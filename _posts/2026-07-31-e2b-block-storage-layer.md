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

Both branches cache. The read side isn't a passthrough to S3, it's a sparse mmap'd file with a bitmap tracking which blocks have arrived, and the chunker only runs on a miss. Same data structure as the write cache, opposite meaning: a set bit on the left means the sandbox wrote this block, and a set bit on the right means S3 already gave it to us.

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

The header answers it. It's a fixed 64-byte metadata record followed by an array of 40-byte mapping entries, all little-endian, and it's what turns a bag of packed blocks back into a filesystem.

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
	// Offset is the starting position of this range in the block device.
	Offset             uint64
	Length             uint64
	BuildId            uuid.UUID
	BuildStorageOffset uint64
}
```
[mapping.go:14](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/header/mapping.go#L14)

Two offsets, and mixing them up is the classic way to corrupt an image. `Offset` is virtual, an address in the 8 GiB filesystem the guest thinks it has. `BuildStorageOffset` is physical, a byte position inside one build's packed data file.

That's the entire format. Whether it makes sense is another question, so the rest of this section is one example, small enough to do the arithmetic by hand.

### A 32 KiB filesystem

Real numbers get in the way, so shrink everything. A 32 KiB image, a 4 KiB block size, eight blocks. Block N covers virtual bytes `N * 4096` up to `(N+1) * 4096`.

Here's a base template straight out of a build. Call its eight blocks A through H:

```text
virtual image, what the guest sees

  block:       0       1       2       3       4       5       6       7
           ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
           │   A   │   B   │   C   │   D   │   E   │   F   │   G   │   H   │
           └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘
  byte:    0       4096    8192    12288   16384   20480   24576   28672   32768

s3://templates/base/rootfs.ext4, 32768 bytes on disk

  byte:    0       4096    8192    12288   16384   20480   24576   28672   32768
           ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
           │   A   │   B   │   C   │   D   │   E   │   F   │   G   │   H   │
           └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘

  header:  BuildMap[0] = {Offset: 0, Length: 32768, BuildId: base, BuildStorageOffset: 0}
```

Both offsets are zero and one entry covers everything, because virtual and physical are the same thing here. Which is exactly why a fresh base template teaches you nothing about the format. It gets interesting after a snapshot.

### One snapshot

The sandbox boots, writes to blocks 3 and 5, and someone pauses it. Neither write reached S3, they both stopped in the write cache, so the pause is when they get exported.

Two dirty blocks means `diff-a`'s data file holds two blocks. Packed end to end, which is the whole trick and the reason the two offsets stop agreeing:

```text
s3://templates/diff-a/rootfs.ext4, 8192 bytes on disk (not 32768)

  byte:    0       4096    8192
           ┌───────┬───────┐
           │  D'   │  F'   │
           └───────┴───────┘
               ▲       ▲
               │       └── new contents of virtual block 5
               └────────── new contents of virtual block 3
```

`D'` sits at physical byte 0 while being virtual block 3, and `F'` sits at physical byte 4096 while being virtual block 5. The data file records none of that. It's eight kilobytes with no structure and no idea where its contents came from.

Which is the job the header does. `diff-a`'s own mapping states where its two blocks belong, virtual offset on the left, physical offset on the right:

```text
BuildMap[0] = {Offset: 12288, Length: 4096, BuildId: diff-a, BuildStorageOffset: 0}
BuildMap[1] = {Offset: 20480, Length: 4096, BuildId: diff-a, BuildStorageOffset: 4096}
```

Two claims, one per entry. Virtual byte 12288 is at physical byte 0 of `diff-a`, and virtual byte 20480 is at physical byte 4096 of `diff-a`.

Still not enough to serve a read, though. Ask that mapping about block 2 and it has nothing to say.

### Merging

`MergeMappings` fixes that by walking the base mapping and the diff mapping in lockstep and producing one mapping that covers all eight blocks with no gaps. Six overlap cases show up in the code and five are bookkeeping. The one that matters is a diff entry landing strictly inside a base entry, because it splits the base in two.

That happens twice here, once per dirty block, so the single base entry ends up in three pieces:

```text
before

  base     └──────────────────── base, virtual 0..32768 ───────────────────┘
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

| entry | virtual `Offset` | `Length` | `BuildId` | `BuildStorageOffset` |
|---|---|---|---|---|
| 0 | 0 | 12288 | base | 0 |
| 1 | 12288 | 4096 | diff-a | 0 |
| 2 | 16384 | 4096 | base | 16384 |
| 3 | 20480 | 4096 | diff-a | 4096 |
| 4 | 24576 | 8192 | base | 24576 |

Entry 4 is where a bug would live. Its virtual offset is 24576, and its physical offset also has to be 24576, because 24576 is where `G` actually sits inside the base data file. Copy the original entry's `BuildStorageOffset` of 0 into the right-hand piece and reads of blocks 6 and 7 come back as `A` and `B`.

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

