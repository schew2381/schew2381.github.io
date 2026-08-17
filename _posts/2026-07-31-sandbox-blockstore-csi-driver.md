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

[Part 1](/posts/e2b-block-storage-layer/) ended on the property that makes any of this legal, which is that the read side never changes. Then [Part 2](/posts/kubernetes-csi-interface/) came down to a build ID in a Pod spec and one `NodePublishVolume` call. Now what breaks when you bolt them together?

Surprisingly little, to start with. E2B serves its block device to a Firecracker guest kernel and we serve the same device to the host kernel instead, so the headers, chunker, and overlay all come over untouched. Our Pod names build `foobar3` in its spec and gets back a writable ext4 mount over a multi-gigabyte image nobody ever downloads.

Everything that does break traces back to that one swap, because the kernel doing the I/O is now the kernel the driver itself runs on.

So let's take that Pod through its mount and write a file through it. Then we'll tear the mount down in the wrong order and watch a diff reach S3 with pages missing and no error anywhere.

## Overview

Let's start with the whole node, once three Pods are running off build `foobar3`. The double lines mark boundaries again, where the first separates the Pods from the host kernel and the second separates the kernel from our driver:

```text
ONE NODE, THREE PODS ON THE SAME BUILD

     pod A            pod B            pod C
       │                │                │         bind mount
═══════▼════════════════▼════════════════▼══════════════════════
 host kernel
      ext4             ext4             ext4
   /dev/nbd7        /dev/nbd8        /dev/nbd9
       │                │                │         NBD, 4 sockets each
═══════▼════════════════▼════════════════▼══════════════════════
 CSI DaemonSet, one process for the whole node
   overlay A        overlay B        overlay C
    ┌──┴────┐        ┌──┴────┐        ┌──┴────┐
    ▼       │        ▼       │        ▼       │
┌───────┐   │    ┌───────┐   │    ┌───────┐   │
│ write │   │    │ write │   │    │ write │   │      PER POD, private
│cache A│   │    │cache B│   │    │cache C│   │      dirty blocks only
└───────┘   │    └───────┘   │    └───────┘   │
            │                │                │
            └────────────────┴────────────────┘
                             ▼
                   ┌──────────────────┐
                   │ read cache       │      PER NODE, shared
                   │ one per build    │      immutable, S3-identical
                   └─────────┬────────┘
                             │  4 MiB range GET
                             ▼
                   ┌──────────────────┐
                   │ S3 build         │
                   │ rootfs.ext4      │
                   └──────────────────┘
```

Everything from `overlay` downward is Part 1 unchanged. Everything above it is new, and it's three things: a CSI driver, an NBD server, and a mount lifecycle that has to survive kubelet retrying it at any point.

The shape of the diagram is the payoff from Part 1's overlay split. Writes are private, so Pod A dirtying a page moves nothing else on the node. Reads are shared, so when Pod A touches a block nobody has fetched yet and drags in the surrounding 4 MiB, Pods B and C get every block in that chunk for free.

In this post we'll walk down that diagram, from the CSI calls at the top to the shared cache at the bottom.

## What the driver actually implements

Starting at the top, the driver's entire job is translation. Kubernetes speaks in volume IDs and target paths while Part 1 speaks in build IDs and offsets. The Node service converts one into the other and hands off to an interface that has never heard of CSI:

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

A build ID and a path go in, and Part 1 takes it from there. What's interesting is what the driver refuses on the way, because each refusal is a promise the storage layer underneath can't keep:

1. Raw `Block` capabilities, since there's no raw-block path to hand anyone.
2. Any access mode except `SINGLE_NODE_WRITER`, since a shared writer would put two Pods on one private write cache and let them diverge without either noticing.
3. Read-only requests, since the overlay builds a write cache no matter what. Saying yes would return a writable mount wearing a read-only label.

Past the refusals it needs `templateBuildID` in the `VolumeContext`, takes an optional `checkpointInterval`, and calls `Mount`.

Only two other Node RPCs do anything, and both are about kubelet rather than about storage. `NodeGetCapabilities` returns an empty list, which is how a driver declines staging, and Part 2 covers why that's the only option available to an ephemeral inline volume. `NodeUnpublishVolume` maps `lifecycle.ErrNotMounted` to success, which is Part 2's rule about the honest answer leaving Pods wedged in `Terminating`.

