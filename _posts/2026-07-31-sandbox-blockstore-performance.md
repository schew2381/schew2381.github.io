---
title: "(Pt. 4) sandbox-blockstore: Optimizing startup performance"
date: 2026-07-31 12:00:00 -0700
categories: [kubernetes, storage, performance]
tags: [csi, performance, caching, prefetch, s3, mincore]
---

> A four-part series on lazy block storage and how it becomes a Kubernetes CSI driver:
> 1. [How E2B block storage works](/posts/e2b-block-storage-layer/)
> 2. [K8s CSI interface](/posts/kubernetes-csi-interface/)
> 3. [Adapting E2B block storage into a CSI driver](/posts/sandbox-blockstore-csi-driver/)
> 4. Optimizing startup performance (this post)
{: .prompt-info }

A Pod sitting in the warm pool, pre-started so that nobody would have to wait for scheduling, passed its readiness probe and then took 56.8 seconds to answer its first request.

Nothing was broken, which is the part worth sitting with. Lazy block fetch was doing exactly what Part 1 promised: it moves the cost out of the mount and into the first read. That's a great trade until the first read is the one a user is watching a spinner for.

Two changes went after that from opposite ends. One shares fetched bytes between Pods on a node so the second Pod doesn't repay what the first already paid, and the other fetches the right bytes before anybody asks. Neither subsumes the other, and why not turns out to be more interesting than either change.

## Where the time actually went

Readiness is the trap. A Pod passes its probe as soon as the volume is mounted and the container is up, and Part 3's mount is one header read plus local setup, so that lands in well under a second:

```text
  WHAT READY MEANS                       WHAT'S ACTUALLY ON THE NODE

  volume mounted          ✓              header, a few KiB      ✓
  filesystem present      ✓              write cache, empty     ✓
  container running       ✓              read cache, empty      ✓
  probe passing           ✓              file contents          ✗ none of it

  kubelet: Ready                         the next read is an S3 round trip
```

Nothing in the readiness signal has an opinion about file content, because from kubelet's side the volume is mounted and the filesystem is there. Then a real request arrives:

```text
git status over 62,115 index entries

  stat + read each path ──> ext4 ──> /dev/nbd7 ──> chunker
                                                      │
                                                      │  every chunk a miss
                                                      ▼
                                                 S3 range GET
```

Each of those entries is a `stat` and usually a read, scattered across an 8 GiB image with no locality worth speaking of, and any read that lands in an unfetched chunk blocks on a round trip to object storage. So `Ready` was true, every health check was green, and the Pod was useless for the next minute.

## Change one: share the cache across Pods

Part 3 built the node-shared read cache and argued for why it's safe. What it bought is a number, and getting it meant running the same thing twice.

The workload is a full development environment coming up: a startup script waits for the CSI mount to be readable, then brings up Postgres, Redis, and OpenSearch concurrently, then waits for the slow ones, then re-syncs the toolchain. Run it on a node whose cache is empty, then run it again on the same node with the cache populated:

| Phase | Empty | Populated | Saved | Improvement |
|---|---|---|---|---|
| Mount sentinel wait | 1.182s | 0.010s | 1.172s | 99.15% |
| Plugins and services start concurrently | 30.516s | 20.479s | 10.037s | 32.89% |
| Remaining service wait | 17.481s | 8.796s | 8.685s | 49.68% |
| Final dev sync | 2.726s | 1.265s | 1.461s | 53.59% |
| **Total startup** | **52.009s** | **30.651s** | **21.358s** | **41.07%** |

The first row is the one that explains the rest. It's nothing but first-read latency, and with the cache populated there's no first read left to pay for, so it drops by two orders of magnitude. Every row below it is the same effect diluted by however much real CPU work that phase also does.

Nothing about the workload changed between the two columns. Same bytes, same order, same everything. 21 of those 52 seconds were one Pod refetching what another Pod on the same machine already had sitting on local disk.

It shipped default-off behind `--shared-read-cache`, which was the right call. Cross-Pod sharing of an mmap'd file is exactly the kind of change where the failure mode is subtle and the blast radius is every Pod on the node.

## Change two: fetch the startup set before the Pod is Ready

Sharing fixes the second Pod. The first one still pays in full, and on a freshly scaled-up node every Pod is the first one, which is also precisely when a burst of Pods is arriving.

