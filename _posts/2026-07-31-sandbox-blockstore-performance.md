---
title: "(Part 4) Node Caches and Startup Hot Sets"
date: 2026-07-31 12:00:00 -0700
categories: [kubernetes, storage, performance]
tags: [csi, performance, caching, prefetch, s3, mincore]
---

> A four-part series on lazy block storage and how it becomes a Kubernetes CSI driver:
> 1. [How E2B's block storage works](/posts/e2b-block-storage-layer/)
> 2. [The Kubernetes CSI interface](/posts/kubernetes-csi-interface/)
> 3. [Adapting E2B block storage into a CSI driver](/posts/sandbox-blockstore-csi-driver/)
> 4. Node caches and startup hot sets (this post)
{: .prompt-info }

Lazy block fetch makes a mount instant and moves the cost to the first read. Two changes to sandbox-blockstore went after that cost from opposite directions: share the fetched bytes between Pods on a node, and fetch the right bytes before anyone asks.

The second one started from a warm-pool Pod that Kubernetes reported as `Ready` and on which the first `git status` took 59.3 seconds.

## Where the time actually went

A warm-pool Pod passes its readiness probe once the volume is mounted and the container is up, which takes well under a second because the mount is only a header read. Nothing in that readiness signal knows whether a single byte of file content is on the node.

So the Pod sat there `Ready`, and then a real request arrived:

```text
git status over 62,115 index entries

  stat + read each path ──> ext4 ──> /dev/nbd7 ──> chunker
                                                      │
                                                      │  every chunk a miss
                                                      ▼
                                                 S3 range GET
```

The read pattern is thousands of small reads scattered across the image, and every one that lands in an unfetched chunk blocks on a round trip. `Ready` was true and the Pod was useless for a minute.

## Change one: share the cache across Pods

[PR #52](https://github.com/Greenbax/sandbox-blockstore/pull/52) added the node-shared read cache whose mechanics are in Part 3. What's left is what it bought.

The premise is that the read side stays byte-identical to S3 for a volume's whole life, so N Pods on one template can point at one cache file:

```text
  before                                after

  Pod A ──> cache A ──> S3              Pod A ──┐
  Pod B ──> cache B ──> S3              Pod B ──┼──> shared cache ──> S3
  Pod C ──> cache C ──> S3              Pod C ──┘

  3 copies, 3x the GETs                 1 copy, only the first Pod pays
```

The second Pod on a template reads from local disk what the first Pod paid an S3 round trip for. Measured across a full development environment startup, empty node cache against populated:

| Phase | Empty | Populated | Saved | Improvement |
|---|---|---|---|---|
| Mount sentinel wait | 1.182s | 0.010s | 1.172s | 99.15% |
| Plugins and services start concurrently | 30.516s | 20.479s | 10.037s | 32.89% |
| Remaining service wait | 17.481s | 8.796s | 8.685s | 49.68% |
| Final dev sync | 2.726s | 1.265s | 1.461s | 53.59% |
| **Total startup** | **52.009s** | **30.651s** | **21.358s** | **41.07%** |

The phases, in order:

1. Mount sentinel wait blocks until the CSI-mounted codebase is readable.
2. Plugins and services install Claude plugins while PostgreSQL, Redis, and OpenSearch start.
3. Remaining service wait is mostly PostgreSQL and OpenSearch finishing.
4. Final dev sync rechecks the toolchain, dependencies, generated files, and the step cache.

The sentinel wait dropping from 1.182s to 0.010s is the shape of the whole result. That phase is pure first-read latency, and with the chunks already local there's nothing left to wait for.

Nothing about the workload changed between the two columns. The same bytes get read in the same order, and 21 seconds of it was one Pod refetching what another Pod on the same node already had.

It shipped default-off behind `--shared-read-cache`, which is the right call for a change that introduces cross-Pod sharing of an mmap'd file.

## Change two: fetch the startup set before the Pod is Ready

Sharing helps the second Pod. The first one still pays, and on a fresh node every Pod is the first one.

[PR #56](https://github.com/Greenbax/sandbox-blockstore/pull/56) went at it from the other side. The set of chunks that `git status` touches is a property of the template rather than of the Pod, so it can be recorded once at build time and fetched during the mount.

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

The recording pass runs in `template-builder` under `--record-startup-hotset`. It measures which parts of the *backing file* a workload touched by reading the kernel's own page-cache accounting, which means the answer comes from the same layer that will later serve the chunks.

```text
1. cp -a the source tree into the image through a loop mount
2. optionally refresh the git index so status doesn't rehash everything
3. syncfs, close the loop device
4. fsync + posix_fadvise(FADV_DONTNEED) the backing file
5. reopen the loop mount, run git status
6. mincore(2) the backing file's mapping
7. resident pages ──> deduplicated 4 MiB chunk offsets
```

Two details make the measurement valid.

The loop device has to be opened with `losetup --direct-io=off`, because direct I/O bypasses the page cache and leaves `mincore` reporting nothing. Buffered I/O is what makes the page cache reflect what the workload actually read.

The eviction in step 4 has to actually land. `prepareColdBackingFile` retries three times and hard-errors if pages stay resident, since a half-cold file produces a hot set missing whatever was still cached. An empty hot set is a hard error too, rather than a manifest with no offsets in it.

`residentPagesToOffsets` maps resident 4 KiB pages to chunk offsets, requires that the chunk size be a multiple of the page size, validates the page count against the mapping length, and deduplicates. The manifest is small: a set of 4 MiB offsets, not a list of pages.

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
[startup_hotset.go:15](https://github.com/Greenbax/sandbox-blockstore/blob/2dc807753ae83288019936ac5740d60586a4778d/pkg/storage/startup_hotset.go#L15)

`ParseStartupHotset` cross-checks the build ID, the header digest, and the image size against the header the driver just read. A manifest recorded against a different build of the same template is rejected rather than used to prefetch offsets that mean something else.

### Prefetching it

At mount time, `prefetchStartupHotset` runs between building the read device and building the write overlay, so it finishes before the NBD device exists and before anything can read.

`PrefetchStartupOffsets` refuses to run once the chunker has started serving, since prefetching alongside demand reads means competing for the same S3 connections against a reader that's blocking a real process.

Ranges get planned before any fetch:

```text
hot set offsets (4 MiB chunks, sorted)

  0  4  8          20 24 28 32         48
  ■  ■  ■          ■  ■  ■  ■          ■

coalesced into ranges, capped at maxRangeBytes

  [0..12)          [20..36)            [48..52)
  one GET          one GET             one GET
```

`prefetchRanges` sorts and compacts the offsets, skips chunks already cached (which is the common case on a warm node with a populated shared cache), and coalesces adjacent chunks up to `maxRangeBytes`. Concurrency is a weighted semaphore where each range's weight is its chunk count, so the in-flight byte total is bounded rather than the request count:

```go
effectiveMaxRangeBytes := min(maxRangeBytes, int64(concurrency)*storage.MemoryChunkSize)
```

Production runs 16 permits with a 4 MiB range cap, so 64 MiB in flight. The plan is logged before it executes, which means a slow prefetch is diagnosable from the log rather than by guessing.

Every fetched chunk goes through `commitChunk`, so a prefetch on a shared cache persists into the state file and survives a daemon restart. Prefetch is also single-flighted per device: a second volume mounting the same template while a prefetch is in flight waits for it and reports `Reused` rather than starting its own.

### The request-count effect

The 512 KiB read batch from Part 3 unblocks readers early, which is good for latency and bad for request count when the whole chunk is going to be read anyway:

```text
before  demand-read one 4 MiB chunk
        ~8 x 512 KiB GetObject

now     prefetch one 4 MiB chunk
        1 x 4 MiB GetObject
```

The prefetch path knows up front that it wants the entire chunk, so it opens one range reader and fills each chunk with `io.ReadFull`. Eight round trips become one, and the bytes land before anything needs them.

### Numbers

From the PR:

| Scenario | Before | After | Improvement |
|---|---|---|---|
| Mount plus first `git status` | 9.80s | 6.97s | 28.9% |
| Warm-pod Git preparation | 11.48s | 7.01s | 39.0% |
| Ordinary demand read | 10.94s | 9.18s | 16.1% |
| Ready-Pod Claude first turn | 56.8s | 4.9-7.2s | 87-91% |

The last row is what motivated the work. A Pod that Kubernetes called `Ready` took 56.8 seconds to answer its first request and now takes 5 to 7.

The ordinary demand read improving by 16% is a side effect. Those reads aren't in the hot set, and they still benefit from the larger effective range size and from chunks the prefetch happened to cover on its way to something else.

The PR is explicit about what it didn't measure, which is worth copying as a habit. There are no numbers for a cold node with no shared cache, for the aggregate S3 request-count reduction, or for what the prefetch costs mount latency when the hot set is large.

Rollout was three ordered steps: the driver change, then the environment enabling the manifest, then the node config raising concurrency to 16 permits with a 4 MiB cap and the daemon memory limit to 10 GiB. Shipping all three together would have meant a regression with three candidate causes.

## How the two changes compose

They cover different cases, and neither one subsumes the other.

```text
                              cold node             warm node
                              (empty cache)         (populated cache)

first Pod on a template       prefetch pays the     prefetch mostly skips,
                              S3 cost up front      chunks already cached

later Pods on that template   shared cache hit      shared cache hit
```

The shared cache turns "every Pod pays" into "the first Pod pays." The hot set moves what the first Pod pays out of the critical path and into the mount. On a warm node the prefetch finds most chunks already cached and does almost nothing, which is the case where the shared cache has already won.

The startup hot set also has a second-order effect on the shared cache: it populates it in a predictable order, so the first Pod on a node warms exactly the chunks the next Pod is going to need rather than whatever its own workload happened to touch.

## Trade-offs

| | Node-shared read cache | Startup hot set prefetch |
|---|---|---|
| Helps | Every Pod after the first | The first Pod, and cold nodes |
| Cost | Cross-Pod coupling on one mmap'd file | Longer mount, wasted GETs if wrong |
| Staleness risk | Key includes the header digest | Manifest validated against the header |
| Failure mode | Cache miss, refetch | Prefetch skipped, demand reads as before |
| Tuning | Watermarks and idle TTL | Concurrency and range cap |

The hot set's real weakness is that it's a recording of one workload. It was recorded from `git status`, so it prefetches what `git status` reads. A Pod whose first action is something else pays for chunks it doesn't need and still misses on the ones it does. Widening the recording to cover more startup paths grows the manifest and the prefetch time, and at some point prefetching the whole image is cheaper than being clever about which part.

The shared cache's weakness is coupling. One mmap'd file behind N Pods means a corrupt cache file, a full disk, or an eviction at the wrong moment affects all of them. The key's header digest rules out the worst case (two volumes reading each other's data through mismatched mappings), and the rest is contained by watermarks and by the state file's whole-chunk-only rule.

Both changes rest on one property from Part 1: the read side never changes. That's what makes a chunk fetched for one Pod valid for another, what makes a page-cache recording from build time valid at mount time, and what makes a cache file safe to hand to a process that has no idea another one already filled it.
