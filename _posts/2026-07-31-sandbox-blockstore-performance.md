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

[Part 3](/posts/sandbox-blockstore-csi-driver/)'s mount finishes in under a second because it reads one header and nothing else. So what does the first real request against that Pod cost? On a warm-pool Pod that had already passed its readiness probe, a bit under a minute.

Nothing was broken, and lazy block fetch was doing exactly what Part 1 promised, moving the cost out of the mount and into the first read. That's a great trade until the first read is the one a user is watching a spinner for.

Two changes came at that from opposite ends. One shares fetched bytes between Pods on a node so the second Pod doesn't repay what the first already paid, and the other fetches the right bytes before anybody asks.

So let's price the sharing by bringing the same environment up twice on one cold node, then go record what a startup actually reads and fetch it during the mount.

## Where the time went

Readiness is the trap. A Pod passes its probe as soon as the volume is mounted and the container is up. Part 3's mount is one header read plus local setup, so that lands in well under a second:

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

Each of those entries is a `stat` and usually a read, scattered across an 8 GiB image with no locality worth speaking of. Any read landing in an unfetched chunk blocks on a round trip to object storage. So `Ready` was true, every health check was green, and the Pod was useless for the next minute.

## Sharing the cache across Pods

Part 3 built the node-shared read cache and argued for why it's safe. What it bought is a number, and getting it meant running the same thing twice.

The workload is a full development environment coming up, in four steps that line up with the four rows below.

1. Wait for the CSI mount to be readable.
2. Bring up Postgres, Redis, and OpenSearch concurrently.
3. Wait for the slow ones to finish.
4. Re-sync the toolchain.

Run it on a node whose cache is empty, then run it again on the same node with the cache populated:

| Phase | Empty | Populated | Saved | Improvement |
|---|---|---|---|---|
| Mount sentinel wait | 1.182s | 0.010s | 1.172s | 99.15% |
| Plugins and services start concurrently | 30.516s | 20.479s | 10.037s | 32.89% |
| Remaining service wait | 17.481s | 8.796s | 8.685s | 49.68% |
| Final dev sync | 2.726s | 1.265s | 1.461s | 53.59% |
| **Total startup** | **52.009s** | **30.651s** | **21.358s** | **41.07%** |

The sentinel is a file the image ships with, which the entrypoint reads to find out whether the volume is serving yet. Waiting on it went from 1.182s to 0.010s, because that phase is nothing but first-read latency and a populated cache leaves no first read to pay for. The phase that actually dominates the total, three services coming up at once, only fell from 30.5s to 20.5s. Most of what it spends is CPU no cache can help with. Every row is the same effect diluted by however much real work that phase also does.

Nothing about the workload changed between the two columns, so 21 of those 52 seconds were one Pod refetching what another Pod on the same machine already had sitting on local disk.

We shipped it default-off behind `--shared-read-cache`. Cross-Pod sharing of an mmap'd file is the kind of change where the failure mode is subtle and the blast radius is every Pod on the node.

## Prefetching the startup set

Sharing fixes the second Pod. The first one still pays in full, and on a freshly scaled-up node every Pod is the first one, which is exactly when a burst of them arrives.

The second change starts from noticing who the read set actually belongs to. What `git status` touches isn't a fact about this Pod or this request. It's a fact about the template's contents, fixed at build time, identical for every Pod that ever boots from it. So record it once, and prefetch it during the mount:

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

So the recording pass asks the kernel instead. It runs in the build pipeline, the same pass that produces a template's objects in the first place, under `--record-startup-hotset`. Run the workload through a loop mount, then ask the page cache which pages of the backing file are resident, and whatever it says is by construction exactly what the read path touched.

```text
1. cp -a the source tree into the image through a loop mount
2. optionally refresh the git index so status doesn't rehash everything
3. syncfs, close the loop device
4. fsync + posix_fadvise(FADV_DONTNEED) the backing file
5. reopen the loop mount, run git status
6. mincore(2) the backing file's mapping
7. resident pages ──> deduplicated 4 MiB chunk offsets
```

Steps 3 through 6 are the whole trick, and they're three states of the same page cache:

```text
  AFTER cp -a           AFTER FADV_DONTNEED       AFTER git status

  ■■■■■■■■■■■■■■■■■     ·················         ··■■··■····■··■··

  every page warm       nothing resident          only what status read
  from the copy         (retried 3x, hard         and this is the
                        error if any stay)        manifest
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

The page cache being a side effect is the entire measurement, so anything that bypasses it produces a manifest that's confidently empty and a build that looks like it worked.

Step 4's eviction has to actually land. `prepareColdBackingFile` retries three times and hard-errors if pages stay resident, because a file that's still half warm produces a hot set missing precisely the chunks that were already cached. Those are usually the important ones. An empty result is a hard error too. Better to fail the build than to publish a manifest that prefetches nothing and looks like it's working.

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

`residentPagesToOffsets` is picky about that arithmetic. It refuses to run unless the chunk size divides cleanly by the page size and the page count matches the mapping length, because an off-by-one here publishes offsets pointing somewhere else in the image entirely.

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

`Offsets` is the answer, and the other five exist so the driver can refuse to believe it. `ParseStartupHotset` walks them against the header it just read. `BuildID`, `HeaderSHA256`, and `ImageSize` all have to match, `ChunkSize` has to be the chunk size this driver actually fetches in, and `Version` is the escape hatch for the day the format changes. Any disagreement throws the manifest away. Same reasoning as the shared cache key from Part 3, because a manifest recorded against a different build of the same template holds offsets that mean something else now.

### Prefetching it

`prefetchStartupHotset` runs as phase 5 of Part 3's eight, between building the read device and building the write overlay, so it finishes before the NBD device exists at all:

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

Every range gets planned and logged before a single GET goes out:

```text
hot set offsets (4 MiB chunks, sorted)

  0  4  8          20 24 28 32         48
  ■  ■  ■          ■  ■  ■  ■          ■

