---
title: "(Pt. 1 Postgres vs MySQL) Clustered Index vs Heap"
date: 2026-07-26 09:00:00 -0700
categories: [databases, internals]
tags: [postgres, mysql, innodb, index, storage]
---

> A five-part series on how PostgreSQL and MySQL (InnoDB) differ under the hood:
> 1. Clustered index vs heap (this post)
> 2. [MVCC + vacuum vs undo log](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/)
> 3. [HOT updates](/posts/postgres-vs-mysql-hot-updates/)
> 4. [Page splits, TOAST, and UUIDs](/posts/postgres-vs-mysql-page-splits-toast-uuids/)
> 5. [Connections: processes vs threads](/posts/postgres-vs-mysql-connection-models/)
{: .prompt-info }

Give MySQL and Postgres identical schemas and identical rows, then run `SELECT * FROM users WHERE email = 'a@a.com'`. MySQL walks two B+Trees to answer it. Postgres walks one index and makes a single trip to the table.

Switch to `WHERE id = 1` and the result inverts. MySQL reads the row straight out of the index leaf, and now Postgres is the one taking two steps.

Whichever engine you've been told is faster, somebody benchmarked one of those two queries and not the other. Both results fall out of a single decision about where row data physically lives.

MySQL's InnoDB engine stores the table *inside* the primary key index. The index and the table are the same B+Tree, and the row data sits in its leaf nodes. That's a [clustered index](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/dict0mem.h#L95).

Postgres stores rows in a [heap](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/heapam.c), an unordered pile of pages, and keeps every index in a separate structure that points back into that pile. The primary key gets no special treatment at all.

One split, and it decides how fast each kind of read is, what an update costs, and how the two engines age over months in production. Here's a table small enough to trace by hand.

```sql
CREATE TABLE users (
    id    INT PRIMARY KEY,
    name  VARCHAR(50),
    email VARCHAR(100) UNIQUE
);
```

Insert two rows: Alice (`id=1`, `email=a@a.com`) and Bob (`id=2`, `email=b@b.com`).

## MySQL: the index is the table

InnoDB builds a B+Tree keyed on the primary key. Upper nodes only route the search, and the leaf nodes at the bottom hold the full row. Look up `id=1` and the row is right there when the search lands, with no second hop.

```text
InnoDB clustered index (keyed on id)

           ┌─────────────────┐
           │ root: [1 | 2]   │
           └────────┬────────┘
         ┌──────────┴──────────┐
         ▼                     ▼
┌─────────────────┐   ┌─────────────────┐
│ leaf: id=1      │   │ leaf: id=2      │
│ name=Alice      │   │ name=Bob        │
│ email=a@a.com   │   │ email=b@b.com   │
└─────────────────┘   └─────────────────┘
        the row lives in the leaf
```

Now add the `email` index. It can't also store the row, because that would mean carrying a second full copy of the table, and a third for the next index after that. So it stores the primary key instead: each email maps to an `id`, and you take that `id` back to the clustered index to fetch the row.

```text
InnoDB secondary index (keyed on email)

          ┌───────────────────────┐
          │ root: [a@a.com | ...] │
          └───────────┬───────────┘
          ┌───────────┴───────────┐
          ▼                       ▼
┌───────────────────┐   ┌───────────────────┐
│ email=a@a.com     │   │ email=b@b.com     │
│ id=1              │   │ id=2              │
└───────────────────┘   └───────────────────┘
     no row data, just the PK to look up next
```

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

Notice what the secondary index stores: a primary key value, not a physical address. So when a row shifts to a different page inside the clustered index, every secondary index still points at it correctly, because `id=1` is `id=1` no matter which page it lives on. Nothing needs fixing up. That single property is why InnoDB can rewrite rows in place, and it's the seed of everything in [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/).

## PostgreSQL: heap plus pointers

Postgres drops each row wherever there's free space, in no particular order. To find it again, every version gets tagged with a Tuple ID, or [TID](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/storage/itemptr.h#L36), which is a physical address written as `(block number, offset)`. Read that as a page and a slot on that page.

Every index stores the indexed value plus a TID, and that includes the primary key index. Nothing is clustered, so in Postgres terms every index is a secondary index and every one of them points straight at the heap.

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

Both reads have the same shape, because both indexes point at the same physical row. That's the email query from the top of the post: one traversal and a heap fetch, against InnoDB's two full traversals.

The bill arrives on the other query. A primary key lookup pays that same heap fetch, the one InnoDB skips entirely by keeping the row in the leaf, so Postgres has no fast path where MySQL has its fastest one. And because nothing in the heap is ordered, a scan across a range of ids gets no help from physical layout either.

## The trade-offs

Neither layout wins outright, which is the whole reason the benchmark from the top of the post can be made to say either thing.

| Operation | MySQL (InnoDB) | PostgreSQL |
|---|---|---|
| Primary key lookup | Faster: row sits in the leaf | Slower: index, then a heap fetch |
| Secondary index lookup | Slower: two traversals (secondary then PK) | Faster: points straight at the heap row |
| Range scan by PK (`id` 10–50) | Fast: rows are physically in PK order | Slower: rows scattered across the heap |
| Update a non-indexed column | Cheaper for indexes: the PK pointer is unchanged | Costlier: a new row version, historically re-pointing every index |

The range-scan row is where clustering pays off most visibly. `WHERE id BETWEEN 10 AND 50` in InnoDB reads a contiguous run of leaf pages, because those forty-one rows are physically adjacent by definition. Postgres scattered them across the heap in insertion order, so the same query hops from page to page collecting them. There's a [`CLUSTER`](https://www.postgresql.org/docs/current/sql-cluster.html) command that reorders a heap by an index, but it's a one-time rewrite and Postgres won't maintain that order as new rows arrive, so it decays the moment you resume writing.

If you take one thing into the rest of the series, take the last row of that table. Updating a row is cheap for InnoDB's indexes and potentially brutal for Postgres, and the reason isn't the update path at all. It's that the two engines implement multi-version concurrency in opposite directions, which is [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/).
