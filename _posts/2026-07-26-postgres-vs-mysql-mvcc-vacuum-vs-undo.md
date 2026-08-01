---
title: "(Pt. 2) Postgres vs MySQL: MVCC + Vacuum vs Undo Log"
date: 2026-07-26 09:15:00 -0700
categories: [databases, internals]
tags: [postgres, mysql, innodb, mvcc, vacuum]
---

> Part 2 of a five-part series:
> 1. [Clustered index vs heap](/posts/postgres-vs-mysql-storage-clustered-vs-heap/)
> 2. MVCC + vacuum vs undo log (this post)
> 3. [HOT updates](/posts/postgres-vs-mysql-hot-updates/)
> 4. [Page splits, TOAST, and UUIDs](/posts/postgres-vs-mysql-page-splits-toast-uuids/)
> 5. [Connections: processes vs threads](/posts/postgres-vs-mysql-connection-models/)
{: .prompt-info }

`DELETE FROM events WHERE created_at < '2025-01-01'`, ten million rows gone, and the table is exactly the same size on disk afterward. Run it against MySQL and the space eventually comes back on its own. Run it against Postgres and it won't, not until something else runs.

Both engines implement MVCC, multi-version concurrency control, which is why a reader never waits on a writer and a writer never waits on a reader. Note the pairing there. It's read against write, and MVCC does nothing for you between two writers, so `UPDATE`s to the same row still serialize on a row lock exactly as you'd expect.

What the guarantee costs is that old row versions have to stay readable as long as some snapshot might still want them. Where they go is the whole difference between the two engines, and it follows straight from [Part 1](/posts/postgres-vs-mysql-storage-clustered-vs-heap/). Postgres piles old versions into the same heap as the live data. InnoDB updates the live row in place and pushes the old version out of the table entirely.

One of those designs needs a `VACUUM` command. The other doesn't.

## Postgres: an update is a delete plus an insert

