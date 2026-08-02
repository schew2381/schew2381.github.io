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

In [Part 1](/posts/postgres-vs-mysql-storage-clustered-vs-heap/) we established that Postgres rows have a physical address and InnoDB rows have a stable identity. Now what happens when you delete one?

Run `DELETE FROM events WHERE created_at < '2025-01-01'`, watch ten million rows disappear, and check the table size. It hasn't moved. On MySQL the space comes back on its own after a while, and on Postgres it doesn't come back until something else runs.

Neither engine can remove a row the moment you ask, because some other transaction may still be reading it. Both keep the old version around for whoever's still looking, which is what MVCC (multi-version concurrency control) means, and it's why a twenty-minute analytics report doesn't block a checkout.

The difference is where those old versions go. Postgres leaves them in the table and InnoDB moves them elsewhere:

```text
Postgres                             InnoDB
┌─────────────────────────┐          ┌───────────────────────┐
│ heap                    │          │ clustered index       │
│   live row              │          │   live row (rewritten │
│   old version           │          │   in place)           │
│   old version           │          └───────────┬───────────┘
│   old version           │                      │ DB_ROLL_PTR
└─────────────────────────┘          ┌───────────▼───────────┐
                                     │ undo log              │
old versions pile up in the          │   old version         │
table you query, so something        │   old version         │
has to come clean them out           └───────────────────────┘
```

Which is why one of these two engines ships a `VACUUM` command and the other one doesn't, so let's follow one update through both of them and see what it costs.

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

Keeping the old version is the entire trick, since a transaction that started at `xid=103` still reads `(0,1)` and sees `foo`, because `xmax=105` belongs to a transaction it can't see yet. A transaction that starts after 105 commits reads `(0,2)` and sees `bar`. Same logical row, two physical tuples, and not one lock between them.

That's the guarantee MVCC actually makes, and it's narrower than people remember. A reader never waits on a writer and a writer never waits on a reader, but two writers still collide, so `UPDATE`'s to the same row serialize on a row lock exactly as you'd expect.

So `(0,1)` has to stick around as long as any transaction might still want it. Correct behavior, and also how a table full of dead weight gets built one update at a time, because when the last interested transaction finishes, nothing about the tuple changes. It sits there taking up space until something reclaims it.

## What a delete actually does

Which brings back the ten million rows from the top. A delete in Postgres doesn't remove anything, it sets `xmax` on the tuple and returns, and three things stay exactly where they were:

- The tuple itself.
- Its data.
- Every index entry pointing at it.

Hence a table that didn't shrink.