Everything else returns `Unimplemented`, and that includes almost all of the Controller. It exists only for the PVC path, and even there it provisions nothing at all. `CreateVolume` mints a volume ID and records it in a map, `DeleteVolume` drops the entry, and neither one allocates or frees a single byte.

In practice almost nothing uses that path anyway. Pods declare the volume inline, exactly as Part 2 described, and the Controller never runs:

```yaml
volumes:
  - name: codebase
    csi:
      driver: sandbox-blockstore.csi.dev
      volumeAttributes:
        templateBuildID: "foobar3"
        checkpointInterval: "5m"
```

So everything interesting happens inside that one `Mount` call, on one node, with no cluster-level object to consult. And the first thing it has to get right isn't a Kubernetes question at all.

## Which kernel holds the dirty pages

Back in Part 1 the dirty pages lived inside the guest, where they died with the VM. Firecracker held `/dev/nbd0` open as an ordinary file and handed it to the guest as `/dev/vda`, so the host kernel provided the device and never mounted anything on it. Two kernels were in play, and only the inner one was running a filesystem.

Take the VM away and one kernel does both jobs:

```text
E2B                                    THIS DRIVER

  guest kernel                           (no guest)
    ext4 on /dev/vda
    dirty pages live here
        │  virtio-blk
        ▼
  Firecracker process
    holds /dev/nbd0 open as a file
        │  ordinary reads and writes on that fd
════════│═══════════════════════       ══════════════════════════════
  host kernel                            host kernel
    /dev/nbd0, nothing mounted             ext4 on /dev/nbd7
    no dirty pages of its own              dirty pages live here
        │  NBD                                 │  NBD
════════▼═══════════════════════       ════════▼═════════════════════
  dispatch → overlay → caches            dispatch → overlay → caches
        │                                      │
        ▼                                      ▼
   the driver                            the driver
```

Whichever kernel holds those pages is the one that has to still be alive to flush them, which here is the kernel the driver itself depends on.

That difference lets E2B be careless in a way we can't. Kill the VM and the guest's ext4 goes with it, page cache included, so nothing is left holding a reference to `/dev/nbd0` and teardown can happen whenever it likes. Pausing is better still, because guest RAM *is* the memfile:

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

  resume ──> guest kernel comes back mid-writeback and finishes the job
```

Nobody had to flush anything, because the unflushed state was itself the thing that got saved.

We get none of that, because our dirty pages outlive the thing that would clean them up. A Pod's write lands in host ext4's page cache, and its only route to S3 runs through a device the driver is holding open:

```text
  pod writes 4 KiB
    │
    ▼
  host page cache      dirty, not durable yet
    │  writeback, whenever the kernel feels like it
    ▼
  ext4 → /dev/nbd7 → NBD socket → dispatch goroutine → write cache
```

Nothing on that path is synchronous with the write. If you tear down while pages are still dirty, writeback's next flush hits a closed socket and ext4 remounts itself read-only. Those blocks then go missing from a diff that uploads without reporting a single error. That's why unmount order is load-bearing, and why the ENOSPC mapping matters more than an error code usually would.

## NBD, because the host kernel needs a real device

Which raises the question of how the host kernel gets a block device out of us at all. Firecracker was easy to satisfy, since it's a userspace process emulating a machine and "here's a block device" could mean "here's an object with `ReadAt` on it." The host kernel's ext4 driver has no such flexibility. It wants a device in `/dev` with a major and a minor number, and it wants to issue real requests against it.

[NBD](https://docs.kernel.org/admin-guide/blockdev/nbd.html) is how you fake one. The kernel's `nbd` module publishes `/dev/nbdN`, takes block requests from the filesystem above it, and forwards each one over a socket to whatever userspace process is listening. Our driver is what's listening, so every read our Pod's ext4 issues arrives as bytes on a Unix socket inside the DaemonSet, gets served out of the overlay, and goes back the same way.

Each device gets four socket pairs, wired up over netlink:

```go
const connections = 4
```

Four and not one, because every cache miss on the far end is an S3 round trip and one socket means one request outstanding at a time:

```text
  ONE SOCKET                             FOUR SOCKETS

  read ──> S3 ──────> done               read ──> S3 ─────> done
           read ──> S3 ──────> done      read ──> S3 ────> done
                    read ──> S3 ──> ...  read ──> S3 ──────> done
                                         read ──> S3 ───> done

  a cold git status walks several        the same misses overlap
  hundred round trips in series
