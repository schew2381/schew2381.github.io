---
title: "(Pt. 2) sandbox-blockstore: K8s CSI Interface"
date: 2026-07-31 10:00:00 -0700
categories: [kubernetes, storage]
tags: [csi, kubernetes, kubelet, grpc, volumes, storage]
---

> A four-part series on lazy block storage and how it becomes a Kubernetes CSI driver:
> 1. [How E2B block storage works](/posts/e2b-block-storage-layer/)
> 2. K8s CSI interface (this post)
> 3. [Adapting E2B block storage into a CSI driver](/posts/sandbox-blockstore-csi-driver/)
> 4. [Optimizing startup performance](/posts/sandbox-blockstore-performance/)
{: .prompt-info }

Part 1 left off with a storage layer that serves a block device out of S3. Handing that to a Pod means convincing Kubernetes it's a volume, and the [Container Storage Interface](https://github.com/container-storage-interface/spec/blob/master/spec.md) is the contract for doing that: implement some gRPC methods, register a Unix socket with kubelet, and Kubernetes calls your code whenever a Pod needs a volume.

Writing the RPCs turned out to be the quick part. The time went into working out which ones we actually had to implement and how much of Kubernetes' default machinery we were allowed to switch off, because a lazily-fetched, node-local, per-Pod volume gets to skip most of it. Knowing that up front saves you from writing two services that do nothing.

## Overview

Three gRPC services, and a driver implements Identity plus whichever of the other two it needs.

```text
┌────────────────────────────────────────────────────────────┐
│ Identity                                                   │
│   GetPluginInfo           name and version                 │
│   GetPluginCapabilities   which services exist             │
│   Probe                   is the driver healthy            │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│ Controller                runs once per cluster            │
│   CreateVolume            provision backing storage        │
│   DeleteVolume            release it                       │
│   ControllerPublishVolume attach to a node (optional)      │
│   CreateSnapshot          snapshot (optional)              │
│   ControllerExpandVolume  grow (optional)                  │
└────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────┐
│ Node                      runs on every node               │
│   NodeStageVolume         mount once per node (optional)   │
│   NodePublishVolume       mount into the Pod's path        │
│   NodeUnpublishVolume     unmount from the Pod's path      │
│   NodeUnstageVolume       unmount from the node (optional) │
│   NodeGetInfo             node identity and topology       │
│   NodeGetCapabilities     which Node RPCs exist            │
└────────────────────────────────────────────────────────────┘
```

Controller runs as a Deployment, usually one replica with leader election. Node runs as a DaemonSet, one Pod per machine, for the unavoidable reason that mounting a filesystem happens on the machine that will use it.

## Who calls what

Nothing in Kubernetes talks to a CSI driver directly, which surprises people the first time they go looking for the caller. Kubelet handles the Node service, and a set of sidecar containers translate Kubernetes API objects into Controller calls on your behalf.

```text
PersistentVolumeClaim
        │
        ▼
 external-provisioner ──gRPC──> Controller.CreateVolume
        │                       │
        │                       ▼
        │                       PersistentVolume created
        ▼
   Pod scheduled to node-7
        │
        ▼
   kubelet on node-7  ──gRPC──> Node.NodeStageVolume   (if staging)
                      ──gRPC──> Node.NodePublishVolume
                                │
                                ▼
                                bind mount appears at
                                /var/lib/kubelet/pods/<uid>/volumes/...
```

