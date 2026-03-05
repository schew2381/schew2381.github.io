---
title: "How PostgreSQL Builds Indexes Without Blocking Writes"
date: 2026-03-04 18:00:00 -0800
categories: [PostgreSQL, Internals]
tags: [postgres, indexes, concurrency, locks]
---

When you run `CREATE INDEX` on a production table, PostgreSQL takes a `SHARE` lock for the entire duration. That lock blocks all writes. For a large table, this can mean minutes or hours of downtime.

`CREATE INDEX CONCURRENTLY` solves this by splitting the work across multiple transactions with weaker locks. But the internal mechanism is surprisingly intricate. This post walks through exactly how it works, straight from the [source code](https://github.com/postgres/postgres/blob/master/src/backend/catalog/index.c#L3284-L3346).

## The core problem

A normal index build can take a single consistent snapshot, scan the table, and build the index. Simple. But if we want to allow writes during the build, we have a consistency problem: rows can be inserted, updated, or deleted while we're scanning. How do we guarantee the index ends up with every row it should have?

PostgreSQL's answer: two table scans with a state transition between them.

## The five transactions

The entire operation spans [five separate transactions](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1628-L1835) with three wait-for-transactions barriers between them. Two important flags on [`pg_index`](https://github.com/postgres/postgres/blob/master/src/include/catalog/pg_index.h) control the index's lifecycle:

- **`indisready`** — when true, all DML (INSERT/UPDATE/DELETE) maintains this index as a side effect
- **`indisvalid`** — when true, the query planner can use this index

Both start as `false`.

### Transaction 1: Catalog entry

```
indisready=false, indisvalid=false
```

PostgreSQL [creates the index entry](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1628-L1652) in `pg_index` and `pg_class`. The index is visible in the catalog but completely inert — no one reads from it, no one writes to it. Commit.

### Wait 1: Drain old writers

[`WaitForLockers()`](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1692) blocks until every transaction that had the table open *before* the index existed has finished. After this, all active transactions see the new index in the catalog. This matters for HOT chain safety — PostgreSQL needs to ensure no new HOT updates break the index's key columns.

### Transaction 2: First table scan

```
indisready=false → indisready=true
```

[`index_concurrently_build()`](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1716) takes a fresh snapshot and does a full table scan, inserting every visible tuple into the index. Then it [sets `indisready=true`](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1722) and commits.

During this entire scan, `indisready` is still `false`. The [`execIndexing.c`](https://github.com/postgres/postgres/blob/master/src/backend/executor/execIndexing.c) code that runs during INSERT/UPDATE/DELETE checks this flag:

```c
if (!indexInfo->ii_ReadyForInserts)
    continue;  /* skip this index */
```

So concurrent DML **ignores the index completely** during the first scan. Rows written during this window are not in the index.

### Wait 2: Drain transactions that missed the index

[`WaitForLockers()`](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1739) again. This time we wait for all transactions that saw `indisready=false`. After this wait, every active transaction's DML is maintaining the index — their writes go into the index as a side effect of INSERT/UPDATE/DELETE.

### Transaction 3: Second table scan (validation)

```
indisready=true, indisvalid=false → indisvalid=true
```

This is [`validate_index()`](https://github.com/postgres/postgres/blob/master/src/backend/catalog/index.c#L3348-L3475). It does three things:

1. **Scan the index** — collect all TIDs currently in the index into a sorted list
2. **Scan the heap** — merge-join against the TID list to find tuples that *should* be in the index but aren't
3. **Insert the missing tuples**

These "missing tuples" are exactly the rows that were written during the first scan when `indisready` was false.

### Wait 3: Drain old snapshots

[`WaitForOlderSnapshots()`](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1803) waits for all transactions with snapshots predating the reference snapshot. This ensures no active transaction could see a tuple that we chose not to index (e.g., one deleted just before our snapshot). After this, [`indisvalid=true`](https://github.com/postgres/postgres/blob/master/src/backend/commands/indexcmds.c#L1814) is set, and the index is open for queries.

## Why this guarantees completeness

Every row ends up in the index through exactly one of three paths:

| Row written... | How it gets indexed |
|---|---|
| Before the first scan | First scan indexes it |
| During the first scan (`indisready=false`) | Second scan catches it |
| After `indisready=true` | The writing transaction's DML hooks insert it |

The waits between phases ensure there are no gaps between these three sets. By the time the second scan runs, Wait 2 has guaranteed that every active transaction is maintaining the index. So any write happening *during* the second scan is handled by the DML hooks, not by the scan.

The source code [acknowledges the brute-force nature](https://github.com/postgres/postgres/blob/master/src/backend/catalog/index.c#L3342-L3345):

```c
/*
 * Doing two full table scans is a brute-force strategy.  We could try to be
 * cleverer, eg storing new tuples in a special area of the table (perhaps
 * making the table append-only by setting use_fsm).  However that would
 * add yet more locking issues.
 */
```

## The virtual xid wait mechanism

The "wait for all transactions" steps work via **virtual transaction ID locks**. PostgreSQL:

1. Snapshots the list of all running virtual xids
2. Attempts to acquire a `ShareLock` on each one
3. A running transaction holds an `ExclusiveLock` on its own virtual xid
4. SHARE conflicts with EXCLUSIVE, so the request blocks until that transaction ends

This is why `CREATE INDEX CONCURRENTLY` can appear to hang — it's waiting for *every* open transaction, even ones touching completely unrelated tables. And this is visible in `pg_stat_activity` via `pg_blocking_pids()`.

## The uniqueness edge case

Building a unique index concurrently has a real race condition during the first scan.

Consider a table with an existing row `name='Alice'`. We're building a unique index on `name`:

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

Now the table has *two* rows with `name='Alice'`. The index only has the original.

After `indisready=true` is set and Wait 2 completes, the second scan runs. It finds the concurrent txn's `Alice` is missing from the index and tries to insert it. The B-tree finds the existing `Alice` and raises a uniqueness violation.

The [source code comments](https://github.com/postgres/postgres/blob/master/src/backend/catalog/index.c#L3326-L3333) describe the subtlety:

```c
/*
 * Building a unique index this way is tricky: we might try to insert a
 * tuple that is already dead or is in process of being deleted, and we
 * mustn't have a uniqueness failure against an updated version of the same
 * row.  ...we expect the index AM to recheck liveness of the to-be-inserted
 * tuple before it declares a uniqueness error.
 */
```

The B-tree rechecks whether the conflicting tuple is still live before reporting the error. This avoids false positives from concurrent UPDATEs (where the old and new versions of the *same* row might both appear).

But if both rows genuinely are live duplicates — `CREATE INDEX CONCURRENTLY` **fails** and leaves behind an invalid index:

```sql
ERROR:  could not create unique index "ix_users_name"
DETAIL:  Key (name)=(Alice) is duplicated.

-- The invalid index lingers and must be cleaned up:
\d users
--  "ix_users_name" btree (name) INVALID

DROP INDEX CONCURRENTLY ix_users_name;
```

Once the second scan begins, the window closes. The docs note: *"the uniqueness constraint is already being enforced against other transactions when the second table scan begins"* — because `indisready=true` means DML hooks are checking uniqueness on every INSERT.

## Lock strength

Throughout all of this, the only table-level lock held is `ShareUpdateExclusiveLock`. This is one of the weakest lock modes — it conflicts only with DDL operations and other concurrent index builds, *not* with reads or writes. This is why normal application traffic is unaffected.

| Lock Mode | Blocks Reads | Blocks Writes | Blocks DDL |
|---|---|---|---|
| `SHARE` (regular `CREATE INDEX`) | No | **Yes** | Yes |
| `ShareUpdateExclusive` (CONCURRENTLY) | No | No | Yes |

The trade-off: the operation takes longer (two full scans + three waits instead of one scan), and it can fail in ways that a regular `CREATE INDEX` cannot. But it doesn't block your application.
