---
title: "(Pt. 2) karpenter: how a node earns its deletion"
date: 2026-09-17 09:30:00 -0700
categories: [kubernetes, internals]
tags: [karpenter, kubernetes, autoscaling, spot, consolidation]
---

> A four-part series on how Karpenter decides what hardware a Kubernetes cluster should run, and what Exa's fork changes for fleets where the answer is measured in GPUs:
> 1. [How a pending pod becomes a node](/posts/karpenter-internals/)
> 2. How a node earns its deletion (this post)
> 3. [kraftsman: when the control loop is the bottleneck](/posts/kraftsman-scale/)
> 4. [kraftsman: pricing the fleet](/posts/kraftsman-pricing/)
{: .prompt-info }

[Part 1](/posts/karpenter-internals/) followed a pod from Pending to a machine and ended on an asymmetry. The provisioner only ever adds capacity, because it only fires on pods that can't schedule. But placement is frozen the moment a pod binds. Jobs finish, spot prices move, reservations free up, and a node bought under yesterday's constraints just sits there costing list price. Nothing in the provisioning loop can see any of that, because none of it produces a pending pod.

So what moves a running pod? Nothing does, directly. A second control loop takes the cheaper route. Every ten seconds it asks of every node whether its pods could run somewhere else for less money. If the answer is yes it deletes the node and lets the pods land wherever the simulation put them.

Let's walk one node through that loop, from candidate to drain.

## The loop and its ladder

