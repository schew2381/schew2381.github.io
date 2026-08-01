---
title: "(Pt. 4 Postgres vs MySQL) Page Splits, TOAST, and UUIDs"
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

On Postgres that decision costs you a little. On MySQL it can roughly double the table on disk and take your insert throughput with it, and none of that is really about UUIDs. It's about what InnoDB is forced to do when a row belongs on a page that's already full.

Both engines store data in fixed-size pages, 8 KB blocks for Postgres and [16 KB](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/univ.i#L325) pages for InnoDB. Two mechanisms have to come first, and both answer the same question in different sizes: what happens when something doesn't fit.

## Giant rows: TOAST and off-page storage

Start with the easy version of not fitting, where a single value is larger than any page. A 100 KB JSON document can't be wedged into 8 or 16 KB, so both engines move it out of line and leave a pointer behind.

Postgres calls this TOAST, The Oversized-Attribute Storage Technique, and the threshold is lower than most people expect. It kicks in when a tuple would exceed roughly 2 KB, not 8 KB, because [`TOAST_TUPLE_THRESHOLD`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/include/access/heaptoast.h#L48) is defined as a quarter of a page. Postgres wants four tuples per page minimum, so a 3 KB row gets TOASTed even though it would fit fine on its own.

Compression comes first, and only if the tuple is still over the limit do the oversized columns move out to a hidden TOAST table, one per main table, leaving a small pointer behind in the heap.

That TOAST table is an ordinary heap, which is the part worth holding on to. It chops the big value into page-sized chunks and stores them as its own rows keyed by an OID, so a scan that doesn't `SELECT` the big column never touches them. Being an ordinary heap also means it has its own dead tuples and needs its own vacuuming, which is how a table with a 4 KB `jsonb` column ends up with twice the bloat you were accounting for. See [`toast_internals.c`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/access/common/toast_internals.c).

```text
main heap tuple                     TOAST table (hidden heap)
┌──────────────────────────┐        ┌───────────────────────┐
│ id=1   status=active     │        │ oid=5001  chunk 0     │
│ payload ──> TOAST 5001 ──┼───────►│ oid=5001  chunk 1     │
└──────────────────────────┘        │ oid=5001  chunk 2     │
                                    └───────────────────────┘
```

InnoDB does nearly the same thing under a different name, off-page storage. Large `BLOB` and `TEXT` columns move to overflow pages and the clustered-index leaf keeps a [20-byte pointer](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/include/page0size.h#L39). Row format decides how much stays inline, where `DYNAMIC` keeps only the pointer and the older `COMPACT` kept a 768-byte prefix, but the motive is the same as Postgres's: the leaf pages are the thing every lookup traverses, so they need to stay small.

For Postgres there's a bonus that falls out of [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/)'s copy-on-write MVCC. Updating a small column writes a new main-table tuple that just copies the TOAST pointer, so a multi-megabyte value doesn't get rewritten because you touched a boolean next to it. Update the big column and you get new chunks, with the old ones sticking around for older transactions until `VACUUM` gets them.

So oversized values are handled and roughly equivalent on both engines. Which is the boring case.

## Growth: page splits vs the free space map

Now the interesting version of not fitting, where the value is ordinary and the page it belongs on is full. This is where InnoDB's requirement to keep the clustered index in primary key order starts costing real money, and where Postgres's refusal to keep anything in order stops looking lazy.

A full 16 KB leaf page holds ids 10 through 20 and you insert id 15. It belongs on that page and there's no room, and unlike Postgres, InnoDB can't just put it elsewhere. Order is the whole contract. So it performs a [page split](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/btr/btr0btr.cc#L2305), allocating a page, moving records across, and updating the parent nodes to point at both halves.

### Where InnoDB splits, and why it matters

Which record it splits at is the part nobody talks about, and it's what decides whether your table ends up dense or half empty. InnoDB tries three things in order:

1. Insert into the right sibling page instead, if the record fits there. No split at all. See [`btr_insert_into_right_sibling`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/btr/btr0btr.cc#L2192).
2. If this insert lands right after the previous one on the same page, treat it as a sequential pattern and split at the new record, leaving the old page nearly full. That's [`btr_page_get_split_rec_to_right`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/btr/btr0btr.cc#L1703), and the comment in it calls the heuristic "eager."
3. Otherwise give up on guessing and split down the middle, at [`page_get_middle_rec`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/storage/innobase/btr/btr0btr.cc#L2415), producing two pages about half full each.

Step 2 is doing an enormous amount of unadvertised work for you. Append rows in key order and InnoDB spots it from `PAGE_LAST_INSERT`, splits at the tail, and seals pages nearly 100% full. Insert in random key order and the heuristic never fires, every split takes step 3, and the steady state is a table of half-full pages.

```text
sequential keys (step 2)          random keys (step 3)
insert 21 into full [10..20]      insert 15 into full [10..20]

┌──────────────────────┐          ┌──────────────────────┐
│ page A: 10..20       │  ~100%   │ page A: 10..14       │  ~50%
└──────────────────────┘          └──────────────────────┘
┌──────────────────────┐          ┌──────────────────────┐
│ page B: 21           │  new     │ page B: 15..20       │  ~50%
└──────────────────────┘          └──────────────────────┘

page A stays sealed and full      every future insert near
                                  10..20 splits again
```

Same table, same rows, roughly double the disk, decided entirely by the order the keys showed up in.

Splits cost more than space. Each one is CPU plus I/O plus a parent-node update, and the new page is allocated wherever the tablespace has room, which is often nowhere near its logical neighbor. The tree stays perfectly ordered while the pages scatter physically underneath it, so a range scan that reads "sequential" leaf pages can be doing random I/O. Fixing that means rebuilding with [`OPTIMIZE TABLE`](https://dev.mysql.com/doc/refman/8.4/en/optimize-table.html), which writes a fresh densely packed B+Tree and drops the old one.

### Postgres has no table-data splits at all

The heap has no required order, so an insert goes to any page with room, found via the free space map, or to the end of the file. There's no such thing as a table-data page split, which means insert order is genuinely irrelevant to how densely a Postgres table packs. Postgres B-Tree indexes do split much like InnoDB's, but an index entry is a key and a TID rather than an entire row, so the same split moves far fewer bytes.

Postgres pays for the same problem in a different currency, which is the honest version of the comparison. Dead tuples from [Part 2](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/) leave Swiss-cheese holes once `VACUUM` frees them, and a heap that doesn't refill its holes efficiently bloats just as badly as a fragmented B+Tree. The heavy fix is [`VACUUM FULL`](https://www.postgresql.org/docs/current/sql-vacuum.html) or `pg_repack`, rewriting the heap into a compact new file. Both engines degrade with churn. They just degrade for different reasons and get rebuilt by different commands.

| | PostgreSQL | MySQL (InnoDB) |
|---|---|---|
| Table data order | None (heap) | Sorted by primary key |
| Insert into a full region | Any free page or append | Page split, keep PK order |
| Cost of insert order | Doesn't matter | Decides dense vs half-full pages |
| Main degradation mode | Heap bloat from dead tuples | Fragmentation from splits |
| Heavy fix | `VACUUM FULL` / `pg_repack` | `OPTIMIZE TABLE` |

That third row is the one that ruins someone's quarter, and it looks like nothing on a comparison table. Insert order is invisible in your schema, absent from your query plans, and for Postgres genuinely irrelevant. For InnoDB it's the difference between a table that packs itself and a table that doubles.

## Back to that UUID

Which brings us back to `id UUID PRIMARY KEY`, now with the machinery to explain it.

In InnoDB the primary key *is* the table ([Part 1](/posts/postgres-vs-mysql-storage-clustered-vs-heap/)), so the primary key's arrival order is the table's insert order. An auto-incrementing integer arrives in perfect order and lands on the happy path from the last section: right sibling or split-at-the-tail, pages sealed nearly full, the active tail sitting in the buffer pool, writes sequential.

UUIDv4 is 122 bits of randomness, so every insert targets an essentially random leaf. The eager heuristic never fires, because the previous insert on that page happened thousands of rows ago. Three things go wrong at once, and they compound:

- The target page is usually already full, so a mid-tree split happens on insert after insert.
- Every one of those splits takes the 50/50 path, so the steady state is pages half full and a table roughly double the size it needs to be.
- The target page is usually not in memory. InnoDB reads a random 16 KB page from disk, inserts, splits, and eventually flushes, and repeats. Sequential writes have become random reads plus random writes.

The third point is the one that actually takes the system down. The first two are a space problem you could throw disk at, but a buffer pool that can't cache a working set spread uniformly across the whole table has nothing left to give.

Postgres mostly shrugs. Rows go into the heap wherever there's room, and no key value changes that, so the random-insert cost is confined to the index B-Tree instead of the full-width table data. An index entry is a key and a TID, so the splits move far less and the bloat is bounded by something much smaller than your table. Real cost, different order of magnitude.

The fix on the MySQL side is [UUIDv7](https://www.rfc-editor.org/rfc/rfc9562#name-uuid-version-7), which puts a millisecond Unix timestamp in the leading 48 bits and fills the rest with randomness. Time only moves forward, so v7 values sort roughly in generation order and append to the right edge of the clustered index the way an integer does, while staying globally unique with no coordination. You keep the property you wanted UUIDs for and stop paying for the one you didn't ask for.

Two caveats, because v7 isn't magic. Concurrent generators inside the same millisecond still interleave, so "roughly sequential" means the insert point stays within the rightmost page or two rather than being strictly monotonic. That's enough for the heuristic and it isn't the same as an auto-increment. The other caveat is that a v7 tells anyone holding it when it was created, which is fine right up until opaque IDs were the reason you wanted UUIDs.

If you've already shipped v4 and want to know how bad it is before planning a migration, InnoDB will tell you:

```sql
SELECT table_name,
       data_length,
       data_free,
       ROUND(data_free / NULLIF(data_length, 0) * 100, 1) AS pct_free
FROM information_schema.tables
WHERE table_schema = DATABASE()
ORDER BY data_length DESC;
```

`data_free` on a clustered index that's been fed random keys creeps toward a third or more of `data_length`, and a fresh `OPTIMIZE TABLE` on the same data will show you how much of that is recoverable versus structural. Do that on a replica, though. `OPTIMIZE TABLE` rebuilds the table and holds a metadata lock at the end of it.

Everything so far has been one connection's view of storage. [Part 5](/posts/postgres-vs-mysql-connection-models/) is about what happens when several thousand clients show up at once, where a second root decision, entirely independent of clustered-versus-heap, explains why the two servers fall over in completely different ways.
