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

Parts 1 and 2 are the two halves of this. Bolt them together and a Pod names a template build ID in its own spec, then gets back a writable ext4 mount over a multi-gigabyte image nobody ever downloads.

One substitution does most of the work. E2B serves its block device to a Firecracker guest kernel, and we serve the same device to the host kernel instead. Headers, chunker, overlay: all of Part 1 comes over untouched.

That substitution is also where the trouble starts, because the kernel doing the I/O is now the kernel the driver itself runs on. There's a whole section below on what that costs.

## Overview

```text
ONE NODE, THREE PODS ON THE SAME TEMPLATE

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
                   │ S3 template      │
                   │ rootfs.ext4      │
                   └──────────────────┘
```

Three write caches and one read cache, all inside one process, and the node is where every S3 request originates. Pod A writing a file dirties a page in write cache A and nothing else on the node moves. Pod A reading a block nobody has fetched yet drags in the whole surrounding 4 MiB chunk, and from then on Pods B and C get every block in that chunk for free.

That asymmetry is exactly what Part 1's overlay split was worth. The expensive resource is shareable because the read side never diverges from S3, so it lives at node scope, while the mutable one stays private per Pod. Everything from `overlay` down is Part 1 unchanged, and everything above it is new: a CSI driver, an NBD server, and a mount lifecycle that has to survive kubelet retrying it at any point.

## What the driver actually implements

The Node service is mostly refusals. It validates the request and then hands off to an interface that has never heard of CSI:

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

That's the seam. Kubernetes above it, Part 1 below it, and the driver's job is translating one vocabulary into the other.

The refusals are the interesting half, since each one is a promise the storage layer underneath can't keep. `NodePublishVolume` turns down raw Block capabilities, because there's no raw-block path to hand anyone. It turns down every access mode except `SINGLE_NODE_WRITER`, because a shared writer would put two Pods on one private write cache and let them diverge without either noticing. And it turns down read-only requests, because the overlay builds a write cache no matter what, so saying yes would mean returning a writable mount wearing a read-only label.

What survives all that is short. `templateBuildID` has to be in the `VolumeContext`, `checkpointInterval` is optional and goes through `time.ParseDuration`, and then `Mount` runs.

Two more Node RPCs do real work, and both are about kubelet's behavior rather than about storage. `NodeGetCapabilities` returns an empty list, which declines staging. Part 2 covers why that's the only option: these are ephemeral inline volumes, and kubelet's `CanDeviceMount` returns false for those before staging is ever considered. The sharing this driver does have sits a level below anything Kubernetes models, inside the read cache, keyed by template rather than by volume.

`NodeUnpublishVolume` maps `lifecycle.ErrNotMounted` to success, which is Part 2's rule about the honest answer leaving Pods wedged in `Terminating`.

Everything else returns `Unimplemented`, including most of the Controller. The Controller only exists for the PVC path, and even there it provisions nothing:

- `CreateVolume` requires a `templateBuildID` StorageClass parameter, mints a volume ID, and records it in a `sync.Map` with `LoadOrStore`. `LoadOrStore` and not load-then-store, because two concurrent calls for the same name both pass a load-then-store check and mint different UUIDs.
- `DeleteVolume` drops the map entry. There's nothing to deprovision. Nothing was ever allocated.
- `ControllerGetCapabilities` advertises `CREATE_DELETE_VOLUME` and nothing else.

The `CSIDriver` object switches off the rest of Kubernetes' machinery:

```yaml
spec:
  attachRequired: false
  podInfoOnMount: true
  volumeLifecycleModes:
    - Ephemeral
```

In practice almost nothing uses the PVC path. Pods declare the volume inline and the Controller never runs:

```yaml
volumes:
  - name: codebase
    csi:
      driver: sandbox-blockstore.csi.dev
      volumeAttributes:
        templateBuildID: "build-python39-v1"
        checkpointInterval: "5m"
```

Everything interesting therefore happens inside `Mount`, on one node, with no cluster-level object to consult. And the first thing `Mount` has to get right isn't a Kubernetes question at all.

## Which kernel holds the dirty pages

Part 1's overview said the guest kernel runs ext4, owns every dirty page, and dies with the VM. Read that again, because it means two kernels are in play, not one. Firecracker opens `/dev/nbd0` as an ordinary file and hands it to the guest as `/dev/vda`, so the host kernel provides the device and then stays out of the way. It never mounts a filesystem on it. The guest kernel is the one running ext4, and the dirty pages of every write the sandbox makes sit in the guest's page cache, inside guest RAM.

