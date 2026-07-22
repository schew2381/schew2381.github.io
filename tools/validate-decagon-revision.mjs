import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const decagonRoot = path.join(root, "decagon");
const indexPath = path.join(decagonRoot, "index.html");
const indexSource = fs.readFileSync(indexPath, "utf8");
const appSource = fs.readFileSync(path.join(decagonRoot, "app.js"), "utf8");

const bannedTerms = [
  "delve",
  "dive into",
  "navigate",
  "underscore",
  "bolster",
  "foster",
  "harness",
  "leverage",
  "unpack",
  "shed light on",
  "pave the way",
  "pivotal",
  "groundbreaking",
  "cutting-edge",
  "transformative",
  "game-changing",
  "innovative",
  "robust",
  "comprehensive",
  "seamless",
  "intricate",
  "nuanced",
  "vibrant",
  "multifaceted",
  "holistic",
  "testament",
  "landscape",
  "realm"
];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const bannedPatterns = bannedTerms.map((term) => ({
  term,
  pattern: new RegExp(`\\b${escapeRegExp(term).replaceAll(" ", "\\s+")}\\b`, "iu")
}));

function relativeToRoot(filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const filePath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(filePath) : [filePath];
  });
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2] || "";
}

function localAssets(source) {
  const assets = [];
  for (const match of source.matchAll(/<(script|link)\b[^>]*>/giu)) {
    const [tag, kind] = match;
    if (kind.toLowerCase() === "link") {
      const relationships = attribute(tag, "rel").toLowerCase().split(/\s+/);
      if (!relationships.includes("stylesheet")) continue;
    }

    const reference = attribute(tag, kind.toLowerCase() === "script" ? "src" : "href");
    if (!reference || /^(?:[a-z]+:)?\/\//iu.test(reference)) continue;
    const cleanReference = reference.split(/[?#]/u, 1)[0];
    const filePath = cleanReference.startsWith("/")
      ? path.resolve(root, cleanReference.slice(1))
      : path.resolve(decagonRoot, cleanReference);
    assets.push({ kind: kind.toLowerCase(), reference, filePath });
  }
  return assets;
}

const assets = localAssets(indexSource);
for (const asset of assets) {
  assert.ok(
    asset.filePath.startsWith(`${root}${path.sep}`),
    `Local asset escapes the repository: ${asset.reference}`
  );
  assert.ok(
    fs.existsSync(asset.filePath) && fs.statSync(asset.filePath).isFile(),
    `Missing local ${asset.kind} asset: ${asset.reference}`
  );
}

const indexedScripts = new Set(
  assets
    .filter((asset) => asset.kind === "script")
    .map((asset) => path.basename(asset.filePath))
);
const decagonFiles = fs.readdirSync(decagonRoot);
const guideFiles = decagonFiles.filter((name) => /^guides-.*\.js$/u.test(name)).sort();
const appliedFiles = decagonFiles.filter((name) => /^applied-.*\.js$/u.test(name)).sort();
const labModelFiles = ["lab-models-gateway.js", "lab-models-crawler.js"];

for (const file of [
  "course-data.js",
  ...guideFiles,
  ...appliedFiles,
  "system-design-studios.js",
  "simulations.js",
  ...labModelFiles
]) {
  assert.ok(indexedScripts.has(file), `index.html does not load ${file}`);
}

const sandbox = { console, window: {} };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function runInCourseContext(file) {
  const source = fs.readFileSync(path.join(decagonRoot, file), "utf8");
  vm.runInContext(source, sandbox, { filename: file, timeout: 5_000 });
}

runInCourseContext("course-data.js");
for (const file of guideFiles) runInCourseContext(file);
for (const file of appliedFiles) runInCourseContext(file);
runInCourseContext("system-design-studios.js");
runInCourseContext("simulations.js");
for (const file of labModelFiles) runInCourseContext(file);

const course = sandbox.window.DECAGON_COURSE;
const guides = sandbox.window.DECAGON_GUIDES;
const appliedQuestions = sandbox.window.DECAGON_APPLIED_QUESTIONS;
const designStudios = sandbox.window.DECAGON_SYSTEM_DESIGN_STUDIOS;
const simulations = sandbox.window.DecagonSim;
const labModels = sandbox.window.DecagonLabModels;

assert.ok(course && Array.isArray(course.modules), "Course modules did not load");
assert.equal(course.version, 4, "Course storage version must invalidate or migrate pre-workbook completions");
assert.ok(guides && typeof guides === "object", "Guide registries did not load");
assert.ok(appliedQuestions && typeof appliedQuestions === "object", "Applied question registries did not load");
assert.ok(designStudios && typeof designStudios === "object", "System-design studios did not load");
assert.ok(simulations && typeof simulations === "object", "Simulations did not load");
assert.ok(labModels && typeof labModels === "object", "Lab models did not load");

function assertText(value, location) {
  assert.ok(typeof value === "string" && value.trim(), `${location} must be nonempty text`);
}

function assertArraySize(value, minimum, maximum, location) {
  assert.ok(Array.isArray(value), `${location} must be an array`);
  assert.ok(
    value.length >= minimum && value.length <= maximum,
    `${location} must contain ${minimum} to ${maximum} items`
  );
}

function assertGuide(guide, lessonId) {
  const location = `guide ${lessonId}`;
  assert.ok(guide && typeof guide === "object", `Missing ${location}`);
  assertText(guide.contextTitle, `${location}.contextTitle`);
  assertArraySize(guide.context, 2, 4, `${location}.context`);
  guide.context.forEach((paragraph, index) => {
    assertText(paragraph, `${location}.context[${index}]`);
  });

  assert.ok(guide.walkthrough && typeof guide.walkthrough === "object", `${location}.walkthrough is missing`);
  assertText(guide.walkthrough.title, `${location}.walkthrough.title`);
  assertText(guide.walkthrough.intro, `${location}.walkthrough.intro`);
  assertArraySize(guide.walkthrough.steps, 4, 8, `${location}.walkthrough.steps`);
  guide.walkthrough.steps.forEach((step, index) => {
    assertText(step?.title, `${location}.walkthrough.steps[${index}].title`);
    assertText(step?.text, `${location}.walkthrough.steps[${index}].text`);
  });
  assertText(guide.walkthrough.takeaway, `${location}.walkthrough.takeaway`);

  assert.ok(guide.workedExample && typeof guide.workedExample === "object", `${location}.workedExample is missing`);
  assertText(guide.workedExample.title, `${location}.workedExample.title`);
  assertText(guide.workedExample.setup, `${location}.workedExample.setup`);
  assert.ok(
    Array.isArray(guide.workedExample.facts) && guide.workedExample.facts.length > 0,
    `${location}.workedExample.facts must be a nonempty array`
  );
  guide.workedExample.facts.forEach((fact, index) => {
    assertText(fact?.label, `${location}.workedExample.facts[${index}].label`);
    assertText(fact?.value, `${location}.workedExample.facts[${index}].value`);
  });
  assertArraySize(guide.workedExample.steps, 3, 7, `${location}.workedExample.steps`);
  guide.workedExample.steps.forEach((step, index) => {
    if (typeof step === "string") {
      assertText(step, `${location}.workedExample.steps[${index}]`);
      return;
    }
    assertText(step?.title, `${location}.workedExample.steps[${index}].title`);
    assertText(step?.text, `${location}.workedExample.steps[${index}].text`);
  });
  assertText(guide.workedExample.result, `${location}.workedExample.result`);

  assertArraySize(guide.explanations, 2, 4, `${location}.explanations`);
  guide.explanations.forEach((explanation, index) => {
    assertText(explanation?.title, `${location}.explanations[${index}].title`);
    assert.ok(
      Array.isArray(explanation?.paragraphs) && explanation.paragraphs.length > 0,
      `${location}.explanations[${index}].paragraphs must be a nonempty array`
    );
    explanation.paragraphs.forEach((paragraph, paragraphIndex) => {
      assertText(paragraph, `${location}.explanations[${index}].paragraphs[${paragraphIndex}]`);
    });
  });

  const table = guide.decisionTable;
  assert.ok(table && typeof table === "object", `${location}.decisionTable is missing`);
  assertText(table.title, `${location}.decisionTable.title`);
  assert.ok(Array.isArray(table.columns) && table.columns.length > 0, `${location}.decisionTable.columns is empty`);
  table.columns.forEach((column, index) => {
    assertText(column, `${location}.decisionTable.columns[${index}]`);
  });
  assert.ok(Array.isArray(table.rows) && table.rows.length > 0, `${location}.decisionTable.rows is empty`);
  table.rows.forEach((row, rowIndex) => {
    assert.equal(row.length, table.columns.length, `${location}.decisionTable.rows[${rowIndex}] has the wrong width`);
    row.forEach((cell, columnIndex) => {
      assertText(cell, `${location}.decisionTable.rows[${rowIndex}][${columnIndex}]`);
    });
  });

  const diagram = guide.diagram;
  const diagramTypes = new Set(["swimlane", "branch", "state-machine", "timeline"]);
  assert.ok(diagram && diagramTypes.has(diagram.type), `${location}.diagram has an unsupported type`);
  assertText(diagram.title, `${location}.diagram.title`);
  if (diagram.type === "swimlane") {
    assert.ok(Array.isArray(diagram.lanes) && diagram.lanes.length > 0, `${location}.diagram.lanes is empty`);
    diagram.lanes.forEach((lane, index) => {
      assertText(lane?.label, `${location}.diagram.lanes[${index}].label`);
      assert.ok(Array.isArray(lane?.items) && lane.items.length > 0, `${location}.diagram.lanes[${index}].items is empty`);
      lane.items.forEach((item, itemIndex) => {
        assertText(item, `${location}.diagram.lanes[${index}].items[${itemIndex}]`);
      });
    });
  } else if (diagram.type === "branch") {
    assertText(diagram.source, `${location}.diagram.source`);
    assert.ok(Array.isArray(diagram.branches) && diagram.branches.length > 0, `${location}.diagram.branches is empty`);
    diagram.branches.forEach((branch, index) => {
      assertText(branch?.label, `${location}.diagram.branches[${index}].label`);
      assertText(branch?.note, `${location}.diagram.branches[${index}].note`);
    });
    if (diagram.destination !== undefined) {
      assertText(diagram.destination, `${location}.diagram.destination`);
    }
  } else if (diagram.type === "state-machine") {
    assert.ok(Array.isArray(diagram.states) && diagram.states.length > 0, `${location}.diagram.states is empty`);
    diagram.states.forEach((state, index) => {
      assertText(state?.label, `${location}.diagram.states[${index}].label`);
      assertText(state?.note, `${location}.diagram.states[${index}].note`);
    });
    assert.ok(
      Array.isArray(diagram.transitions) && diagram.transitions.length > 0,
      `${location}.diagram.transitions is empty`
    );
    diagram.transitions.forEach((transition, index) => {
      assertText(transition, `${location}.diagram.transitions[${index}]`);
    });
  } else {
    assert.ok(Array.isArray(diagram.events) && diagram.events.length > 0, `${location}.diagram.events is empty`);
    diagram.events.forEach((event, index) => {
      assertText(event?.label, `${location}.diagram.events[${index}].label`);
      assertText(event?.note, `${location}.diagram.events[${index}].note`);
    });
  }

  assert.ok(guide.interview && typeof guide.interview === "object", `${location}.interview is missing`);
  assertText(guide.interview.prompt, `${location}.interview.prompt`);
  assertArraySize(guide.interview.answerPoints, 4, 8, `${location}.interview.answerPoints`);
  guide.interview.answerPoints.forEach((point, index) => {
    assertText(point, `${location}.interview.answerPoints[${index}]`);
  });
  assertArraySize(guide.interview.followups, 2, 5, `${location}.interview.followups`);
  guide.interview.followups.forEach((question, index) => {
    assertText(question, `${location}.interview.followups[${index}]`);
  });
}

const moduleIds = new Set(course.modules.map((module) => module.id));
const lessonIds = new Set();
let lessonCount = 0;
let appliedQuestionCount = 0;

assert.deepEqual(Object.keys(designStudios).sort(), ["crawler", "gateway"]);
for (const [studioId, studio] of Object.entries(designStudios)) {
  assertText(studio.title, `${studioId} studio.title`);
  assertArraySize(studio.interviewer, 5, 8, `${studioId} studio.interviewer`);
  assert.equal(studio.phases.length, 7, `${studioId} studio must cover seven interview phases`);
  assert.equal(new Set(studio.phases.map((phase) => phase.id)).size, 7, `${studioId} studio phase IDs repeat`);
  for (const phase of studio.phases) {
    assertText(phase.id, `${studioId} phase.id`);
    assertText(phase.purpose, `${studioId}.${phase.id}.purpose`);
    assertArraySize(phase.fields, 2, 3, `${studioId}.${phase.id}.fields`);
    assert.ok(phase.coach && typeof phase.coach === "object", `${studioId}.${phase.id}.coach is missing`);
    assertText(phase.coach.lead, `${studioId}.${phase.id}.coach.lead`);
    assertArraySize(phase.coach.rows, 4, 5, `${studioId}.${phase.id}.coach.rows`);
    for (const field of phase.fields) {
      assertText(field.id, `${studioId}.${phase.id}.field.id`);
      assertText(field.label, `${studioId}.${phase.id}.${field.id}.label`);
      assertText(field.prompt, `${studioId}.${phase.id}.${field.id}.prompt`);
      if (field.kind === "decision") {
        assertArraySize(field.options, 3, 3, `${studioId}.${phase.id}.${field.id}.options`);
      } else if (field.kind === "diagram") {
        assert.ok(field.minNodes >= 5, `${studioId}.${phase.id}.${field.id} needs a meaningful topology threshold`);
      } else {
        assert.ok(field.minChars >= 80, `${studioId}.${phase.id}.${field.id} needs a meaningful evidence threshold`);
      }
    }
  }
  assertText(studio.workedTopology?.title, `${studioId} studio.workedTopology.title`);
  assertArraySize(studio.workedTopology?.lanes, 3, 3, `${studioId} studio.workedTopology.lanes`);
  studio.workedTopology.lanes.forEach((lane, index) => {
    assertText(lane?.[0], `${studioId} studio.workedTopology.lanes[${index}].label`);
    assertArraySize(lane?.[1], 4, 8, `${studioId} studio.workedTopology.lanes[${index}].nodes`);
  });
  assertArraySize(studio.evolution, 4, 4, `${studioId} studio.evolution`);
  assertArraySize(studio.tradeoffs, 4, 5, `${studioId} studio.tradeoffs`);
  for (const [moduleId, phaseIds] of Object.entries(studio.guidedModules)) {
    assert.ok(course.modules.some((module) => module.id === moduleId), `${studioId} studio references missing module ${moduleId}`);
    assert.ok(phaseIds.every((phaseId) => studio.phases.some((phase) => phase.id === phaseId)), `${studioId} studio has an unknown guided phase`);
  }
}

assert.match(appSource, /previousStorageKey\s*=\s*"decagon-prep:v3"/u, "Missing legacy progress migration");
assert.match(appSource, /localStorage\.removeItem\(previousStorageKey\)/u, "Legacy progress survives migration or reset");
assert.match(appSource, /activeTimer\.endedAt/u, "Timed design evidence has no end boundary");
assert.match(appSource, /\|\|\s*!activeTimer\.running/u, "Paused mocks must lock the design board");
assert.match(appSource, /timestamp\s*<=\s*endedAt/u, "Design evidence may be recorded after time expires");
assert.match(appSource, /data-studio-add-node/u, "System design has no student-created topology control");
assert.match(appSource, /record\.guidedDecisions\[field\.id\]/u, "Mock decisions can bypass their written trade-off gate");
assert.match(appSource, /\.mock-code-rep textarea/u, "Timed coding controls are not covered by the attempt lock");
assert.match(appSource, /codeResult\.attemptId\s*===\s*attemptId/u, "Coding evidence is not bound to the active attempt");

for (const module of course.modules) {
  assertText(module.id, "module.id");
  assert.ok(Array.isArray(module.lessons) && module.lessons.length > 0, `${module.id} has no lessons`);
  const questions = appliedQuestions[module.id];
  assert.ok(Array.isArray(questions) && questions.length >= 2, `${module.id} needs at least two applied questions`);
  appliedQuestionCount += questions.length;
  questions.forEach((question, index) => {
    const location = `${module.id} applied question ${index + 1}`;
    assertText(question?.question, `${location}.question`);
    assert.equal(question?.choices?.length, 4, `${location} must have four choices`);
    question.choices.forEach((choice, choiceIndex) => {
      assertText(choice, `${location}.choices[${choiceIndex}]`);
    });
    assert.ok(Number.isInteger(question.answer), `${location}.answer must be an integer`);
    assert.ok(question.answer >= 0 && question.answer < 4, `${location}.answer is outside the choice range`);
    assertText(question.rationale, `${location}.rationale`);
  });

  const recallCount = module.lessons.length + (module.quizExtra || []).length;
  const quizQuestionCount = recallCount + questions.length;
  const displayedAnswers = Array.from(
    { length: quizQuestionCount },
    (_, index) => (index * 3 + Number(module.number)) % 4
  );
  assert.ok(new Set(displayedAnswers).size >= Math.min(3, quizQuestionCount), `${module.id} quiz answer positions are predictable`);
  const answerCounts = displayedAnswers.reduce((counts, answer) => {
    counts[answer] = (counts[answer] || 0) + 1;
    return counts;
  }, {});
  assert.ok(Math.max(...Object.values(answerCounts)) <= Math.ceil(quizQuestionCount / 2), `${module.id} quiz overuses one answer position`);

  for (const lesson of module.lessons) {
    assert.ok(!lessonIds.has(lesson.id), `Duplicate lesson id: ${lesson.id}`);
    lessonIds.add(lesson.id);
    lessonCount += 1;
    assertGuide(guides[lesson.id], lesson.id);
  }
}

for (const guideId of Object.keys(guides)) {
  assert.ok(lessonIds.has(guideId), `Guide has no matching lesson: ${guideId}`);
}
for (const moduleId of Object.keys(appliedQuestions)) {
  assert.ok(moduleIds.has(moduleId), `Applied questions have no matching module: ${moduleId}`);
}
assert.equal(Object.keys(guides).length, lessonCount, "Guide count does not match lesson count");

function copyConfig(config) {
  return JSON.parse(JSON.stringify(config));
}

function assertDeterministic(label, runner, config) {
  assert.equal(typeof runner, "function", `${label} is not callable`);
  const first = runner(copyConfig(config));
  const second = runner(copyConfig(config));
  assert.ok(first && typeof first === "object", `${label} returned no result`);
  assert.deepEqual(first, second, `${label} changed across identical runs`);
}

const simulationCases = {
  runGateway: {
    scenario: "flaky-fast",
    policy: "hedge",
    requests: 160,
    rps: 60,
    gatewayCap: 28,
    queueCap: 20,
    providerCapA: 7,
    providerCapB: 9,
    deadlineMs: 800,
    hedgeMs: 140,
    explorationPct: 10,
    seed: 81
  },
  runCrawler: {
    scheduler: "host-aware",
    workers: 8,
    perHostCap: 1,
    perIpCap: 2,
    minDelayMs: 1_000,
    respectRobots: true,
    seed: 17,
    scenario: "mixed"
  }
};

for (const [name, config] of Object.entries(simulationCases)) {
  assertDeterministic(`simulation ${name}`, simulations[name], config);
}

const breakerRun = simulations.runGateway({
  scenario: "flaky-fast",
  policy: "adaptive",
  requests: 500,
  rps: 40,
  gatewayCap: 80,
  queueCap: 160,
  providerCapA: 32,
  providerCapB: 32,
  deadlineMs: 1_200,
  explorationPct: 10,
  seed: 7
});
const providerATransitions = breakerRun.providers.A.transitions;
assert.ok(providerATransitions.some((event) => event.state === "open"), "Adaptive gateway never opened A after repeated failures");
assert.ok(providerATransitions.some((event) => event.state === "half-open"), "Adaptive gateway never admitted a half-open probe");
assert.ok(providerATransitions.some((event) => event.state === "recovering"), "Adaptive gateway never entered a recovery ramp");
for (let index = 0; index < providerATransitions.length; index += 1) {
  const opened = providerATransitions[index];
  if (opened.state !== "open") continue;
  const halfOpen = providerATransitions.slice(index + 1).find((event) => event.state === "half-open");
  if (!halfOpen) continue;
  const ordinaryStartsDuringCooldown = breakerRun.requests.flatMap((request) => request.attempts)
    .filter((attempt) => attempt.provider === "A" && !attempt.breakerProbe)
    .filter((attempt) => attempt.startMs > opened.atMs && attempt.startMs < halfOpen.atMs);
  assert.equal(ordinaryStartsDuringCooldown.length, 0, "Ordinary traffic entered A during cooldown");
}
assert.equal(breakerRun.metrics.latencyPopulation, "successful requests", "Gateway latency population is ambiguous");
assert.ok(breakerRun.metrics.achievedRps > 0, "Gateway omits achieved throughput");
assert.ok(Number.isFinite(breakerRun.metrics.terminalP95), "Gateway omits terminal latency");

const labModelCases = {
  runFleet: {
    scenario: "coordinator-partition",
    strategy: "leases",
    replicas: 15,
    zones: 3,
    localCap: 10,
    providerQuotaA: 100,
    providerQuotaB: 100,
    offeredConcurrency: 150,
    normalShareA: 60,
    failoverReserveB: 20,
    leaseTtlSec: 60,
    maxAttemptSec: 30
  },
  runIncident: {
    scenario: "provider-outage",
    configMode: "atomic",
    durationSec: 120,
    stepSec: 5,
    rps: 1_000,
    gatewayCap: 2_400,
    queueCap: 5_000,
    providerCapA: 1_500,
    providerCapB: 1_000,
    deadlineMs: 1_200,
    faultStartSec: 30,
    shiftDelaySec: 10,
    recoveryStartSec: 80,
    recoveryRampSec: 30,
    telemetryQueueBytes: 268_435_456,
    telemetrySinkBytesPerSec: 2_200_000
  },
  runCrawlPipeline: {
    pagesPerDay: 100_000_000,
    peakFactor: 3,
    attemptAmplification: 1.15,
    meanFetchMs: 400,
    p95FetchMs: 2_000,
    authorityGapMs: 5_000,
    perAuthorityConcurrency: 1,
    meanResponseKiB: 200,
    parserCpuMs: 20,
    parserCores: 96,
    browserRenderFraction: 0.05,
    slowdown: {
      durationSeconds: 600,
      parserCapacityFactor: 0.2,
      inputRateMode: "average",
      queueCapacityPages: 500_000,
      maxRecoverySeconds: 900
    }
  },
  runFrontierChallenge: {
    scenario: "mixed",
    controls: {
      scheduler: "authority-ready",
      workers: 3,
      perAuthorityConcurrency: 1,
      sharedIpCap: 1,
      enforceAuthorityReady: true,
      enforceSharedIp: true,
      robotsPolicy: "rfc9309",
      durableLeases: true,
      requeueExpiredLeases: true,
      leaseMs: 800,
      revalidateRedirects: true,
      blockForbiddenAddresses: true,
      pinValidatedAddress: true,
      enforceEgress: true,
      dedupeMode: "bloom-plus-exact",
      enforceCrawlBudget: true,
      maxUrlsPerAuthority: 6
    }
  }
};

assert.deepEqual(
  Object.keys(labModels).sort(),
  Object.keys(labModelCases).sort(),
  "Every exported lab model needs a deterministic test case"
);
for (const [name, config] of Object.entries(labModelCases)) {
  assertDeterministic(`lab model ${name}`, labModels[name], config);
}

const atomicConfigRun = labModels.runIncident({
  ...labModelCases.runIncident,
  scenario: "bad-configuration",
  configMode: "atomic"
});
const partialConfigRun = labModels.runIncident({
  ...labModelCases.runIncident,
  scenario: "bad-configuration",
  configMode: "partial"
});
assert.equal(atomicConfigRun.invariants.find((item) => item.name === "Atomic configuration apply")?.ok, true);
assert.equal(partialConfigRun.invariants.find((item) => item.name === "Atomic configuration apply")?.ok, false);
const longTelemetryOutage = labModels.runIncident({
  ...labModelCases.runIncident,
  scenario: "telemetry-sink-outage",
  recoveryStartSec: 600,
  recoveryRampSec: 30
});
assert.equal(longTelemetryOutage.config.durationSec, 630, "Incident timeline did not extend through recovery");
assert.ok(longTelemetryOutage.summary.totalTelemetryDroppedBytes > 0, "Long telemetry outage never filled its bounded buffer");
const incidentStepOne = labModels.runIncident({ ...labModelCases.runIncident, stepSec: 1 });
const incidentStepFive = labModels.runIncident({ ...labModelCases.runIncident, stepSec: 5 });
assert.deepEqual(incidentStepOne.summary, incidentStepFive.summary, "Incident summary changes with display step size");
const rejectedQueueRun = labModels.runIncident({
  ...labModelCases.runIncident,
  queueCap: 0,
  rps: 8_000,
  providerCapB: 100
});
assert.ok(rejectedQueueRun.summary.totalQueueRejectedRequests > 0, "Queue overflow is not reported as rejected work");
const unsafeLeaseWindow = labModels.runFleet({
  ...labModelCases.runFleet,
  leaseTtlSec: 30,
  maxAttemptSec: 30
});
assert.equal(unsafeLeaseWindow.invariants.find((item) => item.name === "Lease drain window")?.ok, false, "Lease reclaim accepts no clock-safety margin");
assert.deepEqual(
  unsafeLeaseWindow.timeline.map((event) => event.timeSec),
  unsafeLeaseWindow.timeline.map((event) => event.timeSec).slice().sort((left, right) => left - right),
  "Lease timeline is not chronological"
);

const schedulerReady = labModels.runFrontierChallenge({
  scenario: "authority-ready",
  scheduler: "authority-ready",
  workers: 1,
  perAuthorityConcurrency: 1,
  sharedIpCap: 16,
  leaseMs: 800
});
const schedulerFifo = labModels.runFrontierChallenge({
  scenario: "authority-ready",
  scheduler: "global-fifo",
  workers: 1,
  perAuthorityConcurrency: 1,
  sharedIpCap: 16,
  leaseMs: 800
});
assert.ok(schedulerReady.metrics.makespanMs < schedulerFifo.metrics.makespanMs, "Scheduler choice has no visible makespan effect");
assert.ok(schedulerReady.metrics.p95EligibleWaitMs < schedulerFifo.metrics.p95EligibleWaitMs, "Scheduler choice has no visible eligible-wait effect");
const authorityCapOne = labModels.runFrontierChallenge({ scenario: "authority-ready", workers: 16, perAuthorityConcurrency: 1, sharedIpCap: 16 });
const authorityCapTwo = labModels.runFrontierChallenge({ scenario: "authority-ready", workers: 16, perAuthorityConcurrency: 2, sharedIpCap: 16 });
assert.ok(authorityCapTwo.metrics.maxAuthorityConcurrency > authorityCapOne.metrics.maxAuthorityConcurrency, "Per-authority concurrency control is inert");
const shortLeaseRun = labModels.runFrontierChallenge({ scenario: "authority-ready", workers: 3, perAuthorityConcurrency: 2, sharedIpCap: 16, leaseMs: 50 });
assert.ok(shortLeaseRun.metrics.leaseRenewals > 0, "Long fetches do not renew short leases");
assert.equal(shortLeaseRun.invariants.find((item) => item.name === "Active work keeps durable lease ownership")?.ok, true);
const robotsRun = labModels.runFrontierChallenge({ scenario: "robots" });
assert.equal(robotsRun.metrics.robotsDeferred, 2, "Unreachable robots work was not retained for refresh");
const failOpenRobotsRun = labModels.runFrontierChallenge({ scenario: "robots", robotsPolicy: "fail-open" });
assert.equal(
  failOpenRobotsRun.events.some((event) => event.type === "fetch_started" && event.url?.endsWith("/private")),
  false,
  "Fail-open robots policy ignored a valid 2xx disallow rule"
);
const duplicateRun = labModels.runFrontierChallenge({ scenario: "dedupe", dedupeMode: "none" });
assert.equal(duplicateRun.ok, false, "Duplicate fetches are certified as safe");
assert.ok(duplicateRun.metrics.duplicateFetches > 0, "Duplicate fetch count is missing");
assert.ok(duplicateRun.events.some((event) => event.type === "duplicate_fetch_started" && event.durabilityViolation), "Duplicate failure has no event evidence");
const renewalRun = labModels.runFrontierChallenge({
  authorities: [{ name: "renew.example", ip: "93.184.216.34", readyAtMs: 0, gapMs: 0, robotsOutcome: "2xx" }],
  tasks: [{ id: "renew", authority: "renew.example", url: "https://renew.example/", durationMs: 800 }],
  leaseMs: 800
});
assert.ok(renewalRun.events.some((event) => event.type === "lease_renewed" && event.atMs < 800), "Lease renewal occurs at or after expiry");

const sharedPeerAuthorities = [
  { name: "one.example", ip: "93.184.216.34", readyAtMs: 0, gapMs: 0, robotsOutcome: "2xx" },
  { name: "two.example", ip: "142.250.72.14", readyAtMs: 0, gapMs: 0, robotsOutcome: "2xx" }
];
const sharedPeerTasks = sharedPeerAuthorities.map((authority, index) => ({
  id: `shared-${index}`,
  authority: authority.name,
  url: `https://${authority.name}/`,
  durationMs: 400,
  connectIp: "8.8.4.4"
}));
const sharedPeerRun = labModels.runFrontierChallenge({
  authorities: sharedPeerAuthorities,
  tasks: sharedPeerTasks,
  workers: 2,
  perAuthorityConcurrency: 1,
  sharedIpCap: 1,
  enforceSharedIp: true,
  pinValidatedAddress: false
});
assert.equal(sharedPeerRun.metrics.maxSharedIpConcurrency, 1, "Shared destination cap keys the pre-DNS authority address");

const budgetAuthority = { name: "budget.example", ip: "93.184.216.34", readyAtMs: 0, gapMs: 0, robotsOutcome: "2xx" };
const ordinaryBudgetRun = labModels.runFrontierChallenge({
  authorities: [budgetAuthority],
  tasks: Array.from({ length: 5 }, (_, index) => ({ id: `ordinary-${index}`, authority: budgetAuthority.name, url: `https://${budgetAuthority.name}/${index}`, durationMs: 10 })),
  maxUrlsPerAuthority: 3,
  enforceCrawlBudget: true
});
assert.equal(ordinaryBudgetRun.metrics.budgetDrops, 2, "Authority budget applies only to trap-tagged URLs");
const initialReadyRun = labModels.runFrontierChallenge({
  authorities: [{ name: "later.example", ip: "93.184.216.34", readyAtMs: 1000, gapMs: 1000, robotsOutcome: "2xx" }],
  tasks: [{ id: "too-early", authority: "later.example", url: "https://later.example/", durationMs: 50 }],
  enforceAuthorityReady: false
});
assert.equal(initialReadyRun.ok, false, "Initial authority-ready time is not checked");
assert.ok(initialReadyRun.events.some((event) => event.type === "authority_started_early" && event.safetyViolation), "Authority-ready failure has no event evidence");

const publicAuthority = { name: "public.example", ip: "93.184.216.34", readyAtMs: 0, gapMs: 1, robotsOutcome: "2xx" };
for (const forbiddenAddress of [
  "::ffff:a9fe:a9fe",
  "0:0:0:0:0:ffff:a9fe:a9fe",
  "::ffff:169.254.169.254",
  "2001:db8::1",
  "3fff::1",
  "fec0::1",
  "2001::1"
]) {
  const addressRun = labModels.runFrontierChallenge({
    authorities: [publicAuthority],
    tasks: [{
      id: "address-test",
      logicalId: "address-test",
      authority: publicAuthority.name,
      url: `https://${publicAuthority.name}/`,
      durationMs: 10,
      connectIp: forbiddenAddress
    }],
    pinValidatedAddress: false,
    enforceEgress: false
  });
  assert.equal(addressRun.metrics.rebindViolations, 1, `Forbidden address bypassed policy: ${forbiddenAddress}`);
}

const publicIPv6Run = labModels.runFrontierChallenge({
  authorities: [publicAuthority],
  tasks: [{ id: "public-v6", authority: publicAuthority.name, url: `https://${publicAuthority.name}/v6`, durationMs: 10, connectIp: "2606:4700:4700::1111" }],
  pinValidatedAddress: false,
  enforceEgress: true
});
assert.equal(publicIPv6Run.metrics.securityBlocks, 0, "Public global-unicast IPv6 address was blocked");

const writingViolations = [];
const courseTextFiles = filesUnder(decagonRoot)
  .filter((file) => [".js", ".html", ".css"].includes(path.extname(file)))
  .sort();

for (const file of courseTextFiles) {
  const source = fs.readFileSync(file, "utf8");
  const lines = source.split(/\r?\n/u);
  lines.forEach((line, index) => {
    const location = `${relativeToRoot(file)}:${index + 1}`;
    if (/[ \t]+$/u.test(line)) writingViolations.push(`${location}: trailing whitespace`);
    if (line.includes("\u2014")) writingViolations.push(`${location}: em dash`);
    for (const { term, pattern } of bannedPatterns) {
      if (pattern.test(line)) writingViolations.push(`${location}: banned term "${term}"`);
    }
  });
}

assert.equal(
  writingViolations.length,
  0,
  `Writing checks failed:\n${writingViolations.join("\n")}`
);

console.log(
  `Decagon revision validated: ${course.modules.length} modules, ${lessonCount} lessons, ${appliedQuestionCount} applied questions.`
);
console.log(
  `Loaded ${guideFiles.length} guide registries, ${appliedFiles.length} applied registries, ${Object.keys(labModelCases).length} lab models, and ${Object.keys(simulationCases).length} simulations.`
);
console.log(`Checked ${assets.length} local script and stylesheet assets plus ${courseTextFiles.length} course text files.`);
