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

A sandbox is supposed to boot in about a second. Its root filesystem is a few gigabytes of ext4 sitting in S3, and there's a guest memory snapshot of similar size behind it. Downloading both before the guest starts costs tens of seconds, and at the end of that the user's code still hasn't run.

[E2B](https://github.com/e2b-dev/infra) never downloads it. It hands the guest kernel a block device that claims to be the whole image, then fetches 4 MiB pieces the first time something actually reads them. That works because sandboxes barely touch their own disk. A process starts, reads its own binary, pulls in a few libraries, opens some config files, and then mostly idles.

Five pieces make that work: a header that says where bytes live, a data file that holds them, a chunker that fetches in useful sizes, a sparse cache that remembers what arrived, and an overlay that keeps writes away from S3.

## Overview

```text
Firecracker microVM
│   guest kernel: runs ext4, owns the dirty page cache
│   both of them die with the VM
│
├─ guest memory ──> UFFD handler ──┐
│                                  │
└─ /dev/vda ──────> NBD dispatch ──┤   /dev/vda is the host's /dev/nbd0,
   virtio-blk                      │   which the host kernel never mounts
                                   ▼
                             block.Overlay
                  ┌────────────────┴────────────────┐
                  ▼                                 ▼
        ┌───────────────────┐           ┌───────────────────────┐
        │ write cache       │           │ read cache            │
        │ mmap'd sparse     │           │ mmap'd sparse         │
        │ + dirty bitmap    │           │ + cached bitmap       │
        └───────────────────┘           └───────────┬───────────┘
                                                    │  miss
                                                    ▼
                                        ┌───────────────────────┐
                                        │ chunker               │
                                        │ fetches 4 MiB at once │
                                        └───────────┬───────────┘
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

The split down the middle is the part to hold onto. Writes stop at the write cache and never travel any further, so everything on the right stays byte-identical to what's in S3 for as long as the sandbox lives. Two of the later posts are built on that one property.

Both sides are also the same data structure. The read cache isn't a passthrough to S3, it's a sparse mmap'd file with a bitmap over it, and the bitmap just means something different depending on which branch you're standing in. A set bit on the left means the sandbox wrote this block. On the right it means S3 already gave it to us.

## A build in object storage

Everything below refers to a build, which is a UUID with a prefix in the bucket and five objects under it:

```text
s3://templates/<build-id>/
    rootfs.ext4          packed rootfs blocks for this build
    rootfs.ext4.header   metadata plus the block mapping
    memfile              packed guest-memory chunks
    memfile.header       metadata plus the block mapping
    snapfile             Firecracker VM state
```

The interesting one is `rootfs.ext4`, because it isn't an image. It holds only the blocks that this particular build contains, packed end to end with no gaps. A base template happens to contain all of them. A snapshot contains whatever the sandbox dirtied before someone paused it, which is usually a few megabytes against a multi-gigabyte parent.

So a snapshot's `rootfs.ext4` might be 4 MiB of scattered blocks. How does anything read that as an 8 GiB filesystem?

## The header is a virtual address space

The header sitting next to the data file is what lets the guest read those scattered blocks like an ordinary filesystem. It's a 64-byte metadata record followed by an array of 40-byte entries, all little-endian:

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

Every entry makes one claim: this run of the virtual image lives in that build's data file, at that offset.

```go
type BuildMap struct {
	// Offset is the starting position of this range in the block device.
	Offset             uint64
	Length             uint64
	BuildId            uuid.UUID
	BuildStorageOffset uint64
}
```
[mapping.go:14](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/header/mapping.go#L14)

Two offsets in there, and mixing them up is the classic way to corrupt an image. `Offset` is virtual, an address in the 8 GiB filesystem the guest thinks it has. `BuildStorageOffset` is physical, a position inside one build's packed data file.

That's the entire format. Whether it makes sense is another question, so let's build one by hand.

### Eight blocks

Real images have too many digits to follow, so shrink one down to eight blocks and count in blocks rather than bytes. The struct stores byte offsets, but every one of them is a multiple of the block size, so dividing through loses nothing. Block 3 means the fourth block, and that's the last unit conversion in this post.

Here's a base template fresh out of a build. Call its eight blocks A through H:

```text
virtual image, what the guest sees

  block:       0       1       2       3       4       5       6       7
           ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
           │   A   │   B   │   C   │   D   │   E   │   F   │   G   │   H   │
           └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘

s3://templates/base/rootfs.ext4, 8 blocks on disk

  block:       0       1       2       3       4       5       6       7
           ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
           │   A   │   B   │   C   │   D   │   E   │   F   │   G   │   H   │
           └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘

  header:  {Offset: 0, Length: 8, BuildId: base, BuildStorageOffset: 0}
```

One entry covers the whole image, and both of its offsets are zero, because virtual and physical are the same thing in a base template. Which is exactly why a base template teaches you nothing about the format. It gets interesting after a snapshot.

### One snapshot

Boot the sandbox, write to blocks 3 and 5, then pause it. Neither write ever reached S3, since both of them stopped at the write cache, so pausing is when they finally get uploaded.

Two dirty blocks, so `diff-a`'s data file is two blocks long. Packed end to end, which is where the two offsets stop agreeing:

```text
s3://templates/diff-a/rootfs.ext4, 2 blocks on disk (not 8)

  block:       0       1
           ┌───────┬───────┐
           │  D'   │  F'   │
           └───────┴───────┘
               ▲       ▲
               │       └── new contents of virtual block 5
               └────────── new contents of virtual block 3
```

`D'` is virtual block 3 living at physical block 0, and `F'` is virtual block 5 living at physical block 1. The data file records neither fact. It's two blocks with no structure and no idea where its contents belong.

Which is the job the header does. `diff-a`'s own mapping states where its two blocks go, virtual on the left, physical on the right:

```text
BuildMap[0] = {Offset: 3, Length: 1, BuildId: diff-a, BuildStorageOffset: 0}
BuildMap[1] = {Offset: 5, Length: 1, BuildId: diff-a, BuildStorageOffset: 1}
```

That covers two blocks out of eight. Ask this mapping about block 2 and it has nothing to say, so it can't serve a read on its own.

### Merging

`MergeMappings` walks the base mapping and the diff mapping in lockstep and produces one mapping that covers all eight blocks with no gaps. Six overlap cases show up in the code and five of them are bookkeeping. The one worth looking at is a diff entry landing strictly inside a base entry, because it splits the base in two.

That happens twice here, once per dirty block, so the single base entry comes out in three pieces:

```text
before

  base     └──────────────────── base, blocks 0..8 ────────────────────────┘
  diff-a                           └─────┘         └─────┘

after

  block:       0       1       2       3       4       5       6       7
           ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
           │   A   │   B   │   C   │  D'   │   E   │  F'   │   G   │   H   │
           └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘
  owner:   └─────────base──────────┴─diff──┴─base──┴─diff──┴─────base──────┘
  entry:   └───────────0───────────┴───1───┴───2───┴───3───┴───────4───────┘
```

Five entries, both offsets spelled out:

| entry | starts at block | blocks | build | physical block |
|---|---|---|---|---|
| 0 | 0 | 3 | base | 0 |
| 1 | 3 | 1 | diff-a | 0 |
| 2 | 4 | 1 | base | 4 |
| 3 | 5 | 1 | diff-a | 1 |
| 4 | 6 | 2 | base | 6 |

Entry 4 is where a bug would live. It starts at virtual block 6, and its physical block has to be 6 as well, because block 6 is where `G` actually sits inside the base data file. Copy the original entry's physical 0 into the right-hand piece instead and reads of blocks 6 and 7 quietly come back as `A` and `B`.

So the split advances the physical offset by exactly as much virtual space it skipped over:

```go
rightBaseShift := int64(diff.Offset) + int64(diff.Length) - int64(base.Offset)
rightBaseLength := int64(base.Length) - rightBaseShift

if rightBaseLength > 0 {
	baseMapping[baseIdx] = BuildMap{
		Offset:             base.Offset + uint64(rightBaseShift),
		Length:             uint64(rightBaseLength),
		BuildId:            base.BuildId,
		BuildStorageOffset: base.BuildStorageOffset + uint64(rightBaseShift),
	}
}
```
[mapping.go:163](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/header/mapping.go#L163)

Both offsets move by the same `rightBaseShift`, which is the invariant the whole format rests on. Break it and nothing throws. Reads return other data, which is a worse outcome than a crash, and it's why this is the code to read twice.

### Reading one block

Five entries, sorted, covering the image with no gaps, so exactly one of them owns any block you name. Finding it is the whole read path, and the question is simple: which is the last entry that starts at or before the block we want?

That's a binary search over the entry start offsets, which for our five entries are `[0, 3, 4, 5, 6]`. Say the guest asks for block 5, one of the two the sandbox dirtied:

```text
  index:      0    1    2    3    4
  starts at:  0    3    4    5    6
                             ▲
                             │  block 5 is in here

  step 1   lo=0  hi=5   mid=2   starts[2]=4 > 5 ?   no    lo = 3
  step 2   lo=3  hi=5   mid=4   starts[4]=6 > 5 ?   yes   hi = 4
  step 3   lo=3  hi=4   mid=3   starts[3]=5 > 5 ?   no    lo = 4

  answer: index 4
```

`SearchOffset` answers a slightly different question than the one we asked. It returns where block 5 *would be inserted*, which is index 4, so the entry that owns block 5 is the one before it:

```go
i := t.Mapping.SearchOffset(offset)
if i == 0 {
	return BuildMap{}, 0, fmt.Errorf("no source found for offset %d", offset)
}

mapping := t.Mapping.At(i - 1)
shift := offset - int64(mapping.Offset)
```
[header.go:239](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/header/header.go#L239)

An index of 0 would mean the address sits below the first entry, which can't happen in a gapless mapping, so it's an error instead of an index of -1.

Entry 3 is `diff-a` at physical block 1, and our request starts exactly where the entry does, so `shift` is 0. `GetShiftedMapping` wraps all of that up and hands the caller three things:

```text
  which build        diff-a
  physical offset    block 1 + shift 0   =   block 1
  length available   1 block - shift 0   =   1 block
```

Read that as: open `s3://templates/diff-a/rootfs.ext4` and take one block starting at block 1. Those bytes are `F'`. Ask for block 6 instead and the same search lands on entry 4, giving physical block 6 of the base file, which is `G`. Same call, different object, and the caller never had to know which.

That third value is the one people ignore. A caller asking for four blocks starting at block 5 gets told one block is available, because block 6 lives in a different S3 object entirely. It has to stop at the boundary, resolve again, and fetch the rest from the base file. Every layer above this one loops for that reason, and Part 3 gets to skip the loop by indexing its cache differently.

### Two more details

A build ID of `uuid.Nil` means the range is all zeros. There's no object to open, so the reader zero-fills the buffer and moves on. A sandbox that wiped a gigabyte of scratch space uploads one mapping entry and no bytes for it, and it still reads back as zeros.

Left alone, that entry array grows by a few entries per snapshot until a long-lived sandbox is carrying thousands of them. `NormalizeMappings` joins neighbours to keep the count down, and the condition is stricter than sharing a build ID. Their physical offsets have to line up too:

```go
storageContiguous := mp.BuildId == ignoreBuildID ||
	mp.BuildStorageOffset == current.BuildStorageOffset+current.Length
if mp.BuildId == current.BuildId && storageContiguous {
	current.Length += mp.Length
```
[mapping.go:256](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/header/mapping.go#L256)

Sitting next to each other in the virtual image says nothing about sitting next to each other in a packed data file. Picture one `base` entry covering virtual blocks 0 through 2 from physical 0, and the next covering virtual block 3 from physical 9. Adjacent virtually, six blocks apart physically, so a joined entry would send that last read to physical 3 and hand back the wrong contents. Same failure as a bad split, and just as silent.

Block size is per device rather than global. Guest memory sits on hugepages so it works in 2 MiB blocks, while a rootfs uses 4 KiB:

```go
const (
	PageSize        = 4 << 10 // 4 KiB
	HugepageSize    = 2 << 20 // 2 MiB
	RootfsBlockSize = 4 << 10 // 4 KiB
)
```
[diff.go:10](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/header/diff.go#L10)

A metadata record, a sorted array, and a binary search with a `- 1` on the end. That's the whole mechanism, and it buys considerably more than the eight blocks it took to explain.

## Diff chains

Nothing in the example so far justifies storing a build ID in every entry, since two builds could have been a boolean. It's a UUID because one mapping can name as many builds as it likes, and that's what makes the second snapshot as cheap as the first.

Resume the paused sandbox, let it write to block 7, and pause it again. `diff-b` uploads one block, its mapping merges over the previous generation's mapping exactly the way `diff-a`'s merged over the base, and now three objects back one filesystem:

```text
  block:       0       1       2       3       4       5       6       7
           ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
           │   A   │   B   │   C   │  D'   │   E   │  F'   │   G   │  H'   │
           └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘
  owner:   └─────────base──────────┴─diff-a┴─base──┴─diff-a┴─base──┴─diff-b┘
```

Reading block 3 opens `diff-a`, block 7 opens `diff-b`, and the other six come from the base template. The guest sees one flat filesystem and has no idea it's a view stitched from three objects, none of which were rewritten to make it happen.

Each pause bumps `Generation`, mints a new `BuildID`, and leaves `BaseBuildID` pointing at the root, so any header knows both who it is and where its chain started. That's the metadata a rebase pass needs later, once a chain gets long enough to hurt.

## The chunker

`build.File` can now resolve any virtual offset to a build and a physical offset. Ask it for one block and it fetches exactly one block, which sounds efficient right up until you count the round trips. An ext4 mount walking a directory tree issues thousands of small reads, and one HTTP request per 4 KiB block is unusable.

So the chunker sits on top and refuses to think in blocks at all. It works in 4 MiB units:

```go
// MemoryChunkSize must always be bigger or equal to the block size.
MemoryChunkSize = 4 * 1024 * 1024 // 4 MB
```
[storage.go:42](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/storage.go#L42)

Which raises its own problem. Ten readers can want the same chunk at once, and the obvious fix, collapsing them into one fetch and waking everybody when it lands, makes the reader who only wanted the first 4 KiB wait on all 4 MiB.

So the chunker releases readers as their bytes arrive instead. Each in-flight chunk gets a `fetchSession` holding waiters sorted by the offset they need, plus an atomic `bytesReady` counter:

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

The fetch loop reads in batches of `max(blockSize, 16 KiB)`, advances `bytesReady` at block granularity, and pops satisfied waiters off the front of the list. A reader waiting on the first block of a chunk gets released after about 16 KiB rather than 4 MiB, which on a cold `git status` is the difference between usable and not.

Two details in there are the kind that only show up under load:

- The fetch goroutine runs on `context.WithoutCancel(ctx)`. Without it, the first caller giving up would cancel a fetch that four other waiters are depending on.
- `runFetch` marks the chunk cached *before* deleting its session from `fetchMap`. Do it the other way around and there's a window where a late caller finds no in-flight session and no cached chunk, so it starts a redundant fetch for bytes that are already there.

## The cache

Everything above keeps saying "writes into the cache's mmap." Here's what that actually is. `block.Cache` is one sparse file per device, truncated to the full image size and mmap'd:

```go
cache, err := NewCache(size, blockSize, cachePath, false)
```
[cache.go:62](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/orchestrator/pkg/sandbox/block/cache.go#L62)

Sparse is doing real work there. The file claims to be 8 GiB while occupying only what the filesystem has actually allocated, which for a fresh cache is nothing. That gap between claimed and real size is why `FileSize` reports `stat.Blocks * fsStat.Bsize` instead of trusting the stat size, and it comes back as a problem worth its own section in Part 3.

Next to the mapping is a bitmap, one bit per block. `setIsCached` sets a range, `isCached` tests it, and `Slice` returns `BytesNotAvailableError` when the range isn't fully set. One structure, two meanings, depending on which side of the overlay it's on: a set bit on a read cache means "already fetched from S3," and on a write cache it means "modified relative to the parent build." The snapshot path leans entirely on the second reading.

`addressBytes` hands out a slice of the mmap plus a closure that drops a read lock. The chunker fetches directly into that slice, so bytes go from the S3 socket into a page that already is the cache, with no intermediate buffer. Filling the cache and serving a read are the same operation.

## Copy-on-write

None of this is writable yet. The chunker and cache serve reads out of immutable objects, and a sandbox that can't write to its own filesystem isn't much of a sandbox. `block.Overlay` closes that gap:

```go
type Overlay struct {
	device       ReadonlyDevice
	cache        *Cache
	cacheEjected atomic.Bool
	blockSize    int64
}
```
[overlay.go:14](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/orchestrator/pkg/sandbox/block/overlay.go#L14)

`ReadAt` splits a request into blocks and tries the private write cache for each one, falling through to the read device on `BytesNotAvailableError`. `WriteAt` never goes past the cache at all.

```text
read  block 3 ──> write cache dirty?  ──yes──> serve from write cache
                        │
                        no
                        ▼
                  read device (chunker) ──> object storage

write block 3 ──> write cache only, mark dirty
```

Notice what the write arrow doesn't do. It never reaches the read device, so the read device holds bytes identical to what's in S3 for as long as the sandbox lives. Two sandboxes booted from the same template can therefore point at one read device and diverge only in their private write caches. That's a footnote in E2B, and it turns into the headline feature by Part 4.

There's a subtle ordering problem at teardown, too. Snapshotting needs the write cache, and closing the overlay wants to destroy it. `EjectCache` settles it with a compare-and-swap on `cacheEjected` that hands the cache over exactly once, after which the overlay refuses I/O and `Close` becomes a no-op. A snapshot in progress can't lose its data to a concurrent teardown.

## The two consumers

The overlay gets served two different ways, and it doesn't know the difference.

The rootfs goes out over NBD. `NewNBDProvider` builds the cache, wraps the read device in an overlay, and hands it to a direct-path mount speaking the NBD protocol over Unix sockets to `/dev/nbdN`. Firecracker sees an ordinary block device, the guest kernel does ordinary block I/O, and every miss quietly becomes a 4 MiB range GET.

Guest memory goes out over userfaultfd instead. Firecracker maps the memory file, the UFFD handler catches page faults, and `Prefault` writes resolved bytes into the guest's address space. Same headers, same chunker, same cache, different fault mechanism. That's the only reason guest memory works in 2 MiB blocks while the rootfs uses 4 KiB.

Part 3 adds a third consumer that E2B doesn't have: the host kernel's own ext4 driver.

## Snapshotting

Now the write-cache bitmap earns its keep. A paused sandbox has to become two S3 objects, a data file holding only what changed and a header describing where the changes go, and the bitmap already knows which blocks those are.

Five steps, and three of them are Linux mechanisms worth explaining rather than naming:

```text
1  EjectCache          take the write cache out of the overlay
2  destroy sandbox     let in-flight NBD and UFFD requests drain
3  SyncFileRange       push the mmap's dirty pages down to the filesystem
4  ExportToDiff        copy_file_range each dirty range into the diff file
5  ToDiffHeader        bitmap -> BuildMap entries -> merge -> normalize
```

### Why step 3 exists

The write cache is one file that's been [mmap'd](https://man7.org/linux/man-pages/man2/mmap.2.html), which means the process treats a region of its own address space as if it were the file. A write into that memory doesn't call `write(2)` and doesn't immediately touch the disk. It dirties a page of the kernel's page cache, and the kernel flushes it whenever writeback gets around to it.

Which is a problem for a snapshot, because step 4 reads that file through an ordinary file descriptor:

```text
  sandbox writes block 5
    │
    ▼
  mmap'd page in memory   <-- dirty, real data lives here
    │
    │  kernel writeback, whenever it feels like it
    ▼
  cache file on disk      <-- what an fd read would see
```

Read the fd before writeback runs and the diff is missing the block. So step 3 calls [`sync_file_range(2)`](https://man7.org/linux/man-pages/man2/sync_file_range.2.html) with `SYNC_FILE_RANGE_WRITE`, which asks the kernel to start writing out the dirty pages in a range. Not a full `fsync`, and it doesn't wait for the disk to confirm, it just kicks writeback into starting.

That looseness would be alarming if the call mattered, and it doesn't. E2B treats it as an optimization and logs a warning on failure rather than aborting, because the copy in step 4 goes through the page cache anyway and sees the dirty pages whether or not they've reached the platter. The sync just means fewer of them are still in flight when the copy starts.

### Why step 4 is fast

The obvious way to build a diff file is to read each dirty range into a buffer and write it back out. That's two copies through userspace for data nobody inspects, and for a 500 MiB diff it's 500 MiB of pointless memory traffic.

[`copy_file_range(2)`](https://man7.org/linux/man-pages/man2/copy_file_range.2.html) skips it. The kernel copies between two file descriptors without the bytes ever entering the calling process, and on a filesystem that supports it the copy becomes a reflink instead: two inodes pointing at the same copy-on-write blocks on disk, with no data movement at all. XFS supports that. ext4 doesn't, so the same call there does a real in-kernel copy, which is still better than a round trip through userspace but not free.

```text
  read + write                        copy_file_range

  cache file                          cache file
      │  read(2)                          │
      ▼                                   │  kernel-internal,
  userspace buffer                        │  reflink where the fs allows
      │  write(2)                         ▼
      ▼                               diff file
  diff file
```

Three error codes get special handling, and each one is a filesystem declining for a different reason. `EXDEV` means the two files are on different filesystems, which the syscall used to refuse outright. `EOPNOTSUPP` means this filesystem doesn't implement it. `ENOSYS` means the kernel is older than 4.5, when the call was added. Any of the three flips a `fallback` flag and the export finishes with `io.Copy`, so a node on an unusual filesystem gets slower snapshots rather than no snapshots.

### What ends up in S3

Step 5 turns the bitmap back into mapping entries. Every contiguous run of set bits becomes one `BuildMap` whose `BuildStorageOffset` counts up through the diff file in the order the ranges were written, which is precisely the packed layout from the worked example. Those entries merge onto the parent's mapping, normalize, and the generation goes up by one.

Zero blocks take the `uuid.Nil` path from earlier. A sandbox that filled 2 GiB of scratch space and then deleted it produces a mapping entry saying "this range is zeros" and uploads nothing for it, which beats putting 2 GiB of zeros in object storage.

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
