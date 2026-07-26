---
title: "DynamoDB Keys and Indexes: PK, SK, LSI, and GSI"
date: 2026-07-25 17:41:02 -0700
categories: [dynamodb, internals]
tags: [aws, dynamodb, database, index]
---

DynamoDB makes one shape of read cheap: equality on a partition key, optionally narrowed and ordered by a sort key.
PK, SK, LSI, and GSI are four parts of deciding which reads get that path.

## The model

An orders table can expose three useful orderings from the same item:

```
One table write
      │
      ▼
┌─────────────────────────────┐
│ Base table                  │
│ PK CustomerID, SK OrderID   │
│ Read: one customer by ID    │
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
          └─ Read: pending by date
```

The table owns the items.
Each index is another ordered view that DynamoDB maintains from table writes.

## PK chooses the group

A table primary key is either a partition key by itself or a partition key paired with a sort key.

The uniqueness rule follows the shape:

- With only a PK, every PK value must be unique.

- With a PK and SK, the pair must be unique.
  Many items can share the PK as long as their SK values differ.

DynamoDB feeds the partition-key value into an [internal hash function](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.Partitions.html) to place data in its managed partition space.
A DynamoDB partition is replicated across Availability Zones, so it isn't accurate to think of one PK as one server.

Items sharing a PK form a logical **item collection**.
Without an LSI, DynamoDB can split a large item collection across storage partitions, which means the logical grouping doesn't promise permanent placement on one machine.

For the orders table:

| CustomerID (PK) | OrderID (SK) | OrderDate | Status | TotalAmount |
|---|---|---|---|---:|
| `CUSTOMER#A` | `ORDER#1007` | `2026-07-24T14:10:00Z` | `SHIPPED` | 42.00 |
| `CUSTOMER#A` | `ORDER#1011` | `2026-07-22T09:30:00Z` | `PENDING` | 71.00 |
| `CUSTOMER#A` | `ORDER#1042` | `2026-07-25T16:12:00Z` | `PENDING` | 18.00 |
| `CUSTOMER#B` | `ORDER#2003` | `2026-07-23T11:45:00Z` | `PENDING` | 55.00 |

Each item also stores the index sort-key attribute because DynamoDB won't derive it from the other fields:

```text
OrderDateKey = OrderDate#CustomerID#OrderID
```

`CustomerID` gathers one customer's orders into an item collection.
It also determines the value that every table `Query` must provide.

## SK orders the group

The sort key controls order inside one partition-key value.
A `Query` requires equality on the PK and can then apply `=`, `<`, `<=`, `>`, `>=`, `BETWEEN`, or `begins_with` to the SK.

```text
PK = "CUSTOMER#A"
SK BETWEEN "ORDER#1000" AND "ORDER#1099"
```

Query results are ascending by default, with `ScanIndexForward=false` reversing them.
[Numbers sort numerically while strings sort by UTF-8 byte order](https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_Query.html), which puts `ORDER#10` before `ORDER#2` and makes zero-padding necessary when numeric text must retain numeric order.

The base table therefore returns Customer A's orders in `1007, 1011, 1042` order.
It does not return them by `OrderDate` unless the ID already encodes time.

## Unsupported reads cost more

The base key handles some access patterns directly and leaves others to more work:

| Access pattern | Base-table path | Better key |
|---|---|---|
| Fetch one known order for one customer | `GetItem` with `CustomerID + OrderID` | Base key |
| List one customer's orders by ID | `Query` one `CustomerID` | Base key |
| List one customer's newest orders | Query all matching customer items, then sort in the application | LSI or GSI with a date sort key |
| List every pending order by date | `Scan` the table and filter after reading | GSI with a status partition key |

The customer/date case does **not** require a full-table scan because the application already knows `CustomerID`.
It can query only that customer's item collection, but it must read the matching items before sorting them and can't ask DynamoDB for the newest page by date.

The pending-orders case has no usable base PK.
A [`Scan` reads the table before applying its filter](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html), so returning ten pending orders can still consume reads for thousands of unrelated items.

## LSI keeps the PK and changes the order

A local secondary index reuses the table PK and supplies one different scalar sort-key attribute.
For deterministic ordering, use the stored `OrderDateKey = OrderDate#CustomerID#OrderID` value so orders placed at the same instant don't tie.

```
Base table: Customer A
PK CustomerID, SK OrderID

ORDER#1007
    │
ORDER#1011
    │
ORDER#1042

same PK, alternate order
    │
    ▼

OrdersByDate LSI: Customer A
PK CustomerID, SK OrderDateKey

2026-07-22...#CUSTOMER#A#ORDER#1011
    │
2026-07-24...#CUSTOMER#A#ORDER#1007
    │
2026-07-25...#CUSTOMER#A#ORDER#1042
```

The LSI can answer "Customer A's newest 20 orders" with one descending query and a limit.
It can also use a strongly consistent read, which a GSI cannot.

Locality carries hard constraints:

- An LSI must be declared when the table is created.
  It can't be added or deleted later.