Take that VM away and one kernel does both jobs:

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

The dirty pages moved from a box that dies on its own into the same kernel the driver depends on, and that's the whole difference.

E2B gets to be careless in a way this driver can't. Kill the VM and the guest's ext4 goes with it, page cache included, so nothing is left holding a reference to `/dev/nbd0` and teardown can happen whenever it likes. Pausing is better still, because guest RAM *is* the memfile:

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

Here the dirty pages outlive the thing that would clean them up. A pod's write lands in host ext4's page cache, and its only route to S3 runs through a device the driver is holding open:

```text
  pod writes 4 KiB
    │
    ▼
  host page cache      dirty, not durable yet
    │  writeback, whenever the kernel feels like it
    ▼
  ext4 → /dev/nbd7 → NBD socket → dispatch goroutine → write cache
```

Nothing on that path is synchronous with the write. Tear down while pages are still dirty and writeback's next flush hits a closed socket, ext4 remounts itself read-only, and those blocks are missing from a diff that uploads without reporting a single error. That's why unmount order is load-bearing, and why the ENOSPC mapping below matters more than an error code usually would.

## NBD, because the host kernel needs a real device

Firecracker will take a file path. It's a userspace process emulating a machine, so "here's a block device" can mean "here's an object with `ReadAt` on it." The host kernel's ext4 driver has no such flexibility. It wants a block device in `/dev`, with a major and a minor number, and it wants to issue real requests against it.

