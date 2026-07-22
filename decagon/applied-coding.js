(() => {
  "use strict";

  const existing = window.DECAGON_APPLIED_QUESTIONS || {};
  const requestContract = [
    {
      question: `The gateway has forwarded the first SSE token from Provider A when A's stream resets.
Provider B can regenerate the full answer, but the public protocol has no resume offset or token deduplication rule. What should the gateway do?`,
      choices: [
        "Start B, discard tokens until its text matches A's prefix, and then continue the same stream.",
        "Start B from the full prompt and append its entire answer after A's partial output.",
        "End the committed stream using its defined terminal-error behavior, and permit transparent failover only before downstream output is committed.",
        "Return a new HTTP error status on the existing response and leave A running in case it recovers."
      ],
      answer: 2,
      rationale: `The first delivered chunk is the commit point for this contract, so the gateway can no longer replace the response without exposing duplicated, omitted, or spliced output.
Buffering until completion moves the commit point and permits failover at the cost of streaming latency and memory, while a resumable protocol would need an explicit stable offset and deduplication contract.`
    },
    {
      question: `A request arrives with a 900 ms total deadline. Queueing consumes 280 ms, Provider A fails after 370 ms, and the handler reserves 50 ms to clean up and return an error.
Provider B normally receives a 500 ms attempt timeout. What budget can the fallback use?`,
      choices: [
        "500 ms because each provider adapter owns an independent timeout.",
        "900 ms because a fallback starts a new logical request.",
        "250 ms because that is the wall-clock time left, with cleanup performed after the caller deadline.",
        "At most 200 ms, and the gateway should skip B if its minimum useful budget exceeds that remainder."
      ],
      answer: 3,
      rationale: `Only 250 ms remains after queueing and A, and the 50 ms response reserve leaves B no more than 200 ms on the original request clock.
Starting a fresh provider timer would let fallback work outlive the caller's deadline, while spending the cleanup reserve can prevent the gateway from cancelling work and returning on time.`
    }
  ];

  const adaptiveRouting = [
    {
      question: `The tracker receives two attempt events:
A: 429 with Retry-After: 2 seconds on a real request
B: cancelled after its paired A primary produced the winning response
How should these observations change routing state?`,
      choices: [
        "Record both as provider failures because neither attempt returned a usable response to its caller.",
        "Record A's 429 as capacity evidence with its retry window, and leave B's health unchanged because the cancellation supplies no outcome evidence.",
        "Record A as healthy because it replied, and record B as slow because it had not finished when cancelled.",
        "Exclude both samples and retain the prior scores because only 5xx responses should affect routing."
      ],
      answer: 1,
      rationale: `A 429 says that the selected scope has no capacity at that moment, so eligibility should respect Retry-After without confusing saturation with a transport failure.
The losing hedge was cancelled by gateway policy rather than B's behavior, and scoring it as a failure would create a feedback loop that suppresses a provider for work it never had a chance to finish.`
    },
    {
      question: `Provider A entered cooldown after repeated timeouts from one gateway zone, so ordinary traffic moved to B.
The cooldown has expired, B is near its cap, and A has no fresh samples from the affected zone. Which recovery policy is safest?`,
      choices: [
        "Restore A's old traffic share immediately because the cooldown expiry proves recovery.",
        "Keep A disabled until an operator intervenes because passive routing cannot test recovery safely.",
        "Run a shallow global health endpoint and restore A everywhere after its first 200 response.",
        "Permit a bounded probe from the affected zone, reopen cooldown on failure, and ramp ordinary traffic only after enough scoped successes."
      ],
      answer: 3,
      rationale: `Cooldown expiry only permits new evidence and does not provide it, while a global probe may miss the failed network path or model workload.
A limited half-open probe contains the cost of another failure, while gradual restoration avoids a synchronized surge from turning recovery into a second overload.`
    }
  ];

  const concurrencyResilience = [
    {
      question: `An HTTP/2 gateway admits at most 80 logical requests, allows 40 attempts per provider, and lets each request launch one delayed hedge.
The client pool is limited to ten connections, but every connection can carry many concurrent streams. Which implementation actually enforces the intended bounds?`,
      choices: [
        "Use the ten-connection pool as the only limiter because each connection represents one active request.",
        "Acquire one admission slot per logical request and one provider slot for every primary, retry, or hedge, with a bounded deadline-aware queue before those attempts.",
        "Acquire one admission slot for the primary and let its hedge reuse that slot even when both attempts overlap.",
        "Start every attempt immediately, then reject responses when the active counters exceed their configured values."
      ],
      answer: 1,
      rationale: `HTTP/2 multiplexing separates connection count from request concurrency, and one logical request can consume two upstream attempt slots while a hedge overlaps its primary.
Admission, queue, provider, and transport limits protect different resources, so every extra attempt must acquire capacity before launch and release it exactly once on every terminal path.`
    },
    {
      question: `Under the same open-load failure burst, a new policy lowers successful-response p99 from 430 ms to 230 ms but raises attempts per request from 1.03 to 1.86.
Provider B reaches its cap, queue p95 rises to 170 ms, and end-to-end success does not improve. What is the best next policy change?`,
      choices: [
        "Launch both providers at t = 0 so every request receives the lower p99 path.",
        "Increase the queue until no logical request is rejected, even if it waits beyond its deadline.",
        "Share one bounded extra-attempt budget across retries and hedges, require remaining deadline and provider capacity, and shed work when the budget is exhausted.",
        "Allow retries to bypass B's cap because failed primaries have already paid admission cost."
      ],
      answer: 2,
      rationale: `The lower p99 is being purchased with heavy amplification that saturates B and moves delay into the queue without recovering more requests.
A shared retry and hedge budget prevents two mechanisms from multiplying each other, while capacity and deadline checks reserve extra attempts for cases where they can still help.`
    }
  ];

  const codingExecution = [
    {
      question: `A delayed-hedge test scripts A to finish at 200 ms, starts B at 50 ms, and makes B succeed 25 ms later.
The test must prove that B wins, A is cancelled neutrally, and both provider slots are released once. Which test design provides the strongest evidence?`,
      choices: [
        "Sleep for 80 ms, inspect the response, and assume cleanup completes before the test process exits.",
        "Mock the router to return B and test the limiter separately with sequential calls.",
        "Use a virtual clock and event ledger, advance through 0, 50, and 75 ms, then assert response identity, event order, peak activity, health updates, and final slot counts.",
        "Run the test many times against real provider endpoints and treat a majority of passes as success."
      ],
      answer: 2,
      rationale: `A virtual clock makes the completion race reproducible, while the event ledger proves the ordering and cleanup properties that a final response alone cannot show.
Wall-clock sleeps add scheduler noise, and isolated sequential tests never create the overlap needed to expose double release, leaked capacity, or incorrect loser classification.`
    },
    {
      question: `Two policies use the same seed and target 500 requests per second in an open arrival benchmark, producing these rows:
Baseline: 497 achieved RPS, 99.4% end-to-end success, 420 ms p99, and 1.02 attempts per request
Candidate: 360 achieved RPS, 99.7% success among admitted requests, 180 ms p99 among successes, 28% admission drops, and 1.72 attempts per request
What can the candidate claim?`,
      choices: [
        "It is better because both its reported success percentage and p99 improved.",
        "It is not a demonstrated improvement because it rejects much of the offered load and amplifies upstream work, so the end-to-end result must include drops and achieved throughput.",
        "It is better if the benchmark removes rejected arrivals before calculating every metric.",
        "It should be rerun as a closed-loop benchmark so slow or rejected work reduces the number of new arrivals."
      ],
      answer: 1,
      rationale: `The candidate's conditional metrics describe a smaller admitted population, so its low p99 and high success rate do not represent the same offered workload as the baseline's end-to-end result.
Admission drops, achieved RPS, and attempt amplification reveal that the policy is avoiding or multiplying work, and a closed loop would hide that collapse by reducing offered load as service slows.`
    }
  ];

  window.DECAGON_APPLIED_QUESTIONS = {
    ...existing,
    "request-contract": [
      ...(existing["request-contract"] || []),
      ...requestContract
    ],
    "adaptive-routing": [
      ...(existing["adaptive-routing"] || []),
      ...adaptiveRouting
    ],
    "concurrency-resilience": [
      ...(existing["concurrency-resilience"] || []),
      ...concurrencyResilience
    ],
    "coding-execution": [
      ...(existing["coding-execution"] || []),
      ...codingExecution
    ]
  };
})();
