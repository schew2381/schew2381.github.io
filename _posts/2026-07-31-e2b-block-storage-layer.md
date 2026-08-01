---
title: "(Pt. 1) sandbox-blockstore: How E2B Block Storage Works"
date: 2026-07-31 09:00:00 -0700
categories: [storage, internals]
tags: [e2b, firecracker, nbd, block-storage, s3, copy-on-write]
---

> A four-part series on lazy block storage and how it becomes a Kubernetes CSI driver:
> 1. How E2B block storage works (this post)
> 2. [K8s CSI interface](/posts/kubernetes-csi-interface/)
> 3. [Adapting E2B block storage into a CSI driver](/posts/sandbox-blockstore-csi-driver/)
> 4. [Optimizing startup performance](/posts/sandbox-blockstore-performance/)
{: .prompt-info }

A sandbox is supposed to be ready in about a second. The root filesystem it boots from is a few gigabytes of ext4 sitting in S3, with a few gigabytes more of guest memory snapshot behind it, so the honest version of "start a sandbox" is "download eight gigabytes first." That's tens of seconds on a good day, and it happens before the user's code runs at all.

[E2B](https://github.com/e2b-dev/infra) doesn't download it. Not lazily, not in the background, not at all. It hands the kernel a block device that claims to be the full image, then fetches 4 MiB pieces the first time something actually reads them.

The reason that works is a detail about how sandboxes get used. A process starts, reads its own binary, pulls in a few libraries, opens a handful of config files, and then mostly idles. The read set is a small slice of the image, and paying for the other 95% up front buys nothing.

So the transfer gets inverted. Everything below is five pieces working together: a header that describes where bytes live, a per-build data file that holds them, a chunker that fetches in useful sizes, an mmap'd sparse cache that remembers what arrived, and a copy-on-write overlay that keeps writes from ever reaching S3.

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

The split down the middle is the load-bearing part. Writes stop at the overlay and never travel further, which means the entire right-hand branch stays byte-identical to what's in S3 for as long as the sandbox lives. Hold onto that, because two of the later posts are built on it.

## A build in object storage

The unit everything else refers to is a build: one UUID, one prefix in the bucket, five objects under it.

```text
s3://templates/<build-id>/
    rootfs.ext4          packed rootfs blocks for this build
    rootfs.ext4.header   metadata plus the block mapping
    memfile              packed guest-memory chunks
    memfile.header       metadata plus the block mapping
    snapfile             Firecracker VM state
```

Notice that the data file holds only the blocks this particular build contains, packed end to end with no gaps. For a base template that's the whole image. For a snapshot it's whatever the sandbox dirtied before someone paused it, which is usually a few megabytes against a multi-gigabyte parent.

Which raises the obvious problem. If `rootfs.ext4` for a snapshot contains 4 MiB of scattered blocks, how does anything read it as an 8 GiB filesystem?

## The header is a virtual address space

The header answers it. It's a fixed 64-byte metadata record followed by an array of 40-byte mapping entries, all little-endian, and it's the thing that turns a bag of packed blocks back into a filesystem.

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

Two offsets, and mixing them up is the classic way to corrupt an image. `Offset` is virtual, an address in the 8 GiB filesystem the guest thinks it has. `BuildStorageOffset` is physical, a byte position inside that build's packed data file. Entries are sorted by `Offset` and cover the image with no gaps, so any virtual address lands in exactly one entry.

Finding it is a binary search:

```go
i := sort.Search(len(t.Mapping), func(i int) bool {
	return int64(t.Mapping[i].Offset) > offset
})

mapping := &t.Mapping[i-1]
shift := offset - int64(mapping.Offset)
```
[header.go:96](https://github.com/e2b-dev/infra/blob/8d918e2eee45af1911a1eb22508b75a70d9d603b/packages/shared/pkg/storage/header/header.go#L96)

`GetShiftedMapping` wraps that and hands back the physical offset (`BuildStorageOffset + shift`), which build to read from, and how many bytes are left in this mapping (`Length - shift`).

That third return value is easy to ignore and expensive to ignore. A caller asking for 64 KiB has no guarantee those 64 KiB live in one entry, so it has to stop at the boundary, resolve again, and read the remainder from a different object. Every layer above this one loops.

One special case worth knowing about: a build ID of `uuid.Nil` means "this range is all zeros." There's no object to read, so the reader just skips ahead and leaves the buffer alone. A sandbox that zeroed a gigabyte of scratch space uploads nothing for it, and it comes back as zeros anyway.

Block size depends on what's being served. Guest memory is backed by hugepages, so it works in 2 MiB blocks, while a rootfs uses 4 KiB:

```go
const (
	PageSize        = 4 << 10 // 4 KiB
	HugepageSize    = 2 << 20 // 2 MiB
	RootfsBlockSize = 4 << 10 // 4 KiB
)
```
[diff.go:10](https://github.com/e2b-dev/infra/blob/8d918e2eee45af1911a1eb22508b75a70d9d603b/packages/shared/pkg/storage/header/diff.go#L10)

That's the whole format. A metadata record, a sorted array, and a binary search, which is a modest amount of machinery for turning a packed blob back into a filesystem. It buys something bigger than that, though.

## Diff chains

Nothing so far explains why a mapping entry carries a build ID at all. If every entry pointed at the same file, the field would be dead weight. It's there because a single header can assemble an image out of several builds at once, and that's what makes snapshots cheap.

Pausing a sandbox writes out only the blocks it dirtied, under a fresh build ID, then writes a new header that points back at the old builds for everything untouched. No rewriting, no copying, and the parent objects stay exactly as they were.

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

Reading block 3 opens `diff-a`'s data file, block 5 opens `diff-b`'s, and everything else comes from the base template. The guest sees one flat 8 GiB filesystem. It's actually a view stitched from three separate objects, and the guest has no idea.

Producing that flattened mapping is `MergeMappings`, which walks the sorted base and sorted diff together and handles six overlap cases. Five are bookkeeping. The interesting one is a diff landing strictly inside a base entry, because that splits the base in two:

```text
base    [ ---------------- X ---------------- ]
diff               [ -- Y -- ]
result  [ -- X -- ][ -- Y -- ][ ----- X ----- ]
```

The left piece keeps X's original `BuildStorageOffset`. The right piece has to shift its offset forward by however much Y consumed, or it points at the wrong bytes inside X's packed file. This is the arithmetic to get right, because getting it wrong doesn't throw an error. Reads just quietly return other data, which is a considerably worse outcome than a crash.

Left alone, a mapping array would grow with every snapshot until a long-lived sandbox carried thousands of entries. `NormalizeMappings` prevents that by joining adjacent entries that share a build ID. There's also a version gate here worth noticing: validation checks `Metadata.Version >= NormalizeFixVersion` (3), so headers written before a normalization bug got fixed produce a warning instead of a hard failure. Somebody shipped bad headers once and chose to keep reading them.

Each snapshot bumps `Generation`, sets a new `BuildID`, and keeps `BaseBuildID` pointing at the root, so a header knows both who it is and where its chain started.

## The chunker

`build.File` can now resolve any virtual offset to a build and a physical offset. Ask it for 4 KiB and it fetches exactly 4 KiB, which sounds efficient right up until you count the round trips. An ext4 mount reading a directory tree issues thousands of small reads, and one HTTP request per 4 KiB block is completely unusable.

So the chunker sits on top and refuses to think in blocks. It works in 4 MiB units:

```go
// MemoryChunkSize must always be bigger or equal to the block size.
MemoryChunkSize = 4 * 1024 * 1024 // 4 MB
```
[storage.go:43](https://github.com/e2b-dev/infra/blob/8d918e2eee45af1911a1eb22508b75a70d9d603b/packages/shared/pkg/storage/storage.go#L43)

There are two implementations, picked at runtime by a `chunker-config` feature flag with a `useStreaming` key. Both fetch 4 MiB at a time and both write straight into the cache's mmap, so an S3 response body never gets copied twice.

The simpler one, `FullFetchChunker`, uses a `singleflight.Group` keyed by chunk offset. Ten readers wanting the same chunk collapse into one fetch, which is the right call, but all ten then sit there until the full 4 MiB lands. A reader that only wanted the first 4 KiB waits for the other 4092.

`StreamingChunker` fixes that by releasing readers as their bytes arrive. Each chunk gets a `fetchSession` holding waiters sorted by the offset they need, plus an atomic `bytesReady` counter:

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

The fetch loop reads in batches of `max(blockSize, 16 KiB)`, advances `bytesReady` at block granularity, and pops satisfied waiters off the front of the list. So a reader waiting on the first block of a chunk gets released after about 16 KiB instead of 4 MiB, which on a cold `git status` is the difference between usable and not.

Two details in there are the kind that only show up under load:

- The fetch goroutine runs on `context.WithoutCancel(ctx)`. Without it, the first caller giving up would cancel a fetch that four other waiters are depending on.
- `runFetch` marks the chunk cached *before* deleting its session from `fetchMap`. Do it the other way around and there's a window where a late caller finds no in-flight session and no cached chunk, so it starts a redundant fetch for bytes that are already there.

## The cache

Everything above keeps saying "writes into the cache's mmap," so it's worth pinning down what that actually is. `block.Cache` is one sparse file per device, truncated to the full image size and mmap'd:

```go
cache, err := NewCache(size, blockSize, cachePath, false)
```
[cache.go:61](https://github.com/e2b-dev/infra/blob/8d918e2eee45af1911a1eb22508b75a70d9d603b/packages/orchestrator/pkg/sandbox/block/cache.go#L61)

Sparse matters here. The file claims to be 8 GiB and occupies whatever the filesystem has actually allocated, which for a fresh cache is nothing. That gap between claimed and real size is why `FileSize` reports `stat.Blocks * fsStat.Bsize` instead of trusting the stat size, and it comes back as a problem worth its own section in Part 3.

Next to the mapping is a bitmap, one bit per block. `setIsCached` sets a range, `isCached` tests it, and `Slice` returns `BytesNotAvailableError` when the range isn't fully set.

The same bitmap does double duty depending on which side of the overlay it's on. On a read cache, a set bit means "already fetched from S3." On a write cache, it means "modified relative to the parent build." One structure, two meanings, and the snapshot path leans entirely on the second one.

`addressBytes` hands out a slice of the mmap plus a closure that drops a read lock. The chunker fetches directly into that slice, so bytes go from the S3 socket into a page that's already the cache, with no intermediate buffer. Filling the cache and serving a read are the same operation.

## Copy-on-write

None of this is writable yet. The chunker and cache serve reads out of immutable objects, and a sandbox that can't write to its own filesystem isn't much of a sandbox. `block.Overlay` is the piece that closes that gap:

```go
type Overlay struct {
	device       ReadonlyDevice
	cache        *Cache
	cacheEjected atomic.Bool
	blockSize    int64
}
```
[overlay.go:12](https://github.com/e2b-dev/infra/blob/8d918e2eee45af1911a1eb22508b75a70d9d603b/packages/orchestrator/pkg/sandbox/block/overlay.go#L12)

`ReadAt` splits a request into blocks and tries the private write cache for each one, falling through to the read device on `BytesNotAvailableError`. `WriteAt` never goes past the cache at all.

```text
read  block 3 ──> write cache dirty?  ──yes──> serve from write cache
                        │
                        no
                        ▼
                  read device (chunker) ──> object storage

write block 3 ──> write cache only, mark dirty
```

Which gives the property the rest of this series depends on. The read device stays byte-identical to object storage for the entire life of the sandbox, so two sandboxes booted from the same template can share one read device and diverge only in their private write caches. That's a footnote in E2B and it turns into the headline feature by Part 4.

There's a subtle ordering problem at teardown, too. Snapshotting needs the write cache, and closing the overlay wants to destroy it. `EjectCache` settles it with a compare-and-swap on `cacheEjected` that hands the cache over exactly once, after which the overlay refuses I/O and `Close` becomes a no-op. A snapshot in progress can't lose its data to a concurrent teardown.

## The two consumers

The overlay gets served two different ways, and it doesn't know the difference.

The rootfs goes out over NBD. `NewNBDProvider` builds the cache, wraps the read device in an overlay, and hands it to a direct-path mount speaking the NBD protocol over Unix sockets to `/dev/nbdN`. Firecracker sees an ordinary block device, the guest kernel does ordinary block I/O, and every miss quietly becomes a 4 MiB range GET.

Guest memory goes out over userfaultfd instead. Firecracker maps the memory file, the UFFD handler catches page faults, and `Prefault` writes resolved bytes into the guest's address space. Same headers, same chunker, same cache, different fault mechanism. That's the only reason guest memory uses 2 MiB blocks while the rootfs uses 4 KiB.

Part 3 adds a third consumer that E2B doesn't have: the host kernel's own ext4 driver.

## Snapshotting

Now the write-cache bitmap earns its keep. Exporting a diff means walking it:

1. `EjectCache` takes the write cache out of the overlay.
2. The sandbox is destroyed and in-flight operations drain.
3. `SyncFileRange` pushes the mmap's dirty pages to the filesystem.
4. `ExportToDiff` walks the bitmap's set ranges and copies each one into the output file with `copy_file_range`, which becomes a reflink on XFS. On `EXDEV`, `EOPNOTSUPP`, or `ENOSYS` it falls back to `io.Copy`.
5. `ToDiffHeader` turns the bitmap into `BuildMap` entries, merges them over the parent's mapping, normalizes, and bumps the generation.

Step 4 is the one worth stealing. `copy_file_range` becomes a reflink on XFS, so exporting a 500 MiB diff can cost almost no I/O, and the fallback to `io.Copy` on `EXDEV`, `EOPNOTSUPP`, or `ENOSYS` means it degrades instead of failing on a filesystem that doesn't support it.

Zero blocks get the `uuid.Nil` treatment from earlier, so all that scratch space a sandbox wrote and then deleted uploads as a mapping entry instead of bytes.

## Trade-offs

| | Lazy block fetch | Download the image first |
|---|---|---|
| Time to first read | Milliseconds, one chunk | Tens of seconds, whole image |
| Bytes transferred | Only what's read | Everything |
| Steady-state read latency | Cache hit, or one S3 round trip | Local disk |
| Failure mode | Object storage outage stalls live I/O | Fails before boot |
| Snapshot cost | Dirty blocks only | Full image copy |

The costs are real and they don't go away. Downloading the image front-loads all the pain into a place where you expect it, and lazy fetch spreads it across the sandbox's whole life instead. A cache miss is an S3 round trip that the guest kernel experiences as very slow block-device latency, and it can land on the user's first keystroke or on hour six.

Snapshot chains are the other slow leak. Every pause adds mapping entries and one more object that reads might fan out to, so a sandbox someone has been snapshotting for a week eventually needs a rebase pass to flatten it. Cheap snapshots aren't free snapshots, they're deferred ones.

The whole thing rests on one assumption worth stating plainly: the read side never changes. That's what makes it safe for a chunk fetched by one sandbox to be handed to a completely unrelated one, and it's the property that turns this into something you can put behind a Kubernetes volume. [Part 2](/posts/kubernetes-csi-interface/) covers that interface, and it's much less clever than this.
