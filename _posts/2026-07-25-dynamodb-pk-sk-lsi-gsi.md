---
title: "DynamoDB Keys and Indexes: PK, SK, LSI, and GSI"
date: 2026-07-25 17:41:02 -0700
categories: [dynamodb, internals]
tags: [aws, dynamodb, database, index]
---

DynamoDB has no query planner. Where a SQL database lets you filter or sort on any column and trusts the optimizer to find a path to the answer, DynamoDB makes you design that path yourself through the way you lay out the keys. Anything the layout doesn't support falls back to scanning the whole table, so the keys are the design.

Four pieces make up that design:

1. The partition key (PK) picks which physical partition an item lives on.
2. The sort key (SK) orders items within a partition.
3. A local secondary index (LSI) re-sorts a partition under a different sort key.
4. A global secondary index (GSI) regroups items under a brand-new partition key.

The two indexes build on the primary key, so start with PK and SK.

## Partition key and sort key

Every DynamoDB table needs a primary key that uniquely identifies each item. It takes one of two forms: a partition key on its own, or a partition key paired with a sort key.

The partition key decides where an item physically lives. DynamoDB runs the PK value through a hash function and uses the result to pick one of the [partitions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.Partitions.html) the table is spread across, so every item with the same PK lands on the same partition, stored together.

The sort key orders items within that partition. With a composite key one PK holds many items, kept sorted by SK on disk, so a query can ask for a contiguous range and get it back in order without sorting anything at request time.

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

## Example: the `Orders` table

An order-tracking table keys on `CustomerID` as the PK and `OrderID` as the SK:

| CustomerID | OrderID | OrderDate | Status | TotalAmount |
|---|---|---|---|---:|
| `CUSTOMER#A` | `ORDER#1007` | `2026-07-24T14:10:00Z` | `SHIPPED` | 42.00 |
| `CUSTOMER#A` | `ORDER#1011` | `2026-07-22T09:30:00Z` | `PENDING` | 71.00 |
| `CUSTOMER#A` | `ORDER#1042` | `2026-07-25T16:12:00Z` | `PENDING` | 18.00 |
| `CUSTOMER#B` | `ORDER#2003` | `2026-07-23T11:45:00Z` | `PENDING` | 55.00 |

One customer owns many orders, so the composite key fits: each `CustomerID + OrderID` pair points at exactly one item.

This answers one read directly. DynamoDB hashes `CUSTOMER#A`, jumps to that partition, and a `Query` returns its orders in `OrderID` order. A single known order is a `GetItem` on the exact key:

```text
PK = "CUSTOMER#A"
SK = "ORDER#1007"
```

## New access patterns

Then the requirements grow, and now we want to query for:

1. A single customer's orders sorted by `OrderDate` instead of `OrderID`.
2. Every order with `Status = PENDING`, across all customers.

Neither works on our table. It sorts each customer's orders by `OrderID`, and `Status` isn't a key at all, so both reads fall back to a [`Scan`](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html) that reads every item before filtering. Returning ten pending orders can burn reads on thousands of shipped ones.

So how do we serve these without a scan? An index stores the same items under a different key layout that DynamoDB keeps in sync for you. The two kinds differ by one choice: keep the table's partition key, or pick a new one.

## Local secondary index (LSI)

An LSI keeps the table's partition key and gives it a new sort key. Same grouping, different order. Its entries live on the same physical partition as the base item, which is what "local" means, and because the index sits right next to that data, an LSI can serve strongly consistent reads.

For the newest-orders read, build an LSI with `CustomerID` as the PK and `OrderDate` as the SK. The ISO timestamps sort chronologically on their own, so no extra work is needed to order them:

```text
Base table (Customer A)       LSI (Customer A)
sorted by OrderID             sorted by OrderDate

ORDER#1007   07-24            07-22   ORDER#1011
ORDER#1011   07-22    ──►     07-24   ORDER#1007
ORDER#1042   07-25            07-25   ORDER#1042
```

Now the account screen queries `CUSTOMER#A` in descending order and stops after 20 items, with no full-history read and no sorting in the app.

The cost of sharing a partition is a set of hard limits. An LSI has to be declared when the table is created and can't be added later, and one partition key's base items plus its LSI entries must stay under [10 GB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/LSI.html). And since it only reorders one customer's items, it still can't reach across customers.

## Global secondary index (GSI)

A GSI drops the table's partition key and defines its own PK and SK, so it can regroup items by an attribute the table never keyed on. Under the hood it's essentially a separate table: DynamoDB copies each write into the GSI in the background, which is why GSI reads are [eventually consistent](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html) and trail the table by a small lag.

For the operations queue, build a GSI with `Status` as the PK and `OrderDate` as the SK. Orders that lived in different customer partitions now sit together under `PENDING`:

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

The queue queries `Status = PENDING` in date order and pages through the results. A GSI still reads from one PK per query, so it needs a `Status` value even though the index spans every customer.

Unlike an LSI, a GSI can be added or dropped at any time, has no 10 GB limit, and runs on its own capacity, metered apart from the table.

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
       │  ├─ SK OrderDate
       │  └─ Read: customer by date
       │
       └─ GSI (async)
          ├─ PK Status
          ├─ SK OrderDate
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

Default to a GSI. It can be added after the table exists, scales past 10 GB, and doesn't lock in a decision at creation time. An LSI earns its place only when you need strongly consistent reads on an alternate sort of one partition's data, and that has to be known before the table exists.

Either way, choose the table's own key for the dominant read first, then add an index per remaining pattern. Every index costs storage and write throughput, so create one for a read you actually serve, not for an attribute that might be useful someday.

## When one status gets busy

The status GSI works because it piles every pending order under one PK. That is also its weak point. Each partition has a fixed throughput ceiling, and since new orders all start as `PENDING`, the writes and the queue's reads pound the same `Status = PENDING` partition:

1. Orders arrive and all hash to the single `PENDING` partition.
2. That partition nears its read and write throughput limit.
3. DynamoDB throttles requests to it while the rest of the table sits idle.

That is a hot partition. The fix is to [shard the GSI key](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-indexes-gsi-sharding.html): append a small suffix so one status spreads across many partitions.

```text
PENDING            PENDING#00
                   PENDING#01
   split into      PENDING#02
      ──►          ...
                   PENDING#15
```

On write, pick a suffix at random, turning `PENDING` into `PENDING#00` through `PENDING#15`, so the load lands on 16 partitions instead of one. On read, query all 16 shards in parallel and merge their date-ordered results. Throughput scales with the shard count, at the cost of fan-out reads and an application-side merge.