Both offsets move by the same `rightBaseShift`, which is the invariant the whole format rests on. Break it and nothing throws. Reads quietly return other data, which is a worse outcome than a crash, and it's why this is the code to read twice.

### Reading one block

Now the binary search, with a real number in it. The guest wants virtual byte 20480, which is block 5, one of the two the sandbox dirtied.

The five entries are sorted by `Offset` and cover the image with no gaps, so exactly one of them owns 20480. Finding it means finding the last entry whose `Offset` is at or below the address, which the code does in two steps:

```go
i := t.Mapping.SearchOffset(offset)
if i == 0 {
	return BuildMap{}, 0, fmt.Errorf("no source found for offset %d", offset)
}

mapping := t.Mapping.At(i - 1)
shift := offset - int64(mapping.Offset)
```
[header.go:239](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/header/header.go#L239)

`SearchOffset` returns the first index whose `Offset` is strictly greater than the address, so the entry you want is the one before it. That off-by-one reads like a mistake and isn't. A sorted array can cheaply answer "where would this value be inserted," one comparison per step, and "which range contains this value" is that same answer with a `- 1` on the end. The `i == 0` check catches the one case where subtracting is meaningless, an address below the first entry, which shouldn't happen in a gapless mapping and is worth an error rather than an index of -1.

It also searches in block units rather than bytes, because the mapping stores offsets as block indices to keep merged headers small in host RAM. Our five entries are `[0, 3, 4, 5, 6]`, and 20480 becomes block 5:

```text
  index:        0       1       2       3       4
  offsets:      0       3       4       5       6
                                        ▲
                                        │  block 5 lives in this entry

  target = 20480 / 4096 = 5

  step 1   lo=0  hi=5   mid=2   offsets[2]=4 > 5 ?   no    lo = 3
  step 2   lo=3  hi=5   mid=4   offsets[4]=6 > 5 ?   yes   hi = 4
  step 3   lo=3  hi=4   mid=3   offsets[3]=5 > 5 ?   no    lo = 4

  lo == hi == 4, return 4      the entry is At(4 - 1) = At(3)
```

Entry 3 is `{Offset: 20480, Length: 4096, BuildId: diff-a, BuildStorageOffset: 4096}`, and `shift` is `20480 - 20480 = 0`, meaning the request starts right where the entry does. `GetShiftedMapping` wraps all of it and hands back three things:

```text
  which build       BuildId                      =  diff-a
  physical offset   BuildStorageOffset + shift   =  4096 + 0    =  4096
  bytes available   Length - shift               =  4096 - 0    =  4096
```

Read that as: open `s3://templates/diff-a/rootfs.ext4`, take 4096 bytes starting at byte 4096. Those bytes are `F'`. Ask for virtual byte 24576 instead and the same search lands on entry 4, giving physical 24576 in the base file, which is `G`. Same call, different object, and the caller never had to know which.

That third return value is the one people ignore. A caller asking for 16 KiB from virtual 20480 gets told 4096 bytes are available, because the next 4 KiB lives in a different S3 object entirely. It has to stop at the boundary, resolve again, and fetch the rest from the base file. Every layer above this one loops for that reason, and Part 3 gets to skip the loop by indexing its cache differently.

### Two more details

A build ID of `uuid.Nil` means the range is all zeros. There's no object to open, so the reader zero-fills the buffer and moves on. A sandbox that wiped a gigabyte of scratch space uploads one mapping entry and no bytes for it, and it still reads back as zeros.

Left alone, that array grows by a few entries per snapshot until a long-lived sandbox carries thousands. `NormalizeMappings` joins adjacent entries to keep it down, and the condition is stricter than sharing a build ID. The physical offsets have to be contiguous too:

```go
storageContiguous := mp.BuildId == ignoreBuildID ||
	mp.BuildStorageOffset == current.BuildStorageOffset+current.Length
if mp.BuildId == current.BuildId && storageContiguous {
	current.Length += mp.Length
```
[mapping.go:256](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/header/mapping.go#L256)

Entries 2 and 4 in the table above are both `base`, and joining them would corrupt the image. They're separated virtually by entry 3 and separated by that same 4 KiB physically, so a merged entry's `BuildStorageOffset + shift` would land in the wrong part of the base file for every byte past the join. Same failure as the split, same silence.

Block size is per device, not global. Guest memory sits on hugepages so it works in 2 MiB blocks, while a rootfs uses 4 KiB:

```go
const (
	PageSize        = 4 << 10 // 4 KiB
	HugepageSize    = 2 << 20 // 2 MiB
	RootfsBlockSize = 4 << 10 // 4 KiB
)
```
[diff.go:10](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/header/diff.go#L10)

A metadata record, a sorted array, and a binary search with a `- 1` on it. That's all of it, and it buys something bigger than the eight blocks it took to explain.

## Diff chains

Nothing in the example so far justifies storing a build ID in every entry. Two builds could have been a boolean. It's a UUID because a mapping can name as many builds as it likes, and that's what makes the second snapshot as cheap as the first.

Resume the paused sandbox, let it write to block 7, pause it again. `diff-b` uploads one block. Its mapping merges over generation 2's mapping exactly the way `diff-a`'s merged over the base, and now three objects back one filesystem:

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

`build.File` can now resolve any virtual offset to a build and a physical offset. Ask it for 4 KiB and it fetches exactly 4 KiB, which sounds efficient right up until you count the round trips. An ext4 mount reading a directory tree issues thousands of small reads, and one HTTP request per 4 KiB block is completely unusable.

So the chunker sits on top and refuses to think in blocks. It works in 4 MiB units:

```go
// MemoryChunkSize must always be bigger or equal to the block size.
MemoryChunkSize = 4 * 1024 * 1024 // 4 MB
```
[storage.go:42](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/storage.go#L42)

Fetching in 4 MiB units raises its own problem, though. Ten readers can want the same chunk at once, and the obvious answer, collapsing them into one fetch and waking everybody when it lands, makes the reader who only wanted the first 4 KiB wait for the other 4092.

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

The fetch loop reads in batches of `max(blockSize, 16 KiB)`, advances `bytesReady` at block granularity, and pops satisfied waiters off the front of the list. So a reader waiting on the first block of a chunk gets released after about 16 KiB instead of 4 MiB, which on a cold `git status` is the difference between usable and not.

Two details in there are the kind that only show up under load:

- The fetch goroutine runs on `context.WithoutCancel(ctx)`. Without it, the first caller giving up would cancel a fetch that four other waiters are depending on.
- `runFetch` marks the chunk cached *before* deleting its session from `fetchMap`. Do it the other way around and there's a window where a late caller finds no in-flight session and no cached chunk, so it starts a redundant fetch for bytes that are already there.

## The cache

Everything above keeps saying "writes into the cache's mmap," so it's worth pinning down what that actually is. `block.Cache` is one sparse file per device, truncated to the full image size and mmap'd:

```go
cache, err := NewCache(size, blockSize, cachePath, false)
```
[cache.go:62](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/orchestrator/pkg/sandbox/block/cache.go#L62)

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

Notice what the write arrow doesn't do. It never reaches the read device, which means the read device holds bytes identical to what's in S3 for as long as the sandbox lives. Two sandboxes booted from the same template can therefore point at one read device and diverge only in their private write caches. That's a footnote in E2B and it turns into the headline feature by Part 4.

There's a subtle ordering problem at teardown, too. Snapshotting needs the write cache, and closing the overlay wants to destroy it. `EjectCache` settles it with a compare-and-swap on `cacheEjected` that hands the cache over exactly once, after which the overlay refuses I/O and `Close` becomes a no-op. A snapshot in progress can't lose its data to a concurrent teardown.

## The two consumers

The overlay gets served two different ways, and it doesn't know the difference.

The rootfs goes out over NBD. `NewNBDProvider` builds the cache, wraps the read device in an overlay, and hands it to a direct-path mount speaking the NBD protocol over Unix sockets to `/dev/nbdN`. Firecracker sees an ordinary block device, the guest kernel does ordinary block I/O, and every miss quietly becomes a 4 MiB range GET.

Guest memory goes out over userfaultfd instead. Firecracker maps the memory file, the UFFD handler catches page faults, and `Prefault` writes resolved bytes into the guest's address space. Same headers, same chunker, same cache, different fault mechanism. That's the only reason guest memory uses 2 MiB blocks while the rootfs uses 4 KiB.

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

The obvious way to build a diff file is to read each dirty range into a buffer and write it back out. That's two copies through userspace for data that never gets inspected, and for a 500 MiB diff it's 500 MiB of pointless memory traffic.

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

Three error codes get special handling, and each is a filesystem declining for a different reason. `EXDEV` means the two files are on different filesystems, which the syscall used to refuse outright. `EOPNOTSUPP` means this filesystem doesn't implement it. `ENOSYS` means the kernel is older than 4.5, when the call was added. Any of the three flips a `fallback` flag and the export finishes with `io.Copy`, so a node on an unusual filesystem gets slower snapshots rather than no snapshots.

### What ends up in S3

Step 5 turns the bitmap back into mapping entries. Every contiguous run of set bits becomes one `BuildMap` with `BuildStorageOffset` counting up through the diff file in the order the ranges were written, which is precisely the packed layout from the worked example. Those entries merge onto the parent's mapping, normalize, and the generation goes up by one.

Zero blocks take the `uuid.Nil` path from earlier. A sandbox that filled 2 GiB of scratch space and then deleted it produces a mapping entry saying "this range is zeros" and uploads nothing for it, which is a considerably better outcome than 2 GiB of zeros in object storage.

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