The sidecars are separate binaries from [kubernetes-csi](https://github.com/kubernetes-csi): `external-provisioner` watches PVCs, `external-attacher` handles `ControllerPublishVolume`, `external-resizer` handles expansion, and `node-driver-registrar` runs beside the Node service to tell kubelet the driver exists.

That registration is the whole discovery mechanism. The registrar opens a socket at a path kubelet watches and reports two things: the driver name and where the driver's own socket lives.

```yaml
- name: node-driver-registrar
  image: registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.12.0
  args:
    - --csi-address=/csi/csi.sock
    - --kubelet-registration-path=/var/lib/kubelet/plugins/my-driver.csi.dev/csi.sock
```

Those two flags point at the same socket from two different vantage points. `--csi-address` is where the registrar reaches your driver from inside the Pod, and `--kubelet-registration-path` is where kubelet will find it from the host. Swap them and you get a driver that registers successfully and then fails every single mount, because kubelet is dialing a path that doesn't exist in its namespace. The registration succeeding is what makes this one annoying to debug.

## The staging split

Two mount RPCs looks redundant until you consider a volume that several Pods on one node legitimately share.

```text
with staging (a shared network disk)

  NodeStageVolume    ──> mount /dev/sdb at
                         /var/lib/kubelet/plugins/.../globalmount
  NodePublishVolume  ──> bind mount globalmount into pod-A's path
  NodePublishVolume  ──> bind mount globalmount into pod-B's path

without staging (one volume, one Pod)

  NodePublishVolume  ──> mount straight into pod-A's path
```

The division is about cost. Staging is the expensive half that should happen once per node, formatting the disk and running `fsck` and mounting it. Publishing is a bind mount, which is nearly free, and it happens once per Pod.

Opting out is a matter of leaving `STAGE_UNSTAGE_VOLUME` out of `NodeGetCapabilities`, after which kubelet skips both staging calls. Part 3's driver leaves it out, and the reason is worth being precise about, because "it shares nothing" would be false there. It shares plenty. Twenty Pods on one template read from one cache file on the node.

Staging can't express that sharing, though, for two separate reasons.

The first is that staging is keyed by volume ID, and those twenty Pods have twenty different volume IDs. Kubelet would call `NodeStageVolume` twenty times and dedupe nothing, because the thing the volumes have in common isn't the thing staging keys on:

```text
  what kubelet keys staging on     what the sharing actually keys on

  vol-a1b2 ──> stage once          vol-a1b2 ──┐
  vol-c3d4 ──> stage once          vol-c3d4 ──┼──> the same template
  vol-e5f6 ──> stage once          vol-e5f6 ──┘     contents, one cache
  ... 20 distinct IDs
                                   the volume IDs are unrelated to
  20 stages, 0 deduped             what makes these three shareable
```

What makes those three shareable is a fact about their *contents*, and a volume ID can't say anything about contents. Kubernetes has no vocabulary for it, which is why Part 3 ends up inventing its own key.

The second is that kubelet doesn't offer the choice at all here. Staging only exists on the PVC path:

```go
if volumeLifecycleMode == storage.VolumeLifecycleEphemeral {
	klog.V(5).Info(log("plugin.CanDeviceMount skipped ephemeral mode detected for spec %v", spec.Name()))
	return false, nil
}
```
[csi_plugin.go:706](https://github.com/kubernetes/kubernetes/blob/v1.33.10/pkg/volume/csi/csi_plugin.go#L706)

For an ephemeral inline volume, `CanDeviceMount` returns false and the staging machinery never engages. The `STAGE_UNSTAGE_VOLUME` check in `csi_mounter.go` sits inside a `pvSrc != nil` branch, so a driver advertising the capability would be advertising it to nobody. Declaring it would be a lie that costs nothing and clarifies nothing, so the driver doesn't.

## Idempotency is the contract

Every CSI RPC has to be safely retryable, and this is the requirement that quietly turns a working driver into a broken one. Kubelet retries with backoff on any error, and from where it sits those two cases are the same event:

```text
  THE MOUNT FAILED                  THE REPLY GOT LOST

  kubelet ──publish──> driver       kubelet ──publish──> driver
                          │                                 │  mounted
          ◄───error───────┘                     ✗ ◄─────────┘
  kubelet retries                   kubelet retries

  right answer: mount it            right answer: succeed anyway
```

Kubelet can't tell those apart, so the driver has to make the retry correct in both. Three rules cover it in practice:

- `NodePublishVolume` called twice with the same `volume_id` and `target_path` must return success the second time, not "already mounted."
- `NodeUnpublishVolume` on a path that isn't mounted must return success. Returning `NotFound` makes kubelet retry forever and the Pod never finishes terminating.
- `CreateVolume` with the same name and parameters must return the existing volume. With different parameters it must return `ALREADY_EXISTS`.

The unpublish rule is the one that bites, and it bites specifically because the honest implementation is wrong. A driver that faithfully reports "this volume was never mounted here" is telling the truth and producing Pods wedged in `Terminating` until somebody force-deletes them. Return success and move on.

## Volume parameters

Configuration reaches a driver through two channels that show up at different RPCs, and getting them straight before writing either one saves a lot of wondering why a parameter is empty.

The first channel is StorageClass `parameters`, set by whoever administers the cluster, and they arrive in `CreateVolume`'s request:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: sandbox-template
provisioner: my-driver.csi.dev
parameters:
  templateBuildID: "9f3c1a20-..."
volumeBindingMode: WaitForFirstConsumer
reclaimPolicy: Delete
```

`volumeBindingMode: WaitForFirstConsumer` is doing more than it looks like, since it holds provisioning back until a Pod has been scheduled and that's the only way the driver ever learns which node it's provisioning for:

```text
  Immediate                              WaitForFirstConsumer

  PVC created                            PVC created
    │                                      │  nothing happens yet
    ▼                                      ▼
  CreateVolume, node unknown             Pod scheduled to node-7
    │                                      │
    ▼                                      ▼
  Pod scheduled to node-7                CreateVolume, node-7 in the request
  volume is on node-3                      │
                                           ▼
                                         volume is on node-7
```

Anything backed by node-local storage needs the right-hand column, because provisioning early means provisioning on a machine the Pod won't land on.

Whatever reaches `CreateVolume` gets echoed into the `PersistentVolume` and handed to `NodePublishVolume` as `VolumeContext`, so the Node service reads it without a second API lookup.

## Ephemeral inline volumes

The second channel skips the Controller altogether. A Pod declares the volume inline, in its own spec:

```yaml
volumes:
  - name: workspace
    csi:
      driver: my-driver.csi.dev
      volumeAttributes:
        templateBuildID: "9f3c1a20-..."
```

That's the whole thing. Kubelet invents a volume ID, calls `NodePublishVolume`, and passes `volumeAttributes` straight through as the `VolumeContext`, and the volume lives exactly as long as the Pod does. No PVC, no PV, no `CreateVolume`, and no provisioner Deployment to keep leader-elected:

```text
  PVC path                               ephemeral inline

  PVC ──> external-provisioner           Pod spec
            │                              │
            ▼                              │
          CreateVolume                     │  kubelet mints an ID
            │                              │
            ▼                              ▼
          PV ──> kubelet ──> publish     kubelet ──> publish

  4 objects, 1 sidecar, 2 RPCs           1 object, 0 sidecars, 1 RPC
```

Turning it on is a few fields on the `CSIDriver` object:

```yaml
apiVersion: storage.k8s.io/v1
kind: CSIDriver
metadata:
  name: my-driver.csi.dev
spec:
  attachRequired: false
  podInfoOnMount: true
  volumeLifecycleModes:
    - Ephemeral
```

Each one switches off a specific piece of machinery:

- `attachRequired: false` means no `VolumeAttachment` objects and no `external-attacher`, so kubelet goes straight to the Node service. Right for anything that isn't a genuine network-attached disk.
- `podInfoOnMount: true` adds `csi.storage.k8s.io/pod.name`, `pod.namespace`, `pod.uid`, and `serviceAccount.name` to the `VolumeContext`, which is how a driver learns which Pod it's mounting for.
- `volumeLifecycleModes` lists the allowed paths. List both `Persistent` and `Ephemeral` to support each.

What you give up is the one place a driver could have rejected a bad request early. Without `CreateVolume` there's no moment before scheduling where anyone validates anything, so a typo in `templateBuildID` doesn't fail fast. It shows up as a Pod wedged in `ContainerCreating` with the real error buried in kubelet's events, where a `Pending` PVC would have carried a clear message.

## Mount propagation

Now for the part that costs everyone an afternoon. A Node service that mounts filesystems has to make those mounts visible outside its own container, and Kubernetes mount namespaces hide them by default.

```yaml
volumeMounts:
  - name: plugin-dir
    mountPath: /csi
  - name: pods-mount-dir
    mountPath: /var/lib/kubelet
    mountPropagation: Bidirectional
  - name: mount-base
    mountPath: /mnt/volumes
    mountPropagation: Bidirectional
```

`Bidirectional` makes it a shared mount in the kernel, so mounts the driver creates propagate out to the host and mounts the host creates propagate in. Leave it off and every layer reports success while the Pod gets an empty directory:

```text
  without Bidirectional                  with Bidirectional

  driver mounts ext4                     driver mounts ext4
    │  in its own namespace                │  shared mount
    ▼                                      ▼
  host sees nothing                      host sees the mount
    │                                      │
    ▼                                      ▼
  kubelet's bind mount finds             bind mount carries the
  an empty directory                     filesystem into the Pod
    │                                      │
    ▼                                      ▼
  Pod starts, sees nothing,              Pod sees its files
  nothing errors anywhere
```

That's the whole failure: the mount worked, in a namespace nobody else can see. It needs `privileged: true` too, since shared propagation is privileged.

One more detail catches people, which is that the `/var/lib/kubelet` mount has to cover the whole directory rather than just the Pod path. Kubelet passes an absolute target path, and that exact path has to resolve inside the driver's container:

```text
  kubelet passes: /var/lib/kubelet/pods/<uid>/volumes/…/codebase

  MOUNTING ONLY THE POD PATH             MOUNTING /var/lib/kubelet

  driver sees /pods/<uid>/…              driver sees the same absolute
  under some other prefix                path kubelet named
    │                                      │
    ▼                                      ▼
  mount(2) on a path that                mount lands where kubelet
  doesn't exist in this namespace        will go looking for it
```

The driver never gets to rewrite the path, so the namespace has to make the literal string valid.

## A minimal Node service

Put all of that together and a single-Pod, no-staging driver gets small. This is close to the whole thing:

```go
func (n *NodeServer) NodePublishVolume(
	ctx context.Context,
	req *csi.NodePublishVolumeRequest,
) (*csi.NodePublishVolumeResponse, error) {
	if req.GetVolumeCapability().GetMount() == nil {
		return nil, status.Error(codes.InvalidArgument, "only mount volumes supported")
	}

	buildID := req.GetVolumeContext()["templateBuildID"]
	if buildID == "" {
		return nil, status.Error(codes.InvalidArgument, "templateBuildID is required")
	}

	err := n.mounter.Mount(ctx, req.GetVolumeId(), buildID, req.GetTargetPath())
	if err != nil {
		return nil, status.Errorf(codes.Internal, "mount: %v", err)
	}

	return &csi.NodePublishVolumeResponse{}, nil
}

func (n *NodeServer) NodeGetCapabilities(
	context.Context,
	*csi.NodeGetCapabilitiesRequest,
) (*csi.NodeGetCapabilitiesResponse, error) {
	// No staging support, we go directly from publish to mount.
	return &csi.NodeGetCapabilitiesResponse{}, nil
}
```

The validation at the top is where the effort belongs. `GetMount() == nil` means the Pod asked for a raw block device rather than a filesystem, and a filesystem-only driver has to say so instead of mounting something and hoping. Access modes, read-only flags, and unrecognised `VolumeContext` keys all deserve the same treatment, since each one is a request you can't honor, and a loud failure at publish beats a Pod that starts and then behaves strangely for reasons nobody can trace.

## Testing

[csi-sanity](https://github.com/kubernetes-csi/csi-test) runs the spec's conformance suite against a live socket, checking error codes, the idempotency rules, and the capability declarations. It's good at catching the class of bug where a driver works fine when you exercise it by hand and then deadlocks the first time kubelet retries something.

It tells you nothing about your storage, though, and it can't reach mount propagation or registration paths. Those are the two things most likely to be broken on a first deploy, so passing csi-sanity and then getting an empty directory in your Pod is a normal afternoon.

## Trade-offs

| | Ephemeral inline | PVC and StorageClass |
|---|---|---|
| Controller service | Not called | `CreateVolume` and `DeleteVolume` |
| Validation point | At mount, on the node | At provision, before scheduling |
| Failure surface | Pod stuck in `ContainerCreating` | PVC stays `Pending` with an event |
| Lifetime | Exactly the Pod's | Independent of any Pod |
| Parameters set by | Pod author | Cluster administrator |
| Sidecars needed | Only `node-driver-registrar` | Also `external-provisioner` |

When storage is genuinely per-Pod and derived from something immutable, the ephemeral inline path deletes most of the moving parts. Nothing to leak, no reclaim policy to reason about, no provisioner to keep alive. The one thing you give up is early validation, and when the only parameter is a build ID that's a trade worth taking.

Which is exactly the shape [Part 3](/posts/sandbox-blockstore-csi-driver/) needs. One Pod, one writable view of one immutable template, a read side shared across the node, and nothing per-Pod except the copy-on-write layer from Part 1.
