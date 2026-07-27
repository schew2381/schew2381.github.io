---
title: "Postgres vs MySQL, Part 5: Connections, Processes vs Threads"
date: 2026-07-26 10:00:00 -0700
categories: [databases, internals]
tags: [postgres, mysql, connections, processes, threads]
---

> Part 5 of a five-part series:
> 1. [Clustered index vs heap](/posts/postgres-vs-mysql-storage-clustered-vs-heap/)
> 2. [MVCC: vacuum vs the undo log](/posts/postgres-vs-mysql-mvcc-vacuum-vs-undo/)
> 3. [HOT updates](/posts/postgres-vs-mysql-hot-updates/)
> 4. [Page splits, TOAST, and UUIDs](/posts/postgres-vs-mysql-page-splits-toast-uuids/)
> 5. Connections: processes vs threads (this post)
{: .prompt-info }

The first four parts were about one connection's view of storage. This one is about what happens when thousands of clients connect at once, and here the split isn't clustered-versus-heap. It's operating-system processes versus threads.

Postgres runs one OS process per connection. MySQL runs one OS thread per connection. That single choice drives connection cost, isolation, memory footprint, and why "just open more connections" fails differently on each.

## Postgres: a process per connection

A Postgres server is a family of processes. A supervisor called the [postmaster](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/postmaster/postmaster.c) owns the listening socket and the shared memory region. When a client connects, the postmaster [`fork()`s a new backend process](https://github.com/postgres/postgres/blob/e395fbd32a07557de4ac98088928c1749d4845d8/src/backend/postmaster/postmaster.c#L3627) to handle that one connection for its entire life.

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

Each backend is a full process with its own address space and process-local memory (`work_mem` for sorts and hashes, catalog and plan caches). They cooperate through one shared memory segment that holds the buffer pool, locks, and WAL buffers.

The upside is isolation. A backend that segfaults takes down its own connection, and the postmaster resets shared memory and keeps the server alive rather than crashing every session. The downside is weight. `fork()` and a fresh address space are expensive to set up, and each idle backend still holds process-local memory. Thousands of connections mean thousands of processes, which is why a Postgres deployment usually sits behind a pooler like PgBouncer instead of letting every client fork its own backend.

## MySQL: a thread per connection

MySQL runs a single server process, `mysqld`. Its default [per-thread connection handler](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/sql/conn_handler/connection_handler_per_thread.cc#L404) calls [`mysql_thread_create`](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/sql/conn_handler/connection_handler_per_thread.cc#L421) to spin up a thread per connection, all inside that one process.

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

Threads share the process's address space by default, so the buffer pool and caches are simply memory every thread can already reach, with no shared-memory segment to attach. Spawning a thread is cheaper than forking a process, and MySQL keeps a [thread cache](https://github.com/mysql/mysql-server/blob/d229bb760c49b65e19ec28342236961ad961d7fe/sql/conn_handler/connection_handler_per_thread.cc#L147) so a disconnecting client's thread can be parked and handed to the next connection instead of being destroyed and recreated.

The upside is that connections are lighter, so MySQL tolerates a higher raw connection count before it needs a pooler. The downside is the flip side of Postgres's isolation: threads share one address space, so memory corruption in one thread can take down the whole server. At very high connection counts the per-thread model also spends real time on context switching and lock contention, which is what MySQL's [thread pool plugin](https://dev.mysql.com/doc/refman/8.4/en/thread-pool.html) (Enterprise) exists to bound.

## The trade-off

| | PostgreSQL | MySQL (InnoDB) |
|---|---|---|
| Unit per connection | OS process (`fork`) | OS thread |
| Server shape | Postmaster + many backends | One `mysqld`, many threads |
| Shared state | Explicit shared memory segment | Shared process address space |
| Cost per connection | Higher (process + local memory) | Lower (thread, cached and reused) |
| One connection crashes | Isolated; server survives | Can take down the whole server |
| Reuse | New backend each time | Thread cache parks and reuses threads |

Neither model removes the need to bound concurrency. Postgres hits its wall sooner on raw connection count because processes are heavy, so a pooler is close to mandatory at scale. MySQL's threads are cheaper per connection but share fate, so its wall is context-switch and contention overhead that a thread pool addresses. The right mental model is the same for both: a database connection is expensive, and something, a pooler or a thread pool, has to keep the active count sane.

That closes the series. The clustered-index-versus-heap decision from [Part 1](/posts/postgres-vs-mysql-storage-clustered-vs-heap/) rippled through MVCC, HOT, page splits, and UUID behavior, and the process-versus-thread decision here is a second root choice that shapes how each server behaves under load. Most "should I use Postgres or MySQL" arguments are really arguments about these two roots.