```

We picked four because it's the kernel's own default for `nbd`, never tuned it, and never once found it to be the thing we were debugging.

Each pair gets a dispatch goroutine reading a 28-byte request header off the wire and writing a 16-byte reply. Both start with a magic number, so a desynchronized stream fails loudly instead of reading garbage as an offset:

```go
const (
	NBDRequestMagic  = 0x25609513
	NBDResponseMagic = 0x67446698
)
```

```text
one NBD device

/dev/nbd7 ──┬── socket pair 0 ──> goroutine 0 ──┐
            ├── socket pair 1 ──> goroutine 1 ──┤
            ├── socket pair 2 ──> goroutine 2 ──┼──> block.Overlay
            └── socket pair 3 ──> goroutine 3 ──┘

per request: 28-byte header in, 16-byte reply out
```

Which of the four a request takes isn't round-robin. NBD registers the sockets as [blk-mq](https://docs.kernel.org/block/blk-mq.html) hardware queues, one per connection, and dispatches on the queue number blk-mq hands it. That number comes from the CPU that submitted the request. Reads from one CPU stay on one socket, and the kernel only picks another when a socket is dead.

Each dispatch buffer starts at 4 MiB and grows to a 32 MiB cap for large writes, then shrinks back. In a DaemonSet under `GOMEMLIMIT`, one Pod doing a big write shouldn't permanently raise the floor for every other Pod on the node.

### Getting a device in the first place

The protocol turned out to be the easy part. Getting hold of a device at all is flakier, because an index that was just released can stay busy for a moment. So `nbdnl.Connect` retries up to 100 times at 25 ms intervals. `EINVAL` is the one error it won't retry, since bad arguments don't get better with waiting. Indices come out of a pool sized by `--nbd-pool-size`, default 256. That's above the kernel's own ceiling, so the DaemonSet's init container raises it:

```sh
modprobe nbd nbds_max=4096 2>/dev/null || test -e /dev/nbd0
```

The `|| test -e /dev/nbd0` covers a node where `nbd` is built into the kernel rather than loadable, in which case `modprobe` fails and the devices are already there.

## Three layers of batching

Notice that none of those four goroutines talk to S3 themselves. So let's follow one cold read all the way down, which is where the driver's three stacked batch sizes come from:

```text
  pod reads 4 KiB at offset 5 MiB
    │
    ▼
  dispatch goroutine, one of four        ── 1. NBD request, 4 KiB
    │  overlay: write cache misses, read cache misses
    ▼
  chunker: which 4 MiB chunk holds 5 MiB?  ── 2. chunk, 4 MiB
    │  chunk at 4 MiB. is someone already fetching it?
    ▼
  fetchMap[4 MiB]
    │  no session, so create one and spawn ONE fetch goroutine
    ▼
  runFetch: one GetObject over the chunk, held open
    ├─ read 512 KiB into the mmap → wake waiters   ── 3. read batch
    ├─ read 512 KiB into the mmap → wake waiters
    ├─ ... 8 batches to fill 4 MiB
    └─ mark chunk cached, release everyone
```

The Pod asked for 4 KiB and the driver fetched 4 MiB, which is the bet from Part 1. Filesystem reads cluster, so the next request is probably inside the chunk you just paid for.

That fetch goroutine is the only thing in the picture touching S3, and everything else either serves out of the mmap or waits. Which means the goroutine count doesn't scale the way the socket count suggests:

```text
  4 dispatch goroutines per device       consumers, one per socket
  1 fetch goroutine per in-flight chunk  the only S3 caller
