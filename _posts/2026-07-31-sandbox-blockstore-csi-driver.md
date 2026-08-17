---
title: "(Pt. 3) sandbox-blockstore: Adapting E2B Block Storage -> CSI"
date: 2026-07-31 11:00:00 -0700
categories: [kubernetes, storage, internals]
tags: [csi, kubernetes, nbd, block-storage, s3, e2b, ext4]
---

> A four-part series on lazy block storage and how it becomes a Kubernetes CSI driver:
> 1. [How E2B block storage works](/posts/e2b-block-storage-layer/)
> 2. [K8s CSI interface](/posts/kubernetes-csi-interface/)
> 3. Adapting E2B block storage into a CSI driver (this post)
> 4. [Optimizing startup performance](/posts/sandbox-blockstore-performance/)
{: .prompt-info }

[Part 1](/posts/e2b-block-storage-layer/) built a filesystem out of S3 objects, and [Part 2](/posts/kubernetes-csi-interface/) worked out that Kubernetes wants seven RPCs and a build ID. So now let's bolt them together and see what breaks.

Surprisingly little, to start with. Our Pod names build `foobar3` in its spec and gets back a writable ext4 mount over a multi-gigabyte image nobody ever downloads. The headers, chunker, and overlay all come across from Part 1 untouched.

## Overview

Let's start with what one Pod's write actually travels through. The double lines are boundaries again, where the first separates the Pod from the host kernel and the second separates the kernel from our driver:

```text
ONE POD ON ONE NODE

  pod writes /work/main.py
       │
       │  an ordinary file write
═══════▼════════════════════════════════  pod above, host kernel below
  ext4, mounted on /dev/nbd7
       │
       │  a block request, over NBD
═══════▼════════════════════════════════  kernel above, our driver below
  dispatch goroutine
       │
       ▼
  block.Overlay ─────> write cache        private to this Pod
       │
       │  not written by this Pod
       ▼
  read cache ──> chunker ──> header        shared across the node
       │
═══════▼════════════════════════════════  node above, S3 below
  s3://templates/foobar3/rootfs.ext4
```

Everything from `block.Overlay` down is Part 1 exactly as it was. In this post we'll build the three layers above it, and every one of them exists because of a single change at the top of that diagram.

## The one thing that changed

In Part 1 the filesystem lived inside a guest kernel. The Pod's filesystem lives in the host kernel instead, which is the same kernel our own driver process runs on:

```text
WHERE THE FILESYSTEM LIVES

  PART 1                                 THIS DRIVER

  ┌─ guest kernel ─────────┐
  │  ext4 on /dev/vda      │             none of this exists
  │  every dirty page here │
  └────────┬───────────────┘
           │  virtio-blk
           ▼
  ┌─ Firecracker ──────────┐
  │  /dev/nbd0 as a file   │
  └────────┬───────────────┘
           │
═══════════▼═══════════════════════════════════════════════════════
  host kernel                            host kernel
    hands the device out                   ext4 on /dev/nbd7
    mounts nothing on it                   every dirty page here
           │  NBD                                 │  NBD
           ▼                                      ▼
  our process                            our process
```

Two boxes disappeared, and everything difficult about this driver comes out of that. Four problems in particular:

1. The host kernel won't accept a Go object as a disk, so we have to hand it something that looks like real hardware.
2. The host kernel now holds our unflushed writes, and it needs us alive to get rid of them.
3. Every Pod on the node shares that one kernel, which means they can share a cache too.
4. Nothing ever pauses a Pod, so nothing tells us when to snapshot it.

So let's follow one mount down that stack from the top, and we'll run into all four on the way.

## Giving the kernel a device it believes in

Firecracker was easy to satisfy. It's a userspace process emulating a machine, so "here's a block device" could mean "here's a Go object with `ReadAt` on it."

