---
title: "DynamoDB Keys and Indexes: PK, SK, LSI, and GSI"
date: 2026-07-25 17:41:02 -0700
categories: [dynamodb, internals]
tags: [aws, dynamodb, database, index]
---

DynamoDB has no query planner.
A SQL database lets you filter or sort on any column and trusts the optimizer to find a path to the answer.
DynamoDB makes you choose that path yourself through the way you lay out the keys, and a read the layout doesn't support falls back to scanning the whole table.

So the keys are the design.
Four pieces make up that design: the partition key (PK) and sort key (SK) that define a table's primary key, plus two secondary index types that give the same items new read paths, the local secondary index (LSI) and the global secondary index (GSI).
LSIs and GSIs only make sense once PK and SK are clear, so start there.

## Partition key and sort key

Every DynamoDB table needs a primary key that uniquely identifies each item.
It takes one of two forms: a partition key on its own, or a partition key paired with a sort key.

The partition key decides where an item physically lives.
DynamoDB runs the PK value through a hash function and uses the result to pick one of the [partitions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.Partitions.html) the table is spread across, so every item with the same PK lands on the same partition, stored together.

The sort key orders items within that partition.
With a composite key one PK holds many items, and DynamoDB keeps them sorted by SK on disk, so a query can ask for a contiguous range and get it back in order without sorting anything at request time.

```text
hash("CUSTOMER#A")
        │
        ▼
┌─────────────────────────┐
│ one physical partition  │
├─────────────────────────┤
│ SK = ORDER#1007         │
│ SK = ORDER#1011         │  sorted by SK
│ SK = ORDER#1042         │
└─────────────────────────┘
```

The PK maps to storage, and the SK organizes what's inside it.

## An orders table

Take an order-tracking system.
The table uses `CustomerID` as the PK and `OrderID` as the SK, with a few more attributes on each item:

| CustomerID | OrderID | OrderDate | Status | TotalAmount |
|---|---|---|---|---:|
| `CUSTOMER#A` | `ORDER#1007` | `2026-07-24T14:10:00Z` | `SHIPPED` | 42.00 |
| `CUSTOMER#A` | `ORDER#1011` | `2026-07-22T09:30:00Z` | `PENDING` | 71.00 |
| `CUSTOMER#A` | `ORDER#1042` | `2026-07-25T16:12:00Z` | `PENDING` | 18.00 |
| `CUSTOMER#B` | `ORDER#2003` | `2026-07-23T11:45:00Z` | `PENDING` | 55.00 |

The composite key fits because one customer owns many orders, and each `CustomerID + OrderID` pair points at exactly one of them.

This layout answers one question directly: give me a customer's orders.
DynamoDB hashes `CUSTOMER#A`, goes straight to that partition, and a `Query` returns `ORDER#1007`, `ORDER#1011`, and `ORDER#1042` in `OrderID` order.
Fetching a single known order is a `GetItem` on the exact key:

```text
PK = "CUSTOMER#A"
SK = "ORDER#1007"
```

## New access patterns

Then the requirements grow.

The account screen wants Customer A's orders newest first, ordered by `OrderDate` instead of `OrderID`.
The operations team wants every order with `Status = PENDING`, across all customers, so they can work the backlog.

The table answers neither from its keys.
It sorts each customer's orders by `OrderID`, and `Status` isn't a key at all.
Both reads fall back to a [`Scan`](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html), which reads every item before filtering, so returning ten pending orders can burn reads on thousands of shipped ones.

An index stores the same items under a different key layout that DynamoDB keeps in sync for you.
There are two kinds, and they split on one question: does the index keep the table's partition key, or choose a new one?

## Local secondary index (LSI)

An LSI keeps the table's partition key and swaps in a new sort key.
Same grouping, different order.

Its entries live on the same physical partition as the base item, which is what "local" refers to.
Because the index sits next to the data it mirrors, an LSI can serve strongly consistent reads.

The newest-orders query needs a sort key built from the date, and DynamoDB won't derive one from `OrderDate` on its own.
The writer stores an explicit attribute on each order instead:

```text
OrderDateKey =
2026-07-25T16:12:00.000000Z|CUSTOMER#A|ORDER#1042
```

Every timestamp uses the same fixed-width UTC form and the IDs never contain `|`, so the string sorts chronologically and no two orders collapse to the same value.
The LSI keeps `CustomerID` as its PK and uses `OrderDateKey` as its SK:

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

Now the account screen queries `CUSTOMER#A` in descending order and stops after 20 items, with no full-history read and no application-side sort.

The constraints are strict.
An LSI must be defined when the table is created and can't be added later, and one PK's base items plus its LSI entries have to stay under the [10 GB item-collection limit](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/LSI.html).
And because it only reorders a single customer's items, an LSI still can't reach across customers to gather every pending order.

## Global secondary index (GSI)

A GSI drops the table's partition key and defines its own PK and SK, so it can regroup items by an attribute the table never keyed on.

Under the hood it behaves like a separate table.
DynamoDB copies each write into the GSI in the background, which is why GSI reads are [eventually consistent](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html): the index trails the table by a small, usually sub-second, lag.

For the operations queue, the GSI uses `Status` as its PK and `OrderDateKey` as its SK.
Orders that lived in different customer partitions now sit together under `PENDING`:

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

The queue queries `Status = PENDING` in date order and pages through the results.
A GSI still reads from one PK per query, so it needs a `Status` value even though the index spans every customer.

Its separate key space is what makes it flexible.
A GSI can be added or dropped at any time, carries no 10 GB collection limit, and runs on its own capacity, metered apart from the table.

## One write, three read paths

With both indexes defined, a single write to the base table feeds all three reads:

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

The base table answers the known-order lookup.
The LSI keeps the customer grouping and changes the sort.
The GSI throws out the grouping and rebuilds it around status.

## LSI vs GSI

The two look alike in a query but promise different things:

| Property | LSI | GSI |
|---|---|---|
| Partition key | Same as the table | Any attribute |
| Sort key | New alternate sort key | New sort key |
| When you can create it | Table creation only | Any time |
| Read consistency | Strong or eventual | Eventual only |
| Size limit | 10 GB per partition key | None |
| Capacity | Shares the table's | Its own, metered separately |

When you're unsure, reach for a GSI.
It can be added after the table exists, scales past 10 GB, and doesn't force a decision at creation time.
An LSI earns its place only when you need strongly consistent reads on an alternate sort and you're confident one partition key's data stays small, and both of those have to be known before the table exists.

## When one status gets busy

The status GSI makes the operations queue cheap by concentrating pending orders under one PK.
As the queue grows, that same concentration can turn `PENDING` into a hot key.

A common fix adds a stable shard to the index PK:

```text
PENDING
   │
   ├─ PENDING#00
   ├─ PENDING#01
   ├─ ...
   └─ PENDING#15
```

Writes spread across 16 key values, and reads query those shards in parallel and merge their date-ordered results.
Write distribution improves at the cost of read fan-out and an application-side merge.

## Choosing keys

Pick the table key for the dominant read, then add indexes for the rest.
If newest-by-date is the main customer read, `OrderDate#OrderID` may belong in the table SK from the start, which removes the LSI but changes the direct order-ID path.

For this table, the customer-by-date path fits an LSI only when it's known at creation, needs strong reads, and has a safe item-collection bound.
The cross-customer status path needs a GSI and accepts eventually consistent reads plus its own index cost.

Every index adds storage and write work.
Create one for a named access pattern, not because an attribute might be useful someday.
