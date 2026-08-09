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

An agent sandbox needs a disk of its own, and a copy of a VM image per sandbox is the answer that works until you count them. Every paused sandbox is a few more gigabytes held for someone who may never come back, and every fresh one downloads the whole image before it runs a line of code.

[E2B](https://e2b.dev) gives each sandbox a Firecracker microVM with its own kernel and pays neither cost, and its infrastructure is on GitHub as [e2b-dev/infra](https://github.com/e2b-dev/infra) for anyone wanting to self-host.

So let's follow one read down from the guest kernel to S3 and back, then pause the sandbox and watch what it uploads.

## Overview

Here's an overview of one running E2B sandbox, from the guest kernel down to object storage. The double lines mark boundaries, where the first separates the guest kernel from the host and the second separates the machine from the object storage below it.

In this post we'll walk through the whole diagram step by step to see how the E2B storage layer works.

```text
ONE RUNNING SANDBOX

  Firecracker microVM
    the guest kernel runs ext4, owns every dirty page, and dies with the VM

    guest memory                    /dev/vda, virtio-blk
        │                               │
        │  page fault                   │  block request
════════│═══════════════════════════════│════════════  guest above, host below
        ▼                               ▼
    page-fault handler              block-request handler
        │                               │  /dev/vda is really the host's
        │                               │  /dev/nbd0, which the host
        │                               │  kernel never mounts
        └───────────────┬───────────────┘
                        ▼
                  block.Overlay
        ┌───────────────┴───────────────┐
        ▼                               ▼
┌───────────────┐           ┌───────────────────────┐
│ write cache   │           │ read cache            │
│ mmap'd sparse │           │ mmap'd sparse         │
│ dirty bitmap  │           │ cached bitmap         │
└───────────────┘           └───────────┬───────────┘
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
════════════════════════════════════════│════════════  host above, S3 below
                                        ▼
                            ┌───────────────────────┐
                            │ object storage        │
                            └───────────────────────┘
```

Writes stop at the left branch under `block.Overlay` and never travel any further. So the right branch stays byte-identical to what's in S3 for as long as the sandbox lives, and the last two posts spend their time exploiting that.

## A build in object storage

Every address in this system is relative to a build, and a build is just a UUID. Hand that UUID to S3 and you get back the prefix `s3://templates/<build-id>/` with five objects under it.

1. `rootfs.ext4`, the packed rootfs blocks for this build.
2. `rootfs.ext4.header`, metadata plus the block mapping.
3. `memfile`, the packed guest-memory chunks.
4. `memfile.header`, its own metadata and mapping.
5. `snapfile`, [Firecracker's VM state](https://github.com/firecracker-microvm/firecracker/blob/054b647d47745ab1ef945238d06a2112040eda1b/SPECIFICATION.md).

The interesting one is `rootfs.ext4` because it isn't an image. It holds only the blocks that this particular build contains, packed end to end with no gaps. A build is either the base of its own chain, holding every block, or it chains onto a parent and stores only what changed since. That chaining is what makes this a copy-on-write system.

So a chained build's `rootfs.ext4` might be 4 MiB of scattered blocks. How does anything read that as an 8 GiB filesystem?

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

Each entry makes one claim. Some run of the virtual image lives in some build's data file at some offset:

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

The guest addresses its bytes by `Offset` while they actually live at `BuildStorageOffset`, inside whichever data file `BuildId` names:

```text
ONE ENTRY, TWO ADDRESS SPACES

  virtual, what the guest sees
  ┌──────────────────────────────────────────────────────┐
  │                       │  this run  │                 │
  └──────────────────────────────────────────────────────┘
                          └── Offset   └── Offset + Length

  physical, inside BuildId's rootfs.ext4
  ┌──────────────────────┐
  │        │  same run   │
  └──────────────────────┘
           └── BuildStorageOffset
```

### Eight blocks

A real image has far too many digits to follow by hand, so let's shrink one down to eight blocks and count in blocks instead of bytes. The struct really does store byte offsets, but each one is a multiple of the block size. Dividing through costs us nothing, so block 3 just means the fourth block.

So let's run that image through a build and then a snapshot, watching the mapping change underneath it at each step. Here we have a fresh base build made up of eight blocks, A through H:

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

Since we only have a single entry where the virtual and physical offsets are the same, a base build isn't a very interesting case. So let's take a look at what happens after one snapshot instead.

### One snapshot

Now let's boot the sandbox and write to blocks 3 and 5. Those writes land in the write cache initially and are only written to S3 when the sandbox actually stops.

Now that we have two dirty blocks, the snapshot `diff-a` contains those two blocks packed together:

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

`D'` is virtual block 3 living at physical block 0, and `F'` is virtual block 5 living at physical block 1. The data file records neither fact. It's two blocks with no structure and no idea where its contents belong, which leaves the recording to the header.

Turning that bitmap into entries gives two of them, one per dirty block:

```text
BuildMap[0] = {Offset: 3, Length: 1, BuildId: diff-a, BuildStorageOffset: 0}
BuildMap[1] = {Offset: 5, Length: 1, BuildId: diff-a, BuildStorageOffset: 1}
```

This pair never reaches S3 as-is. It only covers two blocks out of eight, so asking it about block 2 gets you nothing. It becomes a header only once it's merged with the parent's mapping.

### Merging

So now we have two mappings that each describe part of the image, and neither one can serve a read by itself. Pausing the sandbox is where they get combined: [`MergeMappings`](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/header/mapping.go#L78) takes the parent's mapping and the new diff's, and returns one mapping covering all eight blocks with no gaps. That merged result is what gets written as `diff-a`'s header.

The diagram below shows the four cases of how a base entry and a diff entry might overlap. In all of them, the diff overwrites the base:

```text
A BASE ENTRY MEETING A DIFF ENTRY, ALL FOUR WAYS

  block:        0       1       2       3       4       5
             ┌───────┬───────┬───────┬───────┬───────┬───────┐

  Case 1: they don't overlap
  base       └──── base ─────┘
  diff                                       └──── diff ─────┘
                                  merge ▼
  result     └──── base ─────┘               └──── diff ─────┘
             no contested blocks, so both entries survive untouched

  Case 2: base falls inside diff
  base                       └──── base ─────┘
  diff               └──────────── diff ─────────────┘
                                  merge ▼
  result             └──────────── diff ─────────────┘
             the diff covers every block base had, so base disappears

  Case 3: diff falls inside base
  base       └──────────────────── base ─────────────────────┘
  diff                       └──── diff ─────┘
                                  merge ▼
  result     └──── base ─────┴──── diff ─────┴──── base ─────┘
             base splits in two around the diff, giving three entries

  Case 4: they overlap at one edge
  base                       └──────────── base ─────────────┘
  diff       └──────────── diff ─────────────┘
                                  merge ▼
  result     └──────────── diff ─────────────┴──── base ─────┘
             base gives up blocks 2 and 3 and keeps the rest
```

Taking a closer look at case 3, let's walk through our example where `diff-a` overwrites blocks `D` and `F`:

```text
Step 1:  one base entry covering everything

  block:       0       1       2       3       4       5       6       7
           ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
           │   A   │   B   │   C   │   D   │   E   │   F   │   G   │   H   │
           └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘
  owner:   └─────────────────────────────base──────────────────────────────┘
  entry:   └───────────────────────────────0───────────────────────────────┘

Step 2:  diff-a's block 3 lands inside it and splits it

  block:       0       1       2       3       4       5       6       7
           ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
           │   A   │   B   │   C   │  D'   │   E   │   F   │   G   │   H   │
           └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘
  owner:   └─────────base──────────┴─diff──┴─────────────base──────────────┘
  entry:   └───────────0───────────┴───1───┴───────────────2───────────────┘

Step 3:  diff-a's block 5 splits the right piece again

  block:       0       1       2       3       4       5       6       7
           ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
           │   A   │   B   │   C   │  D'   │   E   │  F'   │   G   │   H   │
           └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘
  owner:   └─────────base──────────┴─diff──┴─base──┴─diff──┴─────base──────┘
  entry:   └───────────0───────────┴───1───┴───2───┴───3───┴───────4───────┘

Step 4:  the new diff-a build is uploaded to S3, alongside the base

  base    s3://templates/base/rootfs.ext4, 8 blocks on disk

  blocks:      0       1       2       3       4       5       6       7
           ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
           │   A   │   B   │   C   │   D   │   E   │   F   │   G   │   H   │
           └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘

  diff-a  s3://templates/diff-a/rootfs.ext4, 2 blocks on disk

  blocks:      0       1
           ┌───────┬───────┐
           │  D'   │  F'   │
           └───────┴───────┘
```

Those five entries are what gets uploaded as `diff-a`'s header. `Offset` is the reader's view of the filesystem, and `BuildStorageOffset` is the source of truth for where that block actually sits inside `BuildId`'s data file in S3:

| Offset | Length | BuildId | BuildStorageOffset |
|---|---|---|---|
| 0 | 3 | base | 0 |
| 3 | 1 | diff-a | 0 |
| 4 | 1 | base | 4 |
| 5 | 1 | diff-a | 1 |
| 6 | 2 | base | 6 |

That last row is where a bug would live. It starts at virtual block 6, and its `BuildStorageOffset` has to be 6 as well. That's where `G` actually sits inside the base data file. Copy the original entry's physical 0 into the right-hand piece instead and reads of blocks 6 and 7 quietly come back as `A` and `B`.

### Reading one block

To read a specific block, you have to find which entry your block lives inside. We can do that with a binary search over the `Offset` column, which gives us the header entry containing that block. So taking the example from before, let's search for block 5:

```text
  header entry index:    0     1     2     3     4
  Offset:                0     3     4     5     6

  binary search over Offsets for block 5   ->   index 3

  which build        diff-a
  physical offset    BuildStorageOffset 1
  length available   1 block
```

Read that as: open `s3://templates/diff-a/rootfs.ext4` and take one block starting at block 1. Those bytes are `F'`. Ask for block 6 instead and the search lands on index 4, giving physical block 6 of the base file, which is `G`. Same call, different object, and the caller never had to know which.

### Keeping the entry count down

Right after merging, `NormalizeMappings` runs over the result and joins any neighbouring entries it safely can. Our five come out untouched, since they alternate between `base` and `diff-a` and no two neighbours share a build.

For two entries to join they have to name the same build and sit next to each other inside that build's data file, not just inside the virtual image. Two `base` entries covering virtual blocks 6 and 7 join if their bytes are at physical 6 and 7, and don't if the bytes are at physical 6 and 9. Joining that second pair would send the block 7 read to physical 7 and hand back whatever happens to live there.

Without this step the array only ever grows since every snapshot splits entries, and a long-lived sandbox ends up carrying thousands of them.

## Diff chains

Storing a full UUID in every entry only pays off once a mapping names more than two builds, and that's exactly what happens on the second snapshot.

So let's resume the paused sandbox, write to block 7, and pause it again. `diff-b` uploads that one block, and its mapping merges over `diff-a`'s the same way `diff-a`'s merged over the base:

```text
  block:       0       1       2       3       4       5       6       7
           ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
           │   A   │   B   │   C   │  D'   │   E   │  F'   │   G   │  H'   │
           └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘
  owner:   └─────────base──────────┴─diff-a┴─base──┴─diff-a┴─base──┴─diff-b┘
```

Now three builds back one filesystem. Reading block 3 opens `diff-a`, block 7 opens `diff-b`, and the other six come from `base`. The guest sees one flat filesystem the whole time, and none of the three objects had to be rewritten to make it happen.

## The chunker

`build.File` can resolve any virtual offset to a build and a physical offset, which is enough to serve a read and nowhere near enough to serve a filesystem. Ask it for one block and it fetches exactly one block. So a `git status` walking a source tree turns into thousands of independent HTTPS round trips, each paying full S3 latency to move 4 KiB:

```text
  per block                              per 4 MiB chunk

  read block 12 ──> GET ──> 4 KiB        read block 12 ──> GET ──> 4 MiB
  read block 13 ──> GET ──> 4 KiB        read block 13 ──> cache hit
  read block 14 ──> GET ──> 4 KiB        read block 14 ──> cache hit
  ... 1024 times                         ... 1021 more hits

  1024 round trips                       1 round trip
```

The bet is that filesystem reads cluster, so the chunker refuses to think in blocks at all and works in 4 MiB units:

```go
// MemoryChunkSize must always be bigger or equal to the block size.
MemoryChunkSize = 4 * 1024 * 1024 // 4 MB
```
[storage.go:42](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/storage.go#L42)

Ten readers can want the same chunk at once, though, and the obvious fix makes things worse. Collapse them into one fetch, wake everybody when it lands, and the reader who only wanted the first 4 KiB waits on all 4 MiB.

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

The fetch loop reads in batches of `max(blockSize, 16 KiB)`, advances `bytesReady` at block granularity, and pops satisfied waiters off the front of the list. A reader waiting on the first block of a chunk gets released after about 16 KiB rather than 4 MiB. On a cold `git status` that's the difference between usable and not.

Two orderings in there only bite under load, and each one is a way for a correct-looking fetch to waste a round trip or lose one.

1. The fetch goroutine runs on `context.WithoutCancel(ctx)`, since otherwise the first caller giving up cancels a fetch four other waiters are depending on.
2. `runFetch` marks the chunk cached *before* deleting its session from `fetchMap`. The other order leaves a window where a late caller finds no in-flight session and no cached chunk, so it starts a second fetch for bytes already sitting there.

Both of those hazards turn on a chunk being cached, so let's dig into where a cached chunk actually lives.

## The cache

`block.Cache` is one sparse file per device, truncated to the full image size and mmap'd:

```go
cache, err := NewCache(size, blockSize, cachePath, false)
```
[cache.go:62](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/orchestrator/pkg/sandbox/block/cache.go#L62)

The file claims to be 8 GiB while occupying only what the filesystem has actually allocated, and for a fresh cache that's nothing. That gap between claimed and real size is why `FileSize` reports `stat.Blocks * 512`, in the 512-byte units POSIX always uses, instead of trusting the stat size. In Part 3 the same gap turns into a sweep evicting the one cache worth keeping.

Alongside the mapping sits a bitmap with one bit per block. Ask it for a range that isn't fully set and you get a `BytesNotAvailableError` rather than zeros, which is how a caller finds out it has to go fetch something. Snapshotting is built entirely on the write cache's reading of that bit.

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

A read walks its request one block at a time and asks the private write cache first, taking `BytesNotAvailableError` as permission to fall through to the read device. A write doesn't walk anywhere, since `WriteAt` puts the bytes in the cache and stops.

```text
read  block 3 ──> write cache dirty?  ──yes──> serve from write cache
                        │
                        no
                        ▼
                  read device (chunker) ──> object storage

write block 3 ──> write cache only, mark dirty
```

The write arrow never reaches the read device, so the read device holds bytes identical to what's in S3 for as long as the sandbox lives. Two sandboxes booted from the same template can therefore point at one read device and diverge only in their private write caches. That's a footnote in E2B, and it turns into the headline feature by Part 4.

There's a subtle ordering problem at teardown, too. Snapshotting needs the write cache, and closing the overlay wants to destroy it. `EjectCache` settles it with a compare-and-swap on `cacheEjected` that hands the cache over exactly once, after which the overlay refuses I/O and `Close` becomes a no-op. A snapshot in progress can't lose its data to a concurrent teardown.

## The two consumers

The overlay gets served two different ways, and it doesn't know the difference:

```text
  ROOTFS                                 GUEST MEMORY

  guest does block I/O                   guest touches a page
    │                                      │
    ▼  virtio-blk                          ▼  page fault
  /dev/vda                               userfaultfd
    │                                      │
    ▼  NBD over Unix sockets               ▼  UFFD handler calls Prefault
  /dev/nbdN                              writes into the guest's address space
    │                                      │
    └──────────────┬───────────────────────┘
                   ▼
             block.Overlay
       same headers, same chunker, same cache

  4 KiB blocks                           2 MiB blocks (hugepages)
```

The rootfs goes out over NBD. `NewNBDProvider` builds the cache, wraps the read device in an overlay, and hands it to a direct-path mount speaking the NBD protocol over Unix sockets to `/dev/nbdN`. Firecracker sees an ordinary block device, the guest kernel does ordinary block I/O, and every miss quietly becomes a 4 MiB range GET.

Guest memory goes out over userfaultfd instead. Firecracker maps the memory file, the UFFD handler catches page faults, and `Prefault` writes resolved bytes into the guest's address space. Same headers, same chunker, same cache, different fault mechanism. Block size is per device for exactly that reason, since guest memory sits on hugepages and works in 2 MiB units while a rootfs uses 4 KiB:

```go
const (
	PageSize        = 4 << 10 // 4 KiB
	HugepageSize    = 2 << 20 // 2 MiB
	RootfsBlockSize = 4 << 10 // 4 KiB
)
```
[diff.go:10](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/header/diff.go#L10)

Part 3 adds a third consumer that E2B doesn't have: the host kernel's own ext4 driver.

## Snapshotting

A paused sandbox has to become two S3 objects, a data file holding only what changed and a header describing where the changes go, and the bitmap already knows which blocks those are.

Steps 1, 2, and 5 are bookkeeping, while steps 3 and 4 are Linux behaving in ways that lose your data if you assume the obvious thing.

1. `EjectCache` takes the write cache out of the overlay.
2. Destroying the sandbox lets in-flight NBD and UFFD requests drain.
3. `SyncFileRange` pushes the mmap's dirty pages down to the filesystem.
4. `ExportToDiff` copies each dirty range into the diff file with `copy_file_range`.
5. `ToDiffHeader` turns the bitmap into `BuildMap` entries, then merges and normalizes.

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

Read the fd before writeback runs and the diff is missing the block. So step 3 calls [`sync_file_range(2)`](https://man7.org/linux/man-pages/man2/sync_file_range.2.html) with `SYNC_FILE_RANGE_WRITE`, which asks the kernel to start writing out the dirty pages in a range. That's weaker than an `fsync`, because it kicks writeback into starting without waiting for the disk to confirm anything.

That looseness would be alarming if the call mattered, and it doesn't. E2B treats it as an optimization, logging a warning on failure rather than aborting. The copy in step 4 goes through the page cache anyway and sees the dirty pages whether or not they've reached the platter. The sync just means fewer of them are still in flight when the copy starts.

### Why step 4 is fast

The obvious way to build a diff file is to read each dirty range into a buffer and write it back out. That's two copies through userspace for data nobody inspects, and for a 500 MiB diff it's 500 MiB of pointless memory traffic.

[`copy_file_range(2)`](https://man7.org/linux/man-pages/man2/copy_file_range.2.html) skips it. The kernel copies between two file descriptors without the bytes ever entering the calling process. On a filesystem that supports it the copy becomes a reflink, so two inodes end up pointing at the same copy-on-write blocks and no data moves at all. XFS supports that. ext4 doesn't, so the same call there does a real in-kernel copy. Format the snapshot disk XFS if you get the choice, because on ext4 a 500 MiB diff is 500 MiB the kernel actually moves.

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

Three error codes get special handling, and each one is a filesystem declining for a different reason.

1. `EXDEV`, the two files are on different filesystems, which the syscall used to refuse outright.
2. `EOPNOTSUPP`, this filesystem doesn't implement the call.
3. `ENOSYS`, the kernel is older than 4.5, when the call was added.

Any of the three flips a `fallback` flag and the export finishes with `io.Copy`, so a node on an unusual filesystem gets slower snapshots rather than no snapshots.

### What ends up in S3

Step 5 turns the bitmap back into mapping entries. Every contiguous run of set bits becomes one `BuildMap` whose `BuildStorageOffset` counts up through the diff file in the order the ranges were written, which is precisely the packed layout from the worked example. Those entries merge onto the parent's mapping, normalize, and the generation goes up by one.

Zero blocks get a `BuildId` of `uuid.Nil`, which tells the reader to zero-fill the buffer without opening any object at all. So a sandbox that filled 2 GiB of scratch space and then deleted it uploads one mapping entry and no bytes, rather than 2 GiB of zeros.

## Trade-offs

| | Lazy block fetch | Download the image first |
|---|---|---|
| Time to first read | Milliseconds, one chunk | Tens of seconds, whole image |
| Bytes transferred | Only what's read | Everything |
| Steady-state read latency | Cache hit, or one S3 round trip | Local disk |
| Failure mode | Object storage outage stalls live I/O | Fails before boot |
| Snapshot cost | Dirty blocks only | Full image copy |

Downloading the image front-loads all the pain into a place where you expect it, and lazy fetch spreads it across the sandbox's whole life instead. A cache miss is an S3 round trip that the guest kernel experiences as very slow block-device latency, and it can land on the user's first keystroke or on hour six. Worth it, on balance, because a sandbox that starts in a second and occasionally stalls for 40 ms beats one that starts in thirty seconds every single time. Read most of the image on every boot and the trade inverts.

Snapshot chains are the other slow leak. Every pause adds mapping entries and one more object that reads might fan out to, so a sandbox someone has been snapshotting for a week eventually needs a rebase pass to flatten it. Part 3 puts a number on how fast that accumulates once the snapshots are on a timer.

The whole thing rests on one assumption worth stating plainly: the read side never changes. That's what makes it safe for a chunk fetched by one sandbox to be handed to a completely unrelated one. It's also the property that turns this into something you can put behind a Kubernetes volume. [Part 2](/posts/kubernetes-csi-interface/) covers that interface, and it's much less clever than this.
