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

[Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/) ended on a threat: `UPDATE users SET last_login = now()`, a dozen indexes on the table, none of them on `last_login`, and Postgres writing thirteen things to satisfy one logical change. New tuple at a new TID, and a new entry in every index because every index points at a physical address that just moved.

That's real, and it's what Postgres does when nothing saves it. HOT is what usually saves it.

Heap-Only Tuples: when an update qualifies, Postgres writes the new version and touches zero indexes. Not fewer. Zero.

## The two conditions

An update takes the HOT path when both of these hold:

1. It doesn't change any indexed column.
2. There's room for the new tuple on the same heap page as the old one.

Meet both and Postgres writes the new tuple onto that page, then chains the old version to it with a forwarding pointer. The old tuple's [`t_ctid`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/htup_details.h#L161) points at the new one, and two header flags mark the chain: [`HEAP_HOT_UPDATED`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/htup_details.h#L295) on the old version, [`HEAP_ONLY_TUPLE`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/htup_details.h#L296) on the new.

The indexes are never told any of this happened. They keep pointing at the old TID, which now quietly forwards to the current version, and the lie is invisible because a reader following the pointer arrives at the right row anyway.

Both conditions are worth taking seriously, because they fail for completely different reasons. The first is a property of your schema and your query, which you control. The second is a property of how full that particular page happens to be, which you mostly don't.

## A concrete example

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

### Non-indexed update: HOT applies

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

A lookup by `id` or `name` lands on slot 1 exactly as before, sees the forwarding pointer, and follows it to slot 2. Neither index was written. That `last_login` update from the top of the post costs one heap write instead of thirteen.

### Indexed update: HOT breaks

Now set `name = 'Smyth'` instead. The `name` index is sorted, and "Smyth" sorts to a different place in the B-Tree than "Smith" does. A forwarding pointer is useless here, and it's worth seeing exactly why: a later search for "Smyth" descends the index looking for "Smyth" and never arrives at slot 1 at all, because slot 1 is filed under "Smith". The pointer is in a place nobody will look. So the index has to get a real entry for "Smyth", pointing at the new tuple's actual TID.

And once one index needs a direct entry, the entire update falls off the HOT path. Postgres writes the new tuple and re-points every index on the table, which is precisely the cost HOT existed to prevent. There's no partial credit: either no index is touched or all of them are.

Which makes the failure mode sneaky in production. Add one index on a column your hot update path happens to write, and you haven't made that path slightly worse. You've turned every one of those updates from one write into N+1 writes, and nothing in your query plan mentions it.

### Which columns count as indexed

"Doesn't change an indexed column" sounds unambiguous until you write a covering index. `CREATE INDEX ... ON users (email) INCLUDE (last_login)` stores `last_login` in the index leaf without making it part of the key, and the natural reading is that non-key columns are cargo the B-Tree carries but doesn't care about.

