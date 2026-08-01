---
title: "(Pt. 5) Postgres vs MySQL: Connections, Processes vs Threads"
date: 2026-07-26 10:00:00 -0700
categories: [databases, internals]
tags: [postgres, mysql, connections, processes, threads]
---

> Part 5 of a five-part series:
> 1. [Clustered index vs heap](/posts/postgres-vs-mysql-storage-clustered-vs-heap/)
> 2. [MVCC + vacuum vs undo log](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/)
> 3. [HOT updates](/posts/postgres-vs-mysql-hot-updates/)
> 4. [Page splits, TOAST, and UUIDs](/posts/postgres-vs-mysql-page-splits-toast-uuids/)
> 5. Connections: processes vs threads (this post)
{: .prompt-info }

`FATAL: sorry, too many clients already`.

You deployed the same code to Lambda that ran fine on three app servers, traffic scaled it to 150 concurrent invocations, and Postgres started refusing connections at 100. The same deployment against MySQL would have kept going, since MySQL's default is 151.

Postgres defaults to [100](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/utils/misc/postgresql.conf.sample#L67) and MySQL to [151](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/sql/sys_vars.h#L110), and neither number is a tuning preference somebody landed on. A Postgres connection is an operating system process, and a MySQL connection is a thread.

Everything else in this post is downstream of that one sentence: what a connection costs to open, how much memory it holds while doing nothing, what happens to the others when one crashes, and which knob is the right one when you hit the wall.

## Postgres: a process per connection

A Postgres server is a family of processes. A supervisor called the [postmaster](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/postmaster/postmaster.c) owns the listening socket and the shared memory region. When a client connects, the postmaster [launches a child process](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/postmaster/postmaster.c#L3627) that handles that one connection for its entire life, bottoming out in a real [`fork_process()`](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/postmaster/launch_backend.c#L222).

```text
        postmaster (supervisor)
        owns listen socket + shared memory
                 │  fork() on connect
     ┌───────────┼───────────┐
     ▼           ▼           ▼
  backend 1   backend 2   backend 3
  client A    client B    client C
     └───────────┴───────────┘
        attach the shared buffer pool
```

Each backend is a full process with its own address space and process-local memory, holding catalog and plan caches plus `work_mem` for sorts and hashes. They cooperate through a single shared memory segment holding the buffer pool, the lock table, and WAL buffers.

Isolation is what you get for the trouble. A backend that segfaults kills its own connection, and the postmaster resets shared memory and carries on rather than taking every other session down with it. For a database that's a genuinely good trade.

The weight is what you pay. `fork()` plus a fresh address space is expensive per connection, and an idle backend still holds its process-local memory and counts against `max_connections`.

`work_mem` is where this gets people, because it's per sort node and not per connection. A query with three sorts and a hash join can allocate several multiples of `work_mem` on its own, so 200 backends running that query against a 4 MB default aren't using 800 MB. They're using some larger number nobody computed, and the machine finds out before you do.

Which is why serious Postgres deployments put PgBouncer in front and keep the backend count near the core count instead of near the client count. The pooler isn't there because connections are slow to open. It's there because a Postgres connection is a process, and processes are not something you want thousands of.

## MySQL: a thread per connection

MySQL runs a single server process, `mysqld`. Its default [per-thread connection handler](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/sql/conn_handler/connection_handler_per_thread.cc#L404) calls [`mysql_thread_create`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/sql/conn_handler/connection_handler_per_thread.cc#L421) to spin up a thread per connection, all inside that process.

```text
        mysqld (single process)
        one shared address space
     ┌───────────┼───────────┐
     ▼           ▼           ▼
  thread 1    thread 2    thread 3
  client A    client B    client C
     └───────────┴───────────┘
      buffer pool is just shared heap
```

Threads share the process address space, so the buffer pool and the caches are just memory every thread can already reach. Nothing to attach, no segment to size. Spawning a thread is cheaper than forking, and MySQL goes further by keeping a [thread cache](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/sql/conn_handler/connection_handler_per_thread.cc#L147) so a disconnecting client's thread gets parked and handed to the next connection instead of destroyed.

That cache is smaller than you'd guess. `thread_cache_size` defaults to [`8 + max_connections / 100`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/sql/mysqld.cc#L6936), which at the default 151 connections is nine parked threads. Nine. A workload that opens and closes connections faster than that creates real threads for the overflow, so if `Threads_created` keeps climbing long after startup, that's the number to raise.

Cheaper connections mean MySQL gets further before it needs help. The downside is exactly Postgres's upside inverted: one address space means a memory bug in one thread can corrupt state every other thread is reading, with no supervisor able to isolate it. Postgres loses a connection where MySQL loses the server.

Threads aren't free at scale either. Thousands of them contending on shared structures spend measurable time in context switches and lock waits, which is the problem MySQL's [thread pool](https://dev.mysql.com/doc/refman/8.4/en/thread-pool.html) addresses by multiplexing connections onto a bounded set of threads. It's an Enterprise feature, so on community MySQL the answer is the same as on Postgres: a pooler, in front, doing the bounding for you.

## The trade-off

This is the one part of the series where InnoDB never comes up. Connection handling lives in the MySQL server layer above the storage engine, so everything here holds with a different engine underneath.

| | PostgreSQL | MySQL |
|---|---|---|
| Unit per connection | OS process (`fork`) | OS thread |
| Server shape | Postmaster + many backends | One `mysqld`, many threads |
| Shared state | Explicit shared memory segment | Shared process address space |
| Default `max_connections` | 100 | 151 |
| Cost per connection | Higher (process + local memory) | Lower (thread, cached and reused) |
| One connection crashes | Isolated, server survives | Can take down the whole server |
| Reuse | New backend each time | Thread cache parks and reuses threads |

Neither model gets you out of bounding concurrency, which is the practical takeaway if you keep only one. Postgres hits the wall earlier on raw count because processes are heavy, so a pooler is close to mandatory. MySQL's threads are cheap enough that you can get complacent, then hit a different wall made of context switches and contention. Both engines want the number of things actively executing to be close to your core count, and neither will enforce that for you.

Back to the Lambda from the top. Raising `max_connections` to 500 on the Postgres side is the obvious move and the wrong one, because you'd be asking the machine to hold 500 processes and their `work_mem` so 500 mostly-idle Lambdas can each hold a connection they're not using. PgBouncer in transaction mode gives those 500 clients 20 real backends and the problem stops existing. Same fix works on MySQL, and the only reason it feels less urgent there is that the wall is further out, not that it isn't there.

## The two roots

Five posts, and nearly everything traced back to two decisions.

Clustered index versus heap ([Part 1](/posts/postgres-vs-mysql-storage-clustered-vs-heap/)) decided whether a row has a stable identity or a physical address, and that one fact produced copy-on-write MVCC and vacuum, HOT and `fillfactor`, page splits, and why UUIDv4 is merely suboptimal on one engine and a production incident on the other.

Process versus thread decided everything in this post, and it's genuinely orthogonal. You could build a heap-based engine with threads or a clustered engine with processes, and nobody did, so the choices arrive bundled.

Most "should we use Postgres or MySQL" arguments are really arguments about one of these two roots, usually without saying so. Worth figuring out which one you're actually having.
