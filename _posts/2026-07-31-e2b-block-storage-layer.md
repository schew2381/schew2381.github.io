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

`build.File` can resolve any virtual offset to a build and a physical offset, which is enough to serve a read and nowhere near enough to serve a filesystem. Fetching each block individually would turn a few mebibytes of reading into thousands of separate round trips to S3:

```text
  per block                              per 4 MiB chunk

  read block 12 ──> GET ──> 4 KiB        read block 12 ──> GET ──> 4 MiB
  read block 13 ──> GET ──> 4 KiB        read block 13 ──> cache hit
  read block 14 ──> GET ──> 4 KiB        read block 14 ──> cache hit
  ... 1024 times                         ... 1021 more hits

  1024 round trips                       1 round trip
```

Filesystem reads tend to cluster, so the chunker refuses to think in blocks and instead works in 4 MiB units:

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

Three batches in, `A` and `B` have their bytes and are already gone, while `C` is still parked. Each bump wakes all three readers to compare `bytesReady` against the end of the single block they asked for, so `C` goes straight back to sleep until batch 6 lands.

## The read cache

A cached chunk lives in one file per device, the same size as the whole image. It's a sparse file so that size is only a claim, and nothing gets allocated on disk until something writes to it.

Next to it sits a bitmap with one bit per block, saying whether that block has been fetched yet:

```text
  the read cache for an 8 GiB image, three blocks in

  block:       0       1       2       3       4       5    ...
           ┌───────┬───────┬───────┬───────┬───────┬───────┐
  bitmap:  │   1   │   0   │   1   │   1   │   0   │   0   │
           └───────┴───────┴───────┴───────┴───────┴───────┘
  on disk:   4 KiB    ---    4 KiB   4 KiB    ---     ---     = 12 KiB allocated
```

That bitmap is how a reader finds out it has to go fetch something, since asking for a block whose bit is 0 returns a `BytesNotAvailableError` rather than a buffer of zeros. The file is also memory-mapped, so the chunker hands S3 a slice of the mapping and the bytes land straight in the cache with no copy in between.

## Copy-on-write using the write cache

None of this is writable yet. The chunker and read cache serve reads out of immutable objects, and a sandbox that can't write to its own filesystem isn't much of a sandbox. `block.Overlay` closes that gap by putting a second cache in front of the read side, this one private to a single sandbox:

