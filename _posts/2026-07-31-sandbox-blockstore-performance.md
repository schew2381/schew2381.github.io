---
title: "(sandbox-blockstore Pt. 4) Optimizing startup performance"
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

A Pod in the warm pool passed its readiness probe, sat there reporting `Ready`, and then took 59.3 seconds to answer its first `git status`.

Nothing was broken. That's the part worth sitting with. Lazy block fetch works exactly as designed, and what it does is move the cost out of the mount and into the first read, which is great right up until the first read is the one a user is waiting on.

Two changes went after that cost from opposite ends. One shares fetched bytes between Pods on a node, so the second Pod doesn't repay what the first one already paid. The other fetches the right bytes before anybody asks for them. Neither one subsumes the other, and the reason is more interesting than either change.

## Where the time actually went

Readiness is the trap. A warm-pool Pod passes its probe once the volume is mounted and the container is up, and Part 3's mount is a header read plus some local setup, so that happens in well under a second. Nothing in that signal has any opinion about whether a single byte of file content is on the node, because from kubelet's point of view the volume is mounted and the filesystem is there.

Then a real request arrives:

```text
git status over 62,115 index entries

  stat + read each path ──> ext4 ──> /dev/nbd7 ──> chunker
                                                      │
                                                      │  every chunk a miss
                                                      ▼
                                                 S3 range GET
```

62,115 index entries, each one a `stat` and often a read, scattered across an 8 GiB image with no locality worth speaking of. Every read landing in an unfetched chunk blocks on a round trip to object storage. So `Ready` was true, the health checks were green, and the Pod was useless for a minute.

## Change one: share the cache across Pods

The first change is the node-shared read cache. Part 3 covers its mechanics, so what's left is what it bought.

The premise is that the read side stays byte-identical to S3 for a volume's whole life, so N Pods on one template can point at one cache file:

```text
  before                                after

  Pod A ──> cache A ──> S3              Pod A ──┐
  Pod B ──> cache B ──> S3              Pod B ──┼──> shared cache ──> S3
  Pod C ──> cache C ──> S3              Pod C ──┘

  3 copies, 3x the GETs                 1 copy, only the first Pod pays
```

Which means the second Pod on a template reads from local disk what the first Pod paid a round trip for. Here's a full development environment startup measured twice, once on an empty node cache and once on a populated one:

| Phase | Empty | Populated | Saved | Improvement |
|---|---|---|---|---|
| Mount sentinel wait | 1.182s | 0.010s | 1.172s | 99.15% |
| Plugins and services start concurrently | 30.516s | 20.479s | 10.037s | 32.89% |
| Remaining service wait | 17.481s | 8.796s | 8.685s | 49.68% |
| Final dev sync | 2.726s | 1.265s | 1.461s | 53.59% |
| **Total startup** | **52.009s** | **30.651s** | **21.358s** | **41.07%** |

Those phases, in order, are the sentinel wait blocking until the CSI-mounted codebase is readable, then a concurrent stretch installing Claude plugins while PostgreSQL, Redis, and OpenSearch come up, then whatever's left of PostgreSQL and OpenSearch finishing, then a final sync rechecking the toolchain, dependencies, generated files, and the step cache.

The sentinel wait is the row that explains the rest. It goes from 1.182s to 0.010s, because that phase is nothing but first-read latency and there's no first read left to pay for. Every other row is the same effect diluted by however much real CPU work that phase also happens to do.

Nothing about the workload changed between the two columns. Same bytes, same order, same everything. 21 of those 52 seconds were one Pod refetching what another Pod on the same machine already had sitting on local disk.

It shipped default-off behind `--shared-read-cache`, which was the right call. Cross-Pod sharing of an mmap'd file is exactly the kind of change where the failure mode is subtle and the blast radius is every Pod on the node.

## Change two: fetch the startup set before the Pod is Ready

