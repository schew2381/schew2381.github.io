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

Parts 1 and 2 are the two halves. E2B fetches block storage lazily out of S3, and CSI is how Kubernetes asks for a volume. Bolting them together gives you a driver where a Pod names a template build ID and gets back a writable ext4 mount over a multi-gigabyte image that never gets downloaded.

One substitution does most of the work. E2B serves its block device to a Firecracker guest kernel, and here it goes to the host kernel instead. Same headers, same chunker, same copy-on-write overlay, all of it unchanged.

That one change is also where the trouble starts, because the kernel doing the I/O is now the kernel the driver itself runs on. E2B can destroy a VM and then clean up storage at its leisure. Here, if you tear down in the wrong order, you're pulling a block device out from under a live kernel that still has dirty pages for it.

## Overview

```text
Pod
 │  reads /workspace/src/main.go
 ▼
kernel VFS ──> ext4 ──> /dev/nbd7
                            │  NBD protocol over 4 Unix socket pairs
                            ▼
                            dispatch goroutines, in the CSI DaemonSet
                            ▼
                      block.Overlay
             ┌──────────────┴──────────────┐
             ▼                             ▼
   ┌───────────────────┐       ┌───────────────────────┐
   │ write cache       │       │ read device           │
   │ per volume        │       │ shared per node       │
   │ mmap'd sparse     │       │ chunker + build.File  │
   └───────────────────┘       └───────────┬───────────┘
                                           │  4 MiB range GET
                                           ▼
                                  ┌─────────────────┐
                                  │ S3 template     │
                                  │ rootfs.ext4     │
                                  └─────────────────┘
```

Everything below `block.Overlay` is Part 1, unchanged. Everything above it is new code: the CSI driver, an NBD server, and a mount lifecycle that has to survive kubelet retrying it.

## What the driver actually implements

The Node service is 141 lines, and most of them refuse things. It validates the request and then hands off to an interface that has never heard of CSI:

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

The refusals are the interesting half. `NodePublishVolume` rejects Block volume capabilities, any access mode other than `SINGLE_NODE_WRITER`, and read-only requests, and each one is a promise the storage layer underneath can't keep. There's no raw-block path at all. A shared-writer mode would mean two Pods on one private write cache, diverging quietly. Read-only can't be honored either, since the overlay always builds a write cache, so accepting the request would mean handing back a writable mount with a read-only label on it.

What survives all that is short. `templateBuildID` has to be in the `VolumeContext`, `checkpointInterval` is optional and goes through `time.ParseDuration`, and then `Mount` runs.

Two more Node RPCs do real work, and both are about kubelet's behavior rather than about storage. `NodeGetCapabilities` returns an empty list to opt out of staging, for the reason in Part 2: a volume here is one Pod's writable view, so there's no shared thing for a second Pod to bind onto. The sharing that does exist sits a level lower, inside the read device, where Kubernetes never sees it and doesn't need to.

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

## NBD, because the host kernel needs a real device

Firecracker will take a file path. It's a userspace process emulating a machine, so "here's a block device" can mean "here's an object with `ReadAt` on it." The host kernel's ext4 driver has no such flexibility. It wants a block device in `/dev`, with a major and a minor number, and it wants to issue real requests against it.

