(function initializeGatewayLabModels(root) {
  "use strict";

  const FLEET_SCENARIOS = new Set([
    "healthy",
    "coordinator-partition",
    "provider-outage",
    "zone-outage",
    "mass-restart"
  ]);
  const FLEET_STRATEGIES = new Set([
    "local-caps",
    "leases",
    "central-check"
  ]);
  const INCIDENT_SCENARIOS = new Set([
    "provider-slowdown",
    "provider-outage",
    "telemetry-sink-outage",
    "bad-configuration",
    "mass-restart"
  ]);
  const CONFIG_MODES = new Set(["atomic", "partial"]);
  const MAX_INCIDENT_DURATION_SEC = 3600;
  const BASE_ATTEMPT_SUCCESS_PROBABILITY = 0.995;
  const LEASE_SAFETY_MARGIN_SEC = 5;
  const DETERMINISTIC_LATENCY_BUCKETS = Object.freeze([
    { probability: 0.50, p95Multiplier: 0.55 },
    { probability: 0.40, p95Multiplier: 0.85 },
    { probability: 0.05, p95Multiplier: 1.00 },
    { probability: 0.04, p95Multiplier: 1.35 },
    { probability: 0.01, p95Multiplier: 2.00 }
  ]);
  const QUEUE_DELAY_BUCKET_COUNT = 20;

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function finiteNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function boundedNumber(value, fallback, minimum, maximum) {
    return clamp(finiteNumber(value, fallback), minimum, maximum);
  }

  function boundedInteger(value, fallback, minimum, maximum) {
    return Math.round(boundedNumber(value, fallback, minimum, maximum));
  }

  function roundTo(value, digits = 2) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function sum(values) {
    return values.reduce((total, value) => total + value, 0);
  }

  function hasFiniteValue(value) {
    return value !== ""
      && value !== null
      && value !== undefined
      && Number.isFinite(Number(value));
  }

  function normalizeFleetConfig(input) {
    const requested = input || {};
    const replicas = boundedInteger(requested.replicas, 15, 1, 500);
    const zones = Math.min(
      replicas,
      boundedInteger(requested.zones, 3, 1, 20)
    );
    const providerQuotaB = boundedInteger(
      requested.providerQuotaB,
      100,
      1,
      1000000
    );

    return {
      scenario: FLEET_SCENARIOS.has(requested.scenario)
        ? requested.scenario
        : "healthy",
      strategy: FLEET_STRATEGIES.has(requested.strategy)
        ? requested.strategy
        : "leases",
      replicas,
      zones,
      localCap: boundedInteger(requested.localCap, 10, 1, 100000),
      providerQuotaA: boundedInteger(
        requested.providerQuotaA,
        100,
        1,
        1000000
      ),
      providerQuotaB,
      offeredConcurrency: boundedInteger(
        requested.offeredConcurrency,
        150,
        0,
        10000000
      ),
      normalShareA: boundedNumber(requested.normalShareA, 60, 0, 100),
      failoverReserveB: boundedInteger(
        requested.failoverReserveB,
        20,
        0,
        providerQuotaB
      ),
      leaseTtlSec: boundedInteger(requested.leaseTtlSec, 60, 1, 3600),
      maxAttemptSec: boundedInteger(requested.maxAttemptSec, 30, 1, 3600),
      coldStartPct: boundedNumber(requested.coldStartPct, 20, 1, 100),
      restartRampSec: boundedInteger(requested.restartRampSec, 30, 1, 600)
    };
  }

  function fleetTopology(config) {
    const replicasInLostZone = config.scenario === "zone-outage"
      ? Math.ceil(config.replicas / config.zones)
      : 0;
    const activeReplicas = Math.max(0, config.replicas - replicasInLostZone);
    const activeZones = config.scenario === "zone-outage"
      ? Math.max(0, config.zones - 1)
      : config.zones;

    return {
      replicas: config.replicas,
      zones: config.zones,
      activeReplicas,
      lostReplicas: replicasInLostZone,
      activeZones,
      lostZones: config.zones - activeZones
    };
  }

  function fleetDemand(config) {
    const shareA = config.scenario === "provider-outage"
      ? 0
      : config.scenario === "mass-restart"
        ? 50
        : config.normalShareA;
    const providerA = roundTo(config.offeredConcurrency * (shareA / 100), 4);

    return {
      total: config.offeredConcurrency,
      providerA,
      providerB: roundTo(config.offeredConcurrency - providerA, 4),
      shareA,
      shareB: 100 - shareA
    };
  }

  function fleetStrategyCapacity(config, topology) {
    const aggregateLocalCapPerProvider = topology.activeReplicas * config.localCap;
    const zoneFraction = config.zones === 0
      ? 0
      : topology.activeZones / config.zones;
    const ordinaryBudgetB = Math.max(
      0,
      config.providerQuotaB - config.failoverReserveB
    );
    const releaseReserve = config.scenario === "provider-outage";
    const massRestartFactor = config.scenario === "mass-restart"
      ? config.coldStartPct / 100
      : 1;

    if (config.strategy === "local-caps") {
      return {
        providerA: aggregateLocalCapPerProvider,
        providerB: aggregateLocalCapPerProvider,
        aggregateLocalCapPerProvider,
        allocationMode: "Independent local caps",
        allocationDetail: "Every active replica can admit up to its configured cap for each provider."
      };
    }

    if (config.strategy === "central-check") {
      const coordinatorAvailable = config.scenario !== "coordinator-partition";
      const centralA = coordinatorAvailable ? config.providerQuotaA : 0;
      const centralB = coordinatorAvailable
        ? releaseReserve
          ? config.providerQuotaB
          : ordinaryBudgetB
        : 0;

      return {
        providerA: Math.min(
          aggregateLocalCapPerProvider,
          centralA * massRestartFactor
        ),
        providerB: Math.min(
          aggregateLocalCapPerProvider,
          centralB * massRestartFactor
        ),
        aggregateLocalCapPerProvider,
        allocationMode: "Central check per attempt",
        allocationDetail: coordinatorAvailable
          ? "Every provider attempt receives an exact central decision."
          : "New attempts fail closed while the coordinator is unavailable."
      };
    }

    const leaseAvailable = config.scenario !== "mass-restart";
    const leaseFactor = leaseAvailable ? zoneFraction : massRestartFactor;
    const leasedA = config.providerQuotaA * leaseFactor;
    const leasedB = (releaseReserve ? config.providerQuotaB : ordinaryBudgetB) * leaseFactor;

    return {
      providerA: Math.min(aggregateLocalCapPerProvider, leasedA),
      providerB: Math.min(aggregateLocalCapPerProvider, leasedB),
      aggregateLocalCapPerProvider,
      allocationMode: "Expiring capacity leases",
      allocationDetail: config.scenario === "zone-outage"
        ? "The lost zone's allocation stays unavailable until its lease can be reclaimed."
        : config.scenario === "mass-restart"
          ? "Cold replicas begin with a reduced allocation before the traffic ramp."
          : "Replicas spend bounded local credits without a central call per attempt."
    };
  }

  function fleetPartitionBehavior(config, capacity, demand) {
    const lastAdmitSec = Math.max(
      0,
      config.leaseTtlSec - config.maxAttemptSec - LEASE_SAFETY_MARGIN_SEC
    );

    if (config.strategy === "local-caps") {
      return {
        mode: "No coordinator dependency",
        duringPartition: Math.min(
          demand.total,
          capacity.providerA + capacity.providerB
        ),
        afterLastAdmit: Math.min(
          demand.total,
          capacity.providerA + capacity.providerB
        ),
        lastAdmitSec: null,
        reclaimSec: null,
        detail: "Local admission continues, but aggregate caps may exceed the provider account limits."
      };
    }

    if (config.strategy === "central-check") {
      const partitioned = config.scenario === "coordinator-partition";
      return {
        mode: "Synchronous coordination",
        duringPartition: partitioned ? 0 : Math.min(
          demand.total,
          capacity.providerA + capacity.providerB
        ),
        afterLastAdmit: partitioned ? 0 : Math.min(
          demand.total,
          capacity.providerA + capacity.providerB
        ),
        lastAdmitSec: partitioned ? 0 : null,
        reclaimSec: null,
        detail: partitioned
          ? "Every new attempt is rejected because an exact central decision is unavailable."
          : "The coordinator remains a synchronous dependency for each provider attempt."
      };
    }

    return {
      mode: "Lease drain",
      duringPartition: Math.min(
        demand.total,
        capacity.providerA + capacity.providerB
      ),
      afterLastAdmit: config.scenario === "coordinator-partition" ? 0 : Math.min(
        demand.total,
        capacity.providerA + capacity.providerB
      ),
      lastAdmitSec,
      reclaimSec: config.leaseTtlSec,
      detail: "The holder stops new work at the last-admit time so every bounded attempt finishes before credits may be reassigned."
    };
  }

  function fleetTimeline(config, admitted, partitionBehavior, topology) {
    if (config.scenario === "coordinator-partition") {
      if (config.strategy === "leases") {
        return [
          { timeSec: 0, label: "Leases valid", detail: `${admitted.total} concurrent requests can use existing credits.` },
          { timeSec: 1, label: "Coordinator partition", detail: "Renewal stops while current credits remain bounded." },
          { timeSec: partitionBehavior.lastAdmitSec, label: "Admission stops", detail: "No new attempt starts under the expiring allocation." },
          { timeSec: partitionBehavior.reclaimSec, label: "Credits reclaimable", detail: "The coordinator may issue a new allocation after prior attempts have drained." }
        ].sort((left, right) => left.timeSec - right.timeSec);
      }

      if (config.strategy === "central-check") {
        return [
          { timeSec: 0, label: "Coordinator healthy", detail: "Central decisions admit work within provider quotas." },
          { timeSec: 1, label: "Coordinator partition", detail: "New attempts fail closed immediately." },
          { timeSec: 2, label: "Bounded degradation", detail: `${admitted.total} new concurrent requests remain admitted.` }
        ];
      }

      return [
        { timeSec: 0, label: "Local caps active", detail: `${admitted.total} concurrent requests can be admitted.` },
        { timeSec: 1, label: "Coordinator partition", detail: "Local behavior does not change because no coordinator is consulted." },
        { timeSec: 2, label: "Quota risk remains", detail: "Replica count still multiplies the configured local cap." }
      ];
    }

    if (config.scenario === "provider-outage") {
      return [
        { timeSec: 0, label: "Both providers healthy", detail: "Traffic follows the configured normal share." },
        { timeSec: 5, label: "Provider A unavailable", detail: "A demand moves toward Provider B." },
        { timeSec: 10, label: "B headroom consumed", detail: `${admitted.providerB} concurrent requests are admitted to B.` },
        { timeSec: 15, label: "Excess exposed", detail: `${admitted.totalUnserved} concurrent requests cannot complete safely.` }
      ];
    }

    if (config.scenario === "zone-outage") {
      return [
        { timeSec: 0, label: "All zones active", detail: `${config.replicas} replicas share traffic.` },
        { timeSec: 5, label: "One zone unavailable", detail: `${topology.lostReplicas} replicas leave service.` },
        { timeSec: 6, label: "Traffic rebalanced", detail: `${topology.activeReplicas} replicas receive the remaining load.` },
        { timeSec: config.leaseTtlSec, label: "Lost lease reclaimable", detail: "A lease strategy may redistribute the expired zone allocation." }
      ];
    }

    if (config.scenario === "mass-restart") {
      return [
        { timeSec: 0, label: "Fleet stops", detail: "In-flight work is cancelled or drained under the shutdown contract." },
        { timeSec: 1, label: "Replicas boot", detail: "Local health is cold and connection pools are empty." },
        { timeSec: 5, label: "Conservative admission", detail: `${admitted.total} concurrent requests are admitted during startup.` },
        { timeSec: config.restartRampSec, label: "Traffic ramp complete", detail: "Healthy evidence permits the steady allocation." }
      ];
    }

    return [
      { timeSec: 0, label: "Policy loaded", detail: capacityLabel(config.strategy) },
      { timeSec: 1, label: "Traffic admitted", detail: `${admitted.total} concurrent requests enter provider execution.` },
      { timeSec: 2, label: "Steady state", detail: `${admitted.totalUnserved} concurrent requests remain unserved.` }
    ];
  }

  function capacityLabel(strategy) {
    if (strategy === "local-caps") {
      return "Independent local caps are available on every replica.";
    }
    if (strategy === "central-check") {
      return "The central coordinator is ready for per-attempt decisions.";
    }
    return "Expiring provider credits are distributed to the fleet.";
  }

  function runFleet(input) {
    const config = normalizeFleetConfig(input);
    const topology = fleetTopology(config);
    const demand = fleetDemand(config);
    const capacity = fleetStrategyCapacity(config, topology);
    const providerAAvailable = config.scenario !== "provider-outage";
    const quotaA = providerAAvailable ? config.providerQuotaA : 0;
    const quotaB = config.providerQuotaB;
    const admittedA = roundTo(Math.min(demand.providerA, capacity.providerA), 4);
    const admittedB = roundTo(Math.min(demand.providerB, capacity.providerB), 4);
    const safelyServedA = roundTo(Math.min(admittedA, quotaA), 4);
    const safelyServedB = roundTo(Math.min(admittedB, quotaB), 4);
    const providerRejectedA = roundTo(Math.max(0, admittedA - quotaA), 4);
    const providerRejectedB = roundTo(Math.max(0, admittedB - quotaB), 4);
    const gatewayShedA = roundTo(Math.max(0, demand.providerA - admittedA), 4);
    const gatewayShedB = roundTo(Math.max(0, demand.providerB - admittedB), 4);
    const totalAdmitted = roundTo(admittedA + admittedB, 4);
    const safelyServed = roundTo(safelyServedA + safelyServedB, 4);
    const totalUnserved = roundTo(demand.total - safelyServed, 4);
    const normalDemandB = roundTo(
      config.offeredConcurrency * ((100 - config.normalShareA) / 100),
      4
    );
    const normalDemandA = roundTo(config.offeredConcurrency - normalDemandB, 4);
    const unusedOrdinaryB = roundTo(
      Math.max(
        0,
        config.providerQuotaB - config.failoverReserveB - normalDemandB
      ),
      4
    );
    const failoverAvailable = roundTo(
      Math.max(0, config.providerQuotaB - normalDemandB),
      4
    );
    const unmetFailover = roundTo(
      Math.max(0, normalDemandA - failoverAvailable),
      4
    );
    const admitted = {
      total: totalAdmitted,
      providerA: admittedA,
      providerB: admittedB,
      safelyServed,
      providerRejected: roundTo(providerRejectedA + providerRejectedB, 4),
      totalUnserved
    };
    const partitionBehavior = fleetPartitionBehavior(config, capacity, demand);
    const leaseLastAdmitSec = Math.max(
      0,
      config.leaseTtlSec - config.maxAttemptSec - LEASE_SAFETY_MARGIN_SEC
    );
    const invariants = [
      {
        name: "Provider A hard quota",
        ok: admittedA <= quotaA,
        detail: admittedA <= quotaA
          ? `${admittedA} admitted attempts stay within A's available quota of ${quotaA}.`
          : `${admittedA} admitted attempts exceed A's available quota of ${quotaA}.`
      },
      {
        name: "Provider B hard quota",
        ok: admittedB <= quotaB,
        detail: admittedB <= quotaB
          ? `${admittedB} admitted attempts stay within B's quota of ${quotaB}.`
          : `${admittedB} admitted attempts exceed B's quota of ${quotaB}.`
      },
      {
        name: "Replica-local capacity",
        ok: admittedA <= capacity.aggregateLocalCapPerProvider && admittedB <= capacity.aggregateLocalCapPerProvider,
        detail: `Each provider can receive at most ${capacity.aggregateLocalCapPerProvider} attempts from the active replicas.`
      },
      {
        name: "Lease drain window",
        ok: config.strategy !== "leases"
          || config.leaseTtlSec >= config.maxAttemptSec + LEASE_SAFETY_MARGIN_SEC,
        detail: config.strategy !== "leases"
          ? "This strategy does not reclaim expiring credits."
          : config.leaseTtlSec >= config.maxAttemptSec + LEASE_SAFETY_MARGIN_SEC
            ? `Admission stops at ${leaseLastAdmitSec}s, leaving ${config.maxAttemptSec}s to drain and ${LEASE_SAFETY_MARGIN_SEC}s for clock and communication safety before reclaim at ${config.leaseTtlSec}s.`
            : `Reclaim needs the ${config.maxAttemptSec}s attempt bound plus at least ${LEASE_SAFETY_MARGIN_SEC}s of clock and communication safety.`
      },
      {
        name: "Failover capacity",
        ok: config.scenario !== "provider-outage" || admittedB <= config.providerQuotaB,
        detail: config.scenario !== "provider-outage"
          ? `${failoverAvailable} B slots are available above normal B demand.`
          : `${unmetFailover} concurrent requests exceed B's total failover headroom.`
      },
      {
        name: "Coordinator partition bound",
        ok: config.scenario !== "coordinator-partition" || config.strategy !== "central-check" || totalAdmitted === 0,
        detail: config.scenario !== "coordinator-partition"
          ? "The coordinator remains reachable in this scenario."
          : partitionBehavior.detail
      },
      {
        name: "Nonnegative accounting",
        ok: [
          admittedA,
          admittedB,
          safelyServed,
          gatewayShedA,
          gatewayShedB,
          totalUnserved
        ].every((value) => value >= 0),
        detail: "Admission, shedding, and provider rejection remain separate nonnegative quantities."
      }
    ];

    return {
      kind: "fleet",
      modelVersion: 1,
      config,
      topology,
      demand,
      derivedCapacity: {
        strategy: config.strategy,
        mode: capacity.allocationMode,
        detail: capacity.allocationDetail,
        aggregateLocalCapPerProvider: capacity.aggregateLocalCapPerProvider,
        providerA: roundTo(capacity.providerA, 4),
        providerB: roundTo(capacity.providerB, 4),
        total: roundTo(capacity.providerA + capacity.providerB, 4)
      },
      oversubscription: {
        providerA: providerRejectedA,
        providerB: providerRejectedB,
        total: roundTo(providerRejectedA + providerRejectedB, 4),
        potentialProviderA: roundTo(
          Math.max(0, capacity.providerA - quotaA),
          4
        ),
        potentialProviderB: roundTo(
          Math.max(0, capacity.providerB - quotaB),
          4
        ),
        potentialTotal: roundTo(
          Math.max(0, capacity.providerA - quotaA)
          + Math.max(0, capacity.providerB - quotaB),
          4
        ),
        ratio: totalAdmitted === 0
          ? 0
          : roundTo((providerRejectedA + providerRejectedB) / totalAdmitted, 4)
      },
      admitted,
      shed: {
        atGateway: roundTo(gatewayShedA + gatewayShedB, 4),
        providerA: gatewayShedA,
        providerB: gatewayShedB,
        rejectedByProvider: roundTo(providerRejectedA + providerRejectedB, 4),
        totalUnserved
      },
      failoverHeadroom: {
        normalDemandA,
        normalDemandB,
        unusedOrdinaryB,
        reservedB: config.failoverReserveB,
        totalAvailableOnB: failoverAvailable,
        unmetIfAFails: unmetFailover
      },
      partitionBehavior,
      timeline: fleetTimeline(
        config,
        admitted,
        partitionBehavior,
        topology
      ),
      invariants
    };
  }

  function normalizeIncidentConfig(input) {
    const requested = input || {};
    const requestedDurationSec = boundedInteger(
      requested.durationSec,
      120,
      30,
      MAX_INCIDENT_DURATION_SEC
    );
    const recoveryRampSec = boundedInteger(
      requested.recoveryRampSec,
      30,
      1,
      300
    );
    const requestedFaultStartSec = boundedInteger(
      requested.faultStartSec,
      30,
      0,
      MAX_INCIDENT_DURATION_SEC
    );
    const requestedRecoveryStartSec = boundedInteger(
      requested.recoveryStartSec,
      80,
      requestedFaultStartSec,
      MAX_INCIDENT_DURATION_SEC
    );
    const requiredEndSec = Math.max(
      requestedDurationSec,
      hasFiniteValue(requested.faultStartSec) ? requestedFaultStartSec : 0,
      hasFiniteValue(requested.recoveryStartSec)
        || hasFiniteValue(requested.recoveryRampSec)
        ? requestedRecoveryStartSec + recoveryRampSec
        : 0
    );
    const durationSec = Math.min(MAX_INCIDENT_DURATION_SEC, requiredEndSec);
    const faultStartSec = Math.min(requestedFaultStartSec, durationSec);
    const recoveryStartSec = clamp(
      requestedRecoveryStartSec,
      faultStartSec,
      durationSec
    );

    return {
      scenario: INCIDENT_SCENARIOS.has(requested.scenario)
        ? requested.scenario
        : "provider-slowdown",
      configMode: CONFIG_MODES.has(requested.configMode)
        ? requested.configMode
        : "atomic",
      durationSec,
      stepSec: boundedInteger(requested.stepSec, 5, 1, 30),
      rps: boundedNumber(requested.rps, 1000, 1, 100000),
      gatewayCap: boundedInteger(requested.gatewayCap, 2400, 1, 1000000),
      queueCap: boundedInteger(requested.queueCap, 5000, 0, 10000000),
      providerCapA: boundedInteger(requested.providerCapA, 1500, 1, 1000000),
      providerCapB: boundedInteger(requested.providerCapB, 1000, 1, 1000000),
      baseP95Ams: boundedNumber(requested.baseP95Ams, 250, 5, 60000),
      baseP95Bms: boundedNumber(requested.baseP95Bms, 300, 5, 60000),
      slowdownMs: boundedNumber(requested.slowdownMs, 600, 0, 60000),
      deadlineMs: boundedNumber(requested.deadlineMs, 1200, 25, 120000),
      normalShareA: boundedNumber(requested.normalShareA, 60, 0, 100),
      probeSharePct: boundedNumber(requested.probeSharePct, 5, 0, 25),
      faultStartSec,
      shiftDelaySec: boundedInteger(requested.shiftDelaySec, 10, 0, 120),
      recoveryStartSec,
      recoveryRampSec,
      coldStartPct: boundedNumber(requested.coldStartPct, 20, 1, 100),
      telemetryQueueBytes: boundedInteger(
        requested.telemetryQueueBytes,
        256 * 1024 * 1024,
        0,
        1000000000000
      ),
      telemetryBytesPerRequest: boundedNumber(
        requested.telemetryBytesPerRequest,
        1680,
        0,
        1000000
      ),
      telemetrySinkBytesPerSec: boundedNumber(
        requested.telemetrySinkBytesPerSec,
        2200000,
        0,
        10000000000
      )
    };
  }

  function incidentTimes(config) {
    const times = new Set([0, config.durationSec]);
    for (let timeSec = 0; timeSec <= config.durationSec; timeSec += config.stepSec) {
      times.add(timeSec);
    }
    times.add(config.faultStartSec);
    times.add(Math.min(
      config.durationSec,
      config.faultStartSec + config.shiftDelaySec
    ));
    times.add(config.recoveryStartSec);
    times.add(Math.min(
      config.durationSec,
      config.recoveryStartSec + config.recoveryRampSec
    ));
    return [...times].sort((left, right) => left - right);
  }

  function incidentPhase(config, timeSec) {
    const detectionSec = config.faultStartSec + config.shiftDelaySec;
    if (timeSec < config.faultStartSec) {
      return "healthy";
    }
    if (timeSec < Math.min(detectionSec, config.recoveryStartSec)) {
      return "detecting";
    }
    if (timeSec < config.recoveryStartSec) {
      return "degraded";
    }
    if (timeSec < config.recoveryStartSec + config.recoveryRampSec) {
      return "recovering";
    }
    return "healthy";
  }

  function recoveryProgress(config, timeSec) {
    if (timeSec < config.recoveryStartSec) {
      return 0;
    }
    return clamp(
      (timeSec - config.recoveryStartSec) / config.recoveryRampSec,
      0,
      1
    );
  }

  function incidentProfile(config, timeSec) {
    const phase = incidentPhase(config, timeSec);
    const progress = recoveryProgress(config, timeSec);
    let shareA = config.normalShareA;
    let p95Ams = config.baseP95Ams;
    let p95Bms = config.baseP95Bms;
    let providerAAvailable = true;
    let providerBAvailable = true;
    let healthA = "healthy";
    let healthB = "healthy";
    let capacityFactor = 1;
    let configurationState = "valid";

    if (config.scenario === "provider-slowdown") {
      if (phase === "detecting") {
        p95Ams += config.slowdownMs;
        healthA = "degraded";
      } else if (phase === "degraded") {
        p95Ams += config.slowdownMs;
        shareA = config.probeSharePct;
        healthA = "cooldown";
      } else if (phase === "recovering") {
        p95Ams += config.slowdownMs * (1 - progress);
        shareA = config.probeSharePct + (
          config.normalShareA - config.probeSharePct
        ) * progress;
        healthA = progress < 0.4 ? "probing" : "recovering";
      }
    }

    if (config.scenario === "provider-outage") {
      if (phase === "detecting") {
        providerAAvailable = false;
        healthA = "unavailable";
      } else if (phase === "degraded") {
        providerAAvailable = false;
        shareA = 0;
        healthA = "cooldown";
      } else if (phase === "recovering") {
        shareA = config.probeSharePct + (
          config.normalShareA - config.probeSharePct
        ) * progress;
        healthA = progress < 0.4 ? "probing" : "recovering";
      }
    }

    if (config.scenario === "bad-configuration") {
      if (phase === "detecting" || phase === "degraded") {
        if (config.configMode === "atomic") {
          configurationState = "rejected-last-known-good";
        } else {
          configurationState = "partial-invalid";
          providerAAvailable = false;
          shareA = 100;
          healthA = "missing-route";
        }
      } else if (phase === "recovering") {
        if (config.configMode === "atomic") {
          configurationState = "rejected-last-known-good";
        } else {
          configurationState = "rollback";
          shareA = config.normalShareA * progress + 100 * (1 - progress);
          providerAAvailable = progress > 0;
          healthA = progress < 0.4 ? "recovering" : "healthy";
        }
      }
    }

    if (config.scenario === "mass-restart" && timeSec >= config.faultStartSec) {
      const restartProgress = timeSec <= config.recoveryStartSec
        ? 0
        : clamp(
          (timeSec - config.recoveryStartSec) / config.recoveryRampSec,
          0,
          1
        );
      capacityFactor = timeSec <= config.recoveryStartSec
        ? 0
        : config.coldStartPct / 100 + (
          1 - config.coldStartPct / 100
        ) * restartProgress;
      shareA = 50 + (config.normalShareA - 50) * restartProgress;
      healthA = restartProgress === 0
        ? "cold"
        : restartProgress < 0.5
          ? "probing"
          : restartProgress < 1
            ? "recovering"
            : "healthy";
      healthB = healthA;
      configurationState = restartProgress === 0
        ? "loading-last-known-good"
        : "valid";
    }

    return {
      phase,
      shareA: clamp(shareA, 0, 100),
      shareB: 100 - clamp(shareA, 0, 100),
      p95Ams: Math.max(5, p95Ams),
      p95Bms: Math.max(5, p95Bms),
      providerAAvailable,
      providerBAvailable,
      healthA,
      healthB,
      capacityFactor,
      configurationState
    };
  }

  function serviceLatencyDistribution(p95Ms) {
    return DETERMINISTIC_LATENCY_BUCKETS.map((bucket) => ({
      latencyMs: p95Ms * bucket.p95Multiplier,
      probability: bucket.probability
    }));
  }

  function meanServiceLatencyMs(p95Ms) {
    return sum(serviceLatencyDistribution(p95Ms).map(
      (sample) => sample.latencyMs * sample.probability
    ));
  }

  function queueDelayDistribution(maximumDelayMs) {
    if (maximumDelayMs <= 0) {
      return [{ latencyMs: 0, probability: 1 }];
    }

    return Array.from({ length: QUEUE_DELAY_BUCKET_COUNT }, (_, index) => ({
      latencyMs: maximumDelayMs * (
        (index + 0.5) / QUEUE_DELAY_BUCKET_COUNT
      ),
      probability: 1 / QUEUE_DELAY_BUCKET_COUNT
    }));
  }

  function requestLatencyDistribution(
    servedA,
    servedB,
    p95Ams,
    p95Bms,
    maximumQueueDelayMs
  ) {
    const totalServed = servedA + servedB;
    if (totalServed === 0) {
      return [];
    }

    const providers = [
      { served: servedA, p95Ms: p95Ams },
      { served: servedB, p95Ms: p95Bms }
    ].filter((provider) => provider.served > 0);
    const queueSamples = queueDelayDistribution(maximumQueueDelayMs);
    const samples = [];

    providers.forEach((provider) => {
      const providerProbability = provider.served / totalServed;
      serviceLatencyDistribution(provider.p95Ms).forEach((serviceSample) => {
        queueSamples.forEach((queueSample) => {
          samples.push({
            latencyMs: serviceSample.latencyMs + queueSample.latencyMs,
            probability: providerProbability
              * serviceSample.probability
              * queueSample.probability
          });
        });
      });
    });

    return samples.sort((left, right) => left.latencyMs - right.latencyMs);
  }

  function latencyPercentile(samples, percentile) {
    if (samples.length === 0) {
      return 0;
    }

    let cumulativeProbability = 0;
    for (const sample of samples) {
      cumulativeProbability += sample.probability;
      if (cumulativeProbability + Number.EPSILON >= percentile) {
        return sample.latencyMs;
      }
    }

    return samples[samples.length - 1].latencyMs;
  }

  function probabilityWithinDeadline(samples, deadlineMs) {
    return sum(samples
      .filter((sample) => sample.latencyMs <= deadlineMs)
      .map((sample) => sample.probability));
  }

  function incidentCapacityState(config, timeSec) {
    const profile = incidentProfile(config, timeSec);
    const meanAms = meanServiceLatencyMs(profile.p95Ams);
    const meanBms = meanServiceLatencyMs(profile.p95Bms);
    const demandRpsA = config.rps * (profile.shareA / 100);
    const demandRpsB = config.rps - demandRpsA;
    const capacityRpsA = profile.providerAAvailable
      ? (config.providerCapA * profile.capacityFactor * 1000) / meanAms
      : 0;
    const capacityRpsB = profile.providerBAvailable
      ? (config.providerCapB * profile.capacityFactor * 1000) / meanBms
      : 0;
    const rawServedA = Math.min(demandRpsA, capacityRpsA);
    const rawServedB = Math.min(demandRpsB, capacityRpsB);
    const weightedMeanMs = profile.shareA / 100 * meanAms + profile.shareB / 100 * meanBms;
    const gatewayCapacityRps = weightedMeanMs === 0
      ? 0
      : (config.gatewayCap * profile.capacityFactor * 1000) / weightedMeanMs;
    const rawServedTotal = rawServedA + rawServedB;
    const gatewayScale = rawServedTotal === 0
      ? 0
      : Math.min(1, gatewayCapacityRps / rawServedTotal);
    const servedA = rawServedA * gatewayScale;
    const servedB = rawServedB * gatewayScale;
    return {
      profile,
      meanAms,
      meanBms,
      servedA,
      servedB,
      servedNewRps: servedA + servedB,
      potentialRps: Math.min(gatewayCapacityRps, capacityRpsA + capacityRpsB)
    };
  }

  function incidentPointMetrics(config, capacity, queueDepth) {
    const maximumQueueDelayMs = capacity.servedNewRps === 0
      ? 0
      : (queueDepth / capacity.servedNewRps) * 1000;
    const latencySamples = requestLatencyDistribution(
      capacity.servedA,
      capacity.servedB,
      capacity.profile.p95Ams,
      capacity.profile.p95Bms,
      maximumQueueDelayMs
    );
    const terminalLatencySamples = latencySamples.map((sample) => ({
      ...sample,
      latencyMs: Math.min(sample.latencyMs, config.deadlineMs)
    }));
    const successfulRps = capacity.servedNewRps
      * probabilityWithinDeadline(latencySamples, config.deadlineMs)
      * BASE_ATTEMPT_SUCCESS_PROBABILITY;
    const activeA = Math.min(
      config.providerCapA * capacity.profile.capacityFactor,
      capacity.servedA * (capacity.meanAms / 1000)
    );
    const activeB = Math.min(
      config.providerCapB * capacity.profile.capacityFactor,
      capacity.servedB * (capacity.meanBms / 1000)
    );
    return {
      successRate: config.rps === 0
        ? 100
        : clamp((successfulRps / config.rps) * 100, 0, 100),
      p95Ms: capacity.servedNewRps === 0
        ? config.deadlineMs
        : latencyPercentile(terminalLatencySamples, 0.95),
      activeA,
      activeB,
      activeTotal: Math.min(
        config.gatewayCap * capacity.profile.capacityFactor,
        activeA + activeB
      )
    };
  }

  function runIncident(input) {
    const config = normalizeIncidentConfig(input);
    const times = incidentTimes(config);
    const timePoints = [];
    let queueDepth = 0;
    let queueExpiredRequests = 0;
    let queueRejectedRequests = 0;
    let telemetryBufferedBytes = 0;
    let telemetryDroppedBytes = 0;
    let previousTimeSec = 0;
    let maxObservedQueueDepth = 0;
    let maxObservedTelemetryBuffer = 0;
    const summarySamples = [];

    times.forEach((timeSec) => {
      let cursorSec = previousTimeSec;
      let expiredThisStep = 0;
      let rejectedThisStep = 0;
      let generatedTelemetryBytes = 0;
      let droppedThisStep = 0;
      while (cursorSec < timeSec) {
        const elapsedSec = Math.min(1, timeSec - cursorSec);
        const sampleSec = cursorSec + elapsedSec / 2;
        const slice = incidentCapacityState(config, sampleSec);
        const newQueued = Math.max(0, config.rps - slice.servedNewRps) * elapsedSec;
        const drainCapacity = Math.max(0, slice.potentialRps - slice.servedNewRps) * elapsedSec;
        const drained = Math.min(queueDepth, drainCapacity);
        const queueBeforeBound = Math.max(0, queueDepth + newQueued - drained);
        const deadlineQueueBound = config.rps * (config.deadlineMs / 1000);
        const expiredThisSlice = Math.max(0, queueBeforeBound - deadlineQueueBound);
        const queueAfterDeadline = Math.max(0, queueBeforeBound - expiredThisSlice);
        const rejectedThisSlice = Math.max(0, queueAfterDeadline - config.queueCap);
        expiredThisStep += expiredThisSlice;
        rejectedThisStep += rejectedThisSlice;
        queueExpiredRequests += expiredThisSlice;
        queueRejectedRequests += rejectedThisSlice;
        queueDepth = Math.min(config.queueCap, deadlineQueueBound, queueAfterDeadline);
        maxObservedQueueDepth = Math.max(maxObservedQueueDepth, queueDepth);

        const generatedThisSlice = config.rps * elapsedSec * config.telemetryBytesPerRequest;
        const sinkUnavailableInSlice = config.scenario === "telemetry-sink-outage"
          && sampleSec >= config.faultStartSec
          && sampleSec < config.recoveryStartSec;
        const exportCapacityBytes = sinkUnavailableInSlice
          ? 0
          : config.telemetrySinkBytesPerSec * elapsedSec;
        const telemetryBeforeExport = telemetryBufferedBytes + generatedThisSlice;
        const exportedTelemetryBytes = Math.min(telemetryBeforeExport, exportCapacityBytes);
        const telemetryAfterExport = telemetryBeforeExport - exportedTelemetryBytes;
        const droppedThisSlice = Math.max(0, telemetryAfterExport - config.telemetryQueueBytes);
        generatedTelemetryBytes += generatedThisSlice;
        droppedThisStep += droppedThisSlice;
        telemetryDroppedBytes += droppedThisSlice;
        telemetryBufferedBytes = Math.min(config.telemetryQueueBytes, telemetryAfterExport);
        maxObservedTelemetryBuffer = Math.max(maxObservedTelemetryBuffer, telemetryBufferedBytes);

        const summaryCapacity = incidentCapacityState(config, cursorSec + elapsedSec);
        summarySamples.push(incidentPointMetrics(config, summaryCapacity, queueDepth));
        cursorSec += elapsedSec;
      }

      const capacity = incidentCapacityState(config, timeSec);
      const { profile, servedA, servedB } = capacity;
      const pointMetrics = incidentPointMetrics(config, capacity, queueDepth);
      const { successRate, p95Ms, activeA, activeB, activeTotal } = pointMetrics;
      if (timeSec === 0) summarySamples.push(pointMetrics);
      const sinkUnavailable = config.scenario === "telemetry-sink-outage"
        && timeSec >= config.faultStartSec
        && timeSec < config.recoveryStartSec;

      timePoints.push({
        timeSec,
        phase: profile.phase,
        successRate: roundTo(successRate, 2),
        p95Ms: roundTo(p95Ms, 2),
        providerShare: {
          providerA: roundTo(profile.shareA, 2),
          providerB: roundTo(profile.shareB, 2)
        },
        activeAttempts: {
          total: roundTo(activeTotal, 2),
          providerA: roundTo(activeA, 2),
          providerB: roundTo(activeB, 2)
        },
        queueDepth: roundTo(queueDepth, 2),
        queueDropped: roundTo(rejectedThisStep, 2),
        queueExpired: roundTo(expiredThisStep, 2),
        telemetry: {
          generatedBytes: roundTo(generatedTelemetryBytes, 2),
          bufferedBytes: roundTo(telemetryBufferedBytes, 2),
          droppedBytes: roundTo(droppedThisStep, 2),
          cumulativeDroppedBytes: roundTo(telemetryDroppedBytes, 2),
          sinkState: sinkUnavailable ? "unavailable" : "available"
        },
        providerHealth: {
          providerA: profile.healthA,
          providerB: profile.healthB
        },
        configurationState: profile.configurationState
      });

      previousTimeSec = timeSec;
    });

    const maxActiveA = Math.max(...summarySamples.map((point) => point.activeA));
    const maxActiveB = Math.max(...summarySamples.map((point) => point.activeB));
    const maxActiveTotal = Math.max(...summarySamples.map((point) => point.activeTotal));
    const maxQueueDepth = maxObservedQueueDepth;
    const maxTelemetryBuffer = maxObservedTelemetryBuffer;
    const minSuccessRate = Math.min(...summarySamples.map((point) => point.successRate));
    const maxP95Ms = Math.max(...summarySamples.map((point) => point.p95Ms));
    const postDetection = timePoints.filter(
      (point) => point.timeSec >= config.faultStartSec + config.shiftDelaySec
    );
    const invalidConfigApplied = config.scenario === "bad-configuration"
      && config.configMode === "partial";
    const atomicLastKnownGoodChanged = config.scenario === "bad-configuration"
      && config.configMode === "atomic"
      && timePoints.some((point) => (
        point.timeSec >= config.faultStartSec
        && point.timeSec < config.recoveryStartSec + config.recoveryRampSec
        && (
          point.providerShare.providerA !== config.normalShareA
          || point.providerHealth.providerA !== "healthy"
          || point.configurationState === "partial-invalid"
        )
      ));
    const outageRoutedAfterDetection = config.scenario === "provider-outage"
      && postDetection.some((point) => (
        point.timeSec < config.recoveryStartSec
        && point.providerShare.providerA > 0
      ));
    const restartPoint = timePoints.find(
      (point) => point.timeSec === config.faultStartSec
    );
    const prematureRestartCapacity = config.scenario === "mass-restart"
      && timePoints.some((point) => (
        point.timeSec >= config.faultStartSec
        && point.timeSec <= config.recoveryStartSec
        && point.activeAttempts.total > 0
      ));
    const prematureRestartHealth = config.scenario === "mass-restart"
      && timePoints.some((point) => (
        point.timeSec >= config.faultStartSec
        && point.timeSec < config.recoveryStartSec + config.recoveryRampSec
        && point.providerHealth.providerA === "healthy"
      ));
    const invariants = [
      {
        name: "Gateway active-attempt cap",
        ok: maxActiveTotal <= config.gatewayCap,
        detail: `Peak active attempts are ${roundTo(maxActiveTotal, 2)} against a gateway cap of ${config.gatewayCap}.`
      },
      {
        name: "Provider active-attempt caps",
        ok: maxActiveA <= config.providerCapA && maxActiveB <= config.providerCapB,
        detail: `A peaks at ${roundTo(maxActiveA, 2)} of ${config.providerCapA}, while B peaks at ${roundTo(maxActiveB, 2)} of ${config.providerCapB}.`
      },
      {
        name: "Bounded request queue",
        ok: maxQueueDepth <= config.queueCap,
        detail: `Peak queued work is ${roundTo(maxQueueDepth, 2)} against a bound of ${config.queueCap}.`
      },
      {
        name: "Bounded telemetry memory",
        ok: maxTelemetryBuffer <= config.telemetryQueueBytes,
        detail: `Peak telemetry memory is ${roundTo(maxTelemetryBuffer, 2)} bytes against a bound of ${config.telemetryQueueBytes}.`
      },
      {
        name: "Atomic configuration apply",
        ok: !invalidConfigApplied && !atomicLastKnownGoodChanged,
        detail: config.scenario !== "bad-configuration"
          ? "No configuration fault is active in this scenario."
          : atomicLastKnownGoodChanged
            ? "The rejected version changed the last-known-good routing state."
            : config.configMode === "atomic"
              ? "The invalid version is rejected while the last-known-good policy remains active."
              : "Partial apply sends traffic through an invalid provider reference."
      },
      {
        name: "Outage traffic shift",
        ok: !outageRoutedAfterDetection,
        detail: config.scenario !== "provider-outage"
          ? "No provider outage is active in this scenario."
          : outageRoutedAfterDetection
            ? "Provider A still receives traffic after the detection window."
            : "Provider A receives no ordinary traffic after detection and before recovery."
      },
      {
        name: "Mass-restart recovery clock",
        ok: config.scenario !== "mass-restart" || (
          restartPoint?.activeAttempts.total === 0
          && !prematureRestartCapacity
          && !prematureRestartHealth
        ),
        detail: config.scenario !== "mass-restart"
          ? "No fleet restart is active in this scenario."
          : prematureRestartCapacity || prematureRestartHealth
            ? "Capacity or healthy state returned before the configured recovery ramp allowed it."
            : "Capacity remains cold until recovery starts, then returns over the configured ramp."
      },
      {
        name: "Metric ranges",
        ok: timePoints.every((point) => (
          point.successRate >= 0
          && point.successRate <= 100
          && point.providerShare.providerA >= 0
          && point.providerShare.providerA <= 100
          && point.providerShare.providerB >= 0
          && point.providerShare.providerB <= 100
        )),
        detail: "Success rate and provider shares remain valid percentages at every time point."
      }
    ];

    return {
      kind: "incident",
      modelVersion: 2,
      config,
      timePoints,
      summary: {
        minSuccessRate: roundTo(minSuccessRate, 2),
        maxP95Ms: roundTo(maxP95Ms, 2),
        maxActiveAttempts: roundTo(maxActiveTotal, 2),
        maxQueueDepth: roundTo(maxQueueDepth, 2),
        totalQueueExpiredRequests: roundTo(queueExpiredRequests, 2),
        totalQueueRejectedRequests: roundTo(queueRejectedRequests, 2),
        maxTelemetryBufferedBytes: roundTo(maxTelemetryBuffer, 2),
        totalTelemetryDroppedBytes: roundTo(telemetryDroppedBytes, 2)
      },
      modelAssumptions: {
        latencyDistribution: "deterministic-discrete-p95-calibrated",
        latencyBucketCount: DETERMINISTIC_LATENCY_BUCKETS.length,
        queueDelayBucketCount: QUEUE_DELAY_BUCKET_COUNT,
        terminalLatencyCappedAtDeadline: true,
        baseAttemptSuccessProbability: BASE_ATTEMPT_SUCCESS_PROBABILITY
      },
      invariants
    };
  }

  root.DecagonLabModels = {
    ...(root.DecagonLabModels || {}),
    runFleet,
    runIncident
  };
})(typeof window !== "undefined" ? window : globalThis);
