---
title: "DynamoDB Keys and Indexes: PK, SK, LSI, and GSI"
date: 2026-07-25 17:41:02 -0700
categories: [dynamodb, internals]
tags: [aws, dynamodb, database, index]
---

The first version of an orders table has one job: fetch an order when the customer and order ID are known.
A composite `CustomerID + OrderID` key makes that read direct.

Then product needs each customer's newest orders, while operations needs one queue of pending orders across every customer.
Those two requirements add two more key paths over the same items.

## The overview

The three paths start from one table write:

```text
One table write
      │
      ▼
┌─────────────────────────────┐
│ Base table                  │
│ PK CustomerID, SK OrderID   │
│ Read: known order           │
└──────────────┬──────────────┘
               │
       maintained views
               │
       ├─ LSI (same PK)
       │  ├─ PK CustomerID
       │  ├─ SK OrderDateKey
       │  └─ Read: customer by date
       │
       └─ GSI (async)
          ├─ PK Status
          ├─ SK OrderDateKey
          └─ Read: status by date
```

The base table handles the original lookup.
The LSI keeps the customer grouping and changes the order, while the GSI replaces the grouping with status.

## Start with the lookup

The table holds four orders:

| CustomerID | OrderID | OrderDate | Status | TotalAmount |
|---|---|---|---|---:|
| `CUSTOMER#A` | `ORDER#1007` | `2026-07-24T14:10:00Z` | `SHIPPED` | 42.00 |
| `CUSTOMER#A` | `ORDER#1011` | `2026-07-22T09:30:00Z` | `PENDING` | 71.00 |
| `CUSTOMER#A` | `ORDER#1042` | `2026-07-25T16:12:00Z` | `PENDING` | 18.00 |
| `CUSTOMER#B` | `ORDER#2003` | `2026-07-23T11:45:00Z` | `PENDING` | 55.00 |

`CustomerID` and `OrderID` form the table's composite primary key:

```text
Partition key (PK): CustomerID
Sort key (SK):      OrderID
```

A DynamoDB primary key can be a PK alone or a composite PK and SK.
This table needs the composite form because one customer owns many orders, with each `CustomerID + OrderID` pair identifying one item.

`GetItem` can fetch the known order directly:

```text
PK = "CUSTOMER#A"
SK = "ORDER#1007"
```

DynamoDB hashes the PK into its [managed partition space](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.Partitions.html).
Items with the same PK form a logical item collection, while the SK orders query results inside that collection.

A `Query` for `CUSTOMER#A` therefore returns `ORDER#1007`, `ORDER#1011`, and `ORDER#1042` in SK order.
It can narrow that range or reverse it, but the ordering field is still `OrderID`.

That key serves the original lookup, but the history screen needs a different ordering within the same customer.

## Keep the customer, change the order

The history screen needs Customer A's newest 20 orders.
The base table can query only Customer A, so this does not require a table scan, but it returns those items by `OrderID` rather than `OrderDate`.

The application could read every order for Customer A and sort them afterward.
That works for a small customer, but DynamoDB cannot stop once it has found the newest 20 because the base key does not contain the requested order.

The alternate sort key needs a date plus stable tie-breakers:

```text
OrderDateKey =
2026-07-25T16:12:00.000000Z|CUSTOMER#A|ORDER#1042
```

Every timestamp uses the same fixed-width UTC form and the IDs exclude `|`.
Those encoding rules preserve chronological byte order and prevent two component tuples from producing the same scalar key.

The writer stores `OrderDateKey` with each order because DynamoDB does not derive index keys from other fields.
A Local Secondary Index keeps `CustomerID` as the PK and uses this attribute as a second SK:

```text
Base table, Customer A
sorted by OrderID

ORDER#1007
    │
ORDER#1011
    │
ORDER#1042

same PK, alternate SK
    │
    ▼

LSI, Customer A
sorted by OrderDateKey

07-22...|A|1011
    │
07-24...|A|1007
    │
07-25...|A|1042
```

The LSI can query `CUSTOMER#A` in descending SK order and stop after 20 items.
No application-side sort or read of the customer's full history is needed.

"Local" describes the storage boundary.
Sharing the table's item collection enables strong reads and imposes two constraints:

- The LSI must be declared with the table and cannot be added or deleted later.

- One PK's base items and LSI entries must remain below the [10 GB item-collection limit](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/LSI.html).

Because an LSI changes only the order, every LSI query still starts with one `CustomerID` and cannot gather pending orders across customers.

## Change the group

The operations queue needs every pending order across all customers, ordered by date.
Neither the table nor the LSI has `Status` as its PK, leaving a [`Scan`](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html) as the remaining path.

A scan reads items before applying its filter.
Returning ten pending orders can therefore consume reads for thousands of shipped and cancelled orders.

A Global Secondary Index creates another key space:

```text
GSI PK: Status
GSI SK: OrderDateKey
```

Orders from different customer item collections can now meet under `PENDING`:

