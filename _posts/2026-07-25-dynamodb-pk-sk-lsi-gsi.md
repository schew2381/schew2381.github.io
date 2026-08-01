---
title: "Designing DynamoDB Keys: PK, SK, LSI, and GSI"
date: 2026-07-25 17:41:02 -0700
categories: [dynamodb, internals]
tags: [aws, dynamodb, database, index]
---

A `Scan` with `FilterExpression` on `Status = PENDING` returned ten orders. `ScannedCount` came back 400,000, and at roughly a kilobyte an item that's 400 MB read to hand back ten items, or about 50,000 read capacity units on the invoice. The filter saved nothing at all, because DynamoDB reads first and filters what it has already paid for. The docs state it without hedging: "a `Scan` consumes the same amount of read capacity, regardless of whether a filter expression is present."

The 1 MB page limit works the same way, applied before the filter rather than after, so those 400 MB also arrived as roughly 400 round trips, most of them returning zero items. `Count` was 10. Only the other number reaches the bill.

DynamoDB has no query planner. A SQL database lets you filter or sort on any column and trusts the optimizer to find a path to the answer. DynamoDB makes you build that path yourself out of keys, and any read the keys don't cover degrades into exactly the scan above. The keys are the query engine, so there are four things to get right: a partition key that decides which machine an item lives on, a sort key that orders items once they're there, and two kinds of secondary index that give a read its own key layout when the table's keys can't serve it.

## Partition key and sort key

Every table needs a primary key that uniquely identifies an item, and it comes in one of two shapes: a partition key alone, or a partition key paired with a sort key.

The partition key decides where the item physically lives. DynamoDB hashes the value and the hash picks one of the [partitions](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/HowItWorks.Partitions.html) the table is spread across, so equal PK values always land on the same partition and get stored next to each other. The sort key then orders the items inside that partition, on disk, so a query can ask for a contiguous range and get it back already sorted with no work at request time.

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

That physical partition is a real machine with a real ceiling, which is the part worth carrying forward. Every partition serves at most [3,000 read units and 1,000 write units per second](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-design.html), no matter how much capacity the table as a whole has. Choosing a partition key isn't only choosing how you'll look items up, it's choosing how many of those ceilings your traffic gets to spread across.

## The `Orders` table

Here's an order-tracking table keyed on `CustomerID` as the PK and `OrderID` as the SK.

| CustomerID | OrderID | OrderDate | Status | TotalAmount |
|---|---|---|---|---:|
| `CUSTOMER#A` | `ORDER#1007` | `2026-07-24T14:10:00Z` | `SHIPPED` | 42.00 |
| `CUSTOMER#A` | `ORDER#1011` | `2026-07-22T09:30:00Z` | `PENDING` | 71.00 |
| `CUSTOMER#A` | `ORDER#1042` | `2026-07-25T16:12:00Z` | `PENDING` | 18.00 |
| `CUSTOMER#B` | `ORDER#2003` | `2026-07-23T11:45:00Z` | `PENDING` | 55.00 |

One customer owns many orders, so a composite key fits, and each `CustomerID + OrderID` pair identifies exactly one item. Ask for a specific order and it's a `GetItem` on `("CUSTOMER#A", "ORDER#1007")`, one hash and one seek. Ask for a customer's whole history and it's a `Query` on `CUSTOMER#A`, which reads a contiguous run inside one partition and hands it back in `OrderID` order.

That's the shape of every read DynamoDB is good at. You know the partition key, so it knows the machine.

Then the account screen wants a customer's orders newest first, by `OrderDate` rather than `OrderID`. And the operations team wants every `PENDING` order across all customers, because somebody has to work the queue. Neither read has a key to travel on. The table sorts by `OrderID` inside each customer, and `Status` isn't part of any key at all, so both requests fall off the fast path into the [`Scan`](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Scan.html) from the top of the post.

A secondary index is how you buy a key for a read that doesn't have one. DynamoDB stores the same items under a different key layout and keeps that copy in sync on every write. There are two kinds, and the entire difference between them is whether you keep the table's partition key or pick a new one, which sounds like a detail and decides almost everything else about how the index behaves.

## Local secondary index (LSI)

An LSI keeps the table's partition key and gives it a different sort key. Same grouping, new order. Its entries live on the same physical partition as the items they point at, which is what "local" means, and that colocation is why an LSI is the only secondary index in DynamoDB that can serve a strongly consistent read. There's nothing to fall behind.

