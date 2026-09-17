---
title: "(Pt. 3) kraftsman: when the control loop is the bottleneck"
date: 2026-09-17 02:30:00 -0700
categories: [kubernetes, internals]
tags: [karpenter, kraftsman, kubernetes, autoscaling, performance]
---

> A four-part series on how Karpenter decides what hardware a Kubernetes cluster should run, and what Exa's fork changes for fleets where the answer is measured in GPUs:
> 1. [How a pending pod becomes a node](/posts/karpenter-internals/)
> 2. [How a node earns its deletion](/posts/karpenter-disruption/)
> 3. kraftsman: when the control loop is the bottleneck (this post)
> 4. [kraftsman: pricing the fleet](/posts/kraftsman-pricing/)
{: .prompt-info }

[Part 2](/posts/karpenter-disruption/) ended on what consolidation costs: every candidate node gets replayed through a full scheduling simulation inside a three-minute walk. On a hundred-node cluster that's a rounding error. On ours it stopped working.

That fleet runs the kind of work that produces thousands of pending pods at once. The instances cost more per hour than a small web tier, the nodes are self-managed across two clouds, and the batch jobs on top are gang-scheduled.

During one capacity ramp the pending backlog reached roughly 3,400 pods, and the comment that went in with the fix records the result. The simulation stage of a consolidation pass went from cheaper than scheduler construction to 16x its steady-state cost.

The walk timed out in the middle of the candidate list every pass, so the tail of the list effectively didn't exist. Nodes that would have consolidated never got simulated at all.

