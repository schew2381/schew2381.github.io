(() => {
  "use strict";

  const existing = window.DECAGON_APPLIED_QUESTIONS || {};
  const interviewRehearsals = [
    {
      question: `The candidate has 75 minutes to build the two-provider gateway and compare a simple baseline with one adaptive router.
The adaptive experiment may expose a leaked losing attempt near minute 45. Which execution plan produces the strongest runnable artifact and benchmark notebook?`,
      choices: [
        "Use minutes 0 to 15 for architecture, 15 to 55 for fallback, retries, hedging, and a circuit breaker, then benchmark only the final policy and list any leaked work as a production follow-up.",
        "Use minutes 0 to 7 for contract and runner inspection, 7 to 37 for a bounded tested baseline, 37 to 52 for one adaptive policy, 52 to 64 for a controlled comparison, and 64 to 75 for failure checks and cleanup. If the adaptive path leaks work, repair or remove it before measurement and preserve the baseline.",
        "Build the baseline by minute 30, then tune the candidate against live endpoints while changing concurrency between runs, delete the slower implementation, and report the best mean and p99 observed before time expires.",
        "Implement both policies by minute 50, repair any leak without rerunning overlap tests, and use the final notebook row to copy terminal output without recording seed, offered load, drops, errors, or attempt cost."
      ],
      answer: 1,
      rationale: `A runnable baseline establishes the contract early, one adaptive change keeps the experiment explainable, and the final block protects time for cancellation, permit release, tests, naming, and the spoken defense.
Comparable notebook rows must share seed, offered load, sample count, concurrency, caps, and outcome rules while recording throughput, drops, errors, queue delay, latency percentiles, provider share, attempts per request, and the resulting decision.`
    },
    {
      question: `A production gateway design assumes 5,000 logical requests/s, 1.2 physical attempts per request, a 600 ms p95 attempt lifetime, and one 1 KiB request event plus one 1 KiB event per attempt.
The interviewer then removes the shared health and quota coordinator from one zone and stalls the ordinary log collector for ten minutes. Which response gives the clearest defensible design?`,
      choices: [
        "Draw Redis for health and Kafka for logs, keep admitting against the last global quota value, and hold every event in process memory until both dependencies recover.",
        "Estimate 3,000 in-flight requests and 5 MiB/s of logs from logical request rate, then stop every zone whenever either shared dependency is unavailable so no state can diverge.",
        "Estimate the physical load correctly, add enough gateway replicas to absorb it, make every log write synchronous before returning, and let the affected zone follow fleet-wide health because the larger sample is more accurate.",
        "First confirm whether provider quotas are hard and which events must be durable, then derive about 3,600 p95 in-flight attempts and 10.7 MiB/s of events. Trace one request through local admission and provider ownership, spend only pre-leased hard-quota credits during coordinator loss, retain zone-local health evidence, bound ordinary telemetry with a stated loss policy, and send billing events through a separate durable path."
      ],
      answer: 3,
      rationale: `Physical attempt rate is 6,000/s, so the p95 concurrency estimate is about 3,600, while 11,000 events/s produce roughly 10.7 MiB/s and 6.3 GiB over the ten-minute collector outage.
A defensible failure walk preserves zone-local routing with pre-leased quota credits and bounds ordinary telemetry independently from durable billing, naming the availability, consistency, response-latency, and data-loss costs of those boundaries.`
    }
  ];

  window.DECAGON_APPLIED_QUESTIONS = {
    ...existing,
    "interview-rehearsals": [
      ...(existing["interview-rehearsals"] || []),
      ...interviewRehearsals
    ]
  };
})();
