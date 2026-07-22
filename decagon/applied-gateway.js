(() => {
  "use strict";

  const existing = window.DECAGON_APPLIED_QUESTIONS || {};
  const productionFleet = [
    {
      question: "Provider A permits 120 concurrent attempts. Three zones hold leases for 35 credits each, while 15 credits remain reserved. A lease expires at t = 90 s, the longest permitted attempt is 40 s, and one zone loses the coordinator at t = 30 s. Which partition behavior preserves the hard quota without interrupting work that already holds a credit?",
      choices: [
        "Keep admitting through t = 90 s, then let the coordinator reassign all 35 credits immediately.",
        "Stop new admissions before t = 50 s, leave time for the longest attempt plus clock safety, and make the credits reclaimable at t = 90 s.",
        "Stop new admissions at t = 30 s and cancel every active attempt from the partitioned zone.",
        "Keep admitting after t = 90 s from the 15-credit reserve until coordinator access returns."
      ],
      answer: 1,
      rationale: `The last-admit time must precede reclaim by the maximum attempt duration plus clock and communication safety. Stopping before t = 50 s gives a forty-second attempt time to finish before t = 90 s without relying on perfectly synchronized clocks.
Admitting through expiry or spending reserve without coordination can let the old and new holders consume the same hard quota, while cancelling existing work at partition detection is safe but needlessly discards already allocated capacity.`
    },
    {
      question: "Five east-zone replicas time out when calling Provider A, while west-zone replicas report a 99.9% A success rate. The fleet hint still marks A healthy, and Provider B has spare capacity for only 30% of east demand. What should the next east-zone decisions do?",
      choices: [
        "Trust the larger fleet sample and keep the normal A share in every zone until the aggregate turns unhealthy.",
        "Eject A globally, send all fleet traffic to B, and restore A after one successful probe from any zone.",
        "Apply an east-scoped local cooldown for A, shift only within B's known headroom, shed unavoidable excess, and probe A again from east.",
        "Send all east traffic to B because a healthy fallback should receive every request during a local partition."
      ],
      answer: 2,
      rationale: `Remote successes cannot prove that the east network path works, so local negative evidence retains authority for east while west continues using A.
Moving only the capacity B can absorb prevents a path failure from becoming a second provider outage, and recovery must be tested from the affected scope before ordinary east traffic returns.`
    }
  ];

  const telemetryRecovery = [
    {
      question: "A gateway handles 1,000 logical requests per second and emits one request event plus 1.2 attempt events per request. Each encoded event is 900 bytes, the in-memory telemetry queue is 256 MiB, and the sink is unavailable for ten minutes. Billing events cannot be lost. Which design states the correct capacity and failure boundary?",
      choices: [
        "The queue is large enough for the outage, so keep every event in memory and replay when the sink returns.",
        "When the queue fills, block successful responses until ordinary telemetry export resumes and send billing through the same queue.",
        "Bound ordinary telemetry at 256 MiB, expose drops or sampling after roughly 136 seconds, and append billing events to a separate durable path with idempotent consumption.",
        "Write every request and attempt synchronously to the billing database because one durable store removes the need for queue limits."
      ],
      answer: 2,
      rationale: `The gateway produces 2,200 events/s or 1.98 MB/s, so a 256 MiB queue fills in about 136 seconds and cannot cover a ten-minute outage.
Ordinary telemetry needs an explicit bounded-loss policy that does not hold the response open, while billing needs an acknowledged append and atomic deduplication rather than a best-effort log queue.`
    },
    {
      question: "A successful gateway request contains a root span, an A timeout span, and a B fallback-success span. Spans are sent round-robin to three collector gateways that perform tail sampling, and request IDs are also used as metric labels. Which change preserves the request structure without creating unsafe metric growth?",
      choices: [
        "Route spans by trace ID to one tail-sampling collector, keep the root as success with A and B as sibling attempt spans, and move request IDs to traces and logs.",
        "Keep round-robin collection, flatten both attempts into the successful root span, and retain request ID as the metric join key.",
        "Mark every span successful because the client received a response, then page only when the gateway success rate falls.",
        "Create one metric series per request ID and reconstruct missing trace relationships from the metric backend."
      ],
      answer: 0,
      rationale: `A tail sampler needs every span for a trace at the same decision point, while the logical request remains successful even though A records a provider timeout and B records success.
Request IDs belong in event-oriented signals because using them as metric labels creates a new time series for nearly every request.`
    }
  ];

  window.DECAGON_APPLIED_QUESTIONS = {
    ...existing,
    "production-fleet": [
      ...(existing["production-fleet"] || []),
      ...productionFleet
    ],
    "telemetry-recovery": [
      ...(existing["telemetry-recovery"] || []),
      ...telemetryRecovery
    ]
  };
})();
