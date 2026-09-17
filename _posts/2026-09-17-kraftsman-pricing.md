---
title: "(Pt. 4) kraftsman: pricing the fleet"
date: 2026-09-17 10:30:00 -0700
categories: [kubernetes, internals]
tags: [karpenter, kraftsman, kubernetes, spot, gpu, cost]
---

> A four-part series on how Karpenter decides what hardware a Kubernetes cluster should run, and what Exa's fork changes for fleets where the answer is measured in GPUs:
> 1. [How a pending pod becomes a node](/posts/karpenter-internals/)
> 2. [How a node earns its deletion](/posts/karpenter-disruption/)
> 3. [kraftsman: when the control loop is the bottleneck](/posts/kraftsman-scale/)
> 4. kraftsman: pricing the fleet (this post)
{: .prompt-info }

[Part 3](/posts/kraftsman-scale/) was about the control loop keeping up. The other thing a GPU fleet does is spend money, and this is where upstream's model shows its assumptions. Karpenter was built to be safe first. A replacement gets priced at its worst-case compatible offering, one node replaces into at most one node, and packing is first-fit. Those are reasonable defaults when instances are cheap and workloads are latency-sensitive. But they leave money on the table in three specific ways on a fleet where a node is eight accelerators and the workloads are durable batch jobs.

A claim priced at its worst case gets vetoed by the single most expensive zone it might land in, so a spot pool with one spiked zone kills savings available in five others. First-fit packing ignores that growing a claim can cost more than opening a cheaper one. And the 1:1 replacement rule hits the node with the most to save hardest. A fat node running half-empty can never consolidate, because its pods won't fit a single cheaper node.