The [disruption controller](https://github.com/kubernetes-sigs/karpenter/blob/1b4b3e8c829dea93c8a0429e0e27aa68edc98ed7/pkg/controllers/disruption/controller.go) is a singleton reconciler on a ten-second poll. Each pass builds the candidate set, computes per-NodePool disruption budgets, then hands candidates to a fixed ladder of methods. Each method either returns commands to execute or passes, and the first method to return commands wins.

```text
every 10s
    │
    ▼
┌─ disruption pass ────────────────────────────────────┐
│  candidates = nodes that can legally be disrupted    │
│  budgets    = per-pool max simultaneous terminations │
│                                                      │
│  for each method, in order:                          │
│    1. Emptiness      nodes with only DaemonSet pods  │
│    2. StaticDrift    spec replicas changed           │
│    3. Drift          node no longer matches templates│
│    4. MultiNode      packs several nodes into fewer  │
│    5. SingleNode     one node at a time              │
│                                                      │
│  first method returning commands wins                │
└──────────────────────────────────────────────────────┘
    │
    ▼
 commands → disruption queue (async execution)
```

The ordering is a preference ranking, not a pipeline. Empty nodes are free to delete, so they go first. Drift is a correctness issue wearing a cost costume (the node's spec diverged from its NodePool or NodeClass), so it beats price-based moves. Consolidation is last because it's the most disruptive and the most expensive to evaluate.

## What makes a node a candidate

A node earns candidacy through a chain of gates, and the gates are where the policy lives:

- The NodeClaim must be **Initialized**. A node still booting can't be judged on the pods it might eventually run.
- `consolidateAfter` must have elapsed since the node's last pod event. It's a quiet period, defaulting to 0s, that keeps Karpenter from evicting a pod it just placed. `Never` disables consolidation for the pool outright.
- The pool's `consolidationPolicy` admits it: `WhenEmpty` only allows empty-node deletes, `WhenEmptyOrUnderutilized` allows replacement of non-empty nodes, and `Balanced` scores each move on savings per unit disruption.
- No `karpenter.sh/do-not-disrupt` annotation on the node or its pods. It's the escape hatch for work that can't tolerate a move, like a gang job mid-checkpoint.
- PodDisruptionBudgets must allow the evictions, computed once per pass against the live cluster.
- The per-pool disruption budget must have headroom, defaulting to `nodes: 10%`. At most a tenth of a pool's nodes may be terminating at once, which is the knob that keeps consolidation from becoming a self-inflicted outage.

One name to correct while we're here: the disruption reason is `Underutilized`, but nothing measures utilization. There's no CPU threshold hiding anywhere. A node is "underutilized" precisely when a simulation says its pods fit elsewhere for less, which is a much more honest definition than a percentage.

## The simulation, run backwards

Part 1's scheduler matched pods to claims that don't exist yet. Consolidation runs the same machine in the other direction: pick a candidate, pretend it's gone, and replay its pods through `SimulateScheduling` against the rest of the fleet. Three outcomes are possible.

```text
candidate node: g5.2xlarge, on-demand, $1.21/hr, running pods {p, q}

  outcome              simulation result              decision
  ─────────────────────────────────────────────────────────────
  1. pods fit on       0 new NodeClaims               DELETE the node
     existing nodes

  2. pods need one     1 new NodeClaim, priced        REPLACE:
     new node, but     below the candidate            launch cheaper,
     a cheaper one                                    then delete

  3. pods need two+    2+ new NodeClaims              NO-OP
     nodes, or don't                                   (upstream never turns
     fit anywhere                                      1 node into N)
```

A worked pass with real numbers. Six nodes, and the walk reaches node `ip-10-0-1-7`, a $5.67/hr g5.12xlarge running one 4-GPU job. The simulation evicts its pod hypothetically and finds it fits on `ip-10-0-2-3`, which has a free GPU nobody's using. Zero new claims, so the command is a plain delete: the node dies, the pod reschedules, and the fleet saves $5.67 an hour for zero new hardware.

The next candidate is a $1.21/hr on-demand g5.2xlarge whose pod doesn't fit anywhere. The simulation opens a new claim for it, and the cheapest compatible offering is the same instance type on spot at $0.51. One replacement priced below the candidate, so the command is a replace: launch the spot node, wait for it to initialize, then delete the on-demand one.

Both checks share the same spine: all pods must land somewhere, and any new capacity must price below what's being removed. A candidate that fails either check produces nothing, and the walk moves on.

## What "cheaper" means

Pricing deserves its own paragraph because it's stricter than it looks. A candidate's price isn't its list price. `resolveNodePrice` looks up the offering matching the node's actual zone and capacity type, so a node that launched spot in zone b gets compared against its real $0.47 rather than the $1.21 it would cost on-demand. A replacement's price goes the other way: the claim's options get filtered to instance types whose *worst-case* compatible offering still beats the candidate. A claim that might launch somewhere expensive can't be trusted to save money.

Spot-to-spot moves get extra paranoia on top of that. Swapping one spot node for another is where autoscalers go to churn. Upstream gates it behind a feature flag, `SpotToSpotConsolidation`, which is off by default, and requires at least 15 cheaper instance type options before it'll fire (`MinInstanceTypesForSpotToSpotConsolidation` in [consolidation.go](https://github.com/kubernetes-sigs/karpenter/blob/1b4b3e8c829dea93c8a0429e0e27aa68edc98ed7/pkg/controllers/disruption/consolidation.go)). A spot launch picks among offerings by availability, so a replacement needs enough cheaper types that whichever one actually launches is still a win. A pool pinned to a single instance family can never present fifteen cheaper types and stays put.

And before any of that, candidates get sorted by `SavingsRatio` (node price divided by rescheduling disruption cost) descending. The walk goes after the most savings per unit of eviction pain first, which usually means expensive nodes running few pods rather than small cheap ones. That ordering matters for Part 3, where what happens when the walk can't finish becomes the whole story.

## The command and the queue

A computed command is still hypothetical, so execution goes through a queue with a very deliberate ordering. `StartCommand` in [queue.go](https://github.com/kubernetes-sigs/karpenter/blob/1b4b3e8c829dea93c8a0429e0e27aa68edc98ed7/pkg/controllers/disruption/queue.go) does four things in sequence:

```text
  1. markDisrupted      taint candidates  karpenter.sh/disrupted:NoSchedule
                        + set DisruptionReason on the NodeClaim
  2. createReplacement  create replacement NodeClaims (they boot normally)
       NodeClaims
  3. markForDeletion    mark candidates deleting in cluster state
  4. nominate + enqueue record pod nominations, map providerIDs → cmd,
                        push first candidate to the reconcile channel
```

Steps 2 and 3 are in that order on purpose, and the code comments say why. If the candidates were marked for deletion first, the provisioner would see their terminating pods as unscheduled work and launch capacity for them while the command is launching the same capacity. Marking after the replacements exist means the provisioner sees the claims already covering those pods. It's the double-launch race, and the ordering is the fix.

The queue then runs the command asynchronously, up to 100 concurrent reconciles with one command per candidate provider ID, so a node can only be in one command at a time.

```text
  waitOrTerminate loop
    │
    ├─ every replacement Initialized? ──no──▶ requeue (10s base backoff)
    │
    yes
    ▼
  delete all candidate NodeClaims (parallel, retry on transient errors)
    │
    ▼
  termination controller: drain nodes, delete instances, remove finalizers
```

Waiting for `Initialized` is the safety property. The old node doesn't die until the new one has proven it can run pods, meaning Ready with its resources accounted for rather than merely launched or registered. On a GPU pool that means waiting for the device plugin to register `nvidia.com/gpu`, which is exactly the checkpoint you want before evicting a training job.

## Validation, or the cluster moved under us

Between computing a command and executing it sits a fifteen-second settling window (`commandValidationDelay`). The simulation that produced the command ran against a snapshot, and fleets move. Pods bind, nodes die, and other commands launch replacements that eat the capacity the command was counting on. So before a consolidation command is admitted, the validator waits out the window and re-simulates it against live state. A command that no longer reproduces gets rejected, emits an event naming the reason, and the pass returns empty-handed rather than executing a plan computed against a cluster that no longer exists.

## When a command fails

Commands can die at every stage, and each failure has a defined cleanup. A replacement that never initializes turns the wait into a timeout after `maxRetryDuration` (scaled by queue depth). An unrecoverable failure (a deleted replacement, an expired deadline) triggers rollback. Candidates get untainted, the disruption reason condition clears, cluster state unmarks them for deletion, and the command's provider ID mappings drop so the nodes can be re-evaluated by a later pass. Failed launches get counted in `DisruptionQueueFailuresTotal` so you can watch the queue's health as a metric rather than a log line.

## What this costs you

The design trades are worth naming plainly, because Part 3 is built on them:

| the design says | what it costs at scale |
|---|---|
| ten seconds per pass, three minutes per walk | one command per pass, and a walk that may not finish |
| one node in, at most one node out | a fat node whose pods would fit three small cheap nodes never consolidates |
| correctness over speed | settle windows and wait-for-initialized are the right default for web services, a debatable one for hardware billed by the GPU-hour |
| the mirror is the oracle | per-candidate state rebuilds dominate the pass on a big fleet |

That last trade is where the architecture's cost model breaks at scale, and it's where the fork starts.