```text
Orders table

A / 1011 / PENDING
A / 1042 / PENDING
B / 2003 / PENDING
          │
          │ async projection
          ▼
OrdersByStatus GSI

PENDING / 07-22 / A / 1011
PENDING / 07-23 / B / 2003
PENDING / 07-25 / A / 1042
```

The queue queries the GSI with `Status = PENDING` in descending SK order and stops at its page limit.
"Global" does not remove the need for a partition key because every GSI query still supplies the index PK.

DynamoDB updates the GSI [asynchronously](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html) after the table write, so GSI reads are eventually consistent.
Its separate partition space lets the index be added or deleted later and removes the LSI-specific 10 GB item-collection limit.

A current GSI can use up to four partition-key attributes and four sort-key attributes, but this example keeps one materialized `OrderDateKey` to make the PK and SK roles easy to see.
AWS documents the [multi-attribute key form](https://aws.amazon.com/about-aws/whats-new/2025/11/amazon-dynamodb-multi-attribute-composite-keys-global-secondary-indexes/) separately.

## The storage boundary

The LSI and GSI serve similar-looking queries, but they make different storage and consistency promises:

| Property | LSI | GSI |
|---|---|---|
| Partition key | Same as the table | Can differ from the table |
| Sort key | One alternate scalar attribute | Optional alternate key |
| Lifecycle | Created with the table only | Can be added or deleted later |
| Read consistency | Eventual or strong | Eventual only |
| Size boundary | 10 GB per table-PK item collection | No LSI-style 10 GB limit |
| Capacity | Uses table capacity | Scales and meters separately |

## The same reads in PostgreSQL and MySQL

PostgreSQL and MySQL separate the query from the access path.
For these reads, the useful B-tree order starts with the equality predicate and continues with the requested sort.

The same key definitions run on PostgreSQL 18 and MySQL 8.4:

```sql
ALTER TABLE orders
    ADD PRIMARY KEY (
        customer_id,
        order_id
    );

CREATE INDEX orders_by_customer_date
    ON orders (
        customer_id,
        order_date DESC,
        order_id DESC
    );

CREATE INDEX orders_by_status_date
    ON orders (
        status,
        order_date DESC,
        customer_id DESC,
        order_id DESC
    );
```

The three reads also use the same SQL in both engines:

```sql
-- One known order
SELECT
    order_id,
    order_date,
    status,
    total_amount
FROM orders
WHERE customer_id = 'CUSTOMER#A'
  AND order_id = 'ORDER#1007';

-- One customer's newest orders
SELECT
    order_id,
    order_date,
    status,
    total_amount
FROM orders
WHERE customer_id = 'CUSTOMER#A'
ORDER BY
    order_date DESC,
    order_id DESC
LIMIT 20;

-- Newest pending orders
SELECT
    customer_id,
    order_id,
    order_date,
    total_amount
FROM orders
WHERE status = 'PENDING'
ORDER BY
    order_date DESC,
    customer_id DESC,
    order_id DESC
LIMIT 20;
```

The customer/date index resembles the LSI because the grouping remains one customer, while the status/date index resembles the GSI because `status` becomes the leading lookup value.
That comparison ends at the access pattern because SQL lets the optimizer choose an index, while a DynamoDB request targets the table or a named index and supplies its PK.

[PostgreSQL multicolumn B-trees](https://www.postgresql.org/docs/current/indexes-multicolumn.html) favor constraints on leading columns, while [MySQL composite indexes](https://dev.mysql.com/doc/refman/8.4/en/multiple-column-indexes.html) use their leftmost prefixes for lookups.
The complete seeded [PostgreSQL 18 script](https://github.com/schew2381/schew2381.github.io/blob/main/examples/dynamodb-keys/postgresql.sql) and [MySQL 8.4 script](https://github.com/schew2381/schew2381.github.io/blob/main/examples/dynamodb-keys/mysql.sql) are on GitHub.

## When one status gets busy

The status GSI makes the operations queue cheap by concentrating pending orders under one PK.
As the queue grows, that same concentration can make `PENDING` a hot key.

A common fix adds a stable shard to the index PK:

```text
PENDING
   │
   ├─ PENDING#00
   ├─ PENDING#01
   ├─ ...
   └─ PENDING#15
```

Writes spread across 16 key values, while reads query those shards in parallel and merge their date-ordered results.
The write distribution improves at the cost of read fan-out and application-side merging.

## Choose the table key first

Choose the table key for the dominant read, then add indexes for the remaining access patterns.
If newest-by-date is the main customer read, `OrderDate#OrderID` may belong in the table SK from the beginning, which removes the LSI but changes the direct order-ID path.

For this table, the customer/date path fits an LSI only when it was known at table creation, needs strong reads, and has a safe item-collection bound.
The cross-customer status path needs a GSI and accepts eventually consistent reads plus separate index cost.

Every index adds storage and write work.
Create one for a named access pattern, not because an attribute might be useful someday.