[NBD](https://docs.kernel.org/admin-guide/blockdev/nbd.html) is how you fake one. The kernel's `nbd` module publishes `/dev/nbdN`, accepts block requests from the filesystem above, and forwards each one over a socket to whatever userspace process is listening. The driver listens. Every read the Pod's ext4 issues arrives as bytes on a Unix socket inside the DaemonSet, gets served out of the overlay, and goes back the same way.

Four socket pairs per device, wired up over netlink:

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

Four is a guess that held up rather than a tuned number, and it's the kernel's own default for `nbd`.

Each pair gets a dispatch goroutine reading a 28-byte request header off the wire and writing a 16-byte reply, both of which start with a magic number that exists so a desynchronized stream fails loudly rather than reading garbage as an offset:

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

Which of the four a request takes isn't round-robin. NBD registers the sockets as [blk-mq](https://docs.kernel.org/block/blk-mq.html) hardware queues, one per connection, and dispatches on the queue number blk-mq hands it, which comes from the CPU that submitted the request. Reads from one CPU stay on one socket, and the kernel only picks another when a socket is dead.

### Getting a device in the first place

Dispatch buffers start at 4 MiB and grow to a 32 MiB cap for large writes, then shrink back, because in a DaemonSet under `GOMEMLIMIT` one Pod doing a big write shouldn't permanently raise the floor for every other Pod on the node.

Acquiring the device is flakier than the protocol. `nbdnl.Connect` retries up to 100 times at 25 ms intervals, because an index that was just released can stay busy for a moment, and it deliberately doesn't retry `EINVAL`, since that means the arguments are wrong and waiting won't fix them. Indices come out of a pool sized by `--nbd-pool-size`, default 256, which is above the kernel's own ceiling, so the DaemonSet's init container raises it:

```sh
modprobe nbd nbds_max=4096 2>/dev/null || test -e /dev/nbd0
```

The `|| test -e /dev/nbd0` covers a node where `nbd` is built into the kernel rather than loadable, in which case `modprobe` fails and the devices are already there.

### Three layers of batching

Those four goroutines never talk to S3. Following one cold read down is the clearest way to see why the driver ends up with three different batch sizes stacked on top of each other:

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

The Pod asked for 4 KiB and the driver fetched 4 MiB, which is the bet from Part 1: filesystem reads cluster, so the next request is probably inside the chunk you just paid for.

The fetch goroutine is the only thing in this picture that touches S3. Everything else either serves out of the mmap or waits. So the goroutine count doesn't scale the way you'd guess from the socket count:

```text
  4 dispatch goroutines per device       consumers, one per socket
  1 fetch goroutine per in-flight chunk  the only S3 caller
```

Twenty Pods hammering the same chunk still produce one fetch, because the second through twentieth callers find the session already in `fetchMap` and attach to it. That's the coalescing:

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

### The Go primitives underneath

Twenty readers all missing the same chunk have to collapse into one fetch, which means "create a session" and "find the existing session" can't be two separate decisions. So `fetchMap` is a plain `map[int64]*fetchSession` keyed by chunk offset, and `getOrCreateSession` does the lookup and the insert under one `sync.Mutex`. Whoever loses the race finds a session instead of starting a second GET.

Once a reader has a session it needs somewhere to park, and a `chan error` of capacity 1 per waiter gives it two ways out of a single `select`:

```go
select {
case err := <-w.ch:
	return err
case <-ctx.Done():
	return ctx.Err()
}
```

The context case is what lets a Pod's cancelled read walk away from a fetch that's still running. The buffering is what keeps `notifyWaiters` from blocking while holding the session lock.

Waiting isn't always necessary, though, which is where the third primitive comes in. `bytesReady` is an `atomic.Int64` counting bytes from the start of the chunk that are fully written and cached, and it only ever increases. That monotonicity buys a lock-free fast path:

```go
if s.bytesReady.Load() >= endByte {
	return nil
}
```

A reader whose bytes have already landed returns without touching the mutex at all. Waiters are kept sorted by the byte offset they need, so `notifyWaiters` closes channels from the front of the slice and stops at the first waiter that isn't satisfied yet:

```text
  bytesReady ──────────────────>

  waiters sorted by the byte they need
    ├─ needs 512 KiB   ✓ closed, reader returns
    ├─ needs 1 MiB     ✓ closed, reader returns
    ├─ needs 2 MiB     ← stop here, bytesReady is 1.5 MiB
    └─ needs 4 MiB
```

Closing a channel rather than sending on it is deliberate, since a close wakes every receiver and needs no value. A reader that only wanted the first block of the chunk gets released after the first 512 KiB batch instead of waiting out all eight.

One subtlety in the fetch itself:

```go
go c.runFetch(context.WithoutCancel(ctx), s)
```

The fetch inherits the first caller's context for tracing but not its cancellation, because that caller giving up shouldn't strand the nineteen readers waiting behind it. The session is deleted from `fetchMap` in a `defer`, and the chunk gets marked cached *before* that delete, so a late arriver either finds the session or finds the data and never falls between the two.

### ENOSPC instead of a read-only filesystem

One error code in the dispatch layer is worth the paragraph:

```go
const NBDErrNoSpace = 28
```

Being the block device means owning what the filesystem concludes from your errors:

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

Everything up to here is machinery. `MountManager.Mount` is the thing that runs when a Pod actually starts, and it's eight phases, each of them timed:

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

  total on a warm node: under a second, on an 8 GiB volume
```

Nothing in those eight transfers the image. Two small GETs and six local operations, which is Part 1's argument showing up as a sub-second mount on a multi-gigabyte volume.

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

Kubelet can call `NodeUnpublishVolume`, get its bind mount removed, and retry the call as often as it likes without any of that forcing the driver to disconnect NBD or throw away a write cache holding data that hasn't reached S3 yet.

All eight phases land in one log line as `resolveBuildIDMs`, `headerReadMs`, `headerDecodeMs`, `readDeviceMs`, `startupPrefetchMs`, `writeOverlayMs`, `nbdOpenMs`, `ext4MountMs`, `bindMountMs`, and `totalMs`. That's a small thing that pays for itself the first time a mount takes nine seconds, because the answer is in the log instead of in a profiler you have to attach to a DaemonSet.

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

Nothing errors and nothing cleans it up, which is the worst shape a leak can have.

One line in the setup deserves an explanation, since it looks like a mistake:

```go
bgCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
```

Kubelet's gRPC context dies the moment `NodePublishVolume` returns, and the dispatch goroutines have to outlive that by definition. Inheriting the request context would cancel the block device as soon as the mount succeeded, so the background work gets a fresh context that the mount manager cancels on its own schedule.

### Unmount in three phases

```text
phase 1  quiesce      cancel checkpoints, unmount bind, unmount ext4,
                      close NBD, flush the write cache
phase 2  export       walk the dirty bitmap, sendfile to a diff file,
                      upload the diff + header to S3
phase 3  cleanup      release the read cache lease, delete the write
                      cache, remove mount directories
```

The ordering isn't stylistic, and getting it backwards is the failure from the dirty-pages section arriving in code:

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

Phase 1 also cancels any periodic checkpoint before it starts waiting, since a checkpoint and a teardown both want the overlay and an unmount that politely waits its turn can block for a full checkpoint interval.

Phase 2 runs on `context.WithoutCancel`. A snapshot cancelled halfway has done all the work and produced nothing.

If phase 2 or 3 fails, the write cache stays on disk so a retry can export it. That's the difference between a transient S3 error and permanently losing everything the Pod wrote.

## What had to change

The read path came over intact, so the diff against E2B is small, and it splits cleanly. Kubernetes hands you a different sharing shape than an orchestrator does, which lets things go, and a live host kernel is a far less forgiving consumer than a guest you're about to destroy anyway, which adds them back.

### The simplifications

E2B's [`DiffStore`](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/orchestrator/pkg/sandbox/build/cache.go#L42) keeps a `ttlcache` of chunkers, one per S3 object, evicted on disk usage percentage. That's correct for an orchestrator where many sandboxes on one node reach into overlapping sets of build objects, and there's real value in caching at the object level.

The CSI driver doesn't have that shape. Each mount resolves one header into one virtual address space, so it gets one chunker over the whole thing:

Indexing the cache file by virtual offset instead of by object has a pleasant side effect. A 4 MiB chunk that straddles a mapping boundary is one cache entry, filled by reads from two different S3 objects, and nothing above the chunker has to know that happened. `DiffStore` goes away, along with its TTL eviction and its pending-delete accounting, and the sharing it provided comes back later in a different form.

The read batch got bigger, from E2B's 16 KiB default to 512 KiB:

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

What the batch size does *not* control is the S3 request count. The range reader stays open across batches and reopens only at a header mapping boundary, so a 4 MiB chunk inside one contiguous region is one GET whether you read it in 8 batches or 256.

So 512 KiB buys fewer lock-and-notify cycles, not fewer requests. Waking a reader 16 KiB early is a latency win that's mostly already banked by 512 KiB, and the notification bookkeeping is pure overhead past that point.

### The hardening

Three changes exist purely because the kernel doing the I/O is now the host's.

Start with the one that would be a data leak. E2B's [`File.ReadAt`](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/orchestrator/pkg/sandbox/build/build.go#L169) walks past a `uuid.Nil` mapping without writing anything, with a comment noting that the caller's slice has to start empty. That's fine for a freshly allocated buffer, and it isn't true for NBD, where the buffer is a dispatch buffer that's been recycled through however many previous requests. Skipping the zero-fill there means a read of a zero range hands back whatever the last write through that buffer left in it, so the driver calls `clear()` on the range instead of advancing past it.

Then there's `SIGBUS`, which is what a full disk looks like when your file is [mmap'd](https://man7.org/linux/man-pages/man2/mmap.2.html). Cache files are sparse, so a page can exist in the mapping with no disk block behind it, and the block gets allocated when something writes there. If the disk is full at that moment there's nothing to allocate and the kernel signals instead of returning an error:

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

Close ordering had to invert, which is the dirty-pages problem arriving as code. Flush ext4, unmount it, and only then disconnect NBD, in the order the diagram in "Unmount in three phases" lays out.

[`NormalizeMappings`](https://github.com/e2b-dev/infra/blob/da099cf305df080abd16b964ff8b664736ee6d34/packages/shared/pkg/storage/header/mapping.go#L245) got stricter too. E2B merges adjacent entries that share a `BuildId`, and the driver additionally requires their `BuildStorageOffset` values to be contiguous, because two ranges that sit next to each other virtually but not physically would give the merged entry arithmetic that points into the wrong part of the packed file. Same class of mistake as the split arithmetic in Part 1, and the same symptom, which is no error and wrong bytes.

Two syscall swaps round it out, and neither is deep. [`sendfile(2)`](https://man7.org/linux/man-pages/man2/sendfile.2.html) replaces `copy_file_range` for diff export, since it doesn't care whether the two files live on the same filesystem and Part 1's reflink optimization needs XFS, which these nodes don't run. And `unix.Mount` replaces `exec.Command("mount", ...)`, which drops a process spawn from a path that runs on every publish and turns a parsed stderr string into an actual errno.

## The node-shared read cache

Now the sharing that `DiffStore` used to do comes back, in a form that fits Kubernetes better.

The waste is easy to see once you look at a real node running twenty Pods off one template:

```text
  PRIVATE CACHES                         SHARED CACHE

  Pod A ──> cache A ──> S3               Pod A ──┐
  Pod B ──> cache B ──> S3               Pod B ──┼──> one cache ──> S3
  ...                                    ...     │
  Pod T ──> cache T ──> S3               Pod T ──┘

  20 copies of the same bytes            1 copy
  20x the GETs to fetch them             only the first Pod pays
```

Every one of those redundant requests is a chunk some other Pod on the same machine already has on local disk.

Nothing about that is inherent. It's just that E2B's read cache is scoped to a sandbox, and here the read side is byte-identical to S3 for the volume's whole life, which is the property from Part 1 that makes one cache file legal to share. `SharedReadCache` refcounts one file across every volume on the node that resolves to the same build.

Sharing collapses the fetch, not just the disk. Twenty Pods reading a cold chunk hit one `fetchMap` entry in one chunker, so the GET that fills it happens once for the node rather than twenty times.

The key is where the care went:

```go
type SharedReadCacheKey struct {
	buildID      uuid.UUID
	headerDigest [sha256.Size]byte
}
```

A build UUID and the SHA-256 of the serialized header, and the digest is the part that isn't obvious. A template can be rebuilt under the same ID with a different mapping, and if two volumes with different mappings share one cache file they read each other's data at offsets that mean something else entirely. That's silent corruption of exactly the kind Part 1 kept warning about. Including the digest turns it into a cache miss, which costs a refetch and nothing else.

The UUID is the *resolved* build, which is narrower than "the template" in a way worth knowing. A volume that has checkpointed resolves to the diff it wrote last time, not to the template it started from, so two Pods that both began on the same template and have both checkpointed have different keys and share nothing. The sharing pays off exactly where it should, on the cold fan-out of many fresh Pods onto one build.

```text
node

  Pod A (build X) ──┐
  Pod B (build X) ──┼──> lease ──> shared-X-<sha>.readcache   refcount 3
  Pod C (build X) ──┘
  Pod D (build Y) ─────> lease ──> shared-Y-<sha>.readcache   refcount 1

  each Pod keeps its own private write cache
```

### Deciding when to throw one away

`AcquireForVolume` hands back a lease and `release` drops the refcount. Hitting zero doesn't delete anything, though. The file stays on disk with an idle timestamp, because a template that just lost its last Pod is very likely to get another one, and the warm cache is worth more than the disk.

Which means something else has to reclaim the disk eventually, so a sweep runs on a timer:

| Flag | Default |
|---|---|
| `--shared-read-cache` | `false` |
| `--shared-read-cache-idle-ttl` | `6h` |
| `--shared-read-cache-sweep-interval` | `1m` |
| `--shared-read-cache-low-watermark-bytes` | 20 GiB |
| `--shared-read-cache-high-watermark-bytes` | 30 GiB |

Idle-expired entries go first. If usage is still over the high watermark after that, it evicts least-recently-used entries until it's back under the low one, which is the usual two-watermark trick for not evicting one file every sweep forever.

Sharing is opt-in, and with the flag off every volume gets its own private read cache exactly like E2B's. Correctness rests on two volumes agreeing about what every offset means, so the conservative default is the right one until the key has proven itself.

Measuring that usage takes one line that's easy to get wrong:

```go
return uint64(stat.Blocks) * 512
```

Physical size, not logical. This is the sparse-file gap from Part 1 showing up as a real bug you can ship: every cache file claims to be the full image size, so trusting `stat.Size` means a node with three caches looks like it's using 24 GiB and the sweep evicts a file holding 200 MiB of genuinely useful data.

### Surviving a daemon restart

There's a hole in all of this. The DaemonSet restarts on every driver upgrade, and the bitmap that records which chunks are present lives in memory. Restart the daemon and every shared cache on the node becomes a file full of bytes that nothing believes are there.

So the completion record has to be on disk too. `readCacheState` is a sidecar next to each cache file: a 96-byte header holding the magic `SBRCST01`, the cache key, the image size, and a boot ID, followed by one byte per 4 MiB chunk.

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

The boot ID does the same job at a coarser grain. It comes from `/proc/sys/kernel/random/boot_id`, so a daemon restart preserves it and a node reboot doesn't. That distinction matters because a restart leaves the filesystem exactly as it was, while a reboot loses the page cache and any writes that hadn't reached disk, and there's no way after the fact to work out which chunks made it.

Orphan reaping closes the last gap, and it runs at startup before the driver will accept a single mount. It looks for cache files matching the driver's naming scheme with no live volume behind them, which is what a Pod that died alongside the daemon leaves behind. With sharing enabled it uses a variant that spares shared caches, since a shared cache with no current lease isn't an orphan. It's the warm cache the next Pod is about to want.

## Checkpoints

The read side is now well cared for. The write side has a problem: everything a Pod writes lives in a sparse file on one node's local disk, and that's it. Lose the node and you lose the work.

E2B doesn't have this problem in the same shape, because a sandbox gets paused deliberately and the pause is what triggers the export. A Pod doesn't get paused. It gets evicted, or its node gets drained, or the kubelet decides it's unhealthy, and none of those wait for anyone to snapshot anything.

So the export runs on a timer instead:

```text
t=0      mount, write cache empty
t=5m     checkpoint: dirty blocks ──> sendfile ──> diff object
                     dirty bitmap ──> merged header ──> generation 1
t=10m    checkpoint: generation 2
...
unmount  final export, generation N
```

The interval resolves through three levels: `checkpointInterval` in the Pod's `volumeAttributes` if it's there, otherwise the daemon's `--checkpoint-interval` (default `1h`), and a negative value turns it off for workloads that genuinely don't care. `beginCheckpoint` bails out if a checkpoint is already running or the volume is tearing down, which is the other half of the interlock from the unmount section.

Every checkpoint mints a build ID and writes a header pointing back through every previous generation, so this is Part 1's diff chain built one hour at a time instead of one pause at a time. It accumulates faster than anyone expects:

```text
  A WEEK OF HOURLY CHECKPOINTS

  gen 0    base template
  gen 1    diff ──> 1 object a read might reach into
  gen 2    diff
  ...
  gen 168  diff ──> a cold read now resolves through a mapping
                    stitched from up to 169 different objects
```

That's the point where something has to flatten the chain, because no amount of caching fixes a read that has to consult 169 places to find out where a block lives.

## What a node pays per Pod

| Resource | Count |
|---|---|
| Write cache file | 1, sparse, grows with writes |
| Read device | 1 private, or 1 lease on a shared cache |
| NBD device index | 1 |
| Unix socket pairs | 4 (8 file descriptors) |
| Dispatch goroutines | 4 |
| ext4 mount point | 1 |
| Bind mount | 1 |

Cheap enough per Pod that the NBD index pool is the binding constraint long before memory is, which is why the default pool is 256 and the kernel ceiling gets raised to 4096.

The DaemonSet manifest carries four things a normal workload's wouldn't:

- `privileged: true` for mounting, with `Bidirectional` propagation on both `/mnt/sandboxes` and `/var/lib/kubelet`. Part 2's silent-empty-directory failure lives here.
- `hostPID: true`, so orphan recovery can look up which process owns an NBD device through `/proc/<pid>`.
- `priorityClassName: system-node-critical`. Evict the driver and the node can't start any Pod that needs a volume, which includes whatever the replacement driver depends on.
- `GOMEMLIMIT` set under the container limit, so Go's GC gets aggressive before the kernel OOM-killer does. An OOM kill here takes every mount on the node with it.

## Trade-offs

| | This driver | A normal PVC on a network disk |
|---|---|---|
| Time to a usable mount | Under a second, header only | Provision, attach, mount |
| Node storage for N Pods on one template | 1 read cache plus N write caches | N full volumes |
| Read latency, cold | S3 round trip, 4 MiB granularity | Disk or network disk latency |
| Read latency, warm | Local page cache | Same |
| Blast radius of the driver dying | Every mount on the node | Volumes survive |
| Durability of writes | Only as good as the checkpoint interval | Continuous |

Blast radius is the cost that actually keeps you up. Those dispatch goroutines aren't serving the block device, they are the block device, so a dead DaemonSet Pod means every `/dev/nbdN` on the node stops answering at once and every ext4 mount above them starts throwing I/O errors. A CSI driver for a network-attached disk can crash, restart, and find its volumes exactly where it left them. This one can't, and no amount of care inside the driver changes that.

Durability has a similar shape. Writes are safe up to the last checkpoint and speculative after it, which is a fine deal when the volume is a disposable view of a template and anything worth keeping gets pushed to a real store. It is not a deal you'd take for a database.

Then there's the thing that this whole design was supposed to fix and only half fixed. A cold read still costs an S3 round trip, and it lands wherever the workload happens to touch a chunk nobody fetched yet. The worst version of that is a Pod that kubelet has already reported as `Ready`, sitting there looking healthy, about to spend the next minute of its first real request blocking on object storage. [Part 4](/posts/sandbox-blockstore-performance/) is about the two changes that went after it from opposite ends.
