---
title: "How PostgreSQL Builds Indexes Without Blocking Writes"
date: 2026-03-04 18:00:00 -0800
categories: [postgres, internals]
tags: [postgres, index, database, locks]
---

`CREATE INDEX` takes a `SHARE` lock for the entire build, so every write to the table waits. On a large table that's minutes or hours of rejected writes, and adding `CONCURRENTLY` makes it go away.

The interesting question is how, because the obvious approach doesn't work. A plain build takes one snapshot and scans the table once, which is only correct if the table stops changing. Allow writes during the scan and rows get inserted, updated, and deleted in the region the scan has already passed, so the index it produces is missing rows that exist.

Postgres solves that by scanning the table twice across four transactions, using two catalog flags to make the second scan able to find exactly what the first one missed. This post traces the [source](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/catalog/index.c#L3319-L3381) through all four.

```text
 Txn 1                Txn 2                Txn 3                Txn 4
 ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
 │ Create the   │     │ Wait 1       │     │ Wait 2       │     │ Wait 3       │
 │ catalog      │     │              │     │              │     │              │
 │ entry        │     │ First scan   │     │ Second scan  │     │ Set          │
 │              │     │              │     │              │     │ indisvalid   │
 │              │     │ Set          │     │              │     │              │
 │              │     │ indisready   │     │              │     │              │
 └──────┬───────┘     └──────┬───────┘     └──────┬───────┘     └──────┬───────┘
        │                    │                    │                    │
     COMMIT               COMMIT               COMMIT               COMMIT
        │                    │                    │                    │
        ▼                    ▼                    ▼                    ▼
  index exists         DML starts           index holds          planner can
  but is inert         maintaining it       every row            use it
```

Every commit in that sequence publishes a state, and every wait exists to make sure nobody is still operating on the previous one.

## The four transactions

The whole sequence is driven by two booleans on [`pg_index`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/catalog/pg_index.h#L44-L46). `indisready` decides whether DML maintains the index, and `indisvalid` decides whether the planner is allowed to use it. Both start false, they flip in that order, and the gap between the two flips is where all the interesting work happens.

Each of the [four transactions](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/commands/indexcmds.c#L1641-L1849) commits so the next one can see a state the previous one published. Three of them open by waiting for the writers that haven't caught up yet.

### Transaction 1: Catalog entry

```text
indisready=false, indisvalid=false
```

[Creates the index entry](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/commands/indexcmds.c#L1641-L1665) in `pg_index` and `pg_class`. The index is visible in the catalog but inert, so nothing reads from it and nothing writes to it. Commit.

### Transaction 2: First table scan

```text
indisready=false → indisready=true
```

This one opens on a wait. [`WaitForLockers()`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/commands/indexcmds.c#L1705) blocks until every transaction that had the table open *before* the index existed has finished, which is what makes HOT chains safe. A transaction that never saw the index could break the index's key columns with a HOT update, and after the wait no such transaction is left running.

Then [`index_concurrently_build()`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/commands/indexcmds.c#L1729) takes a fresh snapshot and does a full table scan, inserting every visible tuple into the index. It [sets `indisready=true`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/catalog/index.c#L1560) on the way out and commits.

The flag is still `false` for the whole scan, though, which is what makes the second scan necessary. The [`execIndexing.c`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/executor/execIndexing.c#L368-L370) code that runs during INSERT/UPDATE/DELETE checks it:

```c
if (!indexInfo->ii_ReadyForInserts)
    continue;  /* skip this index */
```

So concurrent DML ignores the index completely while the first scan runs, and every row written in that window is missing from it.

### Transaction 3: Second table scan

```text
indisready=true, indisvalid=false
```

Another [`WaitForLockers()`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/commands/indexcmds.c#L1752) opens this one, draining the transactions that were still running with `indisready=false`. Once they're gone, every transaction on the table is maintaining the index, so the set of missing rows stops growing and becomes something a scan can finish.

The build then takes a [reference snapshot](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/commands/indexcmds.c#L1769) and hands it to [`validate_index()`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/catalog/index.c#L3383-L3510), which finds those rows by comparing the index against the heap:

1. Collect every TID currently in the index, using a [bulk-delete callback](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/catalog/index.c#L3461-L3462) that stores TIDs and never actually deletes anything.
2. Sort them.
3. Scan the heap and [merge-join](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/catalog/index.c#L3485) against that sorted list, inserting whatever the index turns out to be missing.

The sort is what makes step 3 a single pass over both structures instead of an index lookup per heap tuple.

### Transaction 4: Mark it valid

```text
indisvalid=false → indisvalid=true
```

One problem is left. The second scan indexed what its reference snapshot could see, so a transaction holding an *older* snapshot might still be able to see a row that got left out. [`WaitForOlderSnapshots()`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/commands/indexcmds.c#L1816) waits those out, then [`indisvalid=true`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/commands/indexcmds.c#L1827) makes the index available to the planner.

That wait is narrower than it sounds, because a transaction only matters if a missing index entry could give it a wrong answer. The ones [safe to ignore](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/commands/indexcmds.c#L417-L432):

- Any transaction whose own `xmin` is newer than the reference, since its oldest snapshot is newer too.
- Any transaction holding no snapshot at all, including a session gone idle with `xmin` cleared.
- Transactions in other databases, which can never see this index.
- Autovacuum and manual `VACUUM`, neither of which is fazed by a missing entry.
- Other `CREATE INDEX CONCURRENTLY` runs, as long as the indexes involved are neither partial nor expressional, because then they read nothing outside their own table.

## How the waits actually wait

Three of those four transactions open by waiting, and there's no "wait for these transactions" primitive to do it with, so Postgres builds one out of the regular lock manager. Every backend takes an `ExclusiveLock` on [its own virtual transaction id](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/storage/lmgr/lock.c#L4600-L4614) when it starts and holds it until commit. To wait for that backend, [`VirtualXactLock()`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/storage/lmgr/lock.c#L4822) requests a `ShareLock` on the same tag.

`ShareLock` conflicts with `ExclusiveLock`, so that request sleeps until the other transaction ends and drops its lock. Then the acquisition succeeds and is [released immediately](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/storage/lmgr/lock.c#L4822-L4824), because the lock was never the point. The blocking was.

`CREATE INDEX CONCURRENTLY` can look hung in this state, and one long-running transaction is usually the whole story. It isn't waiting on *every* open transaction, though. [`GetLockConflicts()`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/storage/lmgr/lmgr.c#L923-L933) collects only the backends holding a lock on this table that conflicts with `ShareLock`, which is the ones writing to it. A session sitting idle after touching some other table isn't in the list.

`pg_stat_progress_create_index` is how you tell which of the three waits you're in, and its `lockers_total`, `lockers_done`, and `current_locker_pid` columns name how much is left and whose transaction to go ask about.

## Completeness guarantee

Put the scans and the waits together and every row reaches the index by exactly one of three paths.

| Row written... | How it gets indexed |
|---|---|
| Before the first scan | The first scan indexes it |
| During the first scan, `indisready=false` | The second scan catches it |
| After `indisready=true` | The writing transaction's DML hooks insert it |

Writes landing *during* the second scan fall into the third row, not a fourth, which is exactly what Wait 2 bought. The waits are what leave no gap between the three.

Postgres is candid about the cost:

```c
/*
 * Doing two full table scans is a brute-force strategy.  We could try to be
 * cleverer, eg storing new tuples in a special area of the table (perhaps
 * making the table append-only by setting use_fsm).  However that would
 * add yet more locking issues.
 */
```

Two scans of a large table is a lot of I/O to spend on correctness. The alternative sketched in [that comment](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/catalog/index.c#L3377-L3380) trades that I/O for more locking, which is the one resource the whole feature exists to conserve.

## The uniqueness edge case

Building a unique index concurrently has a race condition during the first scan.

A table has an existing row `name='Alice'`. A unique index build on `name` starts:

```text
 First scan, indisready=false        Concurrent txn
 ┌──────────────────────────┐        ┌──────────────────────────────┐
 │ scanning...              │        │                              │
 │ "Alice" not reached yet  │        │ INSERT name='Alice'          │
 │                          │        │ ii_ReadyForInserts is false  │
 │                          │        │ so no uniqueness check runs  │
 │ ...reaches the original  │        │ and the INSERT commits       │
 │ "Alice" and indexes it   │        │                              │
 └──────────────────────────┘        └──────────────────────────────┘
              │                                    │
              ▼                                    ▼
       in the index                        in the table only

 Two live 'Alice' rows now, and the index knows about one of them
```

The second scan is what discovers this. It finds the concurrent transaction's `Alice` missing from the index, tries to insert it, and the B-tree hits the original `Alice` already sitting there.

Raising a uniqueness violation on the spot would be wrong, though, because the tuple it collided with might be a dead version of a row that some concurrent `UPDATE` already replaced:

```c
/*
 * Building a unique index this way is tricky: we might try to insert a
 * tuple that is already dead or is in process of being deleted, and we
 * mustn't have a uniqueness failure against an updated version of the same
 * row.  ...we expect the index AM to recheck liveness of the to-be-inserted
 * tuple before it declares a uniqueness error.
 */
```

So the B-tree rechecks whether the tuple it collided with is still live before it declares anything. That's what keeps a concurrent `UPDATE` from failing the build, since the old and new versions of one row are two tuples with the same key and only one of them is alive.

When both rows really are live duplicates, the build fails and leaves the invalid index behind for you to clean up:

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

All of that machinery buys one thing, which is a weaker lock. `ShareUpdateExclusiveLock` is held for the whole build and conflicts only with DDL and other concurrent index builds on the same table.

| Lock mode | Blocks reads | Blocks writes | Blocks DDL |
|---|---|---|---|
| `SHARE`, from plain `CREATE INDEX` | No | Yes | Yes |
| `ShareUpdateExclusive`, from `CONCURRENTLY` | No | No | Yes |

What it costs is two full table scans instead of one, three waits that a single long transaction can stall indefinitely, and a build that can fail partway and leave an invalid index for you to drop. On a large table that's a much better deal than an hour of rejected writes, which is why the ceremony exists.