Sharing fixes the second Pod. The first one still pays in full, and on a freshly scaled-up node every Pod is the first one, which is also precisely when a burst of Pods is arriving.

The second change comes at it from the other side, and it starts from noticing who the read set actually belongs to. What `git status` touches isn't a fact about this Pod or this request. It's a fact about the template's contents, fixed at build time, identical for every Pod that ever boots from it. So record it once, and prefetch it during the mount:

```text
phase 1  at template build time
  ┌────────────────────────────────────────────────────────┐
  │ 1. populate the image, refresh the git index           │
  │ 2. evict the backing file from the page cache          │
  │ 3. run git status through a buffered loop mount        │
  │ 4. mincore(2) the backing file for resident pages      │
  │ 5. map pages to 4 MiB chunk offsets, write a manifest  │
  └────────────────────────────────────────────────────────┘
                               │
                               ▼
       s3://…/<build>/rootfs.ext4.startup-hotset.v1.json

phase 2  at mount time on a warm node
  ┌────────────────────────────────────────────────────────┐
  │ 1. read the manifest, validate against the header      │
  │ 2. coalesce offsets into contiguous ranges             │
  │ 3. prefetch with bounded concurrency, before serving   │
  └────────────────────────────────────────────────────────┘
```

### Recording it

The obvious way to record a read set is to trace the workload: `strace`, or an eBPF probe on `read`, or instrumenting the chunker itself. All of those tell you which file offsets the application asked for, which is not the question. The question is which 4 MiB chunks of the backing file the driver will have to fetch, and getting from one to the other means reimplementing ext4's block allocation in your head.

So the recording pass in `template-builder`, under `--record-startup-hotset`, asks the kernel instead. Run the workload through a loop mount and then ask the page cache which pages of the backing file are resident. Whatever it says is, by construction, exactly what the read path touched.

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

The loop device has to be opened with `losetup --direct-io=off`. Direct I/O skips the page cache entirely, so `mincore` sees nothing resident and the recording pass cheerfully produces an empty hot set from a workload that read half the image. Buffered I/O is what makes the page cache a record of anything at all.

Step 4's eviction has to actually land, which sounds like a formality and isn't. `prepareColdBackingFile` retries three times and hard-errors if pages stay resident, because a file that's still half warm produces a hot set missing precisely the chunks that were already cached, which are usually the important ones. An empty result is a hard error too. Better to fail the build than to publish a manifest that prefetches nothing and looks like it's working.

`residentPagesToOffsets` does the arithmetic from resident 4 KiB pages to 4 MiB chunk offsets, and it's defensive about it: chunk size has to be a multiple of page size, the page count has to match the mapping length, and offsets get deduplicated. The output is small, a set of chunk offsets rather than a list of pages, which is why the manifest stays a few kilobytes on a multi-gigabyte image.

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

Three of those six fields exist only to catch a mismatch. `ParseStartupHotset` checks the build ID, the header digest, and the image size against the header the driver just read, and rejects the manifest if any of them disagree. Same reasoning as the shared cache key from Part 3: a manifest recorded against a different build of the same template contains offsets that mean something else now, and prefetching them wastes GETs on chunks nobody wants.

### Prefetching it

Where the prefetch sits in the mount matters more than how it works. `prefetchStartupHotset` runs as phase 5 of Part 3's eight, between building the read device and building the write overlay, which means it finishes before the NBD device exists. There's no window in which the Pod can read and no window in which a demand read can arrive, because the block device the demand read would come through hasn't been created yet.

`PrefetchStartupOffsets` enforces that directly, refusing to run at all once the chunker has started serving. Otherwise a prefetch competes for S3 connections against a reader that has a real process blocked on it, and losing that race to your own optimization is a bad way to spend an afternoon.

Planning happens before any fetch goes out:

```text
hot set offsets (4 MiB chunks, sorted)

  0  4  8          20 24 28 32         48
  ■  ■  ■          ■  ■  ■  ■          ■

coalesced into ranges, capped at maxRangeBytes

  [0..12)          [20..36)            [48..52)
  one GET          one GET             one GET
```

