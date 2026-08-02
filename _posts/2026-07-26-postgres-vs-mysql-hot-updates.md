---
title: "(Pt. 3) Postgres vs MySQL: HOT Updates"
date: 2026-07-26 09:30:00 -0700
categories: [databases, internals]
tags: [postgres, mysql, mvcc, hot, index]
---

> Part 3 of a five-part series:
> 1. [Clustered index vs heap](/posts/postgres-vs-mysql-storage-clustered-vs-heap/)
> 2. [MVCC + vacuum vs undo log](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/)
> 3. HOT updates (this post)
> 4. [Page splits, TOAST, and UUIDs](/posts/postgres-vs-mysql-page-splits-toast-uuids/)
> 5. [Connections: processes vs threads](/posts/postgres-vs-mysql-connection-models/)
{: .prompt-info }

In [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/) we left Postgres writing thirteen things to satisfy one logical change. `UPDATE users SET last_login = now()`, a dozen indexes on the table, none of them on `last_login`, and every index still needs a new entry because the row moved to a new TID.

Now what saves it from doing that on every update?

When an update qualifies, Postgres writes the new version and touches no indexes at all which is the mechanism called a Heap-Only Tuple. The rest of this post is what "qualifies" means and what it costs when an update doesn't.

## The two conditions

An update takes the HOT path when both of these hold:

1. It doesn't change any indexed column.
2. There's room for the new tuple on the same heap page as the old one.

Meet both and Postgres writes the new tuple onto that page, then chains the old version to it with a forwarding pointer. The old tuple's [`t_ctid`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/htup_details.h#L161) points at the new one, and two header flags mark the chain: [`HEAP_HOT_UPDATED`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/htup_details.h#L295) on the old version, [`HEAP_ONLY_TUPLE`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/htup_details.h#L296) on the new.

The indexes are never told any of this happened, so they keep pointing at the old TID, which now quietly forwards to the current version, and a reader following the pointer arrives at the right row anyway.

The two conditions fail for completely different reasons, so both are worth taking seriously. The first is a property of your schema and your query, which you control, and the second is how full that particular page happens to be, which you mostly don't.

Take a row at TID `(10, 1)`, page 10 slot 1, with two indexes: one on `id`, one on `name`.

```text
indexes                       heap page 10
┌────────────────┐            ┌───────────────────────┐
│ id index       │            │ slot 1:  id=1         │
│ name index     │            │          name=Smith   │
└────────────────┘            └───────────────────────┘
        │                                 ▲
        └────────── both point ───────────┘
                     at (10,1)
```

## Non-indexed update: HOT applies

Set `status = 'inactive'`, a column with no index. Postgres writes the new version at slot 2 and forwards slot 1 to it:

```text
indexes                       heap page 10
┌────────────────┐            ┌───────────────────────┐
│ id index       │            │ slot 1:  name=Smith   │  HEAP_HOT_UPDATED
│ name index     │            │          t_ctid = ────┼──┐
└────────────────┘            │                       │  │
        │                     │ slot 2:  name=Smith   │  │
        │                     │          status=      │◄─┘
        │                     │            inactive   │  HEAP_ONLY_TUPLE
        │                     └───────────────────────┘
        │                                 ▲
        └───── both still point at ───────┘
                     (10,1)
```

A lookup by `id` or `name` lands on slot 1 exactly as before, sees the forwarding pointer, and follows it to slot 2. Neither index was written, so that `last_login` update from the top of the post costs one heap write instead of thirteen.

## Indexed update: HOT breaks

Now set `name = 'Smyth'` instead. The `name` index is sorted, so "Smyth" sorts to a different place in the B-Tree than "Smith" does, and that's what makes a forwarding pointer useless here:

```text
name index leaf pages, in sort order

  ┌───────────────────────┐   ┌───────────────────────┐
  │ Smith ──> (10,1)      │   │ Smyth ──> ?           │
  │ Smithers ──> (12,3)   │   │ Snow ──> (18,2)       │
  └───────────────────────┘   └───────────────────────┘
   slot 1's forwarding         a search for "Smyth"
   pointer lives here          descends to here

  ──> the two never meet, so the pointer sits where
      nobody searching for "Smyth" will ever look
```

So the index needs a real entry for "Smyth", pointing at the new tuple's actual TID.

Once one index needs a direct entry, the entire update falls off the HOT path, and Postgres writes the new tuple and re-points every index on the table, precisely the cost HOT existed to prevent. No partial credit: either no index is touched or all of them are.

Which makes the failure mode sneaky in production, because adding one index on a column your hot update path happens to write hasn't made that path slightly worse. You've turned every one of those updates from one write into N+1, and nothing in your query plan mentions it.

### Which columns count as indexed

"Doesn't change an indexed column" sounds unambiguous until you write a covering index. `CREATE INDEX ... ON users (email) INCLUDE (last_login)` stores `last_login` in the index leaf without making it part of the key, so the natural reading is that non-key columns are cargo the B-Tree carries but doesn't care about.

