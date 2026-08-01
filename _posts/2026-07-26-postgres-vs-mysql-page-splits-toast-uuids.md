---
title: "(Pt. 4) Postgres vs MySQL: Page Splits, TOAST, and UUIDs"
date: 2026-07-26 09:45:00 -0700
categories: [databases, internals]
tags: [postgres, mysql, innodb, toast, uuid]
---

> Part 4 of a five-part series:
> 1. [Clustered index vs heap](/posts/postgres-vs-mysql-storage-clustered-vs-heap/)
> 2. [MVCC + vacuum vs undo log](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/)
> 3. [HOT updates](/posts/postgres-vs-mysql-hot-updates/)
> 4. Page splits, TOAST, and UUIDs (this post)
> 5. [Connections: processes vs threads](/posts/postgres-vs-mysql-connection-models/)
{: .prompt-info }

A UUID primary key is an easy thing to want. Clients generate IDs without a round trip, there's no sequence to coordinate across shards, and your URLs stop advertising how many rows you have. So you write `id UUID PRIMARY KEY` and move on with your day.

On Postgres that decision costs you a little, and on MySQL it can roughly double the table on disk and take your insert throughput with it. None of which is really about UUIDs, it's about what InnoDB is forced to do when a row belongs on a page that's already full.

Both engines store data in fixed-size pages, 8 KB blocks for Postgres and [16 KB](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/univ.i#L325) pages for InnoDB, so "doesn't fit" comes in two sizes: a single value bigger than any page, and an ordinary value landing on a page with no room.

## Giant rows: TOAST and off-page storage

The easy version of not fitting is a single value larger than any page. A 100 KB JSON document can't be wedged into 8 or 16 KB, so both engines move it out of line and leave a pointer behind.

Postgres calls this TOAST, The Oversized-Attribute Storage Technique, and the threshold is lower than most people expect. It kicks in when a tuple would exceed roughly 2 KB, not 8 KB, because [`TOAST_TUPLE_THRESHOLD`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/heaptoast.h#L48) is a quarter of a page. Postgres wants four tuples per page minimum, so a 3 KB row gets TOASTed even though it would fit fine on its own.

Compression comes first, though, which is the half people forget:

```text
step 1: compress in place

  ┌──────────────────────────────────┐
  │ id=1  status=active              │
  │ payload = 3 KB of JSON           │  tuple is over ~2 KB
  └──────────────────────────────────┘
                 │  compress payload
                 ▼
  ┌──────────────────────────────────┐
  │ payload = 1.4 KB compressed      │  under the limit, done,
  └──────────────────────────────────┘  no TOAST table involved
```

Only if it's still over the limit does the column leave the heap:

```text
step 2: move out of line

  main heap tuple                     TOAST table (hidden heap)
  ┌──────────────────────────┐        ┌───────────────────────┐
  │ id=1   status=active     │        │ oid=5001  chunk 0     │
  │ payload ──> TOAST 5001 ──┼───────►│ oid=5001  chunk 1     │
  └──────────────────────────┘        │ oid=5001  chunk 2     │
                                      └───────────────────────┘
```

That TOAST table is an ordinary heap, which is the part worth holding on to. It chops the big value into page-sized chunks stored as its own rows keyed by an OID, so a scan that doesn't `SELECT` the big column never touches them. Being an ordinary heap also means it has its own dead tuples and needs its own vacuuming, which is how a table with a 4 KB `jsonb` column ends up with twice the bloat you were accounting for. See [`toast_internals.c`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/common/toast_internals.c).

InnoDB does nearly the same thing under a different name, off-page storage. Large `BLOB` and `TEXT` columns move to overflow pages and the clustered-index leaf keeps a [20-byte pointer](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/page0size.h#L39). Row format decides how much stays inline, where `DYNAMIC` keeps only the pointer and the older `COMPACT` kept a 768-byte prefix, but the motive matches Postgres's: leaf pages are what every lookup traverses, so they need to stay small.

Postgres gets a bonus out of [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/)'s copy-on-write MVCC. Updating a small column writes a new main-table tuple that copies the TOAST pointer, so a multi-megabyte value doesn't get rewritten because you touched a boolean next to it. Update the big column and you get new chunks, with the old ones sticking around for older transactions until `VACUUM` gets them.

So oversized values get handled about equivalently on both engines, which makes them the boring case.

## Growth: page splits vs the free space map

The interesting version is an ordinary value landing on a page that's full. InnoDB's requirement to keep the clustered index in primary key order starts costing real money here, and Postgres's refusal to keep anything in order stops looking lazy.

A full 16 KB leaf page holds ids 10 through 20 and you insert id 15. It belongs on that page, there's no room, and unlike Postgres, InnoDB can't put it elsewhere, because order is the whole contract. So it performs a [page split](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/btr/btr0btr.cc#L2305), allocating a page, moving records across, and updating the parent nodes to point at both halves.

### Where InnoDB splits, and why it matters

Which record it splits at is the part nobody talks about, and it decides whether your table ends up dense or half empty. InnoDB tries three things in order:

1. Insert into the right sibling page instead, if the record fits there. No split at all. See [`btr_insert_into_right_sibling`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/btr/btr0btr.cc#L2192).
2. If this insert lands right after the previous one on the same page, treat it as a sequential pattern and split at the new record, leaving the old page nearly full. That's [`btr_page_get_split_rec_to_right`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/btr/btr0btr.cc#L1703), and the comment in it calls the heuristic "eager."
3. Otherwise give up on guessing and split down the middle, at [`page_get_middle_rec`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/btr/btr0btr.cc#L2415), producing two pages about half full each.

Attempt 1 is the cheapest outcome available, since a record that sorts past everything on the full page can just go next door:

```text
attempt 1: no split at all

  ┌──────────────────────┐   ┌──────────────────────┐
  │ page A: 10..20  full │   │ page B: 30..34  room │
  └──────────────────────┘   └──────────┬───────────┘
                                        │ 21 sorts into B
                                        ▼ and B has space
                             ┌──────────────────────┐
                             │ page B: 21, 30..34   │
                             └──────────────────────┘
```

Attempt 2 is doing an enormous amount of unadvertised work for you. Append rows in key order and InnoDB spots it from `PAGE_LAST_INSERT`, splits at the tail, and seals pages nearly 100% full. Insert in random key order and the heuristic never fires, every split takes attempt 3, and the steady state is a table of half-full pages:

```text
attempt 2: sequential                attempt 3: random
insert 21 into full [10..20]         insert 15 into full [10..20]

┌──────────────────────┐            ┌──────────────────────┐
│ page A: 10..20       │  ~100%     │ page A: 10..14       │  ~50%
└──────────────────────┘            └──────────────────────┘
┌──────────────────────┐            ┌──────────────────────┐
│ page B: 21           │  new       │ page B: 15..20       │  ~50%
└──────────────────────┘            └──────────────────────┘

page A stays sealed and full        every future insert near
                                    10..20 splits again
```

Same table, same rows, roughly double the disk, decided entirely by the order the keys showed up in.

Splits cost more than space, since each one is CPU plus I/O plus a parent-node update, and the new page is allocated wherever the tablespace has room, often nowhere near its logical neighbor. The tree stays perfectly ordered while the pages scatter physically underneath it, so a range scan reading "sequential" leaf pages can be doing random I/O. Fixing that means rebuilding with [`OPTIMIZE TABLE`](https://dev.mysql.com/doc/refman/8.4/en/optimize-table.html), which writes a fresh densely packed B+Tree and drops the old one.

### Postgres has no table-data splits at all

The heap has no required order, so an insert goes to any page with room, found via the free space map, or to the end of the file. No table-data page splits exist, which makes insert order genuinely irrelevant to how densely a Postgres table packs. Postgres B-Tree indexes do split much like InnoDB's, but an index entry is a key and a TID rather than an entire row, so the same split moves far fewer bytes.

Postgres pays for the same problem in a different currency, which is the honest version of the comparison. Dead tuples from [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/) leave Swiss-cheese holes once `VACUUM` frees them, and a heap that doesn't refill its holes efficiently bloats just as badly as a fragmented B+Tree. The heavy fix is [`VACUUM FULL`](https://www.postgresql.org/docs/current/sql-vacuum.html) or `pg_repack`, rewriting the heap into a compact new file. Both engines degrade with churn, for different reasons, rebuilt by different commands.

| | PostgreSQL | MySQL (InnoDB) |
|---|---|---|
| Table data order | None (heap) | Sorted by primary key |
| Insert into a full region | Any free page or append | Page split, keep PK order |
| Cost of insert order | Doesn't matter | Decides dense vs half-full pages |
| Main degradation mode | Heap bloat from dead tuples | Fragmentation from splits |
| Heavy fix | `VACUUM FULL` / `pg_repack` | `OPTIMIZE TABLE` |

That third row ruins someone's quarter and looks like nothing on a comparison table. Insert order is invisible in your schema, absent from your query plans, and for Postgres genuinely irrelevant. For InnoDB it's the difference between a table that packs itself and a table that doubles.

## Back to that UUID

In InnoDB the primary key *is* the table ([Part 1](/posts/postgres-vs-mysql-storage-clustered-vs-heap/)), so the order keys arrive in is the order the table gets built. An auto-increment integer arrives in perfect order and lands on the happy path from the last section, pages sealed nearly full with the active tail in the buffer pool.

UUIDv4 is 122 bits of randomness, so every insert targets a random leaf and the eager heuristic never fires, because the last insert on that page happened thousands of rows ago. Three things go wrong at once:

- The target page is usually already full, so mid-tree splits happen insert after insert.
- Every split takes the 50/50 path, so the steady state is half-full pages and a table roughly double the size it needs to be.
- The target page is usually not in memory. InnoDB reads a random 16 KB page from disk, inserts, splits, flushes, and repeats.

The third one is what takes the system down, since the first two are a space problem you can throw disk at while a buffer pool asked to cache a working set spread uniformly across the entire table has nothing left to give. Follow one row in:

```text
one UUIDv4 insert, start to finish

  1. random key       ──> a leaf nobody has touched in hours
  2. buffer pool miss ──> read 16 KB from disk
  3. page is full     ──> 50/50 split, allocate a page
  4. parent node      ──> rewrite to point at both halves
  5. flush            ──> two dirty pages out
  6. evict            ──> throw away something useful for step 2
     ──> repeat, per row inserted
```

Postgres mostly shrugs, because rows go into the heap wherever there's room no matter what the key says. The random-insert cost is confined to the index B-Tree, where an entry is a key and a TID rather than a full row, so the bloat is bounded by something much smaller than your table. Real cost, different order of magnitude.

The fix is [UUIDv7](https://www.rfc-editor.org/rfc/rfc9562#name-uuid-version-7), which moves the leading bits from random to sortable and leaves the rest alone:

```text
UUIDv4  ┌──────────────────────────────────────────────────────┐
        │ 122 bits of randomness, all the way down             │
        └──────────────────────────────────────────────────────┘
        ──> every insert targets a different leaf

UUIDv7  ┌──────────────────────┬───────────────────────────────┐
        │ 48-bit ms timestamp  │ 74 random bits                │
        └──────────────────────┴───────────────────────────────┘
        ──> the leading bits only increase, so inserts land at
            the right edge and the eager heuristic fires
```

Time only moves forward, so v7 values sort roughly in generation order and append to the right edge like an integer while staying globally unique with no coordination.

It isn't quite an auto-increment, since concurrent generators inside the same millisecond interleave, so the insert point stays within the rightmost page or two rather than being strictly monotonic, which is enough for the heuristic but not the same thing. And a v7 tells anyone holding it when it was created, which matters if opaque IDs were the point.

If you've already shipped v4, InnoDB will tell you how bad it is before you plan a migration:

```sql
SELECT table_name,
       data_length,
       data_free,
       ROUND(data_free / NULLIF(data_length, 0) * 100, 1) AS pct_free
FROM information_schema.tables
WHERE table_schema = DATABASE()
ORDER BY data_length DESC;
```

`data_free` on a clustered index fed random keys creeps toward a third or more of `data_length`. Run `OPTIMIZE TABLE` on a copy to see how much of that is recoverable versus structural, and keep it off production, since it rebuilds the table and takes a metadata lock at the end.

Everything so far has been one connection's view of storage. [Part 5](/posts/postgres-vs-mysql-connection-models/) is what happens when several thousand clients show up at once, where a second root decision, entirely independent of clustered-versus-heap, explains why the two servers fall over in completely different ways.
