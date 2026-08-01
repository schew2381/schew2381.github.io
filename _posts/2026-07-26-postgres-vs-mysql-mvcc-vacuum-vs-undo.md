---
title: "(Part 2) Postgres vs MySQL: MVCC, Vacuum vs the Undo Log"
date: 2026-07-26 09:15:00 -0700
categories: [databases, internals]
tags: [postgres, mysql, innodb, mvcc, vacuum]
---

> Part 2 of a five-part series:
> 1. [Clustered index vs heap](/posts/postgres-vs-mysql-storage-clustered-vs-heap/)
> 2. MVCC: vacuum vs the undo log (this post)
> 3. [HOT updates](/posts/postgres-vs-mysql-hot-updates/)
> 4. [Page splits, TOAST, and UUIDs](/posts/postgres-vs-mysql-page-splits-toast-uuids/)
> 5. [Connections: processes vs threads](/posts/postgres-vs-mysql-connection-models/)
{: .prompt-info }

Both engines use MVCC, multi-version concurrency control, so readers never block writers and writers never block readers. Each transaction sees a consistent snapshot of the database without holding read locks. The two engines reach that guarantee from opposite directions, and the direction explains why Postgres ships a `VACUUM` command and MySQL doesn't.

The split follows directly from [Part 1](/posts/postgres-vs-mysql-storage-clustered-vs-heap/). Postgres keeps old row versions in the same heap as the live data. InnoDB keeps the live row in place and pushes old versions somewhere else.

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

Keeping the old version is what makes concurrent snapshots work. A transaction that started at `xid=103` still reads `(0,1)` and sees `foo`, because `xmax=105` is a transaction it can't see. A transaction starting after 105 commits reads `(0,2)` and sees `bar`. Same row, two versions, no locks.

The dead tuple can't be removed until no active transaction could still need it. Once that's true, its space is wasted until something reclaims it. That something is `VACUUM`.

## What a delete actually does

A delete doesn't remove anything. Postgres sets `xmax` on the tuple and returns. The tuple, its data, and every index entry pointing at it all stay exactly where they were.