Nothing in the index stops a later query from finding that surviving entry, either. An index tuple is [a key and a TID](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/itup.h#L35) and nothing else, with no `xmin` or `xmax` of its own, so all it can do is hand over an address. Postgres fetches that heap tuple, checks its header against the snapshot, and throws the row away as invisible, which it will do again on every query that goes looking.

So an index entry never points at "the current version" of a row, it points at one specific physical tuple whose header is the only thing deciding whether you're allowed to see it. Hold onto that, because it's about to explain why vacuum can't be a single pass.

It's also why one logical row can have several index entries at once. An update writes a new tuple at a new TID, and unless HOT applies ([Part 3](/posts/postgres-vs-mysql-hot-updates/)), every index gets a second entry pointing at the new TID while the old entry still points at the old one.

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

Both entries are real and both get followed. A reader searching for `foo` lands on `(0,1)`, checks the header, and sees it or doesn't depending on its snapshot. Old readers still need that entry, so the index can't drop it at update time.

That's the easy version, though, because the two keys differ, so any one search only ever finds one of the entries. Now change a column nobody indexed, on a row whose heap page has no room left for the new version. Nothing indexed changed, so both entries carry the same key while pointing at different TIDs.

```text
UPDATE users SET status = 'x' WHERE id = 1;   -- name is indexed, unchanged

name index                        heap
┌───────────────────┐             ┌─────────────────────────┐
│ key=foo ──> (0,1) │────────────►│ (0,1) name=foo          │
│ key=foo ──> (7,3) │──────┐      │ xmin=100  xmax=105      │
└───────────────────┘      │      └─────────────────────────┘
                           │      ┌─────────────────────────┐
                           └─────►│ (7,3) name=foo          │
                                  │ xmin=105  xmax=0        │
                                  └─────────────────────────┘
same key twice, and nothing in the index says which one is visible
```

A reader searching for `foo` gets both TIDs back and has nothing to choose between them with, so it fetches both and lets the heap decide:

```text
SELECT * FROM users WHERE name = 'foo';   -- snapshot at xid 110

  1. index scan on name ──> (0,1) and (7,3), both under key=foo
  2. fetch (0,1) ──> xmax=105, committed ──> invisible, discard
  3. fetch (7,3) ──> xmax=0             ──> visible, return it

  two heap tuples read, one row returned
```

[`heapam_index_fetch_tuple`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/heapam_indexscan.c#L232) runs once per TID and the header check inside [`heap_hot_search_buffer`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/heapam_indexscan.c#L90) is the only thing that discriminates. [Part 3](/posts/postgres-vs-mysql-hot-updates/) is about the mechanism that keeps this from happening, and what it costs when it can't.

## Vacuum in detail

`VACUUM` is what finally turns dead tuples back into usable space, driven by [`heap_vacuum_rel`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L624), and the ordering it does that in matters more than the cleanup itself.

Heap slots get reused, so picture vacuum freeing a slot while an index entry still points at it. The next insert drops an unrelated row into that slot, the stale entry resolves to it, and a query for `email = 'a@a.com'` quietly returns somebody else's row with no error anywhere the database can detect. Postgres rules that out with one invariant, spelled out in the [`lazy_scan_heap`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L1279) header comment: no index entry may ever point at a reusable slot.

Holding that line comes down to the slot itself, the line pointer from [Part 1](/posts/postgres-vs-mysql-storage-clustered-vs-heap/). It carries a [state flag](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/storage/itemid.h#L38) alongside its offset:

- `LP_NORMAL`, pointing at real tuple data on the page.
- `LP_DEAD`, tuple data gone, slot not reusable yet.
- `LP_UNUSED`, slot free for the next insert.
- `LP_REDIRECT`, forwarding to another slot, used by HOT.

`LP_DEAD` is the tombstone that makes it workable. The tuple body is gone and its bytes are reclaimed, but the slot number stays reserved, so an index entry still pointing there lands on something well-defined instead of a stranger's row. That's what buys vacuum time to clean the indexes across three phases.

[`lazy_scan_prune`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L2021) walks each page, frees the data of tuples dead to every running transaction, and records their TIDs:

```text
phase 1: prune the heap page

  ┌──────────────────────────┐
  │ slot 1: LP_DEAD          │  tuple bytes freed
  │ slot 2: LP_NORMAL (live) │  slot number still reserved
  └──────────────────────────┘
  dead-items list: [(0,1)]
```

[`lazy_vacuum_all_indexes`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L2494) hands that list to each index, and [`btbulkdelete`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/nbtree/nbtree.c#L1122) scans the whole B-Tree dropping every entry whose TID is in it:

```text
phase 2: vacuum every index

  email index                    id index
  ┌──────────────────┐           ┌──────────────────┐
  │ a@a.com ─> (0,1) │  deleted  │ 1 ─────> (0,1)   │  deleted
  │ b@b.com ─> (0,2) │  kept     │ 2 ─────> (0,2)   │  kept
  └──────────────────┘           └──────────────────┘
  ──> nothing anywhere points at slot 1
```

Only now is the slot safe to hand out, so [`lazy_vacuum_heap_page`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L2758) comes back for a second pass over the page:

```text
phase 3: revisit the heap page

  ┌──────────────────────────┐
  │ slot 1: LP_UNUSED        │  free for the next insert
  │ slot 2: LP_NORMAL (live) │
  └──────────────────────────┘
```

Phase 3 waits on phase 2 and phase 2 scans every index in full, so vacuum costs one complete index scan per index on the table. Drop them all and the same work collapses to one pass, `LP_NORMAL` straight to `LP_UNUSED`, since nothing could be holding a stale pointer. Every index you add makes vacuum more expensive, a cost nobody thinks about when adding one.

### What vacuum doesn't do

Vacuum won't shrink the file, because compacting the heap would mean moving live tuples and invalidating every index entry aimed at their old addresses. Live rows keep their TIDs for life while vacuum recycles the gaps around them, so those ten million deleted rows became free space *inside* the file rather than on the volume. Trailing empty pages are the one exception, handed back to the OS by [`lazy_truncate_heap`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L3142).

Freezing rides along on the same scan without being about space at all. Transaction IDs are 32 bits and they wrap, so an old enough tuple's `xmin` would eventually look like it came from the future, and vacuum *freezes* those tuples with [`HEAP_XMIN_FROZEN`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/htup_details.h#L206) to mark them unconditionally visible and retire `xmin` from comparison. It's why autovacuum suddenly works over a static table nobody has written to in months.

Ordinary queries pitch in on the index side, because an index scan that follows a TID and finds a whole HOT chain dead sets a `kill_prior_tuple` hint in [`index_fetch_heap`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/index/indexam.c#L677). [`_bt_killitems`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/nbtree/nbtutils.c#L191) then marks the entry `LP_DEAD`, so the next scan skips it without a heap fetch. That only helps entries somebody actually read, and the duplicate pile from two sections ago accumulates whether anyone queries it or not.

## Bottom-up index deletion

Picture those same-key duplicates piling up on one leaf page. Each update that leaves the indexed column alone adds another entry under the identical key, and the page eventually fills. A B-Tree's answer to a full page is a split, which is how an index on a column nobody ever updates doubles in size anyway, purely from churn on other columns.

Splitting to make room for garbage is a bad trade, and since PostgreSQL 14 the B-Tree tries not to. When an incoming entry [doesn't fit](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/nbtree/nbtinsert.c#L917) on its target leaf page, [`_bt_delete_or_dedup_one_page`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/nbtree/nbtinsert.c#L2730) gets a shot at freeing space before the split happens. It works down three options:

1. Delete entries already marked `LP_DEAD` by `_bt_killitems`, if the page has any. Cheapest of the three, since a `LP_DEAD` entry is already known garbage and the pass throws in a few unmarked neighbors while it's visiting their heap blocks anyway.
2. Run a [bottom-up deletion pass](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/nbtree/nbtdedup.c#L309) if the executor says this insert is version churn.
3. Deduplicate, merging equal keys into a posting list.

Step 2's trigger is the interesting half, since the executor already knows whether an `UPDATE` touched any column this particular index cares about. [`index_unchanged_by_update`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/executor/execIndexing.c#L1019) compares the updated columns against the index's key columns and passes down an `indexUnchanged` hint when they don't overlap. A true hint means the entry is a logical duplicate that exists only for MVCC, so most of its neighbors probably are too.

The pass groups the page's entries into runs of equal keys, marks the duplicates "promising", and asks the heap which of their TIDs point at tuples dead to everyone, with nothing known-deletable going in. The B-Tree names a [space target](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/nbtree/nbtdedup.c#L358) of a sixteenth of the page or the new entry's size, whichever is larger. The heap stops checking once it hits that target, or once it decides the visits aren't paying off.

```text
leaf page, key=foo repeated by version churn

before pass                        after pass
┌──────────────────────────┐       ┌──────────────────────────┐
│ foo ──> (0,1)   dead     │       │ foo ──> (7,3)   live     │
│ foo ──> (3,9)   dead     │       │                          │
│ foo ──> (5,2)   dead     │       │ room for the new entry   │
│ foo ──> (7,3)   live     │       │                          │
│ page full ──> must split │       │ no split                 │
└──────────────────────────┘       └──────────────────────────┘
```

### Why guessing is the right design here

All of it is speculative, and the [nbtree README](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/nbtree/README#L589) is upfront about that, calling the pass a backstop against unnecessary version-driven page splits and borrowing the generational hypothesis from garbage collectors: most objects die young. A pass that finds nothing costs a few heap page visits and the page splits as it would have anyway, while a pass that succeeds can keep that page from ever splitting.

Which makes it a different kind of mechanism from vacuum, and that difference is the reason it exists. Vacuum is a scheduled sweep over the whole table reclaiming space long after the fact. Bottom-up deletion is targeted and synchronous, running on the page that has a problem at the moment it has one, so a table under steady non-indexed updates keeps its indexes in shape between autovacuum runs rather than waiting on one. It does nothing for heap bloat, so vacuum keeps its job.

## Index-only scans and the visibility map

Covering indexes run headfirst into all of this, because if every column a query needs is already in the index, Postgres would love to answer from the index alone. It can't, for the reason from two sections ago: the index tuple has no `xmin`/`xmax`. Skipping the heap means skipping the visibility check, and the query cheerfully returns rows deleted last week.

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

The bit says nothing about this tuple specifically, because it's a page-level guarantee, and the logic is that if every tuple on the page is visible to everyone, the one the TID points at is visible too. Enough to skip the fetch without reading a single tuple header.

Which is what the `Heap Fetches` line in `EXPLAIN (ANALYZE)` is telling you. A freshly-vacuumed static table reports zero and never touches the heap. A table under constant writes has most of its bits cleared, so the identical plan does a heap fetch per row and performs nothing like the plan you thought you had. Postgres labels the node "Index Only Scan" either way, so `Heap Fetches` is your only warning that it stopped being one.

HOT doesn't help here, which is worth saying since HOT is otherwise all about avoiding index work. [`heap_update` clears the page's visibility bits](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/heapam.c#L4223) whether the update took the HOT path or not, so index-only scans over a recently updated page fetch from the heap until vacuum sets the bit again. HOT saves index writes, the visibility map saves heap reads, and neither one implies the other. Reaching for `INCLUDE` to get an index-only scan also costs you on the HOT side, and [Part 3](/posts/postgres-vs-mysql-hot-updates/) gets into that.

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

The undo records still need cleaning, and a background [purge thread](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/trx/trx0purge.cc#L2396) drops them once no active transaction needs them. It works on a separate structure rather than on your table, so MySQL ships no `VACUUM` for you to tune or forget to schedule.

None of which is free, since a long-running transaction pins the undo it might need, so undo grows as long as that transaction stays open and readers walking deep chains pay per hop. Postgres bloats the table you query, InnoDB grows a structure off to the side, and both are held hostage by the same idle transaction somebody left open in a psql window.

## Deletes and indexes on the InnoDB side

It's easy to conclude from all that InnoDB deletes rows properly and Postgres doesn't, and it doesn't either. A delete sets a [delete-mark bit](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/rem/rec.h#L147) and leaves the record where it is, for the same reason Postgres does, and the purge thread comes back later for it and its secondary-index entries via [`row_purge_remove_sec_if_poss`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/row/row0purge.cc#L579). Both engines defer the real work, and MySQL just doesn't make you schedule it.

Secondary indexes are where the two designs accidentally converge, because an InnoDB secondary index record carries no `DB_TRX_ID`, so like a Postgres index entry it can't answer a visibility question on its own. Opposite MVCC designs, same hole in the middle.

InnoDB's patch for that hole is close enough to the visibility map to be uncanny:

| | Postgres visibility map | InnoDB index page header |
|---|---|---|
| Granularity | One heap page | One index page |
| The value | 2 bits, `ALL_VISIBLE` and `ALL_FROZEN` | `PAGE_MAX_TRX_ID`, the highest transaction to touch this page |
| The question | Is every tuple here visible to everyone? | Did every change here happen before my snapshot? |
| Yes | Answer from the index | Trust the record as-is |
| No | Fetch the heap tuple and check `xmin`/`xmax` | Take Part 1's second traversal to the primary key |

[`lock_sec_rec_cons_read_sees`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/lock/lock0lock.cc#L273) is what runs that check against the reader's view, using [`PAGE_MAX_TRX_ID`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/page0types.h#L77) out of the page header. Two bits per heap page on one side and one transaction ID per index page on the other, both a page-level watermark that lets a reader skip the visibility check.

One asymmetry undercuts the tidy story. An update changing an indexed column does *not* rewrite the secondary entry in place:

```text
UPDATE users SET email = 'new@a.com' WHERE id = 1

  clustered index                email index
  ┌────────────────────────┐     ┌──────────────────────────────┐
  │ id=1  email=new@a.com  │     │ a@a.com   ──> id=1  DELETED  │
  └────────────────────────┘     │ new@a.com ──> id=1           │
   rewritten in place            └──────────────────────────────┘
   1 write                        old entry delete-marked, new
                                  entry inserted, purge cleans up
```

InnoDB delete-marks the old one, inserts a new one, and leaves purge to sort it out, so index churn on that column looks a lot like Postgres. "InnoDB updates in place" is true of the row and only sometimes true of the indexes.

## Rollback: one write against ten million

Update ten million rows, then change your mind. `ROLLBACK` comes back instantly on Postgres and makes you wait on MySQL, and the reason is the same place old versions go.

Postgres has nothing to undo. Every new tuple it wrote carries `xmin` set to the aborting transaction's ID, and visibility comes from asking the commit log whether that transaction committed, so marking the transaction aborted makes all ten million tuples invisible to everybody at once. [`RecordTransactionAbort`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/transam/xact.c#L1796) does it through [`TransactionIdAbortTree`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/transam/transam.c#L269), a single [`TransactionIdSetTreeStatus`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/transam/clog.c#L192) call setting one status. One row or ten million, same work.

The ten million tuples stay on disk, of course, dead now and indistinguishable from what a committed update leaves behind, so the three-phase vacuum from earlier reclaims them the same way. Nothing got cheaper, it just moved onto a bill Postgres was already going to pay.

InnoDB can't take that route, because the update already overwrote the row. The clustered-index leaf holds the new value and the only surviving copy of the old one is in the undo log, so restoring means reading undo records and applying them, one row at a time, in reverse.

### What that actually looks like

Three statements in one transaction, each writing a different kind of undo record:

```sql
BEGIN;                                             -- trx 900
UPDATE accounts SET balance = 50 WHERE id = 1;     -- was 100
INSERT INTO accounts (id, balance) VALUES (2, 30);
DELETE FROM accounts WHERE id = 3;
ROLLBACK;
```

By the time `ROLLBACK` runs, the table already shows all three changes and the undo log holds the three records needed to walk them back. Each record's [type tag](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/trx0rec.h#L299) says what kind of reversal it needs:

```text
undo log for trx 900              clustered index right now
┌────────────────────────────┐    ┌────────────────────────────┐
│ #3  DEL_MARK    id=3       │    │ id=1  balance=50           │
│ #2  INSERT_REC  id=2       │    │ id=2  balance=30           │
│ #1  UPD_EXIST   id=1       │    │ id=3  delete-marked        │
│         balance was 100    │    │                            │
└────────────────────────────┘    └────────────────────────────┘
   popped newest first
```

Undo records come off in reverse order, and each pop is a real modification to the table:

```text
pop #3  DEL_MARK    ──> clear id=3's delete-mark bit, the row is
                        live again
pop #2  INSERT_REC  ──> physically delete id=2 from the clustered
                        index, plus one delete per secondary index
pop #1  UPD_EXIST   ──> write balance=100 back over id=1 in place
undo log empty       ──> rollback done, 3 records, 3 row operations
```

Rolling back the insert is the part that surprised me. There's no earlier version to restore, so InnoDB removes the record outright with [`row_undo_ins_remove_clust_rec`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/row/row0uins.cc#L68), then calls [`row_undo_ins_remove_sec`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/row/row0uins.cc#L272) for every secondary index entry it created. The comment above [`row_undo_ins`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/row/row0uins.cc#L464) calls this being "eager in a rollback", since purge would have removed those records eventually and doing it now leaves less garbage behind.

The loop driving all of it is [`row_undo`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/row/row0undo.cc#L309), which pops one record with [`trx_roll_pop_top_rec_of_trx`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/trx/trx0roll.cc#L1019), branches on insert versus modification, applies it, and comes back for the next one until the pop returns nothing. No batching and no shortcut for large transactions, so a rollback costs roughly what the transaction cost, sometimes more, since undoing an insert touches every index the insert wrote.

### Which one you notice in production

Long enough rollbacks get their own progress report, because `long_running_diag` in `row0undo.cc` checks in every hundredth row and logs at most once every ten seconds:

```text
Still rolling back transaction 900; 4300000 undo records rolled
back out of 10000000 total (43% complete).
```

A percentage-complete message only exists because rollbacks routinely run long enough for somebody to wonder whether the server hung. You can watch the same number climb live in `information_schema.innodb_trx`, where [`trx_rows_modified`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/trx/trx0i_s.cc#L474) reports the undo count.

Practically, a batch job you kill halfway through bills you a second time for what it already spent, and killing the client doesn't get you out of it, since the rollback runs server-side either way. Postgres in that spot aborts instantly and hands the mess to autovacuum. That's the better deal if you cancel things often and the worse one if you were hoping to stay out of a vacuum problem. Neither engine gives the work back.

## Why the difference exists

Eight rows of consequence out of one decision about where old versions go:

| | PostgreSQL | MySQL (InnoDB) |
|---|---|---|
| On update | New tuple in the heap, old one marked dead | Row rewritten in place |
| Old versions live | In the main heap, beside live rows | In the undo log, off the table |
| Reading an old version | Read a different tuple directly | Walk the undo chain and reverse changes |
| On delete | Set `xmax`, leave tuple and index entries | Set delete-mark bit, leave record |
| Cleanup | `VACUUM` reclaims dead tuples | Purge thread trims undo and marked records |
| Index visibility shortcut | Visibility map, 2 bits per heap page | `PAGE_MAX_TRX_ID` per index page |
| Rollback cost | One clog status write, any size | One undo record per row change |
| Main-table bloat | Yes, without vacuuming | No |

Neither is free, and they don't fail in comparable ways. Postgres pays with vacuum scheduling and bloat management, and gets recent versions sitting right there in the heap, readable at full speed. InnoDB pays with undo-chain walks that slow down the further back your snapshot reaches, and gets a main table that stays compact and in key order permanently.

Postgres has one sharp edge left, the one the two-entry diagrams above already showed you. Every update writes a new tuple at a new TID, so every index needs a new entry pointing at it, including indexes on columns the update didn't touch.

So put a dozen indexes on a table and run an `UPDATE` setting `last_login = now()`, a column nobody indexed, and Postgres writes thirteen things. Uber hit this exact wall on their trips table and [wrote it up](https://www.uber.com/us/en/blog/postgres-to-mysql-migration) as write amplification. A single field update turned into a rewrite of every index on the row, plus the WAL to replicate all of it to their followers.

Postgres would be unusable for that workload if it actually behaved this way, which is a strong hint it doesn't. [Part 3](/posts/postgres-vs-mysql-hot-updates/) is the mechanism that saves it.
