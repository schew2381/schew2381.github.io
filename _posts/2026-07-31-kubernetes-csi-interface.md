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

[Part 1](/posts/e2b-block-storage-layer/) ended on one property, which is that the read side never changes, so a chunk one sandbox fetched is safe to hand to a stranger. Now what does Kubernetes need to hear before it'll mount that as a volume?

The [Container Storage Interface](https://github.com/container-storage-interface/spec/blob/cd4eba751417ddeddb7d5f41656baa61c1a0cb67/spec.md) is a big specification, with more than thirty RPCs spread across five services. A driver for a node-local, per-Pod volume ends up implementing seven of them. Working out *which* seven is the hard part, since the spec calls plenty of RPCs optional that kubelet turns out to require anyway.

So let's take one Pod that wants a sandbox from template build `9f3c1a20`, and follow it from a few lines of YAML down to a mounted filesystem on whichever node it lands on.

## The three services

A CSI driver is a gRPC server, and the spec groups what it can serve into five services. Two of them handle volume groups and snapshot metadata, which nothing here needs, so that leaves three.

### Identity

Every driver implements this one, and it's the only one that's never optional. Three RPCs that answer who the driver is and whether it's alive:

```text
┌────────────────────────────────────────────────────────────┐
│ Identity                  every driver, always             │
│   GetPluginInfo           name and version                 │
│   GetPluginCapabilities   which of the other services      │
│                           this driver actually serves      │
│   Probe                   are you alive                    │
└────────────────────────────────────────────────────────────┘
```

`GetPluginCapabilities` is the interesting one, because it's how the driver declares which of the next two services it bothers to implement.

### Controller

The Controller service deals with a volume *existing*, and it runs as a Deployment somewhere in the cluster rather than on any particular node:

```text
┌────────────────────────────────────────────────────────────┐
│ Controller                one Deployment per cluster       │
│   CreateVolume            go make the backing storage      │
│   DeleteVolume            release it                       │
│   ControllerPublishVolume attach it to a node (optional)   │
│   CreateSnapshot          snapshot it (optional)           │
│   ControllerExpandVolume  grow it (optional)               │
└────────────────────────────────────────────────────────────┘
```

You need this when a volume has a life of its own. A cloud disk gets provisioned before any Pod exists, outlives the Pod that used it, and can be attached to a different machine tomorrow. Somebody has to own those decisions from outside any single node.

Our volume isn't like that. It's created when the Pod starts and thrown away when the Pod dies, so there's nothing to own from outside. Part 3's driver skips this service entirely.

### Node

The Node service deals with making a volume usable *on one machine*, so it runs as a DaemonSet with one Pod on every node:

```text
┌────────────────────────────────────────────────────────────┐
│ Node                      one DaemonSet Pod per machine    │
│   NodePublishVolume       mount it into the Pod's path     │
│   NodeUnpublishVolume     unmount it                       │
│   NodeStageVolume         mount once per node (optional)   │
│   NodeUnstageVolume       the matching unmount (optional)  │
│   NodeGetInfo             which node am I                  │
│   NodeGetCapabilities     which of these I actually serve  │
└────────────────────────────────────────────────────────────┘
```

Every driver needs this one, for the unavoidable reason that mounting a filesystem has to happen on the machine that's going to use it. Nothing about a mount can be done remotely.

So our seven RPCs are all three of Identity, plus `NodePublishVolume`, `NodeUnpublishVolume`, `NodeGetInfo`, and `NodeGetCapabilities`.

## Who calls what

Now the part that surprised us, which is that nothing in Kubernetes ever calls our driver directly. There's no controller in the API server that knows what a CSI driver is. Instead two different things dial the driver's socket, and they call different services:

```text
  WHO DIALS THE DRIVER'S SOCKET

  a PersistentVolumeClaim              the kubelet on one machine
        │                                     │
        ▼                                     │
  sidecar containers                          │
        │                                     │
        ▼                                     ▼
  Controller service                    Node service
  "make a volume exist"                 "mount it here"
```

Those sidecars are prebuilt binaries from [kubernetes-csi](https://github.com/kubernetes-csi). They watch the API for objects like a PVC and turn what they find into Controller calls, and you deploy them beside your driver without writing any of them:

1. `external-provisioner` watches PVCs and calls `CreateVolume`.
2. `external-attacher` calls `ControllerPublishVolume`.
3. `external-resizer` handles expansion.
4. `node-driver-registrar` sits beside the Node service and tells kubelet the driver exists.

That last one is the only sidecar our driver needs, since it's the whole discovery mechanism. It opens a socket at a path kubelet is watching and reports the driver's name plus where the driver's own socket lives.

```yaml
- name: node-driver-registrar
  image: registry.k8s.io/sig-storage/csi-node-driver-registrar:v2.12.0
  args:
    - --csi-address=/csi/csi.sock
    - --kubelet-registration-path=/var/lib/kubelet/plugins/my-driver.csi.dev/csi.sock
```

Those two flags are the same socket seen from two places. `--csi-address` is where the registrar finds your driver from inside the Pod, and `--kubelet-registration-path` is where kubelet will look for it from the host.

Swap them and registration still succeeds, which is what makes this one expensive. Every mount then fails, because kubelet is dialing a path that doesn't exist in its own namespace, and nothing in the registration step ever complained. We lost an afternoon to that.

Kubelet's first call down that socket is `NodeGetInfo`, and it's the first place the spec and kubelet disagree. The spec marks the RPC conditional on a Controller capability our driver doesn't have, so by the letter of it we could leave the RPC out. Kubelet calls it during registration anyway, and unregisters the driver outright if it errors:

```go
driverNodeID, maxVolumePerNode, accessibleTopology, err := csi.NodeGetInfo(ctx)
if err != nil {
	if unregErr := unregisterDriver(pluginName); unregErr != nil {
```
[csi_plugin.go:149](https://github.com/kubernetes/kubernetes/blob/v1.33.10/pkg/volume/csi/csi_plugin.go#L149)

The node ID it returns is what lands in the `CSINode` object, so a driver that skips the call never gets that far.

With registration done, our Pod's volume finally has a path to travel:

```text
  Pod asks for build 9f3c1a20
        │
        ▼
  scheduler puts the Pod on node-7
        │
        ▼
  kubelet on node-7  ──gRPC──> NodePublishVolume("9f3c1a20", targetPath)
        │
        ▼
  a mounted filesystem at
  /var/lib/kubelet/pods/<uid>/volumes/kubernetes.io~csi/workspace/mount
```

One RPC, on one machine. There are four decisions hiding in that single arrow, and they're what's left to work through.

## Why there are two mount RPCs

Having both `NodeStageVolume` and `NodePublishVolume` looks redundant until you picture one disk that three Pods on the same node all want to read.

```text
  ONE SHARED DISK, THREE PODS ON THE NODE

  NodeStageVolume     format it, fsck it, and mount it once
                      at .../globalmount                    <- expensive
                                │
                  ┌─────────────┼─────────────┐
                  ▼             ▼             ▼
  NodePublish     bind into     bind into     bind into      <- nearly free
                  pod-A         pod-B         pod-C
```

That's the whole idea. Staging is the expensive work you only want to do once per node, and publishing is a bind mount you do once per Pod. A driver opts out by leaving `STAGE_UNSTAGE_VOLUME` out of `NodeGetCapabilities`, and kubelet then skips both staging calls.

Part 3's driver opts out, which looks like the wrong call at first. Twenty Pods running the same template all read the same bytes, so that's exactly the shape staging was built for. The problem is that staging keys on the volume ID, and those twenty Pods have twenty different volume IDs:

```text
  what kubelet keys staging on     what actually makes them shareable

  vol-a1b2 ──> stage once          vol-a1b2 ──┐
  vol-c3d4 ──> stage once          vol-c3d4 ──┼──> all build 9f3c1a20,
  vol-e5f6 ──> stage once          vol-e5f6 ──┘    so one set of bytes
  ... 20 distinct IDs
  20 stages, 0 deduped             the IDs have nothing to do with it
```

Kubernetes has no way to say "these volumes have the same contents," so Part 3 invents a key of its own and shares the read cache underneath CSI rather than through it.

There's a second reason too, which is that kubelet wouldn't have offered the choice anyway. Staging only exists on the PVC path, and our volume takes the other path:

```go
if volumeLifecycleMode == storage.VolumeLifecycleEphemeral {
	klog.V(5).Info(log("plugin.CanDeviceMount skipped ephemeral mode detected for spec %v", spec.Name()))
	return false, nil
}
```
[csi_plugin.go:706](https://github.com/kubernetes/kubernetes/blob/v1.33.10/pkg/volume/csi/csi_plugin.go#L706)

So declaring `STAGE_UNSTAGE_VOLUME` would advertise a capability to nobody.

## Every call has to survive being repeated

Say our Pod's mount succeeds, and then the reply never makes it back to kubelet. Now compare that against the mount having simply failed:

```text
  THE MOUNT FAILED                  THE REPLY GOT LOST

  kubelet ──publish──> driver       kubelet ──publish──> driver
                          │                                 │  mounted
          ◄───error───────┘                     ✗ ◄─────────┘
  kubelet retries                   kubelet retries

  nothing is mounted                build 9f3c1a20 is mounted
```

Kubelet sees the same thing either way, which is a call that didn't come back, so it retries. The driver has to be right in both cases without knowing which one happened.

For a publish that means the second call has to succeed rather than complain that the path is already mounted. For an unpublish it means the opposite trap, where a driver asked to unmount something that isn't mounted has to say yes anyway. Reporting `NotFound` is honest and it's also how you get a Pod stuck in `Terminating` forever, since kubelet will keep asking until it gets a success.

Anything on the Controller side follows the same rule. `CreateVolume` called twice with the same name and parameters returns the existing volume, and only returns `ALREADY_EXISTS` if the parameters changed.

## Getting the build ID to the driver

Our driver needs one piece of information to do its job, which is that the Pod wants build `9f3c1a20`. There are two ways to get it there, and they're genuinely different paths through Kubernetes rather than two spellings of the same thing.

### The PVC path

The cluster administrator puts the build ID in a StorageClass, and a Pod asks for storage of that class:

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

Everything under `parameters` arrives in the driver's `CreateVolume` request, gets echoed into the resulting `PersistentVolume`, and is handed to `NodePublishVolume` later as `VolumeContext`. So the Node service reads the build ID without going back to the API server.

The line worth understanding here is `volumeBindingMode`, because for node-local storage the default value is actively wrong:

```text
  Immediate                              WaitForFirstConsumer

  PVC created                            PVC created
    │                                      │  nothing happens yet
    ▼                                      ▼
  CreateVolume, node unknown             Pod scheduled to node-7
    │                                      │
    ▼                                      ▼
  Pod scheduled to node-7                CreateVolume, and now the
    │                                      │  request says node-7
    ▼                                      ▼
  volume sitting on node-3               volume on node-7, where the
  and the Pod is on node-7                 Pod actually is
```

`Immediate` provisions as soon as the PVC exists, which is before anyone has decided where the Pod goes. `WaitForFirstConsumer` holds `CreateVolume` back until scheduling has happened, and that scheduling decision is the only way the driver ever learns which node it's provisioning for.

### The ephemeral inline path

The other option skips the Controller service completely. The Pod names the build ID in its own spec:

```yaml
volumes:
  - name: workspace
    csi:
      driver: my-driver.csi.dev
      volumeAttributes:
        templateBuildID: "9f3c1a20-..."
```

Kubelet invents a volume ID on the spot, passes `volumeAttributes` straight through as the `VolumeContext`, and calls `NodePublishVolume`. There's no PVC, no PersistentVolume, no `CreateVolume`, and no provisioner Deployment to keep leader-elected. The volume lives exactly as long as the Pod:

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

Three fields on the `CSIDriver` object turn this on, and each one deletes a piece of machinery:

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

1. `attachRequired: false` deletes the `VolumeAttachment` objects and the `external-attacher` that creates them, so kubelet goes straight to the Node service. That's right for anything that isn't a real network-attached disk.
2. `podInfoOnMount: true` makes kubelet include `pod.name`, `pod.namespace`, `pod.uid`, and `serviceAccount.name` in the `VolumeContext`, which is the only way a driver learns which Pod it's mounting for.
3. `volumeLifecycleModes` lists the paths you support, so it has to name both if you want both.

The cost of this path is that nobody validates anything until the mount happens. Fat-finger the build ID on the PVC path and `CreateVolume` rejects it before the Pod is ever scheduled, leaving a `Pending` PVC with a clear message on it. Do the same thing here and the Pod sits in `ContainerCreating` with the real reason buried somewhere in kubelet's events.

## Mount propagation

Our driver runs in a container, and it's about to mount a filesystem that a completely different container has to be able to see. That doesn't work by default, because Kubernetes gives each Pod its own mount namespace precisely so that mounts don't leak between them.

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

Nothing in that left-hand path returns an error. The mount really did succeed, just in a namespace nobody else can look into. This also needs `privileged: true`, since shared propagation is a privileged operation.

The other half of this is which directory you mount. We mounted just the Pod's own volume directory, which looks tidier and breaks every publish. Kubelet hands the driver an absolute path, and that exact string has to resolve inside the driver's container:

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

The driver never gets to rewrite that path, so the namespace has to make the literal string valid.

## How to test a CSI driver

With any custom CSI driver, start with [csi-sanity](https://github.com/kubernetes-csi/csi-test), which runs the spec's conformance suite against a live socket. Point it at your driver and it checks the error codes, the idempotency rules from earlier, and whether your capability declarations match what you actually serve. It's very good at the class of bug where a driver works perfectly when you drive it by hand and then deadlocks the first time kubelet retries something.

What it can't do is reach anything outside the gRPC contract. It knows nothing about your storage, and it never sees mount propagation or the registration handshake. Those are the two things most likely to be broken the first time you deploy, and we passed csi-sanity cleanly before spending the rest of the day staring at an empty directory inside a Pod.

So use csi-sanity to prove the contract, then deploy to a real cluster and watch a single Pod come up. Every failure worth worrying about lives in the gap between those two.

## Trade-offs

| | Ephemeral inline | PVC and StorageClass |
|---|---|---|
| Controller service | Not called | `CreateVolume` and `DeleteVolume` |
| Validation point | At mount, on the node | At provision, before scheduling |
| Failure surface | Pod stuck in `ContainerCreating` | PVC stays `Pending` with an event |
| Lifetime | Exactly the Pod's | Independent of any Pod |
| Parameters set by | Pod author | Cluster administrator |
| Sidecars needed | Only `node-driver-registrar` | Also `external-provisioner` |

In this post we followed one Pod asking for build `9f3c1a20` and ended up with a driver that answers seven RPCs. Three say who it is, two mount and unmount, and two describe what it can do. Every other RPC in the spec turned out to be about a volume outliving the Pod that asked for it, which ours never does.

That's what makes the ephemeral inline path the right one here. A volume derived from something immutable that dies with its Pod has nothing to leak, no reclaim policy to reason about, and no provisioner to keep alive. The price is that a bad build ID gets caught at mount time rather than before scheduling, which is cheap when there's one parameter to get wrong.

[Part 3](/posts/sandbox-blockstore-csi-driver/) takes that trade and builds the driver: one Pod, one writable view of one immutable build, a read side shared across the node, and nothing per-Pod except the copy-on-write layer from Part 1.