The second change comes at it from the other side, and it starts from noticing who the read set actually belongs to. What `git status` touches isn't a fact about this Pod or this request. It's a fact about the template's contents, fixed at build time, identical for every Pod that ever boots from it. So record it once, and prefetch it during the mount:

```text
  ONCE PER TEMPLATE, AT BUILD TIME

  run git status against the image
    │
    ▼
  ask the page cache what it touched
    │
    ▼
  s3://…/<build>/rootfs.ext4.startup-hotset.v1.json      a few KiB
    │
    │  EVERY MOUNT, ON EVERY NODE, FOREVER AFTER
    ▼
  validate it against the header we just read
    │
    ▼
  coalesce the offsets, fetch them before serving
```

### Recording it

The obvious way to record a read set is to trace the workload, with `strace` or an eBPF probe on `read` or instrumentation inside the chunker. They all answer a different question than the one we have:

```text
  WHAT A TRACE GIVES YOU                 WHAT THE DRIVER HAS TO FETCH

  read(.git/index, 4096) at              chunk at 25165824   ■
  file offset 811008                     chunk at 29360128   ■
  read(src/main.go, 4096) at             chunk at 96468992   ■
  file offset 0

  offsets inside files                   4 MiB offsets into rootfs.ext4

  translating left to right means reimplementing ext4's
  block allocator in your head
```

So the recording pass in `template-builder`, under `--record-startup-hotset`, asks the kernel instead. Run the workload through a loop mount, then ask the page cache which pages of the backing file are resident, and whatever it says is by construction exactly what the read path touched.

```text
1. cp -a the source tree into the image through a loop mount
2. optionally refresh the git index so status doesn't rehash everything
3. syncfs, close the loop device
4. fsync + posix_fadvise(FADV_DONTNEED) the backing file
5. reopen the loop mount, run git status
6. mincore(2) the backing file's mapping
7. resident pages ──> deduplicated 4 MiB chunk offsets
```

The whole measurement rests on the page cache telling the truth, and two things can make it lie.

The loop device has to be opened with `losetup --direct-io=off`, because direct I/O is exactly the wrong thing here:

```text
  --direct-io=on                         --direct-io=off

  git status reads                       git status reads
    │                                      │
    ▼  bypasses the page cache             ▼
  backing file                           page cache ──> backing file
    │                                      │
    ▼                                      ▼
  mincore: nothing resident              mincore: every page it touched
    │                                      │
    ▼                                      ▼
  empty hot set from a workload          the hot set we wanted
  that read half the image
```

The page cache being a side effect is the entire measurement, so anything that skips it produces a manifest that's confidently empty.

Step 4's eviction has to actually land, which sounds like a formality and isn't. `prepareColdBackingFile` retries three times and hard-errors if pages stay resident, because a file that's still half warm produces a hot set missing precisely the chunks that were already cached, which are usually the important ones. An empty result is a hard error too. Better to fail the build than to publish a manifest that prefetches nothing and looks like it's working.

Going from resident pages to chunk offsets is also where the manifest gets small enough to ship:

```text
  mincore(2) returns one byte per 4 KiB page of the backing file

  page      0     1     2     3    ...   1024   1025   ...   2048
            ·     ■     ■     ·          ■      ·            ■

  1024 pages fill one 4 MiB chunk, so one resident page marks the chunk

  chunk     0                          1              2
            ■ pages 1 and 2            ■ page 1024    ■ page 2048

  manifest  [0, 4194304, 8388608]

  an 8 GiB image is 2,097,152 pages but only 2048 chunks, so the
  manifest can't exceed 2048 offsets no matter what the workload did
```

`residentPagesToOffsets` is picky about that arithmetic, refusing to run unless the chunk size divides cleanly by the page size and the page count matches the mapping length, because an off-by-one here publishes offsets that point somewhere else in the image entirely.

```go
type StartupHotset struct {
	Version      int
	BuildID      string
	HeaderSHA256 string
	ImageSize    int64
	ChunkSize    int64
	Offsets      []int64
}
```

`Offsets` is the answer, and the other five fields are there so the driver can decide not to trust it. `ParseStartupHotset` checks the build ID, the header digest, and the image size against the header it just read, and throws the manifest away if any of them disagree. Same reasoning as the shared cache key from Part 3, because a manifest recorded against a different build of the same template holds offsets that mean something else now, and prefetching them spends GETs on chunks nobody wants.

