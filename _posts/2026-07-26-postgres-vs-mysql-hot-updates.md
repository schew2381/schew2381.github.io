---
title: "Postgres vs MySQL, Part 3: HOT Updates"
date: 2026-07-26 09:30:00 -0700
categories: [databases, internals]
tags: [postgres, mysql, mvcc, hot, index]
---

> Part 3 of a five-part series:
> 1. [Clustered index vs heap](/posts/postgres-vs-mysql-storage-clustered-vs-heap/)
> 2. [MVCC: vacuum vs the undo log](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/)
> 3. HOT updates (this post)
> 4. [Page splits, TOAST, and UUIDs](/posts/postgres-vs-mysql-page-splits-toast-uuids/)
> 5. [Connections: processes vs threads](/posts/postgres-vs-mysql-connection-models/)
{: .prompt-info }

[Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/) left Postgres with a problem. Every update writes a new tuple at a new TID, and every index points at a physical TID, so updating one unindexed column would force Postgres to rewrite an entry in *every* index on the table. Change a `last_login` timestamp and you'd touch the indexes on `email`, `name`, and everything else, for no reason.

HOT, Heap-Only Tuples, is the fix. When an update qualifies, Postgres adds the new version without touching any index at all.

## The two conditions

An update goes down the HOT path when both hold:

1. It doesn't change any indexed column.
2. There's room for the new tuple on the same heap page as the old one.

Meet both, and Postgres writes the new tuple on that page and chains the old version to it with a forwarding pointer. The [`t_ctid`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/htup_details.h#L161) field of the old tuple points at the new one, and two flags on the tuple header, [`HEAP_HOT_UPDATED`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/htup_details.h#L295) on the old version and [`HEAP_ONLY_TUPLE`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/htup_details.h#L296) on the new one, mark the chain.

The indexes never learn the new tuple exists. They still point at the old TID, which now forwards to the current version.

## A concrete example

Take a row at TID `(10, 1)`, page 10 slot 1, with two indexes: one on `id`, one on `name`.

```text
indexes                    heap page 10
┌──────────────┐           ┌──────────────────────┐
│ id index      │──(10,1)──▶│ slot 1: id=1          │
│ name index    │──(10,1)──▶│         name=Smith    │
└──────────────┘           └──────────────────────┘
both indexes point at slot 1
```

### Non-indexed update: HOT applies

Set `status = 'inactive'`, a column with no index. Postgres writes the new version at slot 2 and forwards slot 1 to it:

```text
indexes                    heap page 10
┌──────────────┐           ┌──────────────────────┐
│ id index      │──(10,1)──▶│ slot 1: Smith  ──┐    │  HEAP_HOT_UPDATED
│ name index    │──(10,1)──▶│                  │    │  t_ctid ─▶ slot 2
└──────────────┘           │ slot 2: ◀────────┘    │  HEAP_ONLY_TUPLE
                           │   status=inactive     │
                           └──────────────────────┘
indexes unchanged; slot 1 forwards to slot 2
```

A lookup by `id` or `name` lands on slot 1 as before, sees the forwarding pointer, and follows it to slot 2. Neither index was written.

### Indexed update: HOT breaks

Now set `name = 'Smyth'`. The `name` index is sorted, and "Smyth" belongs in a different place in the B-Tree than "Smith". A forwarding pointer can't help here: a future search for "Smyth" descends the index looking for "Smyth" and would never arrive at slot 1, which is filed under "Smith". So the index *must* get a new entry for "Smyth", and that entry has to point directly at the new tuple's real TID.

Once one index needs a direct entry, the whole update leaves the HOT path. Postgres writes the new tuple and updates every index to point at its TID, the exact penalty HOT existed to avoid. HOT is all-or-nothing: either no index is touched, or all of them are.

## What if the page is full?

Condition 2 fails when the old tuple's page has no room for the new one. Postgres can't put the new version on a different page and still call it a HOT chain, because a HOT chain lives entirely within one page. So it falls back to a normal update: new tuple on a page that has space, every index re-pointed.

A common myth, and one I believed until I checked the source, is that Postgres reserves free space on every heap page by default to leave room for HOT updates. It doesn't. The `fillfactor` storage parameter controls that reservation, and [`HEAP_DEFAULT_FILLFACTOR`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/utils/rel.h#L362) is `100`: heap pages pack full by default. (B-Tree indexes are the ones that default to `90`.) If a table is HOT-update heavy, you lower `fillfactor` yourself so pages keep slack for in-page updates.

## Pruning: cleaning HOT chains cheaply

HOT chains would grow without bound if only `VACUUM` cleaned them. Postgres also prunes them opportunistically during ordinary reads, in [`heap_page_prune_opt`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/pruneheap.c#L272). When a `SELECT` touches a page, Postgres checks its HOT chains, and if the head tuple is dead to everyone, it prunes:

```text
before prune                    after prune
┌──────────────────┐            ┌──────────────────┐
│ slot 1: Smith dead│            │ slot 1: ─▶ slot 2 │  redirect stub
│   t_ctid ─▶ slot 2│            │ slot 2: live      │
│ slot 2: live      │            └──────────────────┘
└──────────────────┘            indexes still point at slot 1
```

Slot 1 becomes a tiny redirect stub instead of a full dead row, reclaiming most of its space, and, crucially, the indexes still point at slot 1 and need no update. Cleanup happens without touching a single index entry.

## Why not a "trampoline" or mixed indexes?

Two cleverer designs seem like they'd avoid updating every index, and both were considered and rejected. Seeing why is seeing why HOT is shaped the way it is.

The first is a trampoline: add the "Smyth" entry but point it at old slot 1, and let slot 1 forward to the new tuple, so the other indexes stay put. It fails for two reasons. One is the immortal-dead-row problem. MVCC cleanup depends on old versions eventually becoming garbage that gets reclaimed, but if a live "Smyth" entry needs slot 1 as a bridge, slot 1 can never be freed, and every update adds another undeletable bridge tuple until the table is permanent bloat. The other is verification cost. A HOT chain guarantees that every tuple in it matches the index key that led there; break that and a search for "Smith" following the chain to a "Smyth" tuple would have to re-check the `WHERE` clause on every hop, burning CPU on every fetch.

The second is mixed state: let the `name` index point at the new tuple while the `id` index keeps pointing at the old slot and follows the chain. This one breaks the cheap pruning above. Pruning is fast precisely because Postgres knows that for a HOT chain *all* indexes point at the chain head, so it can turn the head into a redirect without consulting any index. Allow mixed pointers and pruning no longer knows which index references which slot, so to prune safely it would have to inspect every index on the table, taking locks and doing I/O, exactly the cost HOT was built to avoid.

The rule that either no index changes or all of them do is what keeps both the update path and the cleanup path simple. Postgres always knows how indexes relate to the heap.

## MySQL doesn't need any of this

InnoDB updates the row in place ([Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/)), so the row never moves and secondary indexes, which point via the primary key rather than a physical address, never need fixing up on a non-key update. There's no new-TID problem, so there's no HOT to invent. The equivalent concern surfaces elsewhere for InnoDB: keeping the clustered index physically ordered as rows are inserted and pages fill. That's [Part 4](/posts/postgres-vs-mysql-page-splits-toast-uuids/).
