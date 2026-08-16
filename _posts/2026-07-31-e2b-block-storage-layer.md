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
    page-fault handler              block.Overlay
        │                               │
        │                               ├──────> write cache, private to
        │                               │        this sandbox, dirty bitmap
        │                               │
        │                               │  not written by this sandbox
        └───────────────┬───────────────┘
                        ▼
            ┌───────────────────────┐
            │ read cache            │
            │ mmap'd sparse         │
            │ cached bitmap         │
            └───────────┬───────────┘
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
════════════════════════│════════════  host above, S3 below
                        ▼
            ┌───────────────────────┐
            │ object storage        │
            └───────────────────────┘
```

## A build in object storage

Every address in this system is relative to a build, and a build is just a UUID. Hand that UUID to S3 and you get back the prefix `s3://templates/<build-id>/` with five objects under it.

1. `rootfs.ext4`, the packed rootfs blocks for this build.
2. `rootfs.ext4.header`, metadata plus the block mapping.
3. `memfile`, the packed guest-memory chunks.
4. `memfile.header`, its own metadata and mapping.
5. `snapfile`, [Firecracker's VM state](https://github.com/firecracker-microvm/firecracker/blob/054b647d47745ab1ef945238d06a2112040eda1b/SPECIFICATION.md).

The interesting one is `rootfs.ext4` because it isn't an image. It holds only the blocks that this particular build contains, packed end to end with no gaps. A build is either the base of its own chain, holding every block, or it chains onto a parent and stores only what changed since. That chaining is what makes this a copy-on-write system.

So a chained build's `rootfs.ext4` might be 4 MiB of scattered blocks. How does anything read that as a whole filesystem?

## The header is a virtual address space

The header sitting next to the data file is what lets the guest read those scattered blocks like an ordinary filesystem. It's a 64-byte metadata record followed by an array of 40-byte entries:

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

A real image has far too many digits to follow by hand, so let's shrink one down to eight blocks and count in blocks instead of bytes. The struct really does store byte offsets, but each one is a multiple of the block size.

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

### Reading one block

To read a specific block, you have to find which entry your block lives inside. We can do that with a binary search over the `Offset` column, which gives us the header entry containing that block. So taking the example from before, let's search for block 5:

```text
  header entry index:    0     1     2     3     4
  Offset:                0     3     4     5     6
                                     ▲
                                     └── block 5 lands here, index 3
```

That entry tells us everything we need to go fetch the bytes, and asking for block 6 instead lands on index 4 and resolves against a different object entirely:

| block we want | which build | where in that build | how far the entry runs | bytes |
|---|---|---|---|---|
| 5 | `diff-a` | block 1 | 1 block | `F'` |
| 6 | `base` | block 6 | 2 blocks | `G`, `H` |

### Keeping the entry count down

Right after merging, `NormalizeMappings` runs over the result and joins any neighbouring entries it safely can. Our five come out untouched, since they alternate between `base` and `diff-a` and no two neighbours share a build.

But say the sandbox had written to blocks 3 and 4 instead of 3 and 5. Then `diff-a` would hold `D'` at block 0 and `E'` at block 1, and the merge would produce two neighbouring entries that do collapse into one:

```text
  before                                    after

  Offset  Length  BuildId  Storage          Offset  Length  BuildId  Storage
       3       1   diff-a        0               3       2   diff-a        0
       4       1   diff-a        1
```

Two entries join when both of these hold:

1. They name the same `BuildId`.
2. Their bytes sit next to each other inside that build's data file, so the second one's `BuildStorageOffset` is exactly where the first one ends.

Without this step the array only ever grows since every snapshot splits entries, and a long-lived sandbox ends up carrying thousands of them.

## Diff chains

What happens when you create a new build off another diff instead of off the original base build?

Let's walk through the same example by resuming the paused sandbox, writing to block 7, and pausing again to upload a new build to S3:

```text
  diff-b  s3://templates/diff-b/rootfs.ext4, 1 block on disk

  blocks:      0
           ┌───────┐
           │  H'   │
           └───────┘

  the virtual image after diff-b's mapping merges over diff-a's

  blocks:      0       1       2       3       4       5       6       7
           ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
           │   A   │   B   │   C   │  D'   │   E   │  F'   │   G   │  H'   │
           └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘
  owner:   └─────────base──────────┴─diff-a┴─base──┴─diff-a┴─base──┴─diff-b┘
```

Now three builds back one filesystem. Reading blocks 3 and 5 opens `diff-a`, block 7 opens `diff-b`, and the other five come from `base`. The guest sees one flat filesystem the whole time.

## The chunker

Now that `build.File` can resolve any virtual offset to a build and a physical offset, we have enough to serve a single read. If we tried to serve all reads like this however each read would turn a few mebibytes into thousands of separate round trips to S3:

```text
  per block                              per 4 MiB chunk

  read block 12 ──> GET ──> 4 KiB        read block 12 ──> GET ──> 4 MiB
  read block 13 ──> GET ──> 4 KiB        read block 13 ──> cache hit
  read block 14 ──> GET ──> 4 KiB        read block 14 ──> cache hit
  ... 1024 times                         ... 1021 more hits

  1024 round trips                       1 round trip
```

To get around this the chunker that reads from S3 thinks in 4 MiB units, which works well for filesystem reads that are typically clustered:

```go
// MemoryChunkSize must always be bigger or equal to the block size.
MemoryChunkSize = 4 * 1024 * 1024 // 4 MB
```
[storage.go:42](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/storage.go#L42)

That trade only works if a reader wanting 4 KiB doesn't have to wait for all 4 MiB to land. So instead of waking everyone when the fetch completes, the chunker tracks how far it's got in an atomic `bytesReady` and releases each reader the moment its own block is written.

Say three readers ask for the same chunk at once, and the fetch reads it from S3 in 16 KiB batches, bumping `bytesReady` after each one:

1. Reader `A` wants a block in batch 0.
2. Reader `B` wants a block in batch 2.
3. Reader `C` wants a block in batch 6.

```text
ONE 4 MiB CHUNK, FETCHED 16 KiB AT A TIME

  batch:          0       1       2       3       4       5       6       7
               ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
               │ done  │ done  │ done  │       │       │       │       │       │
               └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘
                                       ▲  bytesReady = 48 KiB
  reader:          A               B                               C
```

Three batches in `A` and `B` have their bytes and are already gone, while `C` is still parked. Each bump wakes all three readers to compare `bytesReady` against the end of the single block they asked for, so `C` goes straight back to sleep until batch 6 lands.

## The read cache

The data fetched from S3 is stored in a read cache. It's a sparse [memory-mapped file](#memory-mapped-files) the same size as the whole image, so nothing is actually stored on disk until it's added to the read cache.

Next to it sits a bitmap with one bit per block, saying whether that block has been fetched yet:

```text
  the read cache for an 8 GiB image, three blocks in

  block:       0       1       2       3       4       5    ...
           ┌───────┬───────┬───────┬───────┬───────┬───────┐
  bitmap:  │   1   │   0   │   1   │   1   │   0   │   0   │
           └───────┴───────┴───────┴───────┴───────┴───────┘
  on disk:   4 KiB    ---    4 KiB   4 KiB    ---     ---     = 12 KiB allocated
```

Readers use the bitmap to find out which blocks are available in the read cache. After a miss, the chunker hands S3 a slice of the memory-mapped file so reads land directly in the cache.

## The write cache

Let's now take a look at writes, which the sandbox has no ability to do yet. We close that gap with `block.Overlay`, which puts a second [memory-mapped](#memory-mapped-files) write cache in front of the read side per sandbox. It carries a bitmap of its own, this time saying which blocks have been written to.

```go
type Overlay struct {
	device       ReadonlyDevice
	cache        *Cache
	cacheEjected atomic.Bool
	blockSize    int64
}
```
[overlay.go:14](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/orchestrator/pkg/sandbox/block/overlay.go#L14)

Writing is the simple direction. The sandbox drops the blocks into the write cache and marks them dirty in the bitmap.

Reads on the other hand walk down the stack. We check the write cache first and serve the block if its bit is set. Failing that we check the read cache the same way. As a final resort the chunker then fetches from S3 and populates the read cache:

```text
read  block 3 ──> in the write cache?  ──yes──> serve it from there
                        │
                        no
                        ▼
                  read cache ──> chunker ──> object storage

write block 3 ──> write cache only, mark the block dirty
```

Since writes never touch the read cache, the read cache stays byte-identical to the build in S3 for the duration of the sandbox. Two sandboxes on the same build could therefore share one read cache, although E2B keeps them separate anyway. Consider that a small hint about what's coming in Part 3.

## Snapshotting

We've been assuming a pause produces `diff-a`, so let's actually do it. Back at the write cache, the sandbox has written to blocks 3 and 5 which is tracked by the dirty bitmap:

```text
PACKING THE DIRTY BLOCKS INTO A DIFF FILE

  virtual:       0       1       2       3       4       5       6       7
              ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
  dirty bit:  │   0   │   0   │   0   │   1   │   0   │   1   │   0   │   0   │
              └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘
  contents:   │       │       │       │  D'   │       │  F'   │       │       │
                                          │               │
                                          └─> block 0     └─> block 1

  diff file:  ┌───────┬───────┐
              │  D'   │  F'   │
              └───────┴───────┘
  physical:      0       1
```

We then walk over the bitmap in order and copy each dirty block into a fresh file to produce the diff. In the example block 3 goes first and lands at 0 while block 5 goes second and lands at 1.

The bitmap also gives us the header. Each run of set bits becomes one `BuildMap` entry, and the runs get merged onto the parent's mapping and normalized the way we walked through earlier. Uploading the diff file and header then produces `diff-a`.

## Memory-mapped files

Both caches are [memory-mapped](https://man7.org/linux/man-pages/man2/mmap.2.html), which means they're sparse files that don't take up the full image size on the sandbox's disk. The idea is that we ask Linux for a region of our own address space and tell it that region *is* a file. From then on we read and write ordinary memory, and Linux handles everything else.

Two things fall out of that:

1. Nothing is allocated until we touch it. The file claims the image's full size, but only the pages we've actually written cost us any disk.
2. We never call `write(2)`. Writing to memory marks that page dirty, and Linux decides on its own schedule when to push it down to the real file. This is called writeback.

Point 2 is what matters at snapshot time, because when we pause a sandbox its most recent writes are still sitting in memory with nothing on disk to show for them:

```text
  sandbox writes block 5
    │
    ▼
  mmap'd page in memory   <-- dirty, the newest data is here
    │
    │  kernel writeback, whenever it feels like it
    ▼
  cache file on disk      <-- what's actually durable
```

So before copying anything out, E2B calls [`sync_file_range(2)`](https://man7.org/linux/man-pages/man2/sync_file_range.2.html) to tell Linux to start flushing those pages now instead of later. It's a head start rather than a requirement, since the call returns without waiting for the disk and the copy would have seen those dirty pages regardless. Getting writeback moving early just leaves less of it pending once the copy starts, which is why failing this call only logs a warning.

The copy itself has up to a few hundred mebibytes to move into the diff file. The obvious way is to read it into our process and write it back out, which is two full copies of data we never even look at. So E2B uses [`copy_file_range(2)`](https://man7.org/linux/man-pages/man2/copy_file_range.2.html) instead, asking the kernel to do it without the bytes ever entering our program:

```text
  READ + WRITE                        COPY_FILE_RANGE

  cache file                          cache file
      │                                   │
      │  read into our process            │
      ▼                                   │  never leaves
  a buffer we never look at               │  the kernel
      │                                   │
      │  write it back out                │
      ▼                                   ▼
  diff file                           diff file
```

On XFS it does even better and skips the copy altogether, pointing both files at the same underlying blocks so a 500 MiB diff moves no data at all. ext4 has no equivalent, so there the kernel really does copy all 500 MiB, which still beats dragging it through our process twice.

## The two consumers

So far this has all been about one file, the sandbox's disk. But a sandbox actually needs two multi-gigabyte files out of S3 which is why the S3 prefix back at the start had both a `rootfs.ext4` and a `memfile`.

`rootfs.ext4` is the disk, holding the OS and everything the user's code reads or writes. `memfile` is the guest's RAM, and it exists because a sandbox never boots from scratch. It resumes a VM that already finished booting, which means the file holds a running kernel, every process that was alive, and Linux's own page cache of the disk it had already read.

So the split is that `rootfs.ext4` is what's on disk while `memfile` is the state of a machine that has read that disk and finished booting. A disk on its own only gets you something that still has to boot, which is the thirty-second path. Resuming in a second means the CPU picks up mid-stride, and that only works if RAM looks exactly like it did at the moment of the pause.

Firecracker, the hypervisor running the microVM, expects both of these to be ordinary local things. It wants a disk it can do block I/O against, and it wants a file it can map into the guest's RAM. Neither one is actually on the machine, so for each of them something has to catch the guest's access and turn it into a fetch.

Everything we've built so far gets used twice, once per file, with its own header, chunker, and read cache. What differs is only how the guest's access reaches us:

```text
  THE DISK, rootfs.ext4                  GUEST MEMORY, memfile

  guest reads a file                     guest touches a page of RAM
    │                                      │
    ▼  block I/O over NBD                  ▼  a page fault over userfaultfd
    │                                      │
    ▼                                      ▼
  header, chunker, read cache            header, chunker, read cache
  4 KiB blocks                           2 MiB hugepages
```

The disk goes out over NBD, which is how Linux serves a block device from a normal process. The guest sees `/dev/vda` and never knows the difference.

Memory is worth being precise about, since the guest's RAM was never separate from the host's to begin with. Firecracker takes a region of its own memory and tells the CPU that region is the guest's physical RAM. What makes it lazy is that the region starts out empty, with the mapping in place and no actual memory behind it:

```text
  guest reads address 0x4000
    │
    ▼  no memory behind that address yet, so the CPU faults
  the host kernel would normally fill the page itself
    │
    ▼  but the region is registered with userfaultfd,
    │  so the kernel hands us the fault instead
  we resolve it through header, chunker, and read cache
    │
    ▼  and write those bytes into the region
  the guest retries the instruction and the page is there
```

After that the page is ordinary resident memory. The guest reads and writes it at full speed with us nowhere in the path.

### Only the disk gets a write cache

That last point is what splits the two apart. A disk write is block I/O, so it travels out to our process where we can catch it, which is exactly what the write cache does. A memory write travels nowhere, so there's nothing for us to intercept and no write cache to put it in.

Which leaves the question of how a memory snapshot knows what changed. The disk reads its own dirty bitmap, since every write came through us. For memory we ask Firecracker over its API and it hands back a bitmap of the pages the guest touched, because tracking that is the hypervisor's job rather than ours.

## Trade-offs

| | Lazy block fetch | Download the image first |
|---|---|---|
| Time to first read | Milliseconds, one chunk | Tens of seconds, whole image |
| Bytes transferred | Only what's read | Everything |
| Steady-state read latency | Cache hit, or one S3 round trip | Local disk |
| Failure mode | Object storage outage stalls live I/O | Fails before boot |
| Snapshot cost | Dirty blocks only | Full image copy |

In Part 1 of this series we traced one read down from the guest kernel to S3, through snapshotting, and back up again. Between the read and write caches, the header mapping of blocks, and chained builds, we ended up with a copy-on-write filesystem for our sandboxes that's backed entirely by object storage.

If the sandboxes downloaded images on startup instead, it would have taken a lot longer for them to spin up. Reads on the other hand incur a slight S3 round-trip delay, which is a good trade for sandboxes starting in sub-second time. If you have a workload that reads most of the image anyway then the trade goes the other way, since you've paid for the whole download and made it slower on top.

The copy-on-write chaining is the other cost. Our example ended at three builds, so a read consults at most three objects to find a block. Pause a hundred times and it's a hundred, since every pause adds another link and nothing here ever flattens the chain back down.

All of this rests on one thing, which is that the read side never changes. That's what makes it safe to hand a chunk one sandbox fetched to a completely unrelated one, and it's the property that lets the whole thing sit behind a Kubernetes volume. [Part 2](/posts/kubernetes-csi-interface/) covers that interface, and it's much less clever than this.