So the account screen gets an LSI on `CustomerID` plus `OrderDate`. The ISO-8601 timestamps sort chronologically as plain strings, so no encoding work is needed to make the order come out right.

```text
Base table (Customer A)       LSI (Customer A)
sorted by OrderID             sorted by OrderDate

ORDER#1007   07-24            07-22   ORDER#1011
ORDER#1011   07-22    ──>     07-24   ORDER#1007
ORDER#1042   07-25            07-25   ORDER#1042
```

The screen now queries `CUSTOMER#A` descending, stops after 20 items, and pays for 20 items instead of the whole history. It can ask for a strongly consistent read if it needs one, and the application sorts nothing.

Assuming the index projects what the screen displays. Ask an LSI for an attribute it doesn't project and DynamoDB will go get it from the base table for you, transparently, charging you a read for each entire base item it fetches rather than for the attribute you asked about. A query that looks like it reads a slim index is quietly reading full items, which is the LSI cost that surprises people. It's also a capability a GSI flatly doesn't have, since a GSI query can only ever see attributes the index projects.

Sharing the partition is where the rest of the bill comes due. An LSI has to be declared at `CreateTable` and can never be added afterward, so it only helps with requirements you saw coming, and requirements arriving late is the normal case. Then there's the ceiling: the base items for one partition key plus that key's index entries have to stay under [10 GB](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/LSI.html) combined, because they all live on the one partition. A table with no LSI has no such limit. Add one and your largest customer can wedge a table that would otherwise have grown indefinitely, with `ItemCollectionSizeLimitExceededException` on every further write to that key.

And the LSI still can't answer the operations team, because it never left the customer partition. Reordering `CUSTOMER#A`'s items doesn't help a query that has to reach every customer at once.

## Global secondary index (GSI)

A GSI throws out the table's partition key and declares its own PK and SK, which is what lets it group items by something the table never keyed on. The mental model that keeps you out of trouble is that a GSI *is* a separate table, because under the hood that's close to literal. It has its own partitions, its own capacity, and its own copy of whatever attributes you project into it. DynamoDB replicates every base-table write into it asynchronously, which is why a GSI read is [eventually consistent](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html) with no option to ask for anything stronger.

So the queue gets a GSI on `Status` plus `OrderDate`. Orders that were sitting in three different customer partitions now sit together under `PENDING`, in date order.

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

The queue queries `Status = PENDING` in date order and pages through it. Notice that the query still names one partition key value, because that requirement never goes away. A GSI doesn't give you the ability to scan cheaply, it gives you a different key to be precise about.

Everything an LSI can't do, a GSI can. Create it whenever you want, drop it whenever you want, no 10 GB ceiling, and its own capacity metered separately from the table's. Which reads like the index has no downside, and is why the next part catches people.

## An under-provisioned GSI throttles the table

Starve a GSI of write capacity and the symptom doesn't show up on the GSI. Your base table starts rejecting writes.

AWS says it straight: "If you perform heavy write activity on the table, but a global secondary index on that table has insufficient write capacity, the write activity on the table will be [throttled](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html)." A `PutItem` against the table fails, and the cause is a capacity number attached to an index the caller has never heard of. The rule that follows is one sentence long and worth taking literally, which is that a GSI's provisioned write capacity should be equal to or greater than the base table's.

A GSI inherits its capacity mode from the base table, so on-demand takes away the number you can get wrong and leaves the coupling in place. The docs are blunt about the rule underneath: for a table write to succeed, the table and all of its GSIs need enough write capacity for it, or the write to the table is throttled. On-demand removes the provisioning mistake, not the dependency.

Getting that number right means counting index writes rather than item writes, and one `UpdateItem` is not one index write. Flipping `Status` from `PENDING` to `SHIPPED` costs two writes in the status GSI, a delete of the `PENDING` entry and a put of the `SHIPPED` one, because changing an indexed key attribute moves the entry to a different place in the index. Update a projected non-key attribute instead and it's one write. Update an attribute the index neither keys on nor projects and it's zero, though the base table still charges you for the write.

