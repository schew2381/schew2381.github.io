(() => {
  "use strict";

  const entries = {
    "gateway-contract": {
      contextTitle: "One public request can create several provider attempts",
      context: [
        "Provider A and Provider B both claim they can answer the same prompt for the same model. Before the gateway can move a request between them, it must prove that request options, response fields, and failure behavior mean the same thing through both adapters.",
        "The client still made one request, even if the gateway calls two providers. Give that logical request one ID and one deadline, then give each provider call its own attempt ID so cancellation, cost, and health evidence stay attributable without inflating request counts.",
        "Replacement is possible only until the gateway commits output to the client. A buffered response can be discarded before any bytes leave, but a streamed response cannot switch providers after its first delivered chunk without repeating or splicing output."
      ],
      walkthrough: {
        title: "Trace one request before choosing a routing policy",
        intro: "Use the same request throughout the coding lane: A normally finishes in 60 ms but fails 20% of attempts, B normally finishes in 120 ms but fails 1%, and the client allows 500 ms total.",
        steps: [
          { title: "Validate once", text: "The handler checks authentication, model access, payload size, sampling options, and the public response mode before provider health or quota is consumed." },
          { title: "Normalize the contract", text: "The gateway turns the public request into one internal form whose model revision, token limits, tools, structured-output rules, and streaming choice have explicit meanings." },
          { title: "Create identities", text: "Request r17 owns the caller deadline, while attempt r17-a1 and any later attempt carry separate provider, timing, and outcome records." },
          { title: "Select A", text: "The router reads an immutable provider snapshot and chooses A without performing network I/O or mutating health state." },
          { title: "Classify the result", text: "If A returns 503 before any response bytes are committed, the executor records a provider failure and checks the time and capacity that remain." },
          { title: "Try B within the same contract", text: "The B adapter receives the same normalized meaning, a new attempt ID, and only the portion of the original 500 ms deadline that remains." },
          { title: "Commit one response", text: "The handler returns B's accepted response under request r17, cancels work that can no longer win, and releases every request and attempt permit exactly once." }
        ],
        takeaway: "Routing is safe only after the gateway defines equivalence, identity, deadline ownership, and the response commit point."
      },
      workedExample: {
        title: "Decide whether a fallback is invisible to the client",
        setup: "A buffered JSON request reaches A first, A returns 503 at 72 ms, and B can begin at 75 ms under the same logical request.",
        facts: [
          { label: "Client deadline", value: "500 ms" },
          { label: "A outcome", value: "503 at 72 ms" },
          { label: "B service time", value: "120 ms" },
          { label: "Output committed", value: "No" },
          { label: "Logical request", value: "r17" }
        ],
        steps: [
          "At 72 ms the gateway has spent part of the caller budget but has not changed the client-visible response.",
          "The executor records r17-a1 as a provider failure and computes 428 ms remaining before subtracting its cleanup reserve.",
          "Attempt r17-b1 starts at 75 ms and completes at 195 ms with the same normalized response contract.",
          "The gateway returns one response for r17 and reports two provider attempts for cost and health accounting."
        ],
        result: "The fallback is valid because it finishes before the original deadline and occurs before the response commit point; the same switch would be invalid after a streamed chunk reached the client."
      },
      explanations: [
        {
          title: "Interchangeability is a versioned contract",
          paragraphs: [
            "Two endpoints can advertise the same model name and still behave differently. A revision, sampling default, safety filter, tool-call format, token limit, or structured-output feature can change the public result.",
            "Treat those capabilities as a versioned contract and test both adapters against shared fixtures. A provider change then fails before latency-based routing sends real traffic across an incompatible boundary."
          ]
        },
        {
          title: "Duplicate work still has a cost",
          paragraphs: [
            "A retry or hedge may produce no external side effect, yet it still consumes tokens, quota, and money. Set an attempt limit and a duplicate-cost policy even though the client receives only one answer.",
            "An idempotency key helps only under the provider's documented scope and retention rules. It does not make an arbitrary streamed response safe to replace after output has begun."
          ]
        },
        {
          title: "Classify the layer that failed",
          paragraphs: [
            "An invalid caller payload fails before a provider can prove anything about its health. A transport reset, provider 5xx, malformed provider response, or timeout does describe the selected provider path and should update the corresponding evidence.",
            "Authentication and model-not-found responses point to another boundary: the gateway's configuration may have drifted. Preserve that class instead of turning every non-200 response into the same provider failure."
          ]
        }
      ],
      decisionTable: {
        title: "When another provider may take over",
        columns: ["Observed condition", "May try another provider?", "Reason"],
        rows: [
          ["Invalid public request", "No", "Reject before routing because the caller contract is invalid"],
          ["Transport failure before commit", "Yes, within budget", "No client-visible output exists yet"],
          ["Provider 503 before commit", "Yes, within budget", "The failure is eligible for cross-provider fallback"],
          ["First streamed chunk delivered", "Usually no", "A replacement can duplicate or splice the stream"],
          ["Caller cancelled", "No", "No result remains useful and the cancellation is neutral health evidence"],
          ["Both adapters lack the requested feature", "No", "The providers are not interchangeable for this request"]
        ]
      },
      diagram: {
        type: "branch",
        title: "One normalized request, two eligible adapters",
        caption: "Both branches preserve the same public meaning, while attempt identity and provider evidence remain separate.",
        source: "Logical request r17",
        branches: [
          { label: "Attempt r17-a1", note: "Provider A, fast path, 503 before commit" },
          { label: "Attempt r17-b1", note: "Provider B, fallback, accepted response" }
        ],
        destination: "One client response"
      },
      interview: {
        prompt: "Two providers claim to serve the same model. Define the contract that lets your gateway retry or hedge a request across them without corrupting the client response.",
        answerPoints: [
          "Confirm that model revision, request options, output schema, token limits, tools, safety behavior, and streaming semantics are compatible.",
          "Use one logical request ID and deadline, plus one attempt ID for each provider call.",
          "Validate caller errors before routing so they do not consume health or provider capacity.",
          "Define the response commit point and stop invisible failover after output reaches the client.",
          "Track duplicate attempts for quota, cost, cancellation, and observability even when one response wins.",
          "Test every adapter against shared request and response fixtures."
        ],
        followups: [
          "What changes when the response is streamed token by token?",
          "How do you classify a 401, 429, malformed JSON body, and caller cancellation?",
          "Does an idempotency key prevent duplicate provider billing?",
          "Which identifier appears on the logical request span and which appears on each attempt span?"
        ]
      }
    },

    "latency-budget": {
      contextTitle: "Every wait spends the same 500 ms",
      context: [
        "A request arrives with 500 ms to produce a complete client response. Queueing, provider acquisition, connection setup, upload, response transfer, fallback, and cleanup all consume that same clock; none receives a fresh 500 ms allowance.",
        "Before any blocking operation, compute `remaining = deadline - monotonicNow` and retain a small response reserve. Otherwise, two provider timeouts placed after a queue wait can stretch a 500 ms client contract into several seconds.",
        "Deadline ownership also requires cancellation. When the caller leaves or one attempt wins, queued and active work must stop, all permits must return, and the intentional cancellation must remain neutral provider evidence."
      ],
      walkthrough: {
        title: "Spend the deadline on one clock",
        intro: "Request r18 arrives with 500 ms remaining, waits behind active work, tries A, then decides whether B still has enough time to help.",
        steps: [
          { title: "Create one absolute deadline", text: "At admission, the handler records deadline = monotonicNow + 500 ms and reserves 20 ms for final cleanup and the client response." },
          { title: "Wait in the bounded queue", text: "The request waits 80 ms for an application slot, leaving 420 ms before the absolute deadline and 400 ms before the response reserve." },
          { title: "Start A with remaining time", text: "A receives a child cancellation signal bounded by the original deadline rather than a new 500 ms timer." },
          { title: "Observe failure at 210 ms", text: "A returns 503 after 130 ms of service, which leaves 290 ms to the deadline and 270 ms of usable provider time." },
          { title: "Check B before launching", text: "B's expected 120 ms service time and current capacity fit inside the remaining usable budget, so the executor may start one fallback." },
          { title: "Finish and release", text: "B succeeds at 335 ms, the gateway records both attempts, releases all permits, and returns before the 480 ms working cutoff." }
        ],
        takeaway: "A fallback is justified by the time that remains now, not by the timeout that existed when the request arrived."
      },
      workedExample: {
        title: "Compute the fallback budget",
        setup: "The request has a 500 ms deadline, the queue spends 80 ms, A spends 130 ms before failing, and the gateway keeps 20 ms for cleanup.",
        facts: [
          { label: "Original deadline", value: "500 ms" },
          { label: "Queue time", value: "80 ms" },
          { label: "A time", value: "130 ms" },
          { label: "Cleanup reserve", value: "20 ms" },
          { label: "B expected time", value: "120 ms" }
        ],
        steps: [
          "Elapsed before fallback is 80 ms + 130 ms = 210 ms.",
          "Raw time remaining is 500 ms - 210 ms = 290 ms.",
          "Usable fallback time is 290 ms - 20 ms cleanup reserve = 270 ms.",
          "B's 120 ms expected service fits, but its attempt must still inherit the absolute deadline so a tail cannot exceed the caller contract."
        ],
        result: "B may start with at most 270 ms of working time; a fresh 500 ms B timeout would violate the request contract."
      },
      explanations: [
        {
          title: "Use a monotonic clock for elapsed time",
          paragraphs: [
            "Wall time can move forward or backward when the system clock is corrected. A monotonic clock preserves the order and duration of queue waits, cooldowns, hedge delays, and timeouts.",
            "Carry one absolute monotonic deadline through the request context or cancellation primitive. Inject that clock in tests so each case advances time deliberately instead of sleeping."
          ]
        },
        {
          title: "Measure the phase that owns the delay",
          paragraphs: [
            "End-to-end latency says that the client waited, but not where. Record admission wait, provider-capacity wait, connection setup, time to headers or first token, and time to complete response as separate durations.",
            "Those phases lead to different fixes. A queue-driven p99 calls for admission changes, while a high first-token delay without queueing points toward provider selection or upstream behavior."
          ]
        },
        {
          title: "Returning is not the same as stopping",
          paragraphs: [
            "A timeout handler can send an error while the upstream call keeps running. That abandoned work still consumes sockets, provider quota, memory, and limiter permits.",
            "Propagate cancellation into the transport and make permit release idempotent. Success, error, timeout, caller exit, and hedge loss should all converge on one cleanup path."
          ]
        }
      ],
      decisionTable: {
        title: "Budget checks before each wait",
        columns: ["Boundary", "Budget check", "If the check fails"],
        rows: [
          ["Admission queue", "Can the request wait before deadline minus reserve?", "Reject as overloaded or deadline-exceeded"],
          ["Provider limiter", "Can an eligible slot appear within remaining time?", "Try another eligible provider or fail"],
          ["Primary attempt", "Bound transport by the absolute deadline", "Cancel and classify the observed outcome"],
          ["Fallback", "Does useful time remain after prior work?", "Do not launch an attempt that cannot help"],
          ["Delayed hedge", "Will the delay and second attempt fit under the same deadline?", "Keep the primary only"],
          ["Response cleanup", "Reserve time to cancel, release, and encode the result", "Use a smaller working deadline"]
        ]
      },
      diagram: {
        type: "timeline",
        title: "The 500 ms budget only moves in one direction",
        caption: "Every event is placed on the caller clock, including queueing and cleanup that provider-only metrics omit.",
        events: [
          { label: "t=0", note: "Admit r18 with 500 ms remaining" },
          { label: "t=80", note: "Leave the application queue with 420 ms remaining" },
          { label: "t=210", note: "A returns 503 with 290 ms remaining" },
          { label: "t=215", note: "B starts under the same absolute deadline" },
          { label: "t=335", note: "B succeeds and cleanup begins" },
          { label: "t=355", note: "Response completes before the 500 ms deadline" }
        ]
      },
      interview: {
        prompt: "A client gives your gateway 500 ms, but the request may queue and fall back from A to B. Explain how each timeout and cancellation signal is derived.",
        answerPoints: [
          "Record one absolute deadline from a monotonic clock at the gateway boundary.",
          "Charge queueing, limiter waits, provider calls, response transfer, and cleanup to that same deadline.",
          "Compute every attempt timeout from the time that remains instead of resetting the original duration.",
          "Reserve a small amount of time for cleanup and the final client response.",
          "Propagate caller cancellation and winner cancellation into queued and active transport work.",
          "Release each application and provider permit once on every terminal path.",
          "Measure queue, first-token, and complete-response phases separately."
        ],
        followups: [
          "What happens if B cannot obtain capacity until 490 ms?",
          "How do you test a 500 ms deadline without a 500 ms sleep?",
          "Does returning a timeout prove that the provider call stopped?",
          "Which latency metric matters for a streamed model response?"
        ]
      }
    },

    "baseline-code-shape": {
      contextTitle: "A replaceable baseline keeps policy out of transport",
      context: [
        "Start with one request that can complete correctly before adding adaptive routing. The path validates input, acquires bounded application capacity, selects an eligible provider, calls a reusable client under the caller deadline, classifies the result, updates health, and returns one response.",
        "The moving part in the next experiment is provider selection, not transport or cleanup. Separate Handler, AdmissionLimiter, Router, ProviderClient, and Tracker ownership so the router can change without rewriting HTTP translation, cancellation, or permit release.",
        "Selection should read an immutable state snapshot and return a provider ID before network I/O begins. Completion records one classified observation afterward, which avoids holding a health lock across a network wait and makes event order controllable in tests."
      ],
      walkthrough: {
        title: "Build the first path that can survive policy changes",
        intro: "Use round robin or a fixed primary for the first benchmark, then preserve every interface while the router becomes adaptive later.",
        steps: [
          { title: "Handler owns the client contract", text: "Parse and validate once, create request context with its absolute deadline, and map the final internal result to the public response." },
          { title: "Admission limiter owns accepted work", text: "Acquire or queue within explicit bounds before provider selection, then return one release handle owned by the logical request." },
          { title: "Router reads a snapshot", text: "Choose from compatible, available provider state without calling the network, sleeping, or updating observations." },
          { title: "Provider client owns translation and I/O", text: "Reuse the underlying HTTP transport, apply credentials, translate the normalized request, and honor cancellation and remaining time." },
          { title: "Tracker owns observations", text: "Classify the completed attempt, update a new immutable health snapshot, and preserve neutral cancellation separately from success or failure." },
          { title: "Executor owns attempt lifecycle", text: "Create attempt IDs, acquire provider permits, choose retry or hedge boundaries, select the winner, and release every resource once." },
          { title: "Benchmark owns policy claims", text: "Run the simple path under a fixed provider schedule before changing selection so later latency and reliability claims have a reference row." }
        ],
        takeaway: "The baseline becomes useful when policy, transport, state updates, and lifecycle cleanup can change independently and remain testable."
      },
      workedExample: {
        title: "Trace ownership through one A failure and B success",
        setup: "Request r19 enters the baseline while both providers are eligible and the router selects A first.",
        facts: [
          { label: "Deadline", value: "500 ms absolute" },
          { label: "Baseline policy", value: "Round robin" },
          { label: "A result", value: "503 at 70 ms" },
          { label: "B result", value: "200 at 195 ms" },
          { label: "Response mode", value: "Buffered JSON" }
        ],
        steps: [
          "Handler validates r19 and hands normalized input plus request context to the executor.",
          "AdmissionLimiter gives r19 one logical-request permit, while Router returns provider A from its current snapshot.",
          "Executor acquires an A permit and ProviderClient A returns a classified 503 result without writing the client response.",
          "Tracker records A failure, Executor releases the A permit, then Router or fallback policy selects B using the time that remains.",
          "ProviderClient B succeeds, Tracker records B success, and Executor releases the B and logical-request permits before Handler responds."
        ],
        result: "Every state change has one owner, so replacing round robin with adaptive selection does not alter provider translation or cleanup."
      },
      explanations: [
        {
          title: "Inject time and provider behavior",
          paragraphs: [
            "Real endpoints and elapsed sleeps make failure tests slow and nondeterministic. A clock interface plus scripted provider clients lets the test choose latency, status, response body, cancellation, and completion order.",
            "Use the same ProviderClient interface for the script and the production adapter. The test then exercises the real executor rather than a simplified path written only for testing."
          ]
        },
        {
          title: "Reuse the transport",
          paragraphs: [
            "Creating an HTTP client for every request throws away connection reuse and repeats handshakes. Under load, it can also exhaust sockets; keep one long-lived client for each provider configuration instead.",
            "That client owns transport pooling, not the entire concurrency policy. Multiplexed protocols can carry many requests on one connection, so the application and each provider still need explicit request limits."
          ]
        },
        {
          title: "Publish snapshots instead of sharing mutable fields",
          paragraphs: [
            "A selector that reads fields while the tracker mutates them can observe an impossible combination of old and new state. Build a complete provider-state value, then publish it atomically so latency, failure, cooldown, and capacity describe one snapshot.",
            "The mechanism depends on the language, but the ownership rule stays the same. Go can use an atomic pointer or short mutex, Python can replace an immutable value under an async-safe owner, and TypeScript can replace a plain object within one event-loop turn."
          ]
        }
      ],
      decisionTable: {
        title: "Code boundaries for the baseline",
        columns: ["Component", "Input", "Output", "Must not own"],
        rows: [
          ["Handler", "Public request and client context", "Public response", "Provider scoring"],
          ["AdmissionLimiter", "Request context and capacity class", "Permit or overload result", "HTTP translation"],
          ["Router", "Request requirements and provider snapshot", "Provider ID or no eligible provider", "Network I/O"],
          ["ProviderClient", "Normalized request and attempt context", "Raw attempt result", "Fleet routing policy"],
          ["Tracker", "Classified attempt observation", "New health snapshot", "Client response writing"],
          ["Executor", "Logical request and dependencies", "Winning result or final error", "Public schema validation"]
        ]
      },
      diagram: {
        type: "swimlane",
        title: "Request flow and state ownership stay separate",
        caption: "The executor coordinates the lanes, but each lane keeps one reason to change.",
        lanes: [
          { label: "Client contract", items: ["Handler validates", "Handler owns the commit point", "Handler writes one result"] },
          { label: "Execution", items: ["AdmissionLimiter bounds work", "Router selects", "Executor owns attempts", "ProviderClient performs I/O"] },
          { label: "Evidence", items: ["Tracker classifies completion", "Tracker publishes snapshot", "Benchmark records policy result"] }
        ]
      },
      interview: {
        prompt: "Sketch the first correct version of the gateway so an interviewer can review it and you can replace its routing strategy without rewriting transport code.",
        answerPoints: [
          "Use a handler for the public contract and one executor for logical request lifecycle.",
          "Put bounded application admission before provider work.",
          "Make the router a pure selection over an immutable provider snapshot.",
          "Keep provider authentication, translation, connection reuse, timeout, and cancellation in provider clients.",
          "Record classified outcomes through a tracker after attempts complete.",
          "Inject provider clients and a monotonic clock for deterministic tests.",
          "Benchmark a simple fixed or round-robin policy before adding adaptive state."
        ],
        followups: [
          "Where is the provider semaphore acquired and released?",
          "How does the router avoid holding a lock across an await?",
          "Which component knows that a streamed response has committed?",
          "How would you add a third provider without changing the handler?"
        ]
      }
    },

    "health-evidence": {
      contextTitle: "Health is a classified, scoped, and expiring estimate",
      context: [
        "Suppose Provider A times out only for large requests from the west gateway zone. A global healthy or unhealthy bit loses that failure because the evidence actually belongs to a provider, model, request class, credential, zone, and network path.",
        "Classify an attempt before it changes health state. Provider success, caller error, provider overload, provider failure, and intentional cancellation carry different meanings; an active probe is also distinct from evidence produced by real traffic.",
        "Every estimate needs an observation time and a sample count so old or weak evidence loses authority. A timeout must affect both failure and latency estimates, or the provider can look fast simply because its slowest attempts never completed."
      ],
      walkthrough: {
        title: "Turn one attempt result into usable evidence",
        intro: "A normally finishes in 60 ms, but request r20 times out against A from the west zone while B remains reliable.",
        steps: [
          { title: "Preserve request context", text: "The observation carries provider A, the model, west zone, attempt r20-a1, start time, deadline, and cancellation source." },
          { title: "Identify the terminal cause", text: "The transport reaches the attempt deadline without a response and no caller or hedge-winner cancellation explains the stop." },
          { title: "Classify provider failure", text: "The timeout becomes provider_failure rather than caller_error or neutral, and it also contributes a latency sample at the timeout boundary." },
          { title: "Update recent estimates", text: "The tracker applies its documented EWMA weights to failure and latency, increments sample count, and records last-sample time." },
          { title: "Keep the scope", text: "The west-path estimate may reduce A locally without declaring A broken from every zone." },
          { title: "Publish a new snapshot", text: "The tracker replaces provider state atomically so future selections see a consistent failure estimate, latency estimate, sample age, and cooldown state." },
          { title: "Expire unsupported certainty", text: "If A receives no traffic for long enough, its old estimate becomes stale and bounded exploration or a probe must refresh it." }
        ],
        takeaway: "Routing should react to evidence only after the gateway knows what happened, where it happened, and how old that conclusion is."
      },
      workedExample: {
        title: "Update A after one timeout",
        setup: "Use EWMA new = (1 - alpha) x old + alpha x sample with alpha = 0.25, where failure samples are 1 for failure and 0 for success.",
        facts: [
          { label: "A prior latency EWMA", value: "60 ms" },
          { label: "A prior failure EWMA", value: "0.05" },
          { label: "Timeout sample", value: "200 ms and failure=1" },
          { label: "EWMA alpha", value: "0.25" },
          { label: "Observation scope", value: "A, model M, west zone" }
        ],
        steps: [
          "Latency becomes 0.75 x 60 + 0.25 x 200 = 95 ms.",
          "Failure becomes 0.75 x 0.05 + 0.25 x 1 = 0.2875.",
          "The tracker records the sample time and scope rather than overwriting A's evidence from every other path.",
          "A later caller cancellation would leave both estimates unchanged because it says nothing about A's ability to finish."
        ],
        result: "The next west-zone selection sees A as slower and riskier, while the system retains enough detail to distinguish a local path failure from a provider-wide incident."
      },
      explanations: [
        {
          title: "Cancellation needs a reason",
          paragraphs: [
            "A caller can leave, or a hedge can lose after another attempt wins, before the provider produces a terminal result. Those cancellations are neutral because the gateway chose to stop waiting.",
            "Counting them as failures creates the wrong feedback loop. Successful hedging would damage the slower provider's score and could eventually remove the fallback that improved reliability."
          ]
        },
        {
          title: "429 is capacity evidence",
          paragraphs: [
            "A provider 429 reports overload or quota pressure, not a broken transport or malformed caller payload. Honor a valid Retry-After value and retain the response as its own evidence class.",
            "That distinction gives each owner the right signal. Selection can reduce traffic, admission can shed excess demand, and operators can separate quota exhaustion from service failure."
          ]
        },
        {
          title: "Active probes answer a narrower question",
          paragraphs: [
            "A shallow probe may prove that an endpoint is reachable, while a full inference remains slow, rate-limited, or incompatible with the requested features. The probe therefore answers a narrower question than production traffic.",
            "Prefer real-request evidence for routing. Use bounded probes for recovery or for stale providers that receive too little ordinary traffic to refresh their state."
          ]
        }
      ],
      decisionTable: {
        title: "Outcome classification before health updates",
        columns: ["Observation", "Class", "Health effect"],
        rows: [
          ["200 with valid response", "success", "Update latency and success evidence"],
          ["Invalid public parameter", "caller_error", "Do not change provider health"],
          ["429 with Retry-After", "provider_overload", "Reduce eligibility or capacity until retry time"],
          ["503 or transport reset", "provider_failure", "Update failure and observed latency"],
          ["Attempt deadline", "provider_failure", "Record failure and timeout-bound latency"],
          ["Caller disconnected", "neutral", "Cancel work and leave health unchanged"],
          ["Losing hedge cancelled", "neutral", "Release capacity and leave health unchanged"],
          ["401 from provider", "configuration_error", "Alert and exclude the broken credential path"]
        ]
      },
      diagram: {
        type: "branch",
        title: "One completion enters one evidence class",
        caption: "Classification happens before the tracker changes latency, failure, capacity, or configuration state.",
        source: "Attempt completion",
        branches: [
          { label: "Success", note: "Latency plus success sample" },
          { label: "Caller error", note: "No provider health change" },
          { label: "Overload", note: "Capacity and retry timing" },
          { label: "Provider failure", note: "Failure plus latency penalty" },
          { label: "Neutral cancel", note: "Cleanup only" },
          { label: "Configuration error", note: "Exclude credential or adapter path" }
        ],
        destination: "New scoped snapshot"
      },
      interview: {
        prompt: "Provider A starts timing out from one gateway zone while other zones still succeed. Explain what state you record and how the next requests react.",
        answerPoints: [
          "Classify terminal outcomes before changing provider health.",
          "Keep caller and hedge-winner cancellation neutral.",
          "Track latency, failure, sample count, and observation time by provider and model.",
          "Retain zone or path scope when partial network failure is possible.",
          "Treat 429 as capacity evidence and honor Retry-After separately from 5xx failure.",
          "Publish immutable snapshots for lock-free selection reads.",
          "Expire stale evidence and refresh it through bounded real traffic or probes."
        ],
        followups: [
          "How does a timeout affect a latency EWMA?",
          "Why is a cancelled losing hedge neutral?",
          "Can a successful active probe clear a production inference failure?",
          "Which dimensions would you remove first if the state becomes too sparse?"
        ]
      }
    },

    "exploration-selection": {
      contextTitle: "Selection must act on evidence without stopping new evidence",
      context: [
        "Imagine A won the startup benchmark, so nearly every later request goes to A. B now has no fresh samples; if it recovers or becomes faster, a greedy router has no evidence that would let it change course.",
        "Selection should proceed through visible gates. First filter for contract compatibility, cooldown, and capacity; then reserve a small deterministic share for stale evidence before ordinary requests are ranked by latency, failure risk, and current load.",
        "That score expresses a policy choice, not an objective truth. Keep its weights configurable, compare changes under the same workload, break test ties deterministically, and add enough per-replica jitter in production to avoid synchronized movement."
      ],
      walkthrough: {
        title: "Choose a provider in four gates",
        intro: "Request r21 has 500 ms, both providers support its contract, and recent west-zone evidence makes A fast but risky while B is slower and reliable.",
        steps: [
          { title: "Filter compatibility", text: "Remove any adapter that cannot preserve the requested model revision, tools, output schema, token limit, or streaming mode." },
          { title: "Filter eligibility", text: "Remove providers in cooldown, providers without attempt capacity, and credential paths that are misconfigured or past Retry-After." },
          { title: "Check exploration", text: "If r21 is the scheduled exploration request, choose the eligible provider with the stalest useful sample rather than the current winner." },
          { title: "Compute ordinary scores", text: "For an exploitation request, read one immutable snapshot and apply the documented latency, failure, and load heuristic." },
          { title: "Choose deterministically", text: "Select the smallest score and use stable provider ID as the test tie-breaker so completion order does not change the expected result." },
          { title: "Record later", text: "Return the provider ID without performing I/O, then let the tracker update evidence only after the executor observes the attempt outcome." }
        ],
        takeaway: "Selection stays fast and testable when eligibility, exploration, scoring, and observation are separate steps."
      },
      workedExample: {
        title: "Compare A and B with a teaching score",
        setup: "Use score = latencyEWMA x (1 + 4 x failureEWMA) x (1 + inFlight/cap) as a stated experiment, not as a universal formula.",
        facts: [
          { label: "A state", value: "95 ms, failure 0.2875, 1 of 4 active" },
          { label: "B state", value: "120 ms, failure 0.01, 2 of 4 active" },
          { label: "A sample age", value: "1 s" },
          { label: "B sample age", value: "18 s" },
          { label: "Exploration rule", value: "Every tenth eligible request" }
        ],
        steps: [
          "A score is 95 x (1 + 4 x 0.2875) x (1 + 1/4), which is about 255.",
          "B score is 120 x (1 + 4 x 0.01) x (1 + 2/4), which is about 187.",
          "An ordinary request chooses B because 187 is smaller than 255 under this policy.",
          "The tenth request chooses the eligible provider with the older useful sample, which is B here; if B were the ordinary winner and A were stale, that probe would go to A.",
          "The benchmark must test whether these weights improve the stated success and latency targets without spending too much provider capacity."
        ],
        result: "The router chooses B for the current evidence, but bounded exploration ensures a stale A can earn ordinary traffic again after its conditions improve."
      },
      explanations: [
        {
          title: "Eligibility comes before ranking",
          paragraphs: [
            "A low score does not grant the ability to serve a request. A provider remains ineligible when it lacks a requested capability, sits in cooldown, has no attempt slot, or cannot finish before the deadline.",
            "The selector may therefore return no provider at all. The executor can then wait inside a bound, shed load, or return a deliberate error instead of forcing an impossible route."
          ]
        },
        {
          title: "Exploration has a budget",
          paragraphs: [
            "Exploration spends real provider capacity, so it needs a ceiling. A fixed percentage or deterministic nth-request rule is easy to explain and bounds the traffic used to refresh weaker evidence.",
            "Send that share to a stale but eligible provider. Record whether the observation came from ordinary production work or a synthetic probe because the two can exercise different paths."
          ]
        },
        {
          title: "Replica synchronization can overload the winner",
          paragraphs: [
            "A fleet-wide health hint can make every replica choose the same new winner at once. The provider may exceed its quota even though each replica made a locally reasonable decision.",
            "Include local in-flight load and move weights gradually. Per-process salt in deterministic tests and bounded jitter in production reduce synchronized traffic without hiding the selection policy."
          ]
        }
      ],
      decisionTable: {
        title: "Provider selection order",
        columns: ["Gate", "Question", "Possible result"],
        rows: [
          ["Contract", "Can this adapter preserve the request meaning?", "Exclude incompatible provider"],
          ["Cooldown", "May ordinary traffic enter now?", "Exclude or allow only a probe"],
          ["Capacity", "Is a provider attempt slot available in time?", "Exclude, queue within deadline, or shed"],
          ["Exploration", "Is this request in the bounded refresh share?", "Choose the stalest eligible evidence"],
          ["Score", "Which eligible provider best fits current policy?", "Choose smallest documented score"],
          ["Tie", "Are two scores equal?", "Use stable ID in tests and controlled jitter in production"]
        ]
      },
      diagram: {
        type: "branch",
        title: "Exploration and exploitation share the same eligibility gate",
        caption: "A probe never bypasses compatibility, cooldown rules, capacity, or the caller deadline.",
        source: "Compatible and eligible providers",
        branches: [
          { label: "Exploration request", note: "Refresh the stalest eligible evidence within a fixed budget" },
          { label: "Ordinary request", note: "Rank latency, failure risk, and current load" }
        ],
        destination: "One provider ID or no eligible provider"
      },
      interview: {
        prompt: "A was fastest during startup, so the gateway now sends it almost every request. B later becomes faster. Show how your router can discover and use that change.",
        answerPoints: [
          "Filter contract compatibility, cooldown, Retry-After, deadline, and provider capacity before scoring.",
          "Read one immutable provider snapshot without network I/O or health mutation.",
          "Reserve a bounded exploration share for stale eligible evidence.",
          "Use a documented heuristic for latency, failure risk, and current load rather than calling one score objectively correct.",
          "Return no eligible provider when every candidate is excluded instead of escaping caps.",
          "Use deterministic ties in tests and controlled jitter or gradual changes across replicas.",
          "Benchmark the score weights and exploration cost under the same provider schedule."
        ],
        followups: [
          "What happens when the exploration target has no available slot?",
          "How do you keep all replicas from switching together?",
          "Which sample should receive exploration when both providers are stale?",
          "How would you prove that B receives traffic after recovery?"
        ]
      }
    },

    "cooldown-recovery": {
      contextTitle: "Failure reaction and recovery are different control problems",
      context: [
        "Repeated failures should stop ordinary requests from continuing to damage the same provider path. A cooldown creates that pause, but elapsed time alone does not prove recovery; one bounded half-open probe must earn the next state.",
        "A successful probe proves only one request at one load level. Restore ordinary traffic through a stated slow-start schedule, and return to cooldown if the recovery evidence fails.",
        "Keep this state machine within the scope that observed the failure and jitter cooldowns across replicas. If the whole fleet probes on the same timestamp, recovery itself becomes another overload event."
      ],
      walkthrough: {
        title: "Move A through cooldown, probe, and ramp",
        intro: "A fails three health-relevant attempts from one gateway process while B remains available for the 500 ms client requests.",
        steps: [
          { title: "Count classified failures", text: "The tracker increments A's consecutive provider failures only after excluding caller errors and neutral cancellation." },
          { title: "Enter cooldown", text: "At the stated threshold, A stops receiving ordinary traffic until cooldownUntil, while B serves only the load its own capacity can accept." },
          { title: "Jitter the deadline", text: "This replica adds bounded random delay so other replicas do not send their first probe to A at the same instant." },
          { title: "Elect one half-open probe", text: "After cooldown, an atomic state transition allows one request to test A while concurrent ordinary requests still avoid it." },
          { title: "Interpret the probe", text: "Failure returns A to a longer bounded cooldown, while success moves A to a ramp state rather than full eligibility." },
          { title: "Increase traffic gradually", text: "A receives a small weight or capped request share that grows only while recent success and capacity evidence remain acceptable." },
          { title: "Return to closed", text: "After the recovery window meets its success rule, A becomes ordinarily eligible and exploration resumes its normal role." }
        ],
        takeaway: "Cooldown stops repeated harm, one probe tests reachability, and slow start tests capacity without a traffic wall."
      },
      workedExample: {
        title: "Recover A without a thundering herd",
        setup: "A opens after three consecutive provider failures, each replica uses a two-second base cooldown with up to 500 ms jitter, and successful recovery ramps over four windows.",
        facts: [
          { label: "Open threshold", value: "3 provider failures" },
          { label: "Base cooldown", value: "2,000 ms" },
          { label: "Replica jitter", value: "0 to 500 ms" },
          { label: "Half-open probes", value: "1 per local scope" },
          { label: "Ramp shares", value: "10%, 25%, 50%, 100%" }
        ],
        steps: [
          "A's third classified failure occurs at t=600 ms, so this replica sets cooldownUntil to t=2,840 ms after adding 240 ms jitter.",
          "At t=2,840 ms one request wins the half-open transition and every other request continues to B or follows overload policy.",
          "The A probe succeeds within its 500 ms client deadline, which moves A to the first 10% recovery window.",
          "Each healthy window raises A to 25%, 50%, and 100%, while any health-relevant failure returns it to cooldown.",
          "The router still respects A's provider cap during the ramp, so a weight increase cannot create capacity."
        ],
        result: "A regains traffic through one controlled probe and measured load windows instead of receiving the whole fleet at one shared cooldown timestamp."
      },
      explanations: [
        {
          title: "Half-open needs an owner",
          paragraphs: [
            "When cooldown expires, many waiting requests may inspect state at the same time. Without an atomic claim, all of them can believe they are the single recovery probe.",
            "The state owner must move from cooldown to probing before publishing the next snapshot. One claimed result then either reopens the provider or begins the traffic ramp."
          ]
        },
        {
          title: "Do not eject every route blindly",
          paragraphs: [
            "Both providers can cross the same failure threshold during a broad incident. Ejecting both may produce lower availability than retaining one degraded path under a small cap.",
            "Choose that behavior explicitly: fail closed, retain the least-bad provider, or shed most load while reserving probe capacity. Routing cannot manufacture upstream capacity that does not exist."
          ]
        },
        {
          title: "Recovery evidence is scoped",
          paragraphs: [
            "A successful request from east does not clear a west network partition. A tiny synthetic request also does not prove that a large streamed inference can sustain load.",
            "Match the probe to the failed path's scope and request class. During slow start, ordinary bounded traffic supplies the stronger evidence needed for full restoration."
          ]
        }
      ],
      decisionTable: {
        title: "Provider recovery state machine",
        columns: ["State", "Ordinary traffic", "Allowed transition"],
        rows: [
          ["Closed", "Normal policy share", "Failure threshold moves to cooldown"],
          ["Cooldown", "None for this scope", "Jittered deadline permits one probe claim"],
          ["Probing", "None except the claimed probe", "Success starts ramp; failure returns to cooldown"],
          ["Ramp 10%", "Small bounded share", "Healthy window raises share; failure reopens"],
          ["Ramp 25% or 50%", "Growing bounded share", "Continue only while evidence and capacity hold"],
          ["Closed again", "Normal policy share", "Resume ordinary observation and exploration"]
        ]
      },
      diagram: {
        type: "state-machine",
        title: "A provider earns traffic back in stages",
        caption: "The arrows describe admission policy, while every state still obeys provider capacity and the caller deadline.",
        states: [
          { label: "Closed", note: "Ordinary selection" },
          { label: "Cooldown", note: "Withhold ordinary traffic" },
          { label: "Probing", note: "One claimed request" },
          { label: "Slow start", note: "10%, 25%, 50%" },
          { label: "Closed", note: "Normal share restored" }
        ],
        transitions: [
          "Three classified failures: Closed -> Cooldown",
          "Jittered cooldown expires: Cooldown -> Probing",
          "Probe failure: Probing -> Cooldown",
          "Probe success: Probing -> Slow start",
          "Ramp failure: Slow start -> Cooldown",
          "Healthy recovery window: Slow start -> Closed"
        ]
      },
      interview: {
        prompt: "Provider A fails repeatedly, then recovers while fifty gateway replicas are running. Define the state transitions that remove it quickly and restore it safely.",
        answerPoints: [
          "Count only health-relevant classified outcomes toward the failure threshold.",
          "Enter a bounded cooldown that removes ordinary traffic for the affected scope.",
          "Add per-replica jitter so probes do not synchronize across the fleet.",
          "Use an atomic half-open claim so one request owns the recovery probe.",
          "Return to cooldown on probe failure and begin slow start on success.",
          "Ramp traffic through bounded shares while respecting provider capacity.",
          "State the degraded policy when every provider is failing."
        ],
        followups: [
          "Who owns the single half-open probe under concurrent requests?",
          "Can one successful health endpoint restore full model traffic?",
          "What if B cannot absorb all traffic while A is in cooldown?",
          "How do local and fleet-wide cooldown evidence interact?"
        ]
      }
    },

    "bounded-concurrency": {
      contextTitle: "Bound logical requests, waiting requests, and provider attempts separately",
      context: [
        "A burst can exhaust the gateway before either provider reaches its own limit. Use an active-request cap to bound process work, a bounded queue to limit waiting callers, and a per-provider cap to bound physical upstream attempts; the HTTP connection pool controls transport reuse, not the whole request count.",
        "One logical request holds one application permit for its lifetime. Each primary, retry, or hedge also acquires a permit from the chosen provider, so extra attempts cannot bypass the limits applied to ordinary work.",
        "When no capacity remains, the request may wait only inside its deadline and the declared queue bound. Otherwise reject it with an explicit overload result, because an unbounded queue turns a capacity shortage into memory growth and extreme tail latency."
      ],
      walkthrough: {
        title: "Follow one request through every capacity owner",
        intro: "The process allows three active logical requests, two queued requests, two A attempts, and one B attempt.",
        steps: [
          { title: "Check total admission", text: "If three requests are active and two are already queued, the next arrival is rejected before it allocates provider work." },
          { title: "Enter the bounded queue", text: "If only one request is queued, the arrival may wait as the second queued request until an application permit appears or its deadline expires." },
          { title: "Acquire application capacity", text: "When a logical slot opens, the request leaves the queue and owns exactly one application permit until its final response or cancellation." },
          { title: "Choose an eligible provider", text: "The router excludes a provider that cannot obtain an attempt slot in useful time instead of pretending a connection-pool setting is an application limit." },
          { title: "Acquire attempt capacity", text: "The executor obtains an A or B permit before starting the provider client and releases it when that physical attempt ends." },
          { title: "Charge extra attempts", text: "A retry or hedge acquires its own provider permit while the same logical request continues to hold one application permit." },
          { title: "Release through one terminal path", text: "Success, final failure, deadline, caller cancellation, and queue cancellation converge on idempotent cleanup that returns every owned permit once." }
        ],
        takeaway: "Capacity stays explainable when each queue and permit has one resource, one owner, and one release event."
      },
      workedExample: {
        title: "Decide whether a new request or hedge may start",
        setup: "Three logical requests are active, one request is queued, both A attempt slots are busy, and B's only attempt slot is busy.",
        facts: [
          { label: "Application cap", value: "3 active" },
          { label: "Queue cap", value: "2 waiting" },
          { label: "A cap", value: "2 attempts, both active" },
          { label: "B cap", value: "1 attempt, active" },
          { label: "New request deadline", value: "500 ms" }
        ],
        steps: [
          "A new logical request may occupy the second and final queue position because the active cap is full but the queue is not.",
          "A second new arrival must be rejected because three active plus two queued requests already consume the stated process bound.",
          "An active request whose hedge delay fires cannot start a hedge while B has no attempt slot, even though the hedge might improve latency.",
          "When one active request completes, the first queued request acquires the application permit and the remaining queued request moves forward without changing queue order.",
          "If the queued request's deadline expires first, cancellation removes it from the queue and frees that waiting position without touching provider health."
        ],
        result: "The process never exceeds three active and two waiting logical requests, while A and B remain at two and one physical attempts even during fallback or hedging."
      },
      explanations: [
        {
          title: "Admission and provider queues answer different shortages",
          paragraphs: [
            "The application queue waits for process capacity. Waiting behind one provider limiter is different: those requests can occupy every active application slot and prevent work that could use another provider from advancing.",
            "Let provider eligibility account for current capacity before starting that wait. If provider-capacity waiting remains part of the design, measure and bound it separately from application admission."
          ]
        },
        {
          title: "Connection pools do not prove request caps",
          paragraphs: [
            "A connection pool counts transport objects, not necessarily active requests. HTTP/2 can multiplex many streams on one connection, while HTTP/1.1 settings may bound sockets without bounding queued application tasks.",
            "Create overlapping work and measure peak active logical requests plus provider attempts. A transport constructor value alone does not prove either application invariant."
          ]
        },
        {
          title: "Fairness changes who may wait",
          paragraphs: [
            "A single tenant can fill every position in one FIFO queue before another tenant arrives. Production admission may therefore reserve or weight capacity by tenant, priority, or response mode.",
            "The coding-round queue can stay simple, but state its fairness assumption. Choose a representation that can later be partitioned instead of baking global FIFO into every boundary."
          ]
        }
      ],
      decisionTable: {
        title: "Capacity boundaries and their invariants",
        columns: ["Boundary", "Counts", "Invariant", "Overload behavior"],
        rows: [
          ["Admission", "Accepted active plus waiting work", "Never exceed active + queue bounds", "Reject before expensive allocation"],
          ["Application active", "Logical requests executing", "One permit per logical request", "Wait in bounded queue or reject"],
          ["Queue", "Logical requests waiting", "Remove on admission, timeout, or cancellation", "Reject when full"],
          ["Provider A", "Physical A attempts", "Primary, retry, and hedge all count", "Choose B, wait within deadline, or fail"],
          ["Provider B", "Physical B attempts", "Primary, retry, and hedge all count", "Choose A, wait within deadline, or fail"],
          ["Client pool", "Connections and transport streams", "Reuse transport within protocol rules", "Transport-specific backpressure"]
        ]
      },
      diagram: {
        type: "swimlane",
        title: "One logical request can own several bounded resources",
        caption: "Permits belong to different lifetimes, so the event ledger must show which owner acquired and released each one.",
        lanes: [
          { label: "Logical request", items: ["Wait in queue", "Acquire application permit", "Hold until final result", "Release once"] },
          { label: "Provider attempts", items: ["Acquire A for primary", "Release A on failure", "Acquire B for fallback or hedge", "Release B on completion"] },
          { label: "Transport", items: ["Reuse provider client", "Open or reuse connection", "Propagate cancellation", "Drain or close response body"] }
        ]
      },
      interview: {
        prompt: "Your client and HTTP library both have connection settings. Explain which additional limits the application needs and prove they hold during retries and hedges.",
        answerPoints: [
          "Define a cap for active logical requests and a separate bound for waiting requests.",
          "Define one physical-attempt cap per provider and count primary, retry, and hedge work equally.",
          "Do not treat connection count as request count under multiplexed transports.",
          "Acquire capacity before launching work and wait only within the caller deadline.",
          "Reject or shed when the bounded queue is full rather than creating hidden waiting.",
          "Use idempotent cleanup for success, error, deadline, queue cancellation, caller exit, and hedge loss.",
          "Test overlap and assert observed peak counts rather than constructor settings."
        ],
        followups: [
          "What happens when all active requests wait behind Provider A while B is free?",
          "Does a losing hedge hold an application permit after cancellation?",
          "How do ten replicas change a local provider cap of twenty?",
          "Where would tenant fairness enter the queue design?"
        ]
      }
    },

    "retry-or-hedge": {
      contextTitle: "Extra attempts spend deadline, capacity, quota, and money",
      context: [
        "When A is slow or fails, the gateway has three ways to spend extra work. Fallback waits for failure and changes providers, retry repeats an eligible failure under a backoff policy, and hedging starts another attempt while the primary is still active to reduce tail latency.",
        "Each choice remains inside one logical request deadline and attempt budget. Every physical attempt still acquires provider capacity and appears in quota, cost, traces, and attempts-per-request metrics.",
        "A delayed hedge is justified only when duplicate execution is allowed, another provider has capacity, enough deadline remains, and measured tails support the added cost. After the first acceptable response commits, cancel the loser and classify that cancellation as intentional rather than as provider failure."
      ],
      walkthrough: {
        title: "Decide whether the second attempt is fallback, retry, or hedge",
        intro: "Request r22 has a 500 ms deadline and starts on fast Provider A, whose usual latency is 60 ms but whose tail sometimes reaches 410 ms.",
        steps: [
          { title: "Start one primary", text: "A acquires one provider permit at t=0 under attempt r22-a1 and the executor schedules a possible hedge at t=100 ms." },
          { title: "Wait through the fast range", text: "Most A requests finish before 100 ms, so the delay prevents duplicate work on the normal path." },
          { title: "Recheck eligibility at the delay", text: "At t=100 ms A is still running, B has capacity, output is uncommitted, and 400 ms remain under the same caller deadline." },
          { title: "Launch one hedge", text: "B acquires its own provider permit as attempt r22-b1 while r22 continues to hold one logical-request permit." },
          { title: "Commit the first acceptable result", text: "B finishes at t=220 ms, wins the logical request, and establishes the response commit point." },
          { title: "Cancel A neutrally", text: "The executor cancels r22-a1, releases both provider permits through their terminal paths, and records the A cancellation as neutral." },
          { title: "Measure the trade", text: "The request saved 190 ms against A's 410 ms tail but consumed 120 ms of B work and increased attempts per request." }
        ],
        takeaway: "A hedge is a measured purchase of tail latency with extra upstream work, not a free reliability switch."
      },
      workedExample: {
        title: "Calculate one delayed hedge",
        setup: "A would finish at 410 ms, B starts at the 100 ms hedge delay and needs 120 ms, and both calls remain below their provider caps.",
        facts: [
          { label: "Client deadline", value: "500 ms" },
          { label: "A completion without hedge", value: "410 ms" },
          { label: "Hedge delay", value: "100 ms" },
          { label: "B service time", value: "120 ms" },
          { label: "Output committed before B", value: "No" }
        ],
        steps: [
          "B starts at 100 ms and finishes at 100 ms + 120 ms = 220 ms.",
          "The client receives a result at 220 ms instead of waiting until A's 410 ms completion, which saves 190 ms on this request.",
          "A ran for 220 ms before cancellation and B ran for 120 ms, so the latency win consumed additional provider work on both paths.",
          "If B had no permit at 100 ms or output had already committed, the executor would not launch this hedge.",
          "A benchmark must count all physical attempts and losing work rather than reporting only the winning latency."
        ],
        result: "The hedge improves this tail request from 410 ms to 220 ms, but the policy is acceptable only if its aggregate attempt cost and overload behavior fit the stated constraints."
      },
      explanations: [
        {
          title: "Retry budgets stop failure amplification",
          paragraphs: [
            "During an isolated reset, one retry may recover the request. When both providers are overloaded, the same retry adds demand to the shared shortage and can reduce the success rate of first attempts.",
            "Bound extra work with a ratio, token bucket, or fixed attempt ceiling that tightens during broad failure. Honor Retry-After and add jitter to any remaining backoff so callers do not retry in lockstep."
          ]
        },
        {
          title: "Cancellation may not erase provider cost",
          paragraphs: [
            "The gateway can cancel a losing attempt after the provider has accepted, executed, or billed it. Fast local cancellation therefore does not prove that duplicate cost was avoided.",
            "Record attempted tokens or provider-reported usage when available. Keep wasted hedge duration beside client latency so the policy's cost remains visible."
          ]
        },
        {
          title: "The commit point controls replacement",
          paragraphs: [
            "Buffered output lets the gateway compare complete responses before any bytes reach the client. A streamed response usually commits at its first delivered chunk, much earlier in the provider attempt.",
            "If the provider resets after several tokens, starting B cannot hide the break by default. The public contract would need explicit restart or continuation semantics for that behavior to be valid."
          ]
        }
      ],
      decisionTable: {
        title: "Choose the extra-attempt mechanism from the observed problem",
        columns: ["Mechanism", "Starts when", "Best fit", "Primary cost"],
        rows: [
          ["Fallback", "After another provider fails", "Interchangeable providers and eligible failure", "Additional latency after failure"],
          ["Retry", "After an eligible transient failure", "Same or alternate provider with backoff", "Failure amplification and quota"],
          ["Delayed hedge", "While the primary is still running", "Rare slow tails with duplicate-safe work", "Concurrent duplicate work"],
          ["Race immediately", "At request start", "Only when latency value justifies near-2x work", "High steady-state cost"],
          ["No extra attempt", "Never", "Committed output, no capacity, or too little time", "Lower reliability or higher tail latency"]
        ]
      },
      diagram: {
        type: "timeline",
        title: "A delayed hedge overlaps only the tail",
        caption: "The second attempt begins after A's normal fast range and ends when the first acceptable response commits.",
        events: [
          { label: "t=0", note: "A starts as r22-a1" },
          { label: "t=60", note: "Normal A requests would already finish" },
          { label: "t=100", note: "Hedge delay fires and B obtains capacity" },
          { label: "t=220", note: "B succeeds and commits" },
          { label: "t=220", note: "A is cancelled neutrally and permits return" },
          { label: "t=410", note: "A would have completed here without the hedge" }
        ]
      },
      interview: {
        prompt: "Provider A is usually fast but has a rare 400 ms tail, while B is slower and reliable. Decide whether to retry, fall back, or hedge under a 500 ms deadline.",
        answerPoints: [
          "Define fallback, retry, and hedge by when the extra attempt starts.",
          "Keep every attempt under one caller deadline and a fixed attempt budget.",
          "Require duplicate-safe semantics, uncommitted output, useful remaining time, and provider capacity before hedging.",
          "Place the hedge delay beyond the primary's measured normal range rather than racing every request.",
          "Cancel the loser and classify intentional cancellation as neutral health evidence.",
          "Count attempts per request, wasted work, quota, and cost beside p95 and p99 latency.",
          "Disable extra attempts during broad overload through admission and retry budgets."
        ],
        followups: [
          "What happens if B is saturated when the hedge delay fires?",
          "How does streaming change the winner rule?",
          "Which metric tells you that hedging doubled provider work?",
          "Can cancellation guarantee that the provider did not bill the request?"
        ]
      }
    },

    "benchmark-protocol": {
      contextTitle: "A benchmark is a controlled argument about one policy change",
      context: [
        "A claim such as adaptive routing lowered p99 is meaningless without the workload that produced it. Before the run, record the arrival schedule, provider phases, request count, seed, caps, deadline, extra-attempt parameters, and measurement rules.",
        "For overload experiments, keep offering requests even when the gateway slows. A closed worker loop waits for each response and quietly reduces offered load, which can hide the collapse the benchmark is supposed to expose.",
        "Compare success, achieved throughput, dropped arrivals, queue latency, p50, p95, p99, provider share, peak active counts, and attempts per logical request. Accept the policy only if it improves the named objective without breaking a cap or moving cost into an unreported metric."
      ],
      walkthrough: {
        title: "Run one baseline and one candidate under the same provider weather",
        intro: "The schedule sends 1,000 requests at 50 RPS through steady service, an A failure burst, recovery, and a final steady phase.",
        steps: [
          { title: "Write the hypothesis", text: "State that adaptive routing should preserve at least 99.5% success and reduce p95 during the A failure phase without exceeding 1.10 attempts per request." },
          { title: "Freeze the workload", text: "Record seed, request bodies, open arrival rate, phase boundaries, provider latency and failure distributions, caps, queue size, and 500 ms deadline." },
          { title: "Warm reusable clients", text: "Run a separate warmup so connection setup and runtime initialization do not affect only the first measured strategy." },
          { title: "Run the baseline", text: "Measure round robin or fixed-primary behavior and preserve the complete result row before changing policy." },
          { title: "Change one control", text: "Enable adaptive selection while keeping the workload, seed, caps, deadline, and measurement code identical." },
          { title: "Repeat and inspect phases", text: "Run enough repetitions to separate a stable effect from one seeded ordering, then inspect failure and recovery windows rather than only aggregate percentiles." },
          { title: "Decide against the constraints", text: "Accept, reject, or revise the candidate by citing success, tail latency, drops, queueing, attempts, and cap observations." }
        ],
        takeaway: "A benchmark supports a policy claim only when the baseline and candidate differ in the control being tested."
      },
      workedExample: {
        title: "Choose between round robin and adaptive routing",
        setup: "Both strategies run the same 1,000 open-loop arrivals with the same seed, 500 ms deadline, caps, and provider phases.",
        facts: [
          { label: "Success objective", value: ">= 99.5%" },
          { label: "Attempt-cost bound", value: "<= 1.10 calls/request" },
          { label: "Round robin", value: "99.2%, p95 220 ms, 1.04 calls/request" },
          { label: "Adaptive", value: "99.7%, p95 170 ms, 1.08 calls/request" },
          { label: "Dropped arrivals", value: "0 for both" }
        ],
        steps: [
          "Round robin misses the 99.5% success objective even though its attempt cost is lower.",
          "Adaptive meets the success objective and reduces p95 by 50 ms under the same schedule.",
          "Adaptive adds 0.04 physical calls per logical request but remains below the 1.10 attempt-cost bound.",
          "Zero drops and observed peak counts at or below every configured cap rule out hidden overload in this run.",
          "Repeat the experiment with several fixed seeds and inspect the recovery phase before accepting the policy."
        ],
        result: "Adaptive is the current candidate because it meets both explicit constraints, but the notebook should preserve the added attempt cost and the need for repeated runs."
      },
      explanations: [
        {
          title: "Closed loops hide coordinated omission",
          paragraphs: [
            "Suppose ten workers each wait for a response before sending their next request. As the gateway slows, those workers generate less traffic, so the latency histogram omits requests that would have arrived under fixed external demand.",
            "An open scheduler offers work at predetermined times and records late or dropped arrivals. The queue and admission policy must then reveal overload instead of letting the benchmark reduce its own demand."
          ]
        },
        {
          title: "Percentiles need their population",
          paragraphs: [
            "A p99 has no meaning until its population is named. Successful responses, all terminal requests, queue-overflow rejections, and deadline failures answer different questions.",
            "Report success and dropped work beside the percentile. Otherwise a system that rejects most arrivals can appear healthy because only its easiest successes remain in the latency sample."
          ]
        },
        {
          title: "Phase charts explain adaptation",
          paragraphs: [
            "One aggregate provider-share number erases when traffic moved. It cannot show whether the router detected failure quickly, starved recovery probes, or returned traffic after A recovered.",
            "Plot traffic share with recent failure and latency estimates, provider state, queue depth, and active attempts for each time window. Every policy transition then has evidence visible at the moment it occurred."
          ]
        }
      ],
      decisionTable: {
        title: "Fields required for a comparable benchmark row",
        columns: ["Field", "Why it matters", "Failure if omitted"],
        rows: [
          ["Code revision and policy", "Names the implementation under test", "Result cannot be tied to code"],
          ["Seed and provider phases", "Replays latency, failure, and recovery", "Strategies see different weather"],
          ["Offered and achieved RPS", "Shows demand and delivered throughput", "Slow service can reduce test load invisibly"],
          ["Caps, queue, and deadline", "Defines resource and time constraints", "One strategy may receive more capacity"],
          ["Success, drops, and errors", "Shows user-visible reliability", "Latency can improve by rejecting work"],
          ["p50, p95, p99, and queue p95", "Separates normal, tail, and admission delay", "Average latency hides tails"],
          ["Attempts per request", "Shows retry and hedge amplification", "Provider cost stays hidden"],
          ["Hypothesis and decision", "Connects the row to one change", "Notebook becomes a number archive"]
        ]
      },
      diagram: {
        type: "timeline",
        title: "Every policy sees the same provider phases",
        caption: "Repeat this schedule for the baseline and each candidate, then compare both aggregate and phase-level behavior.",
        events: [
          { label: "Warmup", note: "Build connections and initialize state outside measurement" },
          { label: "Steady", note: "Measure normal latency, share, and attempt cost" },
          { label: "A fails", note: "Observe detection, fallback, queueing, and drops" },
          { label: "A cooldown", note: "Observe B capacity and admission behavior" },
          { label: "A recovers", note: "Observe probes and gradual traffic return" },
          { label: "Steady again", note: "Measure final share and stale evidence" }
        ]
      },
      interview: {
        prompt: "You have implemented adaptive routing. Design a benchmark that proves it improves latency or reliability without hiding overload or duplicate provider cost.",
        answerPoints: [
          "Write one hypothesis with a latency or reliability target and an attempt-cost constraint.",
          "Use an open arrival schedule with fixed provider phases, seed, requests, caps, queue, and deadline.",
          "Warm clients separately and preserve a simple baseline row.",
          "Change one policy control per candidate run and repeat under comparable conditions.",
          "Report offered and achieved RPS, drops, errors, queue latency, p50, p95, p99, provider share, and attempts per request.",
          "Assert observed peak active work stays within application and provider caps.",
          "Inspect failure and recovery windows rather than relying only on aggregate metrics."
        ],
        followups: [
          "Why can a fixed worker count make overload look healthy?",
          "Which requests belong in the latency percentile population?",
          "How do you compare two strategies when one has higher success and higher provider cost?",
          "What graph proves that A received traffic after recovery?"
        ]
      }
    },

    "coding-operating-loop": {
      contextTitle: "The round needs a working baseline before it needs policy depth",
      context: [
        "The interviewer needs a runnable gateway before they can judge an advanced policy. A correct baseline with visible ownership and one measured improvement is stronger evidence than an unfinished collection of breakers, hedges, and shared state.",
        "Use the 75 minutes as a sequence of working checkpoints. Spend minutes 0 to 7 on the contract and runner, 7 to 37 on the bounded baseline, 37 to 52 on one adaptive policy, 52 to 64 on a controlled benchmark, and 64 to 75 on failure tests plus explanation.",
        "AI assistance can draft one function or one test at a time, but it does not own the result. The candidate must still explain the request contract, cancellation, permit lifecycle, benchmark interpretation, and every generated change retained in the final code."
      ],
      walkthrough: {
        title: "Use five checkpoints across 75 minutes",
        intro: "The plan keeps a runnable fallback at every checkpoint so an incomplete optimization never destroys the working gateway.",
        steps: [
          { title: "Minutes 0 to 7: establish the contract", text: "Inspect the supplied runner, confirm buffered or streamed responses, list health-relevant failures, choose success and latency metrics, and write the first interfaces." },
          { title: "Minutes 7 to 22: forward one request", text: "Implement validation, one provider adapter path, the absolute deadline, reusable client ownership, and one deterministic success test." },
          { title: "Minutes 22 to 37: bound and fail over", text: "Add application and provider limits, a bounded queue or explicit rejection, classified failure, B fallback, cancellation, and permit assertions." },
          { title: "Minutes 37 to 52: add one adaptive rule", text: "Track recent latency and failures, filter cooldown and capacity, reserve bounded exploration, and keep the simple policy available behind the same Router interface." },
          { title: "Minutes 52 to 64: benchmark one change", text: "Run baseline and adaptive policies under the same scripted weather, then record success, p95, p99, queueing, drops, and attempts per request." },
          { title: "Minutes 64 to 75: make the result reviewable", text: "Repair lifecycle gaps, run focused edge cases, simplify names, preserve the notebook, and state one production limitation plus one next step." }
        ],
        takeaway: "Every checkpoint ends with code and evidence that can be defended even if the next feature is not finished."
      },
      workedExample: {
        title: "Choose the right work at minute 52",
        setup: "The baseline forwards requests, enforces caps, falls back from A to B, and passes deterministic cleanup tests, while an adaptive selector is partly implemented but its recovery path is not tested.",
        facts: [
          { label: "Time remaining", value: "23 minutes" },
          { label: "Baseline", value: "Runnable and bounded" },
          { label: "Adaptive selection", value: "Routes failure but lacks recovery proof" },
          { label: "Benchmark rows", value: "Baseline only" },
          { label: "Known risk", value: "A may remain starved after recovery" }
        ],
        steps: [
          "Freeze any new routing features and preserve the baseline policy as the safe option.",
          "Add one deterministic recovery case that makes A stale, improves A, and proves exploration sends it a later request.",
          "Run the baseline and candidate under the same provider schedule and record the candidate only if cleanup and caps still pass.",
          "If recovery remains broken at minute 64, keep the baseline as final code and describe the adaptive attempt as measured but incomplete.",
          "Use the final eleven minutes to leave readable ownership, tests, and a clear production handoff."
        ],
        result: "A smaller correct submission with a measured limitation gives the interviewer more evidence than an adaptive path that can starve recovery or leak work."
      },
      explanations: [
        {
          title: "Keep a fallback plan in the code",
          paragraphs: [
            "Keep fixed or round-robin selection runnable while adaptive behavior is added behind the Router interface. The simple implementation becomes both a benchmark baseline and a recovery path for the coding session.",
            "If the advanced router breaks a lifecycle invariant, switch the final run back to the simple policy. A correct endpoint with a measured limitation is preferable to an advanced path that cannot finish safely."
          ]
        },
        {
          title: "Make reasoning visible",
          paragraphs: [
            "Tell the interviewer which checkpoint works and which invariant the next change targets. Name the benchmark row that will confirm or reject the change before the tools run.",
            "Keep a short notebook of assumptions, commands, parameters, results, and interpretation. That record lets the final walkthrough explain decisions from evidence instead of reconstructing the experiment from memory."
          ]
        },
        {
          title: "Constrain AI-generated changes",
          paragraphs: [
            "Ask the coding tool for one adapter, pure selector, or missing test instead of an entire architecture. Inspect each diff for hidden global state, unbounded tasks, new timers, and lost cancellation before accepting it.",
            "Then rerun deterministic tests and the comparable benchmark. Compilation proves syntax and types, but it does not prove event ordering, cleanup, or capacity ownership."
          ]
        }
      ],
      decisionTable: {
        title: "Coding-round checkpoints and fallback artifacts",
        columns: ["Time", "Required artifact", "If behind"],
        rows: [
          ["0 to 7", "Written contract, metrics, failure classes, interface sketch", "Reduce scope before coding"],
          ["7 to 22", "One forwarded request and deterministic success test", "Keep one provider and finish correctness"],
          ["22 to 37", "Caps, deadline, fallback, cleanup test", "Skip hedging and advanced breaker state"],
          ["37 to 52", "One adaptive rule with recovery path", "Retain simple policy and finish tests"],
          ["52 to 64", "Comparable baseline and candidate rows", "Benchmark the simple path and explain missing policy"],
          ["64 to 75", "Readable code, edge tests, evidence, limitations", "Stop feature work immediately"]
        ]
      },
      diagram: {
        type: "timeline",
        title: "Seventy-five minutes with a runnable checkpoint at each boundary",
        caption: "The sequence spends complexity only after request correctness, capacity, and cleanup are observable.",
        events: [
          { label: "0 to 7", note: "Contract, runner, metrics, interfaces" },
          { label: "7 to 22", note: "One-provider request path" },
          { label: "22 to 37", note: "Bounds, fallback, cancellation" },
          { label: "37 to 52", note: "Health, exploration, recovery" },
          { label: "52 to 64", note: "Comparable benchmark" },
          { label: "64 to 75", note: "Tests, cleanup, and defense" }
        ]
      },
      interview: {
        prompt: "Explain how you will use the 75-minute coding round to deliver a working model gateway, one adaptive improvement, and evidence the interviewer can review.",
        answerPoints: [
          "Spend the first seven minutes confirming contract, streaming, failure classes, runner behavior, and metrics.",
          "Build one correct provider path and deterministic fake before policy complexity.",
          "Add total deadline, bounded application work, provider caps, fallback, cancellation, and cleanup before adaptation.",
          "Implement one understandable health and exploration rule behind a replaceable Router interface.",
          "Preserve a simple baseline and compare it under the same scripted workload.",
          "Reserve the final eleven minutes for edge tests, naming, evidence, limitations, and production handoff.",
          "Inspect and test every AI-generated change before keeping it."
        ],
        followups: [
          "What feature do you drop first if the baseline is late?",
          "What do you do when adaptive routing lowers p95 but leaks a permit?",
          "Which benchmark columns stay visible during the round?",
          "How do you show the interviewer that generated code is understood?"
        ]
      }
    },

    "deterministic-gateway-tests": {
      contextTitle: "Concurrency tests need controlled events instead of elapsed sleep",
      context: [
        "A sleep-based concurrency test can pass or fail because the host scheduler happened to run tasks in a different order. A virtual clock and scripted providers let the test decide exactly when attempts start, block, finish, fail, and observe cancellation.",
        "Record each ownership change in an event ledger: queue, acquire, start, finish, cancel, release, health update, and response commit. Assert invariants from those observed events instead of assuming a semaphore constructor proves the runtime behavior.",
        "Useful cases create overlap deliberately. Hold attempts open, fill active and queued bounds, reorder completions, cancel both queued and active work, then verify the observed peaks and final permit counts."
      ],
      walkthrough: {
        title: "Prove one delayed hedge without sleeping",
        intro: "A scripted test starts A at virtual t=0, schedules B at t=50, and controls both completions under the same 500 ms request deadline.",
        steps: [
          { title: "Install deterministic dependencies", text: "Inject a virtual monotonic clock, provider scripts, and an event recorder through the same interfaces used by the production executor." },
          { title: "Start A", text: "At t=0 the test admits r23, acquires one application permit and one A permit, then records A start while its scripted future remains pending." },
          { title: "Advance to the hedge delay", text: "The clock jumps directly to t=50, which runs the scheduled hedge decision without waiting 50 ms of wall time." },
          { title: "Start B", text: "B has capacity, so the executor acquires one B permit and records a second physical attempt under the same logical request." },
          { title: "Complete B first", text: "At t=75 the script returns B success, and the executor commits B as the logical response winner." },
          { title: "Observe cancellation and release", text: "A receives hedge-winner cancellation, both provider permits return, the application permit returns, and A health remains unchanged." },
          { title: "Assert the ledger", text: "The test checks event order, winner identity, peak active counts, one response commit, neutral cancellation, and zero permits left owned." }
        ],
        takeaway: "The test proves the lifecycle because it controls overlap and inspects ownership events, not because a timer happened to fire on one machine."
      },
      workedExample: {
        title: "Fill two active slots and two queue slots",
        setup: "Five requests arrive together while the application permits two active requests and the bounded queue holds two waiting requests.",
        facts: [
          { label: "Application cap", value: "2 active" },
          { label: "Queue cap", value: "2 waiting" },
          { label: "Arrivals", value: "r1 through r5 at t=0" },
          { label: "Provider scripts", value: "r1 and r2 stay pending" },
          { label: "Caller deadline", value: "500 ms each" }
        ],
        steps: [
          "r1 and r2 acquire the two application permits and remain active while their scripted providers wait.",
          "r3 and r4 enter the two bounded queue positions without starting a provider attempt.",
          "r5 receives the explicit overload result because both active and waiting bounds are full.",
          "The test cancels queued r3 and asserts that its queue node disappears without a provider health sample or permit leak.",
          "A new r6 may now occupy the free queue position, while observed peak active remains two and peak waiting remains two.",
          "Completing r1 admits the oldest remaining queued request and leaves every final permit count at its configured capacity."
        ],
        result: "The ledger proves two active, two waiting, one rejected, clean queued cancellation, FIFO admission, and no permit leak."
      },
      explanations: [
        {
          title: "Script behavior through the production interface",
          paragraphs: [
            "The scripted provider should accept the same normalized request and cancellation context as the real adapter. Its test controls may choose headers, body, latency, status, thrown errors, and cancellation acknowledgement without changing the executor's call shape.",
            "Do not let the script bypass provider permits or translation boundaries. A shortcut there can make the test pass while the production path leaks capacity or misclassifies the result."
          ]
        },
        {
          title: "Test invariants across many orderings",
          paragraphs: [
            "A and B can complete near the same moment that the caller cancels, the deadline expires, or a hedge becomes eligible. Table-driven cases should reorder those events to expose code that assumes one convenient schedule.",
            "Property or fuzz tests can generate more valid sequences from the same contract. Across all of them, each permit releases once, at most one response commits, and no attempt begins after its deadline."
          ]
        },
        {
          title: "Hidden tests should change timing, not the contract",
          paragraphs: [
            "A useful hidden case varies latency, failure order, capacity, and cancellation while preserving the documented provider and request interfaces. It checks whether the implementation owns concurrency correctly under another valid schedule.",
            "An unstated score formula or secret status code tests guessing instead of engineering. Publish policy inputs and keep hidden coverage focused on deadline, cleanup, capacity, and commit invariants."
          ]
        }
      ],
      decisionTable: {
        title: "Deterministic cases that prove gateway invariants",
        columns: ["Case", "Controlled events", "Required assertion"],
        rows: [
          ["Simple success", "A returns valid response", "One commit and all permits released"],
          ["Fallback", "A fails, B succeeds", "Same deadline, two attempt IDs, correct health samples"],
          ["Delayed hedge", "A pending, B wins", "Caps hold and A cancellation is neutral"],
          ["Caller cancellation", "Caller exits while A runs", "Transport cancelled and no permit remains"],
          ["Queue overflow", "Active and waiting bounds fill", "Next arrival rejected before provider work"],
          ["Queued cancellation", "Waiting caller exits", "Queue node removed with no provider sample"],
          ["Recovery probe", "Cooldown expires under concurrency", "Exactly one half-open probe starts"],
          ["Thrown cleanup error", "Adapter throws after acquire", "Release still occurs once"]
        ]
      },
      diagram: {
        type: "swimlane",
        title: "The virtual clock orders every ownership event",
        caption: "The test controls events in the clock lane and verifies their effects in the request and permit lanes.",
        lanes: [
          { label: "Clock", items: ["t=0 start A", "t=50 run hedge callback", "t=75 finish B"] },
          { label: "Logical request", items: ["Admit r23", "Hold one app permit", "Commit B once", "Return response"] },
          { label: "Attempts", items: ["Acquire and start A", "Acquire and start B", "Cancel A neutrally", "Record B success"] },
          { label: "Cleanup", items: ["Release A", "Release B", "Release app permit", "Assert zero owners"] }
        ]
      },
      interview: {
        prompt: "Show how you would test deadlines, concurrency caps, hedging, and permit cleanup without sleeps or real provider endpoints.",
        answerPoints: [
          "Inject a virtual monotonic clock and scripted providers through production interfaces.",
          "Record acquire, queue, start, finish, cancel, release, health update, and response commit events.",
          "Hold attempts open to create overlap and assert observed peak active counts.",
          "Fill active and queue bounds, then prove the next request rejects before provider work.",
          "Reorder completions and cancellation to test valid concurrent event sequences.",
          "Assert at most one response commit, neutral intentional cancellation, and one release per acquired permit.",
          "Keep hidden tests within the published contract while varying timing and failures."
        ],
        followups: [
          "How do you prove a semaphore cap of two rather than reading its constructor?",
          "What should the ledger contain after a queued caller cancels?",
          "How do you test that only one half-open probe starts?",
          "Which event order can expose a double release?"
        ]
      }
    },

    "benchmark-defense": {
      contextTitle: "A final claim needs evidence, cost, and a known limit",
      context: [
        "The final claim should be narrow enough to prove. Connect one stated goal to one policy change, one deterministic failure test, and one comparable benchmark row, then name the added state or provider work that paid for the improvement.",
        "Walk the implementation in the same order as a request: validation, admission, selection, attempt execution, classification, state update, response commit, and cleanup. The interviewer can then connect each benchmark number to the boundary that produced it.",
        "Success, latency, and cost may move in different directions. Choose against an explicit objective and constraint instead of inventing a universal score, then identify the first production concern outside the single-process prototype."
      ],
      walkthrough: {
        title: "Present the gateway in seven connected claims",
        intro: "The candidate has a simple baseline and an adaptive policy measured under the same provider phases and 500 ms caller deadline.",
        steps: [
          { title: "Restate the contract", text: "Name provider interchangeability, buffered or streamed response behavior, the commit point, and the one logical deadline." },
          { title: "Show the baseline", text: "Point to the runnable simple router and its preserved benchmark row before discussing adaptive state." },
          { title: "Trace one healthy request", text: "Walk validation, application permit, provider selection, attempt permit, reusable client, state update, response, and cleanup in code order." },
          { title: "Trace one failure", text: "Use the deterministic A-failure and B-fallback ledger to show remaining deadline, attempt identities, health classification, and release." },
          { title: "Explain the one policy change", text: "Describe recent evidence, eligibility, bounded exploration, and the exact heuristic without claiming its constants are universal." },
          { title: "Compare the rows", text: "State workload, seed, caps, success, p95, p99, queueing, drops, and calls per request for baseline and candidate." },
          { title: "Name cost and next boundary", text: "State added attempts and local state, then hand shared provider quotas, fleet health hints, configuration rollout, and telemetry durability to the production design round." }
        ],
        takeaway: "The explanation is credible when every improvement can be traced to code, a deterministic invariant, and a controlled result row."
      },
      workedExample: {
        title: "Choose a policy under an explicit attempt-cost limit",
        setup: "The service requires at least 99.5% success, prefers p95 below 200 ms, and allows at most 1.15 provider calls per logical request.",
        facts: [
          { label: "Round robin", value: "99.2%, p95 220 ms, p99 430 ms, 1.04 calls" },
          { label: "Adaptive", value: "99.7%, p95 170 ms, p99 310 ms, 1.08 calls" },
          { label: "Adaptive plus hedge", value: "99.8%, p95 150 ms, p99 220 ms, 1.24 calls" },
          { label: "Drops", value: "0 for all three" },
          { label: "Cap violations", value: "0 for all three" }
        ],
        steps: [
          "Round robin fails the success objective and the preferred p95 even though its provider cost is lowest.",
          "Adaptive meets success and p95 objectives while remaining below the 1.15 attempt-cost limit.",
          "Adaptive plus hedge improves every latency percentile and success slightly, but 1.24 calls per request violates the stated cost constraint.",
          "The current decision selects adaptive and records the hedge row as evidence for a future policy with a smaller tail-only budget.",
          "The defense names the constraint that rejected the fastest row instead of calling the lower latency automatically better."
        ],
        result: "Adaptive wins under the declared objective because it meets reliability and latency targets without exceeding the attempt-cost bound."
      },
      explanations: [
        {
          title: "Show cleanup where the benchmark cannot",
          paragraphs: [
            "An aggregate benchmark can look successful while a rare ordering double-releases a permit, leaves an orphaned task, or updates health after cancellation. Pair throughput and latency results with deterministic lifecycle cases.",
            "Use the event ledger and peak-active assertions to prove concurrency ownership. Low latency by itself says nothing about cleanup on the paths that did not win."
          ]
        },
        {
          title: "Keep limitations concrete",
          paragraphs: [
            "Name the production boundary that the prototype actually reaches. Shared provider quota, cross-replica health, credential rotation, configuration rollback, durable audit records, and stream draining each require a different follow-up design.",
            "Choose the first boundary implied by the code or benchmark. If local caps multiply across replicas, for example, the next design must preserve one hard provider-account limit across the fleet."
          ]
        },
        {
          title: "Delete code that cannot be defended",
          paragraphs: [
            "A generated helper may look reusable while it duplicates state, hides cleanup, or lacks a test. Every such layer makes the request path harder to inspect under interview time pressure.",
            "Keep an abstraction only when you can name its owner, input, output, failure behavior, and evidence. Delete the rest before the final walkthrough."
          ]
        }
      ],
      decisionTable: {
        title: "Evidence structure for the final walkthrough",
        columns: ["Claim", "Evidence", "Cost or limit"],
        rows: [
          ["Requests preserve one contract", "Adapter fixtures and commit-point test", "Provider capability drift remains a rollout concern"],
          ["Deadline is end to end", "Virtual-clock queue and fallback trace", "Cleanup reserve reduces usable provider time"],
          ["Caps hold under overlap", "Observed peak counts and queue-overflow case", "Local caps multiply across replicas"],
          ["Adaptive routing reacts", "Failure-phase share and health timeline", "Recent evidence adds mutable state"],
          ["Recovery remains possible", "Stale-provider exploration test", "Probe traffic spends capacity"],
          ["Candidate improves objective", "Comparable baseline and candidate rows", "Attempts per request or cost may rise"],
          ["Prototype has a production path", "Named state ownership boundary", "Coordination must not enter every request"]
        ]
      },
      diagram: {
        type: "branch",
        title: "A policy decision joins behavior and measurement",
        caption: "Neither code nor metrics supports the final claim alone; the chosen policy must satisfy both branches under stated constraints.",
        source: "Candidate policy",
        branches: [
          { label: "Deterministic behavior", note: "Deadline, caps, cleanup, recovery, and one commit" },
          { label: "Controlled measurement", note: "Success, tails, queueing, drops, share, and attempt cost" }
        ],
        destination: "Accept, reject, or revise"
      },
      interview: {
        prompt: "Walk me through your final gateway and defend why the chosen strategy is better than the baseline.",
        answerPoints: [
          "Restate the request equivalence, streaming, commit, and deadline assumptions.",
          "Preserve and show the simple baseline before the adaptive policy.",
          "Trace one healthy request and one A-failure to B-success path in code order.",
          "Show deterministic evidence for caps, cancellation, permit cleanup, recovery, and one response commit.",
          "Compare baseline and candidate under the same workload, seed, caps, and measurement rules.",
          "State success, p95, p99, queueing, drops, provider share, and attempts per request.",
          "Choose against explicit objectives and constraints, then name the first production boundary."
        ],
        followups: [
          "Why did you reject the policy with the lowest p99?",
          "Which test proves that a losing hedge released its permit?",
          "What changes when this process becomes fifty replicas?",
          "Which generated code did you remove and why?"
        ]
      }
    },

    "rehearsal-coding": {
      contextTitle: "The rehearsal should produce code, measurements, and a spoken defense",
      context: [
        "Run the rehearsal through a real endpoint scaffold backed by scripted providers. The timer should reveal the same checkpoints as the lesson sequence, while the simple baseline remains runnable after every stage.",
        "Score the behavior before the presentation. Check request correctness, one total deadline, observed capacity bounds, cancellation cleanup, failure reaction, recovery traffic, and comparable benchmark rows; assess communication only after those technical checks finish.",
        "The debrief should stop at the first broken invariant or unsupported claim. A smaller gateway with measured behavior gives better interview evidence than a feature-rich gateway with hidden lifecycle failures."
      ],
      walkthrough: {
        title: "Run the full coding round from blank branch to defense",
        intro: "The mock starts with two scripted provider endpoints, a benchmark runner, public request fixtures, and failing lifecycle tests.",
        steps: [
          { title: "Minutes 0 to 7: write before implementing", text: "Record equivalence, streaming, commit, failure classes, deadline, caps, target metrics, and the commands that run tests and benchmarks." },
          { title: "Minutes 7 to 22: establish one-provider correctness", text: "Expose the endpoint, validate the request, reuse one provider client, pass the absolute deadline, and make the first deterministic success case pass." },
          { title: "Minutes 22 to 37: bound the request path", text: "Add application admission, provider permits, bounded waiting, B fallback, caller cancellation, and event-ledger assertions for release." },
          { title: "Minutes 37 to 52: react and relearn", text: "Add classified health, recent estimates, eligibility, deterministic exploration, and one recovery case without changing the handler or provider client contract." },
          { title: "Minutes 52 to 64: compare policies", text: "Run the simple and adaptive routers under identical provider phases, then write the hypothesis, parameters, result, and decision in the notebook." },
          { title: "Minutes 64 to 75: stop feature work", text: "Run overlap and cancellation cases, simplify ownership, verify the final benchmark, and prepare a healthy path, failure path, cost, limitation, and production handoff." }
        ],
        takeaway: "The mock is complete when the code runs, the invariants are observed, the comparison is reproducible, and the candidate can explain every retained boundary."
      },
      workedExample: {
        title: "Repair a task leak at minute 45",
        setup: "The baseline and adaptive selector work, but a test shows one A attempt remains active after B wins a hedge and the current branch has 30 minutes left.",
        facts: [
          { label: "Time", value: "Minute 45" },
          { label: "Functional result", value: "B returns the client response" },
          { label: "Broken invariant", value: "A task and permit remain owned" },
          { label: "Planned next feature", value: "Cooldown and slow start" },
          { label: "Baseline status", value: "Passing without hedge" }
        ],
        steps: [
          "Stop cooldown work because a leaked attempt can exhaust capacity and invalidates every later latency result.",
          "Use the event ledger to find the path where B commits but A never receives cancellation or release.",
          "Route winner, caller cancellation, timeout, and error through one idempotent attempt-finalization helper, then rerun reordered completion cases.",
          "Preserve the non-hedged baseline if the fix remains uncertain, because it is still a valid final artifact.",
          "Resume the benchmark only after peak-active and final permit assertions pass under the hedge case.",
          "Explain in the debrief that lifecycle correctness received priority over another routing feature."
        ],
        result: "The repaired or deliberately removed hedge leaves a bounded gateway and defensible benchmark, while unfinished cooldown work becomes a named next step."
      },
      explanations: [
        {
          title: "Objective checks come before self-scoring",
          paragraphs: [
            "The runner should exercise the request path rather than ask whether it feels complete. Send valid and invalid requests, change provider latency and failures, exceed caps, cancel callers, reorder completions, recover A, and verify benchmark metadata.",
            "After those results exist, use a separate rubric for contract clarity, trade-off reasoning, code walkthrough, and follow-up answers. Confidence is not evidence that the technical behavior holds."
          ]
        },
        {
          title: "Reveal follow-ups at checkpoints",
          paragraphs: [
            "Keep later prompts hidden until their checkpoint arrives. The candidate must establish a baseline before the rehearsal introduces failure, recovery, overload, and cleanup challenges.",
            "Each reveal should modify the same provider script with one new condition. The exercise then tests whether the existing design absorbs change instead of replacing it with an unrelated puzzle."
          ]
        },
        {
          title: "Debrief the first unsupported claim",
          paragraphs: [
            "Compare the spoken walkthrough with the tests and notebook rows. Find the earliest claim that lacked code, deterministic evidence, or a controlled measurement.",
            "Build the next rehearsal around that gap. Permit cleanup under cancellation or recovery traffic after cooldown deserves a focused rerun, not another unchanged pass through all 75 minutes."
          ]
        }
      ],
      decisionTable: {
        title: "Coding mock evidence rubric",
        columns: ["Area", "Passing evidence", "Failure sign"],
        rows: [
          ["Contract", "Validation, identities, commit point, and error mapping are explicit", "Every non-200 becomes provider failure"],
          ["Request lifecycle", "One deadline and one final response under all paths", "Fresh timeout per attempt or double response"],
          ["Capacity", "Observed peaks and queue bounds stay within configuration", "Constructor values are the only proof"],
          ["Cleanup", "Every acquired permit has one release in the ledger", "Losing or cancelled work remains active"],
          ["Adaptation", "A failure shifts traffic and bounded exploration restores it", "Current winner receives all future samples"],
          ["Measurement", "Baseline and candidate share workload, seed, caps, and rules", "Only a final latency number is shown"],
          ["Communication", "Healthy path, failure path, trade-off, and limit are explained", "Components are listed without behavior"]
        ]
      },
      diagram: {
        type: "timeline",
        title: "One rehearsal, six inspectable artifacts",
        caption: "Each checkpoint leaves an artifact the interviewer can run or review before the next stage begins.",
        events: [
          { label: "0 to 7", note: "Contract and command notebook" },
          { label: "7 to 22", note: "Working endpoint and success test" },
          { label: "22 to 37", note: "Bounds, fallback, and cleanup ledger" },
          { label: "37 to 52", note: "Adaptive selection and recovery test" },
          { label: "52 to 64", note: "Comparable benchmark rows" },
          { label: "64 to 75", note: "Final suite and spoken defense" }
        ]
      },
      interview: {
        prompt: "Run a complete 75-minute implementation of the two-provider model gateway, then defend the code and benchmark as if the interviewers will review every retained line.",
        answerPoints: [
          "Write contract, failure, deadline, capacity, and measurement assumptions before implementation.",
          "Produce a runnable endpoint and deterministic baseline early.",
          "Prove application, queue, and provider bounds through observed overlap.",
          "Classify health evidence and show both failure reaction and recovery traffic.",
          "Preserve one simple policy and compare one adaptive change under identical conditions.",
          "Repair lifecycle violations before adding another routing mechanism.",
          "Finish with a code-order walkthrough, benchmark decision, added cost, known limit, and production next step."
        ],
        followups: [
          "Provider A becomes flaky at minute 30. Show the next ten routing decisions.",
          "Provider A recovers. Prove it receives bounded traffic again.",
          "More callers arrive than every cap can admit. Show the exact overload result.",
          "The client cancels while two attempts exist. Show every cancellation and release event.",
          "Your fastest policy exceeds the attempt-cost limit. Which policy do you ship and why?"
        ]
      }
    }
  };

  window.DECAGON_GUIDES = {
    ...(window.DECAGON_GUIDES || {}),
    ...entries
  };
})();
