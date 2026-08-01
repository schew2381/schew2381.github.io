---
title: "(Part 1) How E2B's Block Storage Layer Works"
date: 2026-07-31 09:00:00 -0700
categories: [storage, internals]
tags: [e2b, firecracker, nbd, block-storage, s3, copy-on-write]
---

> A four-part series on lazy block storage and how it becomes a Kubernetes CSI driver:
> 1. How E2B's block storage layer works (this post)
> 2. [The Kubernetes CSI interface](/posts/kubernetes-csi-interface/)
> 3. [Adapting E2B block storage into a CSI driver](/posts/sandbox-blockstore-csi-driver/)
> 4. [Node caches and startup hot sets](/posts/sandbox-blockstore-performance/)
{: .prompt-info }

[E2B](https://github.com/e2b-dev/infra) boots Firecracker microVMs whose root filesystem and guest memory live in object storage as multi-gigabyte files, and it never downloads either one. It presents them as block devices and fetches 4 MiB pieces on the first read that touches each piece.

That choice, plus a mapping format that lets any block come from any past build, is the whole storage layer. Everything below is built out of five pieces: a header, a per-build data file, a chunker, an mmap'd sparse cache, and a copy-on-write overlay.

## The problem

A sandbox has to be usable in about a second, and its rootfs is a few gigabytes of ext4 with a few gigabytes more of guest memory snapshot behind it. Copying either one out of S3 before boot costs tens of seconds at best.

Almost none of that data gets read. A process starts, touches its binary, some libraries, and a handful of files, then idles, so the read set is a small fraction of the image.

So E2B inverts the transfer: give the kernel a device that looks complete, and pay for bytes only when something reads them.

## Overview

```text
Firecracker microVM
│
├─ guest memory ──> UFFD handler ──┐
│                                  │
└─ /dev/nbd0 ─────> NBD dispatch ──┤
                                   │
                                   ▼
                             block.Overlay
                  ┌────────────────┴────────────────┐
                  ▼                                 ▼
        ┌───────────────────┐           ┌───────────────────────┐
        │ write cache       │           │ read device           │
        │ mmap'd sparse     │           │ chunker + build.File  │
        │ + dirty bitmap    │           │ read-only             │
        └───────────────────┘           └───────────┬───────────┘
                                                    │
                                                    ▼
                                        ┌───────────────────────┐
                                        │ header mapping        │
                                        │ offset -> build UUID  │
                                        └───────────┬───────────┘
                                                    │
                                                    ▼
                                        ┌───────────────────────┐
                                        │ object storage        │
                                        └───────────────────────┘
```
the read side is shared and immutable, the write side is private per sandbox

Reads walk down the right-hand branch until they hit something that already has the bytes. Writes never go past the overlay.

## A build in object storage

Every build gets a UUID and a prefix. The data file holds only the blocks that build actually contains, packed back to back with no holes.

```text
s3://templates/<build-id>/
    rootfs.ext4          packed rootfs blocks for this build
    rootfs.ext4.header   metadata plus the block mapping
    memfile              packed guest-memory chunks
    memfile.header       metadata plus the block mapping
    snapfile             Firecracker VM state
```

The base template's data file is the full image. A snapshot's data file holds only the blocks that sandbox dirtied, so it's usually a few megabytes.

## The header is a virtual address space

The header is what makes a sparse data file readable as a whole image. It has a fixed 64-byte metadata record and then an array of 40-byte mapping entries, all little-endian.

```text
rootfs.ext4.header

┌──────────────────────────────────────────┐
│ Metadata (64 bytes)                      │
│   Version  BlockSize  Size  Generation   │
│   BuildID  BaseBuildID                   │
├──────────────────────────────────────────┤
│ BuildMap[0] (40 bytes)                   │
│ BuildMap[1]                              │
│ ...                                      │
│ BuildMap[n]                              │
└──────────────────────────────────────────┘
```

Each entry says "this run of the virtual image lives in that build's data file at that offset":

```go
type BuildMap struct {
	// Offset defines which block of the current layer this mapping starts at
	Offset             uint64
	Length             uint64
	BuildId            uuid.UUID
	BuildStorageOffset uint64
}
```
[mapping.go:14](https://github.com/e2b-dev/infra/blob/8d918e2eee45af1911a1eb22508b75a70d9d603b/packages/shared/pkg/storage/header/mapping.go#L14)

`Offset` is a virtual offset in the image the guest sees. `BuildStorageOffset` is a physical offset inside `BuildId`'s packed data file. Entries are sorted by `Offset` and together they cover the whole image with no gaps.

Resolving an address is a binary search:

```go
i := sort.Search(len(t.Mapping), func(i int) bool {
	return int64(t.Mapping[i].Offset) > offset
})

mapping := &t.Mapping[i-1]
shift := offset - int64(mapping.Offset)
```
[header.go:96](https://github.com/e2b-dev/infra/blob/8d918e2eee45af1911a1eb22508b75a70d9d603b/packages/shared/pkg/storage/header/header.go#L96)

`GetShiftedMapping` wraps that and returns three things: the physical offset (`BuildStorageOffset + shift`), how many bytes remain in this mapping (`Length - shift`), and which build to read from. The remaining length matters, because a caller reading 64 KiB across a mapping boundary has to stop at the boundary and resolve again.

A build ID of `uuid.Nil` is a sentinel for "this range is all zeros." No object exists for it, so the reader skips ahead and leaves the buffer untouched.

Blocks are 4 KiB for a rootfs and 2 MiB for guest memory, since the latter is backed by hugepages:

```go
const (
	PageSize        = 4 << 10 // 4 KiB
	HugepageSize    = 2 << 20 // 2 MiB
	RootfsBlockSize = 4 << 10 // 4 KiB
)
```
[diff.go:10](https://github.com/e2b-dev/infra/blob/8d918e2eee45af1911a1eb22508b75a70d9d603b/packages/shared/pkg/storage/header/diff.go#L10)

## Diff chains

Snapshotting a sandbox writes out only its dirty blocks under a fresh build ID, then writes a new header whose mapping points at the old builds for everything untouched. Nothing is rewritten and nothing is copied.

```text
block:     0     1     2     3     4     5     6     7
        ┌─────┬─────┬─────┬─────┬─────┬─────┬─────┬─────┐
        │base │base │base │  a  │base │  b  │base │  b  │
        └─────┴─────┴─────┴─────┴─────┴─────┴─────┴─────┘
           ▲                 ▲           ▲
           │                 │           │
         base             diff-a      diff-b
```
generation 2's mapping after two snapshots, one data file per build ID

Reading block 3 opens `diff-a`'s data file, block 5 opens `diff-b`'s, everything else opens the base template. The image the guest sees is a view assembled from three objects.

Building that view is `MergeMappings`, which walks a sorted base mapping and a sorted diff mapping together and handles six overlap cases. The one that does real work is a diff landing strictly inside a base entry, which splits the base in two:

```text
base    [ ---------------- X ---------------- ]
diff               [ -- Y -- ]
result  [ -- X -- ][ -- Y -- ][ ----- X ----- ]
```

The left piece keeps the base's `BuildStorageOffset`. The right piece shifts its offset forward by the length consumed, so it still points at the right bytes inside X's packed file. Get that arithmetic wrong and reads silently return the wrong data.

`NormalizeMappings` then joins adjacent entries that share a build ID, which keeps the mapping array from growing linearly with the number of snapshots. E2B gates part of its validation on `Metadata.Version >= NormalizeFixVersion` (3) so headers written before a normalization bug fix warn instead of failing.

Each snapshot bumps `Generation` and sets a new `BuildID` while keeping `BaseBuildID`, so a header carries both its own identity and the root of its chain.

## The chunker

`build.File` resolves offsets to builds, but it reads exactly what it's asked for. A 4 KiB block miss would become a 4 KiB range request. Serving an ext4 mount that way means one HTTP round trip per block, which is unusable.

The chunker sits above it and works in 4 MiB units:

```go
// MemoryChunkSize must always be bigger or equal to the block size.
MemoryChunkSize = 4 * 1024 * 1024 // 4 MB
```
[storage.go:43](https://github.com/e2b-dev/infra/blob/8d918e2eee45af1911a1eb22508b75a70d9d603b/packages/shared/pkg/storage/storage.go#L43)

E2B ships two implementations behind a `chunker-config` feature flag with a `useStreaming` key. Both fetch 4 MiB at a time, and both write straight into the cache's mmap so the bytes are never copied twice.

`FullFetchChunker` uses a `singleflight.Group` keyed by chunk offset. Concurrent readers of the same chunk collapse into one fetch, and every waiter blocks until all 4 MiB have landed.

`StreamingChunker` unblocks readers as data arrives. Each chunk gets a `fetchSession` holding a list of waiters sorted by the byte offset they need, plus an atomic `bytesReady` counter:

```text
one 4 MiB chunk fetch

  bytesReady ─────────────>
  ┌────────────────────────┬───────────────────────────┐
  │ written to mmap        │ not fetched yet           │
  └────────────────────────┴───────────────────────────┘
        ▲         ▲                ▲
        │         │                │
    waiter A  waiter B         waiter C
    released  released       still blocked
```

The fetch loop reads in batches of `max(blockSize, 16 KiB)`, advances `bytesReady` at block granularity, and pops satisfied waiters off the front of the sorted list. A reader that needs the first block of a chunk returns after roughly 16 KiB have arrived rather than after 4 MiB.

Two details keep this from breaking under load:

- The fetch goroutine runs on `context.WithoutCancel(ctx)`, so the first caller giving up doesn't abort a fetch that other waiters depend on.
- `runFetch` marks the chunk cached *before* deleting its session from `fetchMap`, which closes the window where a late caller sees neither an in-flight session nor a cached chunk.

## The cache

`block.Cache` is one sparse file per device, truncated to the full image size and then mmap'd:

```go
cache, err := NewCache(size, blockSize, cachePath, false)
```
[cache.go:61](https://github.com/e2b-dev/infra/blob/8d918e2eee45af1911a1eb22508b75a70d9d603b/packages/orchestrator/pkg/sandbox/block/cache.go#L61)

The file's logical size is the image size, while its physical size is whatever the filesystem has actually allocated, which is why `FileSize` reports `stat.Blocks * fsStat.Bsize` rather than the stat size.

Alongside the mapping is a dirty bitmap, one bit per block. `setIsCached` sets a range, `isCached` tests it, and `Slice` returns a `BytesNotAvailableError` when the requested range isn't fully set. That one bitmap serves two jobs: on the read side it means "already fetched," and on the write side it means "modified relative to the parent build."

`addressBytes` hands out a slice of the mmap plus a closure that releases a read lock. The chunker fetches directly into that slice, so an S3 body is written once into a page that's already the cache.

## Copy-on-write

`block.Overlay` is the piece that makes an immutable read device writable:

```go
type Overlay struct {
	device       ReadonlyDevice
	cache        *Cache
	cacheEjected atomic.Bool
	blockSize    int64
}
```
[overlay.go:12](https://github.com/e2b-dev/infra/blob/8d918e2eee45af1911a1eb22508b75a70d9d603b/packages/orchestrator/pkg/sandbox/block/overlay.go#L12)

`ReadAt` splits the request into blocks and, per block, tries the private cache first. A `BytesNotAvailableError` falls through to the read device. `WriteAt` only ever touches the cache.

```text
read  block 3 ──> write cache dirty?  ──yes──> serve from write cache
                        │
                        no
                        ▼
                  read device (chunker) ──> object storage

write block 3 ──> write cache only, mark dirty
```

The read device stays byte-identical to what's in object storage for the whole life of the sandbox. Two sandboxes on the same template can therefore point at the same read device and diverge only in their private caches.

`EjectCache` uses a compare-and-swap on `cacheEjected` to hand the write cache to the snapshot path exactly once. After that the overlay refuses I/O and `Close` becomes a no-op, so teardown can't race with a diff export.

## The two consumers

For the rootfs, the overlay is served over NBD. `NewNBDProvider` builds the cache, wraps the read device in an overlay, and hands the result to a direct-path mount that speaks the NBD protocol over Unix sockets to `/dev/nbdN`. Firecracker gets a block device, the kernel does normal block I/O, and every miss becomes a chunk fetch.

For guest memory, the overlay is served over userfaultfd instead. Firecracker maps the memory file, the UFFD handler catches page faults, and `Prefault` writes the resolved bytes into the guest's address space. Same storage stack, different fault mechanism, which is why guest memory uses 2 MiB blocks and the rootfs uses 4 KiB.

## Snapshotting

Exporting a diff is where the dirty bitmap pays off:

1. `EjectCache` takes the write cache out of the overlay.
2. The sandbox is destroyed and in-flight operations drain.
3. `SyncFileRange` pushes the mmap's dirty pages to the filesystem.
4. `ExportToDiff` walks the bitmap's set ranges and copies each one into the output file with `copy_file_range`, which becomes a reflink on XFS. On `EXDEV`, `EOPNOTSUPP`, or `ENOSYS` it falls back to `io.Copy`.
5. `ToDiffHeader` turns the bitmap into `BuildMap` entries, merges them over the parent's mapping, normalizes, and bumps the generation.

Blocks that are entirely zeros get their own mapping with `uuid.Nil` as the build ID, so a sandbox that zeroed a gigabyte of scratch space uploads nothing for it.

## Trade-offs

| | Lazy block fetch | Download the image first |
|---|---|---|
| Time to first read | Milliseconds, one chunk | Tens of seconds, whole image |
| Bytes transferred | Only what's read | Everything |
| Steady-state read latency | Cache hit, or one S3 round trip | Local disk |
| Failure mode | Object storage outage stalls live I/O | Fails before boot |
| Snapshot cost | Dirty blocks only | Full image copy |

The costs are real. A cache miss on the critical path is an S3 round trip that the guest kernel sees as block-device latency, and it can happen at any point in a sandbox's life rather than only at startup. Header chains grow with every snapshot, so a long-lived sandbox accumulates mapping entries and its reads fan out across more objects. Long chains eventually need a rebase pass that flattens them back into a single object.

The design also assumes the read side never changes. That assumption is what the next two posts build on: it's what lets a single fetched chunk be reused by an unrelated workload, and it's what makes the whole thing fit behind a Kubernetes volume interface. That interface is [Part 2](/posts/kubernetes-csi-interface/).