```go
type Overlay struct {
	device       ReadonlyDevice
	cache        *Cache
	cacheEjected atomic.Bool
	blockSize    int64
}
```
[overlay.go:14](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/orchestrator/pkg/sandbox/block/overlay.go#L14)

A read checks the write cache one block at a time, taking `BytesNotAvailableError` as permission to fall through to the read cache underneath. A write doesn't fall through at all, since it just puts the bytes in the write cache and stops:

```text
read  block 3 ──> in the write cache?  ──yes──> serve it from there
                        │
                        no
                        ▼
                  read cache ──> chunker ──> object storage

write block 3 ──> write cache only, mark the block dirty
```

So writes never reach the read cache, which means it stays byte-identical to S3 for the sandbox's whole life. Two sandboxes on the same build could therefore share one read cache and stay perfectly isolated, since each one's writes land in its own private cache. E2B keeps them separate anyway, and Part 3 is where we stop doing that.

## The two consumers

So far this has all been about one file, the sandbox's disk. But a sandbox actually needs two multi-gigabyte files out of S3, and that's why the S3 prefix back at the start had both a `rootfs.ext4` and a `memfile`.

`rootfs.ext4` is the disk, holding the OS and everything the user's code reads or writes. `memfile` is the guest's RAM, and it exists because a sandbox never boots from scratch. It resumes a VM that already finished booting, which means the file holds a running kernel, every process that was alive, and Linux's own page cache of the disk it had already read.

So the split is that `rootfs.ext4` is what's on disk while `memfile` is the state of a machine that has read that disk and finished booting. A disk on its own only gets you something that still has to boot, which is the thirty-second path. Resuming in a second means the CPU picks up mid-stride, and that only works if RAM looks exactly like it did at the moment of the pause.

Firecracker is the hypervisor running the microVM, and it expects both of these to be ordinary local things. It wants a disk it can do block I/O against and a file it can map into the guest's memory, but neither one is actually on the machine. So in both cases something has to sit underneath and turn the guest's access into a fetch:

```text
  THE DISK                               GUEST MEMORY

  guest reads a file                     guest touches a page of RAM
    │                                      │
    ▼  looks like a normal disk            ▼  page isn't really there yet
  /dev/vda                               the kernel raises a page fault
    │                                      │
    ▼  which is really a network           ▼  our handler catches the fault
    │  block device we serve               │  and fills the page in
    └──────────────┬───────────────────────┘
                   ▼
             block.Overlay
       same headers, same chunker, same cache

  4 KiB blocks                           2 MiB blocks (hugepages)
```

The disk gets served over NBD, which is Linux's protocol for making a network block device look local. Memory gets served over userfaultfd, a Linux feature that lets a normal program handle page faults itself. Two unrelated mechanisms landing on the same overlay, where the only difference underneath is the block size. Memory sits on hugepages and works in 2 MiB units while the disk uses 4 KiB.

Part 3 adds a third consumer that E2B doesn't have: the host kernel's own ext4 driver.

## Snapshotting

We've been assuming a pause produces `diff-a`, so let's actually do it. Back at the write cache, the sandbox has written to blocks 3 and 5, and the dirty bitmap knows exactly that:

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

Walking the bitmap in order and copying each dirty block into a fresh file gives us the diff, and it's that walk order that decides the physical offsets. Block 3 goes first so it lands at 0, block 5 goes second so it lands at 1. Those are exactly the `BuildStorageOffset` values from the worked example, and they come out that way because the copy happened in that order.

The bitmap gives us the header too. Each run of set bits becomes one `BuildMap` entry, and the runs get merged onto the parent's mapping and normalized the way we walked through earlier. Upload the diff file and the header, and `diff-a` exists.

One free case falls out of this. A block the sandbox zeroed gets a `BuildId` of `uuid.Nil`, which tells the reader to zero-fill without opening any object at all. So a sandbox that filled 2 GiB of scratch space and deleted it again uploads one mapping entry and no bytes.

### Where the dirty pages actually are

The write cache is [mmap'd](https://man7.org/linux/man-pages/man2/mmap.2.html), which means the sandbox writes to it by writing to memory rather than by calling `write(2)`. Those writes dirty a page of the kernel's page cache, and the kernel pushes them down to the file whenever writeback feels like getting to it.

Copying the diff out reads that file through an ordinary file descriptor, so the timing matters:

```text
  sandbox writes block 5
    │
    ▼
  mmap'd page in memory   <-- dirty, the real data is here
    │
    │  kernel writeback, whenever it feels like it
    ▼
  cache file on disk      <-- what a file descriptor sees
```

So E2B nudges writeback along with [`sync_file_range(2)`](https://man7.org/linux/man-pages/man2/sync_file_range.2.html) before the copy, which starts flushing the dirty pages without waiting for the disk to confirm anything. It's treated as an optimization rather than a correctness step, since the copy reads through the page cache anyway and sees dirty pages whether or not they've reached the platter. Failing it logs a warning and carries on.

The copy itself uses [`copy_file_range(2)`](https://man7.org/linux/man-pages/man2/copy_file_range.2.html), which moves bytes between two file descriptors entirely inside the kernel rather than reading them into the process and writing them back out. On XFS it goes further and makes the two files share the same blocks, so a 500 MiB diff moves no data at all. ext4 can't do that, so there the kernel really does copy 500 MiB. Either way it beats two trips through userspace for bytes nobody looks at.

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