[NBD](https://docs.kernel.org/admin-guide/blockdev/nbd.html) is how you fake one. The kernel's `nbd` module publishes `/dev/nbdN`, accepts block requests from the filesystem above, and forwards each one over a socket to whatever userspace process is listening. The driver listens. Every read the Pod's ext4 issues arrives as bytes on a Unix socket inside the DaemonSet, gets served out of the overlay, and goes back the same way.

Four socket pairs per device, wired up over netlink:

```go
const connections = 4
```

Four and not one, because every cache miss on the other end is an S3 round trip. With one socket the kernel has one request outstanding at a time and a cold `git status` becomes a strictly serial walk through several hundred round trips. Four lets misses overlap.

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

Connecting is flakier than it looks. `nbdnl.Connect` retries up to 100 times at 25 ms intervals, because a device index that just got released can still be busy for a moment. It deliberately doesn't retry `EINVAL`, since that means the arguments are wrong and waiting won't fix them. Indices come out of a pool sized by `--nbd-pool-size`, default 256, and since the kernel's own default ceiling is lower than that, the DaemonSet's init container raises it:

```sh
modprobe nbd nbds_max=4096 2>/dev/null || test -e /dev/nbd0
```

The `|| test -e /dev/nbd0` covers a node where `nbd` is built into the kernel rather than loadable, in which case `modprobe` fails and the devices are already there.

### ENOSPC instead of a read-only filesystem

One error code in the dispatch layer is worth the paragraph:

```go
const NBDErrNoSpace = 28
```

Being the block device means owning what the filesystem concludes from your errors. A full node disk means a write into the mmap'd cache can't be satisfied, and the lazy version is to return a generic I/O error. ext4's reaction to an I/O error on metadata is to remount itself read-only, which means every process in the Pod suddenly starts failing writes with `EROFS`, and `EROFS` looks nothing like "the node ran out of disk." Mapping it to 28 instead means the application gets `ENOSPC`, which it probably already handles, and the filesystem stays mounted.

Dispatch buffers start at 4 MiB, grow to a 32 MiB cap for large writes, and shrink back afterwards. In a DaemonSet running under `GOMEMLIMIT`, one Pod doing a big write shouldn't permanently raise the floor for every other Pod on the node.

## The mount lifecycle

Everything up to here is machinery. `MountManager.Mount` is the thing that runs when a Pod actually starts, and it's eight phases, each of them timed:

```text
1. resolve build ID       alias file in S3, or the literal UUID
2. read header            GET <prefix>/<build>/rootfs.ext4.header
3. decode header          little-endian metadata + BuildMap array
4. build read device      shared cache lease, or a private cache file
5. prefetch hot set       optional, see Part 4
6. build write overlay    sparse mmap'd cache, one per volume
7. open NBD device        4 socket pairs, dispatch goroutines
8. mount and bind         ext4 at /mnt/sandboxes/<id>, bind to target
```

Note what's missing. Nothing in that list transfers the image. Phase 2 fetches a header measured in kilobytes and phases 4 through 8 are all local, which is Part 1's entire argument showing up as a sub-second mount on a multi-gigabyte volume.

Phase 8 does two mounts, which looks like one too many. The driver mounts ext4 at its own path under `/mnt/sandboxes/<volume-id>`, then bind-mounts that path onto kubelet's target. The second mount buys independence at teardown: kubelet can call `NodeUnpublishVolume`, get its bind mount removed, retry the call, and none of that forces the driver to disconnect NBD or throw away a write cache holding data that hasn't been exported yet. One mount would tie kubelet's retry loop directly to the lifetime of the block device.

All eight phases land in one log line as `resolveBuildIDMs`, `headerReadMs`, `headerDecodeMs`, `readDeviceMs`, `startupPrefetchMs`, `writeOverlayMs`, `nbdOpenMs`, `ext4MountMs`, `bindMountMs`, and `totalMs`. That's a small thing that pays for itself the first time a mount takes nine seconds, because the answer is in the log instead of in a profiler you have to attach to a DaemonSet.

### Publishing twice

Kubelet retries, so all eight phases have to be safe to start over from the top. `Mount` takes a per-volume lock before it does anything else:

```go
if err := m.volumeOperations.lock(ctx, volumeID); err != nil {
	return err
}
```

With the lock held it checks whether this volume is already mounted at this target and returns nil if so. The exception is a volume that's mid-teardown, which errors instead, because returning success would hand kubelet a mount that's in the process of disappearing.

Serializing on the volume ID does the more important job, though. Without it, a publish retry can overlap a concurrent unpublish, and the interleaving that follows leaves a live NBD device with dispatch goroutines running and no mount pointing at it. Nothing errors and nothing cleans it up.

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

The ordering isn't stylistic. Phase 1 has to fully stop the I/O before phase 2 reads the write cache, or the export races the kernel still flushing pages into it. Phase 1 also cancels any periodic checkpoint before it waits, because a checkpoint and a teardown both want the overlay, and an unmount that politely waits its turn blocks for up to a full checkpoint interval.

Phase 2 runs on `context.WithoutCancel`. A snapshot cancelled halfway has done all the work and produced nothing.

If phase 2 or 3 fails, the write cache stays on disk so a retry can export it. That's the difference between a transient S3 error and permanently losing everything the Pod wrote.

## What had to change

The read path came over intact, so the diff against E2B is small. What's in it sorts into two piles, and the split says more than any individual change does.

Some things got simpler, because Kubernetes hands you a different sharing shape than an orchestrator does. Some things got stricter, because a live host kernel is a far less forgiving consumer than a Firecracker guest you're about to destroy anyway.

### The simplifications

E2B's `DiffStore` keeps a `ttlcache` of chunkers, one per S3 object, evicted on disk usage percentage. That's correct for an orchestrator where many sandboxes on one node reach into overlapping sets of build objects, and there's real value in caching at the object level.

The CSI driver doesn't have that shape. Each mount resolves one header into one virtual address space, so it gets one chunker over the whole thing:

```go
// In E2B's architecture each S3 object has its own per-build chunker
// (via DiffStore). Our simplified approach puts a single chunker over
// the resolved virtual address space, which works because we don't share
// build objects across mounts.
```

Indexing the cache file by virtual offset instead of by object has a pleasant side effect. A 4 MiB chunk that straddles a mapping boundary is one cache entry, filled by reads from two different S3 objects, and nothing above the chunker has to know that happened. `DiffStore` goes away, along with its TTL eviction and its pending-delete accounting, and the sharing it provided comes back later in a different form.

The chunker choice went away too. E2B picks between `FullFetchChunker` and `StreamingChunker` at runtime through a feature flag, which is the right call while you're still finding out whether streaming holds up. It does, so the driver hardcodes it and deletes the flag plumbing, the `singleflight` group, and the comparison metrics along with it. Streaming is strictly better for this workload and keeping the loser around costs a code path that nobody exercises.

The read batch got bigger in the process, from E2B's 16 KiB default to 512 KiB:

```go
const cachedDeviceMinReadBatch = 512 * 1024
```

That number is a bet about which cost dominates. 16 KiB unblocks a waiting reader sooner, 512 KiB means fewer and larger reads off the open S3 body, and since one reader stays open until the containing 4 MiB chunk is full either way, the whole chunk costs one GET in both cases. 512 KiB is a reasonable place to stop paying for a latency win that's already mostly won. Part 4 has a case where the bet quietly loses.

### The hardening

Three changes exist purely because the kernel doing the I/O is now the host's.

Start with the one that would be a data leak. E2B's `File.ReadAt` walks past a `uuid.Nil` mapping without writing anything, with a comment noting that the caller's slice has to start empty. That's fine for a freshly allocated buffer, and it isn't true for NBD, where the buffer is a dispatch buffer that's been recycled through however many previous requests. Skipping the zero-fill there means a read of a zero range hands back whatever the last write through that buffer left in it, so the driver calls `clear()` on the range instead of advancing past it.

Then there's `SIGBUS`. Write into a `MAP_SHARED` page, find that the filesystem never allocated a block behind it and has no space left to allocate one now, and the kernel raises `SIGBUS`. Go can't catch that on an mmap write. The process dies, and since the process is every block device on the node, so does every mount. The chunker calls `Fallocate` for the chunk's range before `progressiveRead` touches it, which converts a full disk from an uncatchable signal into an `ENOSPC` return value, which becomes NBD error 28, which becomes the `ENOSPC` the application already handles.

Close ordering had to invert. E2B destroys the Firecracker VM first, so by the time `Close` runs there's nothing on the other end of the device. Here the reader is the host kernel, and it may be holding dirty pages for a filesystem that's still mounted. So `Close` quiesces from the top down: flush ext4, unmount it, disconnect NBD, then close the overlay. Run that in E2B's order and the kernel keeps writing into a device after the userspace server behind it has exited, which surfaces as I/O errors on a filesystem nobody has unmounted yet.

One more change belongs in neither pile. E2B's `NormalizeMappings` merges adjacent entries that share a `BuildId`, and the driver additionally requires the `BuildStorageOffset` values to be contiguous. Two ranges from the same build that sit next to each other virtually but not physically can't merge, because the merged entry's arithmetic would point into the wrong part of the packed file. It's the same class of mistake as the split-arithmetic case from Part 1, and it has the same symptom: no error, just wrong bytes.

Two syscall swaps round it out, and neither is deep. `sendfile(2)` replaces `copy_file_range` for diff export, since `sendfile` doesn't require both files to be on the same filesystem and the reflink optimization wasn't available on these nodes anyway. And `unix.Mount` replaces `exec.Command("mount", ...)`, which drops a process spawn from a path that runs on every single publish and turns a parsed stderr string into an actual errno.

## The node-shared read cache

Now the sharing that `DiffStore` used to do comes back, in a form that fits Kubernetes better.

The waste is easy to see once you look at a real node. Twenty Pods on one template, all reading the same `rootfs.ext4`, each with its own private cache file. That's twenty copies of the same bytes on local disk and twenty times the S3 requests to put them there, and every one of those requests is a chunk that some other Pod on the same machine already has.

Nothing about that is inherent. It's just that E2B's read cache is scoped to a sandbox, and here the read side is byte-identical to S3 for the volume's whole life, which is the property from Part 1 that makes one cache file legal to share. `SharedReadCache` refcounts one file per template across every volume on the node.

The key is where the care went:

```go
type SharedReadCacheKey struct {
	buildID      uuid.UUID
	headerDigest [sha256.Size]byte
}
```

A build UUID and the SHA-256 of the serialized header, and the digest is the part that isn't obvious. A template can be rebuilt under the same ID with a different mapping, and if two volumes with different mappings share one cache file they read each other's data at offsets that mean something else entirely. That's silent corruption of exactly the kind Part 1 kept warning about. Including the digest turns it into a cache miss, which costs a refetch and nothing else.

```text
node

  Pod A (build X) ──┐
  Pod B (build X) ──┼──> lease ──> shared-X-<sha>.readcache   refcount 3
  Pod C (build X) ──┘
  Pod D (build Y) ─────> lease ──> shared-Y-<sha>.readcache   refcount 1

  each Pod keeps its own private write cache
```

`AcquireForVolume` hands back a lease and `release` drops the refcount. Hitting zero doesn't delete anything, though. The file stays on disk with an idle timestamp, because a template that just lost its last Pod is very likely to get another one, and the warm cache is worth more than the disk.

Which means something else has to reclaim the disk eventually. A sweep runs on a timer:

| Flag | Default |
|---|---|
| `--shared-read-cache` | `false` |
| `--shared-read-cache-idle-ttl` | `6h` |
| `--shared-read-cache-sweep-interval` | `1m` |
| `--shared-read-cache-low-watermark-bytes` | 20 GiB |
| `--shared-read-cache-high-watermark-bytes` | 30 GiB |

Idle-expired entries go first. If usage is still over the high watermark after that, it evicts least-recently-used entries until it's back under the low one, which is the usual two-watermark trick for not evicting one file every sweep forever.

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

`commitChunk` writes the completion byte before marking the chunk cached in memory, so the durable record is never behind the in-memory one. On reopen, the header gets validated field by field against what the driver expects, and every completed chunk is replayed into the fresh bitmap:

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

Every checkpoint mints a build ID and writes a header pointing back through all previous generations, so this is Part 1's diff chain, built one hour at a time instead of one pause at a time. And it accumulates faster than anyone expects. Hourly checkpoints for a week is 168 generations, each one an object a read might have to reach into, which is the point where something has to flatten the chain or reads get slow in a way no amount of caching fixes.

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

The DaemonSet manifest carries four things that a normal workload's wouldn't, and each one is load-bearing:

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
