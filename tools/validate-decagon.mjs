import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const courseSource = fs.readFileSync(path.join(root, "decagon/course-data.js"), "utf8");
const simulationSource = fs.readFileSync(path.join(root, "decagon/simulations.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "decagon/index.html"), "utf8");
const context = { window: {}, console };
context.globalThis = context;
vm.createContext(context);
vm.runInContext(courseSource, context, { filename: "course-data.js" });
vm.runInContext(simulationSource, context, { filename: "simulations.js" });

const course = context.window.DECAGON_COURSE;
const simulation = context.window.DecagonSim;
assert.ok(course, "Course data did not load");
assert.ok(simulation, "Simulation module did not load");
assert.equal(course.modules.length, 9, "Expected nine modules");
assert.equal(course.mocks.length, 3, "Expected three mock interviews");

const ids = new Set();
let minutes = 0;
for (const module of course.modules) {
  assert.ok(!ids.has(module.id), `Duplicate module id: ${module.id}`);
  ids.add(module.id);
  assert.ok(course.tracks.some((track) => track.id === module.track), `Unknown track: ${module.track}`);
  assert.ok(module.lessons.length >= 3, `${module.id} needs at least three lessons`);
  minutes += module.duration;

  for (const lesson of module.lessons) {
    assert.ok(!ids.has(lesson.id), `Duplicate lesson id: ${lesson.id}`);
    ids.add(lesson.id);
    assert.ok(lesson.check.answer >= 0 && lesson.check.answer < lesson.check.choices.length, `Invalid answer for ${lesson.id}`);
    assert.ok(lesson.sources.length >= 2, `${lesson.id} needs direct sources`);
    for (const [, url] of lesson.sources) assert.match(url, /^https:\/\//, `Source must use HTTPS: ${url}`);
  }

  for (const question of module.quizExtra) {
    assert.ok(question.answer >= 0 && question.answer < question.choices.length, `Invalid extra answer in ${module.id}`);
  }
}

assert.equal(minutes, course.totalMinutes, "Declared course minutes do not match module minutes");
assert.match(indexSource, /course-data\.js[\s\S]+simulations\.js[\s\S]+app\.js/, "Scripts are in the wrong order");

const gatewayConfig = {
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
};
const firstGateway = simulation.runGateway(gatewayConfig);
const secondGateway = simulation.runGateway(gatewayConfig);
assert.deepEqual(firstGateway, secondGateway, "Gateway simulation is not deterministic");
assert.ok(firstGateway.providers.A.maxInFlight <= gatewayConfig.providerCapA, "Provider A exceeded its cap");
assert.ok(firstGateway.providers.B.maxInFlight <= gatewayConfig.providerCapB, "Provider B exceeded its cap");
assert.ok(firstGateway.metrics.attemptsPerRequest >= 1, "Attempt count is invalid");

for (const scenario of ["mixed", "robots-503", "shared-ip", "trap", "partition"]) {
  const crawler = simulation.runCrawler({
    scheduler: "host-aware",
    workers: 8,
    perHostCap: 1,
    perIpCap: 2,
    minDelayMs: 1000,
    respectRobots: true,
    seed: 17,
    scenario
  });
  assert.ok(crawler.metrics.maxHostConcurrency <= 1, `${scenario} exceeded the authority cap`);
  assert.ok(crawler.metrics.maxIpConcurrency <= 2, `${scenario} exceeded the IP cap`);
}

console.log(`Decagon course validated: ${course.modules.length} modules, ${ids.size - course.modules.length} lessons, ${course.mocks.length} mocks.`);