The [kraftsman](https://github.com/exa-labs/kraftsman) changes land in the order a request meets them, from what a claim reserves before it exists to what a pod costs to place to what a node takes to die.

## The DaemonSet tax, charged fairly

Part 1 mentioned that every claim reserves the sum of its compatible DaemonSets before a workload pod is even considered. "Compatible" is where the subtlety lives. A NodePool template's requirements are broad (several zones, several label realizations, several instance shapes), and different DaemonSets select different realizations. A GPU device plugin runs on GPU nodes, a TPU plugin on TPU nodes, the CNI agent on everything. No concrete node ever carries both plugins, because no node is both.

Upstream sums every DaemonSet compatible with the broad template, which charges each claim for DaemonSets that can't co-reside. On a pool spanning accelerator classes that's a double tax on every node, and oversized claims are the visible symptom, nodes bought one size up to hold capacity for daemons that were never coming.

Kraftsman's [daemonoverhead.go](https://github.com/exa-labs/kraftsman/blob/4ee8e09d8ec7ef8a2b2d96026e80b0bbc7ab59cc/pkg/controllers/provisioning/scheduling/daemonoverhead.go) instead enumerates the label realizations where DaemonSets disagree, sums the DaemonSet requests within each realization, and charges the element-wise maximum across them.

```text
pool template can realize: {gpu node} or {tpu node}

DaemonSets:  cilium (all)         200m cpu
             gpu-plugin (gpu)     500m cpu
             tpu-plugin (tpu)     300m cpu

upstream charges every claim:     200+500+300 = 1000m   ← a node that can't exist
realization-aware charges:        max(200+500, 200+300) = 700m per resource
```

OR semantics in `nodeSelectorTerms` and absent labels are handled conservatively, so a DaemonSet that might match a realization is charged to it. Past 4,096 realizations it falls back to the old over-reservation rather than blow up. The result is claims sized for daemons that could actually coexist, which on a mixed-accelerator pool is the difference between a node that fits the workload and a node that's one size too big.

## What a pod costs to place

Provisioning packing is first-fit: a pending pod joins the first in-flight claim that can hold it, and a new claim opens only when nothing fits. That's the right default for bin-packing since it fills claims, but it treats "fits" as the only criterion, and fits isn't free. Growing a claim can force it onto a bigger instance type, and the difference between "fits" and "cheap" is a price nobody computed.

The `marginal-cost` packing policy, selected per pool via the `karpenter.sh/nodepool-packing-policy` annotation in [packing.go](https://github.com/exa-labs/kraftsman/blob/4ee8e09d8ec7ef8a2b2d96026e80b0bbc7ab59cc/pkg/controllers/provisioning/scheduling/packing.go), prices every candidate placement. Growing an in-flight claim costs the increase in its cheapest launch price, and opening a new claim costs that claim's cheapest price. The pod goes wherever the delta is smaller, with ties preferring the in-flight claim.

```text
pod: 8 cpu.  claim-1 is a g5.2xlarge-shaped claim with room.

  grow claim-1:   its instance options narrow to the next size up
                  → cheapest launch price rises $1.21 → $2.42   delta +$1.21
  open claim-2:   an m5.2xlarge at spot                          delta +$0.17

  binpack:        pod joins claim-1 (first fit)
  marginal-cost:  pod opens claim-2, $0.17 beats $1.21
```

Two degradations keep it honest: a placement with no priceable options falls back to binpacking rather than splitting arbitrarily, and binpack pools price every move at zero so behavior is untouched unless you opt in. On pools where instance types have big price steps (anything with accelerators), "does the pod fit" stops being the only question worth asking.

## The node that couldn't die

Back to Part 2's third gap. Single-node consolidation upstream either deletes a node or replaces it 1:1 with something cheaper. The fat half-empty node, the one holding most of the pool's idle spend, fails both checks: it's not empty, and its pods won't fit one cheaper node. So it stays, pass after pass, the best consolidation target in the fleet and an impossible one.

Kraftsman's split fallback re-runs the same candidate under a price ceiling. The re-simulation forbids replacement capacity priced at or above the candidate's own price, and the scheduler does what it naturally does: split the pods across several claims that each come in under the ceiling.

```text
candidate: 8-GPU on-demand node, $30/hr, running 5 GPUs of pods

upstream:   5 GPUs won't fit any single node under $30  → no-op, forever
split:      ceiling $30 on every new claim
            → claim-2: 4-GPU spot node  $11
            → claim-3: 1-GPU spot node   $3
            total $14 < $30, margin ≥ 5%   → REPLACE 1 → 2
```

The guardrails are what make it a fallback and not a landmine. It only applies to single-candidate consolidations with at least two reschedulable pods. The replacement count is bounded by `max-consolidation-replacements`, and attempts are capped per pass by `consolidation-split-max-attempts` because each one costs a full simulation. The split also has to beat a minimum savings margin (`consolidation-split-min-savings`, default 5%), so a node doesn't churn into three nodes for pocket change. Budget-exhausted attempts record themselves as inconclusive rather than no-op, so a later pass can try again instead of caching the wrong verdict.

## When spot is the answer but only in some zones

Part 2's worst-case pricing has a sharper version of the same problem. An on-demand candidate's replacement claim gets priced at its worst compatible offering across every zone the claim allows. One zone where spot spiked past the budget vetoes the whole replacement even when the other five offer real savings.

The OD-to-spot retry in [consolidation.go](https://github.com/exa-labs/kraftsman/blob/4ee8e09d8ec7ef8a2b2d96026e80b0bbc7ab59cc/pkg/controllers/disruption/consolidation.go) re-prices the empty-handed claims: narrow each to spot only and to the zones whose spot offerings beat the budget, then check again. The narrowing is also the guarantee. The launched claim is pinned to those zones and to spot, so the worst case the retry priced is the worst the launch can do. Insufficient spot capacity fails the launch instead of silently falling back to another on-demand node at the price you were trying to leave. It's enabled by default (`OD_TO_SPOT_CONSOLIDATION`) because "the on-demand node stays" is a safe failure and "a spot node appears in a cheap zone" is a common success on a multi-zone pool.

Two related knobs round out the price checks:

1. `spot-to-spot-min-instance-types` makes upstream's 15-option floor configurable. Fifteen assumes instance-type-diverse pools, and a GPU pool pinned to one family can never present fifteen cheaper types, so it could never consolidate spot-to-spot at all. The launch is also capped to that many cheapest options, so the launched type is always inside the priced set and can't be immediately re-consolidated, which is the churn loop the floor exists to prevent.
2. `consolidation-replace-min-savings` sets a fleet-wide savings floor on every replace decision, same idea as the split margin: moving a node has a real cost in disruption, and saving two cents doesn't cover it.

## When the cloud can't sell yet

All of the above treats capacity markets as something you query. There's a second mode a spot-heavy provider wants: treat them as something you wait on and probe. Kraftsman adds three hooks in [spotfirst.go](https://github.com/exa-labs/kraftsman/blob/4ee8e09d8ec7ef8a2b2d96026e80b0bbc7ab59cc/pkg/cloudprovider/spotfirst.go) for providers that prefer spot but may temporarily fall back to on-demand:

1. `LaunchDeferredError` lets the provider say "not yet" instead of "failed." A deferred launch requeues on the provider's `RetryAfter` cadence rather than controller backoff, and it doesn't burn the five-minute launch timeout because a deferred request isn't a stuck one.
2. `WithUnavailableOfferingsIgnored` bypasses the insufficient-capacity cache for chosen capacity types. The ICE cache exists to stop hammering a sold-out market, but a market you stopped probing is a market you can't notice refilling. Structural incompatibilities stay unavailable regardless.
3. `DriftReasonOnDemandLeaseExpired` is the reclaim path. When the provider falls back to on-demand under a lease, it marks the NodeClaim drifted with this reason once the lease expires. The drift controller sorts those candidates first and pins their replacements to spot, so an insufficient-capacity launch fails the command (and keeps the on-demand node) instead of falling back to another on-demand node. The lease swap is price correction, not template drift, and it gets scheduled like one.

The provider that uses these is Exa-internal, but the shape matters more than the implementation. On a spot-first fleet, "temporarily on-demand" is a state the autoscaler should model rather than a fact it should accept.

## The lifecycle edges a self-managed fleet hits

Upstream's two timeouts (five minutes to launch, fifteen to register) assume launch providers and boot times from a managed-node world. The fork's fleet boots things that violate both, so the timeouts became configurable and a third one got added.

- `karpenter.sh/nodeclaim-registration-timeout` on a NodePool overrides the fifteen-minute registration budget per pool. Some accelerator capacity legitimately takes fifteen to twenty-five minutes from insert to kubelet, and the upstream default deletes those claims mid-boot, replacing a slow node with a fresh timeout forever.
- `NODECLAIM_INITIALIZATION_TIMEOUT` covers the gap after registration. A node can register and then never initialize: startup taints never clear, extended resources never appear. Upstream keeps it forever, an instance billing full price, running no workload, and distorting every simulation that models its phantom capacity. The timeout deletes it like the others, measured from registration rather than creation, so the clock only starts once boot could plausibly have finished.
- The garbage collector reclaims claims that launched but never registered once the instance has verifiably vanished, whether from a spot preemption during boot or an insert that failed after being accepted. A five-minute grace period covers the provider's list-after-create consistency window first. Upstream holds those claims until the registration timeout, holding their pending pods hostage the whole time.
- And the inverse leak: a kubelet that registers after its claim was already being deleted creates a Node with no owner reference and no termination finalizer. On a managed cloud the cloud-controller-manager reaps it when the instance disappears. On a self-managed one nothing does, and it sits NotReady forever. The lifecycle controller deletes those nodes once the provider confirms the instance is gone.

None of these is a big change. They're the seams you only find once your nodes aren't all EKS-shaped.

## What's left

Put next to upstream, the delta reads as one theme: every place upstream chose the safe interpretation of cost, the fork makes the cost explicit and lets you set the floor.

| upstream | kraftsman |
|---|---|
| daemonset tax = sum of everything compatible | element-wise max across realizations |
| first-fit packing | per-pool marginal-cost pricing |
| replace 1:1 or delete | bounded 1→N splits with a savings floor |
| worst-case price vetoes the claim | re-price spot-only in the cheap zones |
| spot-to-spot needs 15 cheaper types | configurable floor, launch capped to priced set |
| any cheaper replacement wins | minimum savings margins |
| launch fails or succeeds | launch can defer, leases get reclaimed to spot |
| 5m/15m global timeouts | per-pool registration + initialization timeouts |

The architecture is still Part 1's. Pending pods become claims, claims become instances, a second loop asks whether the fleet could be cheaper, and a queue makes it so. What the fork learned is that the assumptions inside that loop (what a node reserves, what a pod costs to place, what a replacement may become, how long boot can take) were all calibrated for a fleet where compute is cheap. Point the same loop at hardware that isn't, and it turns out the scheduler already knows how to solve the problem. You mostly have to let it see the prices.
