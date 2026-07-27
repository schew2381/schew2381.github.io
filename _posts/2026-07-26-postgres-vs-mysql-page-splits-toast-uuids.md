---
title: "Postgres vs MySQL, Part 4: Page Splits, TOAST, and UUIDs"
date: 2026-07-26 09:45:00 -0700
categories: [databases, internals]
tags: [postgres, mysql, innodb, toast, uuid]
---

> Part 4 of a five-part series:
> 1. [Clustered index vs heap](/posts/postgres-vs-mysql-storage-clustered-vs-heap/)
> 2. [MVCC: vacuum vs the undo log](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/)
> 3. [HOT updates](/posts/postgres-vs-mysql-hot-updates/)
> 4. Page splits, TOAST, and UUIDs (this post)
> 5. [Connections: processes vs threads](/posts/postgres-vs-mysql-connection-models/)
{: .prompt-info }

Both engines store data in fixed-size pages: Postgres uses 8 KB blocks, InnoDB uses [16 KB](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/univ.i#L325) pages. Three questions fall out of that fixed size, and the answers separate the clustered index from the heap again.

## Giant rows: TOAST and off-page storage

A single value can be larger than a page, a big JSON document or a long `TEXT` column. Neither engine can wedge a 100 KB value into an 8 or 16 KB page, so both move it out of line and leave a pointer behind.

Postgres calls this TOAST, The Oversized-Attribute Storage Technique. When a heap tuple would exceed roughly 2 KB (the [`TOAST_TUPLE_THRESHOLD`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/heaptoast.h#L48), a quarter of an 8 KB page), Postgres first tries to compress the large columns. If the tuple is still over the limit, it moves the oversized columns out to a hidden TOAST table, one per main table, and leaves a small pointer in the heap.

The TOAST table is an ordinary heap under the hood. It chops the big value into chunks that each fit a page and stores them as its own rows, keyed by an OID the main-table pointer references. This keeps the main heap slim, so a scan that doesn't `SELECT` the big column never reads the chunks. See [`toast_internals.c`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/common/toast_internals.c).

```text
main heap tuple                    TOAST table (hidden heap)
┌────────────────────────┐         ┌──────────────────────┐
│ id=1  status=active     │         │ oid=5001 chunk 0      │
│ payload ─▶ TOAST oid 5001│───────▶│ oid=5001 chunk 1      │
└────────────────────────┘         │ oid=5001 chunk 2      │
                                    └──────────────────────┘
```

InnoDB does nearly the same thing under a different name: off-page storage. When a row won't fit a 16 KB page, InnoDB moves large `BLOB`/`TEXT` columns to separate overflow pages and stores a [20-byte pointer](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/page0size.h#L39) in the clustered-index leaf. The exact behavior depends on the row format (`DYNAMIC` stores just the pointer in the leaf; older `COMPACT` kept a 768-byte prefix inline), but the goal is identical: keep the clustered index compact so it stays fast to traverse.

TOAST interacts nicely with the MVCC model from [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/). Update a small column and Postgres writes a new main-table tuple that simply copies the TOAST pointer, so the multi-megabyte value isn't rewritten. Update the big column and it writes new chunks, leaving the old chunks for older transactions until `VACUUM` reclaims them.

## Growth: page splits vs the free space map

The harder difference shows up as tables grow, because InnoDB has to keep the clustered index in primary key order and Postgres doesn't have to keep anything in order.

InnoDB's rows must stay sorted by primary key. Suppose a full 16 KB leaf page holds ids 10 through 20 and you insert id 15. It belongs on that page, but there's no room. InnoDB performs a [page split](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/btr/btr0btr.cc#L2305):

```text
insert id=15 into a full page [10..20]

1. allocate a new 16 KB page
2. move about half the rows onto it
3. update parent B+Tree nodes to point at both pages
4. insert id=15 into whichever half it belongs

result: two half-full pages, and the new page may sit
        far from the old one on disk (fragmentation)
```

Splits cost CPU and I/O, and they fragment the file: the new page is allocated wherever there's free space, often far from its logical neighbor. The tree stays logically ordered while the pages scatter physically. Fixing it means rebuilding the table with [`OPTIMIZE TABLE`](https://dev.mysql.com/doc/refman/8.4/en/optimize-table.html), which writes a fresh, densely packed B+Tree and drops the fragmented one.

Postgres has no equivalent for table data. The heap has no required order, so an insert just goes to any page with room (tracked by the free space map) or to the end of the file. There is no table-data page split. Postgres indexes are B-Trees and *do* split like InnoDB's, but the table itself never does.

Postgres pays for the same problem in a different currency. Dead tuples from [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/) leave Swiss-cheese holes after `VACUUM` frees them, and if the holes don't get reused efficiently the heap bloats. The heavy fix is [`VACUUM FULL`](https://www.postgresql.org/docs/current/sql-vacuum.html) or `pg_repack`, which rewrites the heap into a compact new file.

| | PostgreSQL | MySQL (InnoDB) |
|---|---|---|
| Table data order | None (heap) | Sorted by primary key |
| Insert into a full region | Any free page or append | Page split, keep PK order |
| Main degradation mode | Heap bloat from dead tuples | Fragmentation from splits |
| Heavy fix | `VACUUM FULL` / `pg_repack` | `OPTIMIZE TABLE` |

## Why random UUIDs wreck MySQL

This is where clustering bites hardest, and it's a real decision people get wrong. A random UUID (v4) as a primary key is fine in Postgres and pathological in MySQL.

Recall from [Part 1](/posts/postgres-vs-mysql-storage-clustered-vs-heap/) that in InnoDB the primary key *is* the table, and it stays in key order. An auto-incrementing integer inserts in perfect order: every new row appends to the rightmost leaf, the page fills, InnoDB seals it and starts a fresh one. The active tail stays in the buffer pool, and writes are sequential and cheap.

A random UUIDv4 destroys that. Every insert targets a random point in the middle of the tree:

- The target page is almost always already full, forcing a page split on insert after insert.
- Constant mid-page splits leave pages around half full, so the table balloons to roughly double the size.
- The target page is rarely in memory, so InnoDB reads a random 16 KB page from disk, inserts, splits, and flushes, over and over. The buffer pool thrashes and write throughput collapses.

Postgres shrugs at the same key. Table rows go to the heap in append-ish fashion regardless of key value, so the pathology is confined to the (much smaller) index B-Tree, not the full-width table data. The random-insert hit is real but far smaller.

The fix on the MySQL side is [UUIDv7](https://www.rfc-editor.org/rfc/rfc9562#name-uuid-version-7), which replaces the leading bits with a Unix timestamp. Time moves forward, so UUIDv7 values are roughly sequential and append to the right edge of the clustered index like an auto-increment integer, while keeping global uniqueness. If you want UUID primary keys in MySQL, use v7, not v4.

Everything so far has been about a single connection's view of storage. [Part 5](/posts/postgres-vs-mysql-connection-models/) steps back to how the two servers handle many connections at once, one place where the process-versus-thread split is as consequential as clustered-versus-heap.