coalesced into ranges, capped at maxRangeBytes

  [0..12)          [20..36)            [48..52)
  one reader       one reader          one reader
  3 chunks         4 chunks            1 chunk
```

The step the diagram doesn't show is the skip. `prefetchRanges` drops anything already cached before it coalesces, which is where the two changes meet, because on a warm node most of the hot set is already there and the prefetch turns into almost nothing.

Each range opens one reader and still walks it a chunk at a time. Completion is recorded per 4 MiB chunk, so a range that dies halfway leaves behind the chunks it did finish rather than nothing.

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

A demand read has no idea how much of the chunk anyone wants, so cutting the fetch into pieces is the only way to release a reader before the whole 4 MiB lands. A prefetch knows it wants all of it, because that's what being in the hot set means, so it reads straight through with `io.ReadFull`.

Both paths are one GET. The reader stays open across batches and only reopens at a mapping boundary, so the batching never controlled the request count. What the prefetch skips is the eight rounds of taking the session lock and walking the waiter list to find nobody there.

### What it bought

| Scenario | Before | After | Improvement |
|---|---|---|---|
| Mount plus first `git status` | 9.80s | 6.97s | 28.9% |
| Warm-Pod Git preparation | 11.48s | 7.01s | 39.0% |
| Ordinary demand read | 10.94s | 9.18s | 16.1% |
| Ready-Pod first agent turn | 56.8s | 4.9 to 7.2s | 87-91% |

A `Ready` Pod's first agent turn went from 56.8 seconds to somewhere between 4.9 and 7.2, on a Pod Kubernetes had been calling `Ready` the whole time. That row is what the work was for.

The 16% on ordinary demand reads is a freebie nobody designed for. Those reads aren't in the hot set at all, and they still got faster, partly from the larger effective range size and partly from chunks the prefetch swept up on its way to something adjacent.

Three things that table doesn't measure, worst last.

1. A cold node with no shared cache underneath the prefetch.
2. The aggregate drop in S3 requests.
3. What the prefetch adds to mount latency once a hot set gets large.

That last one is the failure mode this change most plausibly has, and it's the one with no number next to it.

So we rolled it out in three steps instead of one:

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

The shared cache turns "every Pod pays" into "the first Pod pays." The hot set takes what the first Pod pays and moves it out of the critical path into the mount, where nobody is waiting on a response yet.

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

Before either change, a Pod on this driver paid three separate tolls.

- It refetched bytes a neighbour on the same node already had on local disk.
- It paid for the first read of each chunk in the middle of a user request.
- It ended up with whatever cached set the first workload on that node happened to wander into.

Sharing kills the first one and the prefetch kills the second, and together they replace the third with something deliberate. What each buys costs something in return, and the two bills are different shapes. Sharing is tuned with watermarks and an idle TTL, and the prefetch with a concurrency limit and a range cap.

The hot set's weakness is that it's a recording of one workload, and it's honest about being one. It was recorded from `git status`, so it prefetches what `git status` reads. Start a Pod that does something else first and it pays mount latency for chunks it'll never touch, then misses on the ones it needs. Widening the recording to cover more startup paths is possible, and every path you add grows the manifest and the prefetch. Push that far enough and you've reinvented downloading the image, at which point Part 1's whole premise was wrong.

The shared cache's weakness is coupling, and that's what you buy when you point twenty Pods at one file. A corrupt cache file, a full disk, or an eviction at an unlucky moment reaches all of them at once. The header digest in the key rules out the genuinely bad case, where two volumes read each other's data through mismatched mappings. Everything else is bounded rather than prevented. Watermarks keep the disk from filling, and the state file only ever records whole chunks, so a torn write never gets trusted.

Both changes rest on Part 1's immutable read side, and neither needed a protocol to coordinate because immutable bytes don't need one. A chunk fetched for one Pod is valid for another, and a page-cache recording made at build time is still valid at mount time on a different machine a week later.

The number that would tell us where to stop is the one nobody has measured. A hot set recorded from `git status` prefetches for `git status`, and widening the recording grows the manifest and the mount together. Until somebody puts a number on what a large hot set costs at mount time, there's no threshold to widen up to.