### Prefetching it

Where the prefetch sits in the mount matters more than how it works. `prefetchStartupHotset` runs as phase 5 of Part 3's eight, between building the read device and building the write overlay, so it finishes before the NBD device exists:

```text
  PREFETCH AT PHASE 5                    PREFETCH AFTER PHASE 8

  phase 4  read device                   phase 8  mount
  phase 5  prefetch  ◄── all of it          │
  phase 6  write overlay                    ▼
  phase 7  open NBD                      a read can arrive here, so the
  phase 8  mount                         prefetch and a demand read race
     │                                   for the same S3 sockets
     ▼
  no block device existed yet, so        whoever loses has a real process
  nothing could have read anything       blocked behind it
```

`PrefetchStartupOffsets` enforces that directly and refuses to run once the chunker has started serving. A prefetch that steals sockets from a reader with a real process behind it has made things worse while looking like it helped.

Planning happens before any fetch goes out:

```text
hot set offsets (4 MiB chunks, sorted)

  0  4  8          20 24 28 32         48
  ■  ■  ■          ■  ■  ■  ■          ■

coalesced into ranges, capped at maxRangeBytes

  [0..12)          [20..36)            [48..52)
  one reader       one reader          one reader
  3 chunks         4 chunks            1 chunk
```

`prefetchRanges` sorts and compacts the offsets, drops anything already cached, and coalesces what's left into contiguous ranges up to `maxRangeBytes`. That skip step is where the two changes meet: on a warm node with a populated shared cache, most of the hot set is already there and the prefetch turns into almost nothing.

Each range opens one reader and still walks it a chunk at a time, because completion is recorded per 4 MiB chunk and a range that dies halfway should leave behind the chunks it did finish rather than nothing.

Concurrency is a weighted semaphore where each range's weight is its chunk count, so the permits bound bytes in flight rather than requests in flight:

```text
  16 PERMITS, ONE PER REQUEST            16 PERMITS, ONE PER CHUNK

  16 ranges x 1 chunk    64 MiB          16 chunks    64 MiB
  16 ranges x 256 chunks 16 GiB          always

  the same permit count means            the permit count is a byte
  whatever the offsets happened          budget the coalescing can't
  to coalesce into                       move
```

```go
effectiveMaxRangeBytes := min(maxRangeBytes, int64(concurrency)*storage.MemoryChunkSize)
```

Production runs 16 permits against a 4 MiB range cap, so 64 MiB, and the plan gets logged before it executes so a slow prefetch shows up as a log line rather than a mystery.

Two smaller behaviors make it compose with Part 3. Prefetched chunks go through `commitChunk` like any other, so they land in the state file and survive a daemon restart. And prefetch is single-flighted per device, so a second volume mounting the same template mid-prefetch waits on the one already running and reports `Reused` instead of starting a duplicate.

### Where the 512 KiB batch backfires

Part 3's 512 KiB read batch exists to wake a blocked reader sooner. A prefetch has no reader to wake, so every notify cycle it pays for is wasted:

```text
ONE 4 MiB CHUNK, ONE OPEN GetObject

  DEMAND READ                          PREFETCH

  ├─ read 512 KiB → lock, notify       └─ io.ReadFull(4 MiB)
  ├─ read 512 KiB → lock, notify
  ├─ ... 8 batches
  └─ done

  8 notify cycles, readers freed early  1 read, nobody waiting
```

A demand read has no idea how much of the chunk anyone wants, so cutting the fetch into pieces is the only way to release readers early. A prefetch knows it wants all 4 MiB, because that's what being in the hot set means, so it reads straight through with `io.ReadFull`.

Both paths are one GET. The reader stays open across batches and only reopens at a mapping boundary, so the batching never controlled the request count. What the prefetch skips is the eight rounds of taking the session lock and walking the waiter list to find nobody there.

### Numbers

| Scenario | Before | After | Improvement |
|---|---|---|---|
| Mount plus first `git status` | 9.80s | 6.97s | 28.9% |
| Warm-Pod Git preparation | 11.48s | 7.01s | 39.0% |
| Ordinary demand read | 10.94s | 9.18s | 16.1% |
| Ready-Pod first agent turn | 56.8s | 4.9 to 7.2s | 87-91% |

