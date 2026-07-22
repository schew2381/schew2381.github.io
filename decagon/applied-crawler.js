(() => {
  "use strict";

  const existing = window.DECAGON_APPLIED_QUESTIONS || {};
  const crawlerRequestPath = [
    {
      question: `A crawler accepts 100 million pages per day, sees a 3x peak, and creates 1.15 physical attempts per accepted page.
Mean fetch time is 400 ms, p95 is 2 seconds, each authority permits one start every 5 seconds, and 200 KiB bodies are retained for 30 days with two replicas. Parsers use 20 ms of CPU per accepted page across 48 cores. Which capacity statement is correct?`,
      choices: [
        "The peak needs about 1,597 fetch slots and 8,000 active authorities, while 48 parser cores have enough capacity because average accepted load is only about 1,157 pages/s.",
        "Peak rate multiplied by p95 latency gives a 7,986-attempt fetch-cap proxy, 19,966 active authorities are needed, raw bodies need about 1.23 PB, and parser CPU is the first stated bottleneck because 48 cores serve only 2,400 pages/s.",
        "The peak needs about 7,986 fetch slots and 19,966 active authorities, but storage needs about 2.46 PB because every retry creates another retained accepted page and parsers must serve 3,993 pages/s.",
        "About 3,472 fetch slots are sufficient because peak accepted rate is the concurrency target, and adding fetch pods creates the missing authority supply while parser autoscaling catches up."
      ],
      answer: 1,
      rationale: `Peak accepted rate is about 3,472 pages/s and peak physical attempt rate is about 3,993 attempts/s. Multiplying that rate by the two-second p95 gives a conservative 7,986-attempt fetch-cap proxy, while a five-second site gap requires roughly 19,966 independently eligible authorities.
Replicated raw bodies consume about 1.23 PB, while 48 cores at 20 ms per page provide only 2,400 pages/s and therefore require lower admission, more parser capacity, or a deliberately bounded durable backlog.`
    },
    {
      question: `A fetcher holds an expiring URL lease, receives an 8 MiB response, and a parser later extracts a required product link before crashing once.
Which acknowledgment sequence avoids repeating the external fetch while ensuring that the product link cannot disappear during recovery?`,
      choices: [
        "Acknowledge the fetch lease after response headers arrive, pass the body through an in-memory channel, and acknowledge parsing as soon as extraction returns the link.",
        "Keep the fetch lease open until parsing and indexing finish, then repeat the HTTP request whenever either downstream stage loses its worker.",
        "Commit the bounded body and terminal fetch record, durably enqueue a parse task that references the body digest, and only then complete the fetch lease. Let the parser acknowledge after conditional URL admission and its provenance edge are durable.",
        "Store the body under its digest and mark the URL complete without a parse task, because a periodic object-store scan can infer which unparsed bodies need recovery."
      ],
      answer: 2,
      rationale: `The body digest gives parser retries the same immutable input, while the durable parse task or transactional outbox closes the gap between body commit and transfer of ownership from the fetch stage.
An expiring parse lease permits repeated extraction, but stable URL and edge keys make that replay safe and place acknowledgment after the discovered work is durably admitted.`
    }
  ];

  const crawlerFrontier = [
    {
      question: `Alpha and beta are independently site-ready at t = 0 and resolve to one address with a shared-IP cap of one, while alpha starts a 200 ms fetch with a one-second start gap and beta has a 500 ms gap.
Another site returns 503 for robots.txt, a shop returns 404, and alpha's owner dies after granting a durable URL lease. Which frontier behavior preserves every scheduling and recovery contract?`,
      choices: [
        "Start alpha and beta together because hostname limits are independent, allow both robots outcomes because no rules were parsed, and let the new owner issue alpha's leased URL immediately.",
        "Start alpha at t = 0 and beta at t = 200 ms, set alpha's next legal start to t = 1,000 ms, completely disallow ordinary work for the 503 site while permitting the 404 shop, and requeue unfinished alpha work after lease expiry under a valid ownership generation.",
        "Start alpha at t = 0 but hold beta until t = 1,000 ms in global FIFO order, block both robots outcomes, and remove alpha's URL from durable state when its worker accepts the lease.",
        "Start beta at t = 200 ms and set alpha's next legal start to t = 1,200 ms from fetch completion, permit the 503 site during its retry interval, and reclaim alpha's lease as soon as the owner heartbeat is missed."
      ],
      answer: 1,
      rationale: `Site readiness and destination capacity are separate permits, so beta can use the shared address only after alpha releases it and alpha's clock advances from actual dispatch time rather than completion.
RFC 9309 treats 404 as unavailable and permits access, treats 503 as unreachable and requires complete disallow, while an expiring durable lease plus ownership generation prevents both lost work and concurrent reissue after owner failure.`
    },
    {
      question: `A coverage crawler receives a Bloom-positive URL that has never entered its exact frontier, later fetches new bytes from a previously seen URL, follows a public response toward 169.254.169.254, and sees a later DNS answer change the original host to 10.0.0.7.
Which policy preserves coverage and history while preventing either destination change from reaching a private service?`,
      choices: [
        "Treat the Bloom result as final, use the content digest as the only crawl identity, and trust the original URL approval for redirects and later DNS answers as long as TLS still verifies.",
        "Use exact body-digest dedupe before scheduling, retain request credentials across authority-changing redirects, and block only URLs that contain a private-address literal before DNS resolution.",
        "Use exact URL dedupe but replace the prior fetch record whenever the normalized URL matches, validate only the first resolved address, and rely on DNS TTLs to prevent a changed answer during connection setup.",
        "Confirm Bloom positives against exact URL state, keep URL history separate from content-digest storage, restart scope, credential, robots, DNS, address, and scheduler checks on every redirect, and connect only to a validated peer behind an egress deny boundary."
      ],
      answer: 3,
      rationale: `A Bloom filter can reduce lookup traffic but cannot reject new work when false positives would violate coverage, and URL identity must remain separate from body identity because one URL changes while several URLs may share bytes.
Redirects and fresh DNS answers are new destination decisions, so the crawler repeats policy before opening a socket, pins the connection to an approved address set, records the actual peer, and retains network egress denial as a second boundary.`
    }
  ];

  window.DECAGON_APPLIED_QUESTIONS = {
    ...existing,
    "crawler-request-path": [
      ...(existing["crawler-request-path"] || []),
      ...crawlerRequestPath
    ],
    "crawler-frontier": [
      ...(existing["crawler-frontier"] || []),
      ...crawlerFrontier
    ]
  };
})();
