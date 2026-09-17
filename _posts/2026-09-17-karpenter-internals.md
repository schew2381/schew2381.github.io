---
title: "(Pt. 1) karpenter: how a pending pod becomes a node"
date: 2026-09-17 01:30:00 -0700
categories: [kubernetes, internals]
tags: [karpenter, kubernetes, autoscaling, scheduling, spot]
---

> A four-part series on how Karpenter decides what hardware a Kubernetes cluster should run, and what Exa's fork changes for fleets where the answer is measured in GPUs:
> 1. How a pending pod becomes a node (this post)
> 2. [How a node earns its deletion](/posts/karpenter-disruption/)
> 3. [kraftsman: when the control loop is the bottleneck](/posts/kraftsman-scale/)
> 4. [kraftsman: pricing the fleet](/posts/kraftsman-pricing/)
{: .prompt-info }

`0/8 nodes are available: 4 Insufficient nvidia.com/gpu, 8 Insufficient cpu.` The pod sits Pending and kube-scheduler will sit with it forever, because its whole job is picking among nodes that already exist and none of them fit.

Two minutes later an instance is booting, a Node object appears, and the pod binds. Something in between did the scheduling work, and it wasn't kube-scheduler.

That something is [Karpenter](https://github.com/kubernetes-sigs/karpenter). People call it an autoscaler, which is close but not quite the right shape. It's better held as one scheduling simulator driven by two control loops.

A provisioning loop watches pending pods and asks what hardware would make them schedulable, then buys it. A disruption loop watches existing nodes and asks whether their pods could run elsewhere for less, then kills or replaces them. The first adds capacity, the second removes it, and pod binding stays with kube-scheduler. [Part 2](/posts/karpenter-disruption/) is all about that second loop.

So let's follow one pod from Pending to a machine, and meet the objects it passes through on the way.

## Overview

Everything below happens inside one controller process. The double lines mark the two boundaries that matter: where Karpenter's internal simulation ends and real API objects begin, and where the API objects end and a cloud instance begins.

```text
ONE PENDING POD BECOMES ONE NODE

  ┌──────────┐
  │   pod    │  Pending, unschedulable on every existing node
  └────┬─────┘
       │ pod watch event
═══════╪══════════════ karpenter controller ══════════════════════════
       ▼
  ┌───────────┐   ┌──────────────────────────────────────────────┐
  │  batcher  │──▶│ scheduler simulation                          │
  │ idle 1s,  │   │  1. ride existing nodes if they fit           │
  │ max 10s   │   │  2. otherwise open NodeClaims and pack pods   │
  └───────────┘   │     into them, narrowing instance types       │
                  └──────────────────────┬───────────────────────┘
                                         │
                                         ▼
                                NodeClaim object created
═══════════════════════════════╪═════════ apiserver ═══════════════════
                               ▼
                    cloudprovider.Create()
                               │
                               ▼
                    instance boots, kubelet starts
                               │
                               ▼
                    Node registers ──▶ labels synced, taints cleared
                               │
                               ▼
                    kube-scheduler finally binds the pod
```

The actual pod binding happens at the bottom of that diagram, done by kube-scheduler on a node Karpenter bought. Karpenter never binds a pod in its life. Its scheduler is a simulator whose only output is a decision about hardware.

## The vocabulary

The pod's trip passes through four object kinds, and the series leans on all of them.

```text
  NodePool ──▶ NodeClass ──▶ NodeClaim ──▶ Node
  policy        provider      one capacity  registered
  you write     config        request       machine
```

A NodePool is the policy surface. It lists the acceptable instance types and zones, the taints each node carries, how much of the pool may be disrupted at once, and the `nodeClassRef` the claims point at. The NodeClass holds everything needed to actually boot a machine in the pool's shape, like an `EC2NodeClass` carrying the AMI family, subnet and security group selectors, and capacity reservation selectors on AWS.

A NodeClaim is where the two meet. Karpenter stamps one per piece of capacity it wants, with the pool's requirements resolved against real pending pods. When the kubelet on the resulting instance registers with the apiserver, the Node object is what shows up, linked back to its claim by the provider ID.

The pair people conflate is NodeClaim and Node. The claim is Karpenter's intent before hardware exists while the Node is the kubelet's presence after it. Everything interesting about lifecycle lives in the gap between them, bridged by matching the claim's `status.providerID` to `node.spec.providerID`.

## One simulator, two loops

```text
  KUBE-SCHEDULER                   KARPENTER'S SCHEDULER

  pod pending?                     provisioner           disruption
       │                           pod pending,          pretend a node
  nodes that exist                 what node fits it?    is gone, where do
       │                                  │              its pods land?
       ▼                                  ▼                     │
  pick one, bind the pod           create claims                ▼
                                   (adds capacity)       delete or replace
                                                         (removes capacity)

                                   both run the same fit simulation
                                   over nodes that exist + could exist
```

Two consequences follow from putting the intelligence in a shared simulator rather than in either loop.

First, the scheduler never places anything. kube-scheduler still binds every pod to a node. Karpenter's [scheduling package](https://github.com/kubernetes-sigs/karpenter/blob/1b4b3e8c829dea93c8a0429e0e27aa68edc98ed7/pkg/controllers/provisioning/scheduling/scheduler.go) is only a simulator: if this pod needed a node, what would that node look like? The answer comes back as NodeClaims, not bindings.

Second, each loop only moves in one direction. The provisioner can add a node but never remove one, because a pod that can't schedule is never an argument for deleting capacity. The disruption loop owns every removal.

What people picture as a separate repacker is the same fit simulation pointed at existing nodes instead of pending ones. That's also what lets a node's pods replay through the logic that placed them.

That asymmetry is the whole reason [Part 2](/posts/karpenter-disruption/) exists.

## The batch window

The provisioner watches pod events and holds them in a batcher. One second of quiet ends the window, and ten seconds caps it, so a burst of pods gets solved in one pass instead of fifty.

```text
pods pending    │─pod1─pod2─pod3────────────pod4──pod5─│
                │        └─<1s quiet→┘        └─<1s quiet→┘
batches         └── batch A: {1,2,3} ──┘      └─ batch B: {4,5} ─┘
                (max 10s caps a sustained burst)
```

Batching is the difference between autoscaling and just relaunching pods on nodes. Fifty pods arriving together can share one simulation and land on one right-sized node instead of racing through fifty separate launches. The knobs are `BATCH_IDLE_DURATION` (1s) and `BATCH_MAX_DURATION` (10s) in [options.go](https://github.com/kubernetes-sigs/karpenter/blob/1b4b3e8c829dea93c8a0429e0e27aa68edc98ed7/pkg/operator/options/options.go).

Not every Pending pod joins the batch. The entry ticket is a pod kube-scheduler has already tried and marked Unschedulable. `GetProvisionablePods` then drops the ones Karpenter has no business provisioning for:

- DaemonSet pods and static pods, which manage their own placement
- pods kube-scheduler already won a preemption for (`status.nominatedNodeName` is set), because they're about to land on capacity that eviction frees
- pods that already have a `nodeName`

The provisioner also validates what's left, rejecting a pod whose PVC topology can't be satisfied or whose selector names a NodePool that doesn't exist. The rest get fed to the simulator.

## The simulation, walked through

The scheduler's job per batch is a greedy bin-pack with a twist: it can fabricate bins.

Per NodePool it builds a NodeClaimTemplate from the pool's requirements, labels, and taints plus the provider's instance type catalog. Every existing node gets wrapped as an ExistingNode. Then it walks the pod list, sorted by cpu then memory with the largest first, and each pod tries existing nodes first, then in-flight claims, then a fresh claim.

So let's trace three pending pods through one pass. The pool allows three instance types in zones a and b.

```text
NodePool requirements: capacity-type In [spot, on-demand]
                       instance-type In [m5.2xlarge, g5.2xlarge, g5.12xlarge]

instance types          cpu   gpu   price (on-demand)
  m5.2xlarge             8    -      $0.38
  g5.2xlarge             8    1      $1.21
  g5.12xlarge           48    4      $5.67

pods                    requests
  pod-a                 4 cpu
  pod-b                 4 cpu, 1 nvidia.com/gpu
  pod-c                 24 cpu
```

```text
step                     claim-1                              claim-2
                         instance options    requirements     instance options

1. pod-a (4cpu)          m5.2x, g5.2x,      unchanged so far
   all types fit         g5.12x

2. pod-b (4cpu+1gpu)     g5.2x, g5.12x      + gpu requirement
   m5.2x can't fit                                   realized on the claim

3. pod-c (24cpu)         doesn't fit        -                  m5.2x, g5.12x
   g5.12x has 48cpu but                               (opens fresh:
   pods a+b already sit on                            only types that
   the claim, and the pool                            can fit 24cpu)
   sizes claims as packed,
   not as "largest allowed"
```

The narrowing is the mechanism to remember. Every pod added to a claim intersects its scheduling constraints into the claim's requirements. The claim's instance type options then filter down to types that can still host everything on it.

A claim that started life able to be any of three types can only be a GPU type after pod-b joins. pod-c doesn't fit the packed remainder, so it gets a claim of its own.

Two details hide inside those steps:

1. DaemonSet overhead is reserved before any of this. Every claim and every existing node conceptually subtracts the requests of the DaemonSets that could land on it, so a claim's real capacity is instance capacity minus the tax. pod-b's GPU pod can't schedule on a node where the GPU device plugin DaemonSet needs room too.
2. Topology spread constraints are tracked as domain groups with per-domain pod counts, so a `DoNotSchedule` spread across zones forces pods onto claims in different zones rather than piling into one.

The output is a set of simulated claims, each holding the pods assigned to it, a requirements object, and a filtered list of instance types it could still become.

## From claim to machine

Simulation output is hypothetical, so `ToNodeClaim` turns it into a real object. The interesting part of [nodeclaimtemplate.go](https://github.com/kubernetes-sigs/karpenter/blob/1b4b3e8c829dea93c8a0429e0e27aa68edc98ed7/pkg/controllers/provisioning/scheduling/nodeclaimtemplate.go) is what it resolves:

- instance types get ordered by price and capped at 600 (`MaxInstanceTypes`), because a claim that says "any of 800 types" is useless to a launch API
- compatible capacity types get collected from the surviving types' offerings, so a claim whose types only exist on-demand doesn't ask for spot
- custom labels get resolved from requirements down to concrete values, the owner reference points back at the NodePool, and the name generates from the pool name

Then `provisioner.CreateNodeClaims` writes the objects, and the launch path hands them to the cloud provider one at a time.

## What the cloud provider sells

The whole hardware catalog arrives as data through a small CloudProvider interface: `GetInstanceTypes` for the catalog, `Create`/`Delete`/`Get`/`List` for NodeClaims, and `IsDrifted`.

An InstanceType is a name, a capacity map, a requirements set, and a list of Offerings. Each offering is the atom of pricing, one (instance type, zone, capacity type) tuple with a price and an availability bit.

```text
instance type g5.2xlarge, its offerings:

  zone    capacity-type   price     available
  a       spot            $0.51     yes
  b       spot            $0.47     no   ← ICE'd: marked unavailable after
  a       on-demand       $1.21     yes     InsufficientCapacity
  b       on-demand       $1.21     yes
  b       reserved        ~$0       yes  ← you're already paying for it
```

Capacity type is the dimension that does the most work:

- on-demand is the list price. The instance is yours until you stop paying for it.
- spot is the same hardware at a market price, typically a third to a tenth of on-demand, revocable on short notice (two minutes on AWS). Cheap and interruptible are the same property.
- reserved is capacity you already bought. On AWS these are On-Demand Capacity Reservations, and they come in two match criteria. An *open* ODCR is filled automatically by any matching instance you launch. A *targeted* ODCR only fills when the launch names it explicitly, so Karpenter can't consume one by accident. The NodeClass's `capacityReservationSelectorTerms` pick which reservations a pool may use.

The AWS provider exposes reservations as a `reserved` capacity type priced at on-demand divided by ten million (see [reserved_capacity_resolver.go](https://github.com/aws/karpenter-provider-aws/blob/85eeae8f2321be5e58bb0ab2b0abc7e411a43668/pkg/providers/instancetype/offering/reserved_capacity_resolver.go)). Priced near zero, the scheduler prefers reserved capacity wherever the pod is eligible. Each offering also carries its remaining `ReservationCapacity`, so a reservation can't be oversubscribed. GPU capacity blocks (the `capacity-block` reservation type) ride the same path, which is how reserved GPU fleets work.

The price list isn't decorative. Instance types get sorted cheapest-first at materialization, and offerings are priced per zone because spot markets are zonal. [Part 2](/posts/karpenter-disruption/)'s entire consolidation engine is "is there a cheaper offering for these pods."

## The gap between claim and node

A created NodeClaim is a promise. The lifecycle controller walks it through three conditions.

```text
                         claim           instance         kubelet         node
                         created         boots            registers       Ready

  Launched                                   ✓
  Registered                                                  ✓
  Initialized                                                               ✓

  Launched    = instance exists, providerID stamped on the claim
  Registered  = Node appeared and matched providerID, labels
                synced, unregistered taint removed
  Initialized = Node Ready, startup taints gone, extended
                resources (nvidia.com/gpu) registered
```

Each condition is a distinct way to be stuck, and the [liveness controller](https://github.com/kubernetes-sigs/karpenter/blob/1b4b3e8c829dea93c8a0429e0e27aa68edc98ed7/pkg/controllers/nodeclaim/lifecycle/liveness.go) times them out separately.

A claim that never reaches `Launched` within five minutes is deleted and re-provisioned, since the provider API never materialized an instance.

A claim that launches but doesn't register within fifteen minutes is deleted too. The instance exists but the kubelet never showed up, which usually means a bad AMI, a bad bootstrap, or a network partition. The fleet is better off trying again elsewhere.

`Initialized` is the condition that takes the longest in practice, because it's where the slow parts of boot live: image pulls, CNI setup, startup taints draining, and device plugins registering. A GPU pod's node isn't useful until `nvidia.com/gpu` appears in allocatable, and the Initialized condition is what waits for exactly that. Until the claim registers, the `karpenter.sh/unregistered:NoExecute` taint keeps stray pods off a node the simulation didn't account for. Between registration and initialization the pool's startup taints do the same job.

## The shadow cluster

Every simulation above reads from an in-memory mirror, `state.Cluster`, rather than the apiserver. It holds a StateNode per real node and per in-flight claim. Each one records the node's labels and taints, its pods' summed requests, DaemonSet requests, host ports, volumes, and whether it's marked for deletion. That's what makes the per-pass math cheap enough to run a scheduling simulation every time a pod batch or a disruption poll fires.

The mirror also gives the two loops a way to stay out of each other's way, which they need because both act on the same pods. Picture the provisioner's simulation landing a pending pod on an existing node with room. kube-scheduler binds it a few seconds later. If the disruption loop kills that node inside the gap, the pod loses its landing spot and goes pending again. The next pass may then buy a whole new node for it.

```text
                     state.Cluster
                   (in-memory mirror)

  provisioner marks:             disruption marks:
  node won a pending pod         node is being deleted
  (nominated ~20s)               (marked for deletion)
       │                                │
       ▼                                ▼
  disruption reads:              provisioner reads:
  not a candidate                not capacity; its
                                 pods get scheduled too
```

`NominateNodeForPod` in [cluster.go](https://github.com/kubernetes-sigs/karpenter/blob/1b4b3e8c829dea93c8a0429e0e27aa68edc98ed7/pkg/controllers/state/cluster.go) is the sticky note that prevents it. After each batch the provisioner marks every existing node that received a pending pod as nominated for about twenty seconds, covering the gap between simulation and bind. Disruption refuses to touch a nominated node, both at the candidacy gate and again during command validation. It's also the mechanism behind the `Nominated` event on a pod: `Pod should schedule on: node/X` is the provisioner calling its shot.

The same bookkeeping runs the other way. A disruption command starting execution marks its candidates for deletion in cluster state. The provisioner then stops counting them as usable capacity and schedules for their evacuating pods as if they were already pending. It's also why [Part 2](/posts/karpenter-disruption/)'s queue marks candidates after launching replacements rather than before: mark first, and the provisioner races the replacements to buy the same capacity.

Everything so far only grows the cluster. The provisioner has no path that ends with fewer nodes and no reason to have one. Making the fleet smaller and cheaper is a different loop's job, running on a ten-second poll, and it's what [Part 2](/posts/karpenter-disruption/) walks through.