`prefetchRanges` sorts and compacts the offsets, drops anything already cached, and coalesces what's left into contiguous ranges up to `maxRangeBytes`. That skip step is where the two changes meet: on a warm node with a populated shared cache, most of the hot set is already there and the prefetch turns into almost nothing.

Concurrency is a weighted semaphore with each range's weight being its chunk count, which bounds bytes in flight rather than requests in flight:

```go
effectiveMaxRangeBytes := min(maxRangeBytes, int64(concurrency)*storage.MemoryChunkSize)
```

Bounding requests would let 16 permits mean 16 MiB or 16 GiB depending on how well the offsets happened to coalesce. Production runs 16 permits against a 4 MiB range cap, so 64 MiB in flight, and the plan gets logged before it executes so a slow prefetch is a log line rather than a mystery.

Two smaller behaviors make it compose with Part 3. Prefetched chunks go through `commitChunk` like any other, so they land in the state file and survive a daemon restart. And prefetch is single-flighted per device, so a second volume mounting the same template mid-prefetch waits on the one already running and reports `Reused` instead of starting a duplicate.

### Where the 512 KiB batch backfires

Part 3 raised the read batch to 512 KiB to unblock waiting readers sooner. That's the right trade when a reader is blocked. It's the wrong trade when nobody is:

```text
before  demand-read one 4 MiB chunk
        ~8 x 512 KiB GetObject

now     prefetch one 4 MiB chunk
        1 x 4 MiB GetObject
```

A demand read doesn't know how much of the chunk anyone will want, so batching in 512 KiB pieces is the only way to release readers early. A prefetch knows it wants the whole chunk, because that's what a hot set entry means, so it opens one range reader and fills the chunk with `io.ReadFull`. Eight round trips collapse into one, and this is the case where knowing the future is worth more than reacting quickly to the present.

### Numbers

| Scenario | Before | After | Improvement |
|---|---|---|---|
| Mount plus first `git status` | 9.80s | 6.97s | 28.9% |
| Warm-pod Git preparation | 11.48s | 7.01s | 39.0% |
| Ordinary demand read | 10.94s | 9.18s | 16.1% |
| Ready-Pod Claude first turn | 56.8s | 4.9-7.2s | 87-91% |

The last row is the one the work was for. 56.8 seconds down to 5 to 7, on a Pod that Kubernetes had already been calling `Ready` the whole time.

Row three is a freebie nobody designed for. Ordinary demand reads aren't in the hot set at all, and they still got 16% faster, partly from the larger effective range size and partly from chunks the prefetch swept up on its way to something adjacent.

What's missing from that table is worth saying out loud. There are no numbers for a cold node with no shared cache, none for the aggregate reduction in S3 requests, and none for what the prefetch costs mount latency once a hot set gets large. The last gap is the uncomfortable one, since it's the failure mode the change most plausibly has.

Rollout went in three ordered steps: the driver change, then the environment enabling the manifest, then the node config raising concurrency to 16 permits with the 4 MiB cap and lifting the daemon memory limit to 10 GiB. Shipping all three at once would have meant any regression had three candidate causes and no way to bisect between them.

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

There's a second-order effect that only shows up when both are on. The prefetch populates the shared cache in a predictable order, so the first Pod on a node warms exactly the chunks the next Pod will want, rather than whatever its own particular workload wandered into. The shared cache gets better at its job because something else decided what to put in it.

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

Both changes rest on the same property from Part 1, which is that the read side never changes. That's what makes a chunk fetched for one Pod valid for another, what makes a page-cache recording from build time still valid at mount time on a different machine a week later, and what makes it safe to hand a cache file to a process that has no idea some other process already filled it. Everything in this series is downstream of one immutable read path, and the parts that were hard were all on the other side of the overlay.