```

Twenty Pods hammering the same chunk still produce one fetch, because the second through twentieth callers find the session already sitting in `fetchMap` and attach to it instead:

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

Collapsing those twenty readers into one fetch means "create a session" and "find the existing session" can't be two decisions. `getOrCreateSession` does the lookup and the insert under one `sync.Mutex`, so whoever loses the race finds a session instead of starting a second GET. Part 1's waiter machinery handles the rest from there, releasing each reader as its own bytes land rather than when the chunk finishes.

### ENOSPC instead of a read-only filesystem

One more thing falls out of being the block device, which is that we now own whatever the filesystem concludes from our errors. Return the wrong errno from the dispatch layer and ext4 gives up on the whole mount:

```go
const NBDErrNoSpace = 28
```

Say the node's disk fills up while a write is landing in the cache. What we return decides what the Pod sees:

```text
  node disk full, write into the cache fails

  return generic I/O error          return NBD error 28
    │                                 │
    ▼                                 ▼
  ext4 remounts read-only           ext4 stays mounted
    │                                 │
    ▼                                 ▼
  every write in the Pod            app gets ENOSPC
  fails with EROFS                  which it already handles
```

`EROFS` looks nothing like "the node ran out of disk," and it arrives for every process in the Pod at once, including ones that weren't writing anything.

## The mount lifecycle

So let's actually start our Pod. `MountManager.Mount` runs eight phases, each timed separately:

```text
  WHERE A MOUNT SPENDS ITS TIME

  1  resolve build ID    alias file in S3, or the literal UUID      one small GET
  2  read header         GET <prefix>/<build>/rootfs.ext4.header    one GET, KiB
  3  decode header       little-endian metadata + BuildMap array    microseconds
  4  build read device   shared cache lease, or a private file      local
  5  prefetch hot set    optional, see Part 4                       the only bulk
  6  write overlay       sparse mmap'd cache, one per volume        local
  7  open NBD device     4 socket pairs, dispatch goroutines        local
  8  mount and bind      ext4 at /mnt/sandboxes/<id>, then bind     two mount(2)

  total on a warm node: under a second, on a multi-gigabyte volume
```

Notice that none of the eight transfers the image. Two small GETs and six local operations, which is Part 1's whole argument showing up as a sub-second mount.

Phase 1 is why our Pod could say `foobar3` rather than a UUID. An alias is a small object in the bucket holding whichever build ID that name currently points at, so `foobar3` can be repointed at a new build without touching any Pod's YAML. A spec naming the UUID outright skips the lookup.

Phase 8 does two mounts, which looks like one too many until you tear one down. The driver mounts ext4 at its own path under `/mnt/sandboxes/<volume-id>` and then bind-mounts that onto kubelet's target, and the second mount is what lets kubelet's retry loop touch nothing that matters:

```text
  ONE MOUNT                              TWO MOUNTS

  ext4 ──> kubelet's target path         ext4 ──> /mnt/sandboxes/<id>
                                                       │  bind
                                                       ▼
                                                  kubelet's target path

  unpublish tears down the only          unpublish removes the bind mount.
  mount there is, so the block           ext4, NBD, and the unexported
  device has to go with it               write cache all stay put
```

Kubelet can call `NodeUnpublishVolume`, get its bind mount removed, and retry as often as it likes. None of that forces the driver to disconnect NBD or throw away a write cache holding data that hasn't reached S3 yet.

Every phase lands in the same log line as its own `...Ms` field, from `resolveBuildIDMs` through `bindMountMs`, with `totalMs` at the end. That's a small thing that pays for itself the first time a mount takes nine seconds, because the answer is in the log instead of in a profiler you have to attach to a DaemonSet.

### Publishing twice

Kubelet retries, so all eight phases have to be safe to start over from the top. `Mount` takes a per-volume lock before it does anything else:

```go
if err := m.volumeOperations.lock(ctx, volumeID); err != nil {
	return err
}
```

With the lock held it checks whether this volume is already mounted at this target and returns nil if so. The exception is a volume that's mid-teardown, which errors instead, because returning success would hand kubelet a mount that's in the process of disappearing.

Serializing on the volume ID does the more important job, though, which is keeping a publish retry from interleaving with a concurrent unpublish:

```text
  publish retry                          concurrent unpublish

  sees no mount at target                ── ── ── ── ── ──
  opens /dev/nbd3                        ── ── ── ── ── ──
  ── ── ── ── ── ──                      unmounts the old ext4
  ── ── ── ── ── ──                      disconnects /dev/nbd3
  mounts ext4 on /dev/nbd3               ── ── ── ── ── ──
  ── ── ── ── ── ──                      deletes the volume state
  returns success                        returns success

  both RPCs succeeded. /dev/nbd3 is live, its dispatch goroutines are
  running, no mount points at it, and nothing knows it exists