The last row is the one the work was for. 56.8 seconds down to 5 to 7, on a Pod that Kubernetes had already been calling `Ready` the whole time.

Row three is a freebie nobody designed for. Ordinary demand reads aren't in the hot set at all, and they still got 16% faster, partly from the larger effective range size and partly from chunks the prefetch swept up on its way to something adjacent.

Three things that table doesn't measure, in increasing order of how much they bother me: a cold node with no shared cache underneath the prefetch, the aggregate drop in S3 requests, and what the prefetch adds to mount latency once a hot set gets large. That last one is the failure mode this change most plausibly has, and it's the one with no number next to it.

So it rolled out in three separate steps rather than one:

```text
  step 1   driver change, prefetch code present but nothing publishes a manifest
  step 2   environment starts publishing rootfs.ext4.startup-hotset.v1.json
  step 3   node config: 16 permits, 4 MiB range cap, daemon memory limit to 10 GiB

  a regression after any step has exactly one candidate cause
```

Shipping all three together would have left any regression with three suspects and no way to bisect between them.

## How the two changes compose

Neither change subsumes the other, and the reason is that they answer different questions. The shared cache answers "has anyone on this node already fetched this," which is a question with no useful answer on a fresh node. The hot set answers "what is this template about to need," which has the same answer everywhere and is worth the least when the cache is already full of it.

```text
                              cold node             warm node
                              (empty cache)         (populated cache)

first Pod on a template       prefetch pays the     prefetch mostly skips,
                              S3 cost up front      chunks already cached

later Pods on that template   shared cache hit      shared cache hit
```

Read down the columns and the coverage is clean. The shared cache turns "every Pod pays" into "the first Pod pays," and the hot set takes what the first Pod pays and moves it out of the critical path into the mount, where nobody is waiting on a response yet.

Turn both on and a third thing happens that neither one does alone. Without the prefetch, what ends up in the shared cache is whatever the first Pod's workload happened to wander into, and the next Pod inherits that arbitrary set:

```text
  SHARED CACHE ALONE                     BOTH TOGETHER

  Pod A does something odd               prefetch fills the hot set
    │                                      │
    ▼                                      ▼
  cache holds Pod A's                    cache holds what every Pod
  particular read set                    on this template needs first
    │                                      │
    ▼                                      ▼
  Pod B hits some of it,                 Pod B hits nearly all of it
  misses the rest
```

The shared cache gets better at its job because something else decided what to put in it.

## Trade-offs

| | Node-shared read cache | Startup hot set prefetch |
|---|---|---|
| Helps | Every Pod after the first | The first Pod, and cold nodes |
| Cost | Cross-Pod coupling on one mmap'd file | Longer mount, wasted GETs if wrong |
| Staleness risk | Key includes the header digest | Manifest validated against the header |
| Failure mode | Cache miss, refetch | Prefetch skipped, demand reads as before |
| Tuning | Watermarks and idle TTL | Concurrency and range cap |

The hot set's weakness is that it's a recording of one workload, and it's honest about being one. It was recorded from `git status`, so it prefetches what `git status` reads. Start a Pod that does something else first and it pays mount latency for chunks it will never touch, then misses on the ones it needs. Widening the recording to cover more startup paths is possible, and every path you add grows the manifest and the prefetch. Push that far enough and you've reinvented downloading the image, at which point Part 1's whole premise was wrong.

The shared cache's weakness is coupling, which is what you buy when you point twenty Pods at one file. A corrupt cache file, a full disk, or an eviction at an unlucky moment reaches all of them at once. The header digest in the key rules out the genuinely bad case where two volumes read each other's data through mismatched mappings, and the rest is bounded rather than prevented: watermarks keep the disk from filling, and the state file's whole-chunk-only rule keeps a torn write from being trusted.

Both changes rest on the same property from Part 1, which is that the read side never changes. A chunk fetched for one Pod is therefore valid for another, a page-cache recording made at build time is still valid at mount time on a different machine a week later, and a cache file can be handed to a process that has no idea some other process already filled it. None of those three needed a protocol to coordinate, because immutable bytes don't need one. Everything hard in this series turned out to live on the other side of the overlay, where the writes are.
