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

Here's `diff-a`'s own mapping, with the virtual offset on the left and the physical one on the right:

```text
BuildMap[0] = {Offset: 3, Length: 1, BuildId: diff-a, BuildStorageOffset: 0}
BuildMap[1] = {Offset: 5, Length: 1, BuildId: diff-a, BuildStorageOffset: 1}
```

That covers two blocks out of eight. If you ask this mapping about block 2 it has nothing to say, which is why it can't serve a read on its own.

### Merging

So now we have two mappings that each describe part of the image, and neither one can serve a read by itself. Pausing the sandbox is where they get combined: [`MergeMappings`](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/header/mapping.go#L78) takes the parent's mapping and the new diff's, and returns one mapping covering all eight blocks with no gaps. That merged result is what gets written as `diff-a`'s header.

It walks the two mappings in lockstep, holding one entry from each side and asking how the two overlap. There are only six answers, since two runs on a line can either miss each other or overlap in one of four ways. The grid below is the same six blocks in every case, so the bars are directly comparable:

```text
A BASE ENTRY MEETING A DIFF ENTRY, ALL SIX WAYS

  block:        0       1       2       3       4       5
             ┌───────┬───────┬───────┬───────┬───────┬───────┐

  1  no overlap
  base       └──── base ─────┘
  diff                                       └──── diff ─────┘
  merged     └──── base ─────┘
  carried                                    └──── diff ─────┘
             base ends before the diff begins, so nothing can overwrite it

  2  no overlap, reversed
  base                                       └──── base ─────┘
  diff       └──── diff ─────┘
  merged     └──── diff ─────┘
  carried                                    └──── base ─────┘
             same shape, and now it's the diff that's finished

  3  base inside diff
  base                       └──── base ─────┘
  diff               └──────────── diff ─────────────┘
  merged     nothing yet
  carried            └──────────── diff ─────────────┘
             the diff owns every block base did, so base is dropped

  4  diff inside base
  base       └──────────────────── base ─────────────────────┘
  diff                       └──── diff ─────┘
  merged     └──── base ─────┴──── diff ─────┘
  carried                                    └──── base ─────┘
             base splits around the diff, and its right half is carried

  5  diff over base's left
  base                       └──────────── base ─────────────┘
  diff       └──────────── diff ─────────────┘
  merged     └──────────── diff ─────────────┘
  carried                                    └──── base ─────┘
             base loses blocks 2 and 3 and keeps only what the diff missed

  6  diff over base's right
  base       └──────────── base ─────────────┘
  diff                       └──────────── diff ─────────────┘
  merged     └──── base ─────┘
  carried                    └──────────── diff ─────────────┘
             base keeps its left, and the diff isn't finished yet
```

The `carried` row is what makes this work. An entry is only safe to write once nothing further right can overwrite it, so whichever side reaches further stays behind for the next comparison, trimmed down to the part still uncovered.

Our eight blocks only ever hit case 4, once per dirty block, and it's the case worth walking through anyway because it's the one that splits an entry. So let's take them one at a time, starting with `D'` at block 3:

```text
step 1, one base entry covering everything

  block:       0       1       2       3       4       5       6       7
           ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
           │   A   │   B   │   C   │   D   │   E   │   F   │   G   │   H   │
           └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘
  owner:   └─────────────────────────────base──────────────────────────────┘
  entry:   └───────────────────────────────0───────────────────────────────┘

step 2, diff-a's block 3 lands inside it and splits it

  block:       0       1       2       3       4       5       6       7
           ┌───────┬───────┬───────┬───────┬───────┬───────┬───────┬───────┐
           │   A   │   B   │   C   │  D'   │   E   │   F   │   G   │   H   │
           └───────┴───────┴───────┴───────┴───────┴───────┴───────┴───────┘
  owner:   └─────────base──────────┴─diff──┴─────────────base──────────────┘
  entry:   └───────────0───────────┴───1───┴───────────────2───────────────┘
                                               ▲
                                               │  physical offset
                                               │  advanced to 4,
                                               │  not left at 0

step 3, diff-a's block 5 splits the right piece again

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

Entry 4 is where a bug would live. It starts at virtual block 6, and its physical block has to be 6 as well. That's where `G` actually sits inside the base data file. Copy the original entry's physical 0 into the right-hand piece instead and reads of blocks 6 and 7 quietly come back as `A` and `B`.

So the split has to advance the physical offset by exactly as much virtual space as it skipped over:

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

Both offsets move by the same `rightBaseShift`, which is the invariant the whole format rests on. If it breaks, reads silently start returning other people's data without raising any errors.

### Reading one block

Those five entries are sorted and cover the image with no gaps between them, so any block you name is owned by exactly one of them. Finding that one entry is the whole read path, and it comes down to asking which entry is the last one starting at or before the block we want.

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

An index of 0 would mean the address sits below the first entry, which can't happen in a gapless mapping. So it's an error rather than an index of -1.

Entry 3 is `diff-a` at physical block 1, and our request starts exactly where the entry does, so `shift` is 0. `GetShiftedMapping` wraps all of that up and hands the caller three things:

```text
  which build        diff-a
  physical offset    block 1 + shift 0   =   block 1
  length available   1 block - shift 0   =   1 block
```

Read that as: open `s3://templates/diff-a/rootfs.ext4` and take one block starting at block 1. Those bytes are `F'`. Ask for block 6 instead and the same search lands on entry 4, giving physical block 6 of the base file, which is `G`. Same call, different object, and the caller never had to know which.

That third value is the one that's easy to ignore and expensive to get wrong. A caller asking for four blocks starting at block 5 gets told one block is available, because block 6 lives in a different S3 object entirely. It has to stop at the boundary, resolve again, and fetch the rest from the base file. Every layer above this one loops for that reason, and Part 3 gets to skip the loop by indexing its cache differently.

### Keeping the entry count down

A build ID of `uuid.Nil` is the cheap case, meaning the range is all zeros with no object to open, so the reader zero-fills the buffer and moves on. A sandbox that wiped a gigabyte of scratch space uploads one mapping entry and no bytes at all for it, and it still reads back as zeros.

Everything else accumulates. That entry array grows by a few entries per snapshot until a long-lived sandbox is carrying thousands of them. `NormalizeMappings` joins neighbours to keep the count down, on a condition stricter than sharing a build ID. Their physical offsets have to line up too:

```go
storageContiguous := mp.BuildId == ignoreBuildID ||
	mp.BuildStorageOffset == current.BuildStorageOffset+current.Length
if mp.BuildId == current.BuildId && storageContiguous {
	current.Length += mp.Length
```
[mapping.go:256](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/header/mapping.go#L256)

Sitting next to each other in the virtual image says nothing about sitting next to each other in a packed data file. Picture one `base` entry covering virtual blocks 0 through 2 from physical 0, and the next covering virtual block 3 from physical 9. Adjacent virtually, six blocks apart physically, so a joined entry would send that last read to physical 3 and hand back the wrong contents. Same failure as a bad split, and just as silent.

So the format comes down to a metadata record, a sorted array, and a binary search with a `- 1` on the end, and it buys considerably more than the eight blocks it took to explain.

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

Reading block 3 opens `diff-a`, block 7 opens `diff-b`, and the other six come from the base build. The guest sees one flat filesystem and has no idea it's a view stitched from three objects, none of which were rewritten to make it happen.

Each pause bumps `Generation`, mints a new `BuildID`, and leaves `BaseBuildID` pointing at the root. Any header therefore knows both who it is and where its chain started, which is what a rebase pass would need to flatten a long chain back into one object.

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

Zero blocks take the `uuid.Nil` path from earlier. A sandbox that filled 2 GiB of scratch space and then deleted it uploads nothing for that range. The mapping entry says "this range is zeros" instead of object storage holding 2 GiB of them.

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