```

Nothing errors and nothing cleans it up. That's the worst shape a leak can have.

The mount's background context comes out of two calls that look like they cancel each other out:

```go
bgCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
```

Kubelet's gRPC context dies the moment `NodePublishVolume` returns, and the dispatch goroutines have to outlive that by definition. Inheriting the request context would cancel the block device as soon as the mount succeeded, so the background work gets a fresh context that the mount manager cancels on its own schedule.

### Unmount in three phases

Which brings us to the teardown we promised to get wrong. It runs in three phases:

```text
phase 1  quiesce      cancel checkpoints, unmount bind, unmount ext4,
                      close NBD, flush the write cache
phase 2  export       walk the dirty bitmap, sendfile to a diff file,
                      upload the diff + header to S3
phase 3  cleanup      release the read cache lease, delete the write
                      cache, remove mount directories
```

That order isn't stylistic. Swap the first two steps of phase 1 and the dirty-pages problem from earlier shows up for real:

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
                                         export uploads it anyway,
                                         reports success
```

Phase 1 also cancels any periodic checkpoint before it starts waiting. A checkpoint and a teardown both want the overlay, and an unmount that politely waits its turn can block for a full checkpoint interval.

Phase 2 runs on `context.WithoutCancel`, since a snapshot cancelled halfway through has done all of the work and produced nothing.

If phase 2 or 3 fails, the write cache stays on disk so a retry can export it. That's the difference between a transient S3 error and permanently losing everything the Pod wrote.

## What we deleted

Not everything from Part 1 survived the port, and the biggest casualty is worth understanding because it comes back later in a different shape.

E2B's [`DiffStore`](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/orchestrator/pkg/sandbox/build/cache.go#L42) caches chunkers, one per S3 object, and evicts them on disk usage. That's the right design for an orchestrator, where many sandboxes on one node reach into overlapping sets of build objects and caching per object genuinely pays.

Each of our mounts resolves one header into one virtual address space and gets a single chunker over the whole thing, so there's nothing left to index per object.

Indexing by virtual offset instead has a nice side effect. A 4 MiB chunk straddling a mapping boundary becomes one cache entry filled from two different S3 objects, and nothing above the chunker ever finds out. So `DiffStore` went, along with its TTL eviction and pending-delete accounting.

The other change is a number. We raised the read batch from E2B's 16 KiB default to 512 KiB:

```go
const cachedDeviceMinReadBatch = 512 * 1024
```

That's the size of each read off the open S3 body while a fetch fills its 4 MiB chunk, and it decides how granular the waiter notifications are:

```text
FILLING ONE 4 MiB CHUNK

  16 KiB batches                        512 KiB batches

  ├─ read 16 KiB  → notify              ├─ read 512 KiB → notify
  ├─ read 16 KiB  → notify              ├─ read 512 KiB → notify
  ├─ ... 256 total                      ├─ ... 8 total
  └─ done                               └─ done

  a blocked reader wakes sooner         fewer, larger reads
  ~256 build.File.ReadAt calls          ~8 build.File.ReadAt calls
```

What the batch size does *not* control is the S3 request count. The range reader stays open across batches and reopens only at a header mapping boundary. A 4 MiB chunk inside one contiguous region is one GET whether you read it in 8 batches or 256.

So 512 KiB buys fewer lock-and-notify cycles, not fewer requests. Waking a reader 16 KiB early is a latency win that's mostly already banked by 512 KiB, and the notification bookkeeping is pure overhead past that point.

## What we had to harden

Two more changes exist purely because the kernel doing the I/O is now the host's, and the first one would have been a data leak.