Which makes the projection list a throughput decision wearing the costume of a storage decision. `KEYS_ONLY` stores the base table's key plus the index key, `INCLUDE` adds the attributes you name, and `ALL` copies the whole item. Each index entry also carries [100 bytes of overhead](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/GSI.html) on top of that, which disappears against a large item and dominates a small one. Project `ALL` on three GSIs and every write to that table is four writes to four copies of the data.

Projecting less has a hard edge on a GSI that it doesn't have on an LSI, though. A GSI query cannot fetch attributes from the base table, at any price. If the attribute isn't projected, the index cannot return it, so the application has to go `GetItem` the base table itself for every result it got back. Under-project a GSI and you've built an index that hands you a list of keys to look up one at a time.

The flip side of an index only seeing attributes it projects is the sparse index, and it's the best deal DynamoDB offers. An item that doesn't have the index's key attribute at all never gets propagated into the index. So don't write `Status = SHIPPED`, delete the `Status` attribute when the order ships, and the index holds exactly the open orders no matter how large the table grows. The queue's cost stops tracking table size and starts tracking backlog size, which is what you wanted it to cost in the first place.

## One write, three read paths

Every read in this post now lands on a key, and one write keeps all three of them current.

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
               │  maintained views
               │
               ├─ LSI (same PK, sync)
               │    ├─ PK CustomerID
               │    ├─ SK OrderDate
               │    └─ Read: customer by date
               │
               └─ GSI (own PK, async)
                    ├─ PK Status
                    ├─ SK OrderDate
                    └─ Read: status by date
```

Both branches bought a key for a read that didn't have one, and the price was different each time.

## LSI vs GSI

The two look nearly identical at the `Query` call and promise very different things.

| Property | LSI | GSI |
|---|---|---|
| Partition key | Same as the table | Any attribute |
| Sort key | Required, exactly one scalar | Optional |
| When you can create it | Table creation only | Any time |
| Read consistency | Strong or eventual | Eventual only |
| Size limit | 10 GB per partition key | None |
| Capacity | Shares the table's | Its own, and it can throttle the table |
| Unprojected attributes | Fetched from the base table | Unavailable |
| Max per table | 5 | 20 |

Default to a GSI, on the strength of one row. "Table creation only" makes an LSI a bet on requirements you haven't received yet, and the two things it wins on are narrow: a strongly consistent alternate sort, and transparent fetches for attributes you didn't project. Both are real, and neither is usually worth a decision you can't revisit.

Pick the table's own key for the read you serve most, then add one index per remaining access pattern. Not per attribute that looks queryable. Each index is another copy of the data, another write on every mutation, and for a GSI another capacity number that can take the base table down with it.

## Hot partitions and GSI key sharding

Now look at what that status GSI actually built. Every open order in the system, filed under one partition key value, which means one physical partition, which means the 3,000-read and 1,000-write ceiling from earlier applies to all of it at once.

AWS's own table of partition key recommendations lists "status code, where there are only a few possible status codes" under [bad](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-uniform-load.html), and the index I just spent two sections building is precisely that. New orders arrive as `PENDING`, so every write lands on that partition. The queue polls `Status = PENDING`, so every read lands there too. Cross either ceiling and DynamoDB throttles you while the rest of the index sits idle.

The standard fix is to [shard the GSI key](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-indexes-gsi-sharding.html), which means manufacturing the uniformity the attribute doesn't have by appending a suffix.

```text
PENDING            PENDING#00
                   PENDING#01
   split into      PENDING#02
      ──>          ...
                   PENDING#15
```

On write, pick a suffix at random so an order becomes `PENDING#07` instead of `PENDING`. Sixteen shards, sixteen partitions, sixteen times the ceiling. On read, the queue queries all sixteen in parallel and merges the date-ordered pages itself, which is real work you now own and a `Limit` that no longer means what it says, since twenty items per shard is 320 items to merge for the first twenty you want.

Combine that with the sparse index from earlier and the whole thing gets cheap in a satisfying way. Shipped orders drop out of the index entirely, so sixteen shards divide a backlog rather than a table, and the fan-out reads pages that are small because there was never much in them.

The uncomfortable part is that none of these decisions are reversible in the same way. A GSI you can add on Tuesday and drop on Wednesday. A shard count is baked into the values you've already written, so changing it means rewriting them. An LSI you can't add at all. That ordering, from cheap to permanent, is most of what makes DynamoDB schema design feel unlike schema design anywhere else.