Postgres disagrees, and the disagreement is one word in one loop. The relcache builds a bitmap of every column that blocks HOT, and [the loop that fills it](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/utils/cache/relcache.c#L5449) runs over `indnatts`, the total column count, rather than `indnkeyatts`. Key or not, a column in the index goes in the bitmap, and `heap_update` decides the whole question by [testing the modified set against it](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/heapam.c#L4070).

So adding `INCLUDE (last_login)` to make one read query index-only quietly costs you the HOT path on every `last_login` write. Same damage as indexing the column outright, reached by a route that doesn't look like indexing it.

BRIN is the one exception, and a deliberate one: it sets [`amsummarizing = true`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/brin/brin.c#L279), which sends its columns into a separate bitmap that blocks nothing. BRIN summarizes ranges of pages instead of pointing at individual tuples, so a row moving inside its own page invalidates nothing. Postgres refreshes the summary when the value changed, and the update still takes the HOT path.

## When the page has no room

The second condition fails on you silently, because a HOT chain lives entirely inside one page by construction. The code enforces that with an [`Assert`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/heapam_indexscan.c#L217) that a chain's forwarding pointer stays on the same block, so Postgres can't put the new version on a different page and still call it HOT:

```text
same update, same columns, only the free space differs

  page 10 has room                page 10 is full
  ┌───────────────────────┐       ┌───────────────────────┐
  │ slot 1: old ──> 2     │       │ slot 1: old           │  stays dead
  │ slot 2: new           │       │ no room for a slot 2  │
  └───────────────────────┘       └───────────────────────┘
                                  ┌───────────────────────┐
  indexes untouched               │ page 14, slot 6: new  │
  1 write                         └───────────────────────┘
                                  every index re-pointed
                                  N+1 writes
```

For years I assumed Postgres reserves free space on every heap page by default, precisely so HOT has somewhere to put things, and it doesn't. `fillfactor` controls that reservation and [`HEAP_DEFAULT_FILLFACTOR`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/utils/rel.h#L362) is `100`, so heap pages pack completely full out of the box. B-Tree indexes default to `90` and get slack, while your table gets none.

So on a table with a heavy HOT-update path, lowering `fillfactor` is one of the few genuine free wins available. `ALTER TABLE ... SET (fillfactor = 85)` trades space per page for in-page update room on every page written afterward. Existing pages keep their old packing until they're rewritten, which is the detail that makes people think the setting did nothing.

### The reads get worse too

N+1 writes is the cost everybody quotes, and it isn't the whole bill. Condition one held here, remember, so `name` never changed and the new index entry carries the *same key* as the old one:

```text
name index                            heap
┌──────────────────────┐              ┌────────────────────────┐
│ key=Smith ──> (10,1) │─────────────►│ (10,1) name=Smith      │  dead
│ key=Smith ──> (14,6) │──────┐       └────────────────────────┘
└──────────────────────┘      │       ┌────────────────────────┐
                              └──────►│ (14,6) name=Smith      │  live
                                      └────────────────────────┘
```

A search for "Smith" gets both TIDs back and, per [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/), nothing to choose between them with, so it fetches both and lets the heap headers decide. Two heap tuples on two different pages to return one row.

Nothing warns you about it, since a plain `EXPLAIN` reports rows returned rather than tuples examined, so the extra fetch hides inside a plan that looks correct. `EXPLAIN (ANALYZE, BUFFERS)` shows it as block reads you can't account for, and across a whole table the tell is `pg_stat_user_tables.idx_tup_fetch` running well ahead of `idx_scan` times the rows a scan should return.

So why can't the old entry forward to the new page, the way HOT forwards inside one? The old tuple's `t_ctid` does still physically point at the new tuple. The non-HOT branch of `heap_update` [clears `HEAP_HOT_UPDATED`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/heapam.c#L4195) on it, though, so no scan will ever follow that pointer, which is exactly what the `Assert` above is protecting. Those same-key duplicates are what [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/)'s bottom-up deletion pass hunts for, so the pile stays bounded as long as no old snapshot is pinning it.

## Pruning: cleaning HOT chains cheaply

Every HOT update lengthens a chain, and a row updated a thousand times would leave a thousand links to walk if `VACUUM` were the only thing cleaning up. So Postgres prunes opportunistically during ordinary reads, in [`heap_page_prune_opt`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/pruneheap.c#L272). A plain `SELECT` that touches the page checks its chains, and if the head tuple is dead to everyone, cleans up on the spot:

```text
before prune, four HOT updates deep

  ┌────────────────────────────────────────┐
  │ slot 1: dead, t_ctid ──> 2             │
  │ slot 2: dead, t_ctid ──> 3             │
  │ slot 3: dead, t_ctid ──> 4             │
  │ slot 4: live                           │
  └────────────────────────────────────────┘
  indexes ──> slot 1, then three hops to reach the row
```

```text
after prune

  ┌────────────────────────────────────────┐
  │ slot 1: LP_REDIRECT ──> 4              │
  │ slot 2: LP_UNUSED                      │
  │ slot 3: LP_UNUSED                      │
  │ slot 4: live                           │
  └────────────────────────────────────────┘
  indexes ──> slot 1, one hop, and no index was touched
```

The chain collapses to a redirect stub plus the live tuple, reclaiming the bodies of every version in between, and the indexes still point at slot 1 so they still need no update. Compare that to the three-phase, scan-every-index vacuum from Part 2: one page write, zero index I/O, done by a `SELECT` that was reading the page anyway.

## Two rejected designs

All-or-nothing feels needlessly blunt, since surely you could touch the one index that needs it and leave the other eleven alone. Two schemes do exactly that, and the reasons both were rejected are what gives HOT its shape.

The first is a trampoline, where you add the "Smyth" entry but point it at old slot 1 and let slot 1 forward to the new tuple, so the other indexes never move:

```text
name index                       heap page 10
┌──────────────────────┐         ┌───────────────────────────┐
│ key=Smith ──> (10,1) │────────►│ slot 1: Smith, dead       │
│ key=Smyth ──> (10,1) │────────►│         t_ctid ──> slot 2 │
└──────────────────────┘         │ slot 2: Smyth, live       │
                                 └───────────────────────────┘
slot 1 is dead but can never be freed, because the "Smyth"
entry needs it as a bridge to reach slot 2
```

Which builds immortal dead rows, since MVCC cleanup rests on old versions eventually becoming garbage somebody can reclaim, and a live "Smyth" entry needing slot 1 as a bridge means slot 1 can never be freed. Update the row again and you've built a second permanent bridge. That's structural bloat rather than the kind you vacuum away.

It costs on the read side too. A HOT chain currently guarantees every tuple in it matches the index key that led you there, so following a chain needs no re-checking. Break that and a search for "Smith" can land on a "Smyth" tuple, so every hop has to re-evaluate the `WHERE` clause. CPU on every fetch of every chain forever, to save index writes on some updates.

The second scheme is mixed state, where the `name` index points at the new tuple directly while the `id` index keeps pointing at the old slot and follows the chain:

```text
name index                       heap page 10
┌──────────────────────┐         ┌───────────────────────────┐
│ key=Smyth ──> (10,2) │────────►│ slot 2: Smyth, live       │
└──────────────────────┘    ┌───►│ slot 1: Smith, dead       │
id index                    │    └───────────────────────────┘
┌──────────────────────┐    │
│ id=1      ──> (10,1) │────┘    pruning slot 1 into a redirect
└──────────────────────┘         now needs every index checked
```

That takes out the cheap pruning from the last section, which is fast precisely because Postgres knows that for a HOT chain, *all* indexes point at the chain head. Knowing that, it can convert the head into a redirect without consulting a single index. Allow mixed pointers and pruning safely means inspecting every index on the table, taking locks and doing I/O, the exact cost HOT was built to avoid. Saved writes on the update path, same work moved into the read path.

Both rejections point the same direction, so either no index changes or all of them do, and in exchange Postgres always knows exactly how indexes relate to the heap, which keeps the update and cleanup paths fast.

## Checking whether it's working

None of this has to be guesswork, because Postgres counts both HOT updates and the ways they fail:

```sql
SELECT relname, n_tup_upd, n_tup_hot_upd, n_tup_newpage_upd
FROM pg_stat_user_tables
ORDER BY n_tup_upd DESC
LIMIT 10;
```

`n_tup_upd` is every update, and the other two are subsets of it:

- `n_tup_hot_upd` took the HOT path and wrote zero index entries.
- `n_tup_newpage_upd` put the new version on a different heap page, so condition two failed.
- Whatever's left over is `n_tup_upd` minus the other two: non-HOT, but the new version still fit on the same page, so condition one failed.

Do the subtraction, because the two failure buckets have different fixes. A large leftover means your updates are writing indexed columns, so the fix is in the schema or the statement. A large `n_tup_newpage_upd` means the column list is fine and the pages are just full, so the fix is `fillfactor`.

The counters are cumulative since the last `pg_stat_reset()`, so a table that's been up for a year averages over a year of traffic. Reset the stats, run the workload you actually care about, then read them.

## MySQL doesn't need any of this

Every mechanism in this post exists to work around one fact: a Postgres row version has a physical address, and updating the row changes that address. InnoDB rewrites the row in place ([Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/)), and its secondary indexes point via the primary key anyway ([Part 1](/posts/postgres-vs-mysql-storage-clustered-vs-heap/)), so a non-key update moves nothing anybody is pointing at.

No new-TID problem, so no HOT to invent, no `fillfactor` to tune on the table, no chains to prune. InnoDB gets for free what Postgres builds two subsystems to approximate.

It pays under a different name, since keeping the clustered index in primary key order is fine while rows arrive in order and expensive the moment they don't. That turns an ordinary schema decision into a production incident, and that's [Part 4](/posts/postgres-vs-mysql-page-splits-toast-uuids/).