Part 1's zero blocks come back here. E2B's [`File.ReadAt`](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/orchestrator/pkg/sandbox/build/build.go#L169) walks past a `uuid.Nil` mapping without writing anything, on the documented assumption that the caller handed it an empty slice. That's true of a freshly allocated buffer and false of ours, because our buffer is a dispatch buffer that's been recycled through however many previous requests. Skipping the zero-fill would hand a Pod whatever the last write through that buffer happened to leave behind, so we `clear()` the range instead of advancing past it.

The second one is `SIGBUS`, which is what a full disk looks like when your file is [memory-mapped](https://man7.org/linux/man-pages/man2/mmap.2.html). Remember that the caches are sparse, so a page can exist in the mapping with no disk block behind it and the block only gets allocated when something writes there. If the disk is full at that moment there's nothing to allocate, and the kernel raises a signal rather than returning an error:

```text
WRITING INTO A SPARSE MMAP ON A FULL DISK

  without fallocate                      with fallocate

  write to mmap page                     fallocate(chunk range)
    │                                      │
    ▼                                      ├─ no space? → ENOSPC return
  no block behind it                       │              → NBD error 28
    │                                      │              → app sees ENOSPC
    ▼                                      ▼
  SIGBUS, uncatchable in Go              write to mmap page
    │                                      │
    ▼                                      ▼
  daemon dies                            block is already there
  every mount on the node dies
```

So the chunker calls [`fallocate(2)`](https://man7.org/linux/man-pages/man2/fallocate.2.html) for the chunk's range before the fetch writes into it. Same failure, moved from a signal Go can't catch into a return value it can.

Two syscall swaps round it out, and neither is deep. [`sendfile(2)`](https://man7.org/linux/man-pages/man2/sendfile.2.html) replaces `copy_file_range` for diff export, since it doesn't care whether the two files live on the same filesystem. Part 1's reflink optimization needs XFS, which these nodes don't run. And `unix.Mount` replaces `exec.Command("mount", ...)`, which drops a process spawn from a path that runs on every publish and turns a parsed stderr string into an actual errno.

## The node-shared read cache

Here's where the sharing `DiffStore` used to do comes back, in a form that fits Kubernetes better.

Go back to our node, but with twenty Pods on build `foobar3` instead of three. Without sharing, the waste is hard to miss:

```text
  PRIVATE CACHES                         SHARED CACHE

  Pod A ──> cache A ──> S3               Pod A ──┐
  Pod B ──> cache B ──> S3               Pod B ──┼──> one cache ──> S3
  ...                                    ...     │
  Pod T ──> cache T ──> S3               Pod T ──┘

  20 copies of the same bytes            1 copy
  20x the GETs to fetch them             only the first Pod pays
```

Every one of those redundant requests is for a chunk that some other Pod on the same machine already has sitting on local disk.

None of that waste is inherent. E2B just scopes its read cache to a single sandbox, and it has no reason not to.

For us the read side stays byte-identical to S3 for the volume's whole life, which is the property from Part 1 that makes one cache file legal to share. So `SharedReadCache` refcounts a single file across every volume on the node resolving to the same build.

That collapses the fetch and not just the disk, since twenty Pods reading a cold chunk now land on one `fetchMap` entry in one chunker.

Getting the cache key right is the whole game here, and it has two fields:

```go
type SharedReadCacheKey struct {
	buildID      uuid.UUID
	headerDigest [sha256.Size]byte
}
```

A build UUID plus the SHA-256 of the serialized header, and the digest is the part that isn't obvious. A build can be rebuilt under the same ID with a different mapping, and two volumes with different mappings sharing one cache file would read each other's data at offsets that mean something else entirely. That's precisely the silent corruption Part 1 kept warning about, and including the digest turns it into a cache miss instead, which costs one refetch.

The UUID is the *resolved* build, which is narrower than it sounds. A volume that has checkpointed resolves to the diff it wrote last time rather than the build it started from. So two Pods that both began on `foobar3` and have both checkpointed end up with different keys and share nothing, which is fine. The cold fan-out of many fresh Pods onto one build is where sharing was always going to pay.

```text
node

  Pod A (build X) ──┐
  Pod B (build X) ──┼──> lease ──> shared-X-<sha>.readcache   refcount 3
  Pod C (build X) ──┘
  Pod D (build Y) ─────> lease ──> shared-Y-<sha>.readcache   refcount 1

  each Pod keeps its own private write cache
```

### Deciding when to throw one away

Those refcounts come from `AcquireForVolume` handing back a lease and `release` dropping it. Hitting zero doesn't delete anything, though. The file stays on disk with an idle timestamp, because a build that just lost its last Pod is very likely to get another one. A warm cache is worth more than the disk it sits on.

Which means something else has to reclaim the disk eventually, so a sweep runs on a timer:

| Flag | Default |
|---|---|
| `--shared-read-cache` | `false` |
| `--shared-read-cache-idle-ttl` | `6h` |
| `--shared-read-cache-sweep-interval` | `1m` |
| `--shared-read-cache-low-watermark-bytes` | 20 GiB |
| `--shared-read-cache-high-watermark-bytes` | 30 GiB |

Idle-expired entries go first. If usage is still over the high watermark after that, it evicts least-recently-used entries until it's back under the low one. Two watermarks instead of one is what keeps the sweep from evicting a file every single minute.

We shipped sharing behind a flag that defaults to off, so every volume gets its own private read cache exactly like E2B's until somebody turns it on. Correctness rests on two volumes agreeing about what every offset means, and we didn't trust the key enough to make that the default.

The sweep measures usage with one `stat` call, and the obvious field is the wrong one:

```go
return uint64(stat.Blocks) * 512
```

That's the physical size rather than the logical one. Every cache file claims to be the full image size, so `stat.Size` puts a node with three 8 GiB caches at 24 GiB no matter how little of it ever landed. The sweep then evicts a file holding 200 MiB of genuinely useful data, which is Part 1's sparse-file gap arriving as a bug you can ship.

### Surviving a daemon restart

There's a hole in all of this, and it opens every time we ship a new version of the driver. The DaemonSet restarts and the bitmap recording which chunks are present lives in memory, so every shared cache on the node becomes a file full of bytes that nothing believes are there.

Which means the completion record has to be on disk as well. `readCacheState` is a sidecar file next to each cache, opening with 96 bytes the driver has to agree with before it reads anything else.

Those bytes are a magic `SBRCST01`, the cache key, the image size, and a boot ID. Everything after them is one byte per chunk, so replaying the file means walking an array.

```text
shared-<uuid>-<sha256hex>.readcache        sparse, mmap'd, image-sized
shared-<uuid>-<sha256hex>.readcache.state  96-byte header + 1 byte/chunk
```

`commitChunk` writes the completion byte to disk before marking the chunk cached in memory, which keeps the durable record from ever trailing the in-memory one:

```text
  DISK FIRST                             MEMORY FIRST

  write completion byte                  set bit in memory
    │                                      │
    ▼  crash here                          ▼  crash here
  set bit in memory                      write completion byte

  on restart: chunk reads as             on restart: chunk reads as
  present, and it is                     absent, refetched. harmless.

  the bad case is impossible:            ...but during the window, a
  a byte on disk with no data            reader trusts a bit whose
  behind it never happens                durable record doesn't exist
```

On reopen the header gets validated field by field against what the driver expects, and every completed chunk is replayed into a fresh bitmap:

```go
if completionState != nil {
	for off := int64(0); off < size; off += storage.MemoryChunkSize {
		chunkIndex := uint64(off / storage.MemoryChunkSize)
		if completionState.Completed(chunkIndex) {
			chunker.cache.setIsCached(off, min(int64(storage.MemoryChunkSize), size-off))
		}
	}
}
```

Every ambiguity in that design resolves toward refetching. Only whole chunks get recorded, so a chunk that was mid-fetch when the daemon died reads as absent rather than as a partial write someone might trust. Deletion removes the state file before the cache file, so dying between the two leaves a cache with no state, which reads as empty. One GET is a cheap price for never serving a byte you aren't sure about.

The boot ID does the same job at a coarser grain. It comes from `/proc/sys/kernel/random/boot_id`, so a daemon restart preserves it and a node reboot doesn't. That distinction matters because a restart leaves the filesystem exactly as it was. A reboot loses the page cache and any writes that hadn't reached disk, and nothing afterwards can work out which chunks made it.

Orphan reaping closes the last gap, and it runs at startup before the driver will accept a single mount. It looks for cache files matching the driver's naming scheme with no live volume behind them, which is what a Pod that died alongside the daemon leaves behind. With sharing enabled it uses a variant that spares shared caches, since a shared cache with no current lease isn't an orphan. It's the warm cache the next Pod is about to want.

## Checkpoints

One thing we haven't dealt with is that everything our Pod writes lives in a sparse file on one node's local disk, and nothing ever copies it anywhere. Lose the node and you lose the work.

Part 1 didn't have this problem, because a sandbox gets paused on purpose and the pause is what triggers the export. Pods don't get paused. They get evicted, or their node gets drained, or kubelet decides they're unhealthy, and not one of those waits for anybody to snapshot anything.

So the export runs on a timer instead:

```text
t=0      mount, write cache empty
t=5m     checkpoint: dirty blocks ──> sendfile ──> diff object
                     dirty bitmap ──> merged header ──> generation 1
t=10m    checkpoint: generation 2
...
unmount  final export, generation N
```

The interval resolves in preference order:

1. `checkpointInterval` in the Pod's `volumeAttributes`, when the Pod sets one.
2. The daemon's `--checkpoint-interval`, default `1h`.

A negative value at either level turns checkpoints off, for workloads that genuinely don't care. `beginCheckpoint` bails out if a checkpoint is already running or the volume is tearing down, which is the other half of the interlock from the unmount section.

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

The NBD index pool is what runs out first, long before memory does. That's why the default pool is 256 and the init container raises the kernel ceiling to 4096.

The DaemonSet manifest carries four things a normal workload's wouldn't:

1. `privileged: true` for mounting, with `Bidirectional` propagation on both `/mnt/sandboxes` and `/var/lib/kubelet`. Part 2's silent-empty-directory failure lives here.
2. `hostPID: true`, so orphan recovery can look up which process owns an NBD device through `/proc/<pid>`.
3. `priorityClassName: system-node-critical`. Evict the driver and the node can't start any Pod that needs a volume, which includes whatever the replacement driver depends on.
4. `GOMEMLIMIT` set under the container limit, so Go's GC gets aggressive before the kernel OOM-killer does. An OOM kill here takes every mount on the node with it.

## Trade-offs

| | This driver | A normal PVC on a network disk |
|---|---|---|
| Time to a usable mount | Under a second, header only | Provision, attach, mount |
| Node storage for N Pods on one build | 1 read cache plus N write caches | N full volumes |
| Read latency, cold | S3 round trip, 4 MiB granularity | Disk or network disk latency |
| Read latency, warm | Local page cache | Same |
| Blast radius of the driver dying | Every mount on the node | Volumes survive |
| Durability of writes | Only as good as the checkpoint interval | Continuous |

In this post we took one Pod from a build ID in its spec down to a mounted ext4 filesystem, and everything from `overlay` down came over from Part 1 untouched. All we had to build were the three layers above it. A CSI translation layer, an NBD server so the host kernel gets a device it recognises, and a mount lifecycle careful enough that kubelet can retry any part of it.

Blast radius is the cost that actually keeps you up. Those dispatch goroutines aren't serving the block device, they *are* the block device. A dead DaemonSet Pod means every `/dev/nbdN` on the node stops answering at once and every ext4 mount above them starts throwing I/O errors. A CSI driver for a network-attached disk can crash, restart, and find its volumes where it left them. This one can't, and no amount of care inside the driver changes that.

Durability has the same shape, where writes are safe up to the last checkpoint and speculative after it. That's a fine deal for a disposable view of a build when anything worth keeping gets pushed to a real store, and a bad one for a database.

Then there's the problem this whole design was supposed to fix and only half fixed. A cold read still costs an S3 round trip, landing wherever the workload happens to touch a chunk nobody fetched yet. The worst version is a Pod kubelet has already reported as `Ready`, sitting there looking healthy, about to spend the first minute of its first real request blocking on object storage. [Part 4](/posts/sandbox-blockstore-performance/) goes after that from both ends.
