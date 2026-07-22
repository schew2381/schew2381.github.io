(() => {
  "use strict";

  const entries = {
    "crawler-requirements": {
      contextTitle: "A crawler prompt becomes solvable when every number has an owner",
      context: [
        "Crawl one billion pages sounds precise, but it can describe a one-time archive, a daily search index, or a customer-scoped compliance product. Ask which URLs are in scope, how quickly known pages must be revisited, which site policies apply, which pages need rendering, and what output the downstream consumer accepts.",
        "Every answer should change the design. Freshness creates recrawl deadlines, politeness constrains each site's request rate, rendering creates a separate CPU and memory class, and retention determines which bodies, documents, or link histories need versions.",
        "Average page throughput is only the starting rate. Peak demand, retries, redirects, fetch latency, parser service rate, eligible authority count, and a bounded downstream slowdown determine the concurrency and durable buffering needed to keep pod memory from becoming a queue.",
        "Write every invented number as an assumption beside the component that uses it. Then name the production measurement that would replace it, so the interviewer can trace each estimate into a scheduling, admission, or storage decision."
      ],
      walkthrough: {
        title: "Turn the prompt into six design constraints",
        intro: "Use this sequence before naming databases, queues, or worker types so the architecture follows the workload.",
        steps: [
          {
            title: "Define the crawl boundary",
            text: "Ask whether scope is the public web, a domain allowlist, customer-supplied seeds, or a known recrawl corpus. This decides who may create work and which redirects or discoveries must be rejected."
          },
          {
            title: "Define useful output",
            text: "Ask whether the consumer needs raw bytes, parsed text, metadata, a link graph, screenshots, or change events. Each output has a different key, update rate, and retention policy."
          },
          {
            title: "Define freshness and coverage",
            text: "A coverage target favors new discoveries, while a freshness target reserves capacity for known URLs with revisit deadlines. Write both objectives because one priority queue cannot optimize an unstated trade-off."
          },
          {
            title: "Classify the workload",
            text: "Separate ordinary HTTP fetches, large documents, and browser-rendered pages. Estimate their latency, byte, CPU, memory, timeout, and isolation envelopes independently."
          },
          {
            title: "Compute the rate envelope",
            text: "Convert pages per day to average fetches per second, then apply peak and attempt-amplification factors. Use Little's Law for mean in-flight work and a separate tail assumption for safe concurrency."
          },
          {
            title: "Check site-limited capacity",
            text: "Multiply required attempt rate by the minimum interval between starts to estimate how many independent authorities must be active when each authority supplies one start per interval. Add per-authority concurrency explicitly if the policy allows it."
          },
          {
            title: "Compute bytes and stage rates",
            text: "Size network ingress, raw-body storage, metadata, extracted links, replication, and retained versions. Compare fetch rate with parser and indexer service rates so the first expected bottleneck is visible."
          }
        ],
        takeaway: "The first architecture sketch should be a consequence of the requirement sheet, not a collection of familiar infrastructure boxes."
      },
      workedExample: {
        title: "Size a 100 million page daily crawl",
        setup: "Assume 100 million accepted pages per day, a three-times peak, 15 percent extra attempts from retries and redirects, a 200 KiB mean body, 400 ms mean fetch time, a five-second start gap per authority, 30 days of raw retention, and two stored replicas.",
        facts: [
          { label: "Accepted pages", value: "100,000,000 per day" },
          { label: "Peak factor", value: "3x" },
          { label: "Attempt amplification", value: "1.15x" },
          { label: "Mean body", value: "200 KiB" },
          { label: "Mean fetch", value: "400 ms" },
          { label: "Authority gap", value: "5 seconds" }
        ],
        steps: [
          {
            title: "Find average accepted throughput",
            text: "100,000,000 divided by 86,400 is about 1,157 accepted pages per second. Keep this number separate from physical attempts because retries and redirects consume fetch capacity without creating another accepted page."
          },
          {
            title: "Find peak attempt rate",
            text: "1,157 times the three-times peak and 1.15 attempt factor is about 3,993 attempts per second. Admission, DNS, connections, and response budgets must survive this physical rate."
          },
          {
            title: "Estimate mean network concurrency",
            text: "At 400 ms mean fetch time, Little's Law gives about 1,597 attempts in flight at peak. This is a mean, so provider timeouts and observed latency percentiles still determine the configured ceiling."
          },
          {
            title: "Estimate active authority supply",
            text: "With one start every five seconds, one authority supplies 0.2 starts per second. Sustaining 3,993 peak attempts therefore requires roughly 19,965 independently active authorities, unless the politeness policy permits additional concurrency or a shorter interval."
          },
          {
            title: "Estimate raw bytes",
            text: "100 million bodies at 200 KiB produce about 20.48 TB of raw ingress per day. Thirty days with two replicas requires about 1.23 PB before metadata, indexes, extracted links, temporary uploads, and version overhead."
          },
          {
            title: "Expose the next missing estimate",
            text: "If ten percent of accepted pages need a four-second browser render, the peak render class receives roughly 347 tasks per second and averages about 1,389 concurrent tasks. That result is large enough to force a separate quota, queue, and isolation design."
          }
        ],
        result: "The arithmetic reveals three independent capacity questions: physical fetch attempts, authority-limited dispatch supply, and a much more expensive rendered-page class."
      },
      explanations: [
        {
          title: "Why global workers can remain idle",
          paragraphs: [
            "Fetch pods can sit idle while millions of URLs remain queued. If every authority is waiting for its next legal start time, the scarce resource is eligible sites rather than worker CPU, so more replicas cannot create polite capacity.",
            "The shape resembles a Kubernetes controller with work that is not yet eligible for reconciliation. The crawler also has to coordinate each site's eligibility clock across replicas so two workers do not spend the same rate budget."
          ]
        },
        {
          title: "Why averages need explicit companions",
          paragraphs: [
            "Average QPS sizes the steady data path, while the peak factor sizes admission and short queues. Mean latency estimates ordinary in-flight work; tail latency and deadlines show how much concurrency can accumulate during a slow period.",
            "Keep retries and redirects as a visible attempt multiplier instead of hiding them inside page throughput. When a remote site starts failing, the multiplier shows how crawler-generated work can amplify the original demand."
          ]
        },
        {
          title: "Why storage is several contracts",
          paragraphs: [
            "A raw body is large and usually immutable, while one URL accumulates smaller fetch records over time. Parsed documents may be replaced and discovery edges may expire independently, so a single storage box hides both access patterns and idempotency keys.",
            "Estimate a byte rate and retention window for each record class. Those numbers may place bodies in object storage, fetch metadata in a keyed store, and links in a batch or streaming pipeline without forcing one database to serve every shape."
          ]
        }
      ],
      decisionTable: {
        title: "Questions that must change the design",
        columns: ["Requirement", "Derived constraint", "Architecture consequence", "Production signal"],
        rows: [
          ["Coverage", "New URLs must not be silently lost", "Exact dedupe after any approximate prefilter", "Accepted unique URLs and false-positive audit rate"],
          ["Freshness", "Known URLs have revisit deadlines", "Recrawl priority and reserved capacity", "Freshness lag percentiles"],
          ["Politeness", "Each site has an independent dispatch budget", "Per-site ready times with shared-destination guards", "Start interval and concurrency violations"],
          ["Rendering", "Some tasks consume much more CPU and memory", "Separate queue, worker pool, quota, and network sandbox", "Render queue age and resource seconds"],
          ["Durability", "Worker loss must replay bounded work", "Expiring leases and idempotent stage writes", "Lease expiry and replay counts"],
          ["Retention", "Bytes remain for a stated window", "Versioned storage with lifecycle policy", "Stored bytes by object class and age"]
        ]
      },
      diagram: {
        type: "swimlane",
        title: "Requirements become owned constraints",
        caption: "Each lane ends in a measurable contract that can be defended during the interview.",
        lanes: [
          { label: "Product", items: ["Scope and seeds", "Coverage and freshness", "Output and retention"] },
          { label: "Scheduler", items: ["Accepted URL rate", "Authority eligibility", "Recrawl priority"] },
          { label: "Workers", items: ["Fetch and render classes", "Concurrency and deadlines", "Bounded stage handoffs"] },
          { label: "Storage", items: ["Bodies and versions", "Fetch records", "Parsed data and links"] },
          { label: "Operations", items: ["Peak headroom", "Policy violations", "Freshness and cost"] }
        ]
      },
      interview: {
        prompt: "Before drawing the crawler, ask for the requirements and derive the first capacity numbers aloud.",
        answerPoints: [
          "State scope, seed sources, and redirect boundaries.",
          "Separate coverage from freshness and explain how they compete for dispatch capacity.",
          "Classify ordinary fetches, large bodies, and rendered pages.",
          "Calculate average accepted QPS, peak attempt QPS, and mean in-flight attempts.",
          "Calculate active-authority supply under the stated politeness interval.",
          "Estimate raw bytes, retained bytes, metadata, links, and replication separately.",
          "Name the assumption with the largest uncertainty and the production signal that would replace it."
        ],
        followups: [
          "What changes if ninety percent of the target URLs belong to one authority?",
          "What changes if ten percent of pages require a four-second browser render?",
          "How do you reserve recrawl capacity when new discovery grows without a bound?",
          "Which queue fills first if parsing runs twenty percent slower than fetching?"
        ]
      }
    },

    "crawler-url-path": {
      contextTitle: "One URL crosses several ownership and durability boundaries",
      context: [
        "Follow one seed URL as a durable record whose state changes, rather than as a string passed through one large queue. The scheduler owns when it may run, the fetcher owns one network attempt, the body store owns received bytes, and the parser owns extracted metadata plus new references.",
        "Each handoff needs a point after which the previous owner may forget its work. If that acknowledgment occurs before the next required state is durable, a crash can remove the URL or its discovered links from the crawl.",
        "Acknowledging later prevents loss but permits replay after a crash. Stable keys make that replay safe by converging duplicate bodies, edges, and recrawl updates on the same logical records.",
        "Keep the normalized fetch URL, physical fetch attempt, stored representation version, and discovery edge as separate identities. Retries, debugging, content history, and recrawl scheduling ask different questions of those records."
      ],
      walkthrough: {
        title: "Trace the state transition before drawing the fleet",
        intro: "Number these boundaries on the whiteboard and name the owner, durable write, retry point, and idempotency key at each one.",
        steps: [
          {
            title: "Parse and normalize the candidate",
            text: "Resolve a relative reference against the document's effective base URL, parse it with one standards-based implementation, remove the fragment from fetch identity, and apply only conservative normalization."
          },
          {
            title: "Apply admission policy",
            text: "Check scheme, authority, port, crawl scope, URL budget, and exact dedupe before creating durable work. Record why a candidate was accepted or rejected when the product needs explainable coverage."
          },
          {
            title: "Assign site ownership",
            text: "Map the admitted URL to the scheduler that owns its robots state, next legal start, failure backoff, and URL queue. The durable record now exists even if no worker is eligible."
          },
          {
            title: "Lease an eligible URL",
            text: "The scheduler grants temporary ownership with a lease identifier, attempt number, and expiry. A worker crash returns the URL to eligible work after expiry rather than deleting it."
          },
          {
            title: "Perform one bounded fetch",
            text: "Resolve and validate DNS, enforce address policy, connect with deadlines, repeat checks on redirects, stream at most the allowed bytes, and write a fetch record for the terminal outcome."
          },
          {
            title: "Make the body durable",
            text: "Write accepted bytes under a content digest or version key before acknowledging the network stage. The queue to parsing should carry a stable body reference instead of an unbounded byte array."
          },
          {
            title: "Parse and admit discoveries",
            text: "Parse bounded content, emit metadata and links, then resolve, normalize, check, deduplicate, and durably admit discovered URLs. Acknowledge the parse task only after required discoveries and metadata can replay safely."
          },
          {
            title: "Commit recrawl state",
            text: "Point the URL record at the accepted representation, store validators and timing, and calculate the next revisit time from freshness policy plus observed change history."
          }
        ],
        takeaway: "A normal request trace is complete only when every arrow names its durable boundary and every crash has a replay owner."
      },
      workedExample: {
        title: "Follow one catalog URL through a parser crash",
        setup: "A seed page contains `/a/../catalog?b=2&a=1#reviews`, and the catalog page later links to `/item/42`. The parser worker dies after extracting the item link but before finishing its task.",
        facts: [
          { label: "Base URL", value: "https://Shop.Example/start" },
          { label: "Reference", value: "/a/../catalog?b=2&a=1#reviews" },
          { label: "Fetch identity", value: "https://shop.example/catalog?b=2&a=1" },
          { label: "Body digest", value: "sha256:7bd..." },
          { label: "Parse task", value: "URL key plus body digest" }
        ],
        steps: [
          {
            title: "Create the URL key",
            text: "The resolver removes the dot segment, lowercases scheme and host, and removes the fragment because it is not sent in HTTP. It preserves the query order because the server may treat `b=2&a=1` differently from a reordered query."
          },
          {
            title: "Admit durable work",
            text: "An exact conditional insert creates the discovered URL record with its source edge. If another worker discovers the same fetch identity, the insert returns the existing record instead of creating competing work."
          },
          {
            title: "Lease and fetch",
            text: "The frontier leases the record as attempt 1. The fetcher writes the response body under `sha256:7bd...` and appends a fetch record that includes requested URL, final URL, connected address, status, validators, timing, and body reference."
          },
          {
            title: "Queue parsing by reference",
            text: "The parse task contains the URL key and body digest, so replay reads the same bytes without repeating the external request. The network permit is already released."
          },
          {
            title: "Crash before acknowledgment",
            text: "The first parser extracts `/item/42` but dies before the discovered URL is durably admitted. Its parse lease expires, so another parser receives the same task and repeats deterministic extraction from the stored body."
          },
          {
            title: "Commit idempotently",
            text: "The second parser conditionally inserts the normalized item URL and a source-to-target edge, then records the parse version and acknowledges. Repeated inserts use stable keys, so recovery changes attempts without multiplying logical discoveries."
          }
        ],
        result: "The catalog body is fetched once, parsing may run more than once, and the item link cannot disappear between parser acknowledgment and durable admission."
      },
      explanations: [
        {
          title: "Acknowledgment belongs after the durable boundary",
          paragraphs: [
            "A queue acknowledgment tells the previous owner that it may forget the task. Send it only after the next required state is durable, or keep the original lease until a transaction or outbox makes the handoff recoverable.",
            "For discovery, the loss window opens after the parser finds links and closes when durable frontier state accepts them. Replaying the parser is easier to reason about than trying to preserve an in-memory link list through a pod exit."
          ]
        },
        {
          title: "Fetch identity and representation identity differ",
          paragraphs: [
            "One normalized URL can return different bodies over time, and several URLs can return the same body. The URL key owns schedule and fetch history, while the content digest identifies immutable bytes for storage dedupe.",
            "Each physical attempt also needs an identity because retries have separate status, latency, peer address, and terminal reason. Collapsing attempts into the URL record erases the evidence needed to diagnose timeouts and retry storms."
          ]
        },
        {
          title: "Redirects restart the trust decision",
          paragraphs: [
            "An allowed seed does not make its redirect target safe. Treat the new location as untrusted input, resolve it against the current URL, and repeat scope, scheme, DNS, destination, scheduling, and robots checks before another connection.",
            "Preserve the complete redirect chain on the fetch record. An operator can then explain the final destination and the policy decision made before every hop."
          ]
        }
      ],
      decisionTable: {
        title: "Durable handoffs for one URL",
        columns: ["Boundary", "Durable before acknowledgment", "Retry owner", "Stable key"],
        rows: [
          ["Discovery to frontier", "Normalized URL record and required source edge", "Discovering parser or admission outbox", "Normalized fetch URL"],
          ["Frontier to fetcher", "Lease with attempt and expiry", "Frontier after lease expiry", "URL key plus lease ID"],
          ["Fetcher to body store", "Complete bounded body or explicit terminal fetch record", "Fetcher while lease remains valid", "Attempt ID and body digest"],
          ["Body store to parser", "Body reference and parse task", "Parse queue after lease expiry", "URL key plus body digest plus parser version"],
          ["Parser to frontier", "Discovered URLs and edges", "Parser replay", "Target URL key plus source and parse version"],
          ["Parser to recrawl", "Accepted representation, validators, and next revisit", "Commit retry", "URL key plus fetch version"]
        ]
      },
      diagram: {
        type: "state-machine",
        title: "One URL survives worker loss",
        caption: "Forward transitions require durable state, while lease expiry returns abandoned work to an earlier eligible state.",
        states: [
          { label: "Discovered", note: "normalized key and source edge are durable" },
          { label: "Eligible", note: "site policy and ready time permit dispatch" },
          { label: "Leased", note: "one worker owns a bounded attempt until expiry" },
          { label: "Fetched", note: "attempt record and body reference are durable" },
          { label: "Parsed", note: "metadata and discoveries are durable" },
          { label: "Scheduled", note: "validators and next revisit are committed" }
        ],
        transitions: [
          "Discovered to Eligible when robots and ready-time policy allow",
          "Eligible to Leased through an expiring compare-and-set lease",
          "Leased to Eligible when the lease expires without a terminal record",
          "Leased to Fetched after a bounded terminal fetch is recorded",
          "Fetched to Parsed after discoveries and metadata are durable",
          "Parsed to Fetched when parser replay is required",
          "Parsed to Scheduled after recrawl state is committed",
          "Scheduled to Eligible when the next revisit time arrives"
        ]
      },
      interview: {
        prompt: "Trace one seed URL through the crawler and state exactly what is durable before every acknowledgment.",
        answerPoints: [
          "Resolve relative references before conservative normalization.",
          "Separate URL, attempt, representation, and discovery-edge identities.",
          "Durably admit the URL before the discoverer forgets it.",
          "Use an expiring lease so a dead fetcher cannot lose work.",
          "Store a bounded body before asynchronous parsing so parser retries do not repeat the fetch.",
          "Admit required discovered links durably before acknowledging the parse task.",
          "Use stable keys and idempotent writes because delivery is at least once.",
          "Commit validators and the next revisit after the accepted representation is known."
        ],
        followups: [
          "What happens if the fetcher writes the body but dies before acknowledging?",
          "What happens if two pages discover the same URL at the same time?",
          "Which checks repeat when a response redirects to another authority?",
          "How do you preserve an old body while a new fetch is being parsed?"
        ]
      }
    },

    "crawler-fetch-parse-store": {
      contextTitle: "Independent stages turn overload into a bounded state",
      context: [
        "Fetching, storing, parsing, and indexing consume different resources and fail independently. If one worker owns all four, a slow parser keeps sockets and site permits occupied while fetched bodies accumulate in process memory.",
        "Place durable, bounded handoffs between stages and give each stage its own concurrency ceiling. A fetcher can stream into a size-limited sink, record the terminal fetch, release network capacity, and enqueue a stable body reference instead of placing the full body in memory for the parser.",
        "A full downstream boundary must change upstream admission. The scheduler can stop releasing work, use a deliberately sized durable spill buffer, or reject lower-priority URLs under a stated policy; observing queue growth without changing admission is not backpressure.",
        "Kubernetes can add parser pods only while their inputs and outputs have usable capacity. More replicas cannot repair a storage sink or parser class whose total service rate remains below the incoming rate."
      ],
      walkthrough: {
        title: "Give every stage a resource envelope",
        intro: "For each box, state its permit, queue bound, durable payload, full behavior, and retry owner.",
        steps: [
          {
            title: "Lease only dispatchable work",
            text: "The frontier issues work only when a fetch permit, authority budget, destination budget, and downstream body-ingress budget are available. This prevents accepted network work from outrunning the next durable boundary."
          },
          {
            title: "Stream under layered byte and time limits",
            text: "Apply connect, header, body-idle, and total deadlines, plus compressed-byte and decompressed-byte ceilings. A small compressed response must not expand without a bound inside the parser."
          },
          {
            title: "Commit the fetch result",
            text: "Write an immutable body or a terminal no-body outcome, then append fetch metadata with the exact version reference. The fetch stage is complete when this record can be replayed without another socket."
          },
          {
            title: "Queue a compact parse task",
            text: "Pass the URL key, body reference, media type, and parser version through a bounded durable queue. Queue bytes now scale with task metadata rather than response size."
          },
          {
            title: "Parse hostile bytes in isolation",
            text: "Bound CPU time, input size, tree depth, token count, extracted links, and output bytes. Route browser rendering through a separate pool whose credentials and network cannot reach crawler control systems."
          },
          {
            title: "Commit outputs idempotently",
            text: "Write parsed metadata, content identity, and discovery edges under stable versioned keys. A parser retry should replace or confirm the same logical result instead of appending uncontrolled duplicates."
          },
          {
            title: "Propagate saturation upstream",
            text: "When the parse queue reaches its bound, stop new fetch dispatch or reserve the remaining capacity for urgent recrawls. Record queue age and rejected admission so operators can distinguish intentional pressure from missing workers."
          }
        ],
        takeaway: "A bounded crawler says what stops first and what remains durable when any downstream stage slows to zero."
      },
      workedExample: {
        title: "A parser deficit fills memory in seconds",
        setup: "Fetchers accept 10,000 successful pages per second at 200 KiB each, while parsers sustain 8,000 pages per second. Compare an in-memory body queue with a bounded queue of durable body references.",
        facts: [
          { label: "Fetch rate", value: "10,000 pages per second" },
          { label: "Parse rate", value: "8,000 pages per second" },
          { label: "Deficit", value: "2,000 pages per second" },
          { label: "Mean body", value: "200 KiB" },
          { label: "Reference queue bound", value: "50,000 tasks" },
          { label: "Task reference", value: "about 1 KiB" }
        ],
        steps: [
          {
            title: "Measure the unbounded byte growth",
            text: "The two-thousand-page deficit adds about 409.6 MB of bodies each second. An in-memory queue grows by about 24.6 GB per minute before allocator overhead and decompression."
          },
          {
            title: "Move bytes to the durable fetch boundary",
            text: "Each fetcher streams the body to object storage and enqueues a compact reference only after the body commit succeeds. The same deficit now grows the durable queue by tasks, not pod memory by response bodies."
          },
          {
            title: "Calculate the pressure window",
            text: "A 50,000-task queue absorbs the 2,000-task-per-second deficit for 25 seconds. That is enough for a short disturbance, but it is not a substitute for parser capacity or admission control."
          },
          {
            title: "Stop at the declared boundary",
            text: "At the high-water mark, the frontier stops releasing ordinary fetches and preserves any reserved freshness class. Existing fetches finish into already reserved body-ingress slots, so no accepted body is abandoned."
          },
          {
            title: "Recover without a burst",
            text: "After parser capacity returns, the scheduler raises fetch admission only when queue age and depth fall below a lower watermark. This hysteresis prevents fetchers from repeatedly filling and draining the same boundary."
          }
        ],
        result: "The system turns an unbounded 24.6 GB-per-minute memory failure into a 25-second durable pressure budget with explicit admission behavior."
      },
      explanations: [
        {
          title: "A permit should reserve the next boundary",
          paragraphs: [
            "A fetch permit protects the fetcher's sockets and memory, but it says nothing about whether the body sink can accept another stream. Reserve body-ingress capacity before dispatch, or include a bounded sink wait inside the fetch deadline.",
            "Retries, redirects, and browser renders create additional physical work, so each consumes the corresponding permits. Counting only logical URLs hides the resource expansion that appears during failures and complex pages."
          ]
        },
        {
          title: "Store first when parsing can replay",
          paragraphs: [
            "Persist the bounded raw body before asynchronous parsing when the parser can replay from storage. Network retries and parser retries then become independent, and an incident responder can inspect the exact bytes that caused a parser failure.",
            "The cost is an extra durable handoff and more storage. That cost is usually justified when external fetches are slow, rate-limited, or hard to reproduce; a tiny ephemeral crawl may parse inline, but it still needs an explicit loss and retry contract."
          ]
        },
        {
          title: "Browser rendering is another service class",
          paragraphs: [
            "A browser-rendered page can use far more CPU and memory than an HTTP parser, execute hostile code, and create secondary network requests. Put rendering behind its own admission budget so it cannot consume every ordinary fetch slot.",
            "Run renderers without access to cloud metadata, databases, or control planes. Bound page lifetime, process count, downloaded bytes, subrequests, and output size, then return the resulting document to the same versioned storage and parse path."
          ]
        }
      ],
      decisionTable: {
        title: "Respond to saturation at the owning boundary",
        columns: ["Saturated stage", "Primary signal", "Bounded response", "Resource protected"],
        rows: [
          ["DNS or connect", "Attempt queue age and timeout rate", "Reduce dispatch and back off affected destinations", "Sockets and resolver capacity"],
          ["Body ingress", "Reserved stream slots and byte throughput", "Stop new fetch leases before connecting", "Fetcher memory and storage clients"],
          ["Parse queue", "Depth plus oldest task age", "Pause ordinary fetch admission or use bounded durable spill", "Queue storage and freshness"],
          ["Parser CPU", "Service time and runnable saturation", "Scale within storage and discovery limits", "Node CPU and task latency"],
          ["Discovery admission", "Conditional-write latency and rejection", "Slow parser acknowledgment and stop upstream admission", "Frontier store and exact dedupe"],
          ["Renderer pool", "Memory, process, and task age", "Shed or delay rendered class independently", "Node memory and security boundary"]
        ]
      },
      diagram: {
        type: "swimlane",
        title: "Bytes and ownership move through bounded stages",
        caption: "The durable body reference separates external network work from replayable parsing work.",
        lanes: [
          { label: "Frontier", items: ["Eligible URL", "Reserve downstream budget", "Lease with expiry"] },
          { label: "Fetcher", items: ["DNS and connect", "Bounded response stream", "Terminal attempt record"] },
          { label: "Body store", items: ["Temporary upload", "Atomic version commit", "Stable digest reference"] },
          { label: "Parser", items: ["Read stored body", "Bound resource use", "Emit metadata and links"] },
          { label: "Admission", items: ["Exact URL insert", "Durable discovery edges", "Backpressure to frontier"] }
        ]
      },
      interview: {
        prompt: "The crawler fetches faster than it can parse. Show where bytes wait, how memory stays bounded, and what happens when the parser is unavailable for ten minutes.",
        answerPoints: [
          "Separate fetch, body storage, parse, and discovery into independently bounded stages.",
          "Stream responses under compressed and decompressed byte limits.",
          "Persist a body reference before releasing the fetch result to asynchronous parsing.",
          "Queue compact references rather than full response bodies.",
          "Use queue depth and oldest age to propagate admission pressure to the frontier.",
          "State the durable buffer size and the exact full behavior.",
          "Keep browser rendering in a separate quota and network sandbox.",
          "Use stable version keys so parser replay is idempotent."
        ],
        followups: [
          "What happens to fetch throughput when the object store is unavailable?",
          "How do you avoid an admission burst when parsers recover?",
          "Would you ever parse inline before storing the body?",
          "Which metrics distinguish a slow parser from a slow discovery store?"
        ]
      }
    },

    "crawler-polite-frontier": {
      contextTitle: "The frontier schedules sites first and URLs second",
      context: [
        "A global FIFO can identify the oldest URL while placing an ineligible site at the head of the line. The crawler first needs the site whose next legal start time has arrived, then it can choose a URL from that site's queue.",
        "Keep one durable URL queue per scheduling key and one head entry per key in a ready-time structure. The key owns robots state, next start time, concurrent leases, failure backoff, and URL ordering, so millions of delayed URLs do not crowd out an eligible site.",
        "Give one scheduler generation authority to issue leases for each key, and use a handoff protocol when ownership changes. Consistent hashing chooses a likely owner but does not transfer active leases or prevent two generations from dispatching simultaneously.",
        "Site politeness and destination protection remain separate after that scheduling decision. Several authorities can resolve to one address, so dispatch must also acquire a limiter for the validated destination along with worker, site, and downstream capacity."
      ],
      walkthrough: {
        title: "Derive the frontier data structures",
        intro: "Start from the dispatch predicate, then choose the indexes that make the predicate cheap at high URL counts.",
        steps: [
          {
            title: "Store one deque per site key",
            text: "The deque contains URL records ordered by freshness, priority, discovery depth, or another stated policy. Keeping site work together allows one owner to apply the same robots and delay state."
          },
          {
            title: "Index only each site's head eligibility",
            text: "Put one site entry in a min-heap or timing wheel keyed by `next_allowed_at`, backoff, and ownership readiness. Do not place every URL in the global time index."
          },
          {
            title: "Pop an eligible site fairly",
            text: "When several sites share the earliest time, use a fairness rule such as least recent dispatch or weighted deficit. Remove one URL or a bounded batch without letting a hot site monopolize workers."
          },
          {
            title: "Grant an expiring lease",
            text: "Record site generation, URL key, worker, attempt, and expiry through a conditional write. The site owner can now count active leases and recover work after a worker exit."
          },
          {
            title: "Resolve and acquire destination capacity",
            text: "Resolve according to TTL policy, validate every candidate address, then acquire an address or egress permit independently of the site permit. Release both permits exactly once on every terminal path."
          },
          {
            title: "Advance the site clock",
            text: "Set the next legal start from the actual dispatch time and the selected delay policy. Reinsert the site into the ready structure only if more work remains or a recrawl deadline exists."
          },
          {
            title: "Move ownership with a generation",
            text: "During rebalance, stop new leases on the old generation, transfer durable queue and policy state, then let the new owner start after it observes prior leases or their expiry. This avoids two owners spending the same site budget."
          }
        ],
        takeaway: "The scalable frontier has O(active sites) global scheduling state, while URLs remain in per-site durable queues."
      },
      workedExample: {
        title: "Schedule three sites that share two destinations",
        setup: "Two fetch workers are free. Alpha and beta share IP 93.184.216.34 with an IP cap of one, gamma uses another IP, alpha requires one second between starts, beta requires 500 ms, and gamma first becomes eligible at 250 ms.",
        facts: [
          { label: "Worker slots", value: "2" },
          { label: "Alpha", value: "ready 0 ms, gap 1,000 ms" },
          { label: "Beta", value: "ready 0 ms, gap 500 ms" },
          { label: "Gamma", value: "ready 250 ms, gap 1,000 ms" },
          { label: "Shared IP cap", value: "1 for alpha plus beta" },
          { label: "Fetch duration", value: "200 ms for this trace" }
        ],
        steps: [
          {
            title: "t=0 ms: dispatch alpha",
            text: "Alpha and beta are both site-eligible, so the fairness tie-break selects alpha. Alpha leases one URL, acquires the shared-IP permit, starts fetch A1, and moves its next legal start to 1,000 ms."
          },
          {
            title: "t=0 ms: beta waits for address capacity",
            text: "The second worker exists, but beta cannot acquire the shared-IP permit while A1 is running. Beta remains site-eligible without violating the destination cap."
          },
          {
            title: "t=200 ms: dispatch beta",
            text: "A1 completes and releases the shared-IP permit. Beta starts B1 at 200 ms and moves its next legal start to 700 ms."
          },
          {
            title: "t=250 ms: dispatch gamma",
            text: "Gamma reaches its site-ready time and uses the second worker plus its independent destination permit. Gamma can run alongside B1 because the IP controls are separate."
          },
          {
            title: "t=700 ms: dispatch beta again",
            text: "Beta is eligible before alpha and the shared destination is free, so B2 starts at 700 ms. A global FIFO headed by alpha could have delayed this legal work until alpha's 1,000 ms timestamp."
          },
          {
            title: "t=1,000 ms: dispatch alpha again",
            text: "Alpha becomes eligible for A2. The trace preserves both start gaps and never exceeds one concurrent request to the shared address."
          },
          {
            title: "t=1,050 ms: recover a dead gamma worker",
            text: "If gamma's worker died after leasing G2, the URL remains leased until its visibility deadline. The owner returns it to gamma's queue after expiry under the same generation and dispatch rules."
          }
        ],
        result: "Worker availability alone never authorizes a request. Dispatch is the intersection of site time, site concurrency, destination capacity, ownership, and downstream admission."
      },
      explanations: [
        {
          title: "Why the heap contains sites",
          paragraphs: [
            "A hot site may contribute millions of URLs that share one next legal request time. Indexing every URL by that time wastes memory and requires millions of updates when the site's delay or backoff changes.",
            "Use one heap entry for each active site and point it at a durable site queue. The heap chooses a polite site, then the site-local policy chooses among freshness, revisit, or discovery priorities within that queue."
          ]
        },
        {
          title: "Why address control follows DNS",
          paragraphs: [
            "The current destination address is unknown until the crawler resolves the hostname, and that answer can change after its TTL. Record the address selected for the connection and acquire its limiter before opening the socket.",
            "Many customer hostnames can terminate on one shared service. Their independent site limits can still create one large address-level burst, so the destination guard bounds the aggregate without replacing robots or site-delay state."
          ]
        },
        {
          title: "Why partitioning needs a handoff protocol",
          paragraphs: [
            "Consistent hashing reduces shard movement, but replicas can disagree during membership change or a network partition. An ownership generation, renewable claim, or transactional shard lease must identify which generation may issue new URL leases.",
            "The replacement owner reads durable queue state and either imports active leases or waits for them to expire. Starting from an empty local counter would forget ongoing work and can double a site's concurrency during failover."
          ]
        }
      ],
      decisionTable: {
        title: "The dispatch predicate and its owner",
        columns: ["Control", "State", "Owner", "Unsafe shortcut"],
        rows: [
          ["Site readiness", "Next legal start and failure backoff", "One scheduler generation for the site key", "A global FIFO with sleeping head items"],
          ["Site concurrency", "Active URL leases", "Site scheduler", "A counter local to each fetch pod"],
          ["Destination concurrency", "Active connects or attempts by validated address", "Shared limiter or bounded distributed lease", "Assuming one hostname equals one backend"],
          ["Worker capacity", "Available fetch slots", "Worker pool admission", "Scaling pods without downstream capacity"],
          ["Durable work", "URL state and lease expiry", "Frontier store", "Removing a URL when it is handed to a worker"],
          ["Ownership", "Shard generation and transfer state", "Coordinator or transactional claim", "Relying on consistent hashing alone"]
        ]
      },
      diagram: {
        type: "timeline",
        title: "Two-dimensional politeness over one second",
        caption: "Site clocks select eligible work, while the shared-IP permit serializes alpha and beta independently of worker count.",
        events: [
          { label: "0 ms", note: "A1 starts, alpha next=1,000, shared IP busy" },
          { label: "200 ms", note: "A1 ends and B1 starts, beta next=700" },
          { label: "250 ms", note: "G1 starts on another destination using the second worker" },
          { label: "400 ms", note: "B1 ends and releases the shared-IP permit" },
          { label: "450 ms", note: "G1 ends and releases its worker and destination permits" },
          { label: "700 ms", note: "B2 starts because beta is the earliest eligible shared-IP site" },
          { label: "1,000 ms", note: "A2 starts after alpha's independent site gap" }
        ]
      },
      interview: {
        prompt: "Design the distributed frontier and use a timestamped example to show how a hot site, a shared IP, and a dead owner behave.",
        answerPoints: [
          "Keep durable URL queues per site key and one ready-time index entry per active site.",
          "Choose the site by eligibility and fairness, then choose a URL within that site.",
          "Use expiring URL leases and idempotent attempt records.",
          "Partition site ownership so robots, delays, and active leases have one decision maker.",
          "Use an ownership generation and safe handoff during rebalance.",
          "Resolve DNS before acquiring an independent shared-destination permit.",
          "Advance the site clock from actual dispatch time and release every permit once.",
          "Explain that global worker headroom cannot override site or destination budgets."
        ],
        followups: [
          "How do you prevent double dispatch while a shard moves between schedulers?",
          "What happens when one site contributes ninety percent of all queued URLs?",
          "How do several regions share one site's politeness budget?",
          "What key would you use for robots policy when scheme or port changes?",
          "How does DNS TTL expiration update the destination limiter safely?"
        ]
      }
    },
    "crawler-robots": {
      contextTitle: "Robots retrieval is a state machine with opposite failure outcomes",
      context: [
        "Before dispatching ordinary URLs for a site, the crawler must classify its robots retrieval. A successful response yields rules; a 4xx makes the file unavailable and permits access under RFC 9309, while a 5xx, DNS failure, or network failure makes it unreachable and requires complete disallow.",
        "Those opposite outcomes protect different situations. An explicit 404 says the resource is absent, while an unreachable service may already be impaired; store the class so the scheduler never confuses absence with failure.",
        "The durable robots record must retain the evidence behind dispatch. Store the outcome, selected user-agent group, source authority, redirect chain, validators, retrieval time, expiry, parser version, and any local policy for extensions such as `Crawl-delay`, which RFC 9309 does not define.",
        "Robots expresses crawl preference, not authorization. Even when a 404 permits crawling under the standard, scope, authentication, product policy, legal restrictions, rate limits, or destination safety can still reject the request."
      ],
      walkthrough: {
        title: "Classify the retrieval before matching a path",
        intro: "Follow these branches in order so transport failure never falls through to the permissive 4xx behavior.",
        steps: [
          {
            title: "Build the robots request",
            text: "Fetch `/robots.txt` for the site's scheme, authority, and port with bounded redirects, response bytes, and deadlines. Associate the resulting policy with the initial site even when a redirect retrieves the file elsewhere."
          },
          {
            title: "Follow redirects safely",
            text: "A crawler should follow at least five consecutive redirects under RFC 9309, while repeating scheme, scope, DNS, address, and credential checks for each target. A redirect failure ends in the corresponding unreachable or unavailable state."
          },
          {
            title: "Classify 2xx as available",
            text: "Parse the applicable user-agent group and combine duplicate matching groups. Choose the most specific matching rule by matched octets, with `Allow` preferred when equally specific allow and disallow rules match."
          },
          {
            title: "Classify 4xx as unavailable",
            text: "For a 400 through 499 response, the standard permits access to resources on that server. Record the unavailable state rather than synthesizing an empty successful file, since operators need to distinguish the retrieval outcome."
          },
          {
            title: "Classify 5xx as unreachable",
            text: "For a 500 through 599 response, assume complete disallow. Schedule a bounded policy refresh without sending ordinary crawl traffic while the state remains unreachable."
          },
          {
            title: "Classify DNS or network failure as unreachable",
            text: "Timeouts, connection failures, and DNS failures also require complete disallow. Do not map them to 404 behavior merely because no robots body was received."
          },
          {
            title: "Cache with an explicit expiry policy",
            text: "A cached file generally should not be used for more than 24 hours unless the file is unreachable. If the condition lasts for an extended period such as 30 days, state whether the crawler follows the standard's permitted unavailable treatment or continues using a cached copy."
          },
          {
            title: "Apply path rules at dispatch",
            text: "Match the request path case-sensitively using the standard's percent-encoding comparison rules. Recheck the cached policy version and expiry when the frontier attempts to lease a URL."
          }
        ],
        takeaway: "Memorize the safety split: 4xx may crawl, while 5xx, DNS, and network failure mean complete disallow."
      },
      workedExample: {
        title: "Four sites return four different robots outcomes",
        setup: "At 09:00 UTC, the frontier needs policy for shop, news, api, and docs. The sites return 404, 503, DNS failure, and a redirect to a successful robots file respectively.",
        facts: [
          { label: "shop.example", value: "404 Not Found" },
          { label: "news.example", value: "503 Service Unavailable" },
          { label: "api.example", value: "DNS timeout" },
          { label: "docs.example", value: "302 then 200" },
          { label: "Crawler user agent", value: "DecagonBot" },
          { label: "Cached policy limit", value: "24 hours in normal operation" }
        ],
        steps: [
          {
            title: "shop becomes unavailable",
            text: "The 404 is a 4xx response, so RFC 9309 permits crawling. The frontier may release in-scope shop URLs under its normal local rate policy, while the robots record remains visibly unavailable."
          },
          {
            title: "news becomes unreachable",
            text: "The 503 is a 5xx response, so the site enters complete disallow. The scheduler queues a later robots refresh but does not release ordinary news URLs."
          },
          {
            title: "api also becomes unreachable",
            text: "The DNS timeout is a network retrieval failure and has the same complete-disallow behavior as the 503. It does not inherit the permissive shop outcome."
          },
          {
            title: "docs follows the redirect",
            text: "The crawler validates the redirect target, retrieves a 200 robots file, and applies its parsed rules to docs.example, the initial site. The redirect destination does not acquire authority over unrelated crawl traffic."
          },
          {
            title: "Match a path by specificity",
            text: "If docs has `Disallow: /private` and `Allow: /private/public`, the longer matching allow rule permits `/private/public/report`. If equally specific allow and disallow rules match, allow should win."
          },
          {
            title: "Refresh without a stampede",
            text: "Each unreachable record receives a jittered next check and one shared refresh lease. Thousands of queued URLs read the same policy state instead of issuing separate robots requests."
          }
        ],
        result: "The four outcomes produce three policy states: shop may crawl, news and api must not crawl, and docs follows the successfully parsed rules from its redirected retrieval."
      },
      explanations: [
        {
          title: "Unavailable and unreachable are intentionally different",
          paragraphs: [
            "A 404 explicitly reports that the requested robots resource is absent, so the standard permits crawling. A 503 or failed connection can mean the service is impaired, which is precisely when additional crawler traffic may be harmful.",
            "Store unavailable and unreachable as separate states, including their observation time. One `robots_allowed` boolean loses the evidence needed to choose refresh behavior and explain why a site remains idle."
          ]
        },
        {
          title: "Rule matching needs raw path discipline",
          paragraphs: [
            "Robots matching evaluates the request's path and query, not an application route invented by the crawler. Preserve the representation needed for standards-based comparison even when a separate normalized key drives dedupe.",
            "The comparison is case-sensitive, percent encoding matters, and the most specific rule wins. Equal-specificity conflicts prefer allow, so a first-match parser can choose the wrong result."
          ]
        },
        {
          title: "Local extensions stay visibly local",
          paragraphs: [
            "Some sites publish `Crawl-delay`, but RFC 9309 defines neither its syntax nor its precedence. A product may honor it under a configured interpretation and maximum, while the parser labels it as a local extension.",
            "Use the same separation for stricter handling of selected 401 or 403 responses. State the product policy directly instead of attributing behavior to the standard that the standard does not require."
          ]
        }
      ],
      decisionTable: {
        title: "Exact robots retrieval branches",
        columns: ["Outcome", "RFC state", "Ordinary crawl behavior", "Refresh and cache behavior"],
        rows: [
          ["2xx", "Available", "Parse and obey the applicable group", "Cache parsed rules with validators and normal expiry"],
          ["3xx", "Continue retrieval", "Do not dispatch from incomplete policy", "Follow at least five consecutive redirects with safety checks"],
          ["4xx", "Unavailable", "May access resources under RFC 9309", "Record outcome and refresh by local policy"],
          ["5xx", "Unreachable", "Assume complete disallow", "Retry policy fetch with bounded backoff and shared refresh ownership"],
          ["DNS failure", "Unreachable", "Assume complete disallow", "Retry with bounded DNS and policy backoff"],
          ["Network failure", "Unreachable", "Assume complete disallow", "A cached copy may remain usable under the stated unreachable policy"],
          ["Unreachable for an extended period", "Operational policy choice", "State whether permitted unavailable treatment applies", "Document the 30-day decision and any cached-copy use"]
        ]
      },
      diagram: {
        type: "branch",
        title: "Robots retrieval branches before URL dispatch",
        caption: "Only an unavailable 4xx branch is permissive by default. Transport and server failure stay fail-closed.",
        source: "GET /robots.txt for the initial site",
        branches: [
          { label: "2xx", note: "parse group, most-specific rule, equal specificity should favor Allow" },
          { label: "3xx", note: "validate target and follow at least five consecutive redirects" },
          { label: "4xx", note: "unavailable, ordinary resources may be crawled" },
          { label: "5xx", note: "unreachable, complete disallow" },
          { label: "DNS or network failure", note: "unreachable, complete disallow" }
        ],
        destination: "Cached site policy with outcome, rules, expiry, validators, and refresh ownership"
      },
      interview: {
        prompt: "A robots request returns 404 for one site, 503 for another, and DNS failure for a third. State the exact behavior and show how policy is cached across frontier replicas.",
        answerPoints: [
          "Treat 4xx as unavailable and permit crawling under RFC 9309 unless a stricter local rule applies.",
          "Treat 5xx as unreachable and assume complete disallow.",
          "Treat DNS and network failure as unreachable and assume complete disallow.",
          "Follow at least five consecutive redirects while validating each destination.",
          "Apply a redirected robots file to the initial site.",
          "Use most-specific path matching and prefer allow on equal specificity.",
          "Store outcome, selected group, rules, validators, expiry, parser version, and refresh lease.",
          "Identify `Crawl-delay` as a local extension rather than an RFC 9309 rule."
        ],
        followups: [
          "What happens if a valid cached file exists when the next refresh returns 503?",
          "How do you prevent every queued URL from refreshing robots at once?",
          "What happens when the robots redirect crosses authorities?",
          "How does a 401 response differ between the RFC behavior and a stricter product policy?"
        ]
      }
    },

    "crawler-identity-durability": {
      contextTitle: "Identity controls duplicates, while state transitions control loss",
      context: [
        "URL dedupe asks whether a request identity has already been scheduled. Content dedupe asks whether successful fetches produced the same bytes or a near-duplicate document; one URL can change over time and several URLs can serve one body, so the two identities cannot replace each other.",
        "Normalize only when the client can preserve server meaning. Lowercase scheme and host, remove a default port, normalize percent-hex case, decode unreserved characters when appropriate, remove valid dot segments, and usually drop the fragment; preserve query order, duplicate keys, reserved characters, path case, and application-specific forms.",
        "Move durable work through discovered, leased, fetched, parsed, and committed states under expiring ownership. Long attempts renew before lease expiry and fence their final write against the current generation, while stable keys and idempotent transitions make at-least-once replay acceptable.",
        "Approximate dedupe needs an explicit coverage contract because a Bloom-filter false positive can suppress real work. Recrawl remains a separate scheduling decision based on freshness, change history, status, failure backoff, sitemaps, and HTTP validators; keep the prior representation visible until a new version is accepted."
      ],
      walkthrough: {
        title: "Separate exact identity, approximation, and version state",
        intro: "Follow one candidate through dedupe and later revisit so every possible loss has a named policy.",
        steps: [
          {
            title: "Create a conservative fetch key",
            text: "Parse the URL once, apply only standards-supported normalization, remove the fragment from the HTTP fetch key, and retain the original reference for provenance and debugging."
          },
          {
            title: "Use approximation only as a prefilter",
            text: "A Bloom filter can avoid many exact-store reads for known URLs, but a positive result must reach an exact set when coverage cannot tolerate false-positive loss. A negative result can proceed directly to the conditional exact insert."
          },
          {
            title: "Conditionally create discovered state",
            text: "Insert the normalized URL key with source, discovery time, priority, and initial revisit policy. Concurrent discoveries converge on the same record while preserving any required source edges independently."
          },
          {
            title: "Lease with a visibility deadline",
            text: "Move eligible work to leased state with an attempt ID, owner, generation, and expiry. Renew before expiry while the attempt is active, reject a stale owner's terminal write by generation, and return the same logical URL to eligible state when ownership expires."
          },
          {
            title: "Store attempt and representation separately",
            text: "Append the physical attempt outcome even when it fails, and store successful bytes under a content digest or version key. Update the URL's accepted-version pointer only after the selected result is complete."
          },
          {
            title: "Commit parse and discovery versions",
            text: "Key parsed output by URL version and parser version, then admit discovered URLs and edges idempotently. Reprocessing the same body with a new parser can create a new parse version without another fetch."
          },
          {
            title: "Schedule a conditional recrawl",
            text: "Store ETag and Last-Modified when present, compute the next revisit, and send `If-None-Match` or `If-Modified-Since`. A 304 records a new observation while keeping the existing body version."
          },
          {
            title: "Retain poison and terminal evidence",
            text: "After bounded retries, move repeatedly failing work to an inspectable terminal state instead of cycling forever or disappearing. Preserve the last error, attempt count, and next operator action."
          }
        ],
        takeaway: "Exact URL state preserves coverage, representation versions preserve history, and expiring leases preserve work through crashes."
      },
      workedExample: {
        title: "A one-percent Bloom filter can lose ten thousand discoveries",
        setup: "A crawl discovers one million genuinely new candidate URLs after its Bloom filter has reached a one-percent false-positive rate. Coverage requires every accepted in-scope URL to reach the exact frontier store.",
        facts: [
          { label: "New candidates", value: "1,000,000" },
          { label: "Bloom false-positive rate", value: "1%" },
          { label: "Expected false positives", value: "about 10,000" },
          { label: "Coverage policy", value: "No approximate loss" },
          { label: "Delivery", value: "At least once" },
          { label: "Revisit", value: "Conditional after 24 hours" }
        ],
        steps: [
          {
            title: "Observe the loss if Bloom is authoritative",
            text: "About ten thousand new candidates are expected to look present even though they have never reached the frontier. Dropping every positive result would silently remove those pages and every subtree discovered only through them."
          },
          {
            title: "Put an exact set behind positives",
            text: "Bloom negatives proceed to conditional insertion because they are definitely absent from the filter, while Bloom positives query the exact URL store. A false positive is corrected by the missing exact row."
          },
          {
            title: "Converge concurrent insertion",
            text: "Two parsers may race to insert the same normalized URL, but a conditional create on the URL key produces one logical record. Each parser may still add its own discovery edge under a source-target key."
          },
          {
            title: "Replay a lost lease",
            text: "A worker leases the URL and dies before recording a fetch attempt. The lease expires, another worker creates attempt 2, and the URL remains one logical item because the lease and attempt IDs are separate from the URL key."
          },
          {
            title: "Record a changed representation",
            text: "The first successful body is stored under digest D1. On the next visit the server returns a new ETag and body D2, so the URL history gains another attempt and version while D1 remains available under retention policy."
          },
          {
            title: "Record an unchanged revisit",
            text: "A later `If-None-Match` request returns 304. The crawler appends the observation and advances freshness without writing a third body or pretending the fetch never happened."
          }
        ],
        result: "The Bloom filter saves exact-store reads without becoming a coverage oracle, and retries or recrawls add attempts and versions without duplicating the logical URL."
      },
      explanations: [
        {
          title: "Conservative normalization avoids false equivalence",
          paragraphs: [
            "Sorting query parameters can change meaning when order or duplicate keys matter. Decoding a reserved character can change URL structure, so merging either form may silently skip a distinct resource without producing a fetch error.",
            "Keep the original URL for provenance and a conservative fetch key for scheduling. Product-specific or server-provided canonical hints can influence ranking as metadata without becoming unquestioned fetch identity."
          ]
        },
        {
          title: "At least once shifts work into stable keys",
          paragraphs: [
            "Exactly-once execution across the frontier, fetcher, object store, parser, and discovery store requires cross-stage coordination. Expiring leases and idempotent writes usually make replay cheaper and keep recovery local to the failed boundary.",
            "Choose an idempotency key that names the logical result at that boundary. Discovery uses the URL key, network outcomes use an attempt ID, immutable bytes use a content digest, and parsed output uses URL version plus parser version."
          ]
        },
        {
          title: "Recrawl priority is a product policy",
          paragraphs: [
            "A fixed revisit period wastes traffic on stable pages and leaves volatile pages stale. Compute the next visit from the freshness objective, observed change interval, importance, previous status, failure backoff, and trustworthy sitemap hints.",
            "Reserve some dispatch capacity for revisit deadlines so new discoveries cannot starve known content forever. Measure freshness lag as a percentile, because recrawl throughput alone does not show how late important pages became."
          ]
        }
      ],
      decisionTable: {
        title: "Choose the identity that answers the question",
        columns: ["Identity or state", "Key", "What it proves", "Failure if misused"],
        rows: [
          ["Fetch URL", "Conservatively normalized URL without fragment", "One scheduled HTTP request identity", "Aggressive merging silently skips distinct resources"],
          ["Discovery edge", "Source version plus target URL key", "Why the target entered the crawl", "URL dedupe erases provenance if edges share its key"],
          ["Fetch attempt", "URL key plus unique attempt ID", "Exact status, timing, peer, and terminal reason", "Retries overwrite evidence"],
          ["Body version", "Content digest or immutable version ID", "Exact accepted bytes", "One URL cannot retain history"],
          ["Parse result", "Body version plus parser version", "Output can replay or be regenerated", "Parser upgrades overwrite incomparable output"],
          ["Bloom prefilter", "Probabilistic membership bits", "A negative is definitely absent from the filter", "A positive used as truth loses new URLs"],
          ["Lease", "URL key plus owner, generation, and expiry", "Temporary execution ownership", "A dead worker can lose or permanently hold work"]
        ]
      },
      diagram: {
        type: "state-machine",
        title: "Durable URL and version state",
        caption: "Attempts and representations accumulate around one logical URL, while expiry and conditional recrawl create safe loops.",
        states: [
          { label: "Discovered", note: "exact URL key and provenance exist" },
          { label: "Leased", note: "temporary owner may execute one attempt" },
          { label: "Attempted", note: "terminal network evidence is append-only" },
          { label: "Versioned", note: "accepted bytes and validators are durable" },
          { label: "Parsed", note: "versioned metadata and discoveries are committed" },
          { label: "Waiting", note: "next revisit is scheduled" },
          { label: "Poison", note: "bounded failures await explicit policy" }
        ],
        transitions: [
          "Discovered to Leased when the site and destination are eligible",
          "Leased to Discovered after expiry without a terminal attempt",
          "Leased to Attempted after success or terminal failure",
          "Attempted to Versioned after an accepted body commit",
          "Attempted to Waiting after 304 or a retryable policy decision",
          "Versioned to Parsed after idempotent parse and discovery writes",
          "Parsed to Waiting after the next revisit is calculated",
          "Waiting to Leased when the revisit deadline arrives",
          "Attempted to Poison after the bounded retry policy is exhausted"
        ]
      },
      interview: {
        prompt: "Explain URL and content dedupe, then walk a worker crash and a conditional recrawl without claiming exactly-once execution.",
        answerPoints: [
          "Use conservative normalization and preserve the original URL for provenance.",
          "Keep URL identity, fetch attempts, body versions, parse versions, and discovery edges separate.",
          "Use a Bloom filter only as a prefilter when false-positive loss is unacceptable.",
          "Use a conditional exact insert to converge concurrent discoveries.",
          "Represent temporary ownership with an expiring lease.",
          "Make stage writes idempotent under stable logical keys.",
          "Store ETag or Last-Modified and treat 304 as a new observation without a new body.",
          "Reserve capacity and calculate revisit priority from freshness plus change history."
        ],
        followups: [
          "What is lost if the Bloom filter becomes the only dedupe store?",
          "Can two different URLs share a body without being the same crawl item?",
          "How do you reprocess old bodies after a parser upgrade?",
          "What happens when a URL changes while the prior version is still being parsed?",
          "How do new discoveries compete with overdue recrawls?"
        ]
      }
    },

    "crawler-ssrf": {
      contextTitle: "A crawler is an SSRF client unless the connection path enforces policy",
      context: [
        "Every discovered URL is attacker-controlled input. It can target internal services, cloud metadata, control planes, slow streams, parser bombs, or redirect loops, and a string check at admission cannot prove the destination that the socket will eventually use.",
        "Parse through one URL implementation, allow only intended schemes and ports, reject credentials and ambiguous hosts, and resolve through a controlled path. Apply policy to every returned address, then pin the dialer or egress proxy to that set so a second lookup cannot substitute a loopback, private, link-local, multicast, unspecified, or metadata address.",
        "Repeat the decision after every redirect and every fresh resolution after TTL expiry. Application validation is the first boundary; network segmentation and egress policy form a second boundary that contains a parser or dialer mistake before it reaches metadata, databases, cluster APIs, or tenant-private networks.",
        "A public destination can still exhaust the crawler without reaching an internal address. Bound redirect count, connection and body time, headers, compressed and expanded bytes, subrequests, extracted links, parser complexity, and renderer execution for every request."
      ],
      walkthrough: {
        title: "Bind the approved URL to the socket peer",
        intro: "Each gate must consume structured output from the prior gate, and a redirect must restart the sequence rather than skip to another connection.",
        steps: [
          {
            title: "Parse once",
            text: "Accept only HTTP and HTTPS, restrict ports, reject user information and malformed authorities, convert international names through one defined IDNA policy, and avoid comparing raw hostname strings produced by different parsers."
          },
          {
            title: "Apply crawl scope",
            text: "Check domain allowlists, customer boundaries, and redirect policy before DNS. Scope rejection saves work but does not replace address validation because an allowed hostname can resolve internally."
          },
          {
            title: "Resolve through a controlled path",
            text: "Query the crawler's resolver, respect a bounded TTL policy, and inspect every A and AAAA result in normalized binary form. Handle IPv4-mapped IPv6 and alternate textual forms through address libraries rather than prefixes."
          },
          {
            title: "Reject forbidden destinations",
            text: "Reject loopback, private, link-local, multicast, unspecified, reserved, and cloud-metadata destinations according to product policy. Fail the request if the selected address cannot be tied to the approved result set."
          },
          {
            title: "Enforce at connect time",
            text: "Pin the dial to a validated address while preserving the original hostname for HTTP Host and TLS verification, or send the request through an egress proxy that repeats destination policy. Do not validate with one lookup and connect with an unconstrained second lookup."
          },
          {
            title: "Verify the peer and record evidence",
            text: "Record the actual socket peer, resolved set, resolver timestamp, policy version, TLS result, and request authority. Abort if the connection path selects a peer outside the approved set."
          },
          {
            title: "Restart on redirect",
            text: "Resolve the new Location against the current URL, remove credentials when authority changes, then repeat parsing, scope, DNS, address, port, and robots decisions before opening another socket."
          },
          {
            title: "Contain the worker",
            text: "Place fetchers behind deny-by-default egress that cannot reach metadata, cluster control planes, databases, or private tenant ranges. Put browser renderers in an even narrower sandbox with independent subrequest and lifetime budgets."
          }
        ],
        takeaway: "The security invariant is simple to state: the socket peer must be one of the destinations that passed the current policy for this exact hop."
      },
      workedExample: {
        title: "Stop a metadata redirect and a DNS-rebinding attempt",
        setup: "The crawler receives `https://public.example/report`. The first resolution returns a public address, the response redirects to cloud metadata, and a later attacker-controlled resolution changes the original hostname to a link-local address.",
        facts: [
          { label: "Initial URL", value: "https://public.example/report" },
          { label: "Validated address", value: "93.184.216.34" },
          { label: "Redirect", value: "http://169.254.169.254/latest/meta-data" },
          { label: "Allowed ports", value: "80 and 443" },
          { label: "Fetch deadline", value: "10 seconds" },
          { label: "Expanded body limit", value: "10 MiB" }
        ],
        steps: [
          {
            title: "Approve the first hop",
            text: "The parser accepts HTTPS with no credentials and an allowed port. Controlled DNS returns 93.184.216.34, address policy accepts it for this example, and the dialer pins that address while TLS still verifies `public.example`."
          },
          {
            title: "Receive an attacker-controlled redirect",
            text: "The server returns a 302 whose Location is a link-local metadata address. The crawler resolves the Location as a new URL instead of asking the existing HTTP client to follow it automatically."
          },
          {
            title: "Reject before connect",
            text: "Address policy classifies 169.254.169.254 as link-local and forbidden, so no second socket opens. The attempt record stores the redirect target and `blocked_destination` as the terminal reason."
          },
          {
            title: "Block a later rebinding result",
            text: "When the original hostname's TTL expires, DNS returns 169.254.169.254. The new result goes through policy again and is rejected rather than inheriting the earlier public approval."
          },
          {
            title: "Rely on the second boundary",
            text: "If application validation regresses, the fetch subnet's egress rules still deny link-local, private, control-plane, and metadata routes. The failed connect is recorded as an enforcement denial, not retried as an ordinary transport error."
          },
          {
            title: "Keep response work bounded",
            text: "For an allowed public response, the fetcher still stops at the ten-second deadline and ten-MiB expanded body limit. Passing address policy never grants unlimited time, bytes, redirects, or parser work."
          }
        ],
        result: "Neither the redirect nor the changed DNS answer can create a socket to metadata, and the network boundary preserves the rule even if application code makes a mistake."
      },
      explanations: [
        {
          title: "Validation and connection must share one result",
          paragraphs: [
            "A time-of-check to time-of-use gap appears when validation resolves a hostname and the HTTP library resolves it again during connect. An attacker can present a public address to the validator and an internal address to the dialer.",
            "Select the socket address from the already validated set, or move resolution and connection into one policy-enforcing egress proxy. Keep the original hostname for Host routing and TLS identity even when the socket connects to a pinned address."
          ]
        },
        {
          title: "Every redirect is another untrusted request",
          paragraphs: [
            "A safe public page can redirect to another scheme, authority, port, credential-bearing URL, or protected address. Disable automatic redirects unless its callback repeats the parser, scope, resolver, destination, scheduling, and robots gates.",
            "Keep one hop limit and one total deadline across the whole chain. Resetting limits at each hop lets a sequence of individually valid redirects consume unbounded time."
          ]
        },
        {
          title: "The parser and renderer need containment too",
          paragraphs: [
            "Destination policy protects the network boundary, but allowed content can still attack decompression, HTML parsing, image decoding, or browser execution. Give every content stage its own time, byte, complexity, and output limits.",
            "Browser rendering also creates subrequests that must pass the same destination policy. Run the browser without crawler credentials and behind a separate egress boundary, process limit, memory limit, and task deadline."
          ]
        }
      ],
      decisionTable: {
        title: "Destination gates for every hop",
        columns: ["Gate", "Decision", "Enforcement point", "Repeat when"],
        rows: [
          ["URL parser", "HTTP or HTTPS, allowed port, no credentials, valid authority", "Admission library", "Every discovered URL and redirect"],
          ["Scope", "Domain, tenant, and product boundary", "Admission and redirect policy", "Every authority change"],
          ["DNS", "Controlled resolver and bounded TTL", "Resolver service or fetcher", "Cache expiry and every new hostname"],
          ["Address policy", "Reject special, internal, metadata, and forbidden ranges", "Structured IP library", "Every A and AAAA result"],
          ["Connect binding", "Peer must come from the approved result set", "Pinned dialer or egress proxy", "Every socket"],
          ["Network containment", "No route to protected destinations", "Subnet, firewall, or egress gateway", "Always"],
          ["Response budget", "Deadline, redirects, headers, wire bytes, expanded bytes", "HTTP client and bounded sink", "Across the full redirect chain"],
          ["Execution budget", "Parser and browser time, memory, subrequests, outputs", "Isolated worker class", "Every accepted body"]
        ]
      },
      diagram: {
        type: "branch",
        title: "Every hop must end at an approved socket peer",
        caption: "Redirects and TTL expiry return to the parser and resolver instead of inheriting the prior hop's approval.",
        source: "Attacker-controlled URL or redirect Location",
        branches: [
          { label: "Parse or scope fails", note: "reject before DNS" },
          { label: "DNS returns forbidden address", note: "reject before connect" },
          { label: "Peer differs from approved set", note: "abort and record enforcement failure" },
          { label: "Redirect received", note: "restart parser, scope, DNS, address, and robots gates" },
          { label: "Response exceeds budget", note: "terminate stream and classify bounded failure" },
          { label: "All gates pass", note: "store bounded result for isolated parsing" }
        ],
        destination: "Versioned fetch record with resolved set, actual peer, redirect chain, policy version, and terminal reason"
      },
      interview: {
        prompt: "A public URL later resolves or redirects to cloud metadata. Trace the request from parser to socket and show defenses beyond application string checks.",
        answerPoints: [
          "Use one structured URL parser and allow only intended schemes and ports.",
          "Reject credentials, malformed authorities, and out-of-scope redirects.",
          "Resolve through a controlled path and inspect every normalized address result.",
          "Reject loopback, private, link-local, multicast, unspecified, metadata, and other forbidden destinations.",
          "Bind the connection to a validated address or enforce the same decision at an egress proxy.",
          "Preserve the original hostname for HTTP Host and TLS verification.",
          "Repeat every gate on redirects and new DNS resolutions.",
          "Use deny-by-default egress plus response, parser, and renderer budgets as independent boundaries."
        ],
        followups: [
          "How do you prevent the HTTP client from resolving the hostname a second time?",
          "What do you do when one DNS answer is public and another is private?",
          "How are TLS verification and Host routing preserved when dialing a pinned address?",
          "Which limits apply across an entire redirect chain rather than per hop?",
          "How do browser subrequests inherit the same destination policy?"
        ]
      }
    },

    "rehearsal-crawler-design": {
      contextTitle: "A strong crawler answer is one trace, one scheduler, and two failures",
      context: [
        "The mock should leave a design that another engineer could operate. Begin with requirements and arithmetic, trace one URL from discovery through recrawl, then add the frontier and worker stages around the state owners that appeared in that trace.",
        "Use the whiteboard as working memory rather than as a final poster. Keep assumptions and capacity math in the upper left, the normal path in the center, durable stores below their dependent arrows, and policy or failure notes beside the owner that acts on them.",
        "That layout gives each follow-up an existing boundary to modify. Point to the affected state and its owner before proposing another component, which keeps the answer connected as requirements change.",
        "Spend the final third proving behavior under loss by walking a scheduler death and a parser death after link discovery through detection, immediate behavior, resource ceiling, replay owner, and recovery. If time remains, apply the same frame when robots becomes unreachable or an allowed hostname redirects internally."
      ],
      walkthrough: {
        title: "Run the 60-minute whiteboard in eight passes",
        intro: "The supplied interview notes do not state a duration, so this rehearsal uses 60 minutes and leaves time for interviewer follow-ups.",
        steps: [
          {
            title: "0 to 5 minutes: clarify the contract",
            text: "Ask about scope, page target, freshness, rendering, robots policy, retention, availability, regions, and output consumers. Mark each unanswered value as an assumption."
          },
          {
            title: "5 to 10 minutes: estimate the envelope",
            text: "Calculate average and peak physical attempt rate, mean in-flight fetches, active-authority supply, raw bytes per day, retained bytes, and any rendered-page class."
          },
          {
            title: "10 to 17 minutes: draw one URL",
            text: "Trace parse, scope, exact dedupe, durable admission, site scheduling, lease, DNS and address policy, fetch, body storage, parsing, link admission, and recrawl commitment."
          },
          {
            title: "17 to 27 minutes: build the frontier",
            text: "Add per-site durable queues, the ready-time index, fairness, expiring leases, shard ownership, safe handoff, and the independent shared-destination limiter."
          },
          {
            title: "27 to 36 minutes: separate worker stages",
            text: "Add fetch, body, parse, discovery, and render boundaries with permits, queue bounds, idempotency keys, and upstream pressure behavior."
          },
          {
            title: "36 to 44 minutes: explain identity and recrawl",
            text: "Separate URL, attempt, body, parse, and edge keys, then explain Bloom-filter placement, content dedupe, validators, freshness priority, and retained versions."
          },
          {
            title: "44 to 52 minutes: prove policy and safety",
            text: "Walk exact robots branches, DNS rebinding, redirect revalidation, egress denial, compressed and expanded body limits, parser isolation, and browser-rendering containment."
          },
          {
            title: "52 to 60 minutes: inject failures and close",
            text: "Walk one ownership failure and one content or network failure from detection through recovery, then restate the three main trade-offs and the next production measurements."
          }
        ],
        takeaway: "The answer remains coherent because every component is introduced by the URL trace or by a failure that the existing trace cannot yet survive."
      },
      workedExample: {
        title: "Synthesize a public-web crawler from explicit assumptions",
        setup: "Design for 100 million accepted pages per day, a three-times peak, 24-hour freshness for a priority corpus, 200 KiB mean bodies, five-second site gaps, no browser rendering in the first release, and 30 days of raw-body retention.",
        facts: [
          { label: "Accepted rate", value: "about 1,157 pages per second average" },
          { label: "Peak attempts", value: "about 3,993 per second with 15% amplification" },
          { label: "Mean in flight", value: "about 1,597 at 400 ms mean fetch" },
          { label: "Active sites", value: "about 19,965 at peak with a five-second gap" },
          { label: "Raw ingress", value: "about 20.48 TB per day" },
          { label: "Retention", value: "about 1.23 PB at 30 days and two replicas" }
        ],
        steps: [
          {
            title: "Choose the source of truth",
            text: "Use a durable frontier store keyed by conservative URL identity, with per-site queue state, recrawl time, status, validators, and expiring leases. Partition site ownership by a renewable generation rather than worker-local counters."
          },
          {
            title: "Choose the dispatch path",
            text: "Each site owner indexes one head readiness time, leases a URL when site policy permits, then the fetch path resolves and validates DNS before acquiring an independent destination permit."
          },
          {
            title: "Choose the fetch boundary",
            text: "Fetchers stream bounded bodies to versioned object storage and append attempt metadata. A compact durable task points parsers at the stored body so parser replay does not repeat external traffic."
          },
          {
            title: "Choose the discovery boundary",
            text: "Parsers emit bounded links and metadata, then exact conditional inserts admit new URL records and source edges before acknowledgment. Bloom membership can reduce reads but cannot become authoritative."
          },
          {
            title: "Choose the revisit path",
            text: "A priority scheduler reserves capacity for the 24-hour corpus, uses ETag or Last-Modified, appends 304 observations, and adjusts later revisit times from observed change frequency."
          },
          {
            title: "Choose degraded behavior",
            text: "An owner death waits for generation transfer and lease recovery, parse failure replays stored bytes, robots 503 blocks that site, storage pressure stops new fetch admission, and forbidden redirect destinations fail before connect."
          },
          {
            title: "Choose operating signals",
            text: "Track accepted pages, physical attempts, queue age by class, freshness lag, site and IP policy violations, lease expiry, robots states, body and parse failures, retained bytes, and cost per accepted document."
          }
        ],
        result: "The final design has an explainable normal trace, explicit site and destination ownership, bounded stage pressure, replayable work, exact policy branches, and capacity numbers that connect to operations."
      },
      explanations: [
        {
          title: "Draw ownership beneath arrows",
          paragraphs: [
            "A box labeled queue does not explain what the system can recover. Write its payload, key, durability, lease, and full behavior beside the arrow when that handoff enters the design.",
            "Those notes answer later failures without adding new products. A worker crash becomes lease expiry, duplicate delivery becomes an idempotency-key check, and a slow consumer invokes the queue's existing full policy."
          ]
        },
        {
          title: "Use failure walks instead of failure lists",
          paragraphs: [
            "For a scheduler death, start with the missing heartbeat or lease. Identify which generation stops issuing work, what active workers may finish, when abandoned URL leases return, and how the replacement avoids a politeness burst.",
            "Apply the same causal frame to storage, robots, DNS, and parser failures: detection, immediate behavior, resource bound, durable evidence, replay owner, and recovery trigger. This sequence proves behavior more clearly than an availability label."
          ]
        },
        {
          title: "Keep alternatives tied to requirements",
          paragraphs: [
            "A relational store, log, key-value store, or queue can each hold part of frontier state, but naming every option does not choose a design. Pick one shape, state the atomic operation it must provide, and name the scale or availability condition that would force a change.",
            "Apply the same test to coordination. Central ownership simplifies politeness but can add latency, while renewable shard leases enable local dispatch and require handoff logic whose safety depends on site rate, region count, and tolerated duplicate work."
          ]
        }
      ],
      decisionTable: {
        title: "What each interview segment must leave on the board",
        columns: ["Time", "Candidate action", "Visible artifact", "Evidence for the interviewer"],
        rows: [
          ["0 to 5", "Clarify requirements", "Scope, freshness, politeness, rendering, retention", "The design target is explicit"],
          ["5 to 10", "Estimate capacity", "QPS, attempts, concurrency, active sites, bytes", "Components will be sized from assumptions"],
          ["10 to 17", "Trace one URL", "Numbered state and ownership path", "Normal behavior and trust boundaries are clear"],
          ["17 to 27", "Build frontier", "Site queues, ready index, leases, shard and IP control", "Scheduling and distributed ownership are derived"],
          ["27 to 36", "Bound worker stages", "Permits, durable queues, full behavior", "Overload cannot become unlimited pod memory"],
          ["36 to 44", "Explain identity and recrawl", "Keys, versions, dedupe, validators, priority", "Coverage and freshness survive replay"],
          ["44 to 52", "Prove policy and safety", "Robots tree and SSRF gates", "Hostile input cannot bypass the network boundary"],
          ["52 to 60", "Walk failures and summarize", "Two recovery traces plus operating signals", "Degraded behavior is bounded and observable"]
        ]
      },
      diagram: {
        type: "timeline",
        title: "Sixty-minute crawler design rehearsal",
        caption: "The drawing grows from assumptions to one URL, then to distributed ownership, bounded stages, safety, and recovery.",
        events: [
          { label: "0:00", note: "requirements and explicit assumptions" },
          { label: "0:05", note: "capacity math beside the prompt" },
          { label: "0:10", note: "one numbered URL lifecycle" },
          { label: "0:17", note: "per-site frontier and shared-destination control" },
          { label: "0:27", note: "fetch, body, parse, discovery, and render bounds" },
          { label: "0:36", note: "identity, dedupe, versions, and recrawl" },
          { label: "0:44", note: "robots and hostile-destination gates" },
          { label: "0:52", note: "ownership and content failure walks" },
          { label: "0:58", note: "trade-offs, measurements, and final questions" }
        ]
      },
      interview: {
        prompt: "Run the full crawler design from a blank whiteboard, then score whether every component was introduced by a requirement, request transition, or failure.",
        answerPoints: [
          "Requirements and assumptions appear before component selection.",
          "Capacity math distinguishes accepted pages from physical attempts and site-limited supply.",
          "One URL trace names owners, durable boundaries, leases, and idempotency keys.",
          "The frontier schedules sites by ready time and constrains shared destinations after DNS.",
          "Fetch, body, parse, discovery, and render stages have independent bounds and pressure behavior.",
          "URL, attempt, body, parse, and discovery identities remain distinct.",
          "Robots and SSRF decisions use exact branches and repeat on redirects.",
          "Two failure walks state detection, degraded behavior, resource ceiling, replay, and recovery."
        ],
        followups: [
          "A frontier owner dies after leasing work. Show the exact recovery timeline.",
          "A parser dies after finding links. Which write must already be durable?",
          "Millions of hostnames share one IP. Preserve throughput without overloading it.",
          "The crawler's exact dedupe store is slow. Where can a Bloom filter help without losing coverage?",
          "A public hostname redirects to cloud metadata after DNS changes. Stop the socket and show the second boundary."
        ]
      }
    }
  };

  window.DECAGON_GUIDES = {
    ...(window.DECAGON_GUIDES || {}),
    ...entries
  };
})();