[Kraftsman](https://github.com/exa-labs/kraftsman) is Exa's fork. The half of its delta motivated by paragraphs like that one is about making the control loop fast enough to keep up with the fleet it controls.

## What one candidate costs

"It doesn't scale" covers several different leaks. Each candidate in a consolidation walk pays for the same four things, all of which scale with cluster size rather than with the candidate:

```text
per candidate in the walk:

  read pending pod backlog     O(every pending pod in the cluster)
  read PDB limits              O(every PodDisruptionBudget)
  copy cluster state           O(every node + in-flight claim)
  run simulation               O(pods × nodes × instance types × topology)
```

None of these are API server calls (the reads hit the informer cache), so the load lands on the controller's own CPU rather than etcd. The failure mode isn't a melted apiserver, it's a pass that can't afford its own arithmetic.

Multiply the per-candidate cost by a few hundred candidates inside a three-minute budget. The walk becomes a sampler of the first N candidates, where N keeps shrinking as the cluster grows.

There's a second leak on top. A disruption simulation schedules the whole pending backlog alongside the candidate's pods, because that's the right model of what competes for capacity.

But upstream then treats every NodeClaim the simulation opened as the command's replacements, launching them, waiting on them, and pricing them against the candidate. When the backlog holds thousands of pods the provisioner is already handling, a single-node command ends up responsible for a hundred claims it never wanted, all priced against the one it did.

The code comment in [helpers.go](https://github.com/exa-labs/kraftsman/blob/4ee8e09d8ec7ef8a2b2d96026e80b0bbc7ab59cc/pkg/controllers/disruption/helpers.go) tracks the result on the production fleet. The `multiple_replacements_required` skip rate per evaluated candidate ran near zero below 100 pending pods, hit 0.045 at 2,049, and 0.222 at 2,781.

So the fixes come in four layers, cheapest first:

1. Share the work across candidates.
2. Do less per candidate.
3. Remember verdicts across passes.
4. Get more than one command out of a pass that already paid for itself.

## Sharing the pass

Most of what a candidate reads doesn't vary with the candidate. The backlog is the same backlog, the PDB limits are the same limits, and a node's summed pod requests are the same sums. Kraftsman wraps the pass in a set of pass-scoped caches so each of those gets computed once.

The two that carry the most weight:

1. `PassReads` memoizes the pending backlog and the PDB limits for the pass.
2. `SimulationCopy` changes what a state-node copy shares.

```text
  UPSTREAM                            KRAFTSMAN

  candidate 1 ──▶ read backlog        read backlog once per pass
  candidate 2 ──▶ read backlog            │
  candidate 3 ──▶ read backlog            ├─▶ candidate 1
  ...                                   ├─▶ candidate 2
  (same answer,                         └─▶ candidate 3
   paid N times)                         (same answer, paid once)
```

One subtlety in [passreads.go](https://github.com/exa-labs/kraftsman/blob/4ee8e09d8ec7ef8a2b2d96026e80b0bbc7ab59cc/pkg/controllers/disruption/passreads.go): the memoized slice is copied out per call. `SimulateScheduling` appends the candidate's pods to the backlog and would otherwise leak them into the next candidate. And only successes get cached, since a failed read belongs to whichever candidate got unlucky rather than to the pass.

`SimulationCopy` is the same trick one level down. Scheduling only mutates host-port and volume usage. The copy can therefore share the Node and NodeClaim objects, clone just the pod-resource map shells, and precompute each node's summed pod and DaemonSet requests once under the cluster lock.

```text
  copy per candidate:                 share across copies:
    every node object                   Node and NodeClaim objects
    every per-pod request list          summed pod + DaemonSet requests

  clone per candidate, because        previously: re-merge every node's
  scheduling mutates it:              per-pod lists for every candidate
    host-port usage, volume usage
```

Previously every candidate re-merged every node's per-pod resource lists, so the merge now happens once per node per pass. Behind those sits a fleet of narrower caches, each removing one repeated computation: DaemonSet overhead per claim template, topology domain groups, node requirements, reservation capacity, NodeClaim templates, per-pass topology data, and inverse affinities.

They're all context-scoped to one pass and dropped at the end, so they're memoization rather than a cache you have to invalidate. One exception: a validation that waits out its settling window installs fresh ones, so the re-simulation sees the cluster as it is after the wait.

The same logic runs one level down too. Pending pods the provisioner's last pass rejected for a cluster-state-independent reason get excluded from disruption simulations for a TTL-bounded window. That reason means every NodePool was incompatible on taints, requirements, or instance types.

A pod that can't open a claim in any simulation only costs money to simulate, and with a big enough rejected backlog that cost was real. Verdicts expire and get re-derived, so a pod whose fortunes change comes back.

## Surviving the timeout

Sharing fixes the per-candidate cost. The next problem is what happens when even a cheaper walk can't finish. Upstream, a timed-out pass throws away its position and the next pass restarts at the head of the sorted list.

The head is always the juiciest-looking candidates, so a starving walk re-evaluates the same few every ten seconds while the tail is never reached. Kraftsman calls the fix the coverage cycle.

```text
upstream:   pass1 [A B C D |timeout| E F G]   pass2 [A B C D |timeout| E F G]   … E,F,G never seen
kraftsman:  pass1 [A B C D |timeout| E F G]   pass2 [E F G |done, cycle complete|]  pass3 [A B C D …]
```

`evaluatedThisCycle` tracks which candidates recent walks reached so `resumeCoverageCycle` can move them behind the unreached ones. It's a position hint only: nothing simulated or decided carries across passes.

Every candidate still gets simulated against live state. What it buys is a bound on how long any node can hide from evaluation.

Alongside it, a per-candidate simulation budget (`consolidation-candidate-timeout`, default ten seconds) keeps one pathological candidate from eating the walk's whole budget. And a timed-out walk that already found proposals still gets to admit them under a separate admission budget instead of throwing them away.

## Remembering no-ops

The most common outcome of a consolidation simulation is nothing. The candidate's pods don't fit cheaper, the command is a no-op, and the same verdict gets recomputed next pass. Kraftsman's [negative result cache](https://github.com/exa-labs/kraftsman/blob/4ee8e09d8ec7ef8a2b2d96026e80b0bbc7ab59cc/pkg/controllers/disruption/negativeresultcache.go) stores those verdicts keyed by a fingerprint of everything the verdict could depend on.

```text
  candidate simulates to no-op
    │
    ▼
  fingerprint = node resource version + claim resource version
              + NodePool UID & generation + instance-type revision
              + UIDs & versions of every pod that would move
    │
    ▼
  next pass on same candidate
    ├─ fingerprint matches (within TTL, 5m) ──▶ skip the simulation
    ├─ can't build a fingerprint ─────────────▶ simulate anyway
    └─ any command completes through the
        disruption queue ─────────────────────▶ clear the whole cache
```

Two properties make it safe rather than clever:

1. Only no-ops are cached. A stale entry can delay a consolidation, never cause a wrong one, and a fingerprint that can't be built fails closed with no skip.
2. The TTL (default five minutes) bounds what the fingerprint can't see. Spot prices and transient offerings aren't fingerprinted, so a verdict is only trusted for as long as "the fleet didn't change underneath it" is plausible. Any command completing through the disruption queue (from any method, since it might free capacity a cached verdict was computed without) clears the cache entirely.

A pass that skipped candidates on cache hits deliberately can't mark the fleet consolidated, because expiry only runs when a pass looks entries up.

## More than one command per pass

Upstream admits at most one consolidation command per pass. It finds a winner, validates it, and ends. On a big fleet that's throughput the architecture leaves on the table, since the pass already paid to discover the candidates.

Kraftsman lets a pass hold several proposals and admit them in sequence. The catch is correctness. The sequencing in `admitProposals` is the safety property rather than an implementation detail: each proposal gets validated against live state right before `StartCommand`.

```text
  pass holds proposals {A, B, C}

  for each, in order:
    validate against LIVE state
      │
      ▼
    StartCommand: taint candidates, launch replacements,
    mark them for deletion
      │
      ▼
    the next proposal validates against a cluster that
    already contains every admitted effect
```

`StartCommand` taints candidates, launches replacements, and marks them for deletion before returning. By the time the next proposal validates, the cluster it re-simulates against already contains every effect of the commands admitted before it. A proposal that depended on capacity an earlier command consumed fails validation, exactly the way a plan that drifted across the settling window does. Validating the batch up front and launching concurrently would lose precisely that.

Admission runs on its own budget: the settling delay plus about twenty seconds per held proposal. A walk that timed out holding proposals is exactly the case where discarding them hurts most.

The disruption budget mapping decrements as proposals are held, so a batched pass can't overspend a pool's allowance. Claims already named by a held proposal can't join a second command.

While we're in this code: the replacement-attribution fix from earlier lives here too. With `ConsolidationAttributeReplacements` (default on), only NodeClaims that actually host a disrupted pod count as a command's replacements.

```text
  simulation opened three claims for candidate's pods + backlog:

    claim-A  hosts disrupted pods p,q   ──▶ counts as replacement
    claim-B  hosts disrupted pod r      ──▶ counts as replacement
    claim-C  hosts only backlog pods    ──▶ dropped from the command,
                                            left to the provisioner
```

A drift command no longer waits on a hundred claims the backlog spawned. Consolidation pricing also stops charging unrelated capacity against the candidate.

## The fixes that came along for the ride

Several smaller bugs only become visible at this scale. The fork fixes them where it found them:

- `IsPreempting` treats `nominatedNodeName` as "kube-scheduler already freed capacity for this pod," so the pod is skipped for provisioning. Volcano sets the same field on gang members stuck behind an unmet `minAvailable` and never clears it. Karpenter saw nominated pods, provisioned nothing, and partially-satisfiable gangs starved forever. Volcano-scheduled pods no longer count as preempting.
- An unnarrowed `Exists` requirement got resolved to a random invented value, stamping labels like `efa=1490613278757040451` on nodes that match nothing selecting on a real value. Unnarrowed `Exists` now leaves the label unset.
- Domain groups were seeded with every domain any NodePool could supply. A pod pinned to one pool then computed its `DoNotSchedule` spread against zero-pod domains only other pools offered. The result was a permanently unsatisfiable spread that blocked drift and consolidation replacements. Domains now track which pool can supply them, and pods only count domains they can reach.
- The queue reconciled by fetching the candidate NodeClaim named in the request and looking its command up by provider ID. A candidate deleted out from under an in-flight command (spot preemption, GC, an operator) left the command unable to terminate its remaining candidates or untaint them. The queue now resolves requests against its own bookkeeping by candidate name.

## Watching the watcher's math

Almost every change above ships with a metric because the fleet got too big to reason about by log line. Pass outcomes and stage timings (state copy, pod gather, construction, simulation) split where the three minutes go. Per-candidate skip reasons say why the walk passed each node (budget exhausted, below threshold, claimed by a pending command, cached negative, timed out).

Per-NodePool depth metrics show how far into each pool's candidates the walk gets before the budget runs out. The walk-cycle gauge reports what fraction of the candidate list the current coverage cycle has reached.

The biggest addition is the [census](https://github.com/exa-labs/kraftsman/blob/4ee8e09d8ec7ef8a2b2d96026e80b0bbc7ab59cc/pkg/controllers/disruption/census.go). Every ten minutes a sweep simulates every candidate without executing anything and publishes actionable delete/replace counts by NodePool.

The single-node walk's metrics can't answer "how many nodes could consolidate right now" because it stops at its first winner. The census answers it directly in five minutes of simulation you weren't spending anyway.

Termination accounting got the same treatment. NodeClaim lifetime and termination-duration histograms are now labeled by instance type, capacity type, and cause. The cause distinguishes cloud interruption (stamped via a termination-cause annotation on the claim), the disruption reason the queue recorded, and `never_initialized`.

Lifetime is split by whether the claim came from provisioning or from a disruption replacement. "How long do replacement nodes live compared to provisioned ones" stopped being a grep question.

## What the fork actually changed

None of this changes what Karpenter is. The architecture is upstream's, with the same primitives, the same simulate-then-commit split, and the same launch-then-drain ordering. What changes is that each mechanism now survives being multiplied by the size of the fleet it manages.

| upstream assumption | what scale does to it | kraftsman's answer |
|---|---|---|
| re-read backlog/PDBs per candidate | 3,400-pod backlog, 16x sim cost | pass-scoped memoized reads |
| re-copy all state per candidate | O(nodes) merge per candidate | shared resource lists, memoized sums |
| resimulate identical no-ops | most candidates are repeat no-ops | fingerprinted negative cache + TTL |
| restart walks at the head | timed-out walks starve the tail | coverage cycle resumes mid-list |
| one command per pass | discovery cost already paid | batched proposals, sequential admission |
| all simulated claims are replacements | backlog claims held drift hostage | attribute only disrupted-pod claims |
| simulation failure = log line | can't see pass behavior | stage timings, skip reasons, census |

The fork's other half is everything about how a node gets priced: [Part 4](/posts/kraftsman-pricing/).