- Every base-table item and every LSI entry for one PK value stays in one storage partition as a single item collection.
  [That combined collection cannot exceed 10 GB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/LSI.html).

- Reads and index maintenance consume the base table's capacity.
  An LSI query may fetch attributes that weren't projected into the index, but the fetch adds latency and read cost.

An LSI fits when the grouping stays the same, the alternate ordering is known on day one, strong reads matter, and each item collection has a safe size bound.

## GSI defines another key

A global secondary index has its own partition space.
Its key attributes may be unrelated to the table key, although reusing table attributes is allowed.

For the common single-PK and single-SK form:

```
Orders table

A + ORDER#1011 + PENDING
A + ORDER#1042 + PENDING
B + ORDER#2003 + PENDING
           │
           │ asynchronous projection
           ▼
OrdersByStatus GSI

PENDING + 2026-07-22...#CUSTOMER#A#ORDER#1011
PENDING + 2026-07-23...#CUSTOMER#B#ORDER#2003
PENDING + 2026-07-25...#CUSTOMER#A#ORDER#1042
```

The index gathers `PENDING` items from every base-table PK and orders them by `OrderDateKey`.
"Global" means the index spans the whole base table, while every GSI `Query` still supplies one partition-key value such as `PENDING`.

DynamoDB updates GSIs [asynchronously](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html).
Propagation normally takes a fraction of a second, but applications must accept longer delays and eventually consistent reads.

GSIs can be added to or deleted from an existing table.
Adding one backfills qualifying existing items while the table remains online, though the index can't serve queries until it becomes `ACTIVE`.

The GSI stores only its keys, the base-table keys, and the attributes selected by its `KEYS_ONLY`, `INCLUDE`, or `ALL` projection.
A GSI query [cannot fetch a missing attribute from the base table](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/SecondaryIndexes.html), so the application needs another table read if the projection is too small.

## Current GSIs can use several attributes

The one-PK and optional-SK model remains the clearest starting point, but it isn't the only current GSI shape.
[Since November 2025](https://aws.amazon.com/about-aws/whats-new/2025/11/amazon-dynamodb-multi-attribute-composite-keys-global-secondary-indexes/), a GSI can compose its partition key from up to four attributes and its sort key from up to four attributes.

The status index could avoid a synthetic concatenated sort key:

```text
GSI partition key: [Status]
GSI sort key:      [OrderDate, CustomerID, OrderID]
```

A query must provide equality for every partition-key attribute, while sort-key conditions work from left to right.
The example can constrain `OrderDate` first, then `CustomerID`, then `OrderID`, but it can't skip an attribute in the middle and an inequality condition must be last.

Only GSIs support this multi-attribute shape, while base table and LSI key schemas haven't changed.

## LSI and GSI differ at the storage boundary

| Property | LSI | GSI |
|---|---|---|
| Partition key | Same attribute as the base table | May use different attributes, with up to four in current GSIs |
| Sort key | One different scalar attribute | Optional, with up to four attributes in current GSIs |
| Storage | Same item-collection boundary as the table | Separate partition space |
| Lifecycle | Table creation only, with no later add or delete | Can add or delete later, but changing its key or projection requires replacement |
| Size bound | 10 GB for one PK's base items plus all LSI entries | No LSI-style 10 GB item-collection limit |
| Read consistency | Eventual or strong | Eventual only |
| Capacity | Consumes base-table capacity | Inherits the table's capacity mode but scales and meters separately |
| Missing projected attributes | Can fetch from the table at extra cost | Can't fetch from the table |

In provisioned mode, a GSI has its own read and write capacity settings, while on-demand mode bills GSI requests separately and permits an optional maximum throughput for the index.
Either way, an under-capacity or hot GSI can [throttle writes to the base table](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/gsi-throttling.html).

## Status can become a hot key

`Status = PENDING` is useful for explaining a GSI, but it has low cardinality.
A busy system can funnel most index writes and reads into that one key even when `CustomerID` distributes the base table well.

One fix is write sharding:

```text
PENDING
   │
   ├── PENDING#00
   ├── PENDING#01
   ├── ...
   └── PENDING#15
```

The application hashes each order into a status shard, queries all 16 shards in parallel, and merges their date-ordered results.
This spreads traffic at the cost of fan-out reads and application-side merging.

A sparse index is another useful choice when only open orders need the access path.
Add the index-key attributes while an order is open, then remove them when it ships, and DynamoDB will remove that item from the index.

## The practical choice

If listing a customer's orders by date is the dominant read, I would first consider making `OrderDate#OrderID` the table SK and skipping the LSI.
If `OrderID` is globally unique by an application invariant, a GSI with `OrderID` as its PK can provide that lookup, although DynamoDB won't enforce the uniqueness.

I would choose an LSI only when the alternate order is fixed at table creation, strong consistency is required, and one PK's complete item collection will remain comfortably below 10 GB.
For access patterns added later or data that can grow without that bound, a GSI is usually the safer choice.

Every index adds storage and write work.
Create one for a named access pattern, not because an attribute might be useful someday.
