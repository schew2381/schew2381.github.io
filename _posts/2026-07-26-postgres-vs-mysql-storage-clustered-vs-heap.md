---
title: "Postgres vs MySQL, Part 1: Clustered Index vs Heap"
date: 2026-07-26 09:00:00 -0700
categories: [databases, internals]
tags: [postgres, mysql, innodb, index, storage]
---

> A five-part series on how PostgreSQL and MySQL (InnoDB) differ under the hood:
> 1. Clustered index vs heap (this post)
> 2. [MVCC: vacuum vs the undo log](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/)
> 3. [HOT updates](/posts/postgres-vs-mysql-hot-updates/)
> 4. [Page splits, TOAST, and UUIDs](/posts/postgres-vs-mysql-page-splits-toast-uuids/)
> 5. [Connections: processes vs threads](/posts/postgres-vs-mysql-connection-models/)
{: .prompt-info }

Almost every difference between MySQL and PostgreSQL storage traces back to one decision: where the row data physically lives.

MySQL's InnoDB engine stores the table *inside* the primary key index. The index and the table are the same B+Tree, and the row data sits in its leaf nodes. This is a [clustered index](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/dict0mem.h#L95).

PostgreSQL stores rows in a [heap](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/heapam.c), an unordered pile of pages, and keeps every index in a separate structure that points back into that pile. The primary key gets no special storage treatment.

That one split decides how fast each kind of read is, what an update costs, and how the two engines age. Start with a table.

```sql
CREATE TABLE users (
    id    INT PRIMARY KEY,
    name  VARCHAR(50),
    email VARCHAR(100) UNIQUE
);
```

Insert two rows: Alice (`id=1`, `email=a@a.com`) and Bob (`id=2`, `email=b@b.com`).

## MySQL: the index is the table

InnoDB builds a B+Tree keyed on the primary key. Upper nodes only route the search; the leaf nodes at the bottom hold the full row. Look up `id=1` and the row is right there when the search lands, with no second hop.

```text
InnoDB clustered index (keyed on id)

           ┌───────────────┐
           │  root: [1 | 2] │
           └───────┬───────┘
        ┌──────────┴──────────┐
        ▼                     ▼
┌──────────────────┐  ┌──────────────────┐
│ leaf: id=1        │  │ leaf: id=2        │
│ name=Alice        │  │ name=Bob          │
│ email=a@a.com     │  │ email=b@b.com     │
└──────────────────┘  └──────────────────┘
      the row lives in the leaf
```

The row already occupies the leaf, so a secondary index can't also store a full copy without duplicating the whole table. Instead, a secondary index leaf holds the indexed value plus the primary key, and that primary key is the pointer back to the row.

Looking up by `email` therefore walks two trees:

```text
► PK lookup:   SELECT * FROM users WHERE id = 1;
  1. descend the clustered index on id
  2. land on the leaf ──> full row is right there
  cost: 1 B+Tree traversal

► email lookup: SELECT * FROM users WHERE email = 'a@a.com';
  1. descend the secondary index on email
  2. land on the leaf ──> returns id = 1
  3. descend the clustered index on id = 1
  4. land on the leaf ──> full row
  cost: 2 B+Tree traversals (the "double lookup")
```

Because the pointer is the primary key value rather than a physical address, InnoDB never has to fix up secondary indexes when a row moves inside the clustered index. That property matters in [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/).

## PostgreSQL: heap plus pointers

Postgres drops each row wherever there's free space in the heap, with no sort order. To find a row again, it tags every version with a Tuple ID, or [TID](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/storage/itemptr.h#L36), a physical address of the form `(block number, offset)`. A TID is a page and a slot on that page.

Every index, the primary key included, stores the indexed value and a TID. There is no clustered index, so in Postgres terms every index is a secondary index that points straight at the heap.

```text
The heap (unordered data pages)

[block 0, offset 1] ──> (id=1, name=Alice, email=a@a.com)
[block 0, offset 2] ──> (id=2, name=Bob,   email=b@b.com)

► PK lookup:    SELECT * FROM users WHERE id = 1;
  1. descend the id index
  2. leaf ──> TID (0, 1)
  3. fetch the row from the heap at (0, 1)
  cost: 1 index traversal + 1 heap fetch

► email lookup: SELECT * FROM users WHERE email = 'a@a.com';
  1. descend the email index
  2. leaf ──> TID (0, 1)
  3. fetch the row from the heap at (0, 1)
  cost: 1 index traversal + 1 heap fetch
```

Both reads have the same shape, because both indexes point at the same physical row. A Postgres secondary index reaches the row in one traversal plus a heap fetch, where InnoDB's needs two full traversals.

The catch runs the other way. A Postgres primary key lookup still pays the heap fetch that InnoDB avoids by keeping the row in the leaf, and the heap's lack of order makes range scans expensive, covered below.

## The trade-offs

Neither layout wins outright. They optimize for different reads.

| Operation | MySQL (InnoDB) | PostgreSQL |
|---|---|---|
| Primary key lookup | Faster: row sits in the leaf | Slower: index, then a heap fetch |
| Secondary index lookup | Slower: two traversals (secondary then PK) | Faster: points straight at the heap row |
| Range scan by PK (`id` 10–50) | Fast: rows are physically in PK order | Slower: rows scattered across the heap |
| Update a non-indexed column | Cheaper for indexes: the PK pointer is unchanged | Costlier: a new row version, historically re-pointing every index |

The range-scan row is the clearest consequence of clustering. InnoDB keeps rows in primary key order, so `WHERE id BETWEEN 10 AND 50` reads a contiguous run of leaf pages. Postgres scattered those fifty rows across the heap as they were inserted, so the same scan hops between pages. Postgres offers a one-time [`CLUSTER`](https://www.postgresql.org/docs/current/sql-cluster.html) command to reorder a heap by an index, but it doesn't hold that order as new rows arrive.

The last row is the thread into the rest of the series. Updating a row is cheap for InnoDB's indexes and potentially expensive for Postgres, and the reason is that the two engines implement multi-version concurrency in opposite directions. That is [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/).
