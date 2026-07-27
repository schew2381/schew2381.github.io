---
title: "Postgres vs MySQL, Part 2: MVCC, Vacuum vs the Undo Log"
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

```text
UPDATE users SET name = 'Alice2' WHERE id = 1;

before                          after
┌────────────────────┐         ┌────────────────────┐
│ (0,1) Alice   live  │         │ (0,1) Alice   dead  │  xmax set
└────────────────────┘         ├────────────────────┤
                               │ (0,2) Alice2  live  │  new tuple
                               └────────────────────┘
```

Keeping the old version is what makes concurrent snapshots work. A transaction that started before this update still sees `(0,1)`, while newer transactions see `(0,2)`. Each tuple carries the transaction IDs (`xmin`, `xmax`) that bound its visibility, and every reader checks those against its own snapshot.

The dead tuple can't be removed until no active transaction could still need it. Once that's true, its space is wasted until something reclaims it. That something is `VACUUM`.

[`heap_vacuum_rel`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/vacuumlazy.c#L624) scans the heap, finds tuples that are dead to everyone, and marks their space reusable for future inserts. Skip it and dead tuples pile up as *bloat*: a table that keeps growing on disk even though the live row count is flat. Autovacuum runs this in the background, but it's still real work the storage model forces on you.

## MySQL: update in place, old version to the undo log

InnoDB overwrites the row where it sits in the clustered-index leaf. To preserve the old version for MVCC, it first copies the pre-image into the [undo log](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/trx0undo.h) and links the live row to it.

Every InnoDB row carries two hidden columns that make this work:

- [`DB_TRX_ID`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/data0type.h#L182) (6 bytes), the ID of the transaction that last modified the row.
- [`DB_ROLL_PTR`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/data0type.h#L188) (7 bytes), a pointer to the undo record holding the previous version.

```text
UPDATE users SET name = 'Alice2' WHERE id = 1;

clustered index leaf              undo log
┌──────────────────────────┐     ┌────────────────────┐
│ id=1  name=Alice2  (live) │     │ old: name=Alice     │
│ DB_TRX_ID = 105           │────▶│ (reachable via      │
│ DB_ROLL_PTR ──────────────┼─────│  DB_ROLL_PTR)       │
└──────────────────────────┘     └────────────────────┘
```

The live row moved to the new value in place, so no index entry has to change. An older transaction that shouldn't see `Alice2` reconstructs the version it *should* see by walking the undo chain backward, applying each undo record in reverse until the row matches its snapshot:

```text
reader with snapshot < 105
  1. read the clustered-index row: DB_TRX_ID = 105
  2. 105 is newer than my snapshot, I can't see this version
  3. follow DB_ROLL_PTR into the undo log
  4. apply the undo record in reverse ──> name = Alice
  5. that version is visible ──> return it
```

InnoDB's read-view logic lives in [`read0read.cc`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/read/read0read.cc). Because the live row stays put, the main table never accumulates dead versions the way a Postgres heap does.

The undo records still have to be cleaned up, but that happens off the main table. A background [purge thread](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/trx/trx0purge.cc#L2396) discards undo records once no active transaction needs them. There's no user-facing `VACUUM`, and the table itself doesn't bloat with dead rows.

## Why the difference exists

It comes straight back to where old versions go.

| | PostgreSQL | MySQL (InnoDB) |
|---|---|---|
| On update | New tuple in the heap, old one marked dead | Row rewritten in place |
| Old versions live | In the main heap, beside live rows | In the undo log, off the table |
| Reading an old version | Read a different tuple directly | Walk the undo chain and reverse changes |
| Cleanup | `VACUUM` reclaims dead tuples | Purge thread trims undo records |
| Main-table bloat | Yes, without vacuuming | No |

Neither is free. Postgres pays with `VACUUM` and bloat management, and gets fast access to any recent version since it's just another tuple. InnoDB pays with undo-chain walks for long-running readers, and gets a compact, always-in-order main table.

Postgres's approach has an obvious sharp edge. An update writes a whole new tuple and, in Part 1's model, that new tuple sits at a new TID, so every index on the table has to be updated to point at it, even indexes on columns that didn't change. That penalty would make updating a single unindexed column absurdly expensive. [Part 3](/posts/postgres-vs-mysql-hot-updates/) is about the mechanism that avoids it: HOT.
