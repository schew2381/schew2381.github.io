---
title: "(Part 3) Adapting E2B Block Storage into a CSI Driver"
date: 2026-07-31 11:00:00 -0700
categories: [kubernetes, storage, internals]
tags: [csi, kubernetes, nbd, block-storage, s3, e2b, ext4]
---

> A four-part series on lazy block storage and how it becomes a Kubernetes CSI driver:
> 1. [How E2B's block storage works](/posts/e2b-block-storage-layer/)
> 2. [The Kubernetes CSI interface](/posts/kubernetes-csi-interface/)
> 3. Adapting E2B block storage into a CSI driver (this post)
> 4. [Node caches and startup hot sets](/posts/sandbox-blockstore-performance/)
{: .prompt-info }

[sandbox-blockstore](https://github.com/Greenbax/sandbox-blockstore) takes E2B's lazily-fetched block storage and puts it behind `NodePublishVolume`. A Pod declares a template build ID, and the driver hands it a writable ext4 mount backed by a multi-gigabyte S3 image it never downloads.

The substitution that makes this work: E2B serves the block device to a Firecracker guest kernel, and this serves it to the host kernel. Same headers, same chunker, same copy-on-write overlay. Different consumer, and a different set of failure modes because the kernel doing the I/O is the one the driver itself is running on.

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
the read path below the overlay is identical to E2B's, everything above it is new

Below the overlay is E2B's storage layer. Above it is the CSI driver, the NBD server, and the mount lifecycle, all of which are new.

## What the driver actually implements

The whole Node service is 141 lines. It validates, then delegates:

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
[mounter.go](https://github.com/Greenbax/sandbox-blockstore/blob/2dc807753ae83288019936ac5740d60586a4778d/pkg/csi/mounter.go)

`NodePublishVolume` rejects Block volume capabilities, anything other than `SINGLE_NODE_WRITER`, and read-only requests. It requires `templateBuildID` in the `VolumeContext` and optionally parses `checkpointInterval` with `time.ParseDuration`. Then it calls `Mount`.

`NodeGetCapabilities` returns an empty list, which opts out of staging. There's nothing to share at the staging layer: each volume is one Pod's writable view, and the sharing that does happen is one level lower, inside the read device.

`NodeUnpublishVolume` maps `lifecycle.ErrNotMounted` to a success response, for the reason from Part 2. A driver that reports "not mounted" leaves the Pod in `Terminating`.

Every other Node RPC returns `Unimplemented`. So do most Controller RPCs, since the Controller exists only to support the PVC path:

- `CreateVolume` requires a `templateBuildID` StorageClass parameter, then mints a volume ID and records it in a `sync.Map` with `LoadOrStore`. Using `LoadOrStore` rather than a load-then-store closes the race where two concurrent calls for the same name both pass the check and mint different UUIDs.
- `DeleteVolume` drops the map entry. There's nothing to deprovision, because no storage was ever allocated.
- `ControllerGetCapabilities` advertises only `CREATE_DELETE_VOLUME`.

The `CSIDriver` object turns off everything that doesn't apply:

```yaml
spec:
  attachRequired: false
  podInfoOnMount: true
  volumeLifecycleModes:
    - Ephemeral
```

Most Pods use the ephemeral inline form and skip the Controller entirely:

```yaml
volumes:
  - name: codebase
    csi:
      driver: sandbox-blockstore.csi.dev
      volumeAttributes:
        templateBuildID: "build-python39-v1"
        checkpointInterval: "5m"
```

## NBD, because the host kernel needs a block device

E2B gives Firecracker a device by handing it a file path or a `/dev/nbdN`. Here the consumer is the host kernel's ext4 driver, so the device has to be real to the host. That's [NBD](https://docs.kernel.org/admin-guide/blockdev/nbd.html): the kernel's `nbd` module exposes `/dev/nbdN` and forwards every request over a socket to userspace.

Setup is four socket pairs per device, connected with netlink:

```go
const connections = 4
```
[directmount.go:68](https://github.com/Greenbax/sandbox-blockstore/blob/2dc807753ae83288019936ac5740d60586a4778d/pkg/nbd/directmount.go#L68)

Each pair gets a dispatch goroutine reading a 28-byte request header:

```go
const (
	NBDRequestMagic  = 0x25609513
	NBDResponseMagic = 0x67446698
)
```
[dispatch.go:82](https://github.com/Greenbax/sandbox-blockstore/blob/2dc807753ae83288019936ac5740d60586a4778d/pkg/nbd/dispatch.go#L82)

```text
one NBD device

/dev/nbd7 ──┬── socket pair 0 ──> goroutine 0 ──┐
            ├── socket pair 1 ──> goroutine 1 ──┤
            ├── socket pair 2 ──> goroutine 2 ──┼──> block.Overlay
            └── socket pair 3 ──> goroutine 3 ──┘

per request: 28-byte header in, 16-byte reply out
```

Four connections let the kernel keep four requests in flight, which matters because every miss is an S3 round trip and serializing them would make a cold `git status` unusable.

`nbdnl.Connect` retries up to 100 times at 25 ms intervals, since a device index can be transiently busy. It doesn't retry on `EINVAL`, which means a real argument error instead of contention. Devices come from a pool sized by `--nbd-pool-size` (default 256), and the DaemonSet's init container raises the kernel's ceiling:

```sh
modprobe nbd nbds_max=4096 2>/dev/null || test -e /dev/nbd0
```

### ENOSPC instead of a read-only filesystem

The dispatch layer maps a full disk to NBD error 28:

```go
const NBDErrNoSpace = 28
```
[dispatch.go:78](https://github.com/Greenbax/sandbox-blockstore/blob/2dc807753ae83288019936ac5740d60586a4778d/pkg/nbd/dispatch.go#L78)

Without that mapping, a write failure surfaces to ext4 as generic I/O error, and ext4's response to I/O errors on metadata is to remount read-only. Every process in the Pod then starts failing writes with `EROFS`, which looks nothing like "the node ran out of disk." With `ENOSPC` the application gets the error it expects and the filesystem stays mounted.

Dispatch buffers start at 4 MiB and grow to a 32 MiB cap for large writes, then shrink back so a single big write doesn't permanently pin memory in a DaemonSet running under `GOMEMLIMIT`.

## The mount lifecycle

`MountManager.Mount` is eight timed phases, all instrumented in one log line:

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

Two mounts appear rather than one. The driver mounts ext4 at its own path under `/mnt/sandboxes/<volume-id>` and then bind-mounts that to kubelet's target path. The reason is teardown: unmounting the bind mount is independent of unmounting ext4, so kubelet can retry `NodeUnpublishVolume` without forcing the driver to tear down the NBD device and lose the write cache.

The single log line carries `resolveBuildIDMs`, `headerReadMs`, `headerDecodeMs`, `readDeviceMs`, `startupPrefetchMs`, `writeOverlayMs`, `nbdOpenMs`, `ext4MountMs`, `bindMountMs`, and `totalMs`. When a mount is slow the phase is in the log rather than in a profiler.

### Publishing twice

Kubelet retries. `Mount` starts by acquiring a per-volume lock and then checks whether the volume is already mounted at the same target:

```go
if err := m.volumeOperations.lock(ctx, volumeID); err != nil {
	return err
}
```

A repeat publish to the same target returns nil, unless the volume is mid-teardown, in which case it's an error rather than a silent success on a device that's about to disappear. Serializing on the volume ID also keeps a publish retry from racing a concurrent unpublish, which is otherwise a live NBD device with no mount pointing at it.

The background work detaches from the request context:

```go
bgCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
```

Kubelet's gRPC context ends when `NodePublishVolume` returns. The dispatch goroutines and the periodic checkpoint outlive it by definition, so they can't inherit it.

### Unmount in three phases

```text
phase 1  quiesce      cancel checkpoints, unmount bind, unmount ext4,
                      close NBD, flush the write cache
phase 2  export       walk the dirty bitmap, sendfile to a diff file,
                      upload the diff + header to S3
phase 3  cleanup      release the read cache lease, delete the write
                      cache, remove mount directories
```

Phase 2 runs on `context.WithoutCancel`, because a snapshot that gets cancelled halfway through has done real work and thrown it away. Phase 1 cancels any in-flight periodic checkpoint before waiting on teardown, otherwise the two contend on the same overlay and the unmount blocks for a checkpoint interval.

If phase 2 or 3 fails, the write cache is left in place so a retry can still export it. Deleting it on the error path turns a transient S3 failure into permanent data loss.

## What's different from E2B

The read path is E2B's. Everything that touches a live host kernel, a shared node, or a Kubernetes lifecycle needed changing, and `UPSTREAM.md` in the repo tracks that file by file. The changes that matter are below.

### One chunker, not one per build object

E2B's `DiffStore` keeps a `ttlcache` of chunkers, one per S3 object, evicted on disk usage percentage. That's the right design when many sandboxes share build objects across a node's orchestrator process. Here there's one chunker over the whole virtual image:

```go
// In E2B's architecture each S3 object has its own per-build chunker
// (via DiffStore). Our simplified approach puts a single chunker over
// the resolved virtual address space, which works because we don't share
// build objects across mounts.
```
[cached.go:33](https://github.com/Greenbax/sandbox-blockstore/blob/2dc807753ae83288019936ac5740d60586a4778d/pkg/build/cached.go#L33)

The chunker's cache file is indexed by virtual offset, so a chunk that spans a mapping boundary is one cache entry backed by reads from two objects. `DiffStore`, its TTL eviction, and its pending-delete accounting all disappear, replaced by the lease-counted shared cache below.

### The streaming chunker is the only chunker

E2B picks between `FullFetchChunker` and `StreamingChunker` at runtime via a feature flag. Blockstore hardcodes streaming and deletes the flag plumbing, `singleflight`, and the metrics. Its read batch is 512 KiB rather than E2B's 16 KiB default:

```go
const cachedDeviceMinReadBatch = 512 * 1024
```
[cached.go:53](https://github.com/Greenbax/sandbox-blockstore/blob/2dc807753ae83288019936ac5740d60586a4778d/pkg/build/cached.go#L53)

The trade-off is latency against request count. One S3 reader stays open while 512 KiB batches fill the containing 4 MiB chunk, so a reader waiting on the first block of a chunk unblocks after 512 KiB rather than 4 MiB, and the whole chunk still costs one GET.

### fallocate before writing into the mmap

Writing into a `MAP_SHARED` page whose backing block isn't allocated raises `SIGBUS` when the filesystem is full, and a `SIGBUS` on an mmap write isn't catchable in Go. The chunker calls `Fallocate` for the chunk's range before `progressiveRead` touches it, which turns the disk-full case into an `ENOSPC` return value that becomes NBD error 28.

### Nil-UUID ranges get zeroed, not skipped

E2B's `File.ReadAt` advances past a `uuid.Nil` mapping without writing anything, with the comment that the passed slice must start empty. That holds for a freshly allocated buffer, and it doesn't hold for NBD, where the kernel reuses writeback buffers. Blockstore calls `clear()` on the range instead, because skipping the zero-fill here serves stale data from a previous write.

### Two syscall substitutions

E2B exports diffs with `copy_file_range`, which becomes a reflink on XFS. Blockstore uses `sendfile(2)`, which works on the filesystems the nodes actually run and doesn't require both files to be on the same one.

E2B's orchestrator mounts by running `exec.Command("mount", ...)`. The driver calls `unix.Mount` directly, which removes a process spawn from a path that runs on every publish and makes the error a real errno.

### Close ordering is inverted

E2B destroys the Firecracker VM and then tears down the device, so nothing is reading when `Close` runs. Here the host kernel is still live and may hold dirty pages, so `Close` has to quiesce in the other order: flush ext4, unmount, disconnect NBD, then close the overlay. Getting this backwards leaves the kernel writing to a device whose userspace server has already exited.

### NormalizeMappings checks physical contiguity

E2B merges adjacent mapping entries that share a `BuildId`. Blockstore additionally requires that the virtual offsets and the `BuildStorageOffset` values both be contiguous. Two ranges from the same build that aren't adjacent in the packed data file can't become one entry, and merging them anyway makes reads silently return the wrong bytes.

## The node-shared read cache

This is the largest addition and the reason Part 4 exists.

Every Pod on a node running the same template reads the same bytes from S3, independently of every other Pod. A node with 20 Pods on one template fetches the same 4 MiB chunks 20 times and stores 20 copies of them.

The read side is immutable, which is the property that makes sharing safe. `SharedReadCache` gives one refcounted cache file per template to every volume on the node:

```go
type SharedReadCacheKey struct {
	buildID      uuid.UUID
	headerDigest [sha256.Size]byte
}
```
[shared_cache.go:70](https://github.com/Greenbax/sandbox-blockstore/blob/2dc807753ae83288019936ac5740d60586a4778d/pkg/build/shared_cache.go#L70)

The key is the build UUID *plus* the SHA-256 of the serialized header. The UUID alone isn't enough: a rebuilt template can reuse an ID with a different mapping, and two volumes sharing a cache file under different mappings read each other's data at the wrong offsets. The digest makes that a cache miss instead of corruption.

```text
node

  Pod A (build X) ──┐
  Pod B (build X) ──┼──> lease ──> shared-X-<sha>.readcache   refcount 3
  Pod C (build X) ──┘
  Pod D (build Y) ─────> lease ──> shared-Y-<sha>.readcache   refcount 1

  each Pod keeps its own private write cache
```

`AcquireForVolume` returns a lease. `release` drops the refcount, and at zero the file stays on disk with an idle timestamp rather than being deleted, so the next Pod on that template starts warm.

Eviction is a sweep on a timer, default every minute:

| Flag | Default |
|---|---|
| `--shared-read-cache` | `false` |
| `--shared-read-cache-idle-ttl` | `6h` |
| `--shared-read-cache-sweep-interval` | `1m` |
| `--shared-read-cache-low-watermark-bytes` | 20 GiB |
| `--shared-read-cache-high-watermark-bytes` | 30 GiB |

The sweep drops idle-expired entries first, then if physical usage is still above the high watermark it evicts least-recently-used entries down to the low watermark. Physical size, not logical:

```go
return uint64(stat.Blocks) * 512
```
[shared_cache.go:757](https://github.com/Greenbax/sandbox-blockstore/blob/2dc807753ae83288019936ac5740d60586a4778d/pkg/build/shared_cache.go#L757)

A cache file's logical size is the full image size. Its physical size is what's been fetched. Using the logical size would evict a cache holding 200 MiB of real data because it claims to be 8 GiB.

### Surviving a daemon restart

A shared cache that vanishes on every daemon restart isn't worth much, since the DaemonSet gets restarted on every upgrade. Persisting it requires knowing which chunks are complete, which the in-memory bitmap doesn't survive.

`readCacheState` is a sidecar file next to each cache: a 96-byte header with the magic `SBRCST01`, the cache key, the image size, and a boot ID, followed by one byte per 4 MiB chunk.

```text
shared-<uuid>-<sha256hex>.readcache        sparse, mmap'd, image-sized
shared-<uuid>-<sha256hex>.readcache.state  96-byte header + 1 byte/chunk
```

`commitChunk` writes the completion byte before marking the chunk cached in memory. On reopen the state file is validated byte-for-byte against the expected header, and each completed chunk's range is replayed into the in-memory bitmap:

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
[chunker.go](https://github.com/Greenbax/sandbox-blockstore/blob/2dc807753ae83288019936ac5740d60586a4778d/pkg/block/chunker.go)

Only whole chunks are recorded. A partially fetched chunk is treated as absent and refetched, which costs one GET and avoids trusting a torn write.

The boot ID comes from `/proc/sys/kernel/random/boot_id` and scopes the cache to the machine's current boot. A daemon restart preserves it. A node reboot invalidates it, because the sparse file's page cache and any in-flight writes didn't survive and there's no way to verify what landed.

Deletion removes the state file first. If the process dies between the two removals, the leftover cache file has no state and is treated as empty rather than as fully populated, so the failure mode is a refetch instead of serving garbage.

Orphan reaping runs at daemon startup, before the driver accepts any mount. It scans the cache directory for files matching the driver's naming scheme with no corresponding live volume, which is how a cache file from a Pod that died with the daemon gets cleaned up. The variant that preserves shared caches is used when the feature is enabled, since a shared cache with no current lease is warm, not orphaned.

## Checkpoints

A sandbox's writes live only in the node-local write cache. Losing the node loses them. Periodic checkpointing exports the dirty blocks to S3 as a new build on an interval:

```text
t=0      mount, write cache empty
t=5m     checkpoint: dirty blocks ──> sendfile ──> diff object
                     dirty bitmap ──> merged header ──> generation 1
t=10m    checkpoint: generation 2
...
unmount  final export, generation N
```

The interval resolves in order: an explicit `checkpointInterval` in the Pod's `volumeAttributes`, then the daemon's `--checkpoint-interval` (default `1h`), and a negative value disables it. `beginCheckpoint` refuses to start if one is already running or if the volume is tearing down, which keeps a checkpoint from racing the final export.

Each checkpoint produces a new build ID with a header pointing at all previous generations, so a chain builds up exactly as in Part 1. That chain is also the cost: a volume checkpointed hourly for a week has 168 generations, and reads fan out across more objects until something flattens it.

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

The DaemonSet itself needs four things the manifest wouldn't otherwise have:

- `privileged: true` for mounting, and `Bidirectional` propagation on both `/mnt/sandboxes` and `/var/lib/kubelet`.
- `hostPID: true` so orphan recovery can check NBD device owners through `/proc/<pid>`.
- `priorityClassName: system-node-critical`, because a node without the driver can't start any Pod that needs a volume.
- `GOMEMLIMIT` set below the container limit, so Go's GC backs off before the kernel OOM-kills the process and takes every mount on the node with it.

## Trade-offs

| | This driver | A normal PVC on a network disk |
|---|---|---|
| Time to a usable mount | Under a second, header only | Provision, attach, mount |
| Node storage for N Pods on one template | 1 read cache plus N write caches | N full volumes |
| Read latency, cold | S3 round trip, 4 MiB granularity | Disk or network disk latency |
| Read latency, warm | Local page cache | Same |
| Blast radius of the driver dying | Every mount on the node | Volumes survive |
| Durability of writes | Only as good as the checkpoint interval | Continuous |

The blast radius is the real cost. The dispatch goroutines *are* the block device, so if the DaemonSet Pod dies every NBD device on the node stops answering and every ext4 mount on top of them starts erroring. A network-attached disk survives its CSI driver restarting. This doesn't.

Writes are also durable only to the last checkpoint. That's acceptable for a workload where the volume is a disposable view of a template and anything worth keeping gets pushed elsewhere, and it's not acceptable for a database.

Cold reads still cost an S3 round trip, and that shows up in the worst possible place: a Pod that Kubernetes reports as `Ready` whose first real workload is thousands of small file reads. [Part 4](/posts/sandbox-blockstore-performance/) is about the two changes that fixed it.
