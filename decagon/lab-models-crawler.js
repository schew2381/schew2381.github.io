(() => {
  "use strict";

  const DAY_SECONDS = 86_400;
  const KIB = 1024;
  const PIB = 1_000_000_000_000_000;

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function nonNegative(value, fallback) {
    return Math.max(0, finiteNumber(value, fallback));
  }

  function positive(value, fallback) {
    const number = finiteNumber(value, fallback);
    return number > 0 ? number : fallback;
  }

  function bounded(value, fallback, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, finiteNumber(value, fallback)));
  }

  function integer(value, fallback, minimum, maximum) {
    return Math.round(bounded(value, fallback, minimum, maximum));
  }

  function round(value, digits = 2) {
    if (!Number.isFinite(value)) return null;
    const scale = 10 ** digits;
    return Math.round(value * scale) / scale;
  }

  function average(values) {
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  }

  function percentile(values, requested) {
    if (!values.length) return 0;
    const ordered = values.slice().sort((left, right) => left - right);
    const position = (Math.min(100, Math.max(0, requested)) / 100) * (ordered.length - 1);
    const lower = Math.floor(position);
    const upper = Math.ceil(position);
    if (lower === upper) return ordered[lower];
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
  }

  function ratio(required, available) {
    if (!Number.isFinite(required) || !Number.isFinite(available) || available <= 0) return null;
    return round((required / available) * 100, 1);
  }

  function makeConstraint(id, label, required, available, unit, detail) {
    const ok = Number.isFinite(required) && Number.isFinite(available) && required <= available;
    return {
      id,
      label,
      required: round(required),
      available: round(available),
      unit,
      utilizationPercent: ratio(required, available),
      ok,
      detail
    };
  }

  function normalizePipelineConfig(input = {}) {
    const slowdownInput = input.slowdown || {};
    return {
      pagesPerDay: positive(input.pagesPerDay, 100_000_000),
      peakFactor: positive(input.peakFactor, 3),
      attemptAmplification: positive(input.attemptAmplification, 1.15),
      meanFetchMs: positive(input.meanFetchMs, 400),
      p95FetchMs: positive(input.p95FetchMs, 2_000),
      authorityGapMs: nonNegative(input.authorityGapMs, 5_000),
      perAuthorityConcurrency: integer(input.perAuthorityConcurrency, 1, 1, 64),
      meanResponseKiB: positive(input.meanResponseKiB, 200),
      rawRetentionDays: positive(input.rawRetentionDays, 30),
      replicationFactor: positive(input.replicationFactor, 2),
      parserCpuMs: positive(input.parserCpuMs, 20),
      parserCores: positive(input.parserCores, 96),
      fetchConcurrencyCap: positive(input.fetchConcurrencyCap, 10_000),
      activeAuthoritiesAvailable: positive(input.activeAuthoritiesAvailable, 25_000),
      networkCapacityGbps: positive(input.networkCapacityGbps, 10),
      rawStorageCapacityPB: positive(input.rawStorageCapacityPB, 2),
      browserRenderFraction: bounded(input.browserRenderFraction, 0, 0, 1),
      browserRenderMs: positive(input.browserRenderMs, 4_000),
      browserRenderMemoryMiB: positive(input.browserRenderMemoryMiB, 512),
      browserRenderConcurrencyCap: positive(input.browserRenderConcurrencyCap, 2_000),
      browserRenderMemoryGiB: positive(input.browserRenderMemoryGiB, 1_024),
      separateRendererPool: input.separateRendererPool !== false,
      slowdown: {
        durationSeconds: positive(slowdownInput.durationSeconds, 600),
        parserCapacityFactor: bounded(slowdownInput.parserCapacityFactor, 0.2, 0, 1),
        inputRateMode: slowdownInput.inputRateMode === "peak" ? "peak" : "average",
        queueCapacityPages: positive(slowdownInput.queueCapacityPages, 500_000),
        maxRecoverySeconds: positive(slowdownInput.maxRecoverySeconds, 900)
      }
    };
  }

  function runCrawlPipeline(input = {}) {
    const config = normalizePipelineConfig(input);
    const averageAcceptedRate = config.pagesPerDay / DAY_SECONDS;
    const peakAcceptedRate = averageAcceptedRate * config.peakFactor;
    const averageFetchRate = averageAcceptedRate * config.attemptAmplification;
    const peakFetchRate = peakAcceptedRate * config.attemptAmplification;
    const meanInFlightFetches = peakFetchRate * (config.meanFetchMs / 1_000);
    const p95InFlightFetches = peakFetchRate * (config.p95FetchMs / 1_000);
    const startRateByGap = config.authorityGapMs > 0
      ? 1_000 / config.authorityGapMs
      : Number.POSITIVE_INFINITY;
    const startRateByConcurrency = config.perAuthorityConcurrency / (config.meanFetchMs / 1_000);
    const perAuthorityRate = Math.min(startRateByGap, startRateByConcurrency);
    const activeAuthorityRequirement = Math.ceil(peakFetchRate / perAuthorityRate);
    const averageBandwidthGbps = averageFetchRate * config.meanResponseKiB * KIB * 8 / 1_000_000_000;
    const peakBandwidthGbps = peakFetchRate * config.meanResponseKiB * KIB * 8 / 1_000_000_000;
    const rawBytesPerDay = config.pagesPerDay * config.meanResponseKiB * KIB;
    const retainedRawBytes = rawBytesPerDay * config.rawRetentionDays * config.replicationFactor;
    const parserCpuCoresRequired = peakAcceptedRate * config.parserCpuMs / 1_000;
    const parserCapacityPerSecond = config.parserCores * 1_000 / config.parserCpuMs;
    const renderTasksPerSecond = peakAcceptedRate * config.browserRenderFraction;
    const browserRenderConcurrencyRequired = renderTasksPerSecond * config.browserRenderMs / 1_000;
    const browserRenderMemoryGiBRequired = browserRenderConcurrencyRequired
      * config.browserRenderMemoryMiB / 1_024;
    const slowdownInputRate = config.slowdown.inputRateMode === "peak"
      ? peakAcceptedRate
      : averageAcceptedRate;
    const slowedParserCapacity = parserCapacityPerSecond * config.slowdown.parserCapacityFactor;
    const queueGrowthPerSecond = Math.max(0, slowdownInputRate - slowedParserCapacity);
    const queueGrowthPages = queueGrowthPerSecond * config.slowdown.durationSeconds;
    const queueCapacityReachedAtSeconds = queueGrowthPerSecond > 0
      ? config.slowdown.queueCapacityPages / queueGrowthPerSecond
      : null;
    const recoverySurplusPerSecond = parserCapacityPerSecond - slowdownInputRate;
    const recoveryTimeSeconds = queueGrowthPages === 0
      ? 0
      : recoverySurplusPerSecond > 0
        ? queueGrowthPages / recoverySurplusPerSecond
        : Number.POSITIVE_INFINITY;

    const constraints = [
      makeConstraint(
        "authority-supply",
        "Active authority supply",
        activeAuthorityRequirement,
        config.activeAuthoritiesAvailable,
        "authorities",
        "Peak attempts need enough independent sites to satisfy the configured start gap and per-site concurrency."
      ),
      makeConstraint(
        "fetch-concurrency",
        "Fetch-cap proxy at p95 latency",
        p95InFlightFetches,
        config.fetchConcurrencyCap,
        "attempts",
        "Peak rate multiplied by p95 latency is a conservative sizing proxy, not a p95 concurrency statistic."
      ),
      makeConstraint(
        "network",
        "Peak response bandwidth",
        peakBandwidthGbps,
        config.networkCapacityGbps,
        "Gbps",
        "This estimate covers response bodies before protocol overhead, redirects, and unusually large objects."
      ),
      makeConstraint(
        "raw-storage",
        "Retained raw bodies",
        retainedRawBytes / PIB,
        config.rawStorageCapacityPB,
        "PB",
        "Retention includes body replication but excludes metadata, indexes, extracted links, and temporary uploads."
      ),
      makeConstraint(
        "parser-cpu",
        "Peak parser CPU",
        parserCpuCoresRequired,
        config.parserCores,
        "cores",
        "Parser demand uses accepted-page rate because failed transport attempts do not produce parseable bodies."
      )
    ];

    if (config.browserRenderFraction > 0) {
      constraints.push(
        makeConstraint(
          "render-concurrency",
          "Browser render concurrency",
          browserRenderConcurrencyRequired,
          config.browserRenderConcurrencyCap,
          "tasks",
          "Rendered pages need their own admission ceiling because each task holds a browser for much longer than an HTTP fetch."
        ),
        makeConstraint(
          "render-memory",
          "Browser render memory",
          browserRenderMemoryGiBRequired,
          config.browserRenderMemoryGiB,
          "GiB",
          "The estimate multiplies concurrent renders by the configured memory envelope for one isolated task."
        )
      );
    }

    constraints.push(
      makeConstraint(
        "slowdown-queue",
        "Parser slowdown queue",
        queueGrowthPages,
        config.slowdown.queueCapacityPages,
        "pages",
        "The queue holds the deficit accumulated while parser capacity remains below the selected input rate."
      ),
      makeConstraint(
        "recovery-window",
        "Parser recovery time",
        recoveryTimeSeconds,
        config.slowdown.maxRecoverySeconds,
        "seconds",
        "Recovery is possible only when normal parser capacity exceeds the continuing input rate."
      )
    );

    const failedConstraints = constraints.filter((constraint) => !constraint.ok);
    const firstBottleneck = failedConstraints[0] || {
      id: "none",
      label: "No configured bottleneck",
      ok: true,
      detail: "Every modeled requirement fits within the supplied capacity, so the next test should vary the least certain assumption."
    };
    const namedConstraints = Object.fromEntries(
      constraints.map((constraint) => [constraint.id, constraint])
    );
    const timeline = [
      {
        atSeconds: 0,
        label: "Parser slowdown begins",
        detail: `Input is ${round(slowdownInputRate)} pages/s while parser capacity falls to ${round(slowedParserCapacity)} pages/s.`
      }
    ];

    if (
      queueCapacityReachedAtSeconds !== null
      && queueCapacityReachedAtSeconds <= config.slowdown.durationSeconds
    ) {
      timeline.push({
        atSeconds: round(queueCapacityReachedAtSeconds),
        label: "Queue reaches its configured bound",
        detail: "Admission must stop, shed work, or use another declared durable buffer before this point."
      });
    }

    timeline.push({
      atSeconds: config.slowdown.durationSeconds,
      label: "Normal parser capacity returns",
      detail: `The modeled backlog is ${round(queueGrowthPages)} pages after the bounded slowdown.`
    });
    timeline.push({
      atSeconds: Number.isFinite(recoveryTimeSeconds)
        ? round(config.slowdown.durationSeconds + recoveryTimeSeconds)
        : null,
      label: Number.isFinite(recoveryTimeSeconds)
        ? "Backlog recovery completes"
        : "Backlog cannot recover",
      detail: Number.isFinite(recoveryTimeSeconds)
        ? `Normal capacity drains the backlog in ${round(recoveryTimeSeconds)} seconds while new pages continue to arrive.`
        : "Normal parser capacity does not exceed incoming work, so the queue remains full without added capacity or lower admission."
    });

    const invariants = [
      {
        name: "The latency-tail sizing proxy fits inside the fetch ceiling",
        ok: namedConstraints["fetch-concurrency"].ok,
        detail: `Peak attempt rate multiplied by p95 latency gives a ${round(p95InFlightFetches)}-attempt sizing proxy before extra headroom.`
      },
      {
        name: "Site-limited supply can sustain peak dispatch",
        ok: namedConstraints["authority-supply"].ok,
        detail: `${activeAuthorityRequirement} independently active authorities are required under the configured gap and concurrency.`
      },
      {
        name: "Raw-body retention fits the declared store",
        ok: namedConstraints["raw-storage"].ok,
        detail: `${round(retainedRawBytes / PIB)} PB of replicated raw bodies must fit before metadata and indexes are added.`
      },
      {
        name: "Parser steady-state service exceeds peak accepted work",
        ok: namedConstraints["parser-cpu"].ok,
        detail: `${round(parserCpuCoresRequired)} parser cores are required at the peak accepted-page rate.`
      },
      {
        name: "The slowdown remains inside a durable queue bound",
        ok: namedConstraints["slowdown-queue"].ok,
        detail: `${round(queueGrowthPages)} pages accumulate during the slowdown against a ${round(config.slowdown.queueCapacityPages)} page bound.`
      },
      {
        name: "Parser recovery completes inside the objective",
        ok: namedConstraints["recovery-window"].ok,
        detail: Number.isFinite(recoveryTimeSeconds)
          ? `Recovery takes ${round(recoveryTimeSeconds)} seconds after normal capacity returns.`
          : "The configured parser fleet has no spare service rate for draining the backlog."
      },
      {
        name: "Browser rendering has an independent resource pool",
        ok: config.browserRenderFraction === 0 || config.separateRendererPool,
        detail: config.browserRenderFraction === 0
          ? "The current workload does not include browser-rendered pages."
          : "Rendered tasks must not consume every ordinary fetch or parser slot."
      }
    ];

    return {
      kind: "crawl-pipeline",
      config,
      rates: {
        averageAcceptedPagesPerSecond: round(averageAcceptedRate),
        peakAcceptedPagesPerSecond: round(peakAcceptedRate),
        averageFetchAttemptsPerSecond: round(averageFetchRate),
        peakFetchAttemptsPerSecond: round(peakFetchRate)
      },
      concurrency: {
        meanInFlightFetches: round(meanInFlightFetches),
        p95InFlightFetches: round(p95InFlightFetches),
        activeAuthorityRequirement,
        perAuthorityStartsPerSecond: round(perAuthorityRate, 4)
      },
      network: {
        averageBandwidthGbps: round(averageBandwidthGbps),
        peakBandwidthGbps: round(peakBandwidthGbps)
      },
      storage: {
        rawBytesPerDay: round(rawBytesPerDay),
        retainedRawBytes: round(retainedRawBytes),
        retainedRawPB: round(retainedRawBytes / PIB)
      },
      parser: {
        cpuCoresRequiredAtPeak: round(parserCpuCoresRequired),
        configuredCapacityPagesPerSecond: round(parserCapacityPerSecond),
        slowdownCapacityPagesPerSecond: round(slowedParserCapacity),
        slowdownInputPagesPerSecond: round(slowdownInputRate),
        queueGrowthPagesPerSecond: round(queueGrowthPerSecond),
        queueGrowthPages: round(queueGrowthPages),
        recoverySurplusPagesPerSecond: round(recoverySurplusPerSecond),
        recoveryTimeSeconds: round(recoveryTimeSeconds)
      },
      renderer: {
        enabled: config.browserRenderFraction > 0,
        tasksPerSecondAtPeak: round(renderTasksPerSecond),
        concurrencyRequired: round(browserRenderConcurrencyRequired),
        memoryGiBRequired: round(browserRenderMemoryGiBRequired),
        separatePool: config.separateRendererPool
      },
      constraints,
      namedConstraints,
      firstBottleneck,
      timeline,
      invariants
    };
  }

  function baseAuthority(name, ip, options = {}) {
    return {
      name,
      ip,
      readyAtMs: nonNegative(options.readyAtMs, 0),
      gapMs: nonNegative(options.gapMs, 1_000),
      robotsOutcome: options.robotsOutcome || "2xx"
    };
  }

  function task(id, authority, path, options = {}) {
    return {
      id,
      logicalId: options.logicalId || id,
      authority,
      url: options.url || `https://${authority}${path}`,
      discoveredAtMs: nonNegative(options.discoveredAtMs, 0),
      durationMs: positive(options.durationMs, 200),
      robotsAllowed: options.robotsAllowed !== false,
      crashOnAttempt: options.crashOnAttempt === true,
      crashAfterMs: positive(options.crashAfterMs, 100),
      redirectIp: options.redirectIp || null,
      connectIp: options.connectIp || null,
      bloomFalsePositive: options.bloomFalsePositive === true,
      trap: options.trap === true,
      attempt: integer(options.attempt, 1, 1, 20)
    };
  }

  function scenarioDefinition(name) {
    const sharedIp = "93.184.216.34";
    const alpha = baseAuthority("alpha.example", sharedIp, { gapMs: 1_000 });
    const beta = baseAuthority("beta.example", sharedIp, { gapMs: 500 });
    const gamma = baseAuthority("gamma.example", "142.250.72.14", { readyAtMs: 250 });

    if (name === "authority-ready") {
      const independentBeta = { ...beta, ip: "104.16.132.229" };
      return {
        authorities: [alpha, independentBeta, gamma],
        tasks: [
          task("a1", alpha.name, "/a1", { durationMs: 1_600 }),
          task("a2", alpha.name, "/a2", { discoveredAtMs: 1, durationMs: 1_600 }),
          task("b1", independentBeta.name, "/b1", { discoveredAtMs: 2 }),
          task("b2", independentBeta.name, "/b2", { discoveredAtMs: 3 }),
          task("g1", gamma.name, "/g1", { discoveredAtMs: 250 })
        ]
      };
    }

    if (name === "shared-ip") {
      return {
        authorities: [alpha, beta],
        tasks: [
          task("a1", alpha.name, "/a1", { durationMs: 400 }),
          task("b1", beta.name, "/b1", { durationMs: 400 }),
          task("a2", alpha.name, "/a2", { durationMs: 400 }),
          task("b2", beta.name, "/b2", { durationMs: 400 })
        ]
      };
    }

    if (name === "robots") {
      const allow = baseAuthority("allow.example", "151.101.1.69", { robotsOutcome: "2xx" });
      const missing = baseAuthority("missing.example", "104.16.132.229", { robotsOutcome: "4xx" });
      const serverError = baseAuthority("error.example", "8.8.8.8", { robotsOutcome: "5xx" });
      const offline = baseAuthority("offline.example", "1.1.1.1", { robotsOutcome: "unreachable" });
      return {
        authorities: [allow, missing, serverError, offline],
        tasks: [
          task("allow-public", allow.name, "/public"),
          task("allow-private", allow.name, "/private", { robotsAllowed: false }),
          task("missing-public", missing.name, "/public"),
          task("error-public", serverError.name, "/public"),
          task("offline-public", offline.name, "/public")
        ]
      };
    }

    if (name === "lease-expiry") {
      return {
        authorities: [alpha],
        tasks: [task("lease-crash", alpha.name, "/lease", { crashOnAttempt: true })]
      };
    }

    if (name === "redirect-revalidation") {
      return {
        authorities: [alpha],
        tasks: [task("redirect", alpha.name, "/redirect", { redirectIp: "169.254.169.254" })]
      };
    }

    if (name === "dns-rebinding") {
      return {
        authorities: [alpha],
        tasks: [task("rebind", alpha.name, "/rebind", { connectIp: "169.254.169.254" })]
      };
    }

    if (name === "dedupe") {
      return {
        authorities: [alpha],
        tasks: [
          task("same-1", alpha.name, "/same"),
          task("same-2", alpha.name, "/same"),
          task("fresh-filter-positive", alpha.name, "/fresh", { bloomFalsePositive: true })
        ]
      };
    }

    if (name === "crawl-trap") {
      const trapAuthority = baseAuthority("calendar.example", "1.0.0.1", { gapMs: 100 });
      const trapTasks = Array.from({ length: 10 }, (_, index) => task(
        `calendar-${index}`,
        trapAuthority.name,
        `/calendar/2026/${index}?session=${index}`,
        { trap: true, durationMs: 80 }
      ));
      return { authorities: [trapAuthority, beta], tasks: [...trapTasks, task("beta-normal", beta.name, "/normal")] };
    }

    const missing = baseAuthority("missing.example", "104.16.132.229", { robotsOutcome: "4xx" });
    const serverError = baseAuthority("error.example", "8.8.8.8", { robotsOutcome: "5xx" });
    const offline = baseAuthority("offline.example", "1.1.1.1", { robotsOutcome: "unreachable" });
    const trapAuthority = baseAuthority("calendar.example", "1.0.0.1", { gapMs: 100 });
    return {
      authorities: [alpha, beta, gamma, missing, serverError, offline, trapAuthority],
      tasks: [
        task("alpha-1", alpha.name, "/one"),
        task("alpha-2", alpha.name, "/two"),
        task("beta-1", beta.name, "/one"),
        task("gamma-lease", gamma.name, "/lease", { crashOnAttempt: true }),
        task("missing-robots", missing.name, "/allowed-by-4xx"),
        task("server-error-robots", serverError.name, "/blocked-by-5xx"),
        task("offline-robots", offline.name, "/blocked-by-network"),
        task("redirect", alpha.name, "/redirect", { redirectIp: "169.254.169.254" }),
        task("rebind", beta.name, "/rebind", { connectIp: "169.254.169.254" }),
        task("duplicate-1", alpha.name, "/duplicate"),
        task("duplicate-2", alpha.name, "/duplicate"),
        task("filter-positive", beta.name, "/new-but-positive", { bloomFalsePositive: true }),
        ...Array.from({ length: 8 }, (_, index) => task(
          `trap-${index}`,
          trapAuthority.name,
          `/calendar/${index}?session=${index}`,
          { trap: true, durationMs: 80 }
        ))
      ]
    };
  }

  function normalizeControls(input = {}) {
    const values = input.controls || input;
    const dedupeMode = ["exact", "bloom-plus-exact", "bloom-only", "none"].includes(values.dedupeMode)
      ? values.dedupeMode
      : values.dedupeMode === "lossy" ? "bloom-only" : "bloom-plus-exact";
    const robotsPolicy = ["rfc9309", "fail-open", "block-on-any-error"].includes(values.robotsPolicy)
      ? values.robotsPolicy
      : "rfc9309";
    return {
      scheduler: values.scheduler === "global-fifo" ? "global-fifo" : "authority-ready",
      workers: integer(values.workers, 3, 1, 64),
      perAuthorityConcurrency: integer(values.perAuthorityConcurrency, 1, 1, 16),
      sharedIpCap: integer(values.sharedIpCap, 1, 1, 32),
      enforceAuthorityReady: values.enforceAuthorityReady !== false,
      enforceSharedIp: values.enforceSharedIp !== false,
      robotsPolicy,
      durableLeases: values.durableLeases !== false,
      requeueExpiredLeases: values.requeueExpiredLeases !== false,
      leaseMs: positive(values.leaseMs, 800),
      revalidateRedirects: values.revalidateRedirects !== false,
      blockForbiddenAddresses: values.blockForbiddenAddresses !== false,
      pinValidatedAddress: values.pinValidatedAddress !== false,
      enforceEgress: values.enforceEgress !== false,
      dedupeMode,
      enforceCrawlBudget: values.enforceCrawlBudget !== false,
      maxUrlsPerAuthority: integer(values.maxUrlsPerAuthority, 6, 1, 10_000)
    };
  }

  function ipv4Parts(address) {
    const parts = String(address).split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
    return parts;
  }

  function isForbiddenIPv4(parts) {
    const [a, b] = parts;
    return a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0 && parts[2] === 0)
      || (a === 192 && b === 0 && parts[2] === 2)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && parts[2] === 100)
      || (a === 203 && b === 0 && parts[2] === 113)
      || a >= 224;
  }

  function parseIPv6Words(address) {
    let normalized = String(address || "").trim().toLowerCase();
    normalized = normalized.replace(/^\[/, "").replace(/\]$/, "").split("%")[0];
    if (!normalized.includes(":")) return null;

    if (normalized.includes(".")) {
      const lastColon = normalized.lastIndexOf(":");
      const tail = ipv4Parts(normalized.slice(lastColon + 1));
      if (!tail) return null;
      const high = ((tail[0] << 8) | tail[1]).toString(16);
      const low = ((tail[2] << 8) | tail[3]).toString(16);
      normalized = `${normalized.slice(0, lastColon)}:${high}:${low}`;
    }

    const halves = normalized.split("::");
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
    const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
    if ((halves.length === 1 && left.length !== 8) || missing < 1 && halves.length === 2) return null;

    const words = [...left, ...Array(missing).fill("0"), ...right].map((word) => {
      if (!/^[0-9a-f]{1,4}$/.test(word)) return Number.NaN;
      return Number.parseInt(word, 16);
    });
    return words.length === 8 && words.every(Number.isInteger) ? words : null;
  }

  function isForbiddenAddress(address) {
    const normalized = String(address || "").trim().toLowerCase();
    if (!normalized) return true;

    const ipv4 = ipv4Parts(normalized);
    if (ipv4) return isForbiddenIPv4(ipv4);

    const words = parseIPv6Words(normalized);
    if (!words) return true;

    const mappedIPv4 = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
    if (mappedIPv4) {
      return isForbiddenIPv4([
        words[6] >> 8,
        words[6] & 0xff,
        words[7] >> 8,
        words[7] & 0xff
      ]);
    }

    const allZero = words.every((word) => word === 0);
    const loopback = words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
    const uniqueLocal = (words[0] & 0xfe00) === 0xfc00;
    const linkLocal = (words[0] & 0xffc0) === 0xfe80;
    const multicast = (words[0] & 0xff00) === 0xff00;
    const globalUnicast = (words[0] & 0xe000) === 0x2000;
    const specialPurpose2001 = words[0] === 0x2001 && words[1] <= 0x01ff;
    const deprecated6to4 = words[0] === 0x2002;
    const documentation = words[0] === 0x2001 && words[1] === 0x0db8;
    const documentationV2 = words[0] === 0x3fff && (words[1] & 0xf000) === 0;
    return allZero
      || loopback
      || uniqueLocal
      || linkLocal
      || multicast
      || !globalUnicast
      || specialPurpose2001
      || deprecated6to4
      || documentation
      || documentationV2;
  }

  function robotsDecision(outcome, allowedByRules, policy) {
    if (outcome === "2xx") {
      return {
        allowed: allowedByRules,
        deferred: false,
        unsafe: false,
        reason: allowedByRules
          ? "The successful robots file permits this path."
          : "The successful robots file disallows this path."
      };
    }
    if (outcome === "4xx") {
      return {
        allowed: policy !== "block-on-any-error",
        deferred: false,
        unsafe: false,
        reason: policy === "block-on-any-error"
          ? "A stricter local policy blocks an unavailable robots file."
          : "RFC 9309 classifies 4xx as unavailable and permits ordinary crawling."
      };
    }
    if (policy === "fail-open") {
      return {
        allowed: true,
        deferred: false,
        unsafe: true,
        reason: "The selected policy permits work after a robots 5xx or unreachable result."
      };
    }
    return {
      allowed: false,
      deferred: true,
      unsafe: false,
      reason: "RFC 9309 classifies this outcome as unreachable and requires complete disallow until shared authority policy is refreshed."
    };
  }

  function minimumSlot(slots) {
    let index = 0;
    for (let candidate = 1; candidate < slots.length; candidate += 1) {
      if (slots[candidate] < slots[index]) index = candidate;
    }
    return { index, freeAt: slots[index] };
  }

  function maximumConcurrency(intervals) {
    const points = [];
    intervals.forEach((interval) => {
      points.push({ at: interval.startMs, delta: 1 });
      points.push({ at: interval.endMs, delta: -1 });
    });
    points.sort((left, right) => left.at - right.at || left.delta - right.delta);
    let current = 0;
    let maximum = 0;
    points.forEach((point) => {
      current += point.delta;
      maximum = Math.max(maximum, current);
    });
    return maximum;
  }

  function firstConcurrencyViolationAt(intervals, cap) {
    const points = [];
    intervals.forEach((interval) => {
      points.push({ at: interval.startMs, delta: 1 });
      points.push({ at: interval.endMs, delta: -1 });
    });
    points.sort((left, right) => left.at - right.at || left.delta - right.delta);
    let current = 0;
    for (const point of points) {
      current += point.delta;
      if (current > cap) return point.at;
    }
    return null;
  }

  function runFrontierChallenge(input = {}) {
    const scenario = [
      "authority-ready",
      "shared-ip",
      "robots",
      "lease-expiry",
      "redirect-revalidation",
      "dns-rebinding",
      "dedupe",
      "crawl-trap",
      "mixed"
    ].includes(input.scenario) ? input.scenario : "mixed";
    const controls = normalizeControls(input);
    const definition = input.authorities && input.tasks
      ? { authorities: input.authorities, tasks: input.tasks }
      : scenarioDefinition(scenario);
    const authorities = definition.authorities.map((authority) => baseAuthority(
      authority.name,
      authority.ip,
      authority
    ));
    const authorityByName = new Map(authorities.map((authority) => [authority.name, authority]));
    const tasks = definition.tasks.map((value, index) => task(
      value.id || `task-${index}`,
      value.authority,
      "/",
      value
    ));
    const events = [];
    let eventOrder = 0;
    const addEvent = (atMs, type, value = {}) => {
      events.push({
        atMs: round(atMs, 1),
        type,
        authority: value.authority || null,
        url: value.url || null,
        detail: value.detail || "",
        safetyViolation: value.safetyViolation === true,
        durabilityViolation: value.durabilityViolation === true,
        order: eventOrder
      });
      eventOrder += 1;
    };
    const seenUrls = new Set();
    const admittedByAuthority = new Map();
    const pending = [];
    const admittedLogicalIds = new Set();
    const terminalLogicalIds = new Set();
    const deferredRobotsLogicalIds = new Set();
    const completedLogicalIds = new Set();
    const lostLogicalIds = new Set();
    let duplicateDrops = 0;
    let coverageLosses = 0;
    let budgetDrops = 0;
    let robotsBlocks = 0;
    let permanentRobotsBlocks = 0;
    let unsafeRobotsAdmissions = 0;

    tasks.forEach((candidate) => {
      const authority = authorityByName.get(candidate.authority);
      if (!authority) {
        addEvent(candidate.discoveredAtMs, "invalid_authority", {
          authority: candidate.authority,
          url: candidate.url,
          detail: "The candidate names an authority that has no scheduling owner.",
          durabilityViolation: true
        });
        lostLogicalIds.add(candidate.logicalId);
        return;
      }

      if (seenUrls.has(candidate.url)) {
        if (controls.dedupeMode !== "none") {
          duplicateDrops += 1;
          terminalLogicalIds.add(candidate.logicalId);
          addEvent(candidate.discoveredAtMs, "duplicate_dropped", {
            authority: candidate.authority,
            url: candidate.url,
            detail: "The dedupe layer found an existing exact URL identity and suppressed duplicate work."
          });
          return;
        }
      } else if (candidate.bloomFalsePositive && controls.dedupeMode === "bloom-only") {
        coverageLosses += 1;
        terminalLogicalIds.add(candidate.logicalId);
        addEvent(candidate.discoveredAtMs, "new_url_lost", {
          authority: candidate.authority,
          url: candidate.url,
          detail: "A Bloom false positive was treated as authoritative, so a new URL never reached the exact frontier.",
          durabilityViolation: true
        });
        return;
      }

      seenUrls.add(candidate.url);
      const admittedCount = admittedByAuthority.get(candidate.authority) || 0;
      if (controls.enforceCrawlBudget && admittedCount >= controls.maxUrlsPerAuthority) {
        budgetDrops += 1;
        terminalLogicalIds.add(candidate.logicalId);
        addEvent(candidate.discoveredAtMs, "crawl_budget_blocked", {
          authority: candidate.authority,
          url: candidate.url,
          detail: "The authority reached its configured URL budget, so another discovery was not admitted."
        });
        return;
      }
      if (!controls.enforceCrawlBudget && admittedCount >= controls.maxUrlsPerAuthority) {
        addEvent(candidate.discoveredAtMs, "authority_budget_exceeded", {
          authority: candidate.authority,
          url: candidate.url,
          detail: `${candidate.authority} admitted URL ${admittedCount + 1} against a configured budget of ${controls.maxUrlsPerAuthority}.`,
          safetyViolation: true
        });
      }

      admittedByAuthority.set(candidate.authority, admittedCount + 1);
      const decision = robotsDecision(authority.robotsOutcome, candidate.robotsAllowed, controls.robotsPolicy);
      if (!decision.allowed) {
        robotsBlocks += 1;
        if (decision.deferred) deferredRobotsLogicalIds.add(candidate.logicalId);
        else {
          permanentRobotsBlocks += 1;
          terminalLogicalIds.add(candidate.logicalId);
        }
        addEvent(candidate.discoveredAtMs, decision.deferred ? "robots_deferred" : "robots_blocked", {
          authority: candidate.authority,
          url: candidate.url,
          detail: decision.deferred
            ? `${decision.reason} The URL stays deferred behind the authority's single refresh owner.`
            : decision.reason
        });
        return;
      }
      if (decision.unsafe) unsafeRobotsAdmissions += 1;
      if (authority.robotsOutcome === "4xx") {
        addEvent(candidate.discoveredAtMs, "robots_4xx_allows", {
          authority: candidate.authority,
          url: candidate.url,
          detail: decision.reason
        });
      }
      admittedLogicalIds.add(candidate.logicalId);
      pending.push({ ...candidate, unsafeRobots: decision.unsafe });
    });

    const authorityStates = new Map(authorities.map((authority) => [authority.name, {
      nextReadyAtMs: authority.readyAtMs,
      slots: Array(controls.perAuthorityConcurrency).fill(0),
      dispatches: 0
    }]));
    const ipStates = new Map();
    const ipStateFor = (ip) => {
      if (!ipStates.has(ip)) {
        ipStates.set(ip, {
          slots: Array(controls.enforceSharedIp ? controls.sharedIpCap : controls.workers).fill(0)
        });
      }
      return ipStates.get(ip);
    };
    const workerSlots = Array(controls.workers).fill(0);
    const intervals = [];
    let crashes = 0;
    let recoveredLeases = 0;
    let leaseRenewals = 0;
    let expiredLeaseCompletions = 0;
    let redirectViolations = 0;
    let rebindViolations = 0;
    let securityBlocks = 0;
    let iterations = 0;

    function eligibility(candidate) {
      const authority = authorityByName.get(candidate.authority);
      const authorityState = authorityStates.get(candidate.authority);
      const peerIp = !controls.pinValidatedAddress && candidate.connectIp
        ? candidate.connectIp
        : authority.ip;
      const worker = minimumSlot(workerSlots);
      const authoritySlot = minimumSlot(authorityState.slots);
      const ipSlot = minimumSlot(ipStateFor(peerIp).slots);
      const eligibleAtMs = Math.max(
        candidate.discoveredAtMs,
        controls.enforceAuthorityReady ? authorityState.nextReadyAtMs : 0
      );
      return {
        startMs: Math.max(
          eligibleAtMs,
          worker.freeAt,
          authoritySlot.freeAt,
          controls.enforceAuthorityReady ? authorityState.nextReadyAtMs : 0,
          controls.enforceSharedIp ? ipSlot.freeAt : 0
        ),
        worker,
        authoritySlot,
        ipSlot,
        peerIp,
        eligibleAtMs
      };
    }

    function choosePending() {
      if (controls.scheduler === "global-fifo") {
        return { index: 0, candidate: pending[0], eligibility: eligibility(pending[0]) };
      }
      const firstByAuthority = new Map();
      pending.forEach((candidate, index) => {
        if (!firstByAuthority.has(candidate.authority)) firstByAuthority.set(candidate.authority, { candidate, index });
      });
      return [...firstByAuthority.values()]
        .map((value) => ({
          ...value,
          eligibility: eligibility(value.candidate),
          dispatches: authorityStates.get(value.candidate.authority).dispatches
        }))
        .sort((left, right) => (
          left.eligibility.startMs - right.eligibility.startMs
          || left.dispatches - right.dispatches
          || left.candidate.discoveredAtMs - right.candidate.discoveredAtMs
          || String(left.candidate.id).localeCompare(String(right.candidate.id))
        ))[0];
    }

    while (pending.length > 0 && iterations < 10_000) {
      iterations += 1;
      const chosen = choosePending();
      const current = chosen.candidate;
      const slot = chosen.eligibility;
      pending.splice(chosen.index, 1);
      const authority = authorityByName.get(current.authority);
      const authorityState = authorityStates.get(current.authority);
      const startMs = slot.startMs;
      const plannedEndMs = startMs + current.durationMs;
      let leaseExpiryMs = startMs + controls.leaseMs;
      let leaseRenewAtMs = startMs + controls.leaseMs * 0.8;
      const leaseId = `${current.logicalId}:attempt-${current.attempt}`;
      authorityState.dispatches += 1;
      authorityState.nextReadyAtMs = startMs + authority.gapMs;
      addEvent(startMs, "lease_granted", {
        authority: current.authority,
        url: current.url,
        detail: controls.durableLeases
          ? `Durable lease ${leaseId} expires at ${round(leaseExpiryMs, 1)} ms.`
          : `Worker ownership for ${leaseId} exists only in process memory.`,
        durabilityViolation: !controls.durableLeases
      });

      function renewLeaseThrough(targetMs) {
        while (controls.durableLeases && leaseRenewAtMs <= targetMs) {
          const renewedAtMs = leaseRenewAtMs;
          leaseExpiryMs = renewedAtMs + controls.leaseMs;
          leaseRenewAtMs = renewedAtMs + controls.leaseMs * 0.8;
          leaseRenewals += 1;
          addEvent(renewedAtMs, "lease_renewed", {
            authority: current.authority,
            url: current.url,
            detail: `The active worker renewed ${leaseId} through ${round(leaseExpiryMs, 1)} ms before its prior visibility deadline.`
          });
        }
      }

      if (current.crashOnAttempt && current.attempt === 1) {
        crashes += 1;
        const crashAtMs = Math.min(plannedEndMs, startMs + current.crashAfterMs);
        renewLeaseThrough(crashAtMs - Number.EPSILON);
        workerSlots[slot.worker.index] = crashAtMs;
        authorityState.slots[slot.authoritySlot.index] = crashAtMs;
        ipStateFor(slot.peerIp).slots[slot.ipSlot.index] = crashAtMs;
        addEvent(crashAtMs, "worker_crashed", {
          authority: current.authority,
          url: current.url,
          detail: "The worker exited before recording a terminal fetch result."
        });
        if (controls.durableLeases && controls.requeueExpiredLeases) {
          recoveredLeases += 1;
          addEvent(leaseExpiryMs, "lease_expired", {
            authority: current.authority,
            url: current.url,
            detail: "The durable visibility deadline returned the URL to eligible work."
          });
          pending.push({
            ...current,
            id: `${current.id}:retry`,
            attempt: current.attempt + 1,
            discoveredAtMs: leaseExpiryMs,
            crashOnAttempt: false
          });
        } else {
          lostLogicalIds.add(current.logicalId);
          addEvent(crashAtMs, "work_lost", {
            authority: current.authority,
            url: current.url,
            detail: "No durable lease recovery returned the unfinished URL to the frontier.",
            durabilityViolation: true
          });
        }
        continue;
      }

      renewLeaseThrough(plannedEndMs);
      if (!controls.durableLeases && plannedEndMs >= leaseExpiryMs) {
        expiredLeaseCompletions += 1;
        addEvent(leaseExpiryMs, "lease_expired_during_fetch", {
          authority: current.authority,
          url: current.url,
          detail: "The worker kept processing after its in-memory ownership deadline. Another worker could now replay the same URL.",
          durabilityViolation: true
        });
      }

      let actualIp = slot.peerIp;
      let blockedBeforeFetch = false;
      if (current.connectIp && current.connectIp !== authority.ip) {
        if (controls.pinValidatedAddress) {
          addEvent(startMs, "dns_rebinding_prevented", {
            authority: current.authority,
            url: current.url,
            detail: "The dialer kept the socket on the address that passed policy and ignored the changed DNS target."
          });
        } else {
          actualIp = current.connectIp;
          if (isForbiddenAddress(actualIp) && controls.enforceEgress) {
            blockedBeforeFetch = true;
            securityBlocks += 1;
            terminalLogicalIds.add(current.logicalId);
            addEvent(startMs, "egress_blocked_rebinding", {
              authority: current.authority,
              url: current.url,
              detail: "Network policy rejected the forbidden socket peer after application pinning was disabled."
            });
          } else if (isForbiddenAddress(actualIp)) {
            rebindViolations += 1;
            addEvent(startMs, "dns_rebinding_connected", {
              authority: current.authority,
              url: current.url,
              detail: "The connection used a forbidden address that did not pass the original destination decision.",
              safetyViolation: true
            });
          }
        }
      }

      if (blockedBeforeFetch) {
        workerSlots[slot.worker.index] = startMs;
        authorityState.slots[slot.authoritySlot.index] = startMs;
        ipStateFor(slot.peerIp).slots[slot.ipSlot.index] = startMs;
        continue;
      }

      workerSlots[slot.worker.index] = plannedEndMs;
      authorityState.slots[slot.authoritySlot.index] = plannedEndMs;
      ipStateFor(slot.peerIp).slots[slot.ipSlot.index] = plannedEndMs;
      intervals.push({
        authority: current.authority,
        ip: actualIp,
        actualIp,
        discoveredAtMs: current.discoveredAtMs,
        eligibleAtMs: slot.eligibleAtMs,
        startMs,
        endMs: plannedEndMs,
        url: current.url,
        unsafeRobots: current.unsafeRobots,
        trap: current.trap
      });
      addEvent(startMs, "fetch_started", {
        authority: current.authority,
        url: current.url,
        detail: `The request started on worker ${slot.worker.index} with site and destination permits.`,
        safetyViolation: current.unsafeRobots
      });
      addEvent(plannedEndMs, "fetch_completed", {
        authority: current.authority,
        url: current.url,
        detail: "The terminal fetch record released worker, site, and destination ownership."
      });
      completedLogicalIds.add(current.logicalId);
      terminalLogicalIds.add(current.logicalId);

      if (current.redirectIp) {
        const forbidden = isForbiddenAddress(current.redirectIp);
        if (controls.revalidateRedirects && controls.blockForbiddenAddresses && forbidden) {
          securityBlocks += 1;
          addEvent(plannedEndMs, "redirect_blocked", {
            authority: current.authority,
            url: current.url,
            detail: "The redirect restarted destination policy and was rejected before another socket opened."
          });
        } else if (forbidden && controls.enforceEgress) {
          securityBlocks += 1;
          addEvent(plannedEndMs, "egress_blocked_redirect", {
            authority: current.authority,
            url: current.url,
            detail: "The egress boundary denied the forbidden redirect after application revalidation was disabled."
          });
        } else if (forbidden) {
          redirectViolations += 1;
          addEvent(plannedEndMs, "redirect_followed_unsafely", {
            authority: current.authority,
            url: current.url,
            detail: "The crawler followed a redirect to a forbidden address without repeating the destination decision.",
            safetyViolation: true
          });
        } else {
          addEvent(plannedEndMs, "redirect_revalidated", {
            authority: current.authority,
            url: current.url,
            detail: "The redirect target passed a new parse, scope, DNS, address, and policy decision."
          });
        }
      }
    }

    if (iterations >= 10_000 && pending.length > 0) {
      pending.forEach((value) => lostLogicalIds.add(value.logicalId));
      addEvent(0, "simulation_limit", {
        detail: "The deterministic event limit stopped a frontier that did not drain.",
        durabilityViolation: true
      });
    }

    const authorityIntervals = new Map();
    const ipIntervals = new Map();
    intervals.forEach((interval) => {
      if (!authorityIntervals.has(interval.authority)) authorityIntervals.set(interval.authority, []);
      if (!ipIntervals.has(interval.ip)) ipIntervals.set(interval.ip, []);
      authorityIntervals.get(interval.authority).push(interval);
      ipIntervals.get(interval.ip).push(interval);
    });
    let authorityReadyViolations = 0;
    const authorityReadyViolationEvents = [];
    authorityIntervals.forEach((values, authorityName) => {
      const authority = authorityByName.get(authorityName);
      const gapMs = authority.gapMs;
      const ordered = values.slice().sort((left, right) => left.startMs - right.startMs);
      if (ordered[0]?.startMs < authority.readyAtMs) {
        authorityReadyViolations += 1;
        authorityReadyViolationEvents.push({
          interval: ordered[0],
          detail: `${authorityName} started at ${ordered[0].startMs} ms before its initial ready time of ${authority.readyAtMs} ms.`
        });
      }
      for (let index = 1; index < ordered.length; index += 1) {
        if (ordered[index].startMs - ordered[index - 1].startMs < gapMs) {
          authorityReadyViolations += 1;
          authorityReadyViolationEvents.push({
            interval: ordered[index],
            detail: `${authorityName} started again after ${ordered[index].startMs - ordered[index - 1].startMs} ms against a required ${gapMs} ms gap.`
          });
        }
      }
    });
    const maxSharedIpConcurrency = Math.max(0, ...[...ipIntervals.values()].map(maximumConcurrency));
    const maxAuthorityConcurrency = Math.max(0, ...[...authorityIntervals.values()].map(maximumConcurrency));
    const sharedIpViolationGroups = [...ipIntervals.entries()].filter(
      ([, values]) => maximumConcurrency(values) > controls.sharedIpCap
    );
    const sharedIpViolations = sharedIpViolationGroups.length;
    const unsafeRobotsFetches = intervals.filter((interval) => interval.unsafeRobots).length;
    const fetchedUrlCounts = new Map();
    const fetchedUrlIntervals = new Map();
    intervals.forEach((interval) => {
      fetchedUrlCounts.set(interval.url, (fetchedUrlCounts.get(interval.url) || 0) + 1);
      if (!fetchedUrlIntervals.has(interval.url)) fetchedUrlIntervals.set(interval.url, []);
      fetchedUrlIntervals.get(interval.url).push(interval);
    });
    const duplicateFetches = [...fetchedUrlCounts.values()]
      .reduce((total, count) => total + Math.max(0, count - 1), 0);
    const makespanMs = intervals.length
      ? Math.max(...intervals.map((interval) => interval.endMs)) - Math.min(...tasks.map((value) => value.discoveredAtMs))
      : 0;
    const dispatchDelays = intervals.map((interval) => interval.startMs - interval.discoveredAtMs);
    const eligibleWaits = intervals.map((interval) => Math.max(0, interval.startMs - interval.eligibleAtMs));
    const maxAuthorityAdmissions = Math.max(0, ...admittedByAuthority.values());
    const budgetViolation = maxAuthorityAdmissions > controls.maxUrlsPerAuthority;
    admittedLogicalIds.forEach((logicalId) => {
      if (!terminalLogicalIds.has(logicalId) && !lostLogicalIds.has(logicalId)) lostLogicalIds.add(logicalId);
    });
    authorityReadyViolationEvents.forEach(({ interval, detail }) => {
      addEvent(interval.startMs, "authority_started_early", {
        authority: interval.authority,
        url: interval.url,
        detail,
        safetyViolation: true
      });
    });
    fetchedUrlIntervals.forEach((values, url) => {
      values.slice().sort((left, right) => left.startMs - right.startMs).slice(1).forEach((interval) => {
        addEvent(interval.startMs, "duplicate_fetch_started", {
          authority: interval.authority,
          url,
          detail: "A second fetch began for an exact URL identity that already had a fetch attempt.",
          durabilityViolation: true
        });
      });
    });
    sharedIpViolationGroups.forEach(([ip, values]) => {
      addEvent(firstConcurrencyViolationAt(values, controls.sharedIpCap), "shared_ip_cap_exceeded", {
        detail: `Concurrent sockets to ${ip} exceeded the configured destination cap of ${controls.sharedIpCap}.`,
        safetyViolation: true
      });
    });
    events.sort((left, right) => left.atMs - right.atMs || left.order - right.order);
    events.forEach((event) => { delete event.order; });

    const invariants = [
      {
        name: "Authority-ready times are respected",
        category: "safety",
        ok: authorityReadyViolations === 0,
        detail: authorityReadyViolations === 0
          ? "Every repeated start for one authority observed its configured gap."
          : `${authorityReadyViolations} repeated starts occurred before the authority became eligible.`
      },
      {
        name: "Shared destinations stay inside their concurrency cap",
        category: "safety",
        ok: sharedIpViolations === 0,
        detail: sharedIpViolations === 0
          ? `Maximum shared-IP concurrency was ${maxSharedIpConcurrency} against a cap of ${controls.sharedIpCap}.`
          : `${sharedIpViolations} destination groups exceeded the configured shared-IP cap.`
      },
      {
        name: "Robots failures preserve the RFC 9309 safety split",
        category: "safety",
        ok: unsafeRobotsFetches === 0 && unsafeRobotsAdmissions === 0,
        detail: unsafeRobotsFetches === 0 && unsafeRobotsAdmissions === 0
          ? "No disallowed 2xx path, 5xx authority, or unreachable authority was fetched."
          : `${unsafeRobotsFetches || unsafeRobotsAdmissions} URLs entered work without a safe robots decision.`
      },
      {
        name: "Unreachable robots state defers work for shared refresh",
        category: "durability",
        ok: deferredRobotsLogicalIds.size === robotsBlocks - permanentRobotsBlocks,
        detail: deferredRobotsLogicalIds.size === 0
          ? "No URL is waiting for an unreachable robots policy in this scenario."
          : `${deferredRobotsLogicalIds.size} URLs remain deferred behind authority-owned robots refresh state.`
      },
      {
        name: "Redirects repeat destination validation",
        category: "safety",
        ok: redirectViolations === 0,
        detail: redirectViolations === 0
          ? "Every forbidden redirect was rejected by application policy or the egress boundary."
          : `${redirectViolations} redirects reached forbidden destinations without a repeated decision.`
      },
      {
        name: "The connected peer matches a validated destination",
        category: "safety",
        ok: rebindViolations === 0,
        detail: rebindViolations === 0
          ? "DNS changes could not replace an approved public peer with a forbidden address."
          : `${rebindViolations} connections used a forbidden address after the original DNS decision.`
      },
      {
        name: "Every authority remains inside its crawl budget",
        category: "safety",
        ok: !budgetViolation,
        detail: !budgetViolation
          ? `${budgetDrops} discoveries were blocked at the configured per-authority budget.`
          : `One authority admitted ${maxAuthorityAdmissions} URLs against a budget of ${controls.maxUrlsPerAuthority}.`
      },
      {
        name: "Exact URL identity is fetched at most once",
        category: "durability",
        ok: duplicateFetches === 0,
        detail: duplicateFetches === 0
          ? "Every repeated exact URL was suppressed before another fetch began."
          : `${duplicateFetches} duplicate fetches ran because exact URL identity was not enforced.`
      },
      {
        name: "Approximate dedupe cannot silently remove new URLs",
        category: "durability",
        ok: coverageLosses === 0,
        detail: coverageLosses === 0
          ? "Every Bloom-positive new candidate reached an exact check before rejection."
          : `${coverageLosses} new URLs were lost because an approximate membership result became authoritative.`
      },
      {
        name: "Active work keeps durable lease ownership",
        category: "durability",
        ok: controls.durableLeases && expiredLeaseCompletions === 0,
        detail: controls.durableLeases && expiredLeaseCompletions === 0
          ? `${leaseRenewals} renewal${leaseRenewals === 1 ? "" : "s"} kept long attempts owned through completion.`
          : `${expiredLeaseCompletions} attempts completed after ownership expired, or ownership existed only in worker memory.`
      },
      {
        name: "Expired leases return unfinished work",
        category: "durability",
        ok: crashes === 0 || (controls.durableLeases && controls.requeueExpiredLeases && recoveredLeases === crashes),
        detail: crashes === 0
          ? "This scenario did not inject a worker crash."
          : `${recoveredLeases} of ${crashes} crashed attempts returned through durable lease expiry.`
      },
      {
        name: "Accepted logical work reaches a terminal state",
        category: "durability",
        ok: lostLogicalIds.size === 0,
        detail: lostLogicalIds.size === 0
          ? "Every admitted logical URL completed, was blocked safely, or returned through its lease."
          : `${lostLogicalIds.size} admitted logical URLs have no terminal result or recovery path.`
      }
    ];

    return {
      kind: "frontier-challenge",
      scenario,
      controls,
      metrics: {
        discovered: tasks.length,
        admitted: admittedLogicalIds.size,
        completed: completedLogicalIds.size,
        fetchedAttempts: intervals.length,
        robotsBlocks,
        robotsDeferred: deferredRobotsLogicalIds.size,
        duplicateDrops,
        duplicateFetches,
        coverageLosses,
        budgetDrops,
        crashes,
        recoveredLeases,
        leaseRenewals,
        expiredLeaseCompletions,
        securityBlocks,
        lostLogicalWork: lostLogicalIds.size,
        authorityReadyViolations,
        sharedIpViolations,
        redirectViolations,
        rebindViolations,
        maxAuthorityConcurrency,
        maxSharedIpConcurrency,
        makespanMs: round(makespanMs, 1),
        meanDispatchDelayMs: round(average(dispatchDelays), 1),
        p95DispatchDelayMs: round(percentile(dispatchDelays, 95), 1),
        meanEligibleWaitMs: round(average(eligibleWaits), 1),
        p95EligibleWaitMs: round(percentile(eligibleWaits, 95), 1)
      },
      events,
      invariants,
      safetyInvariants: invariants.filter((invariant) => invariant.category === "safety"),
      durabilityInvariants: invariants.filter((invariant) => invariant.category === "durability"),
      ok: invariants.every((invariant) => invariant.ok)
    };
  }

  window.DecagonLabModels = {
    ...(window.DecagonLabModels || {}),
    runCrawlPipeline,
    runFrontierChallenge
  };
})();
