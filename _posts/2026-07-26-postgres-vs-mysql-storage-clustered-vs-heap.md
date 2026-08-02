---
title: "(Pt. 1) Postgres vs MySQL: Clustered Index vs Heap"
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

What happens if you run these two queries against Postgres and MySQL, on the same schema with the same rows?

```sql
SELECT * FROM users WHERE email = 'a@a.com';
SELECT * FROM users WHERE id = 1;
```

Neither engine wins both. MySQL does twice the work of Postgres on the first one and half the work on the second.

The answer comes down to where each engine physically puts the row. MySQL keeps it inside the primary key index, and Postgres keeps it in an unordered pile with the indexes pointing at it from outside.

So let's walk both engines through the table below, storing these two rows and then answering those two queries against them.

```sql
CREATE TABLE users (
    id    INT PRIMARY KEY,
    name  VARCHAR(50),
    email VARCHAR(100) UNIQUE
);

INSERT INTO users VALUES
    (1, 'Alice', 'a@a.com'),
    (2, 'Bob',   'b@b.com');
```

## MySQL: the index is the table

InnoDB keys one B+Tree on the primary key and puts the rows themselves in its leaves, an arrangement called a [clustered index](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/dict0mem.h#L95). The index and the table are the same tree, so the upper nodes have nothing to do but route you downward. A lookup on `id=1` descends to a leaf and finds the row sitting there waiting, with no second hop to pay for.

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

Now add the `email` index. It can't also store the row, because that would mean a second full copy of the table and a third for the next index after that. So it stores the primary key instead: each email maps to an `id`, and you take that `id` back to the clustered index to fetch the row.

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

Looking up by `email` therefore walks two trees, one to turn the email into an `id` and another to turn the `id` into a row:

```text
SELECT * FROM users WHERE email = 'a@a.com';

  email index                       clustered index
  ┌───────────────────┐             ┌───────────────────┐
  │ a@a.com ──> id=1  │────────────►│ id=1              │
  └───────────────────┘   traverse  │ name=Alice        │
      traversal 1          again    │ email=a@a.com     │
                                    └───────────────────┘
                                       traversal 2
```

The primary key query skips the first tree entirely:

```text
SELECT * FROM users WHERE id = 1;

  clustered index
  ┌───────────────────┐
  │ id=1              │   one traversal, row is already here
  │ name=Alice        │
  │ email=a@a.com     │
  └───────────────────┘
```

So InnoDB answers a primary key lookup in one traversal and an `email` lookup in two, and the second one is what people mean by the double lookup.

Notice that each secondary index stores a primary key value instead of a physical address. So when a row shifts to a different page inside the clustered index, every secondary index still points at it correctly, because `id=1` is `id=1` no matter which page it lives on. That one property is why InnoDB can rewrite rows in place, and it's the seed of everything in [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/).

## PostgreSQL: heap plus pointers

Postgres drops each row into a [heap](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/heap/heapam.c), an unordered pile of pages, wherever there's free space. To find it again, every version gets tagged with a Tuple ID, or [TID](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/storage/itemptr.h#L36), a physical address written as `(block number, offset)`.

Read that as a page and a slot on that page, and the slot is a real thing. Each page opens with an array of pointers into its own body, and the offset picks one out, so rows shuffle around inside a page without their TIDs changing. The slot number is what the TID names.

Every index stores the indexed value plus a TID, the primary key index included. Nothing is clustered, so every index is alike, and every one of them points straight at the heap.

Both indexes therefore hold a TID and neither holds a row, so both queries take the identical two-step route:

```text
SELECT * FROM users WHERE email = 'a@a.com';

  email index                       the heap (unordered pages)
  ┌───────────────────┐             ┌─────────────────────────────┐
  │ a@a.com ──> (0,1) │────────────►│ (0,1) id=1  Alice  a@a.com  │
  └───────────────────┘             │ (0,2) id=2  Bob    b@b.com  │
    index traversal      heap fetch └─────────────────────────────┘
```

```text
SELECT * FROM users WHERE id = 1;

  id index                          the heap (same pages)
  ┌───────────────────┐             ┌─────────────────────────────┐
  │ id=1    ──> (0,1) │────────────►│ (0,1) id=1  Alice  a@a.com  │
  └───────────────────┘             │ (0,2) id=2  Bob    b@b.com  │
    index traversal      heap fetch └─────────────────────────────┘
```

The `email` query is where that pays off, since one traversal plus a heap fetch beats InnoDB's two full traversals. The bill arrives on the primary key query, where Postgres pays the same heap fetch that InnoDB skips by keeping the row in the leaf. No fast path exactly where MySQL has its fastest one. Nothing in the heap is ordered either, so a scan across a range of ids gets no help from physical layout.

## The trade-offs

Neither layout wins outright, so the benchmark from the top of the post can be made to say either thing.

| Operation | MySQL (InnoDB) | PostgreSQL |
|---|---|---|
| Primary key lookup | Faster: row sits in the leaf | Slower: index, then a heap fetch |
| Secondary index lookup | Slower: two traversals (secondary then PK) | Faster: points straight at the heap row |
| Range scan by PK (`id` 10–50) | Fast: rows are physically in PK order | Slower: rows scattered across the heap |
| Update a non-indexed column | Cheaper for indexes: the PK pointer is unchanged | Costlier: a new row version, historically re-pointing every index |

The range-scan row is where clustering pays off most visibly. `WHERE id BETWEEN 10 AND 50` in InnoDB reads a contiguous run of leaf pages, because those forty-one rows are physically adjacent by definition. Postgres scattered them across the heap in insertion order, so the same query hops from page to page collecting them. There's a [`CLUSTER`](https://www.postgresql.org/docs/current/sql-cluster.html) command that reorders a heap by an index, but it's a one-time rewrite that Postgres won't maintain as new rows arrive, so it decays the moment you resume writing.

If you take one thing into the rest of the series, take the last row of that table. Updating a row is cheap for InnoDB's indexes and potentially brutal for Postgres, and the reason isn't the update path at all. The two engines implement multi-version concurrency in opposite directions, and that's [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/).