Postgres disagrees. The relcache builds a bitmap of every column that blocks HOT, and [the loop that fills it](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/utils/cache/relcache.c#L5449) runs over `indnatts`, the total column count, rather than `indnkeyatts`. Key or not, if a column is in the index it goes in the bitmap, and `heap_update` decides the whole question by [testing the modified set against it](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/heapam.c#L4070).

So adding `INCLUDE (last_login)` to make one read query index-only will quietly cost you the HOT path on every `last_login` write. Exactly the same damage as indexing the column outright, reached by a route that doesn't look like indexing it.

BRIN is the one exception, and it's deliberate. BRIN sets [`amsummarizing = true`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/brin/brin.c#L279), which sends its columns into a separate bitmap that doesn't block anything, because BRIN summarizes ranges of pages instead of pointing at individual tuples. A row moving inside its own page invalidates nothing. Postgres still refreshes the summary when the value changed, and the update still takes the HOT path.

## When the page has no room

The second condition is the one that fails on you silently. A HOT chain lives entirely inside one page, by construction, so Postgres can't put the new version on a different page and still call it HOT. Page full means normal update: new tuple wherever there's room, every index re-pointed, back to N+1 writes.

Here's the part I had wrong for years. I assumed Postgres reserves some free space on every heap page by default, precisely so HOT has somewhere to put things. It doesn't. `fillfactor` controls that reservation and [`HEAP_DEFAULT_FILLFACTOR`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/utils/rel.h#L362) is `100`, so heap pages pack completely full out of the box. B-Tree indexes default to `90` and get slack. Your table gets none.

So on a table with a heavy HOT-update path, lowering `fillfactor` yourself is one of the few genuine free wins available. `ALTER TABLE ... SET (fillfactor = 85)` costs you some space per page and buys room for in-page updates on every page written afterward. Existing pages keep their old packing until they're rewritten, which is the detail that makes people think the setting did nothing.

## Pruning: cleaning HOT chains cheaply

Every HOT update lengthens a chain, and a row updated a thousand times would leave a thousand-link chain for readers to walk if `VACUUM` were the only thing cleaning up. So Postgres prunes opportunistically during ordinary reads, in [`heap_page_prune_opt`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/pruneheap.c#L272). A plain `SELECT` that touches the page checks its chains, and if the head tuple is dead to everyone, cleans up on the spot:

```text
before prune                     after prune
┌───────────────────────┐        ┌───────────────────────┐
│ slot 1: Smith (dead)  │        │ slot 1: LP_REDIRECT   │
│         t_ctid = 2    │        │         to slot 2     │
│ slot 2: live          │        │ slot 2: live          │
└───────────────────────┘        └───────────────────────┘
                                 indexes still point at slot 1
```

Slot 1 shrinks from a full dead row to a tiny redirect stub, which reclaims nearly all of its space. And the indexes still point at slot 1, so they still need no update. Compare that to the three-phase, scan-every-index vacuum from Part 2: this is cleanup that costs one page write and zero index I/O, done by a `SELECT` that was reading the page anyway.

## Two rejected designs

All-or-nothing feels needlessly blunt. Surely you could touch just the one index that actually needs it and leave the other eleven alone. Two schemes do exactly that, both were considered, and both were rejected. They're worth walking through, because the reasons they fail are what gives HOT its shape.

### The trampoline

Add the "Smyth" entry, but point it at old slot 1 and let slot 1 forward to the new tuple. The other indexes never move. Elegant, and broken two different ways.

The first is immortal dead rows. All of MVCC cleanup rests on old versions eventually becoming garbage somebody can reclaim, and a live "Smyth" entry that needs slot 1 as a bridge means slot 1 can never be freed. Update that row again and you've created a second permanent bridge. The bloat isn't a tuning problem you can vacuum your way out of, it's structural.

The second is verification cost. A HOT chain currently guarantees that every tuple in it matches the index key that led you there, which is why following a chain needs no re-checking. Break that and a search for "Smith" can now land on a "Smyth" tuple, so every hop has to re-evaluate the `WHERE` clause. You'd pay that CPU on every fetch of every chain forever, to save index writes on some updates.

### Mixed state

Let the `name` index point at the new tuple directly while the `id` index keeps pointing at the old slot and follows the chain. Each index does whatever is cheapest for it.

This one takes out the cheap pruning from the last section. Pruning is fast precisely because Postgres knows that for a HOT chain, *all* indexes point at the chain head, so it can convert the head into a redirect without consulting a single index.

Allow mixed pointers and that knowledge is gone. Postgres no longer knows which index references which slot, so pruning safely would mean inspecting every index on the table, taking locks and doing I/O, which is the exact cost HOT was built to avoid. You'd have saved writes on the update path by moving the same work into the read path.

Both rejections point the same direction. Either no index changes or all of them do, and in exchange Postgres always knows exactly how indexes relate to the heap, which is what keeps the update path and the cleanup path simple enough to be fast.

## Checking whether it's working

None of this needs to be guesswork. Postgres counts both HOT updates and the ways they fail:

```sql
SELECT relname, n_tup_upd, n_tup_hot_upd, n_tup_newpage_upd
FROM pg_stat_user_tables
ORDER BY n_tup_upd DESC
LIMIT 10;
```

`n_tup_upd` is every update, and the other two are subsets of it:

- `n_tup_hot_upd` took the HOT path and wrote zero index entries.
- `n_tup_newpage_upd` put the new version on a different heap page, which is condition two failing.
- Whatever's left over is `n_tup_upd` minus the other two: non-HOT, but the new version still fit on the same page, which is condition one failing.

The two failure buckets have different fixes, which is the whole reason it's worth doing the subtraction. A large leftover means your updates are writing indexed columns, so the fix is in the schema or the statement. A large `n_tup_newpage_upd` means the column list is fine and the pages are just full, so the fix is `fillfactor`.

The honest caveat is that these counters are cumulative since the last `pg_stat_reset()`, so a table that's been up for a year averages over a year of traffic. Reset the stats, run the workload you actually care about, then read them.

## MySQL doesn't need any of this

Every mechanism in this post exists to work around one fact: a Postgres row version has a physical address, and updating the row changes that address. InnoDB rewrites the row in place ([Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/)), and its secondary indexes point via the primary key anyway ([Part 1](/posts/postgres-vs-mysql-storage-clustered-vs-heap/)), so a non-key update moves nothing anybody is pointing at.

No new-TID problem, so no HOT to invent, no `fillfactor` to tune on the table, no chains to prune. You get for free what Postgres builds two subsystems to approximate.

InnoDB pays for it under a different name. Keeping the clustered index in primary key order is fine while rows arrive in order and expensive the moment they don't, which turns an ordinary schema decision into a production incident. That's [Part 4](/posts/postgres-vs-mysql-page-splits-toast-uuids/).