Postgres never overwrites a row. [`heap_update`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/heapam.c#L3267) writes a brand-new version of the row (a new tuple) into the heap and marks the old one as expired by stamping its `xmax` with the updating transaction's ID. The old tuple stays on disk.

Every tuple carries two transaction IDs in its header that bound when it's visible:

- [`t_xmin`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/htup_details.h#L124), the transaction that inserted it.
- [`t_xmax`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/htup_details.h#L125), the transaction that deleted or superseded it, or zero while the tuple is current.

A reader checks those two values against its own snapshot. It wants tuples whose `xmin` committed before the snapshot began and whose `xmax` is either unset or belongs to a transaction the snapshot can't see yet.

```text
UPDATE users SET name = 'bar' WHERE id = 1;

before                             after
┌─────────────────────────┐        ┌─────────────────────────┐
│ (0,1) name=foo          │        │ (0,1) name=foo          │
│ xmin=100  xmax=0        │        │ xmin=100  xmax=105      │  now dead
└─────────────────────────┘        ├─────────────────────────┤
                                   │ (0,2) name=bar          │
                                   │ xmin=105  xmax=0        │  now live
                                   └─────────────────────────┘
```

Keeping the old version is the entire trick. A transaction that started at `xid=103` still reads `(0,1)` and sees `foo`, because `xmax=105` belongs to a transaction it can't see yet. A transaction that starts after 105 commits reads `(0,2)` and sees `bar`. Same logical row, two physical tuples, and not one lock between them.

So `(0,1)` has to stick around as long as any transaction might still want it. Correct behavior, and also how a table full of dead weight gets built one update at a time, because when the last interested transaction finishes, nothing about the tuple changes. It sits there taking up space until something reclaims it.

## What a delete actually does

Which brings back the ten million rows from the top. A delete in Postgres doesn't remove anything: it sets `xmax` on the tuple and returns. The tuple, its data, and every index entry pointing at it all stay exactly where they were, which is why the table never got smaller.

Nothing in the index stops a later query from finding that surviving entry, either. An index tuple is [a key and a TID](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/itup.h#L35) and nothing else, with no `xmin` or `xmax` of its own, so all it can do is hand over an address. Postgres fetches that heap tuple, checks its header against the snapshot, and throws the row away as invisible. A deleted row gets found, fetched, and discarded on every query that goes looking for it.

So an index entry never points at "the current version" of a row. It points at one specific physical tuple, and that tuple's header is the only thing that decides whether you're allowed to see it. Hold onto that, because it's about to explain why vacuum can't be a single pass.

This is also why a single logical row can have several index entries at once. An update writes a new tuple at a new TID, and unless HOT applies ([Part 3](/posts/postgres-vs-mysql-hot-updates/)), every index gets a second entry pointing at the new TID while the old entry still points at the old one.

```text
UPDATE users SET name = 'bar' WHERE id = 1;   -- name is indexed

name index                        heap page 0
┌───────────────────┐             ┌─────────────────────────┐
│ key=foo ──> (0,1) │────────────►│ (0,1) name=foo          │
│ key=bar ──> (0,2) │──────┐      │ xmin=100  xmax=105      │
└───────────────────┘      │      ├─────────────────────────┤
                           └─────►│ (0,2) name=bar          │
                                  │ xmin=105  xmax=0        │
                                  └─────────────────────────┘
two index entries, two heap tuples, one logical row
```

Both entries are real and both get followed. A reader searching for `foo` lands on `(0,1)`, checks the header, and sees it or doesn't depending on its snapshot. Old readers still need that entry, which is exactly why the index can't drop it at update time.

## Vacuum in detail

`VACUUM` is what finally turns dead tuples back into usable space, driven by [`heap_vacuum_rel`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L624). The interesting part isn't the cleanup, it's the ordering.

Heap slots get reused, so picture vacuum freeing a slot while an index entry still points at it. The next insert drops an unrelated row into that slot, the stale entry resolves to it, and a query for `email = 'a@a.com'` quietly returns somebody else's row with no error anywhere the database can detect.

Postgres rules that out with one invariant, spelled out in the [`lazy_scan_heap`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L1279) header comment: no index entry may ever point at a reusable slot. Everything awkward about vacuum, including walking the heap twice, exists to hold that line.

The slot itself is how. Every heap page opens with an array of line pointers, and a TID's offset picks one out. Each carries a [state flag](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/storage/itemid.h#L38):

- `LP_NORMAL`, pointing at real tuple data on the page.
- `LP_DEAD`, tuple data gone, slot not reusable yet.
- `LP_UNUSED`, slot free for the next insert.
- `LP_REDIRECT`, forwarding to another slot, used by HOT.

`LP_DEAD` is what makes the invariant workable. It's a tombstone: the tuple body is gone and its bytes reclaimed, but the slot number stays reserved, so an index entry still pointing there lands on something well-defined instead of a stranger's row. That buys Postgres time to go clean the indexes, in three phases.

1. Scan the heap. [`lazy_scan_prune`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L2021) walks each page, frees the data of tuples that are dead to every running transaction, sets their line pointers to `LP_DEAD`, and records their TIDs in a list.
2. Vacuum the indexes. [`lazy_vacuum_all_indexes`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L2494) hands that TID list to each index, and [`btbulkdelete`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/nbtree/nbtree.c#L1122) scans the whole B-Tree deleting every entry whose TID is in the list.
3. Vacuum the heap again. Now that no index references those TIDs, [`lazy_vacuum_heap_page`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L2758) flips each `LP_DEAD` pointer to `LP_UNUSED`.

```text
tuple at (0,1) is dead to everyone

phase 1: prune the heap page
  ┌──────────────────────────┐
  │ slot 1: LP_DEAD          │  tuple bytes freed
  │ slot 2: LP_NORMAL (live) │  slot number still reserved
  └──────────────────────────┘
  record TID (0,1) in the dead-items list

phase 2: vacuum every index
  delete all index entries whose TID = (0,1)
  ──> nothing in any index points at slot 1 anymore

phase 3: revisit the heap page
  ┌──────────────────────────┐
  │ slot 1: LP_UNUSED        │  now safe to hand to an insert
  │ slot 2: LP_NORMAL (live) │
  └──────────────────────────┘
```

Phase 3 waits on phase 2, and phase 2 scans every index in full, so vacuuming a table with eight indexes costs roughly eight complete index scans. Drop the indexes and the same work collapses to a single pass, `LP_NORMAL` straight to `LP_UNUSED`, since nothing could be holding a stale pointer. Every index you add makes vacuum more expensive, which is a cost nobody thinks about when adding one.

Vacuum also doesn't shrink the file, and TIDs never get renumbered. Compacting the heap would mean moving live tuples and invalidating every index entry pointing at their old addresses, so live rows keep their addresses for life and vacuum recycles the gaps around them. Later inserts fill those holes, and a table that shed 90% of its rows reports the same size on disk it did before. Those ten million deleted rows became free space *inside* the file, not on the volume. Trailing empty pages are the one exception, and [`lazy_truncate_heap`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L3142) hands those back to the OS.

There's a second job that has nothing to do with space. Transaction IDs are 32 bits and they wrap, so an old enough tuple's `xmin` would eventually look like it came from the future. Vacuum *freezes* those tuples with [`HEAP_XMIN_FROZEN`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/htup_details.h#L206), marking them unconditionally visible and retiring `xmin` from comparison. It's why autovacuum suddenly works over a static table nobody has written to in months.

Ordinary queries pitch in too. When an index scan follows a TID and finds every tuple in the chain dead, [`index_fetch_heap`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/index/indexam.c#L677) sets a `kill_prior_tuple` hint and [`_bt_killitems`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/nbtree/nbtutils.c#L191) marks the entry `LP_DEAD`, so the next scan skips it without a heap fetch. [Bottom-up index deletion](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/nbtree/nbtpage.c#L1523) fires when a page is about to split and clears version churn instead of growing the tree. Neither replaces vacuum, but both keep read-heavy tables from degrading between runs.

## Index-only scans and the visibility map

Covering indexes run headfirst into all of this. If every column a query needs is already in the index, Postgres would love to answer from the index alone, and it can't, for the reason from two sections ago: the index tuple has no `xmin`/`xmax`, so skipping the heap means skipping the visibility check, and the query cheerfully returns rows deleted last week.

The way out is the visibility map, a bitmap alongside each table with [two bits per heap page](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/visibilitymapdefs.h#L17):

- [`ALL_VISIBLE`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/visibilitymapdefs.h#L20), every tuple on this page is visible to every transaction.
- [`ALL_FROZEN`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/visibilitymapdefs.h#L21), every tuple on this page is frozen.

Two bits per 8 KB page is small enough that the map usually sits in memory in full. Vacuum sets `ALL_VISIBLE` on a cleaned page with nothing left but universally-visible tuples, and any write to that page clears the bit immediately.

So an index-only scan reads the entry, pulls the block number out of the TID, and checks that block's bit ([`nodeIndexonlyscan.c`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/executor/nodeIndexonlyscan.c#L165)):

```text
index-only scan, one index entry

  1. index gives (key, TID) ──> TID = (block 42, slot 3)
  2. check the visibility map bit for block 42
       │
       ├── ALL_VISIBLE set ──> everything on block 42 is visible to
       │                       everyone, so this tuple is too.
       │                       return the index data, no heap read.
       │
       └── bit clear ───────> can't prove visibility from the map.
                              fetch (42,3) from the heap and check
                              xmin/xmax the normal way.
```

The bit says nothing about this tuple specifically. It's a page-level guarantee, and the logic is that if every tuple on the page is visible to everyone, the one the TID points at is visible too. Enough to skip the fetch without reading a single tuple header.

Which is what the `Heap Fetches` line in `EXPLAIN (ANALYZE)` is telling you. A freshly-vacuumed static table reports zero and never touches the heap. A table under constant writes has most of its bits cleared, so the identical plan does a heap fetch per row and performs nothing like the plan you thought you had. Postgres labels the node "Index Only Scan" either way, so `Heap Fetches` is your only warning that it stopped being one.

HOT doesn't help here, which is worth saying since HOT is otherwise all about avoiding index work. [`heap_update` clears the page's visibility bits](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/heapam.c#L4223) whether the update took the HOT path or not, so index-only scans over a recently updated page fetch from the heap until vacuum sets the bit again. HOT saves index writes, the visibility map saves heap reads, and neither one implies the other. Reaching for `INCLUDE` to get an index-only scan also costs you on the HOT side, which [Part 3](/posts/postgres-vs-mysql-hot-updates/) gets into.

## MySQL: update in place, old version to the undo log

InnoDB does the opposite of all of it. The row gets overwritten right where it sits in the clustered-index leaf, and the old version is copied into the [undo log](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/trx0undo.h) first, with the live row keeping a pointer back to it. Same MVCC guarantee, opposite direction: old versions leave the table instead of accumulating in it.

Every InnoDB row carries two hidden columns that make this work:

- [`DB_TRX_ID`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/data0type.h#L185) (6 bytes), the ID of the transaction that last modified the row.
- [`DB_ROLL_PTR`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/data0type.h#L191) (7 bytes), a pointer to the undo record holding the previous version.

```text
UPDATE users SET name = 'bar' WHERE id = 1;

clustered index leaf                  undo log
┌───────────────────────────┐        ┌─────────────────────┐
│ id=1   name=bar   (live)  │        │ old: name=foo       │
│ DB_TRX_ID   = 105         │        │                     │
│ DB_ROLL_PTR ──────────────┼───────►│ reached through     │
│                           │        │ DB_ROLL_PTR         │
└───────────────────────────┘        └─────────────────────┘
```

The live row took its new value in place, so not one index entry had to change. That's the payoff from Part 1: secondary indexes point via primary key, and `id=1` is still `id=1`.

An older transaction that shouldn't see `bar` has to work for its version, though. It walks the undo chain backward, applying each record in reverse until the row matches its snapshot:

```text
reader with snapshot < 105
  1. read the clustered-index row: DB_TRX_ID = 105
  2. 105 is newer than my snapshot, so I can't see this version
  3. follow DB_ROLL_PTR into the undo log
  4. apply the undo record in reverse ──> name = foo
  5. that version is visible ──> return it
```

The read-view logic behind those decisions lives in [`read0read.cc`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/read/read0read.cc), and the consequence is what counts: the live row never moves, so the main table never fills with dead versions the way a Postgres heap does.

The undo records still need cleaning, and a background [purge thread](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/trx/trx0purge.cc#L2396) drops them once no active transaction needs them. It works on a separate structure rather than on your table, which is why MySQL ships no `VACUUM` for you to tune or forget to schedule.

Not free, though. A long-running transaction pins the undo it might need, so undo grows as long as that transaction stays open, and readers walking deep chains pay per hop. Postgres bloats the table you query, InnoDB grows a structure off to the side, and both are held hostage by the same idle transaction somebody left open in a psql window.

## Deletes and indexes on the InnoDB side

It's easy to conclude from all that InnoDB deletes rows properly and Postgres doesn't. It doesn't either. A delete sets a [delete-mark bit](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/rem/rec.h#L147) and leaves the record where it is, for the same reason Postgres does, and the purge thread comes back later for it and its secondary-index entries via [`row_purge_remove_sec_if_poss`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/row/row0purge.cc#L579). Both engines defer the real work. MySQL just doesn't make you schedule it.

Secondary indexes are where the two designs accidentally converge. An InnoDB secondary index record carries no `DB_TRX_ID`, so like a Postgres index entry, it can't answer a visibility question on its own. Opposite MVCC designs, same hole in the middle.

InnoDB's patch is close enough to the visibility map to be uncanny. Every index page stores a [`PAGE_MAX_TRX_ID`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/page0types.h#L77), the highest transaction ID to have modified anything on it, and [`lock_sec_rec_cons_read_sees`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/lock/lock0lock.cc#L273) checks it against the reader's view. If every change predates the snapshot, the record is trustworthy as-is and a covering query never touches the clustered index. Otherwise it falls back to Part 1's second traversal. Two bits per heap page on one side, one transaction ID per index page on the other, both a page-level watermark that lets a reader skip the visibility check.

One asymmetry undercuts the tidy story. When an update changes an indexed column, InnoDB does *not* rewrite the secondary entry in place. It delete-marks the old one, inserts a new one, and leaves purge to sort it out, so index churn on that column looks a lot like Postgres. "InnoDB updates in place" is true of the row and only sometimes true of the indexes.

## Why the difference exists

All of it comes back to that one question about where old versions go.

| | PostgreSQL | MySQL (InnoDB) |
|---|---|---|
| On update | New tuple in the heap, old one marked dead | Row rewritten in place |
| Old versions live | In the main heap, beside live rows | In the undo log, off the table |
| Reading an old version | Read a different tuple directly | Walk the undo chain and reverse changes |
| On delete | Set `xmax`, leave tuple and index entries | Set delete-mark bit, leave record |
| Cleanup | `VACUUM` reclaims dead tuples | Purge thread trims undo and marked records |
| Index visibility shortcut | Visibility map, 2 bits per heap page | `PAGE_MAX_TRX_ID` per index page |
| Main-table bloat | Yes, without vacuuming | No |

Neither is free, and they don't fail in comparable ways. Postgres pays with vacuum scheduling and bloat management, and gets recent versions sitting right there in the heap, readable at full speed. InnoDB pays with undo-chain walks that slow down the further back your snapshot reaches, and gets a main table that stays compact and in key order permanently.

Postgres has one sharp edge left, the one the two-entry diagram above already showed you. Every update writes a new tuple at a new TID, so every index needs a new entry pointing at it, including indexes on columns the update didn't touch.

So: a table with a dozen indexes, an `UPDATE` setting `last_login = now()` on a column nobody indexed, and Postgres writes thirteen things. Uber hit this exact wall and [wrote it up](https://www.uber.com/us/en/blog/postgres-to-mysql-migration) as one of the reasons they left.

Postgres would be unusable for that workload if it actually behaved this way, which is a strong hint it doesn't. [Part 3](/posts/postgres-vs-mysql-hot-updates/) is the mechanism that saves it.
