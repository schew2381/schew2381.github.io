(() => {
  "use strict";

  const sharedPhases = [
    { id: "scope", number: "01", short: "Scope", title: "Clarify the system", minutes: "0 to 5 min" },
    { id: "requirements", number: "02", short: "Requirements", title: "Write the contract", minutes: "5 to 10 min" },
    { id: "scale", number: "03", short: "Numbers", title: "Size the workload", minutes: "10 to 17 min" },
    { id: "entities", number: "04", short: "Entities", title: "Name state and interfaces", minutes: "17 to 25 min" },
    { id: "sketch", number: "05", short: "First sketch", title: "Draw the healthy path", minutes: "25 to 35 min" },
    { id: "evolve", number: "06", short: "Evolve", title: "Add scale and failure", minutes: "35 to 50 min" },
    { id: "defend", number: "07", short: "Defend", title: "Compare and close", minutes: "50 to 60 min" }
  ];

  const gateway = {
    id: "gateway",
    track: "gateway-design",
    label: "Production gateway",
    title: "Turn the coding prototype into a production fleet",
    premise: "One logical model can run on two interchangeable providers whose latency, failures, and available capacity change over time.",
    guidedModules: {
      "production-fleet": ["scope", "requirements", "scale", "entities", "sketch"],
      "telemetry-recovery": ["evolve", "defend"]
    },
    interviewer: [
      {
        question: "Do clients use buffered responses, streaming responses, or both?",
        answer: "Both. A streamed response commits when the first response bytes reach the caller, so failover after that point cannot be invisible."
      },
      {
        question: "What traffic and deployment should I design for?",
        answer: "Assume 1,000 logical requests per second, a three-times burst, 1.10 attempts per request, a 2-second mean provider-attempt duration, and 30 replicas across three zones."
      },
      {
        question: "Which limits are hard constraints?",
        answer: "Each provider account has a hard concurrency budget, tenants have request and token budgets, and the gateway must keep its own queues and memory bounded."
      },
      {
        question: "Which records may be lost during an outage?",
        answer: "Sampled operational telemetry may follow a stated bounded-loss policy. Billing and audit events must be durable, replayable, and deduplicated."
      },
      {
        question: "What should remain outside this design?",
        answer: "Do not design model training, provider internals, prompt evaluation, or semantic equivalence testing beyond the stated interchangeable-provider contract."
      }
    ],
    phases: [
      {
        ...sharedPhases[0],
        purpose: "Ask enough questions to turn the coding prompt into a bounded production problem before adding infrastructure.",
        fields: [
          {
            id: "scope_and_actors",
            label: "Actors and system boundary",
            prompt: "Who calls the gateway, what does it own, and what starts or ends one logical request?",
            placeholder: "Clients, edge, gateway fleet, provider accounts, control services...",
            minChars: 80
          },
          {
            id: "assumptions_and_non_goals",
            label: "Confirmed assumptions and non-goals",
            prompt: "Separate interviewer-supplied facts from assumptions you invented, then state what you will not design.",
            placeholder: "Confirmed: providers are interchangeable... Assumed: three zones... Out of scope: model training...",
            minChars: 100
          }
        ],
        coach: {
          lead: "A useful opening changes the design target. It does not collect questions for their own sake.",
          rows: [
            ["Response contract", "Buffered and streamed inference through one normalized public API", "Streaming creates a response commit point and a draining problem."],
            ["Scale", "1,000 logical requests/s with a 3x burst across three zones", "This drives attempts, permits, replicas, connections, and telemetry."],
            ["Hard limits", "Provider-account, tenant, application, and queue bounds", "Autoscaling the gateway cannot create upstream capacity."],
            ["Non-goals", "Training, provider internals, and semantic evaluation", "These would consume interview time without changing the forwarding system."]
          ]
        }
      },
      {
        ...sharedPhases[1],
        purpose: "Keep features separate from measurable qualities so every later component has a reason to exist.",
        fields: [
          {
            id: "functional_requirements",
            label: "Functional requirements",
            prompt: "List the behaviors the gateway must perform from admission through response, failover, configuration, and records.",
            placeholder: "Accept one normalized request; authenticate the tenant; select an eligible provider...",
            minChars: 160
          },
          {
            id: "non_functional_requirements",
            label: "Non-functional requirements",
            prompt: "Give latency, availability, isolation, durability, regional, and cost targets with numbers or explicit assumptions.",
            placeholder: "Gateway overhead p95 under... Availability... No unbounded queue... Billing event durability...",
            minChars: 160
          }
        ],
        coach: {
          lead: "The quality bar should be testable. A phrase such as high availability needs a target and a failure scope.",
          rows: [
            ["Serve inference", "Validate, admit, route, stream or buffer, map errors, and cancel unused work", "This defines the normal request path."],
            ["Adapt safely", "Use current latency and outcome evidence while preserving bounded recovery probes", "The current winner cannot become a permanent winner."],
            ["Latency", "Preserve one caller deadline and keep gateway overhead within a stated p95", "Every queue and remote check spends the same budget."],
            ["Durability", "Operational telemetry may be bounded-loss; billing events are at-least-once with dedupe", "The two record classes need different write paths."]
          ]
        }
      },
      {
        ...sharedPhases[2],
        purpose: "Derive the capacity envelope before selecting coordinators, stores, or replica counts.",
        fields: [
          {
            id: "capacity_math",
            label: "Capacity worksheet",
            prompt: "Calculate physical attempt rate, mean provider concurrency, burst demand, replica load, and single-provider failover demand with units.",
            placeholder: "1,000 requests/s × 1.10 attempts/request = 1,100 attempts/s...",
            minChars: 180
          },
          {
            id: "evidence_and_headroom",
            label: "Headroom and measurements",
            prompt: "State which mean, tail, zone-loss, stream-memory, connection, and telemetry assumptions still need production measurements.",
            placeholder: "Little's Law gives the mean. Size the configured ceiling from observed duration tails...",
            minChars: 140
          }
        ],
        coach: {
          lead: "Use Little's Law with mean residence time, then size headroom from observed tails and failure cases instead of substituting p95 into the formula.",
          rows: [
            ["Physical attempts", "1,000 requests/s × 1.10 = 1,100 attempts/s", "Retries and hedges spend provider capacity even when the client sees one response."],
            ["Mean in flight", "1,100 attempts/s × 2 s mean = about 2,200 attempts", "This is the mean provider concurrency before headroom."],
            ["Burst", "3,300 attempts/s at the stated 3x peak", "Admission and provider reserve must cover or reject this demand explicitly."],
            ["Telemetry", "One request event plus one event per attempt gives about 2,100 events/s", "Event size and sink rate determine queue fill time during an outage."]
          ]
        }
      },
      {
        ...sharedPhases[3],
        purpose: "Separate logical requests, physical attempts, policy snapshots, capacity, and records before choosing storage.",
        fields: [
          {
            id: "entity_model",
            label: "Entities, keys, and owners",
            prompt: "For each entity, record its stable key, owner, lifetime, durability, and relationship to one logical request.",
            placeholder: "LogicalRequest(request_id) owns many ProviderAttempt(attempt_id)... CapacityLease(lease_id, provider_id)...",
            minChars: 220
          },
          {
            id: "apis_and_events",
            label: "APIs and event contracts",
            prompt: "Define the public inference contract and the internal configuration, capacity, attempt-outcome, and billing boundaries.",
            placeholder: "POST /inference; watch RoutingSnapshot(version); acquire CapacityLease...",
            minChars: 180
          }
        ],
        coach: {
          lead: "A provider retry is another attempt, not another logical request. The keys must preserve that distinction through logs, traces, billing, and cleanup.",
          rows: [
            ["LogicalRequest", "request_id; owned by the serving replica until completion", "Connects the public outcome to every physical attempt."],
            ["ProviderAttempt", "attempt_id plus request_id and provider_id", "Carries timing, outcome class, permit ownership, and provider request ID."],
            ["RoutingSnapshot", "scope plus monotonic version", "Replicas validate it atomically and retain a last-known-good copy."],
            ["CapacityLease", "provider, tenant, units, expiry, and lease generation", "A replica may spend only its current allocation during coordination loss."],
            ["BillingEvent", "stable event ID plus request and usage identity", "At-least-once delivery requires consumer deduplication."]
          ]
        }
      },
      {
        ...sharedPhases[4],
        purpose: "Start with one healthy request and mark deadlines, state reads, permit acquisition, and the response commit point.",
        fields: [
          {
            id: "topology",
            kind: "diagram",
            label: "Request-path topology",
            prompt: "Build the boxes in request order. Name the owner or durable boundary inside each box, then move the boxes until the healthy path reads left to right.",
            minNodes: 5
          },
          {
            id: "healthy_trace",
            label: "Numbered healthy request trace",
            prompt: "Walk one buffered or streamed request from edge admission to cleanup, including every synchronous dependency.",
            placeholder: "1. Edge authenticates and propagates deadline... 2. Replica admits...",
            minChars: 220
          },
          {
            id: "v0_architecture",
            label: "First architecture and invariants",
            prompt: "Describe the smallest production path and name the invariants it must preserve before shared systems are added.",
            placeholder: "Client → edge → gateway replica → provider A or B. The replica owns...",
            minChars: 180
          }
        ],
        coach: {
          lead: "The first sketch should answer a user request. Control, quota, and telemetry systems can be added after their state appears in this trace.",
          rows: [
            ["Admission", "Authenticate, validate, apply tenant and application limits, then enter a bounded queue", "Rejected work must not consume provider capacity."],
            ["Selection", "Read one local snapshot of compatibility, health, and available allocation", "A shared health read would add a request-time failure dependency."],
            ["Attempt", "Acquire provider capacity, pass the remaining deadline, and attach attempt identity", "Fallback and hedges must consume real slots."],
            ["Commit and cleanup", "Commit at the buffered result or first streamed bytes, then cancel and release exactly once", "No provider can replace an already committed stream invisibly."]
          ]
        }
      },
      {
        ...sharedPhases[5],
        purpose: "Add a shared component only when replica count, a hard global limit, or a failure proves that local state is insufficient.",
        fields: [
          {
            id: "state_ownership",
            label: "State ownership matrix",
            prompt: "For health, capacity, configuration, streams, and telemetry, name the owner, request-time read, consistency, stale behavior, and recovery rule.",
            placeholder: "Local health: replica, exact for its path, read locally... Fleet hint: aggregator, cached...",
            minChars: 240
          },
          {
            id: "quota_strategy",
            kind: "decision",
            label: "Choose quota coordination",
            prompt: "Select a default under your stated scale, then defend the condition that would reverse it.",
            options: [
              { id: "leases", label: "Leased allocations", consequence: "Keeps request-time checks local, but accepts bounded slack and needs expiry, fencing, and redistribution." },
              { id: "central", label: "Central check per attempt", consequence: "Offers tighter accounting at modest scale, but adds latency and a hot-path availability dependency." },
              { id: "static", label: "Static per-replica shares", consequence: "Simple under fixed fleet size, but wastes uneven capacity and becomes unsafe when replica count drifts." }
            ]
          },
          {
            id: "pressure_and_recovery",
            label: "Failure and recovery plan",
            prompt: "Walk provider slowdown, coordinator partition, zone loss, and fleet restart through detection, degraded behavior, resource bounds, and recovery.",
            placeholder: "Provider slowdown: detect with latency window... shift only into reserved B capacity...",
            minChars: 240
          }
        ],
        coach: {
          lead: "One defensible default uses local path health, expiring fleet hints, versioned configuration, and leased provider capacity. The requirements can still justify a central quota call at smaller scale.",
          rows: [
            ["Fast state", "Active work, path health, permits, and current immutable snapshot stay local", "The current request can continue during slower control failures."],
            ["Shared state", "Fleet hints, account budgets, and policy versions move asynchronously", "They coordinate future choices without requiring consensus for every request."],
            ["Zone loss", "Keep enough static capacity in surviving zones and avoid emergency scale-up as the only recovery", "The service should already fit the expected failure."],
            ["Fleet restart", "Start with conservative weights, jitter probes, and ramp connections and traffic", "Cold replicas must not create a synchronized provider surge."]
          ]
        }
      },
      {
        ...sharedPhases[6],
        purpose: "Finish with two causal failure walks, explicit trade-offs, operating signals, and a short answer the interviewer can challenge.",
        fields: [
          {
            id: "failure_walks",
            label: "Two complete failure walks",
            prompt: "For each fault, record scope, detection, degraded behavior, resource bound, durable evidence, and recovery proof.",
            placeholder: "Collector outage... Provider A latency brownout...",
            minChars: 260
          },
          {
            id: "tradeoffs",
            label: "Three choices and reversal conditions",
            prompt: "Compare your choice with a credible alternative, name its cost, and state which changed requirement would make you switch.",
            placeholder: "Leases over a central check because... I would reverse this if...",
            minChars: 240
          },
          {
            id: "recap",
            label: "Two-minute final recap",
            prompt: "State the contract, scale, normal path, three protected invariants, degraded behavior, and largest open risk.",
            placeholder: "I designed a three-zone gateway for... The request path...",
            minChars: 220
          }
        ],
        coach: {
          lead: "A close should make the design falsifiable. Name the signal that would prove the capacity, latency, or failure assumption wrong.",
          rows: [
            ["Provider brownout", "Latency window shifts only within spare capacity, probes recovery, and ramps slowly", "Failover cannot create provider slots that do not exist."],
            ["Collector outage", "Bounded queues fill, loss is counted, and requests continue while durable records use another path", "The loss and memory contracts remain explicit."],
            ["Core signals", "End-to-end and attempt latency, success by outcome class, queue age, permit use, allocation staleness, dropped telemetry", "Each signal corresponds to a user promise or resource bound."],
            ["Reversal rule", "Change an architecture choice only when scale, consistency, latency, or durability requirements change", "This defends principles without pretending one diagram always wins."]
          ]
        }
      }
    ],
    workedTopology: {
      title: "A request path with local decisions and separate coordination",
      lanes: [
        ["Synchronous request", ["Client", "Edge and auth", "Gateway replica", "Provider A or B", "Buffered or streamed response"]],
        ["Replica-owned state", ["Bounded admission", "Routing snapshot", "Capacity permit", "Attempt lifecycle"]],
        ["Outside the hot path", ["Outcome events", "Health and policy control", "Bounded telemetry", "Durable billing log"]]
      ]
    },
    evolution: [
      {
        version: "V0",
        title: "Coding prototype",
        reason: "Prove one correct request before distributing state.",
        lanes: [
          ["Request", "Client → gateway → provider A or B"],
          ["Local state", "deadline · caps · health · attempts"]
        ]
      },
      {
        version: "V1",
        title: "Replica fleet",
        reason: "Traffic and zone availability require many stateless serving processes.",
        lanes: [
          ["Request", "Client → edge → gateway replicas → providers"],
          ["Local state", "admission · path health · leased units · cached policy"]
        ]
      },
      {
        version: "V2",
        title: "Coordinated control",
        reason: "Hard provider budgets and policy rollout cross replica boundaries.",
        lanes: [
          ["Control", "quota allocator · policy publisher · health aggregator"],
          ["Request", "local reads continue during stale control state"]
        ]
      },
      {
        version: "V3",
        title: "Operable service",
        reason: "Logs, billing, incidents, and recovery need explicit paths and bounds.",
        lanes: [
          ["Evidence", "bounded telemetry → collectors → stores"],
          ["Durability", "billing events → durable log → deduplicating consumer"]
        ]
      }
    ],
    tradeoffs: [
      ["Provider capacity", "Leased allocations", "Central per-attempt check", "Switch when tighter accounting is worth a request-time dependency."],
      ["Health", "Local evidence plus expiring fleet hints", "Shared read for every selection", "Switch only if centralized consistency outweighs latency and outage coupling."],
      ["Operational telemetry", "Bounded asynchronous export", "Synchronous or durable acknowledgement", "Use durability only for records whose loss breaks the product contract."],
      ["Tail latency", "Fallback after classified failure", "Delayed hedge", "Hedge only when saved tails justify duplicate load and capacity remains bounded."]
    ]
  };

  const crawler = {
    id: "crawler",
    track: "crawler-design",
    label: "Distributed crawler",
    title: "Derive a polite crawler from one URL lifecycle",
    premise: "Seeds and discovered links become durable work that must respect site policy, survive crashes, revisit changing content, and treat every destination as hostile.",
    guidedModules: {
      "crawler-request-path": ["scope", "requirements", "scale", "entities", "sketch"],
      "crawler-frontier": ["evolve", "defend"]
    },
    interviewer: [
      {
        question: "What is in scope and who supplies seeds?",
        answer: "Assume customer and product-owned seed sets. Discoveries may stay within an explicit crawl scope, and redirects must pass the same scope and destination checks."
      },
      {
        question: "What scale and freshness should I target?",
        answer: "Assume 100 million accepted pages per day with a three-times peak and a priority corpus whose freshness lag p95 must stay below 24 hours."
      },
      {
        question: "Which outputs and retention are required?",
        answer: "Store raw response bodies for 30 days, parsed documents, fetch metadata, discovery edges, validators, and recrawl schedules."
      },
      {
        question: "Do pages require browser rendering?",
        answer: "Not in version one. Explain where an isolated renderer pool would enter if the requirement changes."
      },
      {
        question: "Which policy and security rules are hard requirements?",
        answer: "Follow RFC 9309 robots behavior, apply per-authority pacing, constrain shared destinations after DNS, and block private or otherwise forbidden destinations on every redirect."
      }
    ],
    phases: [
      {
        ...sharedPhases[0],
        purpose: "Turn a vague request to crawl the web into a product boundary, output contract, and explicit exclusions.",
        fields: [
          {
            id: "scope_and_consumers",
            label: "Scope, seeds, and consumers",
            prompt: "State who creates a crawl, which discoveries remain eligible, and which downstream consumer defines useful output.",
            placeholder: "Customer and product seed sets... scope rule... parsed-document consumer...",
            minChars: 100
          },
          {
            id: "assumptions_and_non_goals",
            label: "Assumptions and non-goals",
            prompt: "Separate confirmed requirements from invented values, then exclude features that would change worker classes or product scope.",
            placeholder: "Confirmed: 100M accepted pages/day... Assumed: 200 KiB body... Out of scope: browser rendering...",
            minChars: 120
          }
        ],
        coach: {
          lead: "The word crawler does not determine the product. Coverage, freshness, output, rendering, and policy answers change the architecture.",
          rows: [
            ["Admission", "Seeds and discovered URLs enter only within a stated crawl scope", "Scope decides which component may create durable work."],
            ["Output", "Raw bodies, parsed documents, metadata, discovery edges, and revisit state", "Each output needs a stable key, retention, and consumer."],
            ["Freshness", "Reserve capacity for a priority corpus with p95 lag below 24 hours", "Discovery cannot consume every available fetch slot."],
            ["Non-goal", "Browser rendering in version one", "Rendering would need a separate CPU, memory, network, and security class."]
          ]
        }
      },
      {
        ...sharedPhases[1],
        purpose: "Write crawl behaviors separately from measurable coverage, freshness, policy, durability, safety, and cost targets.",
        fields: [
          {
            id: "functional_requirements",
            label: "Functional requirements",
            prompt: "List seed admission, normalization, dedupe, scheduling, robots, fetch, store, parse, discovery, and recrawl behaviors.",
            placeholder: "Create a crawl job; accept seeds idempotently; schedule eligible URLs by authority...",
            minChars: 180
          },
          {
            id: "non_functional_requirements",
            label: "Non-functional requirements",
            prompt: "Give measurable throughput, freshness, durability, politeness, safety, retention, availability, and cost targets.",
            placeholder: "100M accepted pages/day; priority freshness p95 under 24h; no accepted URL lost...",
            minChars: 180
          }
        ],
        coach: {
          lead: "Policy and safety belong on the normal path. They are not late additions after fetchers and queues have already been chosen.",
          rows: [
            ["Coverage", "No accepted URL is lost after the durable admission acknowledgement", "Replay and exact dedupe must preserve this invariant."],
            ["Freshness", "Priority corpus lag p95 stays below 24 hours", "The frontier needs reserved capacity and overdue-work signals."],
            ["Politeness", "Robots and per-authority timing hold across crashes and shard handoff", "Worker-local timers alone are insufficient."],
            ["Safety", "No socket connects to a forbidden resolved destination", "Validation must repeat after DNS and on every redirect."]
          ]
        }
      },
      {
        ...sharedPhases[2],
        purpose: "Size accepted pages, physical attempts, site-limited supply, metadata writes, storage, and bounded stage queues.",
        fields: [
          {
            id: "capacity_math",
            label: "Fetch and storage worksheet",
            prompt: "Calculate average and peak attempts, mean in-flight fetches, active-authority supply, network ingress, daily bytes, and retained bytes.",
            placeholder: "100M / 86,400 = 1,157 accepted pages/s...",
            minChars: 220
          },
          {
            id: "metadata_and_backpressure",
            label: "Metadata and stage pressure",
            prompt: "Estimate links, exact-dedupe writes, frontier updates, parser demand, queue growth during slowdown, and the first expected bottleneck.",
            placeholder: "At 25 discovered links/page, 100M pages create 2.5B edge observations/day...",
            minChars: 180
          }
        ],
        coach: {
          lead: "Accepted pages and physical attempts are different rates. The link and frontier metadata plane can exceed body count by an order of magnitude.",
          rows: [
            ["Accepted rate", "100,000,000 / 86,400 = about 1,157 pages/s", "This is the useful output rate, not the network attempt rate."],
            ["Peak attempts", "1,157 × 3 peak × 1.15 amplification = about 3,993 attempts/s", "Retries and redirects consume DNS, sockets, bytes, and permits."],
            ["Site supply", "At one start per five seconds, peak needs about 19,965 active authorities", "Global worker count cannot overcome a lack of eligible sites."],
            ["Discovery edges", "25 links/page gives 2.5 billion observed edges/day", "Conditional URL admission and edge storage may dominate metadata traffic."],
            ["Raw retention", "200 KiB mean × 100M/day × 30 days × 2 replicas = about 1.23 PB", "Body storage must be budgeted separately from indexes and versions."]
          ]
        }
      },
      {
        ...sharedPhases[3],
        purpose: "Give URL identity, site policy, leases, attempts, bodies, parses, edges, and recrawl schedules different keys and owners.",
        fields: [
          {
            id: "entity_model",
            label: "Entities and relationships",
            prompt: "Record each entity's stable key, owner, lifetime, durability, and cardinality to the URL record.",
            placeholder: "URLRecord(url_id) has many FetchAttempt(attempt_id) and BodyVersion(body_version_id)...",
            minChars: 240
          },
          {
            id: "apis_and_events",
            label: "External APIs and durable handoffs",
            prompt: "Define crawl-job APIs and the admission, lease, fetch, parse, discovery, and recrawl task or event contracts.",
            placeholder: "POST /crawl-jobs; POST /crawl-jobs/{id}/seeds; URLAdmitted(url_id, scope_id)...",
            minChars: 220
          }
        ],
        coach: {
          lead: "One URL may have many attempts and body versions, while one content digest may appear at many URLs. URL and content dedupe cannot share one identity.",
          rows: [
            ["URLRecord", "scope plus conservative normalized URL identity", "Owns admission status, priority, validators, and next revisit time."],
            ["AuthorityState", "scheme, host, and port authority key", "Owns robots state, next start time, active count, and shard generation."],
            ["FrontierLease", "URL, authority generation, worker, and expiry", "Makes crash recovery and stale-owner rejection explicit."],
            ["BodyVersion", "URL plus fetch time or version ID, with content digest", "Preserves history while allowing cross-URL content comparison."],
            ["DiscoveryEdge", "source version, target URL identity, and discovery context", "A parser replay can insert it idempotently before acknowledgement."]
          ]
        }
      },
      {
        ...sharedPhases[4],
        purpose: "Trace one URL from seed or discovery to recrawl before splitting the work into distributed stages.",
        fields: [
          {
            id: "topology",
            kind: "diagram",
            label: "URL-lifecycle topology",
            prompt: "Build the main boxes from admission through discovery and recrawl. Mark durable stores, queue boundaries, and the owner of politeness state in the box names.",
            minNodes: 6
          },
          {
            id: "healthy_trace",
            label: "Numbered URL lifecycle",
            prompt: "Walk parse, normalization, scope, exact admission, robots, ready time, lease, DNS, fetch, store, parse, discovery, and recrawl.",
            placeholder: "1. Parse without fetching... 2. Apply conservative identity...",
            minChars: 260
          },
          {
            id: "v0_architecture",
            label: "First architecture and trust boundaries",
            prompt: "Describe a minimal crawler, its durable acknowledgement points, its bounded queues, and the first failures that force separation.",
            placeholder: "Seeds → URL store/frontier → fetch → body store → parse → discoveries ↺...",
            minChars: 220
          }
        ],
        coach: {
          lead: "The URL trace introduces the scheduler, durable stores, and queues. A component that does not own a transition or survive a named failure does not yet need to exist.",
          rows: [
            ["Admit", "Parse, normalize conservatively, apply scope, and conditionally create the URL record", "The acknowledgement means the URL will survive process loss."],
            ["Schedule", "Check robots and authority readiness, then issue an expiring fenced lease", "Politeness and ownership remain true after restart."],
            ["Fetch", "Resolve and validate the destination, acquire destination capacity, and stream a bounded body", "Redirects repeat scope, DNS, and address policy."],
            ["Store and parse", "Commit the body version, enqueue a compact parse task, and replay parse from stored bytes", "Parser failure does not repeat external traffic."],
            ["Discover and revisit", "Insert edges and URLs idempotently before acknowledgement, then schedule the next validator-based fetch", "Coverage and freshness both receive durable state."]
          ]
        }
      },
      {
        ...sharedPhases[5],
        purpose: "Partition scheduling by authority, fence old owners, protect shared destinations, and bound every worker class.",
        fields: [
          {
            id: "state_ownership",
            label: "Frontier and stage ownership",
            prompt: "Name the owner, atomic operation, lease or generation, full-queue behavior, and handoff rule for every durable stage.",
            placeholder: "Authority shard owner may advance next_start_at and grant URLLease only under generation...",
            minChars: 260
          },
          {
            id: "frontier_strategy",
            kind: "decision",
            label: "Choose frontier ownership",
            prompt: "Select a default, then defend the scale or regional requirement that would change it.",
            options: [
              { id: "sharded", label: "Renewable authority shards", consequence: "Keeps site policy local to one owner, but needs generations, fencing, lease recovery, and hot-shard controls." },
              { id: "central", label: "Central scheduler", consequence: "Simplifies global ordering and politeness at moderate scale, but can become a throughput and availability bottleneck." },
              { id: "active-active", label: "Active-active site dispatch", consequence: "Improves regional availability, but requires global coordination for every authority budget or accepts policy violations." }
            ]
          },
          {
            id: "pressure_and_recovery",
            label: "Failure and recovery plan",
            prompt: "Walk shard transfer, parser death, object-store slowdown, hot authority, shared CDN address, and recrawl backlog.",
            placeholder: "Generation 17 stops dispatching after transfer... Generation 18 waits for or imports active leases...",
            minChars: 260
          }
        ],
        coach: {
          lead: "One defensible default assigns each authority to one renewable shard owner, then applies a separate destination guard after DNS. A central scheduler can still be the simpler answer at smaller scale.",
          rows: [
            ["Shard handoff", "A newer generation fences old dispatch, then imports or waits out active leases before issuing more work", "Two owners must not both spend the same site's politeness budget."],
            ["Destination control", "Apply a bounded exact-address or grouped-address limit after resolution", "Many hostnames can share one service, but a CDN address must not serialize the entire crawl."],
            ["Stage pressure", "Stop upstream admission when the durable queue or destination stage reaches its bound", "A queue inside worker memory cannot survive or control overload."],
            ["Recrawl", "Reserve capacity by class and schedule from importance, change rate, and overdue age", "Unbounded discovery must not starve freshness commitments."]
          ]
        }
      },
      {
        ...sharedPhases[6],
        purpose: "Prove policy, security, durability, and recovery with causal failure walks before delivering the final recap.",
        fields: [
          {
            id: "failure_walks",
            label: "Two complete failure walks",
            prompt: "For each fault, record scope, detection, degraded behavior, resource bound, durable evidence, replay owner, and recovery trigger.",
            placeholder: "Frontier owner dies after lease... Parser dies after discovering links...",
            minChars: 280
          },
          {
            id: "tradeoffs",
            label: "Four choices and reversal conditions",
            prompt: "Compare your choice with a credible alternative, state its cost, and name the requirement that would reverse the choice.",
            placeholder: "Bloom prefilter plus exact dedupe over Bloom-only because...",
            minChars: 260
          },
          {
            id: "recap",
            label: "Two-minute final recap",
            prompt: "State the workload, URL lifecycle, three protected invariants, main failure behavior, and least certain measurement.",
            placeholder: "I designed a crawler for 100M accepted pages/day...",
            minChars: 220
          }
        ],
        coach: {
          lead: "Keep robots and hostile-destination behavior in the main path. A final security appendix cannot repair an earlier arrow that already trusted DNS or redirects.",
          rows: [
            ["Robots", "Unavailable responses such as 404 may allow crawling; unreachable states such as 5xx or network failure require complete disallow", "The state and cache expiry belong to each authority."],
            ["Owner death", "Fence the old generation, recover expired leases, and ramp the replacement without a site burst", "Recovery must preserve both durability and politeness."],
            ["Parser death", "Replay the stored body and idempotently commit discoveries before acknowledging the parse task", "A crash cannot lose discovered work or force another fetch."],
            ["Forbidden redirect", "Reapply scheme, scope, DNS, connected-address, and egress checks at every hop", "Application validation and network enforcement protect different boundaries."]
          ]
        }
      }
    ],
    workedTopology: {
      title: "A durable URL lifecycle with politeness owned by the frontier",
      lanes: [
        ["Crawl lifecycle", ["Seeds or discoveries", "Scope and exact URL admission", "Authority frontier", "Fetch lease and network policy", "Raw body store", "Parse workers", "Discoveries and recrawl"]],
        ["Durable state", ["URL record", "Authority and robots state", "Body version", "Discovery edges", "Next revisit time"]],
        ["Resource guards", ["Authority ready time", "Shared destination cap", "Bounded queues", "Lease generation"]]
      ]
    },
    evolution: [
      {
        version: "V0",
        title: "Single process",
        reason: "Make one URL lifecycle correct before distributing ownership.",
        lanes: [
          ["Flow", "seeds → memory queue → fetch and parse → one database"],
          ["Failure", "process loss can lose queued and discovered work"]
        ]
      },
      {
        version: "V1",
        title: "Durable stages",
        reason: "Worker and parser crashes require replayable boundaries.",
        lanes: [
          ["Scheduling", "exact URL store → durable frontier → fetch lease"],
          ["Content", "object store → parse queue → discoveries ↺"]
        ]
      },
      {
        version: "V2",
        title: "Distributed frontier",
        reason: "Scale and politeness require coherent site ownership.",
        lanes: [
          ["Ownership", "authority shards · generations · ready-time index"],
          ["Network", "robots · DNS policy · shared-destination guard"]
        ]
      },
      {
        version: "V3",
        title: "Fresh and operable",
        reason: "Recrawl objectives and incidents need reserved capacity and evidence.",
        lanes: [
          ["Freshness", "validators · priority classes · overdue age · recrawl reserve"],
          ["Operations", "queue age · lease expiry · policy failures · cost/document"]
        ]
      }
    ],
    tradeoffs: [
      ["Frontier", "Renewable authority shards", "Central scheduler", "Use the simpler central owner until scale or availability makes it the bottleneck."],
      ["URL dedupe", "Bloom prefilter plus exact conditional insert", "Bloom as source of truth", "Never accept Bloom false positives as lost coverage when every admitted URL matters."],
      ["Parsing", "Store body before asynchronous parse", "Inline fetch and parse", "Inline work may fit a small crawler, while durable body replay isolates parser crashes at scale."],
      ["Regions", "One active region per authority", "Active-active dispatch", "Use active-active only with a global politeness budget or an explicit duplicate allowance."],
      ["Freshness", "Reserve recrawl capacity", "Pure global priority", "Change the reserve when product value shifts between new coverage and overdue content."]
    ]
  };

  window.DECAGON_SYSTEM_DESIGN_STUDIOS = { gateway, crawler };
})();
