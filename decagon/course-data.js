window.DECAGON_COURSE = {
  version: 3,
  contentRevision: "2026-07-21",
  title: "Decagon Infra Interview Lab",
  subtitle: "Build, benchmark, and defend an AI model gateway and a distributed web crawler",
  totalMinutes: 703,
  verified: {
    date: "July 21, 2026",
    scope: [
      "The supplied Decagon interview summary",
      "Current IETF HTTP, URI, robots, and DNS specifications",
      "Current Envoy, gRPC, OpenTelemetry, and Prometheus documentation",
      "Original crawler, load-balancing, and latency research"
    ],
    assumptions: [
      "The coding round supplies two interchangeable providers for one model.",
      "The production design round extends the gateway built during coding.",
      "The crawler round is an infrastructure system-design interview.",
      "Design-round practice uses 60 minutes because the supplied notes do not state a duration."
    ]
  },
  tracks: [
    {
      id: "coding",
      label: "AI coding",
      shortLabel: "Coding",
      description: "Implement a small gateway, measure it, and improve it without losing correctness.",
      color: "#c84f31"
    },
    {
      id: "gateway-design",
      label: "Gateway system design",
      shortLabel: "Gateway design",
      description: "Scale the prototype across replicas, provider quotas, and telemetry pipelines.",
      color: "#236785"
    },
    {
      id: "crawler-design",
      label: "Crawler system design",
      shortLabel: "Crawler design",
      description: "Design a polite, durable, secure crawler from seed URL to stored document.",
      color: "#507439"
    }
  ],
  modules: [
    {
      id: "request-contract",
      number: "01",
      track: "coding",
      title: "The request contract and safe baseline",
      shortTitle: "Safe baseline",
      duration: 64,
      color: "#b9472d",
      soft: "#f9e6df",
      description: "Turn a vague gateway prompt into explicit semantics, a traced latency budget, and code that can change safely.",
      outcomes: [
        "State when two provider responses are interchangeable.",
        "Trace queueing, transport, provider, and response time on one deadline.",
        "Separate request handling, selection, transport, and health updates."
      ],
      lessons: [
        {
          id: "gateway-contract",
          number: "01",
          title: "Define interchangeability before routing",
          duration: 20,
          summary: "Routing is correct only when either provider can satisfy the same externally visible request contract.",
          prediction: "Provider A and provider B expose the same model name. Is that enough to retry one request across them after A times out?",
          core: [
            "The interview assumption says both providers return identical responses for the same prompt. Say that assumption aloud and build against it.",
            "A production contract must also pin model revision, sampling settings, safety behavior, output schema, token limits, and billing semantics. Matching model names alone do not prove equivalence.",
            "Buffered responses can fail over before the gateway commits bytes downstream. A streamed response usually commits at the first delivered chunk, after which switching providers can duplicate or splice output."
          ],
          mechanics: [
            { title: "Normalized request", text: "Validate one public schema, then let each provider adapter translate it without changing meaning." },
            { title: "Commit point", text: "Name the event after which the gateway cannot replace the chosen response invisibly." },
            { title: "Attempt identity", text: "Keep one request ID and a distinct attempt ID for every provider call." }
          ],
          deep: [
            "A POST can describe a logically read-only inference but still consume quota or money. Cross-provider retries need an explicit duplicate-cost policy and, where supported, an idempotency key.",
            "Validate authorization, model access, payload limits, and supported options before using provider health capacity. Ordinary client mistakes should not make a healthy provider look broken."
          ],
          bridge: { title: "Interview move", text: "Write the equivalence, streaming, and duplicate-cost assumptions at the top of the scratch document before implementing selection." },
          failure: { title: "Silent contract drift", text: "If one provider changes model behavior or response shape, latency routing can return semantically different results. Version provider capabilities and test adapters against shared fixtures." },
          visual: {
            type: "boundary",
            title: "One public contract, two adapters",
            nodes: [
              ["Client request", "public schema"],
              ["Validation", "reject before routing"],
              ["Model contract", "equivalence boundary"],
              ["Provider adapter", "translate"],
              ["Upstream model", "attempt"]
            ]
          },
          check: {
            question: "When can a gateway replace a failed streaming attempt without corrupting the client response?",
            choices: ["At any time", "Only before output is committed", "Only after the last token", "Whenever both providers use HTTP"],
            answer: 1,
            explanation: "After bytes reach the client, a second provider can repeat or conflict with the partial output."
          },
          sources: [
            ["HTTP semantics and idempotency", "https://www.rfc-editor.org/rfc/rfc9110.html"],
            ["OpenTelemetry GenAI semantic conventions", "https://github.com/open-telemetry/semantic-conventions-genai"],
            ["Envoy AI Gateway provider fallback", "https://aigateway.envoyproxy.io/docs/capabilities/traffic/provider-fallback/"]
          ]
        },
        {
          id: "latency-budget",
          number: "02",
          title: "Budget latency on one clock",
          duration: 22,
          summary: "A useful timeout policy spends one caller deadline across queueing and every upstream attempt.",
          prediction: "The caller deadline is 900 ms, the queue waits 400 ms, and the provider timeout is also 900 ms. Can the gateway still meet the caller deadline?",
          core: [
            "Measure end-to-end time from gateway admission to the completed response. Provider latency alone omits local queueing, connection setup, upload, and response transfer.",
            "Compute every attempt timeout from the remaining inbound deadline, with a small reserve for cleanup and the error response. Queue wait consumes the same budget.",
            "Use a monotonic clock for elapsed time and propagate cancellation when the caller leaves. A wall clock can jump while an attempt is active."
          ],
          mechanics: [
            { title: "Deadline", text: "An absolute latest completion time shared across all work for one request." },
            { title: "Attempt timeout", text: "The smaller budget assigned to one provider call from the time that remains." },
            { title: "Cancellation", text: "A signal that stops queued or active work when its result is no longer useful." }
          ],
          deep: [
            "Track queue time, connection time, time to response headers or first chunk, and complete response time separately. The slow phase determines the right fix.",
            "A timeout should stop waiting, not merely return while work continues. Release limiter slots and cancel transport operations on success, failure, hedge loss, caller exit, and deadline expiry."
          ],
          bridge: { title: "Coding shape", text: "Pass one request context to the limiter and provider client. Avoid unrelated timers that can outlive the request." },
          failure: { title: "Stacked timeouts", text: "Two 900 ms attempts placed behind 400 ms of queueing cannot honor a 900 ms caller budget. Recompute from remaining time before every wait." },
          visual: {
            type: "timeline",
            title: "The deadline keeps moving closer",
            nodes: [
              ["Admit", "900 ms left"],
              ["Queue", "400 ms spent"],
              ["Attempt A", "remaining budget"],
              ["Fallback B", "smaller budget"],
              ["Respond", "reserve cleanup time"]
            ]
          },
          check: {
            question: "What should determine a fallback attempt timeout?",
            choices: ["The original client deadline", "The remaining deadline after prior work", "The provider average only", "An unlimited client default"],
            answer: 1,
            explanation: "Earlier queueing and attempts have already spent part of the caller's budget."
          },
          sources: [
            ["gRPC deadlines", "https://grpc.io/docs/guides/deadlines/"],
            ["HTTP 504 semantics", "https://www.rfc-editor.org/rfc/rfc9110.html#name-504-gateway-timeout"],
            ["Node AbortSignal", "https://nodejs.org/api/globals.html#class-abortsignal"]
          ]
        },
        {
          id: "baseline-code-shape",
          number: "03",
          title: "Build a replaceable baseline",
          duration: 22,
          summary: "Small interfaces and injected dependencies let benchmark results change the policy without rewriting transport code.",
          prediction: "Where should a provider HTTP call live: inside the scoring function or behind a provider client interface?",
          core: [
            "Start with a correct endpoint, reusable provider clients, input validation, a total deadline, and round-robin or static selection. Measure this baseline before adding policy.",
            "Separate Handler, AdmissionLimiter, Router, ProviderClient, and Tracker. Selection reads a snapshot; completion records one classified outcome.",
            "Inject provider clients and a clock so tests control failures and time without real endpoints. Keep state ownership explicit and make cleanup idempotent."
          ],
          mechanics: [
            { title: "Handler", text: "Validates the public contract and owns the final response." },
            { title: "Router", text: "Chooses among eligible provider snapshots without performing network I/O." },
            { title: "Tracker", text: "Records one classified completion and publishes a new health snapshot." },
            { title: "Provider client", text: "Owns authentication, connection reuse, translation, timeout, and cancellation." }
          ],
          deep: [
            "Reuse HTTP transports and clients. Creating one client per request discards connection pooling and can exhaust sockets.",
            "Make the benchmark workload and result table part of the repository. A policy change without a comparable run is an untested guess."
          ],
          bridge: { title: "Review signal", text: "An interviewer can inspect each component independently and see exactly where concurrency, routing, and health decisions live." },
          failure: { title: "Policy mixed with I/O", text: "A scoring function that calls the network is slow, hard to test, and prone to holding locks across awaits. Select from immutable snapshots instead." },
          visual: {
            type: "flow",
            title: "Baseline ownership",
            nodes: [
              ["Handler", "contract"],
              ["Limiter", "capacity"],
              ["Router", "selection"],
              ["Provider client", "I/O"],
              ["Tracker", "observation"]
            ]
          },
          check: {
            question: "Why inject the clock into gateway tests?",
            choices: ["To speed up DNS", "To make deadlines and cooldowns deterministic", "To avoid types", "To share provider credentials"],
            answer: 1,
            explanation: "A controlled clock makes time-dependent behavior fast, repeatable, and free of sleeps."
          },
          sources: [
            ["Go HTTP client and transport", "https://pkg.go.dev/net/http"],
            ["Google SRE testing for reliability", "https://sre.google/sre-book/testing-reliability/"],
            ["HTTP core semantics", "https://www.rfc-editor.org/rfc/rfc9110.html"]
          ]
        }
      ],
      quizExtra: [
        {
          question: "A caller sends an invalid model parameter and receives 400. Should that reduce provider health?",
          choices: ["Yes, every non-200 is a provider failure", "No, validation errors describe the request", "Only for the faster provider", "Only during a hedge"],
          answer: 1,
          explanation: "Request errors should be classified separately so they do not eject a healthy provider."
        },
        {
          question: "Which identifier is shared by two hedged attempts?",
          choices: ["Attempt ID", "Connection ID", "Request ID", "Provider credential"],
          answer: 2,
          explanation: "Both attempts serve one logical request, while each attempt also needs its own identifier."
        },
        {
          question: "What should the first benchmark strategy be?",
          choices: ["The most advanced router", "A correct simple baseline", "A global health service", "Unlimited hedging"],
          answer: 1,
          explanation: "A simple measured baseline shows whether later complexity improves the stated goals."
        }
      ],
      lab: {
        id: "request-oscilloscope",
        title: "Classify gateway outcomes",
        kind: "code-runner",
        badge: "Browser-tested exercise",
        intro: "Implement the boundary between caller errors, provider failures, overload, and neutral cancellation. Pass every deterministic case in the browser.",
        notebook: [
          "Write the response-equivalence assumption.",
          "Mark the downstream commit point.",
          "List which failures may update provider health."
        ]
      }
    },
    {
      id: "adaptive-routing",
      number: "02",
      track: "coding",
      title: "Adaptive routing and health",
      shortTitle: "Adaptive routing",
      duration: 72,
      color: "#c45a2f",
      soft: "#fbe9dd",
      description: "Use recent evidence without locking traffic to yesterday's winner or mistaking caller behavior for provider failure.",
      outcomes: [
        "Classify passive observations before updating state.",
        "Balance exploitation with deliberate recovery probes.",
        "Explain cooldown, half-open probes, and slow recovery."
      ],
      lessons: [
        {
          id: "health-evidence",
          number: "04",
          title: "Health is scoped evidence",
          duration: 24,
          summary: "A health estimate summarizes recent observations for a provider, model, request class, and network path.",
          prediction: "Provider A fails only from one gateway zone. Should a fleet-wide average mark A healthy for that zone?",
          core: [
            "Track passive evidence from real requests and active evidence from probes separately. A shallow probe can pass while expensive inference is slow or failing.",
            "Scope statistics by provider and model, then retain locality or gateway identity when partial network failures matter. A single global average can hide a regional partition.",
            "Update latency and failure estimates with recent samples, attach observation time, and expire stale conclusions. Timeouts need a latency penalty as well as a failure signal."
          ],
          mechanics: [
            { title: "Passive sample", text: "A classified result from a real provider attempt." },
            { title: "Active probe", text: "Synthetic traffic that tests reachability or a small inference path." },
            { title: "EWMA", text: "A compact estimate that gives new samples a fixed fraction of influence." },
            { title: "Staleness", text: "The age beyond which an estimate should lose authority or require a probe." }
          ],
          deep: [
            "Keep caller cancellation and hedge-loser cancellation neutral. Counting them as provider failures creates a feedback loop in which successful hedging damages the slower provider's score.",
            "Treat 429 as capacity evidence and honor a valid Retry-After value. Keep it distinct from malformed input and transport failure so operators can see the cause."
          ],
          bridge: { title: "Minimal state", text: "For the coding round, active count, recent latency, recent failures, last sample time, and cooldown deadline are enough to discuss the larger model." },
          failure: { title: "Average hides locality", text: "If most replicas can reach A, a fleet aggregate may remain green while one zone times out. Local state must be allowed to override a slow global hint." },
          visual: {
            type: "matrix",
            title: "The same provider from two paths",
            nodes: [
              ["Zone west -> A", "timeouts"],
              ["Zone east -> A", "healthy"],
              ["Fleet average", "misleading"],
              ["Local router", "retain path evidence"]
            ]
          },
          check: {
            question: "A hedged B attempt is cancelled because A already won. How should B health change?",
            choices: ["Record a failure", "Record a success", "Remain unchanged", "Open the breaker"],
            answer: 2,
            explanation: "The cancellation says nothing about B's ability to complete the request."
          },
          sources: [
            ["Envoy outlier detection", "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier"],
            ["Envoy active health checking", "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/health_checking"],
            ["HTTP 429", "https://www.rfc-editor.org/rfc/rfc6585.html#section-4"]
          ]
        },
        {
          id: "exploration-selection",
          number: "05",
          title: "Keep learning after choosing a winner",
          duration: 24,
          summary: "A router must reserve some traffic for fresh evidence or it cannot detect changing conditions.",
          prediction: "A was faster during startup, so all traffic moves to A. B later becomes twice as fast. How does the router learn that?",
          core: [
            "Pure fastest-wins selection starves the other provider of samples. Its estimate grows stale and recovery becomes invisible.",
            "Begin with a legible policy: filter ineligible providers, reserve deterministic probes, then rank the remaining providers by recent latency, failure risk, and current load.",
            "Choose from snapshots and break ties deterministically in tests. In production, add jitter or randomized choice to avoid replicas moving in lockstep."
          ],
          mechanics: [
            { title: "Eligibility", text: "The provider is outside cooldown, below its cap, and compatible with the request." },
            { title: "Exploitation", text: "Send ordinary traffic to the provider with the best current evidence." },
            { title: "Exploration", text: "Send a bounded sample to a less-tested eligible provider." }
          ],
          deep: [
            "A score is a policy, not a physical truth. Label any teaching formula as a heuristic and test sensitivity to weights instead of presenting one constant as correct.",
            "Power-of-two least-request selection is useful when many equivalent endpoints exist. With two external providers and unequal latency, explicit health and capacity evidence is easier to explain."
          ],
          bridge: { title: "Interview move", text: "Implement fixed exploration before proposing bandits. It proves that the router can relearn without spending the round on statistical machinery." },
          failure: { title: "Herding", text: "If every replica sees the same score and switches together, the new winner can overload. Local load, jitter, and gradual weight changes reduce synchronized motion." },
          visual: {
            type: "decision",
            title: "Selection has two gates",
            nodes: [
              ["Compatibility", "model and request"],
              ["Eligibility", "cooldown and cap"],
              ["Probe?", "fresh evidence"],
              ["Rank", "latency, failure, load"],
              ["Attempt", "record later"]
            ]
          },
          check: {
            question: "Why reserve probe traffic for a slower provider?",
            choices: ["To increase average latency", "To refresh evidence and detect recovery", "To avoid all metrics", "To bypass concurrency caps"],
            answer: 1,
            explanation: "Without new samples, the router cannot know that provider conditions changed."
          },
          sources: [
            ["Envoy supported load balancers", "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancers.html"],
            ["Power of two choices", "https://www.eecs.harvard.edu/~michaelm/postscripts/tpds2001.pdf"],
            ["Finite-time bandit analysis", "https://link.springer.com/article/10.1023/A:1013689704352"]
          ]
        },
        {
          id: "cooldown-recovery",
          number: "06",
          title: "Eject fast, restore slowly",
          duration: 24,
          summary: "Cooldown limits damage during failure, while probes and slow start prevent a recovered provider from receiving a sudden traffic wall.",
          prediction: "All replicas open A for 30 seconds after the same outage. What happens exactly 30 seconds later?",
          core: [
            "A small coding-round breaker can open after a stated run of health-relevant failures, wait through cooldown, admit one probe, and close after success.",
            "Add jitter to cooldown across replicas. Otherwise every gateway probes at the same instant and can turn recovery into another overload event.",
            "Restore traffic gradually after a successful probe. One success proves availability for one request, not full capacity."
          ],
          mechanics: [
            { title: "Closed", text: "Normal eligible state; attempts contribute observations." },
            { title: "Cooldown", text: "Ordinary traffic is withheld until a bounded time passes." },
            { title: "Half-open", text: "Only a limited recovery probe is admitted." },
            { title: "Slow start", text: "Traffic weight grows over a recovery window rather than jumping to full share." }
          ],
          deep: [
            "Envoy circuit breaking names resource caps such as maximum connections and pending requests. Passive outlier ejection is the closer analogue to an application open-and-probe state machine.",
            "Cap how many providers may be ejected at once. A strict breaker that removes every option can reduce availability more than a degraded fallback policy."
          ],
          bridge: { title: "State-machine answer", text: "Name the transition trigger, cooldown clock, probe owner, and traffic ramp. Those details turn a breaker sketch into an operable policy." },
          failure: { title: "Flapping", text: "Immediate full restoration after one success sends a burst to a weak provider, causes another failure, and repeats. Require controlled probes and gradual weight recovery." },
          visual: {
            type: "state",
            title: "Provider recovery",
            nodes: [
              ["Closed", "serve traffic"],
              ["Cooldown", "withhold"],
              ["Half-open", "one probe"],
              ["Slow start", "ramp weight"],
              ["Closed", "normal share"]
            ]
          },
          check: {
            question: "Why is one successful half-open request insufficient for full traffic?",
            choices: ["It proves no availability", "It proves one request, not sustained capacity", "It invalidates the model contract", "It consumes no provider work"],
            answer: 1,
            explanation: "A provider can handle one probe and still fail under a sudden fleet-wide load shift."
          },
          sources: [
            ["Envoy outlier configuration", "https://www.envoyproxy.io/docs/envoy/latest/api-v3/config/cluster/v3/outlier_detection.proto"],
            ["Envoy slow start", "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/slow_start"],
            ["Envoy circuit breaking", "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/circuit_breaking"]
          ]
        }
      ],
      quizExtra: [
        {
          question: "Provider B receives no traffic for ten minutes. What is true of its latency estimate?",
          choices: ["It is exact", "It is stale", "It is a provider failure", "It overrides capacity"],
          answer: 1,
          explanation: "An old estimate cannot describe current conditions without a new observation."
        },
        {
          question: "What is the safest first recovery action after cooldown?",
          choices: ["Send all traffic", "Admit a limited probe", "Delete all metrics", "Increase retries without limit"],
          answer: 1,
          explanation: "A bounded probe tests recovery without exposing the provider to a full traffic jump."
        },
        {
          question: "Which event is passive health evidence?",
          choices: ["A real request times out", "A config file changes", "A dashboard opens", "A DNS record is documented"],
          answer: 0,
          explanation: "Passive health comes from observed production attempts."
        }
      ],
      lab: {
        id: "routing-weather-map",
        title: "Route through changing provider weather",
        kind: "routing-simulator",
        badge: "Seeded simulation",
        intro: "Hold the scenario and seed fixed, change one routing control, and compare success, tail latency, and calls per request against the baseline.",
        notebook: [
          "Record the seed and offered request rate.",
          "Explain every failure class used by the tracker.",
          "State the maximum traffic reserved for probes."
        ]
      }
    },
    {
      id: "concurrency-resilience",
      number: "03",
      track: "coding",
      title: "Concurrency, deadlines, retries, and hedges",
      shortTitle: "Concurrency and tails",
      duration: 78,
      color: "#d06a31",
      soft: "#fcebdc",
      description: "Bound active work and use extra attempts only when the remaining deadline and provider capacity can support them.",
      outcomes: [
        "Distinguish connection, request, queue, and fleet-wide caps.",
        "Choose fallback, retry, or hedging from the observed failure mode.",
        "Measure tail latency without hiding overload."
      ],
      lessons: [
        {
          id: "bounded-concurrency",
          number: "07",
          title: "Cap active work and queued work",
          duration: 26,
          summary: "A gateway needs explicit limits at admission, per provider, and across the fleet because each boundary protects a different resource.",
          prediction: "The HTTP client allows ten connections and HTTP/2 multiplexes many streams. Does that guarantee at most ten active inference requests?",
          core: [
            "Use an application-wide active-request cap, a per-provider cap, and a bounded queue with a maximum wait. A connection-pool cap does not always cap multiplexed requests.",
            "Every retry and hedge consumes a slot. Acquire capacity before launching the attempt and release it exactly once on every terminal path.",
            "When no eligible capacity remains, fail fast or wait only within the request deadline. An unbounded queue converts overload into memory growth and extreme latency."
          ],
          mechanics: [
            { title: "Admission cap", text: "Bounds total work accepted by one gateway process." },
            { title: "Provider cap", text: "Bounds concurrent attempts sent from the process to one upstream." },
            { title: "Queue cap", text: "Bounds requests waiting for a slot and defines the overload response." },
            { title: "Client pool", text: "Reuses connections and applies transport limits, which may differ from request limits." }
          ],
          deep: [
            "A fair queue prevents one tenant or request class from taking every slot. Production design should state whether capacity is shared, weighted, or reserved by priority.",
            "Autoscaling multiplies local limits. Ten replicas with a provider cap of twenty can present two hundred concurrent attempts unless a fleet policy coordinates quota."
          ],
          bridge: { title: "Implementation check", text: "Expose active, queued, rejected, and peak-active counters in tests. A cap is not proven by reading the semaphore constructor." },
          failure: { title: "Slot leak", text: "A timeout path that returns before releasing its slot eventually blocks all new work. Centralize terminal cleanup or make release idempotent." },
          visual: {
            type: "funnel",
            title: "Capacity narrows in stages",
            nodes: [
              ["Incoming", "unbounded demand"],
              ["Admission", "process cap"],
              ["Queue", "bounded wait"],
              ["Provider limiter", "upstream cap"],
              ["Connection pool", "transport"]
            ]
          },
          check: {
            question: "Where should a hedge obtain capacity?",
            choices: ["Outside all caps", "From the same provider and application limits as other attempts", "Only after completion", "From the logging queue"],
            answer: 1,
            explanation: "A hedge performs real upstream work and must participate in every relevant limit."
          },
          sources: [
            ["Go HTTP transport limits", "https://pkg.go.dev/net/http#Transport"],
            ["Python asyncio semaphore", "https://docs.python.org/3/library/asyncio-sync.html#asyncio.Semaphore"],
            ["Google SRE handling overload", "https://sre.google/sre-book/handling-overload/"]
          ]
        },
        {
          id: "retry-or-hedge",
          number: "08",
          title: "Spend extra attempts deliberately",
          duration: 26,
          summary: "Retries answer explicit transient failures, while hedges attack slow tails before a failure is known.",
          prediction: "A usually fast provider has a rare 900 ms tail. Should the gateway retry immediately, wait for failure, or launch a delayed hedge?",
          core: [
            "Fallback starts after an attempt fails. Retry repeats eligible failure with backoff. Hedging starts a second attempt after a delay while the first is still active.",
            "Use one total deadline, an attempt limit, backoff with jitter, and a retry budget that pauses extra work during broad failure. Honor provider pushback such as Retry-After.",
            "Hedge only requests whose semantics allow duplicates, after a measured tail threshold, and while another provider has capacity. Cancel the loser without blaming its health."
          ],
          mechanics: [
            { title: "Retry budget", text: "Caps the ratio or token pool for extra attempts so failure does not multiply load without bound." },
            { title: "Hedge delay", text: "Waits for the primary through its normal fast range before duplicating work." },
            { title: "Commit", text: "The first acceptable result wins; outstanding attempts receive cancellation." }
          ],
          deep: [
            "Cancellation stops the gateway's wait, but the provider may already have accepted or billed the work. Measure attempts per request and wasted hedge time alongside latency.",
            "A provider error after response headers may be committed by the client library. Define whether the gateway buffers full responses or stops retrying once headers or the first chunk arrive."
          ],
          bridge: { title: "Interview trade-off", text: "A one-hedge policy is easier to defend than racing both providers for every request. Show the measured p99 gain and added attempt percentage." },
          failure: { title: "Retry storm", text: "When both providers are overloaded, eager retries add traffic to the same bottleneck. Admission control and a retry budget must reduce, not multiply, pressure." },
          visual: {
            type: "timeline",
            title: "Delayed hedge",
            nodes: [
              ["A starts", "t=0"],
              ["Fast window", "wait"],
              ["B starts", "hedge delay"],
              ["First success", "commit"],
              ["Loser", "cancel neutrally"]
            ]
          },
          check: {
            question: "What distinguishes a hedge from a retry?",
            choices: ["A hedge starts before the first attempt finishes", "A hedge ignores capacity", "A retry always uses another provider", "A retry has no deadline"],
            answer: 0,
            explanation: "A hedge overlaps attempts to reduce tail latency; a retry follows a completed failure."
          },
          sources: [
            ["gRPC retry", "https://grpc.io/docs/guides/retry/"],
            ["gRPC request hedging", "https://grpc.io/docs/guides/request-hedging/"],
            ["The Tail at Scale", "https://research.google/pubs/the-tail-at-scale/"],
            ["HTTP Retry-After", "https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after"]
          ]
        },
        {
          id: "benchmark-protocol",
          number: "09",
          title: "Benchmark the offered load, not the story",
          duration: 26,
          summary: "A repeatable benchmark records arrival rate, caps, failures, queueing, tail latency, and attempt amplification for every strategy.",
          prediction: "A closed-loop test waits for each response before sending the next. The gateway slows down. What happens to offered load?",
          core: [
            "Use a fixed seed and explicit provider phases: steady state, latency shift, failure burst, overload response, and recovery. Run a warmup and repeat each strategy under the same schedule.",
            "Report offered and achieved request rate, dropped arrivals, success, p50, p95, p99, queue latency, active slots, provider share, and attempts per logical request.",
            "Prefer an open arrival model for overload tests. A closed loop sends less traffic as responses slow, which can hide the collapse being measured."
          ],
          mechanics: [
            { title: "Open model", text: "Starts work at a target arrival rate independent of prior response time." },
            { title: "Closed model", text: "A fixed set of workers waits for completion before issuing more work." },
            { title: "Coordinated omission", text: "Slow responses suppress later samples, causing a latency histogram to miss requests that would have arrived." },
            { title: "Amplification", text: "Physical provider attempts divided by logical gateway requests." }
          ],
          deep: [
            "Record the code revision and policy parameters with each result. A table without the exact cap, timeout, and hedge delay cannot be reproduced.",
            "A strategy passes only if it improves the stated latency or reliability target without violating caps or hiding a large cost in extra attempts."
          ],
          bridge: { title: "Running document", text: "Add one row before making the next policy change. Explain why the result supports or rejects the hypothesis." },
          failure: { title: "Pretty percentiles, wrong load", text: "A low p99 at half the requested arrival rate is not a win. Report dropped work and achieved throughput beside latency." },
          visual: {
            type: "compare",
            title: "One schedule, five policies",
            nodes: [
              ["Round robin", "baseline"],
              ["Static fastest", "stale risk"],
              ["Cooldown", "failure shift"],
              ["Adaptive", "fresh evidence"],
              ["Delayed hedge", "tail cost"]
            ]
          },
          check: {
            question: "Why can a closed-loop benchmark make overload look better?",
            choices: ["It increases offered load", "Slow responses reduce new arrivals", "It removes all latency", "It disables providers"],
            answer: 1,
            explanation: "Workers wait longer, so the test offers less traffic precisely when the service degrades."
          },
          sources: [
            ["k6 open and closed models", "https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/"],
            ["k6 constant arrival rate", "https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/"],
            ["HdrHistogram coordinated omission", "https://github.com/HdrHistogram/HdrHistogram"],
            ["Prometheus histograms", "https://prometheus.io/docs/practices/histograms/"]
          ]
        }
      ],
      quizExtra: [
        {
          question: "Ten replicas each allow twenty A attempts. What is the fleet maximum without another control?",
          choices: ["20", "30", "100", "200"],
          answer: 3,
          explanation: "Independent local caps multiply with replica count."
        },
        {
          question: "A primary succeeds 5 ms after its hedge starts. What did the hedge add?",
          choices: ["Guaranteed latency savings", "Extra upstream work with no win", "A caller error", "A new deadline"],
          answer: 1,
          explanation: "The primary still won, so the second attempt consumed capacity without reducing response time."
        },
        {
          question: "Which metric exposes retry cost?",
          choices: ["Attempts per logical request", "Only p50", "Only process uptime", "Provider DNS TTL"],
          answer: 0,
          explanation: "Attempt amplification shows how much extra provider work the policy creates."
        }
      ],
      lab: {
        id: "tail-latency-bench",
        title: "Tune a bounded gateway",
        kind: "benchmark-simulator",
        badge: "Virtual clock",
        intro: "Set application, queue, and provider caps; add fallback or one delayed hedge; then compare the exact seeded workload.",
        notebook: [
          "Record offered and achieved RPS.",
          "Record p95 queue time and p99 end-to-end time.",
          "Record attempts per request and every cap violation."
        ]
      }
    },
    {
      id: "coding-execution",
      number: "04",
      track: "coding",
      title: "Execute the 75-minute coding round",
      shortTitle: "75-minute execution",
      duration: 75,
      color: "#a43e2e",
      soft: "#f7e2df",
      description: "Use AI tools as a controlled implementation aid while keeping the contract, tests, benchmarks, and final explanation under your ownership.",
      outcomes: [
        "Allocate the round across clarification, implementation, measurement, and cleanup.",
        "Use deterministic fakes to test time and concurrency.",
        "Present measured improvements and unfinished production concerns clearly."
      ],
      lessons: [
        {
          id: "coding-operating-loop",
          number: "10",
          title: "Time-box the right sequence",
          duration: 20,
          summary: "A measured baseline and one defended improvement beat a pile of unfinished policies.",
          prediction: "You have a working round-robin gateway at minute 30. Should you add distributed health coordination or benchmark the next local routing change?",
          core: [
            "Use minutes 0 through 7 for the contract, failure classes, interface, and target metrics. Confirm how providers are mocked and how the result is evaluated.",
            "Use minutes 7 through 22 for one correct provider path, then minutes 22 through 37 for caps, the total deadline, fallback, and cleanup. Run deterministic tests before changing policy.",
            "Use minutes 37 through 52 for one adaptive rule and minutes 52 through 64 for a comparable benchmark. Reserve the final eleven minutes for edge cases, naming, and explanation."
          ],
          mechanics: [
            { title: "Checkpoint 1", text: "The endpoint forwards one request correctly and has deterministic provider fakes." },
            { title: "Checkpoint 2", text: "Active work is bounded and all terminal paths release capacity." },
            { title: "Checkpoint 3", text: "The benchmark compares the baseline with one stated policy change." },
            { title: "Checkpoint 4", text: "The final code and notes explain trade-offs without hidden assumptions." }
          ],
          deep: [
            "Keep a short fallback plan. If adaptive state is incomplete at minute 52, retain the correct baseline and finish tests rather than leaving the request path broken.",
            "State what you intentionally defer: shared state, global quotas, durable telemetry, credential rotation, rollout policy, and streaming recovery belong in the follow-up design."
          ],
          bridge: { title: "Interviewer visibility", text: "Say the current checkpoint and next experiment aloud. The interviewer can assess reasoning even while code is running." },
          failure: { title: "Complexity before proof", text: "Starting with hedging, a breaker, and adaptive weights creates interacting bugs before there is a correct reference path. Add one measured mechanism at a time." },
          visual: {
            type: "timeline",
            title: "Seventy-five minutes",
            nodes: [
              ["0-7", "contract"],
              ["7-22", "one provider"],
              ["22-37", "bounds and fallback"],
              ["37-52", "health policy"],
              ["52-64", "benchmark"],
              ["64-75", "tests and defense"]
            ]
          },
          check: {
            question: "At minute 64, what should receive priority?",
            choices: ["A new control plane", "Tests, cleanup, and explanation", "A third provider", "A database migration"],
            answer: 1,
            explanation: "The final minutes should leave a correct, readable result that the interviewers can review."
          },
          sources: [
            ["Google SRE testing for reliability", "https://sre.google/sre-book/testing-reliability/"],
            ["Google engineering practices: small changes", "https://google.github.io/eng-practices/review/developer/small-cls.html"],
            ["k6 scenarios", "https://grafana.com/docs/k6/latest/using-k6/scenarios/"]
          ]
        },
        {
          id: "deterministic-gateway-tests",
          number: "11",
          title: "Test concurrency without sleeping",
          duration: 30,
          summary: "A virtual clock and scripted providers make deadlines, overlap, and cleanup exact rather than timing-sensitive.",
          prediction: "A test sleeps 100 ms and expects a timeout at 90 ms. What can make that test fail even when the code is correct?",
          core: [
            "Inject a virtual clock that advances scheduled events in order. Script each provider attempt with latency, status, body, and cancellation behavior.",
            "Record active attempts at every event and assert the peak never exceeds the configured cap. Hold tasks open to prove queueing rather than inferring it from elapsed wall time.",
            "Cover success, provider failure, 429, timeout, caller cancellation, hedge loss, both providers unavailable, recovery probe, and cleanup after thrown errors."
          ],
          mechanics: [
            { title: "Fake provider", text: "Returns a scripted result through the same interface as the real provider client." },
            { title: "Virtual clock", text: "Runs scheduled callbacks deterministically without sleeping." },
            { title: "Event ledger", text: "Records acquire, start, finish, cancel, release, and health update in order." },
            { title: "Hidden test", text: "Changes order and failure timing to catch code coupled to one fixture." }
          ],
          deep: [
            "One deterministic case should start five tasks with two active slots and two queue slots. The fifth must fail as overloaded, and cancelling one queued task must remove it without leaking capacity.",
            "For a delayed hedge, script A at 200 ms, launch B at 50 ms, and finish B 25 ms later. Assert B wins at 75 ms, A receives neutral cancellation, and both attempts obey caps."
          ],
          bridge: { title: "AI tool boundary", text: "Ask the coding assistant for one small function or missing test, inspect the diff, and run the deterministic suite before accepting it." },
          failure: { title: "Flaky proof", text: "Wall-clock sleeps mix scheduler noise with gateway behavior. A passing run cannot prove event order, and a slow machine can create false failures." },
          visual: {
            type: "event-log",
            title: "One exact hedge test",
            nodes: [
              ["t=0", "A acquire and start"],
              ["t=50", "B acquire and start"],
              ["t=75", "B succeeds"],
              ["t=75", "A cancelled neutrally"],
              ["t=75", "both slots released"]
            ]
          },
          check: {
            question: "What proves a semaphore cap of two?",
            choices: ["The constructor argument", "An observed peak-active count of two under overlap", "One sequential request", "A low p50"],
            answer: 1,
            explanation: "The test must create overlap and observe that a third task cannot become active."
          },
          sources: [
            ["Google SRE dependency injection example", "https://sre.google/sre-book/testing-reliability/#traditional-tests"],
            ["Node test mocking timers", "https://nodejs.org/api/test.html#mocktimers"],
            ["Python asyncio synchronization", "https://docs.python.org/3/library/asyncio-sync.html"]
          ]
        },
        {
          id: "benchmark-defense",
          number: "12",
          title: "Defend the code with evidence",
          duration: 25,
          summary: "The final walkthrough connects each code boundary to a benchmark result and a known limitation.",
          prediction: "Adaptive routing lowers p95 from 180 ms to 115 ms but raises attempts per request from 1.00 to 1.35. Is it clearly better?",
          core: [
            "Show the baseline and final row together. State offered load, seed, caps, success, p95, p99, queue delay, and attempt amplification.",
            "Walk the request path in code order: validate, admit, select, attempt, classify, update, and respond. Point out how cancellation and cleanup reach every terminal path.",
            "Name the cost of the chosen policy. A latency win with thirty-five percent extra provider work may violate quota, cost, or overload constraints."
          ],
          mechanics: [
            { title: "Claim", text: "State the specific behavior the policy should improve." },
            { title: "Evidence", text: "Show a comparable benchmark or deterministic failure test." },
            { title: "Cost", text: "Name added attempts, state, latency, memory, or failure coupling." },
            { title: "Next step", text: "Name the first production concern to address without pretending it is implemented." }
          ],
          deep: [
            "If one metric improved and another regressed, tie the choice to an explicit SLO or constraint. There is no universal score that combines latency, availability, and cost.",
            "Keep generated code only when you can explain its ownership, failure behavior, and tests. Delete helpers that obscure the request path or duplicate state."
          ],
          bridge: { title: "Follow-up handoff", text: "End by drawing the single-process state that must become fleet-aware: health hints, provider quotas, logs, and configuration." },
          failure: { title: "Benchmark theater", text: "A result without the workload, seed, caps, and errors is not comparable. Keep the table small enough that every row can be explained." },
          visual: {
            type: "evidence-chain",
            title: "Policy defense",
            nodes: [
              ["Goal", "latency and success"],
              ["Change", "one policy"],
              ["Test", "deterministic"],
              ["Benchmark", "same schedule"],
              ["Trade-off", "cost and risk"]
            ]
          },
          check: {
            question: "What makes two benchmark rows comparable?",
            choices: ["Different workloads", "The same workload, caps, seed, and measurement rules", "Only the same p50", "A larger code diff"],
            answer: 1,
            explanation: "Controlled conditions isolate the routing change from workload and configuration changes."
          },
          sources: [
            ["k6 metrics", "https://grafana.com/docs/k6/latest/using-k6/metrics/"],
            ["HdrHistogram", "https://github.com/HdrHistogram/HdrHistogram"],
            ["The Tail at Scale", "https://research.google/pubs/the-tail-at-scale/"]
          ]
        }
      ],
      quizExtra: [
        {
          question: "What should happen after accepting an AI-generated routing change?",
          choices: ["Trust it because it compiles", "Inspect it and rerun deterministic tests and the benchmark", "Add another policy immediately", "Remove the baseline"],
          answer: 1,
          explanation: "The candidate owns correctness and must verify generated changes."
        },
        {
          question: "A hidden test reorders provider completions. What design quality does it probe?",
          choices: ["Hard-coded timing assumptions", "CSS rendering", "DNS ownership", "Log retention"],
          answer: 0,
          explanation: "Correct async code should handle any valid completion order."
        },
        {
          question: "Why preserve the baseline benchmark row?",
          choices: ["To make the document longer", "To prove whether later policy helped", "To avoid tests", "To set provider credentials"],
          answer: 1,
          explanation: "Without a reference run, an observed final number has no controlled comparison."
        }
      ],
      lab: {
        id: "timed-gateway-coding",
        title: "Build the bounded gateway path",
        kind: "code-runner",
        badge: "Browser-tested integration",
        intro: "Implement selection, fallback, one shared deadline, application and provider caps, cancellation, and exact cleanup against overlapping scripted requests.",
        notebook: [
          "Keep the contract and benchmark table visible.",
          "Log every accepted AI-generated change.",
          "Finish with one known limitation and one production next step."
        ]
      }
    },
    {
      id: "production-fleet",
      number: "05",
      track: "gateway-design",
      title: "Scale the gateway to a fleet",
      shortTitle: "Production fleet",
      duration: 78,
      color: "#1f607d",
      soft: "#deedf3",
      description: "Keep routing fast and locally informed while coordinating slow policy, provider quotas, and configuration across many app servers.",
      outcomes: [
        "Separate the data, control, and telemetry planes.",
        "Combine local health with asynchronous fleet evidence.",
        "Prevent replica count from multiplying provider quotas."
      ],
      lessons: [
        {
          id: "three-gateway-planes",
          number: "13",
          title: "Separate the three planes",
          duration: 26,
          summary: "The forwarding path should survive loss of slow configuration, aggregation, and telemetry dependencies.",
          prediction: "The shared health database is down. Should every gateway request fail before contacting a provider?",
          core: [
            "The data plane validates, admits, selects, and forwards requests. It uses local state and a last-known-good policy without a synchronous health-store read.",
            "The control plane distributes provider inventory, compatibility, weights, exclusions, quotas, and rollout versions. Updates are asynchronous and acknowledged or rejected by each replica.",
            "The telemetry plane exports request, attempt, health, limiter, and configuration evidence without holding the response open."
          ],
          mechanics: [
            { title: "Data plane", text: "Latency-sensitive request processing and local protection." },
            { title: "Control plane", text: "Slower policy calculation and versioned configuration delivery." },
            { title: "Telemetry plane", text: "Asynchronous evidence collection, aggregation, storage, and alerting." },
            { title: "Last known good", text: "The most recent valid policy retained when updates stop or fail validation." }
          ],
          deep: [
            "A control update needs a version, generation time, scope, and expiry policy. The data plane must define whether stale state remains usable or falls back to a safer static route.",
            "Sequence dependent resources before routes that reference them. Eventual configuration delivery can briefly point at a provider that a replica does not yet know."
          ],
          bridge: { title: "Whiteboard order", text: "Draw the request path first, then place control arrows above it and telemetry arrows below it. This keeps slow dependencies out of the hot path." },
          failure: { title: "Shared-store coupling", text: "A synchronous read for every selection adds latency and turns a coordination outage into a total gateway outage. Cache valid policy and update it asynchronously." },
          visual: {
            type: "planes",
            title: "Three independent failure domains",
            nodes: [
              ["Control", "versioned policy"],
              ["Data", "request path"],
              ["Providers", "external capacity"],
              ["Telemetry", "async events"],
              ["Backends", "logs, metrics, traces"]
            ]
          },
          check: {
            question: "Which dependency should a normal provider selection require synchronously?",
            choices: ["A log backend", "A shared health database", "Local valid policy and state", "A dashboard"],
            answer: 2,
            explanation: "Local state keeps the data plane available when slower supporting systems fail."
          },
          sources: [
            ["Envoy xDS protocol", "https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol.html"],
            ["Envoy life of a request", "https://www.envoyproxy.io/docs/envoy/latest/intro/life_of_a_request.html"],
            ["OpenTelemetry gateway deployment", "https://opentelemetry.io/docs/collector/deploy/gateway/"]
          ]
        },
        {
          id: "coordinated-health",
          number: "14",
          title: "Coordinate health without erasing locality",
          duration: 26,
          summary: "Local passive health reacts to path-specific failures, while a fleet aggregator supplies slower evidence and broad exclusions.",
          prediction: "One replica reports two timeouts and another reports two hundred successes. Which state should the first replica use for its next A request?",
          core: [
            "Keep local passive observations in the selection path. Publish attempt events asynchronously so an aggregator can compute broader, time-decayed health by provider, model, and locality.",
            "Treat aggregate weights as hints rather than a replacement for local reachability. A local network partition is real for the affected gateway even when the provider is healthy elsewhere.",
            "Use independent active probes to distinguish provider-wide failure from client-path failure. Probe payloads, rate, credentials, and location must represent the path they claim to test."
          ],
          mechanics: [
            { title: "Fast loop", text: "Local active count, passive outcomes, cooldown, and probe state update within one process." },
            { title: "Slow loop", text: "Fleet aggregation publishes decayed weights and scoped exclusions." },
            { title: "Epoch", text: "A monotonic policy version prevents an older update from replacing a newer one." },
            { title: "Expiry", text: "A time bound limits how long a broad exclusion can survive without refresh." }
          ],
          deep: [
            "Global ejection can create synchronized failover. Limit the shifted share, include destination capacity, and use staged recovery so the surviving provider is not overwhelmed.",
            "Health events are observations, not commands. Keep raw outcome class and source identity so aggregation policy can change without reinterpreting flattened healthy or unhealthy booleans."
          ],
          bridge: { title: "Answer shape", text: "State which decisions are local, which are aggregated, how updates arrive, and what the gateway does when the aggregator is stale." },
          failure: { title: "Consensus on the wrong view", text: "A fleet-wide green state can override the one gateway that cannot reach A. Local transport failures must retain authority for that request path." },
          visual: {
            type: "feedback",
            title: "Two health loops",
            nodes: [
              ["Real attempts", "local evidence"],
              ["Local router", "fast decision"],
              ["Event stream", "async publish"],
              ["Aggregator", "fleet hint"],
              ["Policy update", "versioned and scoped"]
            ]
          },
          check: {
            question: "What should a gateway do with an older health-policy epoch?",
            choices: ["Apply it immediately", "Reject or ignore it", "Delete local state", "Block all requests"],
            answer: 1,
            explanation: "A monotonic epoch prevents delayed messages from rolling policy backward."
          },
          sources: [
            ["Envoy outlier detection", "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/outlier"],
            ["Envoy health checking", "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/health_checking"],
            ["xDS eventual consistency", "https://www.envoyproxy.io/docs/envoy/latest/api-docs/xds_protocol.html#eventual-consistency-considerations"]
          ]
        },
        {
          id: "global-provider-capacity",
          number: "15",
          title: "Coordinate provider capacity",
          duration: 26,
          summary: "Local caps protect a process, while a global quota or leased budget protects the provider account across autoscaling and failover.",
          prediction: "A has a quota of 100 concurrent requests. The fleet grows from five to twenty replicas, each capped at ten A requests. What changed at the provider boundary?",
          core: [
            "A local cap multiplies by replica count. Use a global rate or concurrency service, or distribute renewable leases that give each replica a bounded share of provider capacity.",
            "Keep a coarse local limiter in front of a global check so sudden bursts do not overload the coordination service. Decide explicitly whether coordination failure fails open or closed by tenant and workload.",
            "Reserve fallback capacity before an outage. If B cannot absorb A's normal share, global failover must shed lower-priority work instead of moving every request."
          ],
          mechanics: [
            { title: "Global limit", text: "One account-wide request, token, or concurrency budget shared by all replicas." },
            { title: "Local bucket", text: "A cheap first-stage burst control within one replica." },
            { title: "Lease", text: "A time-bounded capacity allocation used locally without one remote check per attempt." },
            { title: "Priority", text: "A rule for preserving selected traffic when total healthy capacity falls." }
          ],
          deep: [
            "Rate, concurrency, and token quotas are different. Long model calls can respect requests per second while exhausting concurrent slots, and large prompts can exhaust token budgets at low request rate.",
            "Autoscaling from gateway CPU does not create provider capacity. Include quota utilization and provider queueing in scaling and admission decisions."
          ],
          bridge: { title: "Capacity math", text: "Put replica count, local cap, provider quota, normal load, and single-provider failover load on the board before choosing a coordinator." },
          failure: { title: "Failover overload", text: "Routing every request to B after A fails can turn one provider incident into two. Shift only within B's reserved capacity and reject the rest early." },
          visual: {
            type: "budget",
            title: "A quota split into leases",
            nodes: [
              ["Provider quota", "100 concurrent"],
              ["Lease service", "allocate"],
              ["Replica 1", "local share"],
              ["Replica 2", "local share"],
              ["Reserve", "failover headroom"]
            ]
          },
          check: {
            question: "Why keep a local limiter when a global quota service exists?",
            choices: ["To multiply the quota", "To absorb bursts and reduce coordinator load", "To remove all deadlines", "To disable failover"],
            answer: 1,
            explanation: "Local rejection is fast and prevents every burst from becoming a remote quota call."
          },
          sources: [
            ["Envoy global rate limiting", "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/other_features/global_rate_limiting.html"],
            ["Envoy rate-limit filter", "https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/rate_limit_filter"],
            ["Google SRE cascading failures", "https://sre.google/sre-book/addressing-cascading-failures/"]
          ]
        }
      ],
      quizExtra: [
        {
          question: "A health aggregator stops publishing. What should a data-plane replica do first?",
          choices: ["Crash", "Use valid local state and the last-known-good policy", "Block on the logging backend", "Delete all provider clients"],
          answer: 1,
          explanation: "The data plane remains available with cached valid policy while surfacing staleness."
        },
        {
          question: "Which failure can a local router see that a global average may hide?",
          choices: ["A path-specific network partition", "A documented model name", "A static quota", "A completed dashboard"],
          answer: 0,
          explanation: "Reachability can differ by gateway zone or instance."
        },
        {
          question: "What must accompany an expiring global provider exclusion?",
          choices: ["A policy version and scope", "A prompt body", "An unbounded queue", "A browser cookie"],
          answer: 0,
          explanation: "Version, scope, and expiry prevent stale or misplaced exclusions from persisting."
        }
      ],
      lab: {
        id: "fleet-capacity-board",
        title: "Scale replicas without scaling quota",
        kind: "fleet-simulator",
        badge: "System model",
        intro: "Change replica count, local caps, provider quotas, and failover reserve. Keep the hot path serving while control dependencies fail.",
        notebook: [
          "Write the normal and single-provider capacity equations.",
          "Name the fail-open or fail-closed policy for quota coordination.",
          "State which health decision remains local."
        ]
      }
    },
    {
      id: "telemetry-recovery",
      number: "06",
      track: "gateway-design",
      title: "Logs, telemetry, overload, and recovery",
      shortTitle: "Operate the gateway",
      duration: 78,
      color: "#2f7189",
      soft: "#e0eff3",
      description: "Make every attempt explainable while bounded telemetry and overload controls keep observability failures from taking down inference.",
      outcomes: [
        "Design separate request, attempt, and durable business records.",
        "Correlate metrics, logs, and traces without high-cardinality metrics.",
        "Predict gateway behavior under provider and telemetry failure."
      ],
      lessons: [
        {
          id: "structured-log-flow",
          number: "16",
          title: "Write logs off the response path",
          duration: 26,
          summary: "Structured attempt events travel through bounded asynchronous queues, while durability-required records use a separate contract.",
          prediction: "The log backend stops accepting writes. Should every successful inference wait until logging recovers?",
          core: [
            "Emit one logical request outcome and one event for each physical attempt. Include request ID, trace ID, attempt ID, provider, outcome class, queue time, attempt time, deadline remaining, policy version, and retry or hedge reason.",
            "Send ordinary telemetry through a bounded local buffer to an agent or collector. Define retry, persistence, drop, and sampling behavior when downstream storage is slow.",
            "Separate billing or audit records that require durable delivery. Give them stable event IDs and an idempotent consumer rather than pretending a best-effort log is a ledger."
          ],
          mechanics: [
            { title: "Event time", text: "When the application says the event occurred." },
            { title: "Observed time", text: "When the collection pipeline received the event." },
            { title: "Bounded queue", text: "Limits memory while the exporter is slow or unavailable." },
            { title: "Stable event ID", text: "Lets an at-least-once durable consumer remove duplicates." }
          ],
          deep: [
            "Do not log prompt or response content by default. Content can contain credentials, personal data, customer source, or regulated information; record size, model, and safe hashes only when policy permits.",
            "Global event order is neither needed nor cheaply available. Preserve request-local attempt sequence and timestamps, then correlate through trace and request identifiers."
          ],
          bridge: { title: "System-design answer", text: "State whether the record is telemetry or a business ledger, where it buffers, what happens when full, and how loss or duplication becomes visible." },
          failure: { title: "Telemetry backpressure", text: "An unbounded exporter queue turns a backend outage into gateway memory exhaustion. Bound it, monitor it, and choose an explicit loss or persistence policy." },
          visual: {
            type: "pipeline",
            title: "Two write contracts",
            nodes: [
              ["Gateway", "structured events"],
              ["Local collector", "bounded queue"],
              ["Telemetry backend", "search and metrics"],
              ["Durable event", "billing or audit"],
              ["Idempotent ledger", "business record"]
            ]
          },
          check: {
            question: "Which record needs a stable deduplication ID?",
            choices: ["A durability-required billing event", "A metric bucket", "A CSS rule", "A provider score"],
            answer: 0,
            explanation: "A durable pipeline may deliver more than once, so consumers need an idempotent key."
          },
          sources: [
            ["OpenTelemetry log data model", "https://opentelemetry.io/docs/specs/otel/logs/data-model/"],
            ["OpenTelemetry Collector resiliency", "https://opentelemetry.io/docs/collector/resiliency/"],
            ["OpenTelemetry agent-to-gateway", "https://opentelemetry.io/docs/collector/deploy/other/agent-to-gateway/"]
          ]
        },
        {
          id: "gateway-observability",
          number: "17",
          title: "Observe logical requests and physical attempts",
          duration: 26,
          summary: "A root request span and child attempt spans explain how fallback preserved an SLO or how extra work amplified failure.",
          prediction: "A request succeeds through B after A times out. Is the end-user result a gateway failure, a provider failure, both, or neither?",
          core: [
            "Measure end-user success and end-to-end latency at the gateway. Separately measure every provider attempt so a successful fallback does not erase A's failure.",
            "Create one request span with one child per physical HTTP attempt. Intentional caller and hedge-winner cancellations remain neutral rather than becoming errors.",
            "Use low-cardinality metric labels such as provider, model class, route, and outcome. Put request IDs, full error context, and policy versions in traces or logs."
          ],
          mechanics: [
            { title: "Request SLI", text: "Whether the gateway returned an acceptable response within its latency objective." },
            { title: "Attempt SLI", text: "Provider outcome, latency, and capacity evidence for one physical call." },
            { title: "Histogram", text: "Aggregatable latency distribution used for thresholds and tail analysis." },
            { title: "Exemplar", text: "A trace reference attached to a metric observation for a concrete slow request." }
          ],
          deep: [
            "For streaming, track time to first chunk and complete-stream duration separately. A fast first token with a stalled stream is not a complete success.",
            "Alert on end-user error-budget burn and saturation, then use provider and attempt signals for diagnosis. Paging directly on every provider blip creates noise when fallback is working."
          ],
          bridge: { title: "Dashboard story", text: "Show traffic, errors, latency, and saturation for the gateway, then break down attempts by provider and policy version." },
          failure: { title: "Cardinality explosion", text: "Putting request ID, prompt hash, or raw model string in metric labels creates unbounded time series. Keep those fields in logs and traces." },
          visual: {
            type: "trace",
            title: "Success after fallback",
            nodes: [
              ["Gateway request", "success"],
              ["Attempt A", "timeout"],
              ["Attempt B", "success"],
              ["Request log", "final route"],
              ["Metrics", "both layers"]
            ]
          },
          check: {
            question: "Where should a request ID be recorded?",
            choices: ["As a metric label", "In correlated logs and traces", "As a histogram boundary", "In the provider cap"],
            answer: 1,
            explanation: "Request IDs are high cardinality and belong in event-oriented signals."
          },
          sources: [
            ["OpenTelemetry HTTP spans", "https://opentelemetry.io/docs/specs/semconv/http/http-spans/"],
            ["OpenTelemetry HTTP metrics", "https://opentelemetry.io/docs/specs/semconv/http/http-metrics/"],
            ["W3C Trace Context", "https://www.w3.org/TR/trace-context/"],
            ["Google SRE monitoring distributed systems", "https://sre.google/sre-book/monitoring-distributed-systems/"]
          ]
        },
        {
          id: "overload-failure-drills",
          number: "18",
          title: "Design the degraded modes",
          duration: 26,
          summary: "Failure drills test whether caps, fallback, retries, logs, and recovery interact safely under the events they were built to handle.",
          prediction: "A slows by 600 ms without returning errors. Which mechanism reacts first: a consecutive-error breaker or latency-aware routing?",
          core: [
            "Drill latency inflation, 5xx bursts, 429 pushback, connection resets, partial streams, one-zone partitions, empty startup state, stale policy, quota-service loss, and collector backpressure.",
            "For each fault, name detection, request behavior, capacity consequence, recovery trigger, and one misleading signal. Verify that the system fails within a bounded queue and memory envelope.",
            "Use load shedding before local saturation. Prefer an early 429 or 503 over admitting work that cannot finish within its deadline."
          ],
          mechanics: [
            { title: "Fault", text: "The injected condition, duration, scope, and affected layer." },
            { title: "Steady degraded state", text: "The intended behavior after detection but before recovery." },
            { title: "Recovery", text: "The probe, expiry, or operator action that restores traffic." },
            { title: "Invariant", text: "The cap, deadline, data rule, or SLO property that must still hold." }
          ],
          deep: [
            "A retry policy that helps during rare resets can amplify a provider-wide outage. Repeat the same drill at normal load and near saturation to expose that boundary.",
            "Control-plane and telemetry failures deserve drills even when providers are healthy. Supporting systems often fail differently from the data path they observe."
          ],
          bridge: { title: "Interview defense", text: "Pick two faults and walk them end to end. Concrete degraded behavior is stronger than listing many components." },
          failure: { title: "Recovery stampede", text: "When every replica exits cooldown or reloads empty state together, probes and ordinary traffic can flood the provider. Jitter and slow start must be exercised, not merely configured." },
          visual: {
            type: "drill",
            title: "Fault to invariant",
            nodes: [
              ["Inject", "A latency +600 ms"],
              ["Detect", "attempt p95 rises"],
              ["Degrade", "shift within B reserve"],
              ["Recover", "limited A probes"],
              ["Verify", "caps and SLO"]
            ]
          },
          check: {
            question: "Why run a retry drill near saturation?",
            choices: ["Retries use no capacity", "A helpful retry can become overload amplification", "Latency disappears", "It removes the queue"],
            answer: 1,
            explanation: "Extra attempts consume scarce slots and can worsen an already saturated provider."
          },
          sources: [
            ["Envoy overload manager", "https://www.envoyproxy.io/docs/envoy/latest/configuration/operations/overload_manager/overload_manager"],
            ["Google SRE cascading failures", "https://sre.google/sre-book/addressing-cascading-failures/"],
            ["Google SRE testing for reliability", "https://sre.google/sre-book/testing-reliability/"]
          ]
        }
      ],
      quizExtra: [
        {
          question: "The telemetry queue is full. Which policy prevents gateway memory from growing without limit?",
          choices: ["An unbounded retry loop", "A bounded queue with explicit drop or persistence", "A request-ID metric label", "A longer provider timeout"],
          answer: 1,
          explanation: "Bounded buffering limits resource use and forces a stated loss or durability decision."
        },
        {
          question: "A request succeeds after one failed provider attempt. Which signals should record failure?",
          choices: ["Only the gateway outcome", "The failed attempt, while the gateway outcome remains success", "Neither", "Every metric label"],
          answer: 1,
          explanation: "Logical and physical outcomes answer different operational questions."
        },
        {
          question: "Which overload response is safer?",
          choices: ["Accept into an unbounded queue", "Reject early when the deadline cannot be met", "Disable all caps", "Start unlimited hedges"],
          answer: 1,
          explanation: "Early rejection preserves bounded work and prevents requests from timing out after consuming more resources."
        }
      ],
      lab: {
        id: "gateway-incident-console",
        title: "Operate a failing gateway fleet",
        kind: "incident-simulator",
        badge: "Failure drills",
        intro: "Inject provider, control-plane, quota, and telemetry faults. Choose a mitigation and verify request-path invariants.",
        notebook: [
          "Name the first reliable detection signal.",
          "State the intended degraded state and capacity ceiling.",
          "Define the recovery probe and stampede protection."
        ]
      }
    },
    {
      id: "crawler-request-path",
      number: "07",
      track: "crawler-design",
      title: "The crawler request path",
      shortTitle: "Crawler request path",
      duration: 72,
      color: "#426f3d",
      soft: "#e7f1df",
      description: "Turn crawler requirements into capacity estimates, then follow one URL through scheduling, fetching, parsing, and storage.",
      outcomes: [
        "Gather the requirements that materially change a crawler design.",
        "Trace URL ownership and state changes from a seed to a stored document.",
        "Separate scheduling, network fetch, parsing, and durable storage."
      ],
      lessons: [
        {
          id: "crawler-requirements",
          number: "19",
          title: "Requirements first, arithmetic second",
          duration: 24,
          summary: "A crawler architecture becomes concrete after scope, freshness, politeness, rendering, and output requirements are translated into rates and bytes.",
          prediction: "The target is one billion pages each month. What must you ask before converting that number into an average fetch rate?",
          core: [
            "Ask about allowed domains, seed discovery, page and content types, JavaScript rendering, maximum response size, revisit freshness, robots policy, legal constraints, output consumers, durability, and regional scope.",
            "Convert pages per day into average fetches per second, then state a peak factor and retry allowance. Multiply successful fetches by compressed body, metadata, link, and replication estimates to size network and storage paths.",
            "Global capacity does not override per-site politeness. A large worker fleet may have idle slots while the scheduler waits for each authority's next eligible time.",
            "State every invented number as an interview assumption. The supplied notes identify a web-crawling design round but do not specify crawl scale, freshness, rendering, or retention."
          ],
          mechanics: [
            { title: "Scope", text: "Public web, an allowlist, one customer domain, or a recrawl corpus imply different safety and discovery rules." },
            { title: "Rate", text: "Average fetch rate equals pages divided by time; provision separately for peaks, retries, redirects, robots requests, and rendering." },
            { title: "Bytes", text: "Account for response bodies, fetch metadata, extracted links, indexes, replication, and retained versions." },
            { title: "Freshness", text: "A revisit objective determines how the frontier prioritizes known URLs against new discoveries." }
          ],
          deep: [
            "Split fetches by class. HTML, large documents, and browser-rendered pages have different CPU, memory, network, timeout, and security envelopes.",
            "Name the success metric before selecting components: useful documents per hour, freshness percentile, coverage, duplicate rate, host-policy violations, or cost per accepted document."
          ],
          bridge: { title: "Whiteboard opening", text: "Spend the first minutes writing scope, scale, freshness, politeness, rendering, retention, and availability. Put arithmetic beside each stated assumption." },
          failure: { title: "One global throughput target", text: "A single pages-per-second number hides skew. One authority may expose millions of URLs while politeness permits only a few requests per second." },
          visual: {
            type: "requirements",
            title: "Questions become design constraints",
            nodes: [
              ["Scope", "which URLs"],
              ["Freshness", "when to revisit"],
              ["Politeness", "per-site pace"],
              ["Workload", "fetch, parse, render"],
              ["Arithmetic", "rate and bytes"]
            ]
          },
          check: {
            question: "Why can a crawler with spare global workers still be correctly idle?",
            choices: ["DNS always fails", "Every authority may be waiting for its next polite fetch time", "Storage requires one worker", "URLs cannot be queued"],
            answer: 1,
            explanation: "The global pool cannot spend capacity by violating the independent schedule for each authority."
          },
          sources: [
            ["Mercator crawler architecture", "https://research.google/pubs/mercator-a-scalable-extensible-web-crawler/"],
            ["Google SRE capacity planning", "https://sre.google/sre-book/software-engineering-in-sre/"],
            ["HTTP semantics", "https://www.rfc-editor.org/rfc/rfc9110.html"]
          ]
        },
        {
          id: "crawler-url-path",
          number: "20",
          title: "Trace one URL from seed to discovery",
          duration: 24,
          summary: "The request path is a sequence of owned state transitions, not a fetch loop with a queue attached.",
          prediction: "A fetched page redirects to another hostname, which resolves to an internal address. Which stages must run again?",
          core: [
            "A seed is parsed, resolved against any base URL, normalized conservatively, checked against crawl scope, filtered by URL identity, associated with robots policy, and placed into the frontier for its authority.",
            "The frontier releases eligible work to a fetcher. The fetcher resolves DNS, applies address and shared-IP policy, connects with deadlines, follows approved redirects through the same safety checks, and emits bounded response metadata and bytes.",
            "A parser extracts canonical metadata and links. Each discovered reference is resolved against the document base, normalized, checked, deduplicated, and durably admitted to the frontier before the parse task is acknowledged.",
            "Raw content, fetch metadata, parse results, and link edges have different update patterns. Give them explicit keys and owners instead of treating storage as one box."
          ],
          mechanics: [
            { title: "URL identity", text: "The normalized fetch identity decides whether two references point to the same scheduled resource." },
            { title: "Authority state", text: "Robots policy, next-eligible time, concurrency, failure history, and DNS observations belong near the authority scheduler." },
            { title: "Fetch record", text: "Record requested URL, redirect chain, connected address, status, headers, timing, body digest, and terminal reason." },
            { title: "Discovery edge", text: "Preserve source document and target URL so ranking, debugging, and recrawl policy can explain why work exists." }
          ],
          deep: [
            "Relative references are resolved before identity normalization. HTML can also change the document base, so link extraction must use the parser's effective base URL rather than concatenate strings.",
            "A redirect creates a new request target. Reapply scope, scheme, port, DNS, address, robots, and quota checks on every hop."
          ],
          bridge: { title: "Design narration", text: "Draw one numbered arrow per state transition and name which service owns retries and acknowledgment at that boundary." },
          failure: { title: "Acknowledge before discovery is durable", text: "If the parser crashes after acknowledging the document but before discovered URLs reach durable storage, an entire subtree can disappear from the crawl." },
          visual: {
            type: "pipeline",
            title: "URL lifecycle",
            nodes: [
              ["Seed", "parse and scope"],
              ["Frontier", "wait by authority"],
              ["Fetcher", "resolve and request"],
              ["Parser", "extract links"],
              ["Storage", "body, metadata, edges"],
              ["Discovery", "admit new URLs"]
            ]
          },
          check: {
            question: "When should a parser task be acknowledged if discovered links matter for coverage?",
            choices: ["Before parsing", "After discovered work is durably admitted", "After DNS starts", "As soon as bytes arrive"],
            answer: 1,
            explanation: "Durable admission before acknowledgment prevents a crash from losing the discovered branch."
          },
          sources: [
            ["URI generic syntax", "https://www.rfc-editor.org/rfc/rfc3986.html"],
            ["WHATWG URL standard", "https://url.spec.whatwg.org/"],
            ["WHATWG HTML parsing", "https://html.spec.whatwg.org/multipage/"],
            ["Mercator crawler architecture", "https://research.google/pubs/mercator-a-scalable-extensible-web-crawler/"]
          ]
        },
        {
          id: "crawler-fetch-parse-store",
          number: "21",
          title: "Separate fetch, parse, and storage pressure",
          duration: 24,
          summary: "Independent bounded stages keep slow parsers, large bodies, or storage trouble from silently consuming every fetch slot.",
          prediction: "Fetchers receive pages faster than parsers can process them. Where should pressure be applied, and which resource must remain bounded?",
          core: [
            "Use separate scheduler, fetcher, parser, and storage pools with bounded queues. A full downstream queue must slow admission or spill to an intentional durable buffer rather than expand process memory.",
            "Stream response bodies into a size-limited sink. Enforce connection, header, body-idle, total, compressed-byte, and decompressed-byte limits; release the network slot even if parsing happens later.",
            "Store immutable raw content by a digest or versioned fetch key, plus mutable URL metadata that points to the accepted version. Make repeated delivery safe because leases and workers can retry.",
            "Parsing is untrusted-data processing. Bound document complexity, parser time, extracted link count, and rendering resources; isolate browser execution from fetch credentials and internal networks."
          ],
          mechanics: [
            { title: "Fetcher", text: "Owns DNS, connection, HTTP deadlines, redirects, byte limits, and the exact network outcome." },
            { title: "Body store", text: "Accepts a bounded stream and returns a stable content or version reference." },
            { title: "Parser", text: "Consumes stored bytes, emits metadata and bounded discovered links, and can retry without another network request." },
            { title: "Backpressure", text: "Propagates downstream saturation to scheduling while preserving per-stage resource ceilings." }
          ],
          deep: [
            "Content-addressed bodies reduce duplicate storage, but URL fetch records still need timestamps, status, headers, redirect chains, and policy decisions. A digest alone cannot answer what happened.",
            "JavaScript rendering is a separate workload class. Route it through stricter quotas and stronger isolation instead of letting browser tasks occupy ordinary fetch workers."
          ],
          bridge: { title: "Capacity check", text: "For every queue on the drawing, state its bound, full behavior, retry owner, and whether its payload is durable." },
          failure: { title: "Decompression bomb", text: "A small compressed response can expand far beyond its transfer size. Counting only wire bytes leaves memory and parser CPU unprotected." },
          visual: {
            type: "backpressure",
            title: "Bounded crawler stages",
            nodes: [
              ["Frontier", "eligible leases"],
              ["Fetch pool", "network limits"],
              ["Body sink", "byte limits"],
              ["Parse pool", "CPU limits"],
              ["Discovery", "durable admission"]
            ]
          },
          check: {
            question: "Why store a fetched body before an asynchronous parse when possible?",
            choices: ["It removes HTTP", "A parser retry need not repeat the external fetch", "It disables dedupe", "It makes queues unbounded"],
            answer: 1,
            explanation: "Separating the durable fetch result from parsing limits duplicate network work and gives each stage independent retries."
          },
          sources: [
            ["HTTP message semantics", "https://www.rfc-editor.org/rfc/rfc9110.html"],
            ["WHATWG HTML standard", "https://html.spec.whatwg.org/multipage/"],
            ["Mercator crawler architecture", "https://research.google/pubs/mercator-a-scalable-extensible-web-crawler/"],
            ["UbiCrawler distributed crawler", "https://onlinelibrary.wiley.com/doi/10.1002/spe.587"]
          ]
        }
      ],
      quizExtra: [
        {
          question: "Which requirement most directly determines how known URLs compete with new URLs?",
          choices: ["CSS color", "Freshness objective", "TLS cipher name", "Worker hostname"],
          answer: 1,
          explanation: "A freshness target gives the scheduler a reason and deadline for revisiting previously fetched resources."
        },
        {
          question: "A redirect changes authority. What should the crawler do?",
          choices: ["Trust the original checks", "Reapply scope, robots, DNS, address, and quota checks", "Skip URL parsing", "Copy the original IP forever"],
          answer: 1,
          explanation: "The redirect target is a new request target with its own authority and network destination."
        },
        {
          question: "Which queue policy keeps parser slowdown from exhausting fetcher memory?",
          choices: ["Unlimited buffering", "A bounded handoff with backpressure or intentional durable spill", "More redirects", "No response-size limit"],
          answer: 1,
          explanation: "A bounded boundary makes saturation explicit and preserves a fixed resource envelope."
        }
      ],
      lab: {
        id: "crawler-path-builder",
        title: "Size the crawler request path",
        kind: "capacity-model",
        badge: "Derived capacity model",
        intro: "Convert the page target into separate fetch, authority, network, parser, storage, slowdown, and recovery limits. Explain the first bottleneck or least certain assumption.",
        notebook: [
          "Write five requirements and attach one architecture consequence to each.",
          "Estimate average and peak fetch rate plus storage per day.",
          "For every queue, name its bound, retry owner, and durability."
        ]
      }
    },
    {
      id: "crawler-frontier",
      number: "08",
      track: "crawler-design",
      title: "Frontier correctness, politeness, and safety",
      shortTitle: "Crawler frontier",
      duration: 96,
      color: "#5b7d35",
      soft: "#edf3dc",
      description: "Schedule fairly by authority, apply the robots standard exactly, preserve URL identity, recover durable work, and contain hostile destinations.",
      outcomes: [
        "Design a partitioned per-authority scheduler with an independent shared-IP cap.",
        "Apply RFC 9309 behavior for successful, unavailable, and unreachable robots files.",
        "Explain URL normalization, Bloom-filter loss, durable leases, conditional fetches, and SSRF defenses."
      ],
      lessons: [
        {
          id: "crawler-polite-frontier",
          number: "22",
          title: "Schedule by authority, then constrain by address",
          duration: 24,
          summary: "A scalable frontier picks ready authorities rather than scanning URLs, while a second guard limits traffic to shared network destinations.",
          prediction: "Ten thousand hostnames resolve to one shared IP address. Is a one-request-per-host policy sufficient to protect that destination?",
          core: [
            "Maintain a queue of URLs per authority and a ready-time heap or timing structure over authorities. When an authority becomes eligible, lease bounded work, update its next eligible time, and return it to the scheduler.",
            "Partition authority ownership consistently so one scheduler coordinates its robots state, delay, concurrency, and failure backoff. A durable handoff or replicated state is required when ownership moves.",
            "Authority and destination address are different control keys. Many names can share an address, so enforce a second concurrency or rate cap over resolved IP prefixes or egress destinations.",
            "DNS answers expire and can change. Respect TTLs, re-resolve by policy, record the connected address, and avoid treating an old address as permanent identity."
          ],
          mechanics: [
            { title: "Per-authority queue", text: "Keeps URLs together with one robots policy and one next-eligible schedule." },
            { title: "Ready set", text: "Indexes authorities by the earliest legal dispatch time instead of repeatedly scanning blocked URLs." },
            { title: "Address guard", text: "Tracks concurrent work independently for shared IP destinations after validated resolution." },
            { title: "Lease", text: "Gives a worker temporary ownership so an expired task can return to the frontier after failure." }
          ],
          deep: [
            "Consistent hashing reduces moved authority state when scheduler membership changes, but it does not make in-flight leases or updates atomic. Define a generation or handoff protocol.",
            "Crawl-delay is not part of RFC 9309. If the product honors that common extension, label it as local policy, parse it separately, and define precedence rather than presenting it as a standard rule."
          ],
          bridge: { title: "Whiteboard shape", text: "Draw per-authority queues feeding a ready-time structure, then put the shared-IP gate after DNS and before connect." },
          failure: { title: "Host-only politeness", text: "Thousands of tenant hostnames on one service can pass independent host caps and overload their shared backend. The address guard covers that aggregation." },
          visual: {
            type: "scheduler",
            title: "Two-dimensional politeness",
            nodes: [
              ["Authority queues", "URL order"],
              ["Ready times", "host eligibility"],
              ["DNS", "current addresses"],
              ["IP guard", "shared cap"],
              ["Fetcher", "bounded lease"]
            ]
          },
          check: {
            question: "Why is an IP-level cap separate from an authority-level delay?",
            choices: ["URLs have no hosts", "Many authorities can resolve to one destination", "DNS removes queues", "Robots defines CPU limits"],
            answer: 1,
            explanation: "Independent authority policies do not bound their aggregate load on a shared address."
          },
          sources: [
            ["UbiCrawler distributed crawler", "https://onlinelibrary.wiley.com/doi/10.1002/spe.587"],
            ["BUbiNG crawler paper", "https://arxiv.org/abs/1601.06919"],
            ["DNS concepts and facilities", "https://www.rfc-editor.org/rfc/rfc1034.html"],
            ["DNS implementation and specification", "https://www.rfc-editor.org/rfc/rfc1035.html"]
          ]
        },
        {
          id: "crawler-robots",
          number: "23",
          title: "Apply RFC 9309 without folklore",
          duration: 24,
          summary: "The robots standard distinguishes an unavailable file from an unreachable service, and those states permit opposite crawl behavior.",
          prediction: "The robots request returns 404. Must a standards-conforming crawler treat the entire site as disallowed?",
          core: [
            "For a successful robots retrieval, parse the applicable user-agent group and obey the most specific matching allow or disallow rule. Path matching should be case-sensitive, and octets outside ASCII or reserved URI characters are percent-encoded for comparison.",
            "When robots returns a 400 through 499 status, RFC 9309 calls it unavailable and says the crawler may access any resources on that server.",
            "When robots returns a 500 through 599 status or the server is unreachable because of network or DNS errors, the crawler must assume complete disallow.",
            "A crawler should follow at least five consecutive redirects for robots, including cross-authority redirects, while applying the retrieved rules to the initial authority. Cached robots content generally should not be used for more than 24 hours unless the file is unreachable.",
            "Crawl-delay is not defined by RFC 9309. Treat support for it as an explicit product policy or extension."
          ],
          mechanics: [
            { title: "Available", text: "A successful fetch yields parseable groups and allow or disallow rules for the initial authority." },
            { title: "Unavailable", text: "A 4xx robots response permits crawling under RFC 9309, subject to the crawler's stricter local policy." },
            { title: "Unreachable", text: "A 5xx, DNS error, or network failure means complete disallow until policy permits another check." },
            { title: "Cache", text: "Store retrieval outcome, selected group, expiry, validators, and the policy version used to interpret it." }
          ],
          deep: [
            "If robots remains undefined for a long period, such as 30 days, the standard permits treating it as unavailable or using a cached copy. State the chosen operational policy and recovery schedule.",
            "A robots file is not an access-control system. It communicates crawler preferences publicly and does not authorize access to private content."
          ],
          bridge: { title: "Memorize the split", text: "Say it plainly in the interview: 4xx may crawl; 5xx, DNS, or network failure means complete disallow." },
          failure: { title: "Fail open on outage", text: "Treating a 503 or DNS failure like a missing robots file sends traffic to a site while it may already be unhealthy." },
          visual: {
            type: "decision",
            title: "Robots retrieval state",
            nodes: [
              ["2xx", "parse and obey"],
              ["Redirect", "follow at least 5"],
              ["4xx", "may crawl"],
              ["5xx", "complete disallow"],
              ["Network or DNS", "complete disallow"]
            ]
          },
          check: {
            question: "What does RFC 9309 require after a robots request fails with a network error?",
            choices: ["Crawl everything", "Assume complete disallow", "Ignore only images", "Honor Crawl-delay"],
            answer: 1,
            explanation: "A network or DNS failure makes the robots file unreachable, which requires complete disallow."
          },
          sources: [
            ["Robots Exclusion Protocol", "https://www.rfc-editor.org/rfc/rfc9309.html"],
            ["HTTP caching", "https://www.rfc-editor.org/rfc/rfc9111.html"],
            ["URI generic syntax", "https://www.rfc-editor.org/rfc/rfc3986.html"]
          ]
        },
        {
          id: "crawler-identity-durability",
          number: "24",
          title: "URL identity, lossy filters, and durable recrawls",
          duration: 24,
          summary: "Correct URL identity prevents accidental duplication, while explicit queue and cache semantics prevent silent loss during retries and recrawls.",
          prediction: "A Bloom filter reports that a never-seen URL is present. What happens if it is the only deduplication store?",
          core: [
            "Safe normalization can lowercase scheme and host, remove a default port, normalize percent-hex case, decode percent-encoded unreserved characters, and remove dot segments where the syntax permits it.",
            "Do not reorder query parameters, decode reserved characters, merge distinct paths, or apply application-specific equivalence without evidence. Fragments are not sent in an HTTP request and are normally removed from fetch identity, while preserving them may matter to a downstream product.",
            "A Bloom filter has false positives. If it is authoritative, an unseen URL can be discarded and coverage is lost. Use it as a memory-saving prefilter before an exact set when completeness matters, or state the accepted loss rate.",
            "Represent work as durable states such as discovered, leased, fetched, parsed, and committed. Use expiring leases, bounded retries, idempotent writes, poison-task handling, and checkpoints so a worker crash causes replay rather than disappearance.",
            "For recrawls, send validators such as If-None-Match or If-Modified-Since when available. A 304 response confirms the selected representation is unchanged without transferring its body."
          ],
          mechanics: [
            { title: "Canonical key", text: "A conservative normalized URL identifies scheduling and fetch history without inventing server equivalence." },
            { title: "Bloom prefilter", text: "Quickly rejects many known items but requires an exact second check when false-positive loss is unacceptable." },
            { title: "Expiring lease", text: "Makes ownership temporary so abandoned work becomes eligible after a worker dies." },
            { title: "Conditional fetch", text: "Reuses ETag or modification metadata to avoid downloading a representation that has not changed." }
          ],
          deep: [
            "At-least-once delivery shifts the correctness burden to stable keys and idempotent writes. It is usually simpler than coordinating exactly-once execution across frontier, fetch, parse, and storage.",
            "URL dedupe and content dedupe answer different questions. Two URLs can serve one body, and one URL can serve different bodies over time. Keep both identities."
          ],
          bridge: { title: "Trade-off statement", text: "For every approximation, say the false-positive effect. For every durable stage, say what replays and which write remains idempotent." },
          failure: { title: "Aggressive canonicalization", text: "Sorting a query string can merge requests whose servers interpret order or duplicate keys as meaningful, causing the crawler to skip distinct resources." },
          visual: {
            type: "state-machine",
            title: "Durable URL state",
            nodes: [
              ["Discovered", "normalized key"],
              ["Leased", "visibility deadline"],
              ["Fetched", "version and body"],
              ["Parsed", "links and metadata"],
              ["Committed", "recrawl schedule"]
            ]
          },
          check: {
            question: "When is a Bloom filter alone unsafe for URL deduplication?",
            choices: ["When false-positive loss would reduce required coverage", "When it uses bits", "When URLs have hosts", "When HTTP returns 200"],
            answer: 0,
            explanation: "A false positive can label unseen work as already seen, so an authoritative filter can silently omit pages."
          },
          sources: [
            ["URI normalization rules", "https://www.rfc-editor.org/rfc/rfc3986.html"],
            ["Bloom filter original paper", "https://dl.acm.org/doi/10.1145/362686.362692"],
            ["HTTP conditional requests", "https://www.rfc-editor.org/rfc/rfc9110.html"],
            ["Mercator crawler architecture", "https://research.google/pubs/mercator-a-scalable-extensible-web-crawler/"]
          ]
        },
        {
          id: "crawler-ssrf",
          number: "25",
          title: "Treat every destination as hostile",
          duration: 24,
          summary: "A crawler that accepts untrusted links is an SSRF-capable network client unless parsing, resolution, redirects, egress, and resource use are constrained together.",
          prediction: "A hostname passes validation while resolving to a public address, then resolves to 169.254.169.254 when the fetcher connects. Which class of attack is this?",
          core: [
            "Allow only intended schemes and ports, use one standards-based URL parser, reject embedded credentials, and reject ambiguous or malformed host representations before DNS.",
            "Resolve the hostname and validate every returned address against loopback, private, link-local, multicast, documentation, and cloud-metadata destinations according to policy. A hostname string check is insufficient.",
            "Prevent DNS rebinding by connecting to a validated address or by enforcing the same destination policy at an egress proxy or network boundary. Record the actual peer address and revalidate on each new resolution.",
            "Apply all checks again for every redirect. Cap redirects, total time, response headers, compressed and decompressed bytes, and extracted work. Remove credentials when authority changes.",
            "Run fetchers in a network segment that cannot reach metadata services, databases, control planes, or tenant-private ranges. Rendering needs an even narrower sandbox because page code executes."
          ],
          mechanics: [
            { title: "Parse", text: "Accept only HTTP or HTTPS URLs whose authority, port, and credentials satisfy one canonical parser's rules." },
            { title: "Resolve", text: "Inspect every address, not only the first answer, and retain the validated result for connection enforcement." },
            { title: "Connect", text: "Pin or enforce the allowed destination so DNS cannot change the target between validation and use." },
            { title: "Redirect", text: "Treat each hop as new untrusted input and restart scheme, address, scope, and credential checks." },
            { title: "Contain", text: "Use egress policy and workload isolation as a second boundary if application validation fails." }
          ],
          deep: [
            "IPv4-in-IPv6 forms, alternate numeric address syntax, user-info tricks, Unicode names, and parser disagreements can bypass ad hoc string checks. Parse once and compare structured values.",
            "The crawler can also be used for denial of service against itself. Slow responses, endless streams, compressed expansion, redirect loops, and parser bombs require independent budgets."
          ],
          bridge: { title: "Security walk", text: "Trace attacker-controlled URL to parser, DNS, address decision, socket peer, redirect, body limit, parser, and isolated network. Mark every trust boundary." },
          failure: { title: "Validate name, connect by name", text: "If validation and connection perform different DNS lookups, rebinding can replace an allowed public address with a forbidden internal one." },
          visual: {
            type: "security-gates",
            title: "Destination validation chain",
            nodes: [
              ["URL parser", "scheme and authority"],
              ["DNS", "all addresses"],
              ["Policy", "reject special ranges"],
              ["Egress", "enforce peer"],
              ["Redirect", "repeat checks"],
              ["Sandbox", "contain failure"]
            ]
          },
          check: {
            question: "What closes the DNS-rebinding gap most directly?",
            choices: ["Validate a hostname once", "Connect to the validated address or enforce destination policy at egress", "Follow more redirects", "Increase the body limit"],
            answer: 1,
            explanation: "The connected destination must remain the same destination that passed address policy."
          },
          sources: [
            ["OWASP SSRF prevention", "https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html"],
            ["URI security considerations", "https://www.rfc-editor.org/rfc/rfc3986.html#section-7"],
            ["Private IPv4 address space", "https://www.rfc-editor.org/rfc/rfc1918.html"],
            ["IPv6 address architecture", "https://www.rfc-editor.org/rfc/rfc4291.html"],
            ["HTTP redirection semantics", "https://www.rfc-editor.org/rfc/rfc9110.html#name-redirection-3xx"]
          ]
        }
      ],
      quizExtra: [
        {
          question: "Is Crawl-delay a directive standardized by RFC 9309?",
          choices: ["Yes", "No; it is an extension or local policy", "Only for 4xx", "Only for IPv6"],
          answer: 1,
          explanation: "RFC 9309 standardizes allow and disallow matching but does not define Crawl-delay."
        },
        {
          question: "A robots request returns 503. What is the standards-based crawler state?",
          choices: ["May crawl everything", "Complete disallow", "Ignore only HTML", "Use no rate limit"],
          answer: 1,
          explanation: "A 5xx response makes robots unreachable, which requires the crawler to assume complete disallow."
        },
        {
          question: "Why revalidate every redirect destination?",
          choices: ["Redirects cannot change hosts", "Each hop can target a new scheme, authority, or forbidden address", "It avoids all duplicate content", "It standardizes Crawl-delay"],
          answer: 1,
          explanation: "A safe initial URL can redirect to a destination outside scope or inside a protected network."
        }
      ],
      lab: {
        id: "crawler-frontier-console",
        title: "Operate a polite and hostile frontier",
        kind: "frontier-simulator",
        badge: "Frontier lab",
        intro: "Schedule skewed authorities, process exact robots outcomes, recover expired leases, and block rebinding and redirect attacks.",
        notebook: [
          "Explain why both authority and destination-address limits exist.",
          "Write the RFC 9309 behavior for 404, 503, and DNS failure.",
          "State which dedupe approximation can lose work and how you contain that loss."
        ]
      }
    },
    {
      id: "interview-rehearsals",
      number: "09",
      track: "coding",
      title: "Interview rehearsals and defense",
      shortTitle: "Rehearsals",
      duration: 90,
      color: "#7b4a72",
      soft: "#f2e6f0",
      description: "Practice all three rounds under time limits, with visible assumptions, measured trade-offs, and end-to-end failure explanations.",
      outcomes: [
        "Run a 75-minute coding session with checkpoints and a benchmark record.",
        "Defend a multi-replica gateway using requirements, numbers, invariants, and failure paths.",
        "Defend a crawler from seed scheduling through safety, durability, and recrawl."
      ],
      lessons: [
        {
          id: "rehearsal-coding",
          number: "26",
          title: "Rehearse the 75-minute coding round",
          duration: 30,
          summary: "A staged implementation produces a correct baseline early, then spends remaining time on measured routing improvements and cleanup.",
          prediction: "At minute 45, the baseline works and one routing experiment is faster but occasionally leaks tasks. Do you add another strategy or repair lifecycle correctness?",
          core: [
            "Use the supplied 75-minute duration. Spend 0 to 7 minutes on the contract, 7 to 22 on one provider, 22 to 37 on bounds and fallback, 37 to 52 on adaptation, 52 to 64 on a comparable benchmark, and 64 to 75 on tests and defense.",
            "Narrate assumptions and inspect generated code. AI assistance may accelerate scaffolding, but you own deadlines, cancellation, caps, resource release, and test evidence.",
            "Keep a running benchmark table with strategy, workload, sample size, concurrency, latency percentiles, success rate, attempt count, and one interpretation. Do not report a faster mean while hiding errors or overload.",
            "Prefer a clear selector interface, provider adapter, bounded executor, health update, and test seam over a large framework. Interview code should be easy to review and extend."
          ],
          mechanics: [
            { title: "0 to 7", text: "Clarify request semantics, inspect the runner, choose metrics, and sketch the interfaces." },
            { title: "7 to 22", text: "Implement one-provider correctness, the absolute deadline, and a deterministic success test." },
            { title: "22 to 37", text: "Add application and provider bounds, fallback, cancellation, and cleanup assertions." },
            { title: "37 to 52", text: "Add one adaptive rule with a recovery path while preserving the simple policy." },
            { title: "52 to 64", text: "Compare the baseline and candidate under the same scripted provider behavior." },
            { title: "64 to 75", text: "Repair lifecycle gaps, simplify ownership, rerun tests, and defend the evidence." }
          ],
          deep: [
            "If the runner behavior differs from an assumption, preserve the observed contract in the notebook before changing code. That prevents an optimization from solving the wrong workload.",
            "A deterministic fake provider with controllable latency and outcomes is more useful than sleeps scattered across tests. It makes selection and cleanup behavior reviewable."
          ],
          bridge: { title: "Decision rule", text: "Once the code can leak work or exceed a cap, stop adding policy. Repair the invariant, rerun the benchmark, and explain the choice." },
          failure: { title: "Benchmark theater", text: "A table without workload, samples, concurrency, or error rate cannot support a routing conclusion and may reward an unsafe strategy." },
          visual: {
            type: "timeline",
            title: "Seventy-five minute coding plan",
            nodes: [
              ["0-7", "contract"],
              ["7-22", "one provider"],
              ["22-37", "bounds and fallback"],
              ["37-52", "adaptation"],
              ["52-64", "benchmark"],
              ["64-75", "tests and defense"]
            ]
          },
          check: {
            question: "What should happen before adding a second routing optimization?",
            choices: ["Delete the benchmark", "Prove the first version respects cleanup, caps, and correctness", "Remove deadlines", "Increase task leaks"],
            answer: 1,
            explanation: "A faster policy is not progress if it violates concurrency or leaves work running after the request ends."
          },
          sources: [
            ["Google Benchmark tools", "https://github.com/google/benchmark"],
            ["Google SRE testing for reliability", "https://sre.google/sre-book/testing-reliability/"],
            ["HTTP semantics", "https://www.rfc-editor.org/rfc/rfc9110.html"]
          ]
        },
        {
          id: "rehearsal-gateway-design",
          number: "27",
          title: "Defend the production gateway design",
          duration: 30,
          summary: "A production answer should connect requirements and estimates to request flow, shared controls, telemetry, overload behavior, and recovery.",
          prediction: "An interviewer asks, 'What changes when you go from one process to fifty replicas?' Which three coordination problems should you name first?",
          core: [
            "Clarify traffic, streaming, tenant isolation, latency and availability objectives, provider quotas, regions, durability, and cost. Estimate requests per second, concurrent requests, bytes, attempts, and telemetry volume.",
            "Walk one request through edge admission, authentication, tenant quota, local queue, provider selection, provider limiter, transport, response commit, attempt events, and client outcome.",
            "Separate fast local signals from slower shared state. Global quotas and configuration need coordination; per-request selection should keep working when that coordination path is stale or unavailable.",
            "Explain log writes as a bounded side pipeline, then cover metric label limits, trace sampling, event durability, redaction, and collector failure. Finish with provider outage, quota outage, regional loss, and recovery stampede drills."
          ],
          mechanics: [
            { title: "Requirements", text: "State goals and non-goals before naming products." },
            { title: "Numbers", text: "Use Little's Law for concurrency and estimate attempts and telemetry from request rate." },
            { title: "Path", text: "Narrate ownership and deadlines for one logical request and its physical attempts." },
            { title: "Failure", text: "For each dependency, state detection, degraded behavior, resource bound, and recovery." },
            { title: "Trade-off", text: "Compare local speed against global coordination, and reliability against duplicate cost." }
          ],
          deep: [
            "The strongest follow-up answers preserve invariants when a component is removed. If the health store, quota service, collector, or one zone fails, describe what the request path still knows and what it refuses to do.",
            "Use the coding prototype as evidence. Point to which interface becomes a service boundary, which state remains local, and which benchmark exposed the next bottleneck."
          ],
          bridge: { title: "Answer spine", text: "Requirements, estimates, request path, state ownership, overload, observability, failure walk, and trade-offs form a repeatable sequence." },
          failure: { title: "Diagram without behavior", text: "Boxes and arrows do not explain whether a request queues, fails over, sheds load, logs durably, or recovers after stale state." },
          visual: {
            type: "whiteboard",
            title: "Gateway design defense",
            nodes: [
              ["Requirements", "SLO and quotas"],
              ["Math", "RPS and concurrency"],
              ["Request path", "attempt ownership"],
              ["Shared state", "quota and policy"],
              ["Failure walk", "degrade and recover"]
            ]
          },
          check: {
            question: "What is the best first response when asked to scale the prototype to many replicas?",
            choices: ["Name a database", "Clarify scale and identify state that now needs coordination", "Make every queue unlimited", "Delete local health"],
            answer: 1,
            explanation: "Replica count matters because health, quotas, policy, and logs now cross process boundaries under stated traffic."
          },
          sources: [
            ["Google SRE cascading failures", "https://sre.google/sre-book/addressing-cascading-failures/"],
            ["OpenTelemetry logs data model", "https://opentelemetry.io/docs/specs/otel/logs/data-model/"],
            ["Envoy load balancing", "https://www.envoyproxy.io/docs/envoy/latest/intro/arch_overview/upstream/load_balancing/load_balancing"],
            ["Prometheus instrumentation practices", "https://prometheus.io/docs/practices/instrumentation/"]
          ]
        },
        {
          id: "rehearsal-crawler-design",
          number: "28",
          title: "Defend the crawler from seed to recrawl",
          duration: 30,
          summary: "A crawler answer is strongest when politeness, durability, identity, and security remain visible in the main request path rather than appearing as afterthoughts.",
          prediction: "You have drawn fetchers, parsers, and object storage. Which missing component controls both coverage order and site safety?",
          core: [
            "Open with scope, scale, freshness, rendering, retention, politeness, and safety. Estimate fetch rate and storage, while noting that per-authority readiness constrains usable global concurrency.",
            "Trace seed to conservative URL identity, scope, robots, per-authority frontier, DNS and shared-IP gate, fetch limits, body storage, parsing, durable discovery, dedupe, and recrawl.",
            "Explain exact robots outcomes, Bloom false positives, lease recovery, idempotent writes, conditional requests, redirect checks, DNS rebinding protection, and isolated egress when prompted.",
            "Use failure walks: frontier owner dies with leases, parser crashes before discovery commit, robots is unreachable, storage slows, one authority produces most URLs, or a link targets metadata service."
          ],
          mechanics: [
            { title: "Frontier", text: "Owns priority, authority readiness, leases, revisit time, and durable admission." },
            { title: "Politeness", text: "Combines robots, per-authority timing, and an independent shared-destination cap." },
            { title: "Identity", text: "Uses conservative URL normalization plus separate content versions and exact dedupe where coverage requires it." },
            { title: "Safety", text: "Revalidates schemes, addresses, redirects, bytes, parsers, and egress on every request path." },
            { title: "Recovery", text: "Replays expired leases into idempotent storage and keeps discovered work durable before acknowledgment." }
          ],
          deep: [
            "When challenged on scale, partition frontier ownership by authority so policy state remains coherent, then explain handoff, hot-authority limits, and shared-IP aggregation.",
            "When challenged on freshness, keep prior validators and schedule recrawls from change rate, importance, and freshness objective rather than treating every URL equally."
          ],
          bridge: { title: "Answer spine", text: "Requirements, arithmetic, URL lifecycle, frontier ownership, politeness, durability, safety, and failure walks keep the design easy to follow." },
          failure: { title: "Security appendix", text: "If SSRF controls appear only at the end, the earlier fetch path may already trust redirects, DNS, or connected addresses incorrectly." },
          visual: {
            type: "whiteboard",
            title: "Crawler design defense",
            nodes: [
              ["Seeds", "scope and identity"],
              ["Frontier", "priority and politeness"],
              ["Fetch", "DNS and limits"],
              ["Parse", "bounded discovery"],
              ["Store", "versions and edges"],
              ["Recrawl", "freshness and validators"]
            ]
          },
          check: {
            question: "Which detail should remain on the main crawler path, not in a late security appendix?",
            choices: ["Font choice", "Destination validation after DNS and on redirects", "Interviewer seating", "Metric color"],
            answer: 1,
            explanation: "The fetch target is untrusted, so destination policy is part of normal request execution."
          },
          sources: [
            ["Robots Exclusion Protocol", "https://www.rfc-editor.org/rfc/rfc9309.html"],
            ["Mercator crawler architecture", "https://research.google/pubs/mercator-a-scalable-extensible-web-crawler/"],
            ["BUbiNG crawler paper", "https://arxiv.org/abs/1601.06919"],
            ["OWASP SSRF prevention", "https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html"]
          ]
        }
      ],
      quizExtra: [
        {
          question: "What should precede a system-design component list?",
          choices: ["A product logo", "Requirements, assumptions, and capacity estimates", "A retry storm", "An unlimited queue"],
          answer: 1,
          explanation: "Components can only be judged against a stated workload, objective, and constraint."
        },
        {
          question: "Which failure explanation is complete enough to defend?",
          choices: ["The service is highly available", "Detection, degraded request behavior, resource bound, and recovery", "Add replicas", "Use a queue"],
          answer: 1,
          explanation: "A useful failure walk shows what the system does during the fault and how it returns safely."
        },
        {
          question: "How should an unstated interview number be presented?",
          choices: ["As a Decagon fact", "As an explicit assumption used for arithmetic", "As a hidden constant", "As an RFC requirement"],
          answer: 1,
          explanation: "Labeling the assumption lets the interviewer correct it and makes the resulting design math auditable."
        }
      ],
      lab: {
        id: "decagon-mock-hub",
        title: "Run the three Decagon rehearsals",
        kind: "mock-hub",
        badge: "Timed mocks",
        intro: "Choose a round, run its timer, reveal follow-ups in order, and score the artifact against a concrete rubric.",
        notebook: [
          "Record every assumption before using it in code or arithmetic.",
          "For each design, practice one healthy request and two failure paths.",
          "End with measured evidence, known limits, and the next change you would make."
        ]
      }
    }
  ],
  mocks: [
    {
      id: "ai-gateway-coding",
      track: "coding",
      title: "AI model gateway coding mock",
      minutes: 75,
      prompt: "Interview assumption from the supplied notes: one model is served by two interchangeable providers whose latency and failure rates change. Expose a gateway endpoint, forward requests quickly and reliably, track provider outcomes, adapt routing without freezing on today's winner, cap concurrency, and keep a benchmark record.",
      followups: [
        "Provider A is faster at startup, then begins returning 5xx responses. Show how the next requests react.",
        "Provider A recovers. Show how it receives bounded exploration traffic instead of remaining excluded forever.",
        "Run more client requests than either provider cap can admit. Prove queueing and in-flight work stay bounded.",
        "A request deadline expires while two attempts exist. Prove cancellation and permit release for both attempts.",
        "Compare at least two strategies with sample count, concurrency, latency percentiles, success rate, and attempt cost."
      ],
      rubric: [
        { label: "Contract and correctness", detail: "Validates inputs, preserves response semantics, maps errors deliberately, and handles deadlines and cancellation.", max: 20 },
        { label: "Structure and tests", detail: "Separates provider transport, selection, execution, and health state with deterministic test seams.", max: 20 },
        { label: "Concurrency safety", detail: "Enforces application and provider caps, bounds queues, releases permits, and leaves no losing work behind.", max: 20 },
        { label: "Adaptive behavior", detail: "Uses outcome and latency evidence, fails over, probes recovery, and avoids permanent winner selection.", max: 20 },
        { label: "Measurement and communication", detail: "Maintains an interpretable benchmark notebook and explains trade-offs, limits, and next steps.", max: 20 }
      ],
      artifact: "A working gateway, focused tests, and a benchmark notebook with at least two comparable strategy rows."
    },
    {
      id: "gateway-production-design",
      track: "gateway-design",
      title: "Production gateway system-design mock",
      minutes: 60,
      prompt: "Practice assumption: use 60 minutes because the supplied notes do not state this round's duration. Scale the coding prototype across multiple application servers while coordinating health and quotas, handling log writes and observability pipelines, and preserving low latency and high reliability when dependencies fail.",
      followups: [
        "Traffic grows to many replicas in three zones. Which health state stays local, and which state is shared?",
        "A provider has one account-wide concurrency quota. Show admission under stale or partitioned quota coordination.",
        "The log collector slows for ten minutes. Keep the request path and process memory bounded while stating the loss or durability policy.",
        "One provider becomes slow without returning errors. Show detection, traffic shift, probe recovery, and protection against synchronized recovery.",
        "Estimate request concurrency, provider attempts, metric volume, and log bytes from your chosen traffic assumptions."
      ],
      rubric: [
        { label: "Requirements and estimates", detail: "Clarifies traffic, streaming, tenancy, quotas, objectives, regions, cost, and derives useful capacity numbers.", max: 20 },
        { label: "Request and attempt path", detail: "Explains deadlines, admission, selection, transport, response commit, fallback, and logical versus physical outcomes.", max: 20 },
        { label: "State and quota ownership", detail: "Balances fast local health with shared coordination and defines behavior during stale state or partitions.", max: 20 },
        { label: "Telemetry and data safety", detail: "Bounds log pipelines, controls metric labels, connects traces and logs, and states redaction and durability rules.", max: 20 },
        { label: "Failure and recovery", detail: "Walks provider, quota, collector, zone, and overload faults through detection, degraded state, bounds, and recovery.", max: 20 }
      ],
      artifact: "A whiteboard architecture with capacity math, state ownership, one normal request trace, and two end-to-end failure walks."
    },
    {
      id: "web-crawler-design",
      track: "crawler-design",
      title: "Web-crawling infrastructure mock",
      minutes: 60,
      prompt: "Practice assumption: use 60 minutes because the supplied notes do not state this round's duration. Design infrastructure that crawls from seeds at an explicitly assumed scale, respects site policy and shared destinations, stores useful documents and link discoveries durably, revisits content, and treats every fetched URL as hostile input.",
      followups: [
        "robots.txt returns 404 for one site, 503 for another, and DNS fails for a third. State the exact behavior for each.",
        "Millions of tenant hostnames share one IP. Preserve throughput without overloading that destination.",
        "The dedupe layer uses a Bloom filter. Explain its false-positive consequence and the design if coverage cannot lose URLs.",
        "A frontier owner dies after leasing work, and a parser dies after finding links. Show what replays and what was made durable.",
        "A public hostname redirects to a cloud metadata address after DNS changes. Stop the request and show defense beyond application parsing."
      ],
      rubric: [
        { label: "Requirements and arithmetic", detail: "Clarifies scope, freshness, rendering, retention, politeness, safety, and computes fetch and storage estimates.", max: 20 },
        { label: "URL lifecycle", detail: "Traces conservative identity, frontier admission, fetching, body storage, parsing, discovery, and recrawl with clear owners.", max: 20 },
        { label: "Frontier and politeness", detail: "Coordinates per-authority ready times, exact robots behavior, shared-IP caps, DNS changes, and hot authorities.", max: 20 },
        { label: "Durability and identity", detail: "Explains leases, replay, idempotent writes, exact versus approximate dedupe, versioned content, and conditional requests.", max: 20 },
        { label: "Security and failure recovery", detail: "Rechecks redirects and resolved addresses, prevents rebinding, bounds resource use, isolates egress, and walks worker and storage faults.", max: 20 }
      ],
      artifact: "A whiteboard crawler with scale math, one URL state machine, exact robots decisions, and security and durability failure paths."
    }
  ]
};
