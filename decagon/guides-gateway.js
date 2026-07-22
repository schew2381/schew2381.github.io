(() => {
  "use strict";

  const entries = {
    "three-gateway-planes": {
      contextTitle: "Start with the request that must survive",
      context: [
        "The coding prototype can keep routing policy, provider health, and benchmark output inside one process. After the gateway becomes a fleet, a request still cannot wait for every replica or shared service to agree before it chooses a provider.",
        "Treat the planes as failure boundaries rather than as three products to place on a diagram. The data plane serves the request now, the control plane publishes validated state for later reads, and the telemetry plane exports evidence without becoming part of the response contract.",
        "Trace one request before drawing those supporting systems. Its deadline, streaming commit point, local capacity, and cached policy reveal what must keep working when configuration delivery or telemetry export is unavailable."
      ],
      walkthrough: {
        title: "Follow one request through one replica",
        intro: "Assume an authenticated client starts a streamed inference request with a five-second deadline while the fleet has a valid routing snapshot in memory.",
        steps: [
          {
            title: "Admit at the edge",
            text: "The edge authenticates the caller, enforces body limits, assigns a request ID and trace context, and forwards the remaining deadline instead of creating a fresh timeout."
          },
          {
            title: "Protect the replica",
            text: "The selected gateway replica checks tenant admission, its active-request cap, and its bounded queue before work consumes a provider slot."
          },
          {
            title: "Read one local snapshot",
            text: "The router reads immutable provider compatibility, expiring fleet hints, local health, and current capacity without calling a shared health store."
          },
          {
            title: "Spend provider capacity",
            text: "The executor acquires both application capacity and provider capacity before the adapter starts the upstream attempt with the time that remains."
          },
          {
            title: "Define the commit point",
            text: "For a streamed response, the first byte delivered to the client commits that response, so a later provider failure cannot be replaced invisibly by another provider."
          },
          {
            title: "Publish evidence later",
            text: "Attempt outcomes update local health immediately while health events, spans, logs, and metrics enter bounded asynchronous paths that cannot hold the response open."
          },
          {
            title: "Clean up every terminal path",
            text: "Success, timeout, client disconnect, losing hedge, shutdown, and transport failure all cancel unneeded work and release each permit exactly once."
          }
        ],
        takeaway: "A normal request needs local policy, local health, and local capacity synchronously, while fleet policy and telemetry improve later requests without becoming dependencies of the current one."
      },
      workedExample: {
        title: "Turn request rate into provider concurrency",
        setup: "A three-zone gateway receives 1,000 logical requests per second, an upstream attempt lasts two seconds on average, and retries plus hedges raise attempts per request to 1.10.",
        facts: [
          { label: "Logical request rate", value: "1,000 requests/s" },
          { label: "Mean attempt duration", value: "2 s" },
          { label: "Attempts per request", value: "1.10" },
          { label: "App replicas", value: "30 across 3 zones" },
          { label: "Caller deadline", value: "5 s" }
        ],
        steps: [
          {
            title: "Compute physical attempt rate",
            text: "1,000 logical requests/s multiplied by 1.10 attempts/request produces 1,100 provider attempts/s."
          },
          {
            title: "Apply Little's Law",
            text: "1,100 attempts/s multiplied by a two-second mean duration produces about 2,200 provider attempts in flight."
          },
          {
            title: "Reject the per-replica shortcut",
            text: "A local cap of 100 on each of 30 replicas would permit 3,000 attempts, so replica-local semaphores alone cannot enforce a smaller provider-account quota."
          },
          {
            title: "Keep the request path local",
            text: "Replicas consume preallocated capacity credits locally while a slower coordinator adjusts future allocations outside the attempt path."
          }
        ],
        result: "The design needs roughly 2,200 mean provider slots before headroom, and this number becomes the starting constraint for provider quotas, failover reserve, and admission."
      },
      explanations: [
        {
          title: "The data plane owns the deadline",
          paragraphs: [
            "A request may spend time at the edge, in a local queue, waiting for provider capacity, connecting upstream, and transferring a stream. Every one of those waits consumes the same caller budget.",
            "Derive each stage limit from the time that remains. Independent per-stage timeouts can exceed the caller deadline even when each individual value appears reasonable."
          ]
        },
        {
          title: "The control plane publishes snapshots",
          paragraphs: [
            "A replica needs one self-consistent routing snapshot, not a series of unrelated field updates. That snapshot carries provider inventory, capabilities, weights, exclusions, quota policy, version, scope, generation time, and expiry.",
            "Validate the complete candidate before replacing the last-known-good copy. A partial update could otherwise publish a route before the provider credentials or capability rule it depends on arrives."
          ]
        },
        {
          title: "Streaming changes deployment behavior",
          paragraphs: [
            "A replica can stop accepting new requests while existing streams remain active for minutes. Readiness and load-balancer draining must remove new traffic first, then allow those committed streams a bounded period to finish.",
            "Slow or disconnected clients must also push back into the provider adapter. If the gateway buffers an unlimited upstream stream instead, it has moved the overload into its own memory."
          ]
        }
      ],
      decisionTable: {
        title: "State ownership on the request path",
        columns: ["State", "Owner", "Read by request", "Behavior when unavailable"],
        rows: [
          ["Active requests", "One replica", "Yes, local memory", "Reject or queue within a bound"],
          ["Local provider health", "One replica and network path", "Yes, local snapshot", "Cold-start with conservative traffic"],
          ["Fleet health hint", "Aggregator, cached by replicas", "Yes, cached only", "Use local evidence and an unexpired last value"],
          ["Routing configuration", "Control plane, cached by replicas", "Yes, validated snapshot", "Keep last-known-good policy or use a stated safe fallback"],
          ["Logs and traces", "Telemetry pipeline", "No synchronous read", "Drop, sample, or persist according to the record contract"]
        ]
      },
      diagram: {
        type: "swimlane",
        title: "Three planes around one request",
        caption: "Only the data lane carries the caller response, while control updates enter from above and telemetry leaves below.",
        lanes: [
          { label: "Control", items: ["Validate versioned snapshot", "Publish provider and quota policy", "Retain last-known-good state"] },
          { label: "Data", items: ["Authenticate", "Admit", "Select from local snapshot", "Call provider", "Stream response"] },
          { label: "Telemetry", items: ["Emit request and attempt events", "Batch in bounded queues", "Export metrics, logs, and traces"] }
        ]
      },
      interview: {
        prompt: "Scale the single-process gateway across many application servers without making shared health, configuration, or telemetry a synchronous dependency of every request.",
        answerPoints: [
          "State the request and streaming contract before naming components.",
          "Draw the latency-sensitive request path and pass one absolute deadline through it.",
          "Name the local snapshots required for provider eligibility and capacity.",
          "Place versioned configuration delivery outside the request path and define last-known-good behavior.",
          "Place telemetry on bounded asynchronous paths with a separate durability contract for business records.",
          "Explain cancellation, permit release, stream draining, and cold-start behavior."
        ],
        followups: [
          "What serves traffic when the control plane is unreachable for twenty minutes?",
          "What changes after the first response byte reaches the client?",
          "How does a rolling deployment drain a five-minute stream?",
          "Which state disappears when one replica restarts?"
        ]
      }
    },

    "coordinated-health": {
      contextTitle: "Combine two views without erasing the local one",
      context: [
        "Suppose west replicas time out against A while east replicas continue to succeed. A fleet-wide average can look acceptable, yet it does not answer whether the next west request should use A for this model, credential, and request class.",
        "Use two feedback loops with different jobs. The fast loop reacts to outcomes seen by one replica; the slow loop aggregates events into scoped, expiring hints that help replicas learn from one another.",
        "The router needs an explicit rule when those views disagree. Local negative evidence can override a positive fleet hint, a scoped fleet exclusion can reduce traffic broadly, and bounded probes must refresh stale or recovering evidence before it regains authority."
      ],
      walkthrough: {
        title: "Build the fast and slow health loops",
        intro: "Provider A is healthy from most of the fleet but unreachable from one east-zone subnet.",
        steps: [
          {
            title: "Classify the attempt",
            text: "The replica records transport timeout with provider, model, zone, credential class, attempt ID, event time, and whether cancellation came from the caller or a hedge winner."
          },
          {
            title: "Update local evidence",
            text: "A path-relevant failure updates the east replica's latency and failure window immediately, while intentional cancellation remains neutral."
          },
          {
            title: "Change local eligibility",
            text: "After the stated threshold, the east replica places A in local cooldown and routes within B's available capacity."
          },
          {
            title: "Publish the raw event",
            text: "The replica sends an immutable outcome event asynchronously so the aggregator can recompute policy without changing the completed request."
          },
          {
            title: "Aggregate by scope",
            text: "The aggregator compares east with other zones and publishes either an east-scoped reduction or a broad exclusion with a version and expiry."
          },
          {
            title: "Merge the next snapshot",
            text: "The router applies the newest valid fleet hint but never lets a positive hint clear its still-active local cooldown."
          },
          {
            title: "Probe recovery",
            text: "After cooldown, one bounded probe tests A from the affected path before ordinary traffic returns through slow start."
          }
        ],
        takeaway: "Fleet evidence helps a replica learn about broad incidents, but local reachability keeps authority over the path that must send the next request."
      },
      workedExample: {
        title: "Two timeouts against two hundred successes",
        setup: "The east replica sees two consecutive A timeouts while west replicas report two hundred A successes during the same thirty-second window.",
        facts: [
          { label: "East observations", value: "2 timeouts, 0 successes" },
          { label: "West observations", value: "200 successes, 0 timeouts" },
          { label: "Local cooldown", value: "20 s after 2 path failures" },
          { label: "Fleet hint expiry", value: "30 s" },
          { label: "Recovery exploration", value: "1 probe, then 5% traffic" }
        ],
        steps: [
          {
            title: "Reject the global average",
            text: "The combined success rate is above 99%, but that number conceals complete failure on the east path."
          },
          {
            title: "Honor local cooldown",
            text: "East removes A for twenty seconds while west continues to use A, which preserves service without declaring a provider-wide incident."
          },
          {
            title: "Publish a scoped hint",
            text: "The aggregator sends an east-zone reduction rather than a global exclusion because the evidence differs by locality."
          },
          {
            title: "Test recovery from east",
            text: "One east probe succeeds after cooldown, then A receives five percent of eligible east traffic before its weight rises further."
          }
        ],
        result: "The fleet keeps A available where it works, stops east requests from repeating a known failure, and relearns recovery without a synchronized traffic jump."
      },
      explanations: [
        {
          title: "Health requires a scope key",
          paragraphs: [
            "A provider name is too broad when one model endpoint, credential, region, or request size can fail independently. The health key must describe the path whose evidence will control the next route.",
            "Retain enough raw dimensions to recompute that scope when the failure pattern changes. Promote dimensions into routing policy deliberately so the estimates do not fragment into tiny, noisy samples."
          ]
        },
        {
          title: "Positive and negative evidence are asymmetric",
          paragraphs: [
            "An east success cannot prove that the west network path works. A west transport failure, however, directly describes the path the next west request would use.",
            "A broad provider incident can still arrive as negative fleet evidence. Apply it with an expiry and ejection limit, and compare the traffic shift with known fallback capacity before removing a route."
          ]
        },
        {
          title: "Recovery is part of health",
          paragraphs: [
            "Permanent ejection leaves the router frozen on old failure evidence. Restoring full weight after one success creates the opposite mistake by asking one good request to prove sustained capacity.",
            "Use a jittered cooldown, one claimed half-open probe, and a gradual traffic ramp. Each transition gathers new evidence while bounding the cost if the provider is still weak."
          ]
        }
      ],
      decisionTable: {
        title: "Which evidence controls the next request?",
        columns: ["Evidence", "Scope", "Authority", "Expiry or recovery"],
        rows: [
          ["Local transport failures", "Replica path to provider and model", "Can remove local eligibility", "Cooldown followed by bounded probe"],
          ["Local latency estimate", "Replica path and request class", "Changes local score", "Decays as new samples arrive"],
          ["Fleet negative hint", "Declared provider, model, and locality", "Can reduce or exclude within scope", "Versioned expiry and controlled recovery"],
          ["Fleet positive hint", "Declared provider, model, and locality", "Cannot clear active local failure state", "Expires when aggregation stops"],
          ["Active probe", "Probe origin and credential path", "Tests recovery for the represented path", "Limited rate and payload"]
        ]
      },
      diagram: {
        type: "branch",
        title: "One outcome feeds two health loops",
        caption: "The local branch changes the next decision immediately, while the fleet branch returns a slower hint that remains scoped and expiring.",
        source: "Classified provider attempt",
        branches: [
          { label: "Fast local loop", note: "Update latency, failure window, cooldown, and active count in one replica" },
          { label: "Slow fleet loop", note: "Publish raw event, aggregate by scope, and issue a versioned hint" }
        ],
        destination: "Next immutable eligibility snapshot"
      },
      interview: {
        prompt: "Thirty gateway replicas disagree about Provider A, and the shared health aggregator is eventually consistent. Explain the next routing decision and the recovery path.",
        answerPoints: [
          "Define health by provider, model, request class, credential, and locality.",
          "Keep passive local outcomes in the synchronous selection path.",
          "Publish immutable attempt events asynchronously for fleet aggregation.",
          "Treat fleet output as versioned, scoped, expiring policy rather than a universal boolean.",
          "Let local negative evidence override remote positive evidence for the affected path.",
          "Use bounded probes, jitter, and slow start for recovery.",
          "State what happens when events are late, duplicated, or the aggregator stops."
        ],
        followups: [
          "How do you distinguish a provider incident from one-zone packet loss?",
          "What prevents every replica from failing over at once?",
          "Which cancellations are neutral health samples?",
          "How does a provider recover after receiving no ordinary traffic?"
        ]
      }
    },

    "global-provider-capacity": {
      contextTitle: "A provider quota belongs to the fleet",
      context: [
        "A local semaphore stops one replica at ten attempts. If autoscaling creates twenty replicas, the fleet can still send two hundred attempts against an account whose hard limit is one hundred.",
        "The shared budget may also have several dimensions. Request rate, concurrent attempts, and token consumption need separate accounting because staying below one does not protect the others.",
        "Renewable allocations let a replica admit from a local cache of provider credits. Their stop-admit and reclaim rules must prevent a partitioned replica and its replacement from spending the same hard capacity."
      ],
      walkthrough: {
        title: "Allocate a hard provider budget safely",
        intro: "Provider B permits one hundred concurrent attempts across every gateway replica and region.",
        steps: [
          {
            title: "Name each quota dimension",
            text: "Record B's request-rate, concurrency, input-token, and output-token contracts separately because no single counter represents them all."
          },
          {
            title: "Reserve failure headroom",
            text: "Keep part of B's hard budget outside ordinary leases so a failure of A does not require stealing capacity from requests already admitted to B."
          },
          {
            title: "Allocate expiring credits",
            text: "The coordinator grants each zone a bounded lease whose total, plus reserve and safety slack, never exceeds the provider account limit."
          },
          {
            title: "Split locally without increasing the total",
            text: "A zone may distribute its lease across changing replicas, but adding a replica only divides existing credits and never creates new ones."
          },
          {
            title: "Reject bursts before coordination",
            text: "A cheap tenant and replica limiter absorbs local bursts before a request consumes a leased provider credit or calls a central service."
          },
          {
            title: "Stop before reclaim",
            text: "If renewal fails, the holder stops new attempts early enough that every attempt admitted under the lease finishes before the coordinator can reassign those credits."
          },
          {
            title: "Shed beyond reserve",
            text: "When A fails, B accepts only the traffic covered by unused ordinary capacity and reserved credits, while lower-priority excess fails early."
          }
        ],
        takeaway: "Local limiters protect replicas and absorb bursts, while expiring fleet allocations keep aggregate provider use within the account contract."
      },
      workedExample: {
        title: "One hundred B slots across three zones",
        setup: "Provider B has a hard concurrency limit of one hundred, three zones use twenty-five normal slots each, twenty slots are held for failover, and five slots remain as safety slack.",
        facts: [
          { label: "Provider B concurrency", value: "100" },
          { label: "Normal zone leases", value: "25 + 25 + 25 = 75" },
          { label: "Failover reserve", value: "20" },
          { label: "Safety slack", value: "5" },
          { label: "Maximum attempt duration", value: "30 s" },
          { label: "Clock and communication margin", value: "5 s" },
          { label: "Lease reclaim time", value: "t = 60 s" }
        ],
        steps: [
          {
            title: "Prove the normal allocation",
            text: "Seventy-five normal credits plus twenty reserve credits plus five slack credits equals the provider limit of one hundred."
          },
          {
            title: "Scale replicas without scaling quota",
            text: "If a zone grows from five to ten replicas, each replica receives a smaller share of the same twenty-five zone credits."
          },
          {
            title: "Handle a coordinator partition",
            text: "A zone that cannot renew stops new attempts at t = 25 s. A thirty-second attempt then drains by t = 55 s, leaving five seconds for clock and communication safety before reclaim at t = 60 s."
          },
          {
            title: "Bound single-provider failover",
            text: "If A fails and sixty additional requests target B, only twenty reserve credits are available, so forty requests must wait within a bound or fail early."
          }
        ],
        result: "Replica count cannot push B above one hundred concurrent attempts, and failover exposes the real capacity shortage instead of turning it into a second provider outage."
      },
      explanations: [
        {
          title: "A lease needs two times",
          paragraphs: [
            "One lease timestamp cannot safely govern both admission and reassignment. The holder needs a last-admit time for new attempts, while the coordinator needs a later reclaim time before it gives those credits to another replica.",
            "The interval between them must cover the longest permitted attempt plus clock and communication safety. Without that gap, an old holder and a replacement can consume the same hard quota during a partition."
          ]
        },
        {
          title: "Fail-open is a product decision with a physical limit",
          paragraphs: [
            "A soft tenant limit may permit a small emergency allowance while its coordinator is unavailable. A hard provider-account limit cannot safely invent credits whose ownership is unknown.",
            "Define partition behavior by workload rather than with one fleet-wide switch. Interactive traffic, internal batch work, and safety probes may receive different reserved shares of the known capacity."
          ]
        },
        {
          title: "Tenant fairness precedes provider selection",
          paragraphs: [
            "A router can respect the account quota while one customer occupies every leased slot. The provider is protected, but other tenants still lose service.",
            "Decide who receives scarce capacity before deciding where to route it. Weighted queues or reserved shares establish tenant fairness, then the provider selector spends the admitted slot."
          ]
        }
      ],
      decisionTable: {
        title: "Different quotas answer different questions",
        columns: ["Quota", "Protects", "Typical scope", "Failure policy"],
        rows: [
          ["Tenant request rate", "Fairness and commercial contract", "Tenant and model class", "429 with stated retry guidance"],
          ["Tenant concurrency", "Long requests occupying all slots", "Tenant and priority", "Queue within a bound or reject"],
          ["Provider request rate", "Provider rate contract", "Provider account and region", "Spend tokens, then delay or reject"],
          ["Provider concurrency", "In-flight provider capacity", "Provider account", "Consume leased credit or reject"],
          ["Input and output tokens", "Cost and token quota", "Tenant plus provider account", "Estimate before admission and reconcile after completion"]
        ]
      },
      diagram: {
        type: "branch",
        title: "Split one hard quota without multiplying it",
        caption: "Every normal lease, reserve credit, and safety credit comes from the same provider-account budget.",
        source: "Provider B: 100 concurrent attempts",
        branches: [
          { label: "Zone east: 25", note: "Divide among current replicas" },
          { label: "Zone central: 25", note: "Divide among current replicas" },
          { label: "Zone west: 25", note: "Divide among current replicas" },
          { label: "Failover reserve: 20", note: "Release only under priority policy" },
          { label: "Safety slack: 5", note: "Covers accounting and timing uncertainty" }
        ],
        destination: "Local admission before each provider attempt"
      },
      interview: {
        prompt: "Thirty autoscaled replicas share a provider account that permits one hundred concurrent requests. Design admission during normal operation, a coordinator partition, and single-provider failover.",
        answerPoints: [
          "Separate request-rate, concurrency, and token quotas.",
          "Place tenant fairness and local burst control before provider admission.",
          "Allocate a bounded sum of renewable provider credits across the fleet.",
          "Keep failover reserve and safety slack outside ordinary allocations.",
          "Define last-admit, renewal, expiry, drain, and reclaim times.",
          "Stop new work when safe credits expire instead of inventing capacity.",
          "Calculate how much failover traffic the surviving provider cannot absorb."
        ],
        followups: [
          "What happens when a lease holder pauses for forty seconds?",
          "How does autoscaling change per-replica capacity?",
          "Which tenants lose traffic when failover reserve is exhausted?",
          "How do you reconcile estimated and actual output tokens?"
        ]
      }
    },

    "structured-log-flow": {
      contextTitle: "Choose the write contract before the queue",
      context: [
        "A request log helps an operator reconstruct what happened. A billing or audit event can create a money or compliance obligation, so sending both through one best-effort exporter gives two unlike records the same loss policy.",
        "Ordinary telemetry should leave the response path through a bounded memory queue and a nearby collector. Queue capacity, retry time, sampling, and drop counters make an exporter outage visible without letting it exhaust gateway memory.",
        "A record that must survive needs an acknowledged durable append and an idempotent consumer. A stable event ID helps identify duplicates, but it does not make the original write durable or make a later business side effect atomic."
      ],
      walkthrough: {
        title: "Fork one completed request into two write paths",
        intro: "A request succeeds through Provider B after Provider A times out, and the gateway must record both operational evidence and a billable outcome.",
        steps: [
          {
            title: "Finish the user contract",
            text: "The gateway records the logical outcome, releases request capacity, and does not wait for an ordinary log backend before completing the client response."
          },
          {
            title: "Emit physical attempt events",
            text: "A timeout event for A and a success event for B enter a bounded in-process queue with request ID, trace ID, attempt ID, provider, policy version, and timing."
          },
          {
            title: "Batch through a local collector",
            text: "The collector batches and retries export while its own memory limiter and queue capacity protect both collector and application."
          },
          {
            title: "Apply the telemetry loss policy",
            text: "When the queue fills, the system drops or samples the chosen class, increments a loss counter, and preserves process memory."
          },
          {
            title: "Append the business event",
            text: "If billing must survive failure, the service appends a stable event to a durable stream or transactional outbox under an explicit response-consistency rule."
          },
          {
            title: "Consume idempotently",
            text: "The ledger consumer uses a unique event key or transactional inbox so duplicate delivery cannot apply the same charge twice."
          },
          {
            title: "Redact before either path",
            text: "Prompts, responses, credentials, and customer content stay out by default, while approved metadata follows retention and access policy."
          }
        ],
        takeaway: "Telemetry may trade completeness for bounded service health, while a business ledger pays a separate latency and storage cost for durable, idempotent delivery."
      },
      workedExample: {
        title: "Size a ten-minute telemetry outage",
        setup: "The gateway handles 1,000 logical requests per second, averages 1.10 provider attempts per request, and emits one request event plus one event per attempt at 800 bytes each.",
        facts: [
          { label: "Request events", value: "1,000 events/s" },
          { label: "Attempt events", value: "1,100 events/s" },
          { label: "Total event rate", value: "2,100 events/s" },
          { label: "Average encoded event", value: "800 B" },
          { label: "Memory queue", value: "256 MiB" },
          { label: "Sink outage", value: "600 s" }
        ],
        steps: [
          {
            title: "Compute byte rate",
            text: "2,100 events/s multiplied by 800 bytes produces 1.68 MB/s before batching and transport overhead."
          },
          {
            title: "Compute outage volume",
            text: "1.68 MB/s multiplied by six hundred seconds produces about 1.0 GB of telemetry during the outage."
          },
          {
            title: "Find the memory limit",
            text: "A 256 MiB in-memory queue fills after roughly one hundred sixty seconds, well before the sink returns."
          },
          {
            title: "Choose the overflow contract",
            text: "Ordinary success events may sample or drop after the bound, while errors and durable billing events follow separately budgeted paths."
          },
          {
            title: "Expose the loss",
            text: "Queue occupancy, failed exports, dropped events, and oldest-event age remain available through a small independent health signal."
          }
        ],
        result: "The gateway stays within its memory ceiling, operators can quantify missing telemetry, and durability-required records do not disappear with the ordinary log queue."
      },
      explanations: [
        {
          title: "Bounded does not mean lossless",
          paragraphs: [
            "An in-memory queue can absorb a short exporter pause, but it loses data when the queue fills or the process exits. A disk-backed queue can survive restart, trading that retention for finite disk capacity and additional I/O.",
            "A durable message service can retain data through a longer outage. It also introduces its own quotas, retention window, partition behavior, and operational failures, which must be included in the write contract."
          ]
        },
        {
          title: "Stable IDs need atomic consumption",
          paragraphs: [
            "Suppose a consumer applies a charge and records the event ID in a second operation. A crash between those writes can replay the event and apply the charge twice despite the stable ID.",
            "Deduplication must share an atomic boundary with the business effect. A unique constraint, transactional inbox, or idempotent downstream API can provide that boundary."
          ]
        },
        {
          title: "Privacy begins before export",
          paragraphs: [
            "Backend redaction happens after the event has crossed queues, collectors, and storage boundaries. Any sensitive value already present has escaped the gateway's first control point.",
            "Construct events from an allowlist of permitted metadata. Then give each record class an explicit retention, access, and deletion policy before it leaves the process."
          ]
        }
      ],
      decisionTable: {
        title: "Match each record to its failure contract",
        columns: ["Record", "Delivery target", "When full", "Correctness mechanism"],
        rows: [
          ["Request and attempt telemetry", "Bounded collector pipeline", "Sample or drop by priority", "Loss counters and correlated identifiers"],
          ["Metrics", "In-process aggregation and collector", "Preserve small health set, shed optional series", "Stable low-cardinality dimensions"],
          ["Traces", "Collector with stated sampling", "Apply sampling policy", "Trace context and request-attempt span structure"],
          ["Billing event", "Durable append or outbox", "Backpressure or fail according to product contract", "Stable ID plus atomic dedupe and side effect"],
          ["Security audit event", "Restricted durable store", "Follow stated fail-open or fail-closed rule", "Immutable identity, access control, and retention"]
        ]
      },
      diagram: {
        type: "branch",
        title: "Two write contracts leave the gateway",
        caption: "The operational branch protects request latency with bounded loss, while the business branch pays for acknowledged durability and idempotent replay.",
        source: "Completed logical request and physical attempts",
        branches: [
          { label: "Operational telemetry", note: "Bounded memory, local collector, batch, retry, sample or drop" },
          { label: "Billing or audit", note: "Durable append, stable event ID, replay, atomic dedupe" }
        ],
        destination: "Operational search and business ledger"
      },
      interview: {
        prompt: "The log collector cannot export for ten minutes. Keep request latency and memory bounded while preserving the records that the business cannot lose.",
        answerPoints: [
          "Separate request, attempt, metric, trace, billing, and audit contracts.",
          "Calculate event rate, byte rate, queue fill time, and outage volume.",
          "Use bounded local queues and state the exact sampling or drop order.",
          "Expose queue occupancy, exporter failures, dropped records, and event age.",
          "Send durability-required events through an acknowledged append or outbox.",
          "Make replay safe with atomic dedupe and side-effect handling.",
          "Redact content before it crosses the application boundary."
        ],
        followups: [
          "What data is lost when the gateway process restarts?",
          "What happens when a disk-backed queue fills?",
          "Can the response succeed if its billing append fails?",
          "How do you detect silent telemetry loss?"
        ]
      }
    },

    "gateway-observability": {
      contextTitle: "Observe the user request and every provider attempt",
      context: [
        "A client request can succeed through B after A timed out. The user saw one successful logical result, while the system spent two physical attempts and still needs A's latency, failure, and capacity cost as provider evidence.",
        "Use each signal for the question it answers. Metrics aggregate bounded dimensions, traces preserve the request-to-attempt structure, and logs carry event detail; a request ID belongs in traces or logs, not as an unbounded metric label.",
        "A stream can deliver its first token quickly and then stall. Time to first byte captures initial responsiveness, while inter-chunk gaps, complete duration, and terminal reason describe whether the full response remained healthy."
      ],
      walkthrough: {
        title: "Instrument success after fallback",
        intro: "Provider A times out after 700 ms, Provider B succeeds after 180 ms, and the gateway returns a valid response within its one-second objective.",
        steps: [
          {
            title: "Create one root span",
            text: "The root represents the logical gateway request from admission through the final client outcome and carries the request deadline and routing policy version."
          },
          {
            title: "Create sibling attempt spans",
            text: "Attempt A and Attempt B are children of the root rather than children of each other, even if fallback starts B after A fails."
          },
          {
            title: "Record both outcome layers",
            text: "The gateway request records success, A records provider timeout, and B records success, which preserves the difference between user reliability and provider reliability."
          },
          {
            title: "Update aggregate metrics",
            text: "Low-cardinality counters and histograms observe gateway outcome, provider outcome, queue time, attempt latency, active work, and attempts per request."
          },
          {
            title: "Attach searchable context",
            text: "Request ID, attempt ID, full error details, safe tenant reference, and policy version remain in correlated logs and traces rather than metric labels."
          },
          {
            title: "Sample with the full trace in mind",
            text: "Head sampling is cheap but can miss late failures, while tail sampling can retain slow or failed traces only after all spans reach the same sampling decision point."
          },
          {
            title: "Alert from user impact",
            text: "Gateway error-budget burn and saturation page the team, while provider attempt failures and routing versions explain the cause."
          }
        ],
        takeaway: "A successful fallback is a gateway success, a provider failure, and extra physical work at the same time, so the signal model must preserve all three facts."
      },
      workedExample: {
        title: "Score one successful request correctly",
        setup: "A request waits 40 ms for admission, A times out at 700 ms, B succeeds in 180 ms, and the final response completes at 940 ms under a one-second objective.",
        facts: [
          { label: "Gateway outcome", value: "Success in 940 ms" },
          { label: "Attempt A", value: "Provider timeout in 700 ms" },
          { label: "Attempt B", value: "Success in 180 ms" },
          { label: "Queue time", value: "40 ms" },
          { label: "Attempts per request", value: "2.0" },
          { label: "Latency objective", value: "1,000 ms" }
        ],
        steps: [
          {
            title: "Record the user SLI",
            text: "The logical request increments gateway success and observes 940 ms in the end-to-end latency histogram."
          },
          {
            title: "Record provider evidence",
            text: "A increments provider timeout while B increments provider success, and each attempt observes its own latency."
          },
          {
            title: "Record amplification",
            text: "Two physical attempts for one logical request produce an attempts-per-request observation of 2.0."
          },
          {
            title: "Preserve trace shape",
            text: "The root span contains sibling A and B spans, with events marking fallback and final provider selection."
          },
          {
            title: "Choose the alert",
            text: "One A timeout should not page while fallback meets the user objective, but a rising timeout rate plus shrinking B headroom should warn before gateway success falls."
          }
        ],
        result: "The dashboard shows a successful user request without hiding Provider A's failure or the doubled provider cost that made success possible."
      },
      explanations: [
        {
          title: "Metric volume is series math",
          paragraphs: [
            "Recording one histogram observation does not export one network event. Export volume depends on the active label combinations, bucket count, and export interval of the in-process aggregation.",
            "Provider, stable model class, route, outcome, and policy cohort can form bounded label sets. Request IDs, raw prompt hashes, and full error text create unbounded cardinality and belong in traces or logs."
          ]
        },
        {
          title: "Tail sampling changes collector routing",
          paragraphs: [
            "A tail sampler cannot decide whether a trace was slow or erroneous until it has seen the relevant spans. When several collector gateways share work, every span for one trace must reach the same sampling owner.",
            "That requirement adds trace-ID-aware routing and buffered sampler state to telemetry capacity planning. The dependency remains outside the user response path, but it still needs explicit memory and failure bounds."
          ]
        },
        {
          title: "Streaming needs more than one timer",
          paragraphs: [
            "Time to first byte detects a slow model start. Inter-chunk gaps and complete-stream duration catch a different failure in which output begins quickly and then stalls.",
            "A stream can end after the client received useful bytes but before it received a valid complete result. Record that partial terminal reason separately from both zero-byte failure and complete success."
          ]
        }
      ],
      decisionTable: {
        title: "Place each field in the right signal",
        columns: ["Field or measurement", "Metric", "Trace", "Log"],
        rows: [
          ["Gateway success and latency", "Counter and histogram", "Root span status and duration", "Final request event"],
          ["Provider attempt outcome", "Bounded provider and outcome labels", "Child attempt span", "Attempt event with error detail"],
          ["Request ID", "Never a label", "Trace attribute or correlation", "Searchable field"],
          ["Policy version", "Bounded rollout cohort when controlled", "Root and attempt attribute", "Request and attempt field"],
          ["Prompt or response content", "Never", "Excluded by default", "Excluded by default under data policy"],
          ["Time to first byte", "Histogram", "Span event or attribute", "Attempt timing field"]
        ]
      },
      diagram: {
        type: "branch",
        title: "One request span, two sibling attempts",
        caption: "The logical result remains the parent outcome while each physical provider attempt retains its own status and timing.",
        source: "Gateway request span: success, 940 ms",
        branches: [
          { label: "Attempt A span", note: "Timeout, 700 ms, fallback trigger" },
          { label: "Attempt B span", note: "Success, 180 ms, final provider" }
        ],
        destination: "Gateway metrics, correlated logs, and user SLI"
      },
      interview: {
        prompt: "Design metrics, logs, and traces for a gateway where a user request can create retries, hedges, and streamed provider attempts.",
        answerPoints: [
          "Separate logical request outcomes from physical attempt outcomes.",
          "Use a root request span with one child span per provider attempt.",
          "Measure end-to-end latency, queue time, attempt latency, active work, and amplification.",
          "Measure time to first byte and complete-stream duration separately.",
          "Keep metric labels bounded and move identifiers and error detail to traces and logs.",
          "Explain head versus tail sampling and trace-ID-aware collector routing.",
          "Alert on user impact and saturation, then diagnose with provider signals."
        ],
        followups: [
          "Does a successful fallback consume the gateway error budget?",
          "How do you retain rare slow traces without storing every trace?",
          "What breaks if spans from one trace reach different tail samplers?",
          "How do you classify a stream that delivers tokens and then resets?"
        ]
      }
    },

    "overload-failure-drills": {
      contextTitle: "A failure drill is a state transition, not a fault list",
      context: [
        "Injecting a provider fault at idle load proves little about incident behavior. Run the drill under a stated offered load and record its scope, detection delay, capacity loss, steady degraded behavior, and recovery condition.",
        "A latency fault can be worse than an immediate error near saturation. A consecutive-error breaker may remain closed while slow attempts occupy every slot and push otherwise useful work past its deadline.",
        "Recovery can create another surge when many replicas probe or restore weight together. Jitter, bounded probes, and slow start therefore belong in the drill's assertions rather than in an optional configuration note."
      ],
      walkthrough: {
        title: "Run one provider slowdown end to end",
        intro: "Provider A becomes six hundred milliseconds slower without returning errors while the gateway is already near normal capacity.",
        steps: [
          {
            title: "Fix the offered load",
            text: "Replay the same arrival schedule, request mix, deadlines, caps, and random seed used by the healthy baseline."
          },
          {
            title: "Inject one scoped fault",
            text: "Add six hundred milliseconds to A in one zone for a stated duration without changing B or the client schedule."
          },
          {
            title: "Observe the first reliable signal",
            text: "Attempt latency and occupied A slots rise before error count, while queue delay shows whether the slowdown has reached callers."
          },
          {
            title: "Enter the degraded state",
            text: "The router reduces A traffic only within B's spare and reserved capacity, then admission rejects the remainder before deadlines become impossible."
          },
          {
            title: "Hold the invariant",
            text: "Provider and application caps, queue bytes, attempts per request, and telemetry memory remain below their stated ceilings throughout the fault."
          },
          {
            title: "Probe after cooldown",
            text: "Jittered replicas admit a bounded number of A probes instead of sending ordinary traffic simultaneously."
          },
          {
            title: "Ramp and compare",
            text: "A regains traffic through slow start while the final report compares success, p95, p99, rejected load, and amplification with the baseline."
          }
        ],
        takeaway: "The target is not zero errors during every outage, but bounded work, intentional shedding, visible degradation, and a recovery path that cannot create another overload."
      },
      workedExample: {
        title: "The surviving provider cannot absorb the shift",
        setup: "The gateway receives 1,000 requests per second, A normally receives 600, B receives 400, and B can safely accept only 150 additional requests per second during the incident.",
        facts: [
          { label: "Offered load", value: "1,000 requests/s" },
          { label: "Normal A share", value: "600 requests/s" },
          { label: "Normal B share", value: "400 requests/s" },
          { label: "Safe B headroom", value: "150 requests/s" },
          { label: "A latency increase", value: "+600 ms" },
          { label: "Caller deadline", value: "1.2 s" }
        ],
        steps: [
          {
            title: "Detect saturation before errors",
            text: "A's active attempts and p95 rise even though status codes remain successful, so latency-aware evidence reacts before a 5xx breaker."
          },
          {
            title: "Spend B headroom",
            text: "The router shifts at most 150 requests/s to B, raising B from 400 to its safe 550 requests/s ceiling."
          },
          {
            title: "Expose the shortage",
            text: "The remaining 450 requests/s cannot move safely to B, so admission rejects or deprioritizes them rather than queueing past the deadline."
          },
          {
            title: "Stop retry amplification",
            text: "Retry and hedge budgets contract during the broad slowdown because extra attempts would consume the same scarce slots."
          },
          {
            title: "Restore A gradually",
            text: "After limited probes meet the recovery threshold, A returns through a staged weight increase while B reserve remains protected."
          }
        ],
        result: "The system preserves 550 requests/s through B, tests whether A can still serve useful work, and rejects unavoidable excess without overloading the surviving provider."
      },
      explanations: [
        {
          title: "Slow failure consumes capacity",
          paragraphs: [
            "An immediate reset frees its provider slot quickly, while a slow attempt can hold the same slot until the caller deadline is nearly gone. The latter removes useful capacity before it produces an error sample.",
            "Track active duration, queue delay, and deadline remaining alongside terminal outcomes. The router can then react to the capacity loss instead of waiting for a consecutive-error threshold."
          ]
        },
        {
          title: "Retry policy depends on load",
          paragraphs: [
            "One retry can repair an isolated reset. When every attempt fails for the same reason, that policy can add one hundred percent more work to an already constrained system.",
            "Run the same fault at ordinary load and near saturation. Attempts per request, rejected work, and provider queueing reveal when the reliability mechanism becomes failure amplification."
          ]
        },
        {
          title: "Cold start is a recovery incident",
          paragraphs: [
            "After a fleet restart, every replica may have empty local health and a full local concurrency allowance. They can all test the same default provider at once even though no upstream incident occurred.",
            "Retain usable control snapshots where possible and begin with conservative traffic. Jitter probes, then increase weight only after enough scoped evidence arrives to support the change."
          ]
        }
      ],
      decisionTable: {
        title: "Failure drills with measurable end states",
        columns: ["Fault", "First reliable signal", "Degraded behavior", "Recovery proof"],
        rows: [
          ["Provider latency inflation", "Attempt latency, active slots, queue delay", "Shift within reserve and shed excess", "Bounded probes and sustained latency threshold"],
          ["Provider 429 burst", "Outcome class and retry guidance", "Respect pushback and contract retry budget", "Probe after retry interval"],
          ["Quota coordinator loss", "Lease renewal age", "Use safe credits until last-admit time", "Fresh allocation with no double spend"],
          ["Telemetry sink loss", "Queue occupancy and export failures", "Drop or persist by record class", "Drain backlog within a bounded rate"],
          ["Zone partition", "Local transport failures against remote success", "Remove provider locally", "Probe from affected zone"],
          ["Fleet restart", "Cold local state and synchronized load", "Conservative admission and jitter", "Slow-start traffic after scoped success"]
        ]
      },
      diagram: {
        type: "timeline",
        title: "Provider slowdown and controlled recovery",
        caption: "Traffic moves only into known B headroom, excess is rejected, and A returns through probes before ordinary weight.",
        events: [
          { label: "t0: healthy", note: "A serves 600/s and B serves 400/s with bounded queues" },
          { label: "t1: A slows", note: "A latency and active slots rise before status errors" },
          { label: "t2: degrade", note: "Shift 150/s to B and shed unavoidable excess" },
          { label: "t3: cooldown", note: "Retry budget contracts while A ordinary traffic stays reduced" },
          { label: "t4: probe", note: "Jittered A probes test the affected scope" },
          { label: "t5: slow start", note: "A weight rises in stages while caps and SLOs remain visible" }
        ]
      },
      interview: {
        prompt: "Provider A becomes slow without returning errors while Provider B has limited spare capacity. Walk detection, degradation, shedding, and recovery.",
        answerPoints: [
          "Fix the arrival schedule, deadline, caps, and request mix before the drill.",
          "Use latency, active work, and queue delay rather than waiting only for error count.",
          "Calculate the exact share B can absorb without losing its own SLO.",
          "Shed excess before it enters a queue that cannot meet the caller deadline.",
          "Contract retry and hedge budgets during broad failure.",
          "Verify application, provider, queue, and telemetry bounds throughout the incident.",
          "Recover through jittered probes and staged traffic rather than synchronized restoration."
        ],
        followups: [
          "Which status should an overloaded gateway return to a tenant?",
          "What misleading signal remains green during latency inflation?",
          "How do you drain a telemetry backlog without causing another outage?",
          "What changes when the failure affects only one zone?"
        ]
      }
    },

    "rehearsal-gateway-design": {
      contextTitle: "Build the answer around ownership and failure",
      context: [
        "Begin with the constraints that change the gateway's state ownership: traffic, streaming, tenancy, objectives, and provider contracts. Those answers determine which health, quota, and telemetry decisions can remain local and which must be coordinated.",
        "Draw one logical request and each physical provider attempt before adding shared systems. The latency-sensitive path stays readable, and every later control or telemetry component must justify the state it supplies.",
        "For each major component, write what happens when it is unavailable, which resource remains bounded, and what proves recovery. The whiteboard then describes executable behavior instead of only showing where data might travel."
      ],
      walkthrough: {
        title: "Use sixty minutes as a sequence of proofs",
        intro: "The round duration is an assumption, so state it and adjust when the interviewer provides a different clock.",
        steps: [
          {
            title: "Minutes 0 to 7: clarify",
            text: "Ask about request and streaming semantics, traffic, latency and availability objectives, tenancy, provider quotas, regions, data retention, and cost."
          },
          {
            title: "Minutes 7 to 13: estimate",
            text: "Calculate logical concurrency, provider attempts, failover demand, telemetry byte rate, and the headroom required by the stated objectives."
          },
          {
            title: "Minutes 13 to 23: trace the request",
            text: "Draw edge authentication, tenant admission, local queue, provider eligibility, capacity acquisition, adapter call, streaming commit, and client outcome."
          },
          {
            title: "Minutes 23 to 33: assign state",
            text: "Place active counts and path health locally, then add versioned fleet hints, provider quota allocations, and validated configuration delivery."
          },
          {
            title: "Minutes 33 to 41: design telemetry",
            text: "Separate request and attempt evidence from durable business records, size the queues, and define labels, sampling, redaction, loss, and replay."
          },
          {
            title: "Minutes 41 to 54: walk failures",
            text: "Trace a provider slowdown, quota-coordinator partition, collector outage, and zone loss through detection, degraded behavior, bounds, and recovery."
          },
          {
            title: "Minutes 54 to 60: defend",
            text: "State the main trade-offs, identify the first scaling limit, and summarize which dependencies the data plane can lose while it continues serving."
          }
        ],
        takeaway: "Requirements, arithmetic, request path, state ownership, telemetry contracts, and two detailed failure walks create an answer the interviewer can test from any direction."
      },
      workedExample: {
        title: "A complete set of interview assumptions",
        setup: "Use a three-zone service with 1,000 requests per second, streamed responses, a two-second mean provider duration, 1.10 attempts per request, and hard provider concurrency limits.",
        facts: [
          { label: "Logical traffic", value: "1,000 requests/s" },
          { label: "Mean logical concurrency", value: "About 2,000 before gateway overhead" },
          { label: "Physical attempt traffic", value: "1,100 attempts/s" },
          { label: "Mean provider concurrency", value: "About 2,200" },
          { label: "Telemetry event traffic", value: "2,100 events/s" },
          { label: "Availability objective", value: "99.9% within stated latency objective" },
          { label: "Deployment", value: "30 replicas across 3 zones" }
        ],
        steps: [
          {
            title: "Expose the capacity constraint",
            text: "If provider quotas total less than about 2,200 concurrent attempts plus headroom, the design must reduce amplification, shed load, or renegotiate the traffic assumption."
          },
          {
            title: "Keep eligibility local",
            text: "Each replica selects from local path health, current permits, cached fleet hints, and a validated configuration snapshot."
          },
          {
            title: "Coordinate what is truly global",
            text: "Provider-account capacity and tenant contracts receive fleet coordination, while replicas consume bounded local allocations without a central call per attempt."
          },
          {
            title: "Separate evidence from business state",
            text: "Ordinary request and attempt events use bounded telemetry queues, while billing or audit records use an acknowledged durable path with atomic deduplication."
          },
          {
            title: "Prove degraded service",
            text: "When one provider slows, traffic moves only into reserved headroom, unavoidable excess fails early, and recovery uses scoped probes and slow start."
          }
        ],
        result: "The answer connects every component to a measured need, names what happens when coordination fails, and makes the unavoidable capacity trade-offs explicit."
      },
      explanations: [
        {
          title: "Draw the normal path before side systems",
          paragraphs: [
            "The client-to-provider path establishes the deadline, admission point, selection decision, attempt boundary, and response commit. It also exposes any dependency that can block the request synchronously.",
            "Only then add control arrows above the path and telemetry arrows below it. Each new box should supply or consume state already named in the request trace."
          ]
        },
        {
          title: "Use numbers to reject impossible failover",
          paragraphs: [
            "If A fails, B can accept the shift only when its reserved and unused capacity covers the offered load. A routing algorithm cannot create the missing provider slots.",
            "When the arithmetic does not fit, choose which traffic loses service. Priority admission, bounded queueing, and early rejection are explicit degraded policies, not failures to finish the design."
          ]
        },
        {
          title: "A failure walk has five parts",
          paragraphs: [
            "Walk one fault from cause to recovery. Name its scope, the first reliable detection signal, the steady degraded behavior, the resource bound that still holds, and the evidence required to restore service.",
            "Those steps force every component to explain an action. A list of products cannot substitute for the behavior the interviewer asked you to design."
          ]
        }
      ],
      decisionTable: {
        title: "Questions the whiteboard must answer",
        columns: ["Question", "Decision", "Evidence to show"],
        rows: [
          ["Can the request finish on time?", "One propagated deadline and bounded waits", "Latency budget and queue policy"],
          ["Which provider is eligible?", "Local path evidence plus scoped fleet hint", "Health merge and recovery rule"],
          ["Can the fleet spend this capacity?", "Tenant admission plus provider allocations", "Quota equation and partition behavior"],
          ["What happens after stream commit?", "No invisible provider replacement", "Commit point and cancellation path"],
          ["Can telemetry fail safely?", "Bounded operational path and separate durable ledger", "Queue fill math and loss policy"],
          ["Can recovery overload the provider?", "Jittered probes and slow start", "Traffic ramp and capacity ceiling"]
        ]
      },
      diagram: {
        type: "swimlane",
        title: "A whiteboard that preserves the runtime boundaries",
        caption: "The center lane answers the user request, the state lane changes future decisions, and the evidence lane records behavior without delaying the client.",
        lanes: [
          { label: "Request path", items: ["Edge and auth", "Tenant admission", "Gateway replica", "Provider capacity", "Provider A or B", "Stream to client"] },
          { label: "State and coordination", items: ["Local health", "Expiring fleet hints", "Quota allocations", "Versioned configuration"] },
          { label: "Evidence and durability", items: ["Request and attempt spans", "Low-cardinality metrics", "Bounded logs", "Durable billing or audit events"] }
        ]
      },
      interview: {
        prompt: "Scale the adaptive two-provider gateway from the coding round into a production service across many replicas and zones.",
        answerPoints: [
          "Clarify request equivalence, streaming, tenancy, objectives, scale, quotas, and cost.",
          "Use Little's Law and attempts per request to estimate logical and provider concurrency.",
          "Trace one request through admission, selection, capacity, transport, commit, and cleanup.",
          "Keep path-specific health local while distributing scoped, expiring fleet hints asynchronously.",
          "Coordinate hard provider capacity through bounded local allocations and reserve.",
          "Publish validated configuration snapshots with last-known-good behavior.",
          "Separate bounded telemetry from durability-required billing and audit records.",
          "Walk provider slowdown and coordination loss through detection, degradation, bounds, and recovery."
        ],
        followups: [
          "The shared health service is stale for fifteen minutes. What changes on the request path?",
          "A provider has one account-wide concurrency limit. What happens during a partition?",
          "The collector is down long enough to fill every memory queue. What is lost?",
          "Provider A sends three tokens and resets. Can Provider B continue the response?",
          "All replicas restart at once. How do you avoid a probe and connection stampede?"
        ]
      }
    }
  };

  window.DECAGON_GUIDES = {
    ...(window.DECAGON_GUIDES || {}),
    ...entries
  };
})();