Nothing in the index stops a later query from finding that surviving entry. An index tuple is just [a key and a TID](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/itup.h#L35), with no `xmin` or `xmax` of its own, so it can't answer a visibility question at all. The check happens after the index hands over the TID, when Postgres fetches the heap tuple and tests `xmin`/`xmax` against the snapshot. A deleted row still gets found in the index, fetched from the heap, and then thrown away as invisible.

So an index entry never points at "the current version" of a row. It points at one specific physical tuple, and that tuple's own header decides whether the reader is allowed to see it.

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

`VACUUM` is what turns dead tuples back into free space. [`heap_vacuum_rel`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L624) drives it, and the ordering it uses matters more than the cleanup itself.

The constraint is that heap slots get reused. If vacuum freed a slot while an index entry still pointed at it, the next insert would land in that slot and the stale index entry would silently start resolving to an unrelated row. Postgres avoids this with an invariant, stated in the [`lazy_scan_heap`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L1279) header comment: no index entry may ever point at a reusable slot. Holding that invariant is what forces vacuum into more than one pass over the heap.

To see how, you need the slot itself. Every heap page starts with an array of line pointers, and a TID's offset selects one of them. Each pointer carries a [state flag](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/storage/itemid.h#L38):

- `LP_NORMAL`, pointing at real tuple data on the page.
- `LP_DEAD`, tuple data gone, slot not reusable yet.
- `LP_UNUSED`, slot free for the next insert.
- `LP_REDIRECT`, forwarding to another slot, used by HOT.

`LP_DEAD` is the state that makes the invariant work. It's a tombstone: the tuple body is gone and its bytes are reclaimed, but the slot number stays reserved, so an index entry still pointing there resolves to something well-defined instead of a stranger's row.

Vacuum then runs in three phases:

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

The phases have to run in that order and can't be collapsed. Phase 3 waits on phase 2, and phase 2 scans every index in full, which is why vacuuming a table with eight indexes costs roughly eight index scans. A table with no indexes at all skips straight from `LP_NORMAL` to `LP_UNUSED` in a single pass, since there's no index that could be holding a stale pointer.

TIDs are not renumbered. Nothing compacts the heap or shifts live rows down into lower slots, because moving a live tuple would invalidate every index entry pointing at its old TID. Live rows keep their addresses for as long as they exist. Vacuum only recycles the gaps around them, so the file stays the same size and later inserts fill the holes. That's why a table that shed 90% of its rows still occupies the same disk space after a plain `VACUUM`. Trailing empty pages are the one exception, since [`lazy_truncate_heap`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L3142) can hand fully-empty pages at the end of the file back to the OS.

Vacuum has a second job unrelated to space. Transaction IDs are 32 bits and wrap around, so an ancient tuple's `xmin` would eventually look like it came from the future. Vacuum *freezes* old tuples by setting [`HEAP_XMIN_FROZEN`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/htup_details.h#L206), which marks a tuple unconditionally visible and retires its `xmin` from comparison. Autovacuum will force a pass over a table it otherwise had no reason to touch just to get this done.

Indexes also get cleaned outside of vacuum. When an index scan follows a TID and finds every tuple in the chain dead, [`index_fetch_heap`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/index/indexam.c#L677) sets a `kill_prior_tuple` hint, and [`_bt_killitems`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/nbtree/nbtutils.c#L191) marks that index entry `LP_DEAD` so later scans skip it without a heap fetch. Postgres also runs [bottom-up index deletion](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/nbtree/nbtpage.c#L1523) when an index page is about to split, clearing out version churn instead of growing the tree.

## Index-only scans and the visibility map

A covering index raises an awkward problem. If every column a query needs is already in the index, Postgres would like to answer from the index alone and skip the heap entirely. It can't, for the reason above: the index tuple has no `xmin`/`xmax`, so it can't prove the row is visible. Skipping the heap means skipping the visibility check, and the query would happily return deleted rows.

Postgres gets around it with the visibility map, a small bitmap alongside each table holding [two bits per heap page](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/visibilitymapdefs.h#L17):

- [`ALL_VISIBLE`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/visibilitymapdefs.h#L20), every tuple on this page is visible to every transaction.
- [`ALL_FROZEN`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/visibilitymapdefs.h#L21), every tuple on this page is frozen.

Two bits per 8 KB page makes the map tiny enough that it usually sits in memory in full. Vacuum sets `ALL_VISIBLE` when a page it just cleaned has nothing left but universally-visible tuples, and any write to that page clears the bit immediately.

An index-only scan reads the index entry, takes the block number out of the TID, and checks that block's bit. [`nodeIndexonlyscan.c`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/executor/nodeIndexonlyscan.c#L165) does exactly this:

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

The bit says nothing about this tuple specifically. It's a page-level guarantee, and the reasoning is that if every tuple on the page is visible to everyone, then whichever tuple the TID points at is visible too. That's enough to skip the fetch without ever reading the tuple header.

This is why `EXPLAIN (ANALYZE)` on an index-only scan reports `Heap Fetches`. A freshly-vacuumed static table reports zero and never touches the heap. A table taking constant writes has most of its `ALL_VISIBLE` bits cleared, so the same plan quietly falls back to a heap fetch per row. The plan node still says "Index Only Scan" either way, and the `Heap Fetches` count is the only thing that tells you it isn't behaving like one.

HOT changes nothing here, which is worth stating plainly since HOT is otherwise all about avoiding index work. A HOT update writes a new tuple onto the page, and [`heap_update` clears that page's bits](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/heapam.c#L4223) whether the update took the HOT path or not, so index-only scans over a recently HOT-updated page go back to fetching from the heap until vacuum sets the bit again. The two mechanisms are independent: HOT saves index writes, the visibility map saves heap reads.

Covering indexes come with one trap. An `INCLUDE` column still blocks HOT. The relcache loop that decides which columns are HOT-blocking iterates over [`indnatts`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/utils/cache/relcache.c#L5449), the total attribute count rather than just the key columns, so adding `INCLUDE (last_login)` to make a scan index-only also means every `last_login` update stops being HOT.

## MySQL: update in place, old version to the undo log

InnoDB overwrites the row where it sits in the clustered-index leaf. To preserve the old version for MVCC, it first copies the pre-image into the [undo log](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/trx0undo.h) and links the live row to it.

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

The live row took its new value in place, so no index entry has to change. An older transaction that shouldn't see `bar` reconstructs the version it *should* see by walking the undo chain backward, applying each undo record in reverse until the row matches its snapshot:

```text
reader with snapshot < 105
  1. read the clustered-index row: DB_TRX_ID = 105
  2. 105 is newer than my snapshot, so I can't see this version
  3. follow DB_ROLL_PTR into the undo log
  4. apply the undo record in reverse ──> name = foo
  5. that version is visible ──> return it
```

InnoDB's read-view logic lives in [`read0read.cc`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/read/read0read.cc). Because the live row stays put, the main table never accumulates dead versions the way a Postgres heap does.

The undo records still have to be cleaned up, but that happens off the main table. A background [purge thread](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/trx/trx0purge.cc#L2396) discards undo records once no active transaction needs them. There's no user-facing `VACUUM`, and the table itself doesn't bloat with dead rows.

## Deletes and indexes on the InnoDB side

InnoDB doesn't erase a deleted row either, and for the same reason: older snapshots may still need it. It sets a [delete-mark bit](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/rem/rec.h#L147) on the record and leaves it in place. The same purge thread later removes the marked clustered-index record along with the matching secondary-index entries, through [`row_purge_remove_sec_if_poss`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/row/row0purge.cc#L579).

Secondary indexes are where InnoDB's version story gets interesting. A secondary index record carries no `DB_TRX_ID` of its own, so like a Postgres index entry it can't answer a visibility question by itself. InnoDB's workaround is close in spirit to the visibility map: each index page stores a [`PAGE_MAX_TRX_ID`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/page0types.h#L77), the highest transaction ID that has modified anything on that page.

[`lock_sec_rec_cons_read_sees`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/lock/lock0lock.cc#L273) compares that page-level maximum against the reader's view. If every modification to the page predates the snapshot, the record is trustworthy as it stands and InnoDB serves a covering index query without touching the clustered index. Otherwise it does the second traversal from Part 1 and checks visibility properly at the row. Both engines land on the same trick: a page-level watermark that lets a reader skip the visibility check when nothing recent has touched the page.

Updates behave asymmetrically here. When an update changes an indexed column, InnoDB doesn't rewrite the secondary entry in place. It delete-marks the old entry and inserts a new one, leaving purge to clean up, so index churn on that column ends up looking a lot like the Postgres behavior even though the clustered-index row itself was rewritten in place.

## Why the difference exists

It comes straight back to where old versions go.

| | PostgreSQL | MySQL (InnoDB) |
|---|---|---|
| On update | New tuple in the heap, old one marked dead | Row rewritten in place |
| Old versions live | In the main heap, beside live rows | In the undo log, off the table |
| Reading an old version | Read a different tuple directly | Walk the undo chain and reverse changes |
| On delete | Set `xmax`, leave tuple and index entries | Set delete-mark bit, leave record |
| Cleanup | `VACUUM` reclaims dead tuples | Purge thread trims undo and marked records |
| Index visibility shortcut | Visibility map, 2 bits per heap page | `PAGE_MAX_TRX_ID` per index page |
| Main-table bloat | Yes, without vacuuming | No |

Neither is free. Postgres pays with `VACUUM` and bloat management, and gets fast access to any recent version since it's just another tuple. InnoDB pays with undo-chain walks for long-running readers, and gets a compact, always-in-order main table.

Postgres's approach has an obvious sharp edge, visible in the two-entry diagram above. An update writes a whole new tuple at a new TID, so every index on the table needs a new entry pointing at it, even indexes on columns that didn't change. That penalty would make updating a single unindexed column absurdly expensive. [Part 3](/posts/postgres-vs-mysql-hot-updates/) is about the mechanism that avoids it: HOT.
