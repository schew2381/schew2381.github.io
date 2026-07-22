(function initializeDecagonSim(root, factory) {
  const api = factory();

  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }

  if (root) {
    root.DecagonSim = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function createDecagonSim() {
  "use strict";

  const GATEWAY_POLICIES = new Set([
    "fixed",
    "round-robin",
    "least-inflight",
    "adaptive",
    "hedge",
  ]);
  const GATEWAY_SCENARIOS = new Set([
    "steady",
    "flaky-fast",
    "brownout",
    "recovery",
    "slow-tail",
  ]);
  const CRAWLER_SCHEDULERS = new Set(["fifo", "host-aware"]);

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function finiteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function boundedInteger(value, fallback, minimum, maximum) {
    return Math.round(clamp(finiteNumber(value, fallback), minimum, maximum));
  }

  function canonicalValue(value) {
    if (value === undefined) {
      return JSON.stringify("undefined");
    }
    if (value === null || typeof value !== "object") {
      if (typeof value === "number" && !Number.isFinite(value)) {
        return JSON.stringify(String(value));
      }
      return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
      return `[${value.map(canonicalValue).join(",")}]`;
    }

    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(value[key])}`)
      .join(",")}}`;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function stableFingerprint(config) {
    return hashString(canonicalValue(config)).toString(16).padStart(8, "0");
  }

  function makeRandom(seed) {
    let state = hashString(String(seed)) || 0x6d2b79f5;
    return function random() {
      state = (state + 0x6d2b79f5) >>> 0;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function percentile(values, p) {
    const sorted = values
      .filter((value) => Number.isFinite(value))
      .slice()
      .sort((left, right) => left - right);
    if (sorted.length === 0) {
      return 0;
    }

    const percentileValue = p >= 0 && p <= 1 ? p * 100 : p;
    const position = (clamp(percentileValue, 0, 100) / 100) * (sorted.length - 1);
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    if (lowerIndex === upperIndex) {
      return sorted[lowerIndex];
    }

    const weight = position - lowerIndex;
    return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
  }

  function minimumSlot(slots) {
    let index = 0;
    for (let candidate = 1; candidate < slots.length; candidate += 1) {
      if (slots[candidate] < slots[index]) {
        index = candidate;
      }
    }
    return { index, freeAt: slots[index] };
  }

  function maximumConcurrency(intervals) {
    const points = [];
    intervals.forEach((interval) => {
      if (interval.endMs > interval.startMs) {
        points.push({ time: interval.startMs, delta: 1 });
        points.push({ time: interval.endMs, delta: -1 });
      }
    });
    points.sort((left, right) => left.time - right.time || left.delta - right.delta);

    let current = 0;
    let maximum = 0;
    points.forEach((point) => {
      current += point.delta;
      maximum = Math.max(maximum, current);
    });
    return maximum;
  }

  function average(values) {
    if (values.length === 0) {
      return 0;
    }
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function roundTo(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function normalizeGatewayConfig(input) {
    const requested = input || {};
    const scenario = GATEWAY_SCENARIOS.has(requested.scenario)
      ? requested.scenario
      : "steady";
    const policy = GATEWAY_POLICIES.has(requested.policy)
      ? requested.policy
      : "adaptive";

    return {
      scenario,
      policy,
      requests: boundedInteger(requested.requests, 240, 1, 5000),
      rps: clamp(finiteNumber(requested.rps, 40), 0.1, 10000),
      gatewayCap: boundedInteger(requested.gatewayCap, 80, 1, 2000),
      queueCap: boundedInteger(requested.queueCap, 160, 0, 10000),
      providerCapA: boundedInteger(requested.providerCapA, 32, 1, 1000),
      providerCapB: boundedInteger(requested.providerCapB, 32, 1, 1000),
      deadlineMs: clamp(finiteNumber(requested.deadlineMs, 1200), 25, 60000),
      hedgeMs: clamp(finiteNumber(requested.hedgeMs, 90), 0, 60000),
      explorationPct: clamp(finiteNumber(requested.explorationPct, 8), 0, 100),
      seed: requested.seed === undefined ? 7 : requested.seed,
    };
  }

  function gatewayScenarioProfile(scenario, providerName, progress) {
    const steady = providerName === "A"
      ? { baseMs: 76, spread: 26, failureRate: 0.02, tailRate: 0.035, tailMs: 190 }
      : { baseMs: 108, spread: 24, failureRate: 0.012, tailRate: 0.02, tailMs: 140 };

    if (scenario === "flaky-fast") {
      return providerName === "A"
        ? { baseMs: 56, spread: 18, failureRate: 0.19, tailRate: 0.05, tailMs: 260 }
        : { baseMs: 116, spread: 22, failureRate: 0.018, tailRate: 0.02, tailMs: 130 };
    }

    if (scenario === "brownout") {
      if (providerName === "A" && progress >= 0.3 && progress <= 0.76) {
        return { baseMs: 390, spread: 190, failureRate: 0.24, tailRate: 0.18, tailMs: 650 };
      }
      return providerName === "A"
        ? { baseMs: 72, spread: 24, failureRate: 0.018, tailRate: 0.03, tailMs: 180 }
        : { baseMs: 126, spread: 28, failureRate: 0.025, tailRate: 0.025, tailMs: 160 };
    }

    if (scenario === "recovery") {
      if (providerName === "A") {
        const recovery = clamp((progress - 0.35) / 0.45, 0, 1);
        return {
          baseMs: 285 - recovery * 220,
          spread: 100 - recovery * 74,
          failureRate: 0.34 - recovery * 0.322,
          tailRate: 0.12 - recovery * 0.09,
          tailMs: 440 - recovery * 250,
        };
      }
      return { baseMs: 120, spread: 24, failureRate: 0.018, tailRate: 0.02, tailMs: 140 };
    }

    if (scenario === "slow-tail") {
      return providerName === "A"
        ? { baseMs: 51, spread: 17, failureRate: 0.022, tailRate: 0.19, tailMs: 610 }
        : { baseMs: 111, spread: 18, failureRate: 0.014, tailRate: 0.018, tailMs: 110 };
    }

    return steady;
  }

  function sampleGatewayAttempt(config, providerName, requestId, ordinal) {
    const progress = config.requests <= 1 ? 0 : requestId / (config.requests - 1);
    const random = makeRandom(`${config.seed}:${requestId}:${providerName}:${ordinal}`);
    const profile = gatewayScenarioProfile(config.scenario, providerName, progress);
    let serviceMs = profile.baseMs + (random() - 0.5) * 2 * profile.spread;
    if (random() < profile.tailRate) {
      serviceMs += profile.tailMs * (0.65 + random() * 0.7);
    }
    serviceMs = Math.max(5, serviceMs);

    const failed = random() < profile.failureRate;
    let status = "200";
    if (failed) {
      const failureDraw = random();
      status = failureDraw < 0.5 ? "503" : failureDraw < 0.82 ? "502" : "transport";
    }

    return { serviceMs, success: !failed, status };
  }

  function gatewayPhaseDefinitions(scenario) {
    if (scenario === "brownout") {
      return [
        { label: "Before brownout", start: 0, end: 0.3 },
        { label: "Brownout begins", start: 0.3, end: 0.53 },
        { label: "Brownout continues", start: 0.53, end: 0.76 },
        { label: "After brownout", start: 0.76, end: 1.01 }
      ];
    }
    if (scenario === "recovery") {
      return [
        { label: "Failure", start: 0, end: 0.35 },
        { label: "Early recovery", start: 0.35, end: 0.57 },
        { label: "Recovery ramp", start: 0.57, end: 0.8 },
        { label: "Recovered", start: 0.8, end: 1.01 }
      ];
    }
    return [
      { label: "Opening quarter", start: 0, end: 0.25 },
      { label: "Second quarter", start: 0.25, end: 0.5 },
      { label: "Third quarter", start: 0.5, end: 0.75 },
      { label: "Final quarter", start: 0.75, end: 1.01 }
    ];
  }

  function gatewayPhaseWindows(config, rows) {
    return gatewayPhaseDefinitions(config.scenario).map((phase) => {
      const phaseRows = rows.filter((row) => {
        const progress = config.requests <= 1 ? 0 : row.id / (config.requests - 1);
        return progress >= phase.start && progress < phase.end;
      });
      const attempts = phaseRows.flatMap((row) => row.attempts || []);
      const providerACount = attempts.filter((attempt) => attempt.provider === "A").length;
      const providerBCount = attempts.filter((attempt) => attempt.provider === "B").length;
      const attemptCount = providerACount + providerBCount;
      const queueIntervals = phaseRows
        .filter((row) => row.queued && row.startMs !== null && row.startMs > row.arrivalMs)
        .map((row) => ({ startMs: row.arrivalMs, endMs: row.startMs }));
      const successfulLatencies = phaseRows.filter((row) => row.success).map((row) => row.latencyMs);
      return {
        label: phase.label,
        requestStart: phaseRows[0]?.id ?? 0,
        requestEnd: phaseRows.at(-1)?.id ?? 0,
        successRate: phaseRows.length === 0 ? 0 : roundTo((phaseRows.filter((row) => row.success).length / phaseRows.length) * 100, 1),
        successP95: roundTo(percentile(successfulLatencies, 95), 1),
        providerShareA: attemptCount === 0 ? 0 : roundTo((providerACount / attemptCount) * 100, 1),
        providerShareB: attemptCount === 0 ? 0 : roundTo((providerBCount / attemptCount) * 100, 1),
        maxActive: maximumConcurrency(attempts),
        maxQueued: maximumConcurrency(queueIntervals),
        dropped: phaseRows.filter((row) => row.dropped).length
      };
    });
  }

  function makeGatewayProvider(name, cap, initialLatency) {
    return {
      name,
      cap,
      slots: Array(cap).fill(0),
      attempts: [],
      transitions: [],
      health: {
        samples: 0,
        successEwma: 0.985,
        latencyEwma: initialLatency,
        consecutiveFailures: 0,
        circuitState: "closed",
        openUntilMs: 0,
        probeInFlight: false,
        recoverySuccesses: 0,
      },
    };
  }

  function runGateway(input) {
    const config = normalizeGatewayConfig(input);
    const warnings = [];
    const random = makeRandom(`${config.seed}:routing`);
    const providers = {
      A: makeGatewayProvider("A", config.providerCapA, 82),
      B: makeGatewayProvider("B", config.providerCapB, 112),
    };
    const healthEvents = [];
    const gatewaySlots = Array(config.gatewayCap).fill(0);
    const rows = [];
    let retries = 0;
    let hedges = 0;

    function transitionCircuit(providerName, state, atMs, reason) {
      const provider = providers[providerName];
      if (provider.health.circuitState === state) return;
      provider.health.circuitState = state;
      provider.transitions.push({ state, atMs, reason });
    }

    function openCircuit(providerName, atMs, reason) {
      const health = providers[providerName].health;
      health.openUntilMs = atMs + Math.max(500, Math.min(3000, config.deadlineMs));
      health.probeInFlight = false;
      health.recoverySuccesses = 0;
      transitionCircuit(providerName, "open", atMs, reason);
    }

    function refreshCircuit(providerName, now) {
      const health = providers[providerName].health;
      if (health.circuitState === "open" && now >= health.openUntilMs) {
        health.probeInFlight = false;
        transitionCircuit(providerName, "half-open", now, "Cooldown elapsed; admit one probe.");
      }
    }

    function updateHealth(event) {
      const provider = providers[event.provider];
      const health = provider.health;
      const weight = health.samples < 4 ? 0.34 : 0.2;
      health.samples += 1;
      health.successEwma = health.successEwma * (1 - weight) + (event.success ? 1 : 0) * weight;
      health.latencyEwma = health.latencyEwma * (1 - weight) + event.latencyMs * weight;
      health.consecutiveFailures = event.success ? 0 : health.consecutiveFailures + 1;

      if (event.breakerProbe) health.probeInFlight = false;
      if (!event.success) {
        if (
          event.breakerProbe
          || health.circuitState === "recovering"
          || health.consecutiveFailures >= 3
        ) {
          openCircuit(event.provider, event.time, event.breakerProbe
            ? "The half-open probe failed."
            : "The failure threshold was reached.");
        }
        return;
      }

      if (event.breakerProbe) {
        health.recoverySuccesses = 1;
        transitionCircuit(event.provider, "recovering", event.time, "The half-open probe succeeded.");
      } else if (health.circuitState === "recovering") {
        health.recoverySuccesses += 1;
        if (health.recoverySuccesses >= 4) {
          health.recoverySuccesses = 0;
          transitionCircuit(event.provider, "closed", event.time, "Four recovery samples succeeded.");
        }
      }
    }

    function flushHealth(now) {
      healthEvents.sort((left, right) => left.time - right.time || left.sequence - right.sequence);
      while (healthEvents.length > 0 && healthEvents[0].time <= now) {
        updateHealth(healthEvents.shift());
      }
    }

    function commitHealth(attempt) {
      if (!attempt || attempt.cancelled || attempt.healthCommitted) {
        return;
      }
      attempt.healthCommitted = true;
      healthEvents.push({
        provider: attempt.provider,
        time: attempt.endMs,
        latencyMs: attempt.endMs - attempt.startMs,
        success: attempt.success,
        sequence: attempt.sequence,
        breakerProbe: attempt.breakerProbe,
      });
    }

    function providerInflight(providerName, now) {
      return providers[providerName].attempts.filter(
        (attempt) => attempt.startMs <= now && attempt.endMs > now,
      ).length;
    }

    function adaptiveScore(providerName, now) {
      const provider = providers[providerName];
      const health = provider.health;
      const load = providerInflight(providerName, now) / provider.cap;
      const reliabilityPenalty = 1 / Math.pow(clamp(health.successEwma, 0.08, 1), 2);
      const breakerPenalty = health.circuitState === "recovering"
        ? 4 / Math.max(1, health.recoverySuccesses)
        : 1;
      return health.latencyEwma * reliabilityPenalty * breakerPenalty * (1 + load * 0.7);
    }

    function providerEligible(providerName, requestId, now) {
      refreshCircuit(providerName, now);
      const health = providers[providerName].health;
      if (health.circuitState === "open") return false;
      if (health.circuitState === "half-open") return !health.probeInFlight;
      if (health.circuitState === "recovering") {
        const share = Math.min(1, health.recoverySuccesses / 4);
        const sample = makeRandom(`${config.seed}:recovery:${providerName}:${requestId}`)();
        return sample < share;
      }
      return true;
    }

    function chooseProvider(policy, requestId, now) {
      flushHealth(now);
      const eligible = ["A", "B"].filter((providerName) => providerEligible(providerName, requestId, now));
      if (eligible.length === 0) return null;
      const halfOpen = eligible.find((providerName) => providers[providerName].health.circuitState === "half-open");
      if (halfOpen) return halfOpen;
      if (policy === "fixed") {
        return eligible.includes("A") ? "A" : eligible[0];
      }
      if (policy === "round-robin") {
        const preferred = requestId % 2 === 0 ? "A" : "B";
        return eligible.includes(preferred) ? preferred : eligible[0];
      }
      if (policy === "least-inflight") {
        return eligible.slice().sort((left, right) => {
          const loadLeft = providerInflight(left, now) / providers[left].cap;
          const loadRight = providerInflight(right, now) / providers[right].cap;
          return loadLeft - loadRight
            || providers[left].health.latencyEwma - providers[right].health.latencyEwma
            || left.localeCompare(right);
        })[0];
      }

      if (random() * 100 < config.explorationPct) {
        return eligible[Math.floor(random() * eligible.length)];
      }
      return eligible.slice().sort((left, right) => adaptiveScore(left, now) - adaptiveScore(right, now) || left.localeCompare(right))[0];
    }

    function otherProvider(providerName) {
      return providerName === "A" ? "B" : "A";
    }

    function earliestProviderStart(providerName, desiredStart, requestId) {
      if (!providerEligible(providerName, requestId, desiredStart)) return Number.POSITIVE_INFINITY;
      return Math.max(desiredStart, minimumSlot(providers[providerName].slots).freeAt);
    }

    function scheduleAttempt(providerName, desiredStart, deadlineAt, requestId, kind, ordinal) {
      if (!providerName || !providerEligible(providerName, requestId, desiredStart)) return null;
      const provider = providers[providerName];
      const slot = minimumSlot(provider.slots);
      const startMs = Math.max(desiredStart, slot.freeAt);
      if (startMs >= deadlineAt) {
        return null;
      }

      const sampled = sampleGatewayAttempt(config, providerName, requestId, ordinal);
      const rawEndMs = startMs + sampled.serviceMs;
      const timedOut = rawEndMs > deadlineAt;
      const endMs = timedOut ? deadlineAt : rawEndMs;
      const attempt = {
        provider: providerName,
        kind,
        startMs,
        scheduledStartMs: startMs,
        endMs,
        serviceMs: endMs - startMs,
        success: sampled.success && !timedOut,
        status: timedOut ? "deadline" : sampled.status,
        cancelled: false,
        dispatched: true,
        sequence: provider.attempts.length,
        slotIndex: slot.index,
        slotPreviousFreeAt: slot.freeAt,
        slotReservedUntil: endMs,
        healthCommitted: false,
        breakerProbe: provider.health.circuitState === "half-open",
      };
      if (attempt.breakerProbe) provider.health.probeInFlight = true;
      provider.slots[slot.index] = endMs;
      provider.attempts.push(attempt);
      return attempt;
    }

    function cancelAttempt(attempt, atMs) {
      if (!attempt || attempt.endMs <= atMs || attempt.cancelled) {
        return;
      }

      const provider = providers[attempt.provider];
      const reservationIsLatest = provider.slots[attempt.slotIndex] === attempt.slotReservedUntil;
      if (atMs <= attempt.startMs) {
        attempt.dispatched = false;
        attempt.startMs = atMs;
        attempt.endMs = atMs;
        if (reservationIsLatest) {
          provider.slots[attempt.slotIndex] = attempt.slotPreviousFreeAt;
        }
      } else {
        attempt.endMs = atMs;
        if (reservationIsLatest) {
          provider.slots[attempt.slotIndex] = atMs;
        }
      }
      attempt.serviceMs = attempt.endMs - attempt.startMs;
      attempt.success = false;
      attempt.status = "cancelled";
      attempt.cancelled = true;
      if (attempt.breakerProbe) provider.health.probeInFlight = false;
    }

    function retryAfterFailure(primary, deadlineAt, requestId, ordinal) {
      commitHealth(primary);
      flushHealth(primary.endMs);
      const retryProvider = otherProvider(primary.provider);
      const retry = scheduleAttempt(
        retryProvider,
        primary.endMs + 1,
        deadlineAt,
        requestId,
        "retry",
        ordinal,
      );
      if (retry) {
        retries += 1;
        commitHealth(retry);
      }
      return retry;
    }

    function simulateLogicalRequest(requestId, arrivalMs, startMs, deadlineAt) {
      const attempts = [];
      const primaryProvider = chooseProvider(
        config.policy === "hedge" ? "adaptive" : config.policy,
        requestId,
        startMs,
      );
      const primary = scheduleAttempt(
        primaryProvider,
        startMs,
        deadlineAt,
        requestId,
        "primary",
        0,
      );
      if (!primary) {
        return { attempts, success: false, endMs: startMs, status: "no-eligible-provider" };
      }
      attempts.push(primary);

      if (config.policy !== "hedge") {
        commitHealth(primary);
        if (primary.success) {
          return { attempts, success: true, endMs: primary.endMs, status: "ok" };
        }
        if (primary.endMs < deadlineAt && primary.status !== "deadline") {
          const retry = retryAfterFailure(primary, deadlineAt, requestId, 1);
          if (retry) {
            attempts.push(retry);
            return {
              attempts,
              success: retry.success,
              endMs: retry.endMs,
              status: retry.success ? "ok" : retry.status,
            };
          }
        }
        return { attempts, success: false, endMs: primary.endMs, status: primary.status };
      }

      const hedgeAt = Math.min(deadlineAt, startMs + config.hedgeMs);
      if (primary.endMs <= hedgeAt) {
        if (primary.success) {
          commitHealth(primary);
          return { attempts, success: true, endMs: primary.endMs, status: "ok" };
        }
        const retry = retryAfterFailure(primary, deadlineAt, requestId, 1);
        if (retry) {
          attempts.push(retry);
          return {
            attempts,
            success: retry.success,
            endMs: retry.endMs,
            status: retry.success ? "ok" : retry.status,
          };
        }
        return { attempts, success: false, endMs: primary.endMs, status: primary.status };
      }

      const secondaryProvider = otherProvider(primary.provider);
      const secondaryStart = earliestProviderStart(secondaryProvider, hedgeAt, requestId);
      if (secondaryStart >= primary.endMs || secondaryStart >= deadlineAt) {
        if (primary.success) {
          commitHealth(primary);
          return { attempts, success: true, endMs: primary.endMs, status: "ok" };
        }
        const retry = retryAfterFailure(primary, deadlineAt, requestId, 1);
        if (retry) {
          attempts.push(retry);
          return {
            attempts,
            success: retry.success,
            endMs: retry.endMs,
            status: retry.success ? "ok" : retry.status,
          };
        }
        return { attempts, success: false, endMs: primary.endMs, status: primary.status };
      }

      const hedge = scheduleAttempt(
        secondaryProvider,
        hedgeAt,
        deadlineAt,
        requestId,
        "hedge",
        1,
      );
      if (!hedge) {
        commitHealth(primary);
        return {
          attempts,
          success: primary.success,
          endMs: primary.endMs,
          status: primary.success ? "ok" : primary.status,
        };
      }
      attempts.push(hedge);
      hedges += 1;

      const successful = attempts
        .filter((attempt) => attempt.success)
        .sort((left, right) => left.endMs - right.endMs);
      if (successful.length > 0) {
        const winner = successful[0];
        attempts.forEach((attempt) => {
          if (attempt !== winner && attempt.endMs > winner.endMs) {
            cancelAttempt(attempt, winner.endMs);
          }
        });
        attempts.forEach(commitHealth);
        return { attempts, success: true, endMs: winner.endMs, status: "ok" };
      }

      attempts.forEach(commitHealth);
      const endMs = Math.max(...attempts.map((attempt) => attempt.endMs));
      const lastAttempt = attempts.find((attempt) => attempt.endMs === endMs);
      return { attempts, success: false, endMs, status: lastAttempt.status };
    }

    for (let requestId = 0; requestId < config.requests; requestId += 1) {
      const arrivalMs = (requestId * 1000) / config.rps;
      const deadlineAt = arrivalMs + config.deadlineMs;
      const queuedAhead = rows.filter(
        (row) => row.queued && row.queueExitMs > arrivalMs && row.arrivalMs <= arrivalMs,
      ).length;
      const gatewaySlot = minimumSlot(gatewaySlots);
      const mustQueue = gatewaySlot.freeAt > arrivalMs;

      if (mustQueue && queuedAhead >= config.queueCap) {
        rows.push({
          id: requestId,
          arrivalMs,
          startMs: null,
          endMs: arrivalMs,
          queueMs: 0,
          queueExitMs: arrivalMs,
          latencyMs: 0,
          queued: false,
          dropped: true,
          success: false,
          status: "queue-overflow",
          route: "dropped",
          attempts: [],
        });
        continue;
      }

      const startMs = Math.max(arrivalMs, gatewaySlot.freeAt);
      if (startMs >= deadlineAt) {
        rows.push({
          id: requestId,
          arrivalMs,
          startMs: null,
          endMs: deadlineAt,
          queueMs: config.deadlineMs,
          queueExitMs: deadlineAt,
          latencyMs: config.deadlineMs,
          queued: true,
          dropped: false,
          success: false,
          status: "queue-deadline",
          route: "none",
          attempts: [],
        });
        continue;
      }

      const logical = simulateLogicalRequest(requestId, arrivalMs, startMs, deadlineAt);
      gatewaySlots[gatewaySlot.index] = logical.endMs;
      rows.push({
        id: requestId,
        arrivalMs,
        startMs,
        endMs: logical.endMs,
        queueMs: startMs - arrivalMs,
        queueExitMs: startMs,
        latencyMs: logical.endMs - arrivalMs,
        queued: mustQueue,
        dropped: false,
        success: logical.success,
        status: logical.status,
        route: logical.attempts.map((attempt) => attempt.provider).join(" -> ") || "none",
        attempts: logical.attempts.map((attempt) => ({
          provider: attempt.provider,
          kind: attempt.kind,
          breakerProbe: attempt.breakerProbe,
          startMs: attempt.startMs,
          scheduledStartMs: attempt.scheduledStartMs,
          endMs: attempt.endMs,
          latencyMs: attempt.endMs - attempt.startMs,
          success: attempt.success,
          status: attempt.status,
          cancelled: attempt.cancelled,
          dispatched: attempt.dispatched,
        })),
      });
    }

    flushHealth(Number.POSITIVE_INFINITY);
    const completedRows = rows.filter((row) => !row.dropped);
    const successfulRows = completedRows.filter((row) => row.success);
    const successfulLatencies = successfulRows.map((row) => row.latencyMs);
    const terminalLatencies = rows.map((row) => row.latencyMs);
    const allAttempts = [...providers.A.attempts, ...providers.B.attempts];
    const providerResults = {};

    ["A", "B"].forEach((providerName) => {
      const provider = providers[providerName];
      const completed = provider.attempts.filter((attempt) => !attempt.cancelled);
      const latencies = completed.map((attempt) => attempt.endMs - attempt.startMs);
      const successRatio = completed.length === 0
        ? 0
        : completed.filter((attempt) => attempt.success).length / completed.length;
      providerResults[providerName] = {
        name: providerName,
        cap: provider.cap,
        attempts: provider.attempts.length,
        successes: completed.filter((attempt) => attempt.success).length,
        failures: completed.filter((attempt) => !attempt.success).length,
        cancelled: provider.attempts.filter((attempt) => attempt.cancelled).length,
        successRate: roundTo(successRatio * 100, 1),
        successRatio,
        share: allAttempts.length === 0
          ? 0
          : Math.round((provider.attempts.length / allAttempts.length) * 1000) / 10,
        sharePct: allAttempts.length === 0
          ? 0
          : Math.round((provider.attempts.length / allAttempts.length) * 1000) / 10,
        state: provider.health.circuitState,
        circuitState: provider.health.circuitState,
        recoverySuccesses: provider.health.recoverySuccesses,
        transitions: provider.transitions.slice(),
        latencyEWMA: provider.health.latencyEwma,
        ewmaLatency: provider.health.latencyEwma,
        averageLatencyMs: roundTo(average(latencies), 1),
        p95LatencyMs: roundTo(percentile(latencies, 95), 1),
        maxInFlight: maximumConcurrency(provider.attempts),
        health: {
          samples: provider.health.samples,
          successEwma: provider.health.successEwma,
          latencyEwma: provider.health.latencyEwma,
          circuitState: provider.health.circuitState,
          openUntilMs: provider.health.openUntilMs,
          recoverySuccesses: provider.health.recoverySuccesses,
        },
      };
    });

    const successRatio = successfulRows.length / config.requests;
    const durationMs = Math.max(0, ...rows.map((row) => row.endMs));
    const queueIntervals = rows
      .filter((row) => row.queued && row.startMs !== null && row.startMs > row.arrivalMs)
      .map((row) => ({ startMs: row.arrivalMs, endMs: row.startMs }));
    const metrics = {
      successRate: roundTo(successRatio * 100, 1),
      successRatio,
      latencyPopulation: "successful requests",
      p50: roundTo(percentile(successfulLatencies, 50), 1),
      p95: roundTo(percentile(successfulLatencies, 95), 1),
      p99: roundTo(percentile(successfulLatencies, 99), 1),
      successP50: roundTo(percentile(successfulLatencies, 50), 1),
      successP95: roundTo(percentile(successfulLatencies, 95), 1),
      successP99: roundTo(percentile(successfulLatencies, 99), 1),
      terminalP50: roundTo(percentile(terminalLatencies, 50), 1),
      terminalP95: roundTo(percentile(terminalLatencies, 95), 1),
      terminalP99: roundTo(percentile(terminalLatencies, 99), 1),
      queueP95: roundTo(percentile(completedRows.map((row) => row.queueMs), 95), 1),
      attemptsPerRequest: roundTo(allAttempts.length / config.requests, 2),
      attemptPopulation: "all logical requests",
      maxActive: maximumConcurrency(allAttempts),
      maxQueueDepth: maximumConcurrency(queueIntervals),
      dropped: rows.filter((row) => row.dropped).length,
      retries,
      hedges,
      completed: completedRows.length,
      successful: successfulRows.length,
      durationMs,
      offeredRps: config.rps,
      achievedRps: durationMs > 0 ? roundTo(successfulRows.length / (durationMs / 1000), 1) : 0,
      terminalRps: durationMs > 0 ? roundTo(rows.length / (durationMs / 1000), 1) : 0,
    };

    if (metrics.dropped > 0) {
      warnings.push(`Gateway queue overflow dropped ${metrics.dropped} requests.`);
    }
    if (rows.some((row) => row.status === "queue-deadline")) {
      warnings.push("Some requests expired while waiting for a gateway slot.");
    }
    if (metrics.successRate < 99) {
      warnings.push("Success rate stayed below 99%; inspect routing health and deadline pressure.");
    }
    if (metrics.attemptsPerRequest > 1.25) {
      warnings.push("Retries and hedges added more than 25% request amplification.");
    }
    if (metrics.p95 >= config.deadlineMs * 0.8) {
      warnings.push("Successful-request p95 latency approached the request deadline.");
    }
    if (
      providerResults.A.maxInFlight > providerResults.A.cap
      || providerResults.B.maxInFlight > providerResults.B.cap
    ) {
      warnings.push("A provider concurrency cap was exceeded.");
    }

    const result = {
      kind: "gateway",
      config,
      metrics,
      providers: providerResults,
      requests: rows,
      rows,
      windows: gatewayPhaseWindows(config, rows),
      warnings,
    };
    result.fingerprint = stableFingerprint({ kind: result.kind, config: result.config });
    return result;
  }

  function normalizeCrawlerScenario(value) {
    const aliases = {
      normal: "steady",
      balanced: "steady",
      robots: "robots-outage",
      "robots-503": "robots-outage",
      failures: "retry-storm",
      trap: "crawl-trap",
    };
    const normalized = aliases[value] || value || "mixed";
    const supported = new Set([
      "steady",
      "mixed",
      "shared-ip",
      "hot-host",
      "robots-outage",
      "retry-storm",
      "crawl-trap",
      "partition",
    ]);
    return supported.has(normalized) ? normalized : "mixed";
  }

  function normalizeCrawlerConfig(input) {
    const requested = input || {};
    return {
      scheduler: CRAWLER_SCHEDULERS.has(requested.scheduler)
        ? requested.scheduler
        : "host-aware",
      workers: boundedInteger(requested.workers, 8, 1, 128),
      perHostCap: boundedInteger(requested.perHostCap, 2, 1, 32),
      perIpCap: boundedInteger(requested.perIpCap, 3, 1, 64),
      minDelayMs: clamp(finiteNumber(requested.minDelayMs, 120), 0, 60000),
      respectRobots: requested.respectRobots !== false,
      seed: requested.seed === undefined ? 11 : requested.seed,
      scenario: normalizeCrawlerScenario(requested.scenario),
    };
  }

  function crawlerHostDefinitions(scenario) {
    const hosts = [
      {
        host: "alpha.example",
        ip: "198.51.100.10",
        pages: 12,
        latencyMs: 115,
        failureRate: 0.025,
        robotsStatus: 200,
        privateEvery: 8,
        duplicateEvery: 9,
      },
      {
        host: "beta.example",
        ip: "198.51.100.10",
        pages: 10,
        latencyMs: 155,
        failureRate: 0.035,
        robotsStatus: 200,
        privateEvery: 0,
        duplicateEvery: 8,
      },
      {
        host: "gamma.example",
        ip: "198.51.100.20",
        pages: 11,
        latencyMs: 88,
        failureRate: 0.018,
        robotsStatus: 404,
        privateEvery: 0,
        duplicateEvery: 10,
      },
      {
        host: "delta.example",
        ip: "198.51.100.30",
        pages: 7,
        latencyMs: 104,
        failureRate: 0.03,
        robotsStatus: scenario === "steady" ? 200 : 503,
        privateEvery: 0,
        duplicateEvery: 0,
      },
      {
        host: "hot.example",
        ip: "198.51.100.40",
        pages: scenario === "crawl-trap" ? 46 : scenario === "hot-host" ? 32 : 16,
        latencyMs: 205,
        failureRate: 0.045,
        robotsStatus: 200,
        privateEvery: 0,
        duplicateEvery: scenario === "crawl-trap" ? 4 : 7,
      },
    ];

    if (scenario === "shared-ip") {
      hosts[0].pages = 24;
      hosts[1].pages = 24;
      hosts[3].robotsStatus = 200;
    }
    if (scenario === "robots-outage") {
      hosts[3].pages = 18;
    }
    if (scenario === "retry-storm") {
      hosts.forEach((host) => {
        host.failureRate = Math.max(host.failureRate, 0.24);
      });
      hosts[3].robotsStatus = 200;
    }
    if (scenario === "partition") {
      hosts[3].robotsStatus = 200;
    }
    return hosts;
  }

  function buildCrawlerTasks(config, hosts) {
    const perHost = new Map();
    let sequence = 0;
    hosts.forEach((hostDefinition, hostIndex) => {
      const tasks = [];
      for (let page = 0; page < hostDefinition.pages; page += 1) {
        let path = `/page/${page}`;
        if (hostDefinition.privateEvery > 0 && page % hostDefinition.privateEvery === 0) {
          path = `/private/${page}`;
        }
        if (config.scenario === "crawl-trap" && hostDefinition.host === "hot.example") {
          path = `/calendar/2026/${page}?session=${page % 13}`;
        }

        let url = `https://${hostDefinition.host}${path}`;
        if (config.scenario === "crawl-trap" && page > 0 && page % 11 === 0) {
          url = tasks[tasks.length - 1].url;
        }
        tasks.push({
          id: sequence,
          sequence,
          url,
          host: hostDefinition.host,
          ip: hostDefinition.ip,
          discoveredAt: Math.floor(sequence / 7) * 8,
          firstDiscoveredAt: Math.floor(sequence / 7) * 8,
          attempt: 1,
          robotsAllowed: !path.startsWith("/private/"),
          contentDuplicate: hostDefinition.duplicateEvery > 0
            && page > 0
            && page % hostDefinition.duplicateEvery === 0,
          hostIndex,
        });
        sequence += 1;
      }
      perHost.set(hostDefinition.host, tasks);
    });

    if (config.scenario === "hot-host" || config.scenario === "crawl-trap") {
      return [
        ...perHost.get("hot.example"),
        ...hosts
          .filter((hostDefinition) => hostDefinition.host !== "hot.example")
          .flatMap((hostDefinition) => perHost.get(hostDefinition.host)),
      ];
    }

    const tasks = [];
    let remaining = true;
    let index = 0;
    while (remaining) {
      remaining = false;
      hosts.forEach((hostDefinition) => {
        const hostTasks = perHost.get(hostDefinition.host);
        if (index < hostTasks.length) {
          tasks.push(hostTasks[index]);
          remaining = true;
        }
      });
      index += 1;
    }
    tasks.forEach((task, taskIndex) => {
      task.sequence = taskIndex;
    });
    return tasks;
  }

  function sampleCrawlerAttempt(config, hostDefinition, task) {
    const random = makeRandom(`${config.seed}:${task.url}:${task.attempt}`);
    let latencyMs = hostDefinition.latencyMs * (0.72 + random() * 0.58);
    if (random() < 0.07) {
      latencyMs += hostDefinition.latencyMs * (1.2 + random() * 2.1);
    }
    const failed = random() < hostDefinition.failureRate;
    return {
      latencyMs: Math.max(8, latencyMs),
      success: !failed,
      status: failed ? (random() < 0.62 ? "503" : "transport") : "200",
    };
  }

  function runCrawler(input) {
    const config = normalizeCrawlerConfig(input);
    const warnings = [];
    const hostDefinitions = crawlerHostDefinitions(config.scenario);
    const hostDefinitionByName = new Map(
      hostDefinitions.map((hostDefinition) => [hostDefinition.host, hostDefinition]),
    );
    const hostStates = new Map();
    const ipStates = new Map();
    hostDefinitions.forEach((hostDefinition) => {
      hostStates.set(hostDefinition.host, {
        host: hostDefinition.host,
        ip: hostDefinition.ip,
        slots: Array(config.perHostCap).fill(0),
        nextAllowedAt: 0,
        ownerReadyAt: config.scenario === "partition" && hostDefinition.host === "beta.example"
          ? 2200
          : 0,
        dispatches: 0,
      });
      if (!ipStates.has(hostDefinition.ip)) {
        ipStates.set(hostDefinition.ip, {
          ip: hostDefinition.ip,
          slots: Array(config.perIpCap).fill(0),
        });
      }
    });

    const workerSlots = Array(config.workers).fill(0);
    const pending = [];
    const events = [];
    const seenUrls = new Set();
    const exactDuplicates = new Set();
    let nextSequence = 0;
    let fifoBarrier = 0;

    buildCrawlerTasks(config, hostDefinitions).forEach((task) => {
      nextSequence = Math.max(nextSequence, task.sequence + 1);
      if (seenUrls.has(task.url)) {
        exactDuplicates.add(task.url);
        events.push({
          id: `dedupe-${task.id}`,
          type: "dedupe",
          url: task.url,
          host: task.host,
          ip: task.ip,
          discoveredAt: task.discoveredAt,
          startMs: task.discoveredAt,
          endMs: task.discoveredAt,
          queueMs: 0,
          attempt: 0,
          status: "duplicate-url",
          success: false,
          duplicate: true,
          policyViolation: false,
        });
        return;
      }
      seenUrls.add(task.url);

      const hostDefinition = hostDefinitionByName.get(task.host);
      const robotsUnavailable = hostDefinition.robotsStatus === 503;
      const disallowedByRule = hostDefinition.robotsStatus === 200 && !task.robotsAllowed;
      if (config.respectRobots && (robotsUnavailable || disallowedByRule)) {
        events.push({
          id: `blocked-${task.id}`,
          type: "blocked",
          url: task.url,
          host: task.host,
          ip: task.ip,
          discoveredAt: task.discoveredAt,
          startMs: task.discoveredAt,
          endMs: task.discoveredAt,
          queueMs: 0,
          attempt: 0,
          robotsStatus: hostDefinition.robotsStatus,
          status: robotsUnavailable ? "blocked-robots-503" : "blocked-by-rule",
          success: false,
          duplicate: false,
          policyViolation: false,
        });
        return;
      }
      pending.push(task);
    });

    function taskEligibility(task) {
      const worker = minimumSlot(workerSlots);
      const hostState = hostStates.get(task.host);
      const hostSlot = minimumSlot(hostState.slots);
      const ipState = ipStates.get(task.ip);
      const ipSlot = minimumSlot(ipState.slots);
      return {
        startMs: Math.max(
          task.discoveredAt,
          worker.freeAt,
          hostSlot.freeAt,
          ipSlot.freeAt,
          hostState.nextAllowedAt,
          hostState.ownerReadyAt,
        ),
        worker,
        hostSlot,
        ipSlot,
      };
    }

    function choosePendingTask() {
      if (config.scheduler === "fifo") {
        const task = pending[0];
        const eligibility = taskEligibility(task);
        eligibility.startMs = Math.max(eligibility.startMs, fifoBarrier);
        return { pendingIndex: 0, task, eligibility };
      }

      const firstByHost = new Map();
      pending.forEach((task, pendingIndex) => {
        if (!firstByHost.has(task.host)) {
          firstByHost.set(task.host, { task, pendingIndex });
        }
      });
      return [...firstByHost.values()]
        .map((candidate) => ({
          ...candidate,
          eligibility: taskEligibility(candidate.task),
          dispatches: hostStates.get(candidate.task.host).dispatches,
        }))
        .sort((left, right) => (
          left.eligibility.startMs - right.eligibility.startMs
          || left.dispatches - right.dispatches
          || left.task.sequence - right.task.sequence
        ))[0];
    }

    while (pending.length > 0) {
      const chosen = choosePendingTask();
      const task = chosen.task;
      const eligibility = chosen.eligibility;
      pending.splice(chosen.pendingIndex, 1);

      const hostDefinition = hostDefinitionByName.get(task.host);
      const hostState = hostStates.get(task.host);
      const ipState = ipStates.get(task.ip);
      const startMs = eligibility.startMs;
      const sampled = sampleCrawlerAttempt(config, hostDefinition, task);
      const endMs = startMs + sampled.latencyMs;
      const robotsViolation = !config.respectRobots && (
        hostDefinition.robotsStatus === 503
        || (hostDefinition.robotsStatus === 200 && !task.robotsAllowed)
      );

      workerSlots[eligibility.worker.index] = endMs;
      hostState.slots[eligibility.hostSlot.index] = endMs;
      ipState.slots[eligibility.ipSlot.index] = endMs;
      hostState.nextAllowedAt = startMs + config.minDelayMs;
      hostState.dispatches += 1;
      if (config.scheduler === "fifo") {
        fifoBarrier = startMs;
      }

      events.push({
        id: `fetch-${task.id}-${task.attempt}`,
        type: "fetch",
        url: task.url,
        host: task.host,
        ip: task.ip,
        discoveredAt: task.firstDiscoveredAt,
        eligibleAt: task.discoveredAt,
        startMs,
        endMs,
        queueMs: startMs - task.firstDiscoveredAt,
        worker: eligibility.worker.index,
        attempt: task.attempt,
        robotsStatus: hostDefinition.robotsStatus,
        status: sampled.status,
        success: sampled.success,
        duplicate: sampled.success && task.contentDuplicate,
        policyViolation: robotsViolation,
      });

      if (!sampled.success && task.attempt < 2) {
        const retryRandom = makeRandom(`${config.seed}:${task.url}:backoff`);
        pending.push({
          ...task,
          id: `${task.id}-retry`,
          sequence: nextSequence,
          attempt: task.attempt + 1,
          discoveredAt: endMs + 180 + retryRandom() * 420,
        });
        nextSequence += 1;
      }
    }

    events.sort((left, right) => (
      left.startMs - right.startMs
      || left.endMs - right.endMs
      || String(left.id).localeCompare(String(right.id))
    ));
    events.forEach((event) => {
      event.timeMs = roundTo(event.startMs, 1);
      event.at = event.timeMs;
    });

    const fetchEvents = events.filter((event) => event.type === "fetch");
    const successfulUrls = new Set(
      fetchEvents.filter((event) => event.success).map((event) => event.url),
    );
    const blockedUrls = new Set(
      events.filter((event) => event.type === "blocked").map((event) => event.url),
    );
    const contentDuplicates = new Set(
      fetchEvents.filter((event) => event.duplicate).map((event) => event.url),
    );
    const firstAttempts = new Map();
    fetchEvents.forEach((event) => {
      if (!firstAttempts.has(event.url) || event.attempt < firstAttempts.get(event.url).attempt) {
        firstAttempts.set(event.url, event);
      }
    });

    let policyViolations = fetchEvents.filter((event) => event.policyViolation).length;
    const hostIntervals = new Map();
    const ipIntervals = new Map();
    fetchEvents.forEach((event) => {
      if (!hostIntervals.has(event.host)) {
        hostIntervals.set(event.host, []);
      }
      if (!ipIntervals.has(event.ip)) {
        ipIntervals.set(event.ip, []);
      }
      hostIntervals.get(event.host).push(event);
      ipIntervals.get(event.ip).push(event);
    });

    hostIntervals.forEach((hostEvents) => {
      const ordered = hostEvents.slice().sort((left, right) => left.startMs - right.startMs);
      for (let index = 1; index < ordered.length; index += 1) {
        if (ordered[index].startMs - ordered[index - 1].startMs < config.minDelayMs - 0.0001) {
          policyViolations += 1;
        }
      }
      if (maximumConcurrency(ordered) > config.perHostCap) {
        policyViolations += 1;
      }
    });
    ipIntervals.forEach((ipEvents) => {
      if (maximumConcurrency(ipEvents) > config.perIpCap) {
        policyViolations += 1;
      }
    });

    const hostSummaries = hostDefinitions.map((hostDefinition) => {
      const hostEvents = fetchEvents.filter((event) => event.host === hostDefinition.host);
      const completed = hostEvents.filter((event) => event.success);
      const hostState = hostStates.get(hostDefinition.host);
      const nextAllowedAt = Math.max(
        hostState.nextAllowedAt,
        minimumSlot(hostState.slots).freeAt,
      );
      return {
        host: hostDefinition.host,
        ip: hostDefinition.ip,
        robotsStatus: hostDefinition.robotsStatus,
        nextAllowedAt: roundTo(nextAllowedAt, 1),
        nextEligibleAt: roundTo(nextAllowedAt, 1),
        discovered: new Set(
          events
            .filter((event) => event.host === hostDefinition.host)
            .map((event) => event.url),
        ).size,
        fetched: new Set(completed.map((event) => event.url)).size,
        blocked: new Set(
          events
            .filter((event) => event.host === hostDefinition.host && event.type === "blocked")
            .map((event) => event.url),
        ).size,
        attempts: hostEvents.length,
        retries: hostEvents.filter((event) => event.attempt > 1).length,
        failures: hostEvents.filter((event) => !event.success).length,
        duplicates: new Set(
          hostEvents.filter((event) => event.duplicate).map((event) => event.url),
        ).size,
        maxInFlight: maximumConcurrency(hostEvents),
        p95LatencyMs: roundTo(percentile(
          hostEvents.map((event) => event.endMs - event.startMs),
          95,
        ), 1),
        lastFetchMs: roundTo(Math.max(0, ...hostEvents.map((event) => event.endMs)), 1),
      };
    });

    const durationMs = Math.max(0, ...events.map((event) => event.endMs));
    const metrics = {
      fetched: successfulUrls.size,
      blocked: blockedUrls.size,
      retries: fetchEvents.filter((event) => event.attempt > 1).length,
      duplicates: exactDuplicates.size + contentDuplicates.size,
      policyViolations,
      frontierAgeP95: roundTo(percentile(
        [...firstAttempts.values()].map((event) => event.startMs - event.discoveredAt),
        95,
      ), 1),
      attempts: fetchEvents.length,
      successRate: fetchEvents.length === 0
        ? 0
        : roundTo(
          (fetchEvents.filter((event) => event.success).length / fetchEvents.length) * 100,
          1,
        ),
      successRatio: fetchEvents.length === 0
        ? 0
        : fetchEvents.filter((event) => event.success).length / fetchEvents.length,
      durationMs,
      throughputPerSecond: durationMs === 0
        ? 0
        : roundTo((successfulUrls.size * 1000) / durationMs, 2),
      maxHostConcurrency: Math.max(0, ...hostSummaries.map((summary) => summary.maxInFlight)),
      maxIpConcurrency: Math.max(
        0,
        ...[...ipIntervals.values()].map((intervals) => maximumConcurrency(intervals)),
      ),
    };

    if (metrics.blocked > 0) {
      warnings.push(`${metrics.blocked} URLs were blocked by robots policy.`);
    }
    if (metrics.policyViolations > 0) {
      warnings.push(`${metrics.policyViolations} crawl policy violations were detected.`);
    }
    if (metrics.retries > Math.max(2, metrics.fetched * 0.2)) {
      warnings.push("Retry traffic exceeded 20% of successful fetches.");
    }
    if (metrics.duplicates > 0) {
      warnings.push(`${metrics.duplicates} duplicate URLs or responses were identified.`);
    }
    if (config.scheduler === "fifo" && config.minDelayMs > 0) {
      warnings.push("FIFO can leave eligible hosts waiting behind a delayed authority.");
    }
    if (metrics.maxIpConcurrency > config.perIpCap) {
      warnings.push("The shared-IP concurrency cap was exceeded.");
    }
    if (config.scenario === "partition") {
      warnings.push("Owner handoff delayed beta.example for 2.2 seconds.");
    }

    const result = {
      kind: "crawler",
      config,
      events,
      hosts: hostSummaries,
      hostSummaries,
      metrics,
      warnings,
    };
    result.fingerprint = stableFingerprint({ kind: result.kind, config: result.config });
    return result;
  }

  function formatMetric(value, suffix) {
    if (!Number.isFinite(value)) {
      return `0${suffix || ""}`;
    }
    const rounded = Math.abs(value) >= 100 ? value.toFixed(0) : value.toFixed(2);
    return `${rounded}${suffix || ""}`;
  }

  function cleanMarkdownText(value) {
    return String(value || "").replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
  }

  function markdownBenchmark(result, note) {
    if (!result || !result.metrics || !result.config) {
      return "## Benchmark\n\nNo simulation result was supplied.";
    }

    const heading = result.kind === "crawler" ? "Crawler benchmark" : "Gateway benchmark";
    const lines = [
      `## ${heading} ${result.fingerprint || stableFingerprint(result.config)}`,
      "",
      `Scenario: \`${result.config.scenario}\``,
    ];
    if (note) {
      lines.push("", `Note: ${cleanMarkdownText(note)}`);
    }
    lines.push("", "| Metric | Result |", "| --- | ---: |");

    if (result.kind === "crawler") {
      lines.push(
        `| Scheduler | ${result.config.scheduler} |`,
        `| Fetched URLs | ${result.metrics.fetched} |`,
        `| Blocked URLs | ${result.metrics.blocked} |`,
        `| Retries | ${result.metrics.retries} |`,
        `| Duplicates | ${result.metrics.duplicates} |`,
        `| Policy violations | ${result.metrics.policyViolations} |`,
        `| Frontier age p95 | ${formatMetric(result.metrics.frontierAgeP95, " ms")} |`,
        `| Throughput | ${formatMetric(result.metrics.throughputPerSecond, " URLs/s")} |`,
      );
    } else {
      lines.push(
        `| Policy | ${result.config.policy} |`,
        `| Success rate | ${formatMetric(result.metrics.successRate, "%")} |`,
        `| Latency p50 | ${formatMetric(result.metrics.p50, " ms")} |`,
        `| Latency p95 | ${formatMetric(result.metrics.p95, " ms")} |`,
        `| Latency p99 | ${formatMetric(result.metrics.p99, " ms")} |`,
        `| Queue p95 | ${formatMetric(result.metrics.queueP95, " ms")} |`,
        `| Attempts per request | ${formatMetric(result.metrics.attemptsPerRequest, "")} |`,
        `| Dropped | ${result.metrics.dropped} |`,
        `| Retries | ${result.metrics.retries} |`,
        `| Hedges | ${result.metrics.hedges} |`,
      );
      lines.push("", "| Provider | Attempts | Success | P95 | Max in flight |", "| --- | ---: | ---: | ---: | ---: |");
      ["A", "B"].forEach((providerName) => {
        const provider = result.providers[providerName];
        lines.push(
          `| ${providerName} | ${provider.attempts} | ${formatMetric(provider.successRate, "%")} | ${formatMetric(provider.p95LatencyMs, " ms")} | ${provider.maxInFlight} |`,
        );
      });
    }

    if (result.warnings && result.warnings.length > 0) {
      lines.push("", "Warnings:");
      result.warnings.forEach((warning) => lines.push(`- ${cleanMarkdownText(warning)}`));
    }
    return lines.join("\n");
  }

  return {
    runGateway,
    runCrawler,
    percentile,
    stableFingerprint,
    markdownBenchmark,
  };
});