The host kernel's ext4 driver won't take that. It wants a device in `/dev` with a major and a minor number, and it wants to issue real block requests against it. [NBD](https://docs.kernel.org/admin-guide/blockdev/nbd.html) is how you fake one:

```text
  ext4 issues a read
       │
       ▼
  /dev/nbd7            the kernel's nbd module publishes this
       │
       │  forwards the request over a Unix socket
       ▼
  our dispatch goroutine ──> block.Overlay
```

So the kernel believes it's talking to hardware, and on the other end of the socket we're serving bytes out of Part 1's overlay.

One socket would be correct and terrible. A single socket carries one request at a time, and every cache miss on our end is an S3 round trip. A cold `git status` would walk several hundred of them back to back. Four sockets let the misses overlap:

```text
  ONE SOCKET                             FOUR SOCKETS

  read ──> S3 ──────> done               read ──> S3 ─────> done
           read ──> S3 ──────> done      read ──> S3 ────> done
                    read ──> S3 ──> ...  read ──> S3 ──────> done
                                         read ──> S3 ───> done

  misses wait in line                    misses overlap
```

Four is the kernel's own default for `nbd`. We never tuned it and never once found it to be the thing we were debugging.

Each socket gets its own dispatch goroutine, and which socket a request lands on isn't round-robin. NBD registers the sockets as [blk-mq](https://docs.kernel.org/block/blk-mq.html) hardware queues and dispatches on the CPU that submitted the request, so reads from one CPU stay on one socket unless that socket dies.

Getting hold of a device is flakier than talking to one. An index that was just released can stay busy for a moment, so `nbdnl.Connect` retries for a few seconds before giving up. The DaemonSet's init container also raises the kernel's device ceiling on the way up:

```sh
modprobe nbd nbds_max=4096 2>/dev/null || test -e /dev/nbd0
```

The `||` covers a node where `nbd` is built into the kernel rather than loadable, in which case `modprobe` fails and the devices are already there.

## Following one read down to S3

Now let's take a single cold read all the way down, because three different batch sizes stack up along the way:

```text
  pod reads 4 KiB at offset 5 MiB
    │
    ▼
  dispatch goroutine                     ── 1. the NBD request, 4 KiB
    │  write cache misses, read cache misses
    ▼
  chunker: which 4 MiB chunk holds 5 MiB?  ── 2. the chunk, 4 MiB
    │  the chunk at 4 MiB. is anyone already fetching it?
    ▼
  fetchMap[4 MiB]
    │  nobody is, so create a session and spawn one fetch
    ▼
  one GetObject, held open across the whole chunk
    ├─ read 512 KiB into the mmap → wake waiters   ── 3. the read batch
    ├─ read 512 KiB into the mmap → wake waiters
    ├─ ... 8 batches to fill 4 MiB
    └─ mark the chunk cached, release everyone
```

The Pod asked for 4 KiB and we fetched 4 MiB, which is Part 1's bet that filesystem reads cluster.

The interesting number is the innermost one. E2B reads its chunks in 16 KiB batches and we raised that to 512 KiB, which sounds like it should mean fewer S3 requests and doesn't. The range reader stays open across batches and only reopens at a mapping boundary, so a 4 MiB chunk inside one contiguous region is one GET whether you read it in 8 batches or 256. What the bigger batch actually buys is 8 rounds of waking up blocked readers instead of 256, and waking a reader 16 KiB sooner was never worth that bookkeeping.

Notice too that only one goroutine in that whole picture ever talks to S3. Twenty Pods hammering the same cold chunk still produce a single fetch, because everyone after the first finds the session already in `fetchMap` and attaches to it:

```text
  socket 0 ─ read ─┐
  socket 1 ─ read ─┤  all miss the
  socket 2 ─ read ─┼─ chunk at 4 MiB ──> fetchMap[4 MiB]
  socket 3 ─ read ─┘                       │
                                           │  first caller creates the session
                                           │  and spawns the fetch. everyone
                                           │  else registers as a waiter.
                                           ▼
                                      one fetch goroutine, one open GET
```

Collapsing twenty readers into one fetch only works if "create a session" and "find the session" can't happen at the same time, so `getOrCreateSession` does the lookup and the insert under one mutex. Whoever loses the race finds a session rather than starting a second GET, and Part 1's waiter machinery releases each reader as its own bytes land.

## Whose dirty pages are these?

Reads were the easy direction. Writes are where the kernel swap starts costing us, and the trouble is that a Pod's write doesn't reach us when the Pod makes it. It lands in the host kernel's page cache and sits there until writeback feels like moving it:

```text
  pod writes 4 KiB
    │
    ▼
  host page cache          dirty, nothing durable yet
    │  writeback, whenever the kernel decides
    ▼
  ext4 ──> /dev/nbd7 ──> NBD socket ──> our dispatch goroutine ──> write cache
```

Nothing on that path is synchronous with the write, and the whole path runs through a device we're holding open. So if we tear down while pages are still dirty, writeback's next flush hits a closed socket, ext4 remounts itself read-only, and those blocks quietly go missing from a diff that uploads and reports success.

Part 1 never had to think about this. Kill the sandbox and the guest's ext4 goes with it, page cache included, so nothing is left holding a reference to anything. Pausing is even better, because guest RAM *is* the memfile:

```text
  PAUSING AN E2B SANDBOX

  guest page cache        ┐
    dirty page for        │  all of this is just guest RAM,
    block 5, unflushed    │  and guest RAM is the memfile
  guest ext4 metadata     ┘
        │
        │  snapshot guest memory to S3
        ▼
  memfile in S3           the dirty page is in there, still dirty

  resume ──> the guest kernel comes back mid-writeback and finishes
```

Nobody had to flush anything, because the unflushed state was itself the thing that got saved. We get none of that, which makes teardown order load-bearing in a way it wasn't before.

Being the block device has one more consequence while we're here, which is that we now own whatever ext4 concludes from our errors. Say the node's disk fills up while a write is landing in the cache. What we return decides what the Pod sees:

```text
  return a generic I/O error        return NBD error 28 (ENOSPC)
    │                                 │
    ▼                                 ▼
  ext4 remounts read-only           ext4 stays mounted
    │                                 │
    ▼                                 ▼
  every write in the Pod            the app gets ENOSPC,
  fails with EROFS                  which it already handles
```

`EROFS` looks nothing like "the node ran out of disk," and it arrives for every process in the Pod at once, including the ones that weren't writing anything.

## Mounting our Pod

With all of that machinery explained, let's actually start the Pod. Kubelet calls `NodePublishVolume`, and the driver spends its first few lines rejecting things. Saying yes to any of them would promise something the layers below can't deliver:

1. Raw `Block` volumes get refused, since there's no raw-block path to hand anyone.
2. Every access mode except `SINGLE_NODE_WRITER` gets refused, since a shared writer would put two Pods on one private write cache and let them diverge without either noticing.
3. Read-only requests get refused, since the overlay builds a write cache no matter what. Accepting one would hand back a writable mount wearing a read-only label.

Past the refusals it pulls `foobar3` out of the `VolumeContext` and calls into an interface that has never heard of CSI:

```go
type Mounter interface {
	Mount(
		ctx context.Context,
		volumeID, templateBuildID, targetPath string,
		checkpointInterval time.Duration,
	) error
	Unmount(ctx context.Context, volumeID, targetPath string) error
}
```

A build ID and a path go in, and Part 1 takes it from there. That interface is the entire translation layer.

`Mount` itself runs eight phases:

```text
  WHERE A MOUNT SPENDS ITS TIME

  1  resolve build ID    "foobar3" ──> a UUID, via a small S3 object   one small GET
  2  read header         GET <prefix>/<build>/rootfs.ext4.header       one GET, KiB
  3  decode header       metadata plus the BuildMap array             microseconds
  4  build read device   a shared cache lease, or a private file      local
  5  prefetch hot set    optional, and all of Part 4                  the only bulk
  6  write overlay       a sparse mmap'd cache, one per volume        local
  7  open NBD device     4 socket pairs and their goroutines          local
  8  mount and bind      ext4 at /mnt/sandboxes/<id>, then bind       two mount(2)

  total on a warm node: under a second, on a multi-gigabyte volume
```

Notice that not one of those eight transfers the image. Two small GETs and six local operations, which is Part 1's entire argument arriving as a sub-second mount.

Phase 1 is why our Pod could write `foobar3` instead of a UUID. An alias is a tiny object holding whichever build ID that name currently points at, so `foobar3` can be repointed at a new build without touching anyone's YAML.

Phase 8 looks like one mount too many until you tear one down. We mount ext4 at our own path and then bind-mount that onto kubelet's target:

```text
  ONE MOUNT                              TWO MOUNTS

  ext4 ──> kubelet's target path         ext4 ──> /mnt/sandboxes/<id>
                                                       │  bind
                                                       ▼
                                                  kubelet's target path

  unpublish tears down the only          unpublish removes the bind mount.
  mount there is, so the block           ext4, NBD, and the write cache
  device has to go with it               all stay exactly where they are
```

Kubelet can call `NodeUnpublishVolume`, get its bind mount removed, and retry as often as it likes without forcing us to disconnect NBD or throw away a write cache holding data that hasn't reached S3.

That retry loop is also why `Mount` takes a per-volume lock before it does anything else. With the lock held it checks whether this volume is already mounted at this target and returns success if so, which is Part 2's idempotency rule. The lock's more important job is keeping a publish retry from interleaving with a concurrent unpublish:

```text
  publish retry                          concurrent unpublish

  sees no mount at target                ── ── ── ── ── ──
  opens /dev/nbd7                        ── ── ── ── ── ──
  ── ── ── ── ── ──                      unmounts the old ext4
  ── ── ── ── ── ──                      disconnects /dev/nbd7
  mounts ext4 on /dev/nbd7               ── ── ── ── ── ──
  ── ── ── ── ── ──                      deletes the volume state
  returns success                        returns success

  both RPCs succeeded. /dev/nbd7 is live, its goroutines are running,
  no mount points at it, and nothing knows it exists
```

Nothing errors and nothing cleans it up, which is the worst shape a leak can have.

## Tearing it down in the right order

Now the teardown we've been building toward. It runs in three phases:

```text
phase 1  quiesce      cancel checkpoints, unmount bind, unmount ext4,
                      close NBD, flush the write cache
phase 2  export       walk the dirty bitmap, copy out a diff file,
                      upload the diff and header to S3
phase 3  cleanup      release the read cache lease, delete the write
                      cache, remove the mount directories
```

Swap two steps inside phase 1 and the dirty-pages problem arrives for real:

```text
  RIGHT ORDER                            WRONG ORDER

  unmount ext4                           close NBD
    │  kernel flushes every                │  the far end is gone
    │  dirty page through NBD              ▼
    ▼                                    unmount ext4
  close NBD                                │  writeback gets EIO
    │  far end is idle now                 ▼
    ▼                                    ext4 remounts read-only
  read the write cache                     │
    │  nothing is still writing            ▼
    ▼                                    read the write cache
  export a complete diff                   │  missing every page that
                                           ▼  hadn't flushed yet
                                         export uploads it anyway
                                         and reports success
```

Two smaller things fall out of the same reasoning. Phase 1 cancels any running checkpoint before it starts waiting, because a checkpoint and a teardown both want the overlay and an unmount that politely waits its turn can block for a full checkpoint interval. And phase 2 runs on a context nothing can cancel, since a snapshot abandoned halfway through has done all of the work and produced nothing.

If phase 2 or 3 fails, the write cache stays on disk so a retry can still export it. That's the difference between a transient S3 error and permanently losing everything the Pod wrote.

## Two bugs the host kernel introduced

Before moving on, two changes to Part 1's code exist purely because the reader is now the host kernel, and the first would have been a data leak.

Part 1's zero blocks come back here. E2B's [`File.ReadAt`](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/orchestrator/pkg/sandbox/build/build.go#L169) walks past a `uuid.Nil` mapping without writing anything, on the documented assumption that the caller handed it an empty buffer. That's true of a freshly allocated buffer and false of ours, because ours is a dispatch buffer recycled through however many previous requests. Skipping the zero-fill would hand a Pod whatever the last write left behind, so we clear the range instead of stepping over it.

The second one is `SIGBUS`, which is what a full disk looks like when your file is [memory-mapped](/posts/e2b-block-storage-layer/#memory-mapped-files). A sparse file has pages in the mapping with no disk block behind them, and the block only gets allocated when something writes there. If the disk is full at that moment there's nothing to allocate:

```text
  without fallocate                      with fallocate

  write to the mmap page                 fallocate the chunk's range
    │                                      │
    ▼                                      ├─ no space? ENOSPC, a
  no block behind it                       │  return value we can map
    │                                      │  to NBD error 28
    ▼                                      ▼
  SIGBUS, which Go can't catch           write to the mmap page
    │                                      │
    ▼                                      ▼
  the daemon dies, and every             the block is already there
  mount on the node dies with it
```

So the chunker calls [`fallocate(2)`](https://man7.org/linux/man-pages/man2/fallocate.2.html) for a chunk's range before the fetch writes into it. Same failure, moved out of a signal Go can't catch and into a return value it can.

## Sharing one cache across the node

Here's where the kernel swap finally pays us back. Every Pod on the node lives above the same kernel and the same driver process, so let's put twenty of them on build `foobar3` and see what a private cache each would cost:

```text
  PRIVATE CACHES                         SHARED CACHE

  Pod A ──> cache A ──> S3               Pod A ──┐
  Pod B ──> cache B ──> S3               Pod B ──┼──> one cache ──> S3
  ...                                    ...     │
  Pod T ──> cache T ──> S3               Pod T ──┘

  20 copies of the same bytes            1 copy
  20x the GETs to fetch them             only the first Pod pays
```

Every one of those redundant requests is for a chunk that some other Pod on the same machine already has on local disk. E2B has no reason to care, since one sandbox is one machine's worth of caching. We do.

Part 1 is what makes this legal. The read side stays byte-identical to S3 for the volume's whole life, so two volumes on one build can point at the same file without either being able to corrupt the other. It collapses the fetch as well as the disk, since twenty Pods reading a cold chunk now land on one `fetchMap` entry.

Which leaves the cache key, where the second of its two fields does the real work:

```go
type SharedReadCacheKey struct {
	buildID      uuid.UUID
	headerDigest [sha256.Size]byte
}
```

A build can be rebuilt under the same ID with a different mapping. Two volumes with different mappings sharing one cache file would read each other's bytes at offsets that mean something else entirely, which is exactly the silent corruption Part 1 kept warning about. Including the header's digest turns that into a cache miss instead, and a cache miss costs one refetch.

The UUID is also narrower than it looks, because it's the *resolved* build. A volume that has checkpointed resolves to the diff it wrote last time rather than the build it started from, so two Pods that both began on `foobar3` and have both checkpointed share nothing. That's fine. The cold fan-out of many fresh Pods onto one build is where sharing was always going to pay:

```text
node

  Pod A (build X) ──┐
  Pod B (build X) ──┼──> lease ──> shared-X-<sha>.readcache   refcount 3
  Pod C (build X) ──┘
  Pod D (build Y) ─────> lease ──> shared-Y-<sha>.readcache   refcount 1

  each Pod still keeps its own private write cache
```

We shipped this behind a flag that defaults to off, so every volume gets a private read cache exactly like E2B's until somebody turns it on. Correctness rests on two volumes agreeing about what every offset means, and we didn't trust the key enough to make that the default.

### Deciding when to throw one away

Refcounts come from leases, and hitting zero doesn't delete anything. The file stays on disk with an idle timestamp, because a build that just lost its last Pod is very likely to get another one. A warm cache is worth more than the disk it sits on.

So something else has to reclaim that disk, and a sweep runs on a timer:

| Flag | Default |
|---|---|
| `--shared-read-cache` | `false` |
| `--shared-read-cache-idle-ttl` | `6h` |
| `--shared-read-cache-sweep-interval` | `1m` |
| `--shared-read-cache-low-watermark-bytes` | 20 GiB |
| `--shared-read-cache-high-watermark-bytes` | 30 GiB |

Idle-expired entries go first, and if usage is still over the high watermark the sweep evicts least-recently-used entries until it's back under the low one. Two watermarks rather than one is what keeps it from evicting a file every single minute.

Measuring that usage has a trap in it, and it's Part 1's sparse files again:

```go
return uint64(stat.Blocks) * 512
```

Every cache file claims to be the full image size, so the obvious field puts a node with three caches at three times the image size no matter how little of it ever landed. The sweep would then evict a file holding a few hundred usable megabytes. Counting allocated blocks instead measures what's actually on disk.

### Surviving a daemon restart

There's a hole in all of this, and it opens every time we ship a new driver. The DaemonSet restarts and the bitmap saying which chunks are present lives in memory, so every shared cache on the node becomes a file full of bytes that nothing believes are there.

So that record has to be on disk as well. Each cache file gets a small sidecar next to it:

```text
shared-<uuid>-<sha256hex>.readcache        sparse, mmap'd, image-sized
shared-<uuid>-<sha256hex>.readcache.state  a header, then 1 byte per chunk
```

The header holds a magic number, the cache key, the image size, and a boot ID, all of which the driver has to agree with before it trusts a single byte after them. Everything past the header is one byte per 4 MiB chunk, so replaying the file on startup means walking an array.

The ordering here matters for the same reason teardown ordering did. `commitChunk` writes the durable byte before marking the chunk cached in memory:

```text
  DISK FIRST                             MEMORY FIRST

  write the completion byte              set the bit in memory
    │                                      │
    ▼  crash here                          ▼  crash here
  set the bit in memory                  write the completion byte

  on restart the chunk reads as          on restart the chunk reads as
  present, and it is                     absent and gets refetched

  a byte on disk with no data            harmless, but in that window
  behind it can never happen             a reader trusts a bit whose
                                         durable record doesn't exist
```

Every ambiguity in that design resolves toward refetching. Only whole chunks get recorded, so a chunk that was mid-fetch when the daemon died reads as absent rather than as a partial write somebody might trust. Deleting a cache removes the state file first, so dying between the two leaves a cache with no state, which reads as empty. One GET is a cheap price for never serving a byte you aren't sure about.

The boot ID does the same job at a coarser grain. It comes from `/proc/sys/kernel/random/boot_id`, which survives a daemon restart and not a node reboot. A restart leaves the filesystem exactly as it was. A reboot loses the page cache along with any writes that hadn't reached disk, and nothing afterwards can work out which chunks made it.

## Checkpointing on a timer

The last consequence is the one we can do least about. Everything our Pod writes lives in a sparse file on one node's local disk, and nothing copies it anywhere.

Part 1 didn't have this problem, because a sandbox gets paused on purpose and the pause is what triggers the export. Pods don't get paused. They get evicted, or their node gets drained, or kubelet decides they're unhealthy, and not one of those waits for anybody to snapshot anything.

So the export runs on a timer instead:

```text
t=0      mount, write cache empty
t=5m     checkpoint: dirty blocks ──> a diff object
                     dirty bitmap ──> a merged header ──> generation 1
t=10m    checkpoint: generation 2
...
unmount  the final export, generation N
```

The interval comes from the Pod's `volumeAttributes` when it sets one, and otherwise from the daemon's default of an hour. A negative value at either level turns checkpoints off for workloads that genuinely don't care.

Every checkpoint mints a build ID and writes a header pointing back through every previous generation. That's Part 1's diff chain again, built one hour at a time rather than one pause at a time, and it accumulates faster than anyone expects:

```text
  A WEEK OF HOURLY CHECKPOINTS

  gen 0    base build
  gen 1    diff ──> 1 object a read might reach into
  gen 2    diff
  ...
  gen 168  diff ──> a cold read now resolves through a mapping
                    stitched from up to 169 different objects
```

Nothing in this driver flattens that chain, so an hourly interval is a bet that the volume gets deleted before its mapping gets expensive. No amount of caching fixes a read that has to consult 169 places to find out where a block lives.

## What a node pays per Pod

After all of that machinery, the bill for one Pod is small enough to be boring:

| Resource | Count |
|---|---|
| Write cache file | 1, sparse, grows with writes |
| Read device | 1 private, or 1 lease on a shared cache |
| NBD device index | 1 |
| Unix socket pairs | 4 (8 file descriptors) |
| Dispatch goroutines | 4 |
| ext4 mount point | 1 |
| Bind mount | 1 |

The NBD index pool runs out long before memory does, which is why the default pool is 256 and the init container raises the kernel ceiling to 4096.

The DaemonSet manifest carries four things a normal workload's wouldn't:

1. `privileged: true` for mounting, with `Bidirectional` propagation on both `/mnt/sandboxes` and `/var/lib/kubelet`. Part 2's silent empty directory lives here.
2. `hostPID: true`, so orphan recovery can look up which process owns an NBD device.
3. `priorityClassName: system-node-critical`. Evict the driver and the node can't start any Pod that needs a volume, including whatever the replacement driver depends on.
4. `GOMEMLIMIT` set under the container limit, so Go's GC gets aggressive before the kernel's OOM killer does. An OOM kill here takes every mount on the node with it.

## Trade-offs

| | This driver | A normal PVC on a network disk |
|---|---|---|
| Time to a usable mount | Under a second, header only | Provision, attach, mount |
| Node storage for N Pods on one build | 1 read cache plus N write caches | N full volumes |
| Read latency, cold | S3 round trip, 4 MiB granularity | Disk or network disk latency |
| Read latency, warm | Local page cache | Same |
| Blast radius of the driver dying | Every mount on the node | Volumes survive |
| Durability of writes | Only as good as the checkpoint interval | Continuous |

In this post we swapped one kernel for another, and paid for it four times over:

1. An NBD server, so the host kernel would accept a device from us at all.
2. A teardown order that gets its dirty pages to S3 before we close the socket.
3. One read cache shared across every Pod on the node.
4. Snapshots on a timer, because nothing ever pauses a Pod.

Blast radius is the cost that actually keeps you up. Those dispatch goroutines aren't serving the block device, they *are* the block device. A dead DaemonSet Pod means every `/dev/nbdN` on the node stops answering at once and every ext4 mount above them starts throwing I/O errors. A CSI driver for a network-attached disk can crash, restart, and find its volumes where it left them. This one can't, and no amount of care inside the driver changes that.

Durability has the same shape, where writes are safe up to the last checkpoint and speculative after it. That's a fine deal for a disposable view of a build when anything worth keeping gets pushed to a real store, and a bad one for a database.

Then there's the problem this whole design was supposed to fix and only half fixed. A cold read still costs an S3 round trip, landing wherever the workload happens to touch a chunk nobody fetched yet. The worst version is a Pod kubelet has already reported as `Ready`, sitting there looking healthy, about to spend the first minute of its first real request blocking on object storage. [Part 4](/posts/sandbox-blockstore-performance/) goes after that from both ends.
