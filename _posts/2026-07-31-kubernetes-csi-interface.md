---
title: "(Part 2) The Kubernetes CSI Interface"
date: 2026-07-31 10:00:00 -0700
categories: [kubernetes, storage]
tags: [csi, kubernetes, kubelet, grpc, volumes, storage]
---

> A four-part series on lazy block storage and how it becomes a Kubernetes CSI driver:
> 1. [How E2B's block storage works](/posts/e2b-block-storage-layer/)
> 2. The Kubernetes CSI interface (this post)
> 3. [Adapting E2B block storage into a CSI driver](/posts/sandbox-blockstore-csi-driver/)
> 4. [Node caches and startup hot sets](/posts/sandbox-blockstore-performance/)
{: .prompt-info }

The [Container Storage Interface](https://github.com/container-storage-interface/spec/blob/master/spec.md) is a gRPC contract. Implement the right subset of it, register a Unix socket with kubelet, and Kubernetes will call your code every time a Pod needs a volume.

It's a small API. The hard part isn't the RPCs, it's knowing which ones you actually have to implement and which of Kubernetes' assumptions you're allowed to opt out of.

## Overview

CSI splits into three gRPC services. A driver implements Identity plus whichever of the other two it needs.

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

Controller runs as a Deployment, usually one replica with leader election. Node runs as a DaemonSet, one Pod per machine, because mounting is inherently local.

## Who calls what

Nothing in Kubernetes calls a CSI driver directly. Kubelet calls the Node service, and a set of sidecar containers translate Kubernetes API objects into Controller calls.

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

`--csi-address` is where the registrar reaches your driver inside the Pod. `--kubelet-registration-path` is the same socket as seen from the host. Getting these two confused produces a driver that registers and then fails every mount, since kubelet dials a path that doesn't exist from its own namespace.

## The staging split

`NodeStageVolume` and `NodePublishVolume` exist because a volume can legitimately be shared by several Pods on the same node.

```text
with staging (a shared network disk)

  NodeStageVolume    ──> mount /dev/sdb at
                         /var/lib/kubelet/plugins/.../globalmount
  NodePublishVolume  ──> bind mount globalmount into pod-A's path
  NodePublishVolume  ──> bind mount globalmount into pod-B's path

without staging (one volume, one Pod)

  NodePublishVolume  ──> mount straight into pod-A's path
```

Staging is the expensive, once-per-node half: format the disk, run `fsck`, mount it. Publishing is a cheap bind mount per Pod.

A driver opts out by leaving `STAGE_UNSTAGE_VOLUME` out of `NodeGetCapabilities`, after which kubelet skips both staging calls and goes straight to publish. That's the right choice when each volume belongs to exactly one Pod, because there's nothing to share and staging only adds a mount layer and two more RPCs that can fail.

## Idempotency is the contract

Every CSI RPC must be safely retryable. Kubelet retries with backoff on any error and has no way to distinguish "the mount failed" from "the mount succeeded and the reply was lost."

The rules that matter in practice:

- `NodePublishVolume` called twice with the same `volume_id` and `target_path` must return success the second time, not "already mounted."
- `NodeUnpublishVolume` on a path that isn't mounted must return success. Returning `NotFound` makes kubelet retry forever and the Pod never finishes terminating.
- `CreateVolume` with the same name and parameters must return the existing volume. With different parameters it must return `ALREADY_EXISTS`.

The unpublish rule is the one that bites. A driver that faithfully reports "this volume was never mounted here" produces Pods stuck in `Terminating` until someone force-deletes them.

## Volume parameters

Two channels carry configuration into a driver, and they arrive at different RPCs.

StorageClass `parameters` land in `CreateVolume`'s request. They're set by whoever administers the cluster:

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

`volumeBindingMode: WaitForFirstConsumer` delays provisioning until a Pod is scheduled, so the driver learns which node it's provisioning for. That matters for any driver whose storage is node-local.

The parameters that reach `CreateVolume` are echoed back in the `PersistentVolume` and delivered to `NodePublishVolume` as `VolumeContext`, so the Node service sees them without a second lookup.

## Ephemeral inline volumes

There's a second path that skips the Controller entirely. A Pod declares the volume in its own spec:

```yaml
volumes:
  - name: workspace
    csi:
      driver: my-driver.csi.dev
      volumeAttributes:
        templateBuildID: "9f3c1a20-..."
```

No PVC, no PV, no `CreateVolume` call. Kubelet calls `NodePublishVolume` with a synthetic volume ID and passes `volumeAttributes` through as the `VolumeContext`. The volume's lifetime is exactly the Pod's.

Enabling it is a field on the `CSIDriver` object:

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

Each field turns off or on a specific piece of machinery:

- `attachRequired: false` means no `VolumeAttachment` objects and no `external-attacher`, so kubelet goes straight to the Node service. Correct for anything that isn't a real network-attached disk.
- `podInfoOnMount: true` adds `csi.storage.k8s.io/pod.name`, `pod.namespace`, `pod.uid`, and `serviceAccount.name` to the `VolumeContext`, which is how a driver knows which Pod it's mounting for.
- `volumeLifecycleModes` lists which paths are allowed. List both `Persistent` and `Ephemeral` to support each.

Ephemeral mode gives up something real. With no `CreateVolume` there's no point at which the driver can reject a bad request before scheduling, so a typo in `templateBuildID` surfaces as a Pod stuck in `ContainerCreating` with the error buried in kubelet's events.

## Mount propagation

A Node service that mounts filesystems has to make those mounts visible outside its own container, and Kubernetes mount namespaces default to hiding them.

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

`Bidirectional` maps to a shared mount in the kernel, so mounts the driver creates propagate to the host and mounts the host creates propagate in. Without it the driver mounts into its own namespace, sees success, and the Pod sees an empty directory. It also requires `privileged: true`, since shared propagation is a privileged operation.

The `/var/lib/kubelet` mount has to be the whole directory rather than the specific pod path, because kubelet passes an absolute target path and the driver needs that exact path to exist in its own namespace.

## A minimal Node service

Stripped to what a single-Pod, no-staging driver actually needs:

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

The validation up front is worth writing carefully. `GetMount() == nil` means the Pod asked for a raw block device rather than a filesystem, and a driver that only does filesystems has to reject that rather than silently mount something. Access mode, read-only flags, and unexpected `VolumeContext` keys deserve the same treatment, because every one of them is a request the driver can't honor and shouldn't pretend to.

## Testing

[csi-sanity](https://github.com/kubernetes-csi/csi-test) runs the spec's conformance suite against a live socket. It checks the error codes, the idempotency rules, and the capability declarations, and it catches the whole class of bug where a driver works by hand and then deadlocks under kubelet's retries.

It won't catch anything about the storage itself. It also can't check mount propagation or registration paths, which are the two things most likely to be wrong on a first deploy.

## Trade-offs

| | Ephemeral inline | PVC and StorageClass |
|---|---|---|
| Controller service | Not called | `CreateVolume` and `DeleteVolume` |
| Validation point | At mount, on the node | At provision, before scheduling |
| Failure surface | Pod stuck in `ContainerCreating` | PVC stays `Pending` with an event |
| Lifetime | Exactly the Pod's | Independent of any Pod |
| Parameters set by | Pod author | Cluster administrator |
| Sidecars needed | Only `node-driver-registrar` | Also `external-provisioner` |

For storage that's genuinely per-Pod and derived from something immutable, ephemeral inline volumes remove most of the moving parts. There's no PV to leak, no reclaim policy to reason about, and no provisioner Deployment to keep leader-elected.

That's the shape [Part 3](/posts/sandbox-blockstore-csi-driver/) uses. The volume is one sandbox's view of one immutable template, the read side is shared across every Pod on the node, and the only thing per-Pod is the copy-on-write layer.
