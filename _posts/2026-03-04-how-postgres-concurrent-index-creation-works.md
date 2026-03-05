---
title: "How PostgreSQL Builds Indexes Without Blocking Writes"
date: 2026-03-04 18:00:00 -0800
categories: [postgres, internals]
tags: [postgres, index, database, locks]
---

`CREATE INDEX` takes a `SHARE` lock on the table for the entire build. That blocks all writes — minutes or hours of downtime for large tables.

`CREATE INDEX CONCURRENTLY` avoids this by splitting the work across multiple transactions with weaker locks. The internal mechanism is non-trivial. This post traces through the [source code](https://github.com/postgres/postgres/blob/master/src/backend/catalog/index.c#L3284-L3346) to explain exactly what happens.

## The core problem

A normal index build takes a consistent snapshot, scans the table, and builds the index. Allowing concurrent writes breaks this — rows can be inserted, updated, or deleted mid-scan. PostgreSQL solves this with two table scans and a state transition between them.

## The overview

```
 indisready=false                          indisready=true
 indisvalid=false                          indisvalid=false
 ◄──────────────────────────────────────── ──────────────────────────────────────────►

 Txn 1           Txn 2                     Txn 3              Txn 4          Txn 5
 ┌──────────┐   ┌─────────────────────┐   ┌──────────────┐   ┌───────────┐  ┌──────┐
 │ Create    │   │ First table scan    │   │ Second table │   │ Wait for  │  │ Set  │
 │ catalog   │   │ (build index from   │   │ scan (find & │   │ old       │  │index │
 │ entry     │   │  all visible rows)  │   │ insert rows  │   │ snapshots │  │valid │
 │           │   │                     │   │ missed by    │   │           │  │      │
 │           │   │ Set indisready=true │   │ first scan)  │   │           │  │      │
 └─────┬─────┘   └──────────┬──────────┘   └──────┬───────┘   └─────┬─────┘  └──┬───┘
       │                    │                      │                 │            │
    COMMIT              COMMIT                  COMMIT           COMMIT       COMMIT
       │                    │                      │                 │
       ▼                    ▼                      ▼                 ▼
   Wait for            Wait for               (reference         Wait for
   old writers         txns that saw           snapshot           txns with older
   to finish           indisready=false        taken here)        snapshots
```

During the first scan, concurrent writes **skip the index entirely** — `indisready` is false. After the first scan commits with `indisready=true`, all new DML starts maintaining the index. The second scan catches the gap: rows written during the first scan that never made it into the index.

## The five transactions

The operation spans [five separate transactions](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1628-L1835) with three wait barriers. Two flags on [`pg_index`](https://github.com/postgres/postgres/blob/master/src/include/catalog/pg_index.h) control the index's lifecycle:

- **`indisready`** — when true, all DML (INSERT/UPDATE/DELETE) maintains this index as a side effect
- **`indisvalid`** — when true, the query planner can use this index

Both start as `false`.

### Transaction 1: Catalog entry

```
indisready=false, indisvalid=false
```

[Creates the index entry](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1628-L1652) in `pg_index` and `pg_class`. The index is visible in the catalog but inert — nothing reads from it, nothing writes to it. Commit.

### Wait 1: Drain old writers

[`WaitForLockers()`](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1692) blocks until every transaction that had the table open *before* the index existed has finished. After this, all active transactions see the new index in the catalog. This is required for HOT chain safety — no new HOT updates can break the index's key columns.

### Transaction 2: First table scan

```
indisready=false → indisready=true
```

[`index_concurrently_build()`](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1716) takes a fresh snapshot and does a full table scan, inserting every visible tuple into the index. Then it [sets `indisready=true`](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1722) and commits.

During the entire scan, `indisready` is still `false`. The [`execIndexing.c`](https://github.com/postgres/postgres/blob/master/src/backend/executor/execIndexing.c) code that runs during INSERT/UPDATE/DELETE checks this flag:

```c
if (!indexInfo->ii_ReadyForInserts)
    continue;  /* skip this index */
```

Concurrent DML **ignores the index completely** during the first scan. Rows written in this window are not in the index.

### Wait 2: Drain transactions that missed the index

[`WaitForLockers()`](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1739) again — this time waiting for all transactions that saw `indisready=false`. After this, every active transaction's DML is maintaining the index.

### Transaction 3: Second table scan (validation)

```
indisready=true, indisvalid=false → indisvalid=true
```

[`validate_index()`](https://github.com/postgres/postgres/blob/master/src/backend/catalog/index.c#L3348-L3475) does three things:

1. **Scans the index** — collects all TIDs currently in the index into a sorted list
2. **Scans the heap** — merge-joins against the TID list to find tuples that *should* be in the index but aren't
3. **Inserts the missing tuples**

The missing tuples are the rows written during the first scan when `indisready` was false.

### Wait 3: Drain old snapshots

[`WaitForOlderSnapshots()`](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1803) waits for all transactions with snapshots predating the reference snapshot. This ensures no active transaction can see a tuple that was excluded from the index. After this, [`indisvalid=true`](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1814) is set and the index is open for queries.

## Completeness guarantee

Every row reaches the index through exactly one of three paths:

| Row written... | How it gets indexed |
|---|---|
| Before the first scan | First scan indexes it |
| During the first scan (`indisready=false`) | Second scan catches it |
| After `indisready=true` | The writing transaction's DML hooks insert it |

The waits between phases ensure no gaps between these sets. By the time the second scan runs, Wait 2 has guaranteed every active transaction is maintaining the index. Writes happening *during* the second scan are handled by the DML hooks, not by the scan.

From the [source](https://github.com/postgres/postgres/blob/master/src/backend/catalog/index.c#L3342-L3345):

```c
/*
 * Doing two full table scans is a brute-force strategy.  We could try to be
 * cleverer, eg storing new tuples in a special area of the table (perhaps
 * making the table append-only by setting use_fsm).  However that would
 * add yet more locking issues.
 */
```

## The virtual xid wait mechanism

The "wait for all transactions" barriers use **virtual transaction ID locks**:

1. Snapshot the list of all running virtual xids
2. Acquire a `ShareLock` on each one
3. Each running transaction holds an `ExclusiveLock` on its own virtual xid
4. SHARE conflicts with EXCLUSIVE — the request blocks until that transaction ends

This is why `CREATE INDEX CONCURRENTLY` can appear to hang: it waits for *every* open transaction, including ones touching completely unrelated tables. These waits are visible in `pg_stat_activity` via `pg_blocking_pids()`.

## The uniqueness edge case

Building a unique index concurrently has a race condition during the first scan.

A table has an existing row `name='Alice'`. A unique index build on `name` starts:

```
First scan (indisready=false):
  ┌──scanning──────────┐
  │ ...                 │  ← "Alice" not yet reached
  │                     │
  │   Concurrent txn:   │
  │   INSERT name='Alice'
  │   → checks ii_ReadyForInserts → false
  │   → SKIPS uniqueness check entirely
  │   → INSERT succeeds, commits
  │                     │
  │ ...scan reaches     │
  │ original "Alice"    │
  │ → indexes it        │
  └─────────────────────┘
```

The table now has *two* rows with `name='Alice'`. The index only has the original.

After `indisready=true` is set and Wait 2 completes, the second scan finds the concurrent txn's `Alice` missing from the index and tries to insert it. The B-tree finds the existing `Alice` and raises a uniqueness violation.

The [source code](https://github.com/postgres/postgres/blob/master/src/backend/catalog/index.c#L3326-L3333) handles this carefully:

```c
/*
 * Building a unique index this way is tricky: we might try to insert a
 * tuple that is already dead or is in process of being deleted, and we
 * mustn't have a uniqueness failure against an updated version of the same
 * row.  ...we expect the index AM to recheck liveness of the to-be-inserted
 * tuple before it declares a uniqueness error.
 */
```

The B-tree rechecks whether the conflicting tuple is still live before reporting the error — this avoids false positives from concurrent UPDATEs where old and new versions of the *same* row both appear.

If both rows are genuinely live duplicates, `CREATE INDEX CONCURRENTLY` **fails** and leaves an invalid index:

```sql
ERROR:  could not create unique index "ix_users_name"
DETAIL:  Key (name)=(Alice) is duplicated.

-- The invalid index must be cleaned up manually:
\d users
--  "ix_users_name" btree (name) INVALID

DROP INDEX CONCURRENTLY ix_users_name;
```

The race window only exists during the first scan. Once the second scan begins, `indisready=true` means DML hooks enforce uniqueness on every INSERT.

## Lock strength

The only table-level lock held throughout is `ShareUpdateExclusiveLock` — one of the weakest modes. It conflicts only with DDL and other concurrent index builds, not with reads or writes.

| Lock Mode | Blocks Reads | Blocks Writes | Blocks DDL |
|---|---|---|---|
| `SHARE` (regular `CREATE INDEX`) | No | **Yes** | Yes |
| `ShareUpdateExclusive` (CONCURRENTLY) | No | No | Yes |

The trade-off: two full scans + three waits instead of one scan, and the operation can fail in ways `CREATE INDEX` cannot. But it doesn't block application traffic.
