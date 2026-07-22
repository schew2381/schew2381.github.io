(() => {
  "use strict";

  const course = window.DECAGON_COURSE;
  const Sim = window.DecagonSim;
  if (!course || !Sim) return;

  const guides = window.DECAGON_GUIDES || {};
  const LabModels = window.DecagonLabModels || {};
  const appliedQuestions = window.DECAGON_APPLIED_QUESTIONS || {};
  const systemDesignStudios = window.DECAGON_SYSTEM_DESIGN_STUDIOS || {};

  course.modules.sort((a, b) => Number(a.number) - Number(b.number));

  const allLessons = course.modules.flatMap((module) =>
    module.lessons.map((lesson, index) => ({ lesson, module, index }))
  );
  const lessonById = new Map(allLessons.map((entry) => [entry.lesson.id, entry]));
  const moduleById = new Map(course.modules.map((module) => [module.id, module]));
  const mockById = new Map(course.mocks.map((mock) => [mock.id, mock]));
  const passingScore = 75;
  const storageKey = `decagon-prep:v${course.version}`;
  const previousStorageKey = "decagon-prep:v3";
  const defaultState = {
    completedLessons: [],
    completedLabs: [],
    quizScores: {},
    benchmarks: [],
    notes: {},
    codeDrafts: {},
    codeResults: {},
    designs: {},
    mockScores: {},
    mockNotes: {},
    mockNoteUpdatedAt: {},
    designWorkbooks: {},
    mockDesignWorkbooks: {},
    activeMockTimer: null,
    mode: "learn",
    lastRoute: "home"
  };

  let state = loadState();
  let activeQuiz = null;
  let activeSearchIndex = 0;
  let activeGatewayRun = null;
  let activeCrawlerRun = null;
  let activeFleetRun = null;
  let activeIncidentRun = null;
  let frontierFailedRun = null;
  let activeTimer = restoreMockTimer(state.activeMockTimer);
  let timerInterval = null;
  let toastTimer = null;

  const view = document.querySelector("#course-view");
  const rail = document.querySelector("#course-rail");
  const moduleNav = document.querySelector("#module-nav");
  const drawer = document.querySelector("#context-drawer");
  const breadcrumbs = document.querySelector("#breadcrumbs");
  const searchDialog = document.querySelector("#search-dialog");
  const searchInput = document.querySelector("#search-input");
  const searchResults = document.querySelector("#search-results");
  const modeButtons = [...document.querySelectorAll("[data-mode-value]")];

  const trackLabels = {
    coding: "AI coding",
    "gateway-design": "Gateway design",
    "crawler-design": "Crawler design"
  };

  const modeCopy = {
    learn: {
      label: "Guided lesson",
      description: "Start with a concrete failure, follow one request, then work through the decision."
    },
    interview: {
      label: "Interview drill",
      description: "Answer from a blank page before revealing the expected reasoning and follow-up questions."
    },
    reference: {
      label: "Reference sheet",
      description: "Use the compact diagrams, decision tables, formulas, and source links while reviewing."
    }
  };

  const gatewayPolicyLabels = {
    fixed: "Prefer A, fallback on failure",
    "round-robin": "Round robin",
    "least-inflight": "Least in flight",
    adaptive: "Error-aware EWMA",
    hedge: "Adaptive with a delayed hedge"
  };

  const gatewayScenarioLabels = {
    steady: "Steady",
    "flaky-fast": "A is fast but flaky",
    brownout: "Provider brownout",
    recovery: "Failure then recovery",
    "slow-tail": "Long latency tail"
  };

  function moduleTrackLabel(module) {
    return module.id === "interview-rehearsals" ? "All three interviews" : trackLabels[module.track];
  }

  function loadState() {
    try {
      const currentRaw = localStorage.getItem(storageKey);
      const previousRaw = currentRaw ? null : localStorage.getItem(previousStorageKey);
      const saved = JSON.parse(currentRaw || previousRaw);
      if (!saved || typeof saved !== "object") return structuredClone(defaultState);
      const loaded = {
        ...structuredClone(defaultState),
        ...saved,
        completedLessons: arrayOfStrings(saved.completedLessons),
        completedLabs: arrayOfStrings(saved.completedLabs),
        quizScores: objectOrEmpty(saved.quizScores),
        benchmarks: Array.isArray(saved.benchmarks) ? saved.benchmarks.slice(0, 40) : [],
        notes: objectOrEmpty(saved.notes),
        codeDrafts: objectOrEmpty(saved.codeDrafts),
        codeResults: objectOrEmpty(saved.codeResults),
        designs: objectOrEmpty(saved.designs),
        mockScores: objectOrEmpty(saved.mockScores),
        mockNotes: objectOrEmpty(saved.mockNotes),
        mockNoteUpdatedAt: objectOrEmpty(saved.mockNoteUpdatedAt),
        designWorkbooks: objectOrEmpty(saved.designWorkbooks),
        mockDesignWorkbooks: objectOrEmpty(saved.mockDesignWorkbooks)
      };
      if (previousRaw || !saved.designWorkbooks || !saved.mockDesignWorkbooks) {
        const replacedLabs = new Set(["production-fleet", "telemetry-recovery", "crawler-request-path", "crawler-frontier", "interview-rehearsals"]);
        loaded.completedLabs = loaded.completedLabs.filter((id) => !replacedLabs.has(id));
        loaded.designWorkbooks = {};
        loaded.mockDesignWorkbooks = {};
        loaded.activeMockTimer = null;
        delete loaded.mockScores["gateway-production-design"];
        delete loaded.mockScores["web-crawler-design"];
        localStorage.setItem(storageKey, JSON.stringify(loaded));
        if (previousRaw) localStorage.removeItem(previousStorageKey);
      }
      return loaded;
    } catch {
      return structuredClone(defaultState);
    }
  }

  function arrayOfStrings(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  }

  function objectOrEmpty(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function restoreMockTimer(value) {
    if (!value || typeof value !== "object" || !mockById.has(value.mockId)) return null;
    const mock = mockById.get(value.mockId);
    const total = mock.minutes * 60;
    const elapsed = Math.max(0, Math.min(total, Number(value.elapsed || 0)));
    return {
      mockId: mock.id,
      remaining: Math.max(0, total - elapsed),
      running: Boolean(value.running && elapsed < total),
      started: Boolean(value.started),
      elapsed,
      startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
      endedAt: typeof value.endedAt === "string" ? value.endedAt : null,
      attemptId: typeof value.attemptId === "string" ? value.attemptId : null,
      rubricRevealed: Boolean(value.rubricRevealed),
      elapsedAtRunStart: Math.max(0, Math.min(total, Number(value.elapsedAtRunStart ?? elapsed))),
      runStartedAtMs: Number.isFinite(Number(value.runStartedAtMs)) ? Number(value.runStartedAtMs) : null
    };
  }

  function saveState() {
    try {
      state.activeMockTimer = activeTimer ? structuredClone(activeTimer) : null;
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      announce("This browser could not save your progress.");
    }
  }

  function escapeHTML(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(value) {
    return escapeHTML(value).replaceAll("`", "&#096;");
  }

  function routeFor(type, id) {
    return id ? `${type}/${id}` : type;
  }

  function currentRoute() {
    return location.hash.replace(/^#\/?/, "") || state.lastRoute || "home";
  }

  function parseRoute() {
    const [type = "home", id] = currentRoute().split("/");
    return { type, id };
  }

  function goToRoute(route) {
    setMobileMap(false);
    if (location.hash === `#${route}`) renderRoute();
    else location.hash = route;
  }

  function formatMinutes(minutes) {
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
  }

  function announce(message) {
    const region = document.querySelector("#live-region");
    if (region) region.textContent = message;
  }

  function showToast(message) {
    const toast = document.querySelector("#toast");
    if (!toast) return;
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("show");
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
  }

  function moduleProgress(module) {
    const lessons = module.lessons.filter((lesson) => state.completedLessons.includes(lesson.id)).length;
    const lab = Number(state.completedLabs.includes(module.id));
    const quiz = Number((state.quizScores[module.id] || 0) >= passingScore);
    const total = module.lessons.length + 2;
    const complete = lessons + lab + quiz;
    return { complete, total, percent: Math.round((complete / total) * 100) };
  }

  function moduleComplete(module) {
    return moduleProgress(module).percent === 100;
  }

  function trackStats(trackId) {
    const modules = course.modules.filter((module) => module.track === trackId && module.id !== "interview-rehearsals");
    const checkpoints = modules.reduce((sum, module) => sum + module.lessons.length + 2, 0);
    const completed = modules.reduce((sum, module) => sum + moduleProgress(module).complete, 0);
    const mock = course.mocks.find((item) => item.track === trackId);
    const mockScore = mock ? Number(state.mockScores[mock.id]?.percent || 0) : 0;
    const percent = checkpoints ? Math.round((completed / checkpoints) * 100) : 0;
    const status = percent === 100 && mockScore >= 70
      ? "Ready"
      : mockScore > 0
        ? "Needs another rep"
        : completed > 0
          ? "Building"
          : "Not started";
    return { modules, checkpoints, completed, percent, mockScore, status };
  }

  function overallStats() {
    const total = allLessons.length + course.modules.length * 2 + course.mocks.length;
    const mockComplete = course.mocks.filter((mock) => Number(state.mockScores[mock.id]?.percent || 0) >= 70).length;
    const complete =
      state.completedLessons.filter((id) => lessonById.has(id)).length +
      state.completedLabs.filter((id) => moduleById.has(id)).length +
      course.modules.filter((module) => (state.quizScores[module.id] || 0) >= passingScore).length +
      mockComplete;
    return { total, complete, percent: Math.round((complete / total) * 100) };
  }

  function nextRoute() {
    for (const module of course.modules) {
      const lesson = module.lessons.find((item) => !state.completedLessons.includes(item.id));
      if (lesson) return routeFor("lesson", lesson.id);
      if (!state.completedLabs.includes(module.id)) return routeFor("lab", module.id);
      if ((state.quizScores[module.id] || 0) < passingScore) return routeFor("quiz", module.id);
      const mockAfterModule = {
        "coding-execution": "ai-gateway-coding",
        "telemetry-recovery": "gateway-production-design",
        "crawler-frontier": "web-crawler-design"
      };
      const mockId = mockAfterModule[module.id];
      if (mockId && Number(state.mockScores[mockId]?.percent || 0) < 70) return routeFor("mock", mockId);
    }
    return "home";
  }

  function routeAfterModule(module) {
    const mockAfterModule = {
      "coding-execution": "mock/ai-gateway-coding",
      "telemetry-recovery": "mock/gateway-production-design",
      "crawler-frontier": "mock/web-crawler-design"
    };
    if (mockAfterModule[module.id]) return mockAfterModule[module.id];
    const index = course.modules.findIndex((entry) => entry.id === module.id);
    const next = course.modules[index + 1];
    return next ? routeFor("module", next.id) : "home";
  }

  function labelAfterModule(module) {
    if (module.id === "coding-execution") return "Run the coding mock";
    if (module.id === "telemetry-recovery") return "Run the gateway design mock";
    if (module.id === "crawler-frontier") return "Run the crawler design mock";
    const index = course.modules.findIndex((entry) => entry.id === module.id);
    return course.modules[index + 1] ? `Next: ${course.modules[index + 1].shortTitle}` : "Return to the course map";
  }

  function renderNav(activeModuleId) {
    const rehearsal = course.modules.find((module) => module.id === "interview-rehearsals");
    const trackNavigation = course.tracks
      .map((track) => {
        const modules = course.modules.filter((module) => module.track === track.id && module.id !== "interview-rehearsals");
        return `
          <section class="nav-lane" aria-labelledby="nav-${track.id}">
            <div class="nav-lane-label" id="nav-${track.id}">${escapeHTML(track.shortLabel || track.label)}</div>
            ${modules.map((module) => {
              const progress = moduleProgress(module);
              const status = progress.percent === 100 ? "Complete" : progress.complete ? "In progress" : "Not started";
              return `
                <button
                  class="module-nav-button"
                  type="button"
                  data-route="${routeFor("module", module.id)}"
                  ${module.id === activeModuleId ? 'aria-current="page"' : ""}
                >
                  <span class="nav-index">${escapeHTML(module.number)}</span>
                  <span class="nav-label">${escapeHTML(module.shortTitle)}</span>
                  <span class="nav-status ${progress.percent === 100 ? "complete" : progress.complete ? "started" : ""}" aria-label="${status}"></span>
                </button>
              `;
            }).join("")}
          </section>
        `;
      })
      .join("");
    const rehearsalNavigation = rehearsal ? `
      <section class="nav-lane nav-lane-rehearsal" aria-labelledby="nav-rehearsal">
        <div class="nav-lane-label" id="nav-rehearsal">Mock interviews</div>
        ${(() => {
          const progress = moduleProgress(rehearsal);
          const status = progress.percent === 100 ? "Complete" : progress.complete ? "In progress" : "Not started";
          return `
            <button
              class="module-nav-button"
              type="button"
              data-route="${routeFor("module", rehearsal.id)}"
              ${rehearsal.id === activeModuleId ? 'aria-current="page"' : ""}
            >
              <span class="nav-index">${escapeHTML(rehearsal.number)}</span>
              <span class="nav-label">${escapeHTML(rehearsal.shortTitle)}</span>
              <span class="nav-status ${progress.percent === 100 ? "complete" : progress.complete ? "started" : ""}" aria-label="${status}"></span>
            </button>
          `;
        })()}
      </section>
    ` : "";
    moduleNav.innerHTML = trackNavigation + rehearsalNavigation;
  }

  function updateModePicker() {
    for (const button of modeButtons) {
      const selected = button.dataset.modeValue === state.mode;
      button.setAttribute("aria-pressed", String(selected));
    }
  }

  function updateProgress() {
    const stats = overallStats();
    const bar = document.querySelector("#progress-bar");
    const track = bar?.parentElement;
    document.querySelector("#progress-percent").textContent = `${stats.percent}%`;
    document.querySelector("#progress-detail").textContent = `${stats.complete} of ${stats.total} evidence checks complete`;
    if (bar) bar.style.width = `${stats.percent}%`;
    if (track) track.setAttribute("aria-valuenow", String(stats.percent));
  }

  function renderBreadcrumbs(parts) {
    breadcrumbs.innerHTML = parts.map((part, index) => {
      const value = part.route
        ? `<button type="button" data-route="${part.route}">${escapeHTML(part.label)}</button>`
        : `<span aria-current="page">${escapeHTML(part.label)}</span>`;
      return `${index ? '<span class="breadcrumb-separator" aria-hidden="true">/</span>' : ""}${value}`;
    }).join("");
  }

  function renderHome() {
    renderBreadcrumbs([{ label: "Interview preparation" }]);
    if (!activeGatewayRun) activeGatewayRun = Sim.runGateway(defaultGatewayConfig());
    const stats = overallStats();
    const currentMode = modeCopy[state.mode] || modeCopy.learn;

    view.innerHTML = `
      <div class="home-view decagon-home home-revision">
        <section class="orientation-hero" aria-labelledby="home-title">
          <div class="orientation-copy">
            <div class="orientation-kicker">
              <span class="eyebrow">Decagon infrastructure interview lab</span>
              <span class="freshness-stamp">Sources checked ${escapeHTML(course.verified.date)}</span>
            </div>
            <h1 id="home-title">Build the gateway. Defend the system.</h1>
            <p class="orientation-lede">The coding round and its system-design follow-up are one continuous problem. The crawler round tests the same habits against a different distributed system: define the contract, trace ownership, estimate capacity, and explain failure behavior.</p>
            <div class="hero-actions">
              <button class="primary-button" type="button" data-route="${nextRoute()}">${stats.complete ? "Continue your next exercise" : "Start the first guided lesson"}</button>
              <button class="secondary-button" type="button" data-route="module/interview-rehearsals">See the three interview prompts</button>
            </div>
            <dl class="course-facts" aria-label="Course facts">
              <div><dt>Lessons</dt><dd>${allLessons.length}</dd></div>
              <div><dt>Hands-on labs</dt><dd>${course.modules.length}</dd></div>
              <div><dt>Full mocks</dt><dd>${course.mocks.length}</dd></div>
              <div><dt>Evidence recorded</dt><dd>${stats.complete}/${stats.total}</dd></div>
            </dl>
          </div>

          <div class="round-brief" aria-labelledby="round-brief-title">
            <div class="round-brief-head">
              <span class="eyebrow">How the interviews connect</span>
              <h2 id="round-brief-title">Three rooms, two systems</h2>
            </div>
            <div class="round-stack">
              <article class="round-card round-coding">
                <div class="round-meta"><span>01</span><strong>75 min · coding</strong></div>
                <h3>Build one correct request path</h3>
                <p>Forward one model request to either provider, measure the result, then adapt without breaking deadlines or concurrency limits.</p>
                <div class="mini-architecture gateway-mini" role="img" aria-label="Client request enters one gateway, which can call provider A or provider B.">
                  <span>client</span><i aria-hidden="true">→</i><strong>gateway</strong><i aria-hidden="true">→</i><span class="provider-pair"><b>A</b><b>B</b></span>
                </div>
              </article>
              <div class="round-connector" aria-hidden="true"><span></span><small>same prototype, production constraints</small></div>
              <article class="round-card round-gateway">
                <div class="round-meta"><span>02</span><strong>system design follow-up</strong></div>
                <h3>Scale the gateway into a fleet</h3>
                <p>Add replicas, shared quotas, local health, configuration rollout, streaming behavior, and telemetry without placing every decision on a central hot path.</p>
                <div class="mini-architecture fleet-mini" role="img" aria-label="An edge sends requests to three gateway replicas, which share quota and telemetry services while calling two providers.">
                  <span>edge</span><i aria-hidden="true">→</i><span class="replica-set"><b>g1</b><b>g2</b><b>g3</b></span><i aria-hidden="true">→</i><span>A · B</span>
                </div>
              </article>
            </div>
            <article class="round-card round-crawler">
              <div class="round-meta"><span>03</span><strong>independent system design</strong></div>
              <h3>Design a polite distributed crawler</h3>
              <p>Turn seeds into durable work, schedule by authority and address, survive crashes, and keep untrusted destinations outside the crawler’s trust boundary.</p>
              <div class="mini-architecture crawler-mini" role="img" aria-label="Seeds enter a durable frontier, then fetchers retrieve pages and store documents while discovered links return to the frontier.">
                <span>seeds</span><i aria-hidden="true">→</i><strong>frontier</strong><i aria-hidden="true">→</i><span>fetch</span><i aria-hidden="true">→</i><span>store</span><em aria-hidden="true">↺ links</em>
              </div>
            </article>
          </div>
        </section>

        <section class="next-session" aria-labelledby="next-session-title">
          <div>
            <span class="eyebrow">Your next 25-minute block</span>
            <h2 id="next-session-title">${escapeHTML(nextRepLabel())}</h2>
            <p><strong>${escapeHTML(currentMode.label)}:</strong> ${escapeHTML(currentMode.description)}</p>
          </div>
          <div class="session-loop" aria-label="Recommended study loop">
            <span><b>1</b> predict</span><i aria-hidden="true">→</i><span><b>2</b> trace</span><i aria-hidden="true">→</i><span><b>3</b> decide</span><i aria-hidden="true">→</i><span><b>4</b> retrieve</span>
          </div>
          <button class="primary-button" type="button" data-route="${nextRoute()}">Continue</button>
        </section>

        <section class="study-format-strip" aria-labelledby="study-format-title">
          <div class="section-heading">
            <div><span class="eyebrow">Study format</span><h2 id="study-format-title">Choose the kind of work you need now</h2></div>
          </div>
          <div class="study-format-grid" role="group" aria-label="Choose how lesson pages are presented">
            <button type="button" data-mode-value="learn" aria-pressed="${state.mode === "learn"}"><strong>Guided</strong><span>Read the explanation, trace one example, work the numbers, then check your understanding.</span></button>
            <button type="button" data-mode-value="interview" aria-pressed="${state.mode === "interview"}"><strong>Interview drill</strong><span>See the prompt first. Answer aloud before opening the guide, diagram, and follow-up questions.</span></button>
            <button type="button" data-mode-value="reference" aria-pressed="${state.mode === "reference"}"><strong>Reference</strong><span>Review only the system diagram, decision table, key terms, and answer shape.</span></button>
          </div>
        </section>

        <section class="readiness-section" aria-labelledby="readiness-title">
          <div class="section-heading">
            <div><span class="eyebrow">Preparation plan</span><h2 id="readiness-title">Work one interview lane at a time</h2></div>
            <button class="quiet-button" type="button" data-route="notebook">Open interview notebook</button>
          </div>
          <div class="track-grid">
            ${course.tracks.map(renderTrackCard).join("")}
          </div>
        </section>

        <section class="home-experiment" aria-labelledby="experiment-title">
          <div class="section-heading">
            <div>
              <span class="eyebrow">Optional first experiment</span>
              <h2 id="experiment-title">Change one routing decision and read the evidence</h2>
              <p>The simulator is below the course orientation on purpose. Use it after you can state what success, p95, p99, and calls per request mean.</p>
            </div>
          </div>
          <div class="home-console-shell">${renderGatewayConsole("home", true)}</div>
        </section>

        <section class="module-map-section" aria-labelledby="map-title">
          <div class="section-heading"><div><span class="eyebrow">Full course map</span><h2 id="map-title">Open any module when you need it</h2></div></div>
          <div class="module-card-grid">${course.modules.map(renderModuleCard).join("")}</div>
        </section>
      </div>
    `;
  }

  function renderTrackCard(track) {
    const stats = trackStats(track.id);
    const next = stats.modules.find((module) => !moduleComplete(module));
    const mock = course.mocks.find((item) => item.track === track.id);
    const glyphs = { coding: "⌁", "gateway-design": "◇", "crawler-design": "↯" };
    return `
      <article class="track-card" style="--track-color:${escapeAttr(track.color)}">
        <div class="track-card-head">
          <span class="track-glyph" aria-hidden="true">${escapeHTML(glyphs[track.id] || "◎")}</span>
          <span class="status-pill status-${stats.status.toLowerCase().replaceAll(" ", "-")}">${stats.status}</span>
        </div>
        <h3>${escapeHTML(track.label)}</h3>
        <p>${escapeHTML(track.description)}</p>
        <dl class="readiness-record">
          <div><dt>Evidence checks</dt><dd>${stats.completed}/${stats.checkpoints}</dd></div>
          <div><dt>Mock score</dt><dd>${stats.mockScore ? `${stats.mockScore}%` : "Not scored"}</dd></div>
          <div><dt>Practice time</dt><dd>${mock ? `${mock.minutes} min` : "Self-paced"}</dd></div>
        </dl>
        <div class="mini-progress" aria-label="${stats.percent}% of track checkpoints complete"><span style="width:${stats.percent}%"></span></div>
        <button class="text-button" type="button" data-route="${next ? routeFor("module", next.id) : routeFor("mock", course.mocks.find((mock) => mock.track === track.id)?.id)}">
          ${next ? `Next: ${escapeHTML(next.shortTitle)}` : "Run the mock"} <span aria-hidden="true">→</span>
        </button>
      </article>
    `;
  }

  function renderModuleCard(module) {
    const progress = moduleProgress(module);
    return `
      <article class="module-card" style="--module-color:${module.color};--module-soft:${module.soft}">
        <div class="module-card-top"><span class="module-number">${escapeHTML(module.number)}</span><span class="module-track">${escapeHTML(moduleTrackLabel(module))}</span></div>
        <h3>${escapeHTML(module.title)}</h3>
        <p>${escapeHTML(module.description)}</p>
        <div class="module-card-meta"><span>${formatMinutes(module.duration)}</span><span>${module.lessons.length} lessons</span><span>${progress.percent}%</span></div>
        <button class="card-link" type="button" data-route="module/${module.id}" aria-label="Open ${escapeAttr(module.title)}">Open workbench <span aria-hidden="true">→</span></button>
      </article>
    `;
  }

  function renderModule(module) {
    const progress = moduleProgress(module);
    renderBreadcrumbs([{ label: "Control room", route: "home" }, { label: `Module ${module.number}` }]);
    view.innerHTML = `
      <div class="module-view" style="--module-color:${module.color};--module-soft:${module.soft}">
        <header class="module-hero">
          <div>
          <span class="eyebrow">${escapeHTML(moduleTrackLabel(module))} · ${formatMinutes(module.duration)}</span>
            <h1 id="module-title" tabindex="-1">${escapeHTML(module.title)}</h1>
            <p>${escapeHTML(module.description)}</p>
          </div>
          <div class="module-progress-card"><strong>${progress.percent}%</strong><span>${progress.complete} of ${progress.total} checks</span></div>
        </header>
        <section class="outcome-panel" aria-labelledby="outcomes-title">
          <span class="eyebrow">You should be able to</span>
          <h2 id="outcomes-title">Defend these decisions aloud</h2>
          <ul>${module.outcomes.map((outcome) => `<li>${escapeHTML(outcome)}</li>`).join("")}</ul>
        </section>
        ${renderSystemDesignMethod(module)}
        <section class="lesson-list" aria-labelledby="lessons-title">
          <div class="section-heading"><div><span class="eyebrow">Learn and retrieve</span><h2 id="lessons-title">Lessons</h2></div></div>
          ${module.lessons.map((lesson, index) => renderLessonRow(lesson, module, index)).join("")}
        </section>
        <section class="module-actions" aria-label="Module practice">
          <article class="action-card lab-action">
            <span class="action-index">LAB</span><div><h2>${escapeHTML(module.lab.title)}</h2><p>${escapeHTML(module.lab.intro)}</p></div>
            <button class="primary-button" type="button" data-route="lab/${module.id}">${state.completedLabs.includes(module.id) ? "Reopen lab" : "Open lab"}</button>
          </article>
          <article class="action-card quiz-action">
            <span class="action-index">TEST</span><div><h2>Scenario check</h2><p>Pass at 75%. Missed concepts stay available for another attempt.</p></div>
            <button class="secondary-button" type="button" data-route="quiz/${module.id}">${state.quizScores[module.id] ? `Retry · best ${state.quizScores[module.id]}%` : "Start test"}</button>
          </article>
        </section>
      </div>
    `;
  }

  function renderSystemDesignMethod(module) {
    const studioId = module.track === "gateway-design"
      ? "gateway"
      : module.track === "crawler-design"
        ? "crawler"
        : null;
    const studio = studioId ? systemDesignStudios[studioId] : null;
    if (!studio) return "";
    const phaseIds = studio.guidedModules[module.id] || [];
    if (!phaseIds.length) return "";
    const phases = studio.phases.filter((phase) => phaseIds.includes(phase.id));
    return `
      <section class="design-method-strip" aria-labelledby="design-method-${escapeAttr(module.id)}">
        <div>
          <span class="eyebrow">System-design operating loop</span>
          <h2 id="design-method-${escapeAttr(module.id)}">The board grows in interview order</h2>
          <p>Produce each artifact before comparing it with the worked design. The executable model then tests whether the capacity or failure claim holds.</p>
        </div>
        <ol>${phases.map((phase) => `<li><span>${escapeHTML(phase.number)}</span><strong>${escapeHTML(phase.short)}</strong><small>${escapeHTML(phase.minutes)}</small></li>`).join("")}</ol>
        <button class="secondary-button compact" type="button" data-route="lab/${escapeAttr(module.id)}">Open this part of the board</button>
      </section>
    `;
  }

  function renderLessonRow(lesson, module, index) {
    const complete = state.completedLessons.includes(lesson.id);
    return `
      <button class="lesson-row" type="button" data-route="lesson/${lesson.id}">
        <span class="lesson-state ${complete ? "complete" : ""}" aria-label="${complete ? "Complete" : "Not complete"}">${complete ? "✓" : String(index + 1).padStart(2, "0")}</span>
        <span class="lesson-row-copy"><strong>${escapeHTML(lesson.title)}</strong><small>${escapeHTML(lesson.summary)}</small></span>
        <span class="lesson-duration">${formatMinutes(lesson.duration)}</span>
        <span aria-hidden="true">→</span>
      </button>
    `;
  }

  function renderLesson(lesson, module) {
    const position = module.lessons.findIndex((entry) => entry.id === lesson.id);
    const nextLesson = module.lessons[position + 1];
    const complete = state.completedLessons.includes(lesson.id);
    const guide = normalizeLessonGuide(lesson);
    const currentMode = modeCopy[state.mode] || modeCopy.learn;
    renderBreadcrumbs([
      { label: "Control room", route: "home" },
      { label: `Module ${module.number}`, route: `module/${module.id}` },
      { label: lesson.title }
    ]);

    view.innerHTML = `
      <article class="lesson-view lesson-mode-${escapeAttr(state.mode)}" style="--module-color:${module.color};--module-soft:${module.soft}">
        <header class="lesson-header">
          <div class="lesson-meta-row">
            <span class="eyebrow">Lesson ${escapeHTML(lesson.number)} · ${formatMinutes(lesson.duration)}</span>
            <span class="lesson-mode-chip">${escapeHTML(currentMode.label)}</span>
          </div>
          <h1 id="lesson-title" tabindex="-1">${escapeHTML(lesson.title)}</h1>
          <p class="lesson-summary">${escapeHTML(lesson.summary)}</p>
          ${state.mode === "learn" ? `<div class="prediction-card"><span>Commit to a prediction</span><p>${escapeHTML(lesson.prediction)}</p><small>You do not need to be right. The prediction gives the walkthrough something concrete to correct.</small></div>` : ""}
        </header>
        <div class="lesson-body">${state.mode === "interview"
          ? renderInterviewLessonBody(lesson, guide, module, complete)
          : state.mode === "reference"
            ? renderReferenceLessonBody(lesson, guide, module)
            : renderGuidedLessonBody(lesson, guide, module, complete)}
        </div>
        <footer class="lesson-footer">
          <button class="secondary-button" type="button" data-route="module/${module.id}">Module overview</button>
          ${nextLesson ? `<button class="primary-button" type="button" data-route="lesson/${nextLesson.id}">Next: ${escapeHTML(nextLesson.title)}</button>` : `<button class="primary-button" type="button" data-route="lab/${module.id}">Apply this module in the lab</button>`}
        </footer>
      </article>
    `;
  }

  function normalizeLessonGuide(lesson) {
    const guide = guides[lesson.id];
    if (guide) return guide;
    return {
      contextTitle: "Why this decision exists",
      context: lesson.core,
      walkthrough: {
        title: lesson.visual?.title || "Follow one request",
        intro: "Keep one request in view while each boundary changes its state.",
        steps: (lesson.visual?.nodes || []).map(([title, text]) => ({ title, text })),
        takeaway: lesson.summary
      },
      workedExample: null,
      explanations: [{ title: "Implementation details", paragraphs: lesson.deep }],
      decisionTable: {
        title: "Terms to keep separate",
        columns: ["Concept", "What it controls"],
        rows: lesson.mechanics.map((item) => [item.title, item.text])
      },
      diagram: {
        type: "timeline",
        title: lesson.visual?.title || "System trace",
        caption: "Read the trace from left to right, then identify which component owns each transition.",
        events: (lesson.visual?.nodes || []).map(([label, note]) => ({ label, note }))
      },
      interview: {
        prompt: lesson.prediction,
        answerPoints: lesson.core,
        followups: [lesson.failure.text]
      }
    };
  }

  function renderGuidedLessonBody(lesson, guide, module, complete) {
    return `
      <section class="narrative-chapter" aria-labelledby="context-${escapeAttr(lesson.id)}">
        <div class="chapter-number" aria-hidden="true">01</div>
        <div class="chapter-copy">
          <span class="eyebrow">Build the mental model</span>
          <h2 id="context-${escapeAttr(lesson.id)}">${escapeHTML(guide.contextTitle)}</h2>
          ${guide.context.map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`).join("")}
        </div>
      </section>
      ${renderWalkthrough(guide.walkthrough, "02")}
      ${renderGuideDiagram(guide.diagram, module)}
      ${renderWorkedExample(guide.workedExample, "03")}
      ${renderExplanations(guide.explanations)}
      ${renderDecisionTable(guide.decisionTable)}
      ${renderTermList(lesson.mechanics)}
      <details class="deep-section implementation-notes">
        <summary><span>Implementation notes</span><small>code boundaries and edge cases</small></summary>
        <div>${lesson.deep.map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`).join("")}</div>
      </details>
      <aside class="failure-story">
        <span class="eyebrow">Run the failure forward</span>
        <h2>${escapeHTML(lesson.failure.title)}</h2>
        <p>${escapeHTML(lesson.failure.text)}</p>
      </aside>
      ${renderInterviewTransfer(lesson, guide.interview)}
      ${renderQuickCheck(lesson, complete)}
      ${renderSources(lesson)}
    `;
  }

  function renderInterviewLessonBody(lesson, guide, module, complete) {
    return `
      <section class="drill-brief" aria-labelledby="drill-${escapeAttr(lesson.id)}">
        <span class="eyebrow">Closed-note drill</span>
        <h2 id="drill-${escapeAttr(lesson.id)}">Answer before you reveal the guide</h2>
        <blockquote>${escapeHTML(guide.interview.prompt)}</blockquote>
        <ol>
          <li>State the contract or invariant before naming a component.</li>
          <li>Draw the normal request path and mark who owns each piece of state.</li>
          <li>Inject one failure, then explain what remains available.</li>
          <li>Name the metric or test that would disprove your design.</li>
        </ol>
      </section>
      <details class="answer-reveal">
        <summary><span>Reveal the answer guide</span><small>Open only after answering aloud</small></summary>
        <div class="answer-reveal-body">
          <section>
            <h2>A strong answer covers these points</h2>
            <ol>${guide.interview.answerPoints.map((point) => `<li>${escapeHTML(point)}</li>`).join("")}</ol>
          </section>
          ${renderGuideDiagram(guide.diagram, module)}
          ${renderDecisionTable(guide.decisionTable)}
          <section class="followup-list">
            <h2>Expect these follow-ups</h2>
            <ul>${guide.interview.followups.map((followup) => `<li>${escapeHTML(followup)}</li>`).join("")}</ul>
          </section>
          <aside class="failure-story compact">
            <span class="eyebrow">Failure boundary</span>
            <h2>${escapeHTML(lesson.failure.title)}</h2>
            <p>${escapeHTML(lesson.failure.text)}</p>
          </aside>
        </div>
      </details>
      ${renderQuickCheck(lesson, complete)}
      ${renderSources(lesson)}
    `;
  }

  function renderReferenceLessonBody(lesson, guide, module) {
    return `
      <section class="reference-intro">
        <span class="eyebrow">Reference sheet</span>
        <h2>${escapeHTML(guide.contextTitle)}</h2>
        <p>${escapeHTML(guide.context[0] || lesson.summary)}</p>
      </section>
      ${renderGuideDiagram(guide.diagram, module)}
      ${renderWorkedExample(guide.workedExample, "Worked case")}
      ${renderDecisionTable(guide.decisionTable)}
      ${renderTermList(lesson.mechanics)}
      <section class="reference-answer">
        <h2>Answer shape</h2>
        <ol>${guide.interview.answerPoints.map((point) => `<li>${escapeHTML(point)}</li>`).join("")}</ol>
      </section>
      <aside class="failure-story compact">
        <span class="eyebrow">Failure boundary</span>
        <h2>${escapeHTML(lesson.failure.title)}</h2>
        <p>${escapeHTML(lesson.failure.text)}</p>
      </aside>
      ${renderSources(lesson)}
    `;
  }

  function renderWalkthrough(walkthrough, number) {
    if (!walkthrough?.steps?.length) return "";
    return `
      <section class="walkthrough-section" aria-labelledby="walkthrough-title">
        <div class="chapter-number" aria-hidden="true">${escapeHTML(number)}</div>
        <div class="chapter-copy">
          <span class="eyebrow">Follow one concrete case</span>
          <h2 id="walkthrough-title">${escapeHTML(walkthrough.title)}</h2>
          <p class="chapter-intro">${escapeHTML(walkthrough.intro)}</p>
          <ol class="walkthrough-steps">
            ${walkthrough.steps.map((step, index) => `<li><span>${index + 1}</span><div><h3>${escapeHTML(step.title)}</h3><p>${escapeHTML(step.text)}</p></div></li>`).join("")}
          </ol>
          ${walkthrough.takeaway ? `<p class="walkthrough-takeaway"><strong>What changed:</strong> ${escapeHTML(walkthrough.takeaway)}</p>` : ""}
        </div>
      </section>
    `;
  }

  function renderWorkedExample(example, number) {
    if (!example) return "";
    return `
      <section class="worked-example" aria-labelledby="worked-example-title">
        <div class="chapter-number" aria-hidden="true">${escapeHTML(number)}</div>
        <div class="chapter-copy">
          <span class="eyebrow">Work the numbers and state</span>
          <h2 id="worked-example-title">${escapeHTML(example.title)}</h2>
          <p>${escapeHTML(example.setup)}</p>
          ${example.facts?.length ? `<dl class="example-facts">${example.facts.map((fact) => `<div><dt>${escapeHTML(fact.label)}</dt><dd>${escapeHTML(fact.value)}</dd></div>`).join("")}</dl>` : ""}
          <ol class="example-steps">${(example.steps || []).map((step) => typeof step === "string" ? `<li>${escapeHTML(step)}</li>` : `<li><strong>${escapeHTML(step.title)}</strong><span>${escapeHTML(step.text)}</span></li>`).join("")}</ol>
          <p class="example-result"><strong>Result:</strong> ${escapeHTML(example.result)}</p>
        </div>
      </section>
    `;
  }

  function renderExplanations(explanations = []) {
    return explanations.map((section) => `
      <section class="explanation-section">
        <h2>${escapeHTML(section.title)}</h2>
        ${section.paragraphs.map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`).join("")}
      </section>
    `).join("");
  }

  function renderDecisionTable(table) {
    if (!table?.rows?.length) return "";
    return `
      <section class="decision-table" aria-labelledby="decision-table-title">
        <div class="section-heading"><div><span class="eyebrow">Decision guide</span><h2 id="decision-table-title">${escapeHTML(table.title)}</h2></div></div>
        <div class="table-scroll"><table><thead><tr>${table.columns.map((column) => `<th>${escapeHTML(column)}</th>`).join("")}</tr></thead><tbody>${table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeHTML(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      </section>
    `;
  }

  function renderTermList(items = []) {
    if (!items.length) return "";
    return `
      <section class="term-list" aria-labelledby="term-list-title">
        <span class="eyebrow">Keep these boundaries separate</span>
        <h2 id="term-list-title">Terms in the design</h2>
        <dl>${items.map((item) => `<div><dt>${escapeHTML(item.title)}</dt><dd>${escapeHTML(item.text)}</dd></div>`).join("")}</dl>
      </section>
    `;
  }

  function renderGuideDiagram(diagram, module) {
    if (!diagram) return "";
    let body = "";
    if (diagram.type === "swimlane") {
      body = `<div class="diagram-swimlanes">${diagram.lanes.map((lane) => `<section><h3>${escapeHTML(lane.label)}</h3><ol>${lane.items.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ol></section>`).join("")}</div>`;
    } else if (diagram.type === "branch") {
      body = `<div class="diagram-branch"><div class="diagram-anchor">${escapeHTML(diagram.source)}</div><span aria-hidden="true">→</span><div class="diagram-branches">${diagram.branches.map((branch) => `<div><strong>${escapeHTML(branch.label)}</strong><small>${escapeHTML(branch.note)}</small></div>`).join("")}</div>${diagram.destination ? `<span aria-hidden="true">→</span><div class="diagram-anchor">${escapeHTML(diagram.destination)}</div>` : ""}</div>`;
    } else if (diagram.type === "state-machine") {
      body = `<p class="state-machine-guide">These are states, not a one-way pipeline. Follow the event-labeled transitions below, including the return paths.</p><div class="diagram-states">${diagram.states.map((state, index) => `<div><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHTML(state.label)}</strong><small>${escapeHTML(state.note)}</small></div>`).join("")}</div>${diagram.transitions?.length ? `<div class="transition-map"><strong>Transition map</strong><ol class="diagram-transitions">${diagram.transitions.map((transition, index) => `<li><span>T${index + 1}</span><p>${escapeHTML(transition).replaceAll("-&gt;", '<b aria-hidden="true">→</b><span class="sr-only"> to </span>')}</p></li>`).join("")}</ol></div>` : ""}`;
    } else {
      const events = diagram.events || [];
      body = `<ol class="diagram-timeline">${events.map((event, index) => `<li><span>${index + 1}</span><div><strong>${escapeHTML(event.label)}</strong><small>${escapeHTML(event.note)}</small></div></li>`).join("")}</ol>`;
    }
    return `
      <figure class="teaching-diagram diagram-${escapeAttr(diagram.type || "timeline")}" style="--module-color:${module.color}">
        <figcaption><span class="eyebrow">System model</span><strong>${escapeHTML(diagram.title)}</strong><p>${escapeHTML(diagram.caption || "")}</p></figcaption>
        ${body}
      </figure>
    `;
  }

  function renderInterviewTransfer(lesson, interview) {
    return `
      <section class="interview-transfer" aria-labelledby="interview-transfer-title">
        <span class="eyebrow">Translate it to the interview</span>
        <h2 id="interview-transfer-title">${escapeHTML(lesson.bridge.title)}</h2>
        <p>${escapeHTML(lesson.bridge.text)}</p>
        <details><summary>Answer outline</summary><ol>${interview.answerPoints.map((point) => `<li>${escapeHTML(point)}</li>`).join("")}</ol></details>
      </section>
    `;
  }

  function renderSources(lesson) {
    return `
      <section class="sources-section" aria-labelledby="sources-${escapeAttr(lesson.id)}">
        <span class="eyebrow">Primary sources</span>
        <h2 id="sources-${escapeAttr(lesson.id)}">Check the contract behind the lesson</h2>
        <ul>${lesson.sources.map(([label, url]) => `<li><a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHTML(label)} <span aria-hidden="true">↗</span></a></li>`).join("")}</ul>
      </section>
    `;
  }

  function renderLessonVisual(visual, module) {
    if (!visual?.nodes?.length) return "";
    return `
      <figure class="lesson-visual visual-${escapeAttr(visual.type || "flow")}" style="--module-color:${module.color}">
        <figcaption><span class="eyebrow">System trace</span><strong>${escapeHTML(visual.title)}</strong></figcaption>
        <div class="visual-flow">
          ${visual.nodes.map(([label, note], index) => `
            ${index ? '<span class="flow-arrow" aria-hidden="true">→</span>' : ""}
            <div class="flow-node"><strong>${escapeHTML(label)}</strong><span>${escapeHTML(note)}</span></div>
          `).join("")}
        </div>
      </figure>
    `;
  }

  function renderQuickCheck(lesson, complete) {
    return `
      <section class="quick-check" data-check-id="${escapeAttr(lesson.id)}" aria-labelledby="check-${escapeAttr(lesson.id)}">
        <div class="check-heading"><span class="eyebrow">Retrieval check</span><span class="completion-chip ${complete ? "complete" : ""}">${complete ? "Recorded" : "Answer to complete"}</span></div>
        <h2 id="check-${escapeAttr(lesson.id)}">${escapeHTML(lesson.check.question)}</h2>
        <div class="choice-grid">
          ${lesson.check.choices.map((choice, index) => `<button class="choice-button" type="button" data-check-answer="${index}">${escapeHTML(choice)}</button>`).join("")}
        </div>
        <div class="check-feedback" role="status" aria-live="polite" tabindex="-1" hidden></div>
      </section>
    `;
  }

  function renderDrawer(route) {
    if (!drawer) return;
    const latest = state.benchmarks[0];
    const tracks = course.tracks.map((track) => ({ track, stats: trackStats(track.id) }));
    drawer.innerHTML = `
      <div class="drawer-sticky">
        <section class="drawer-section">
          <span class="eyebrow">Interview readiness</span>
          <h2>Three separate signals</h2>
          <div class="drawer-readiness">
            ${tracks.map(({ track, stats }) => `<button type="button" data-route="${stats.modules[0] ? `module/${stats.modules[0].id}` : "home"}"><span class="drawer-dot" style="--dot:${track.color}"></span><span><strong>${escapeHTML(track.shortLabel || track.label)}</strong><small>${stats.status}</small></span><b>${stats.percent}%</b></button>`).join("")}
          </div>
        </section>
        <section class="drawer-section">
          <span class="eyebrow">Next rep</span>
          <h2>${escapeHTML(nextRepLabel())}</h2>
          <button class="primary-button compact" type="button" data-route="${nextRoute()}">Continue</button>
        </section>
        <section class="drawer-section">
          <div class="drawer-title-row"><span class="eyebrow">Benchmark notebook</span><button class="text-button" type="button" data-route="notebook">Open</button></div>
          ${latest ? `
            <div class="latest-run"><strong>${escapeHTML(latest.policyLabel || latest.config?.policy || "Saved run")}</strong><span>${latest.metrics.successRate}% success · successful-request p95 ${latest.metrics.successP95 ?? latest.metrics.p95} ms</span><small>${escapeHTML(latest.fingerprint || "")}</small></div>
          ` : `<p class="drawer-empty">Run the gateway lab and save a comparison.</p>`}
        </section>
        <section class="drawer-section interview-cue">
          <span class="eyebrow">Say this first</span>
          <p>“I’ll confirm the contract and failure semantics, choose the metrics, build a baseline, then change one control at a time.”</p>
        </section>
      </div>
    `;
  }

  function nextRepLabel() {
    const route = nextRoute();
    const [type, id] = route.split("/");
    if (type === "lesson") return lessonById.get(id)?.lesson.title || "Continue learning";
    if (type === "lab") return moduleById.get(id)?.lab.title || "Open a lab";
    if (type === "quiz") return `${moduleById.get(id)?.shortTitle || "Module"} scenario check`;
    if (type === "mock") return mockById.get(id)?.title || "Run a mock";
    return "Review the control room";
  }

  function renderRoute() {
    stopTimer(false);
    announce("");
    const route = parseRoute();
    let activeModuleId = null;

    if (route.type === "home") renderHome();
    else if (route.type === "module" && moduleById.has(route.id)) {
      activeModuleId = route.id;
      renderModule(moduleById.get(route.id));
    } else if (route.type === "lesson" && lessonById.has(route.id)) {
      const entry = lessonById.get(route.id);
      activeModuleId = entry.module.id;
      renderLesson(entry.lesson, entry.module);
    } else if (route.type === "lab" && moduleById.has(route.id)) {
      activeModuleId = route.id;
      renderLab(moduleById.get(route.id));
    } else if (route.type === "quiz" && moduleById.has(route.id)) {
      activeModuleId = route.id;
      renderQuiz(moduleById.get(route.id));
    } else if (route.type === "mock" && mockById.has(route.id)) {
      renderMock(mockById.get(route.id));
    } else if (route.type === "notebook") renderNotebook();
    else {
      renderNotFound();
    }

    state.lastRoute = currentRoute();
    saveState();
    renderNav(activeModuleId);
    updateProgress();
    renderDrawer(route);
    updateModePicker();
    const heading = view.querySelector("h1");
    if (heading) {
      heading.setAttribute("tabindex", "-1");
      requestAnimationFrame(() => heading.focus({ preventScroll: true }));
    }
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function renderNotFound() {
    renderBreadcrumbs([{ label: "Not found" }]);
    view.innerHTML = `<section class="empty-state"><span class="eyebrow">Route not found</span><h1>That workbench is not here.</h1><p>Return to the interview control room and choose a course lane.</p><button class="primary-button" type="button" data-route="home">Go home</button></section>`;
  }

  function defaultGatewayConfig() {
    return {
      scenario: "flaky-fast",
      policy: "adaptive",
      requests: 120,
      rps: 24,
      gatewayCap: 32,
      queueCap: 24,
      providerCapA: 12,
      providerCapB: 12,
      deadlineMs: 900,
      hedgeMs: 180,
      explorationPct: 10,
      seed: 42
    };
  }

  function gatewayConfigFromDOM(scope) {
    const root = document.querySelector(`[data-gateway-scope="${CSS.escape(scope)}"]`);
    if (!root) return defaultGatewayConfig();
    const read = (name, fallback) => {
      const element = root.querySelector(`[name="${CSS.escape(name)}"]`);
      return element ? element.value : fallback;
    };
    return {
      scenario: read("scenario", "flaky-fast"),
      policy: read("policy", "adaptive"),
      requests: Number(read("requests", 120)),
      rps: Number(read("rps", 24)),
      gatewayCap: Number(read("gatewayCap", 32)),
      queueCap: Number(read("queueCap", 24)),
      providerCapA: Number(read("providerCapA", 12)),
      providerCapB: Number(read("providerCapB", 12)),
      deadlineMs: Number(read("deadlineMs", 900)),
      hedgeMs: Number(read("hedgeMs", 180)),
      explorationPct: Number(read("explorationPct", 10)),
      seed: Number(read("seed", 42))
    };
  }

  function gatewayHypothesisFromDOM(scope) {
    const root = document.querySelector(`[data-gateway-scope="${CSS.escape(scope)}"]`);
    return root?.querySelector('[name="hypothesis"]')?.value.trim() || "";
  }

  function gatewayInterpretationFromDOM(scope) {
    const root = document.querySelector(`[data-gateway-scope="${CSS.escape(scope)}"]`);
    return root?.querySelector('[name="interpretation"]')?.value.trim() || "";
  }

  function changedGatewayFields(left, right) {
    const ignored = new Set(["scenario", "seed"]);
    const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
    return [...keys].filter((key) => !ignored.has(key) && left?.[key] !== right?.[key]);
  }

  function gatewayMetricsChanged(left, right) {
    const fields = ["successRate", "successP95", "successP99", "terminalP95", "achievedRps", "attemptsPerRequest", "queueP95", "dropped", "retries", "hedges"];
    return fields.some((field) => Number(left?.metrics?.[field] || 0) !== Number(right?.metrics?.[field] || 0));
  }

  function changedModelFields(left, right) {
    const keys = new Set([...Object.keys(left || {}), ...Object.keys(right || {})]);
    return [...keys].filter((key) => JSON.stringify(left?.[key]) !== JSON.stringify(right?.[key]));
  }

  function modelOutcomeChanged(baseline, candidate) {
    const outcome = (run) => Object.fromEntries(
      Object.entries(run || {}).filter(([key]) => !["config", "controls", "evidence", "modelVersion", "modelAssumptions"].includes(key))
    );
    return JSON.stringify(outcome(baseline)) !== JSON.stringify(outcome(candidate));
  }

  function gatewayModuleFromScope(scope) {
    return scope.startsWith("lab-") ? scope.slice(4) : null;
  }

  function gatewayComparisonEvidence(moduleId, savedAfter = null, savedBefore = null, attemptId = null) {
    const allowedChanges = {
      "adaptive-routing": new Set(["policy", "explorationPct", "hedgeMs"]),
      "concurrency-resilience": new Set(["rps", "gatewayCap", "queueCap", "providerCapA", "providerCapB", "deadlineMs", "hedgeMs"])
    };
    const cutoff = savedAfter ? new Date(savedAfter).getTime() : 0;
    const ceiling = savedBefore ? new Date(savedBefore).getTime() : Number.POSITIVE_INFINITY;
    const candidates = state.benchmarks.filter((run) => (
      run.moduleId === moduleId
      && (!cutoff || new Date(run.savedAt || 0).getTime() >= cutoff)
      && new Date(run.savedAt || 0).getTime() <= ceiling
      && (!attemptId || run.attemptId === attemptId)
    ));
    for (let first = 0; first < candidates.length; first += 1) {
      for (let second = first + 1; second < candidates.length; second += 1) {
        const a = candidates[first];
        const b = candidates[second];
        if (a.config?.scenario !== b.config?.scenario || a.config?.seed !== b.config?.seed) continue;
        const changed = changedGatewayFields(a.config, b.config);
        if (changed.length !== 1) continue;
        if (!allowedChanges[moduleId]?.has(changed[0])) continue;
        if (!gatewayMetricsChanged(a, b)) continue;
        if (String(a.hypothesis || "").length < 20 || String(b.hypothesis || "").length < 20) continue;
        if (String(a.note || "").length < 40 || String(b.note || "").length < 40) continue;
        return { baseline: b, candidate: a, changed };
      }
    }
    return null;
  }

  function renderGatewayConsole(scope, compact = false) {
    if (!activeGatewayRun || activeGatewayRun.evidence?.scope !== scope) {
      activeGatewayRun = Sim.runGateway(defaultGatewayConfig());
      activeGatewayRun.evidence = {
        scope,
        moduleId: gatewayModuleFromScope(scope),
        ranByStudent: false,
        hypothesis: "",
        configFingerprint: Sim.stableFingerprint(activeGatewayRun.config)
      };
    }
    const run = activeGatewayRun;
    const config = run.config || defaultGatewayConfig();
    const scenarios = Object.entries(gatewayScenarioLabels);
    const policies = Object.entries(gatewayPolicyLabels);
    const moduleId = gatewayModuleFromScope(scope);
    const experimentRule = moduleId === "adaptive-routing"
      ? "Keep the scenario and seed fixed. Change exactly one of: routing policy, explore percentage, or hedge delay."
      : moduleId === "concurrency-resilience"
        ? "Keep the scenario and seed fixed. Change exactly one of: offered RPS, gateway cap, queue cap, provider cap, deadline, or hedge delay."
        : "";

    return `
      <section class="gateway-console ${compact ? "compact" : ""}" data-gateway-scope="${escapeAttr(scope)}" aria-labelledby="gateway-${escapeAttr(scope)}-title">
        <div class="console-title-row">
          <div><span class="eyebrow">Live provider race</span><h2 id="gateway-${escapeAttr(scope)}-title">One model, two changing providers</h2></div>
          <span class="seed-chip">seed ${config.seed}</span>
        </div>
        <div class="gateway-layout">
          <form class="sim-controls" data-gateway-controls>
            <label>Scenario<select name="scenario">${scenarios.map(([value, label]) => `<option value="${value}" ${config.scenario === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
            <label>Routing policy<select name="policy">${policies.map(([value, label]) => `<option value="${value}" ${config.policy === value ? "selected" : ""}>${label}</option>`).join("")}</select></label>
            ${compact ? "" : `
              <div class="control-pair">
                ${numberControl("Offered RPS", "rps", config.rps, 1, 200)}
                ${numberControl("Requests", "requests", config.requests, 20, 500)}
              </div>
              <div class="control-pair">
                ${numberControl("Gateway cap", "gatewayCap", config.gatewayCap, 1, 200)}
                ${numberControl("Queue cap", "queueCap", config.queueCap, 0, 500)}
              </div>
              <div class="control-pair">
                ${numberControl("Provider A cap", "providerCapA", config.providerCapA, 1, 100)}
                ${numberControl("Provider B cap", "providerCapB", config.providerCapB, 1, 100)}
              </div>
              <div class="control-pair">
                ${numberControl("Deadline ms", "deadlineMs", config.deadlineMs, 50, 5000)}
                ${numberControl("Hedge after ms", "hedgeMs", config.hedgeMs, 0, 3000)}
              </div>
              <div class="control-pair">
                ${numberControl("Explore %", "explorationPct", config.explorationPct, 0, 100)}
                ${numberControl("Seed", "seed", config.seed, 1, 99999)}
              </div>
              <label class="benchmark-hypothesis"><span>Hypothesis before the run</span><textarea name="hypothesis" placeholder="If I change one control, I expect success, tail latency, or attempt cost to change because…"></textarea></label>
              <label class="benchmark-interpretation"><span>Interpretation after the run</span><textarea name="interpretation" placeholder="Did the result support the hypothesis? Name the metric change, attempt cost, and decision."></textarea></label>
              ${experimentRule ? `<p class="experiment-constraint"><strong>Evidence rule:</strong> ${escapeHTML(experimentRule)}</p>` : ""}
            `}
            <div class="sim-actions">
              <button class="primary-button compact" type="button" data-run-gateway="${escapeAttr(scope)}">Run batch</button>
              ${compact ? `<button class="text-button" type="button" data-route="lab/adaptive-routing">Open full lab</button>` : `<button class="secondary-button compact" type="button" data-save-benchmark>Save result</button>`}
            </div>
            ${compact ? "" : `<p class="run-evidence-status" data-run-evidence-status>${run.evidence?.ranByStudent ? "This result matches the controls and pre-run hypothesis." : "Write a hypothesis, then run the batch before saving evidence."}</p>`}
          </form>
          <div class="sim-output" data-gateway-output>${renderGatewayResult(run, compact)}</div>
        </div>
      </section>
    `;
  }

  function numberControl(label, name, value, min, max, step) {
    const resolvedStep = step || (Number.isInteger(Number(value)) ? 1 : 0.01);
    return `<label>${escapeHTML(label)}<input type="number" name="${escapeAttr(name)}" value="${escapeAttr(value)}" min="${min}" max="${max}" step="${escapeAttr(resolvedStep)}" inputmode="decimal"></label>`;
  }

  function renderGatewayResult(run, compact = false) {
    const metrics = run.metrics || {};
    const rows = representativeRows(run.requests || run.rows || [], compact ? 6 : 18);
    const providers = run.providers || {};
    const deadlineMs = Math.max(1, Number(run.config?.deadlineMs || 1000));
    const warnings = Array.isArray(run.warnings) ? run.warnings : [];

    return `
      <div class="metric-strip" aria-label="Gateway batch summary">
        ${metric("Success", `${valueOr(metrics.successRate, 0)}%`)}
        ${metric("Success p50", `${valueOr(metrics.successP50, metrics.p50 || 0)} ms`)}
        ${metric("Success p95", `${valueOr(metrics.successP95, metrics.p95 || 0)} ms`)}
        ${metric("Achieved RPS", valueOr(metrics.achievedRps, 0))}
        ${metric("Calls/logical request", valueOr(metrics.attemptsPerRequest, 0))}
        ${metric("Peak active / cap", `${valueOr(metrics.maxActive, 0)} / ${valueOr(run.config?.gatewayCap, 0)}`)}
        ${metric("Peak queued / cap", `${valueOr(metrics.maxQueueDepth, 0)} / ${valueOr(run.config?.queueCap, 0)}`)}
      </div>
      <div class="provider-state-row">
        ${renderProviderState("A", providers.A || providers.a)}
        ${renderProviderState("B", providers.B || providers.b)}
      </div>
      ${renderProviderTransitions(providers)}
      ${renderGatewayWindows(run.windows || [])}
      <div class="request-waterfall" aria-label="Sample request waterfall">
        <div class="waterfall-axis"><span>arrival</span><span>deadline</span></div>
        ${rows.length ? rows.map((row, index) => renderRequestRow(row, index, deadlineMs)).join("") : `<p class="empty-inline">Run a batch to draw request attempts.</p>`}
      </div>
      <details class="sim-table-details" ${compact ? "" : "open"}>
        <summary>Text result table</summary>
        <div class="table-scroll"><table><thead><tr><th>Metric</th><th>Value</th><th>What it tests</th></tr></thead><tbody>
          <tr><td>Success rate</td><td>${valueOr(metrics.successRate, 0)}%</td><td>End-user result before the deadline</td></tr>
          <tr><td>Successful-request p99</td><td>${valueOr(metrics.successP99, metrics.p99 || 0)} ms</td><td>Tail latency among successful logical requests only</td></tr>
          <tr><td>Terminal p95</td><td>${valueOr(metrics.terminalP95, 0)} ms</td><td>Time to any terminal result, including failures and immediate shedding</td></tr>
          <tr><td>Offered / achieved RPS</td><td>${valueOr(metrics.offeredRps, run.config?.rps || 0)} / ${valueOr(metrics.achievedRps, 0)}</td><td>Demand compared with successful results per simulated second</td></tr>
          <tr><td>Queue p95</td><td>${valueOr(metrics.queueP95, 0)} ms</td><td>Admission pressure hidden by provider latency</td></tr>
          <tr><td>Dropped</td><td>${valueOr(metrics.dropped, 0)}</td><td>Bounded overload behavior</td></tr>
          <tr><td>Retries</td><td>${valueOr(metrics.retries, 0)}</td><td>Post-failure extra attempts</td></tr>
          <tr><td>Hedges</td><td>${valueOr(metrics.hedges, 0)}</td><td>Pre-failure extra attempts</td></tr>
        </tbody></table></div>
      </details>
      ${warnings.length ? `<div class="sim-warnings" role="note">${warnings.map((warning) => `<p><span aria-hidden="true">!</span>${escapeHTML(warning)}</p>`).join("")}</div>` : ""}
    `;
  }

  function representativeRows(rows, limit) {
    if (rows.length <= limit) return rows;
    const indexes = new Set([0, rows.length - 1]);
    for (let sample = 0; sample < limit; sample += 1) {
      indexes.add(Math.round((sample / Math.max(1, limit - 1)) * (rows.length - 1)));
    }
    return [...indexes].sort((left, right) => left - right).slice(0, limit).map((index) => rows[index]);
  }

  function renderGatewayWindows(windows) {
    if (!windows.length) return "";
    return `<details class="gateway-phase-evidence" ${windows.some((window) => window.dropped > 0) ? "open" : ""}><summary>Phase evidence across the full run</summary><div class="table-scroll"><table><thead><tr><th>Window</th><th>Requests</th><th>Success</th><th>Success p95</th><th>A / B share</th><th>Peak active</th><th>Peak queued</th><th>Dropped</th></tr></thead><tbody>${windows.map((window) => `<tr><td>${escapeHTML(window.label)}</td><td>${valueOr(window.requestStart, 0)}–${valueOr(window.requestEnd, 0)}</td><td>${valueOr(window.successRate, 0)}%</td><td>${valueOr(window.successP95, 0)} ms</td><td>${valueOr(window.providerShareA, 0)}% / ${valueOr(window.providerShareB, 0)}%</td><td>${valueOr(window.maxActive, 0)}</td><td>${valueOr(window.maxQueued, 0)}</td><td>${valueOr(window.dropped, 0)}</td></tr>`).join("")}</tbody></table></div></details>`;
  }

  function valueOr(value, fallback) {
    return value === undefined || value === null || Number.isNaN(value) ? fallback : value;
  }

  function metric(label, value) {
    return `<div><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`;
  }

  function renderProviderState(label, provider = {}) {
    return `
      <article class="provider-state provider-${label.toLowerCase()}">
        <div><span class="provider-symbol" aria-hidden="true">${label === "A" ? "▲" : "●"}</span><strong>Provider ${label}</strong></div>
        <dl><div><dt>State</dt><dd>${escapeHTML(provider.state || "closed")}</dd></div><div><dt>Share</dt><dd>${valueOr(provider.share, provider.sharePct || 0)}%</dd></div><div><dt>EWMA</dt><dd>${Math.round(valueOr(provider.latencyEWMA, provider.ewmaLatency || 0))} ms</dd></div><div><dt>Peak / cap</dt><dd>${valueOr(provider.maxInFlight, 0)} / ${valueOr(provider.cap, 0)}</dd></div></dl>
      </article>
    `;
  }

  function renderProviderTransitions(providers) {
    const events = ["A", "B"].flatMap((providerName) => {
      const provider = providers[providerName] || providers[providerName.toLowerCase()] || {};
      return (provider.transitions || []).map((event) => ({ ...event, providerName }));
    }).sort((left, right) => left.atMs - right.atMs).slice(-10);
    if (!events.length) return `<p class="breaker-trace-empty">No circuit transition occurred in this batch. Choose a failure-heavy scenario or raise the request count to exercise cooldown and recovery.</p>`;
    return `<section class="breaker-trace" aria-label="Provider circuit transitions"><span>Circuit transitions</span><div>${events.map((event) => `<article><strong>${escapeHTML(event.providerName)} · ${escapeHTML(event.state)}</strong><small>${Math.round(event.atMs)} ms</small><p>${escapeHTML(event.reason || "State changed.")}</p></article>`).join("")}</div></section>`;
  }

  function renderRequestRow(row, index, deadlineMs) {
    const attempts = row.attempts || [];
    const status = row.status || row.outcome || "unknown";
    return `
      <div class="waterfall-row">
        <span class="request-label">r${String(row.id ?? index + 1).padStart(2, "0")}</span>
        <div class="request-track">
          ${attempts.map((attempt) => {
            const start = Number(attempt.startMs ?? attempt.start ?? row.arrivalMs ?? 0);
            const end = Number(attempt.endMs ?? attempt.end ?? (start + Number(attempt.latencyMs || 1)));
            const arrival = Number(row.arrivalMs || 0);
            const left = Math.min(96, Math.max(0, ((start - arrival) / deadlineMs) * 100));
            const width = Math.max(2, ((end - start) / deadlineMs) * 100);
            const provider = String(attempt.provider || "A").toLowerCase();
            return `<span class="attempt-bar provider-${provider}" style="left:${left}%;width:${Math.min(100 - left, width)}%" title="Provider ${escapeAttr(attempt.provider || "A")}, ${Math.round(end - start)} ms"><b>${escapeHTML(attempt.provider || "A")}</b></span>`;
          }).join("")}
        </div>
        <span class="request-outcome outcome-${escapeAttr(status)}">${escapeHTML(status)}</span>
      </div>
    `;
  }

  function renderLab(module) {
    renderBreadcrumbs([
      { label: "Control room", route: "home" },
      { label: `Module ${module.number}`, route: `module/${module.id}` },
      { label: "Lab" }
    ]);
    const complete = state.completedLabs.includes(module.id);
    view.innerHTML = `
      <div class="lab-view" data-lab-module="${escapeAttr(module.id)}" style="--module-color:${module.color};--module-soft:${module.soft}">
        <header class="lab-header">
          <div><span class="eyebrow">${escapeHTML(module.lab.badge || "Interactive workbench")}</span><h1 tabindex="-1">${escapeHTML(module.lab.title)}</h1><p>${escapeHTML(module.lab.intro)}</p></div>
          <span class="completion-chip ${complete ? "complete" : ""}">${complete ? "Evidence recorded" : "Evidence required"}</span>
        </header>
        ${renderLabWorkbench(module)}
        ${renderNotebookCommands(module.lab.notebook)}
        <footer class="lab-footer"><div><button class="secondary-button" type="button" data-route="module/${module.id}">Module overview</button><button class="primary-button" type="button" data-route="quiz/${module.id}">Continue to the scenario test</button></div><p data-lab-requirement>${labRequirement(module)}</p></footer>
      </div>
    `;
  }

  function renderLabWorkbench(module) {
    if (["adaptive-routing", "concurrency-resilience"].includes(module.id)) {
      if (!activeGatewayRun) activeGatewayRun = Sim.runGateway(defaultGatewayConfig());
      return renderGatewayConsole(`lab-${module.id}`, false);
    }
    if (["request-contract", "coding-execution"].includes(module.id)) return renderCodeLab(module);
    if (module.id === "production-fleet") return `${renderSystemDesignStudio("gateway", { moduleId: module.id })}${renderFleetLab()}`;
    if (module.id === "telemetry-recovery") return `${renderSystemDesignStudio("gateway", { moduleId: module.id })}${renderIncidentLab()}`;
    if (module.id === "crawler-request-path") return `${renderSystemDesignStudio("crawler", { moduleId: module.id })}${renderCapacityLab(module)}`;
    if (module.id === "crawler-frontier") return `${renderSystemDesignStudio("crawler", { moduleId: module.id })}${renderCrawlerLab(module)}`;
    return renderMockHub();
  }

  function labRequirement(module) {
    if (["adaptive-routing", "concurrency-resilience"].includes(module.id)) return "Save a baseline and a one-control change with the same scenario and seed. Write a hypothesis before each run.";
    if (["request-contract", "coding-execution"].includes(module.id)) return "Pass every browser test to complete this lab.";
    if (module.id === "production-fleet") return "Complete the first five design artifacts, then change and defend a fleet failure that satisfies every invariant.";
    if (module.id === "telemetry-recovery") return "Finish the failure and defense artifacts, then run and defend an incident with every invariant intact.";
    if (module.id === "crawler-request-path") return "Complete the first five design artifacts, fit every modeled limit, and explain the first bottleneck.";
    if (module.id === "crawler-frontier") return "Finish the failure and defense artifacts, then repair an unsafe frontier run without moving the contract.";
    return "Score at least one mock rubric.";
  }

  function renderNotebookCommands(notebook = []) {
    if (!notebook?.length) return "";
    if (notebook.every((item) => typeof item === "string")) {
      return `
        <section class="field-notes" aria-labelledby="field-notes-title">
          <div class="section-heading"><div><span class="eyebrow">Running notes</span><h2 id="field-notes-title">Keep these beside the workbench</h2></div></div>
          <ul class="field-note-checklist">${notebook.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>
        </section>
      `;
    }
    return `
      <section class="field-notes" aria-labelledby="field-notes-title">
        <div class="section-heading"><div><span class="eyebrow">Take it to a terminal</span><h2 id="field-notes-title">Optional field notes</h2></div></div>
        <div class="field-note-grid">${notebook.map((item) => `<article><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.text)}</p>${item.command ? `<pre><code>${escapeHTML(item.command)}</code></pre><button class="copy-button" type="button" data-copy-text="${escapeAttr(item.command)}">Copy command</button>` : ""}</article>`).join("")}</div>
      </section>
    `;
  }

  const codeExercises = {
    "request-contract": {
      id: "classify-attempt",
      title: "Classify provider outcomes",
      prompt: "Implement classifyAttempt(event). Return success, caller_error, provider_overload, provider_failure, or neutral. A caller cancellation and a losing hedge are neutral health samples.",
      functionName: "classifyAttempt",
      starter: `function classifyAttempt(event) {
  // event: { status, transportError, cancelledBy, retryAfterMs }
  // Return one outcome string.
  return "success";
}`
    },
    "coding-execution": {
      id: "build-gateway",
      title: "Build the bounded request path",
      prompt: "Implement createGateway({ providers, states, maxActive, recordOutcome }). Return an object with async handle(request). deadlineAtMs and nowMs share one monotonic clock domain. Try at most two eligible providers, sorted by score then ID. Enforce the application and provider caps, pass the remaining deadlineMs to each provider, and call the optional recordOutcome({ provider, status, elapsedMs }) after every returned result. Retry only 429, 5xx, and non-AbortError exceptions from a provider adapter; in this deterministic exercise, those exceptions represent transport errors and consume zero modeled milliseconds. Do not retry other 4xx responses or AbortError. A result that arrives after the absolute deadline fails with deadline_exhausted. Return the last eligible provider's returned response even if it is retryable, propagate its thrown transport error, and release every counter on every terminal path. Throw no_eligible_provider when no provider is eligible before the first attempt.",
      functionName: "createGateway",
      starter: `function createGateway({ providers, states, maxActive, recordOutcome = () => {} }) {
  let active = 0;

  async function handle(request) {
    // request: { id, deadlineAtMs, nowMs }
    // Success: { status, body, provider, attempts }
    // Throw Error("gateway_overloaded") before accepting excess work.
    // Throw Error("deadline_exhausted") when no deadline remains.
    // Propagate AbortError without trying another provider.
  }

  return { handle };
}`
    }
  };

  function renderCodeLab(module) {
    const exercise = codeExercises[module.id] || codeExercises["request-contract"];
    const draft = state.codeDrafts[exercise.id] || exercise.starter;
    const result = state.codeResults[exercise.id];
    return `
      <section class="code-workbench" data-code-exercise="${escapeAttr(exercise.id)}">
        <div class="code-brief">
          <span class="eyebrow">Browser-tested exercise</span>
          <h2>${escapeHTML(exercise.title)}</h2>
          <p>${escapeHTML(exercise.prompt)}</p>
          <div class="code-contract"><strong>Contract</strong><code>${escapeHTML(exercise.functionName)}(...)</code><span>No network or wall-clock access</span></div>
          ${exercise.id === "build-gateway" ? `<p class="code-scope-note">This grader isolates the sequential request-path core: absolute deadline, adaptive-feedback callback, fallback, caps, and cleanup. Use the routing simulator to test queueing, hedges, cooldown probes, and recovery phases.</p>` : ""}
          <ul class="test-preview">
            ${exercise.id === "build-gateway"
              ? "<li>Fallback and shared deadline</li><li>Application and provider caps</li><li>Caller errors and cancellation</li><li>Exact cleanup after overlap</li>"
              : "<li>Normal result</li><li>Failure boundary</li><li>Cancellation or saturation</li><li>Deterministic classification</li>"}
          </ul>
        </div>
        <div class="editor-panel">
          <div class="editor-toolbar"><span>${escapeHTML(exercise.id)}.js</span><span>isolated worker · 1.5 s limit</span></div>
          <label class="sr-only" for="code-editor-${escapeAttr(exercise.id)}">Solution code</label>
          <textarea id="code-editor-${escapeAttr(exercise.id)}" class="code-editor" spellcheck="false" data-code-editor>${escapeHTML(draft)}</textarea>
          <div class="editor-actions"><button class="primary-button compact" type="button" data-run-code="${escapeAttr(exercise.id)}">Run tests</button><button class="quiet-button" type="button" data-reset-code="${escapeAttr(exercise.id)}">Reset</button></div>
          <div class="test-results ${result?.passed ? "passed" : result ? "failed" : ""}" data-test-results>${renderCodeResult(result)}</div>
        </div>
      </section>
    `;
  }

  function renderCodeResult(result) {
    if (!result) return `<p>Tests have not run.</p>`;
    return `
      <div class="test-summary"><strong>${result.passed ? "All tests passed" : `${result.failed} test${result.failed === 1 ? "" : "s"} failed`}</strong><span>${result.passedCount}/${result.total} passing</span></div>
      <ul>${result.cases.map((test) => `<li class="${test.ok ? "pass" : "fail"}"><span aria-hidden="true">${test.ok ? "✓" : "×"}</span><span>${escapeHTML(test.name)}</span>${test.message ? `<small>${escapeHTML(test.message)}</small>` : ""}</li>`).join("")}</ul>
    `;
  }

  function designWorkbook(studioId, { mockId = null } = {}) {
    const collection = mockId ? state.mockDesignWorkbooks : state.designWorkbooks;
    const key = mockId || studioId;
    if (!collection[key] || typeof collection[key] !== "object") {
      collection[key] = { activePhase: "scope", phases: {}, createdAt: new Date().toISOString() };
    }
    if (!collection[key].phases || typeof collection[key].phases !== "object") collection[key].phases = {};
    return collection[key];
  }

  function designPhaseRecord(workbook, phaseId) {
    if (!workbook.phases[phaseId] || typeof workbook.phases[phaseId] !== "object") {
      workbook.phases[phaseId] = { fields: {}, fieldUpdatedAt: {}, guidedDecisions: {}, verified: false, verifiedAt: null };
    }
    if (!workbook.phases[phaseId].fields || typeof workbook.phases[phaseId].fields !== "object") {
      workbook.phases[phaseId].fields = {};
    }
    if (!workbook.phases[phaseId].fieldUpdatedAt || typeof workbook.phases[phaseId].fieldUpdatedAt !== "object") {
      workbook.phases[phaseId].fieldUpdatedAt = {};
    }
    if (!workbook.phases[phaseId].guidedDecisions || typeof workbook.phases[phaseId].guidedDecisions !== "object") {
      workbook.phases[phaseId].guidedDecisions = {};
    }
    return workbook.phases[phaseId];
  }

  function designFieldComplete(field, record) {
    if (field.kind === "diagram") {
      return designDiagramNodes(record.fields[field.id]).length >= Number(field.minNodes || 1);
    }
    const value = String(record.fields[field.id] || "").trim();
    if (field.kind === "decision" && record.guidedDecisions[field.id] && field.options.some((option) => option.id === value)) return true;
    return designTextComplete(value, Number(field.minChars || (field.kind === "decision" ? 120 : 1)));
  }

  function designTextComplete(value, minimum) {
    const words = value.toLowerCase().match(/[a-z0-9][a-z0-9_-]*/gu) || [];
    const uniqueWords = new Set(words);
    const sections = value.split(/[.!?;\n]+/u).filter((part) => part.trim().length >= 12);
    return value.length >= minimum
      && words.length >= Math.max(16, Math.ceil(minimum / 8))
      && uniqueWords.size >= Math.max(12, Math.ceil(words.length * 0.4))
      && sections.length >= 2;
  }

  function designDiagramNodes(value) {
    const nodes = Array.isArray(value) ? value : String(value || "").split("\n");
    return nodes.map((node) => String(node).trim()).filter(Boolean).slice(0, 12);
  }

  function designPhaseComplete(phase, record) {
    return Boolean(record.verified && phase.fields.every((field) => designFieldComplete(field, record)));
  }

  function mockDesignLocked(mockId) {
    if (!mockId) return false;
    return Boolean(
      !activeTimer?.started
      || activeTimer.mockId !== mockId
      || !activeTimer.running
      || activeTimer.remaining === 0
      || activeTimer.endedAt
    );
  }

  function renderSystemDesignStudio(studioId, { moduleId = null, mockId = null } = {}) {
    const studio = systemDesignStudios[studioId];
    if (!studio) return "";
    const workbook = designWorkbook(studioId, { mockId });
    const phaseIds = mockId
      ? studio.phases.map((phase) => phase.id)
      : studio.guidedModules[moduleId] || studio.phases.map((phase) => phase.id);
    const phases = studio.phases.filter((phase) => phaseIds.includes(phase.id));
    if (!phaseIds.includes(workbook.activePhase)) workbook.activePhase = phases[0]?.id || "scope";
    const active = phases.find((phase) => phase.id === workbook.activePhase) || phases[0];
    const completed = studio.phases.filter((phase) => designPhaseComplete(phase, designPhaseRecord(workbook, phase.id))).length;
    const contextLabel = mockId ? "Timed blank board" : "Guided design studio";

    return `
      <section
        class="system-design-studio ${mockId ? "system-design-studio-mock" : ""}"
        data-system-design-studio="${escapeAttr(studioId)}"
        data-studio-module="${escapeAttr(moduleId || "")}"
        data-studio-mock="${escapeAttr(mockId || "")}"
        aria-labelledby="studio-title-${escapeAttr(studioId)}-${escapeAttr(mockId || moduleId || "guided")}"
      >
        <header class="studio-header">
          <div>
            <span class="eyebrow">${escapeHTML(contextLabel)} · ${escapeHTML(studio.label)}</span>
            <h2 id="studio-title-${escapeAttr(studioId)}-${escapeAttr(mockId || moduleId || "guided")}">${escapeHTML(studio.title)}</h2>
            <p>${escapeHTML(studio.premise)}</p>
          </div>
          <div class="studio-progress" aria-label="${completed} of ${studio.phases.length} design phases recorded">
            <strong>${completed}/${studio.phases.length}</strong>
            <span>artifacts recorded</span>
          </div>
        </header>

        <nav class="studio-phase-nav" aria-label="System-design interview phases">
          ${phases.map((phase) => {
            const record = designPhaseRecord(workbook, phase.id);
            const complete = designPhaseComplete(phase, record);
            return `<button type="button" data-studio-phase="${escapeAttr(phase.id)}" aria-current="${phase.id === active.id ? "step" : "false"}"><span>${escapeHTML(phase.number)}</span><strong>${escapeHTML(phase.short)}</strong><small>${complete ? "Recorded" : phase.minutes}</small></button>`;
          }).join("")}
        </nav>

        <div class="studio-desk">
          ${renderDesignPhase(studio, active, workbook, { mockId, phases })}
          ${renderGrowingDesignBoard(studio, workbook)}
        </div>
        ${!mockId && designPhaseRecord(workbook, active.id).attempted ? renderDesignReference(studio, active) : ""}
      </section>
    `;
  }

  function renderDesignPhase(studio, phase, workbook, { mockId = null, phases = studio.phases } = {}) {
    const record = designPhaseRecord(workbook, phase.id);
    const complete = designPhaseComplete(phase, record);
    const mockLocked = mockDesignLocked(mockId);
    const mockFinished = Boolean(mockId && activeTimer?.mockId === mockId && activeTimer.remaining === 0);
    const next = phases[phases.findIndex((entry) => entry.id === phase.id) + 1];
    const interviewer = phase.id === "scope"
      ? `<div class="interviewer-drawer"><span>${mockId ? "Simulated interviewer: open an answer only after asking" : "Ask before opening"}</span>${studio.interviewer.map((item, index) => `<details><summary>Question ${index + 1}: ${escapeHTML(item.question)}</summary><p>${escapeHTML(item.answer)}</p></details>`).join("")}</div>`
      : "";
    return `
      <section class="studio-phase" aria-labelledby="studio-phase-${escapeAttr(studio.id)}-${escapeAttr(phase.id)}">
        <div class="studio-phase-heading">
          <div><span>${escapeHTML(phase.minutes)}</span><h3 id="studio-phase-${escapeAttr(studio.id)}-${escapeAttr(phase.id)}" tabindex="-1">${escapeHTML(phase.title)}</h3></div>
          ${mockId ? `<details class="studio-mock-cue"><summary>Show phase cue</summary><p>${escapeHTML(phase.purpose)}</p></details>` : `<p>${escapeHTML(phase.purpose)}</p>`}
        </div>
        ${interviewer}
        <div class="studio-fields">
          ${phase.fields.map((field) => renderStudioField(studio, phase, field, record, { mockId })).join("")}
        </div>
        <div class="studio-phase-actions">
          <button class="primary-button compact" type="button" data-check-studio-phase="${escapeAttr(phase.id)}" ${mockLocked ? "disabled" : ""}>${complete ? "Recheck this artifact" : mockId ? "Lock phase evidence" : "Compare my artifact"}</button>
          ${complete && next ? `<button class="text-button" type="button" data-studio-phase="${escapeAttr(next.id)}">Next: ${escapeHTML(next.short)} →</button>` : ""}
          <p class="${complete ? "complete" : ""}" data-studio-phase-status tabindex="-1">${mockFinished ? "Time is complete. This attempt is frozen for scoring." : mockLocked ? activeTimer?.started ? "Resume the interview timer to edit this board." : "Start the interview timer to unlock the blank board." : complete ? mockId ? "Evidence recorded for this timed attempt." : "Artifact recorded. Revise it if the reference exposes a gap." : "Complete every field before recording this phase."}</p>
        </div>
      </section>
    `;
  }

  function renderStudioField(studio, phase, field, record, { mockId = null } = {}) {
    const rawValue = record.fields[field.id];
    const value = String(rawValue || "");
    const fieldId = `studio-${studio.id}-${mockId || "guided"}-${phase.id}-${field.id}`;
    const disabled = mockDesignLocked(mockId);
    if (field.kind === "diagram") {
      const nodes = designDiagramNodes(rawValue);
      return `
        <fieldset class="studio-field studio-diagram-field">
          <legend>${escapeHTML(field.label)}</legend>
          ${mockId ? "" : `<p>${escapeHTML(field.prompt)}</p>`}
          <div class="studio-diagram-entry">
            <label for="${escapeAttr(fieldId)}"><span>Next box</span><input id="${escapeAttr(fieldId)}" data-studio-node-input maxlength="64" placeholder="${mockId ? "Name a component and its owner" : "Example: gateway replica [request owner]"}" ${disabled ? "disabled" : ""}></label>
            <button class="secondary-button compact" type="button" data-studio-add-node="${escapeAttr(field.id)}" ${disabled ? "disabled" : ""}>Add box</button>
          </div>
          <div class="studio-diagram-canvas" role="list" aria-label="Student-created component path">
            ${nodes.length ? nodes.map((node, index) => `
              <div class="studio-diagram-node" role="listitem">
                <strong>${escapeHTML(node)}</strong>
                <div>
                  <button type="button" data-studio-node-action="left" data-studio-node-field="${escapeAttr(field.id)}" data-studio-node-index="${index}" aria-label="Move ${escapeAttr(node)} left" ${disabled || index === 0 ? "disabled" : ""}>←</button>
                  <button type="button" data-studio-node-action="right" data-studio-node-field="${escapeAttr(field.id)}" data-studio-node-index="${index}" aria-label="Move ${escapeAttr(node)} right" ${disabled || index === nodes.length - 1 ? "disabled" : ""}>→</button>
                  <button type="button" data-studio-node-action="remove" data-studio-node-field="${escapeAttr(field.id)}" data-studio-node-index="${index}" aria-label="Remove ${escapeAttr(node)}" ${disabled ? "disabled" : ""}>×</button>
                </div>
              </div>${index < nodes.length - 1 ? '<span class="studio-diagram-arrow" aria-hidden="true">→</span>' : ""}
            `).join("") : '<p class="studio-diagram-empty">Add the first component. The path will grow here.</p>'}
          </div>
          <small data-studio-counter class="${nodes.length >= field.minNodes ? "complete" : ""}">${nodes.length}/${field.minNodes} boxes</small>
        </fieldset>
      `;
    }
    if (field.kind === "decision") {
      if (mockId) {
        const minimum = Number(field.minChars || 120);
        return `
          <label class="studio-field" for="${escapeAttr(fieldId)}">
            <span><strong>${escapeHTML(field.label)}</strong><small>Choose a default, name a credible alternative, and state the condition that reverses your choice.</small></span>
            <textarea id="${escapeAttr(fieldId)}" data-studio-field="${escapeAttr(field.id)}" data-studio-min="${minimum}" placeholder="Write the choice, cost, alternative, and reversal condition." ${disabled ? "disabled" : ""}>${escapeHTML(value)}</textarea>
            <small data-studio-counter class="${value.trim().length >= minimum ? "complete" : ""}">${value.trim().length}/${minimum} characters</small>
          </label>
        `;
      }
      const selected = field.options.find((option) => option.id === value);
      return `
        <fieldset class="studio-field studio-decision-field">
          <legend>${escapeHTML(field.label)}</legend>
          <p>${escapeHTML(field.prompt)}</p>
          <div class="studio-decision-options">${field.options.map((option) => `<button type="button" data-studio-option="${escapeAttr(option.id)}" data-studio-option-field="${escapeAttr(field.id)}" aria-pressed="${value === option.id}" ${disabled ? "disabled" : ""}><strong>${escapeHTML(option.label)}</strong><span>${escapeHTML(option.consequence)}</span></button>`).join("")}</div>
          <small data-studio-counter>${selected ? `Selected: ${escapeHTML(selected.label)}` : "Choose one default. Your written failure plan should state when it stops fitting."}</small>
        </fieldset>
      `;
    }
    return `
      <label class="studio-field" for="${escapeAttr(fieldId)}">
        <span><strong>${escapeHTML(field.label)}</strong>${mockId ? "" : `<small>${escapeHTML(field.prompt)}</small>`}</span>
        <textarea id="${escapeAttr(fieldId)}" data-studio-field="${escapeAttr(field.id)}" data-studio-min="${Number(field.minChars || 1)}" placeholder="${escapeAttr(mockId ? "Write this artifact from your questions and stated assumptions." : field.placeholder)}" ${disabled ? "disabled" : ""}>${escapeHTML(value)}</textarea>
        <small data-studio-counter class="${value.trim().length >= field.minChars ? "complete" : ""}">${value.trim().length}/${field.minChars} characters</small>
      </label>
    `;
  }

  function renderGrowingDesignBoard(studio, workbook) {
    return `
      <aside class="growing-design-board" aria-labelledby="growing-board-${escapeAttr(studio.id)}">
        <div class="growing-board-head"><span class="eyebrow">Growing interview board</span><h3 id="growing-board-${escapeAttr(studio.id)}">Your design, not the answer key</h3></div>
        <ol>${studio.phases.map((phase) => {
          const record = designPhaseRecord(workbook, phase.id);
          const values = phase.fields.map((field) => field.kind === "diagram"
            ? designDiagramNodes(record.fields[field.id]).join(" → ")
            : String(record.fields[field.id] || "").trim()).filter(Boolean);
          const complete = designPhaseComplete(phase, record);
          const summary = values.length ? values.join(" · ").slice(0, 190) : "No artifact yet.";
          return `<li class="${complete ? "complete" : values.length ? "started" : ""}"><span>${escapeHTML(phase.number)}</span><div><strong>${escapeHTML(phase.short)}</strong><p>${escapeHTML(summary)}${values.join(" · ").length > 190 ? "…" : ""}</p></div><small>${complete ? "recorded" : values.length ? "draft" : "open"}</small></li>`;
        }).join("")}</ol>
      </aside>
    `;
  }

  function renderDesignReference(studio, phase) {
    const showEvolution = ["sketch", "evolve"].includes(phase.id);
    const showTradeoffs = phase.id === "defend";
    return `
      <section class="studio-reference" aria-labelledby="studio-reference-${escapeAttr(studio.id)}-${escapeAttr(phase.id)}">
        <div class="studio-reference-heading">
          <div><span class="eyebrow">Worked design under the stated assumptions</span><h3 id="studio-reference-${escapeAttr(studio.id)}-${escapeAttr(phase.id)}">Compare structure, then revise your board</h3></div>
          <p>${escapeHTML(phase.coach.lead)}</p>
        </div>
        <div class="studio-reference-table" role="table" aria-label="Worked artifact comparison">
          <div class="studio-reference-row studio-reference-row-head" role="row"><span role="columnheader">Decision</span><span role="columnheader">One defensible answer</span><span role="columnheader">Why it follows</span></div>
          ${phase.coach.rows.map((row) => `<div class="studio-reference-row" role="row"><strong role="cell" data-label="Decision">${escapeHTML(row[0])}</strong><span role="cell" data-label="One defensible answer">${escapeHTML(row[1])}</span><span role="cell" data-label="Why it follows">${escapeHTML(row[2])}</span></div>`).join("")}
        </div>
        ${showEvolution ? `${renderWorkedTopology(studio)}${renderArchitectureEvolution(studio)}` : ""}
        ${showTradeoffs ? renderDesignTradeoffs(studio) : ""}
      </section>
    `;
  }

  function renderArchitectureEvolution(studio) {
    return `
      <section class="architecture-evolution" aria-labelledby="architecture-evolution-${escapeAttr(studio.id)}">
        <div><span class="eyebrow">Progressive architecture</span><h4 id="architecture-evolution-${escapeAttr(studio.id)}">Each revision pays for one new requirement or failure</h4></div>
        <ol>${studio.evolution.map((stage, index) => `<li><div class="evolution-version"><span>${escapeHTML(stage.version)}</span><strong>${escapeHTML(stage.title)}</strong></div><p>${escapeHTML(stage.reason)}</p><div class="evolution-lanes">${stage.lanes.map((lane) => { const nodes = lane[1].split(/\s(?:→|·)\s/u); return `<div><strong>${escapeHTML(lane[0])}</strong><div class="evolution-lane-flow">${nodes.map((node, nodeIndex) => `<span>${escapeHTML(node)}</span>${nodeIndex < nodes.length - 1 ? '<i aria-hidden="true">→</i>' : ""}`).join("")}</div></div>`; }).join("")}</div>${index < studio.evolution.length - 1 ? '<i class="evolution-next" aria-hidden="true">→</i>' : ""}</li>`).join("")}</ol>
      </section>
    `;
  }

  function renderWorkedTopology(studio) {
    const topology = studio.workedTopology;
    if (!topology) return "";
    return `
      <section class="worked-topology" aria-labelledby="worked-topology-${escapeAttr(studio.id)}">
        <div><span class="eyebrow">Worked topology</span><h4 id="worked-topology-${escapeAttr(studio.id)}">${escapeHTML(topology.title)}</h4></div>
        <div class="worked-topology-board" role="img" aria-label="${escapeAttr(topology.lanes.map(([label, nodes]) => `${label}: ${nodes.join(" to ")}`).join(". "))}">
          ${topology.lanes.map(([label, nodes]) => `<div class="worked-topology-lane"><strong>${escapeHTML(label)}</strong><div>${nodes.map((node, index) => `<span>${escapeHTML(node)}</span>${index < nodes.length - 1 ? '<i aria-hidden="true">→</i>' : ""}`).join("")}</div></div>`).join("")}
        </div>
      </section>
    `;
  }

  function renderDesignTradeoffs(studio) {
    return `
      <section class="studio-tradeoffs" aria-labelledby="studio-tradeoffs-${escapeAttr(studio.id)}">
        <div><span class="eyebrow">Accepted alternatives</span><h4 id="studio-tradeoffs-${escapeAttr(studio.id)}">Defend a condition, not a memorized product</h4></div>
        <div class="table-scroll"><table><thead><tr><th>Boundary</th><th>Default here</th><th>Credible alternative</th><th>Reversal condition</th></tr></thead><tbody>${studio.tradeoffs.map((row) => `<tr>${row.map((cell) => `<td>${escapeHTML(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      </section>
    `;
  }

  function guidedStudioComplete(studioId, moduleId) {
    const studio = systemDesignStudios[studioId];
    if (!studio) return false;
    const workbook = designWorkbook(studioId);
    return (studio.guidedModules[moduleId] || []).every((phaseId) => {
      const phase = studio.phases.find((entry) => entry.id === phaseId);
      return phase && designPhaseComplete(phase, designPhaseRecord(workbook, phaseId));
    });
  }

  function refreshSystemDesignStudio(root, { focusPhase = false, focusSelector = null } = {}) {
    if (!root) return;
    const studioId = root.dataset.systemDesignStudio;
    const moduleId = root.dataset.studioModule || null;
    const mockId = root.dataset.studioMock || null;
    const marker = `${studioId}:${moduleId || ""}:${mockId || ""}`;
    root.outerHTML = renderSystemDesignStudio(studioId, { moduleId, mockId });
    if (!focusPhase && !focusSelector) return;
    requestAnimationFrame(() => {
      const replacement = [...document.querySelectorAll("[data-system-design-studio]")].find((entry) => `${entry.dataset.systemDesignStudio}:${entry.dataset.studioModule || ""}:${entry.dataset.studioMock || ""}` === marker);
      replacement?.querySelector(focusSelector || ".studio-phase h3")?.focus({ preventScroll: true });
    });
  }

  function maybeCompleteSystemDesignLab(moduleId) {
    const studioId = ["production-fleet", "telemetry-recovery"].includes(moduleId) ? "gateway" : "crawler";
    const model = state.designs[moduleId] || {};
    const modelComplete = Boolean(model.modelChecked || model.checked);
    if (!modelComplete || !guidedStudioComplete(studioId, moduleId)) return false;
    completeLab(moduleId, "Design artifacts and executable model evidence recorded.");
    return true;
  }

  function invalidateStudioEvidence(root) {
    const moduleId = root?.dataset.studioModule;
    if (moduleId && state.completedLabs.includes(moduleId)) {
      state.completedLabs = state.completedLabs.filter((id) => id !== moduleId);
      updateProgress();
      renderDrawer(parseRoute());
      const chip = document.querySelector(".lab-header .completion-chip");
      if (chip) {
        chip.textContent = "Evidence required";
        chip.classList.remove("complete");
      }
    }
    const mockId = root?.dataset.studioMock;
    const saved = mockId ? state.mockScores[mockId] : null;
    if (saved?.attemptId && saved.attemptId === activeTimer?.attemptId) delete state.mockScores[mockId];
  }

  function updateStudioDiagram(root, fieldId, nodes) {
    const studioId = root?.dataset.systemDesignStudio;
    const mockId = root?.dataset.studioMock || null;
    const workbook = designWorkbook(studioId, { mockId });
    const phase = systemDesignStudios[studioId]?.phases.find((entry) => entry.id === workbook.activePhase);
    if (!phase || mockDesignLocked(mockId)) return;
    const record = designPhaseRecord(workbook, phase.id);
    const now = new Date().toISOString();
    record.fields[fieldId] = nodes.join("\n");
    record.fieldUpdatedAt[fieldId] = now;
    record.verified = false;
    workbook.updatedAt = now;
    workbook.attemptId = mockId ? activeTimer?.attemptId || null : workbook.attemptId;
    invalidateStudioEvidence(root);
    saveState();
    refreshSystemDesignStudio(root, { focusSelector: "[data-studio-node-input]" });
  }

  function defaultFleetConfig() {
    return {
      scenario: "healthy",
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
      maxAttemptSec: 30,
      coldStartPct: 20,
      restartRampSec: 30
    };
  }

  function renderFleetLab() {
    if (typeof LabModels.runFleet !== "function") return renderLabModelError();
    if (!activeFleetRun) {
      activeFleetRun = LabModels.runFleet(defaultFleetConfig());
      activeFleetRun.evidence = { ranByStudent: false, changedControls: [] };
    }
    const config = activeFleetRun.config;
    return `
      <section class="systems-lab" data-fleet-lab>
        <aside class="systems-lab-controls sim-controls">
          <span class="eyebrow">Fleet capacity model</span>
          <h2>Keep a provider quota true across replicas</h2>
          <p>Inject a fleet failure, then compare what each ownership strategy admits, sheds, or delegates.</p>
          <p class="model-scale-note">This is a reduced-scale ratio model: 150 offered attempts and 200 provider slots stand in for the larger worksheet. Preserve the ratios when you map a result back to your capacity estimate.</p>
          <label>Failure scenario<select name="scenario">
            ${selectOptions([
              ["coordinator-partition", "Capacity coordinator partition"],
              ["provider-outage", "Provider A outage"],
              ["zone-outage", "One gateway zone fails"],
              ["mass-restart", "All gateway replicas restart"],
              ["healthy", "Healthy control"]
            ], config.scenario)}
          </select></label>
          <label>Quota ownership<select name="strategy">
            ${selectOptions([
              ["leases", "Expiring capacity leases"],
              ["local-caps", "Independent local caps"],
              ["central-check", "Central check per attempt"]
            ], config.strategy)}
          </select></label>
          <div class="control-pair">${numberControl("Replicas", "replicas", config.replicas, 1, 500)}${numberControl("Zones", "zones", config.zones, 1, 20)}</div>
          <div class="control-pair">${numberControl("Local cap", "localCap", config.localCap, 1, 100000)}${numberControl("Offered concurrency", "offeredConcurrency", config.offeredConcurrency, 0, 10000000)}</div>
          <div class="control-pair">${numberControl("Provider A quota", "providerQuotaA", config.providerQuotaA, 1, 1000000)}${numberControl("Provider B quota", "providerQuotaB", config.providerQuotaB, 1, 1000000)}</div>
          <div class="control-pair">${numberControl("B failover reserve", "failoverReserveB", config.failoverReserveB, 0, 1000000)}${numberControl("Normal share to A %", "normalShareA", config.normalShareA, 0, 100)}</div>
          <div class="control-pair">${numberControl("Lease TTL sec", "leaseTtlSec", config.leaseTtlSec, 1, 3600)}${numberControl("Max attempt sec", "maxAttemptSec", config.maxAttemptSec, 1, 3600)}</div>
          <details class="advanced-assumptions"><summary>Advanced restart assumptions</summary><div class="control-pair">${numberControl("Cold capacity %", "coldStartPct", config.coldStartPct, 1, 100)}${numberControl("Restart ramp sec", "restartRampSec", config.restartRampSec, 1, 600)}</div></details>
          <button class="primary-button" type="button" data-run-fleet>Run fleet failure</button>
        </aside>
        <div class="systems-lab-output">
          <div data-fleet-output>${renderFleetResult(activeFleetRun)}</div>
          ${renderLabDefense("fleet", "Explain who owns the provider limit, what happens during this failure, and which work is shed.")}
        </div>
      </section>
    `;
  }

  function selectOptions(options, selected) {
    return options.map(([value, label]) => `<option value="${escapeAttr(value)}" ${value === selected ? "selected" : ""}>${escapeHTML(label)}</option>`).join("");
  }

  function renderFleetResult(run) {
    const capacity = run.derivedCapacity || {};
    const admitted = run.admitted || {};
    const shed = run.shed || {};
    const topology = run.topology || {};
    return `
      <div class="metric-strip systems-metrics" aria-label="Fleet simulation summary">
        ${metric("Active replicas", `${valueOr(topology.activeReplicas, 0)} / ${valueOr(topology.replicas, 0)}`)}
        ${metric("Safe service", valueOr(admitted.safelyServed, 0))}
        ${metric("Gateway shed", valueOr(shed.atGateway, 0))}
        ${metric("Provider rejected", valueOr(shed.rejectedByProvider, 0))}
        ${metric("Unserved", valueOr(shed.totalUnserved, 0))}
      </div>
      <section class="model-explanation">
        <span class="eyebrow">Derived capacity</span>
        <h3>${escapeHTML(capacity.mode || "Capacity strategy")}</h3>
        <p>${escapeHTML(capacity.detail || "")}</p>
        <div class="capacity-ledger">
          <div><span>Demand</span><strong>${valueOr(run.demand?.total, 0)}</strong></div>
          <div><span>A allocation</span><strong>${valueOr(capacity.providerA, 0)}</strong></div>
          <div><span>B allocation</span><strong>${valueOr(capacity.providerB, 0)}</strong></div>
          <div><span>Potential quota excess</span><strong>${valueOr(run.oversubscription?.potentialTotal, 0)}</strong></div>
        </div>
      </section>
      <p class="model-assumption-note">A mass restart begins at ${valueOr(run.config?.coldStartPct, 0)}% cold capacity and returns over ${valueOr(run.config?.restartRampSec, 0)} seconds. These values do not affect the other fleet scenarios.</p>
      ${renderModelTimeline(run.timeline || [])}
      ${renderInvariantList(run.invariants || [])}
    `;
  }

  function defaultIncidentConfig() {
    return {
      scenario: "provider-outage",
      configMode: "atomic",
      durationSec: 120,
      stepSec: 5,
      rps: 1000,
      gatewayCap: 2400,
      queueCap: 5000,
      providerCapA: 1500,
      providerCapB: 1000,
      baseP95Ams: 250,
      baseP95Bms: 300,
      slowdownMs: 600,
      deadlineMs: 1200,
      normalShareA: 60,
      probeSharePct: 5,
      faultStartSec: 30,
      shiftDelaySec: 10,
      recoveryStartSec: 80,
      recoveryRampSec: 30,
      coldStartPct: 20,
      telemetryQueueBytes: 268435456,
      telemetryBytesPerRequest: 1680,
      telemetrySinkBytesPerSec: 2200000
    };
  }

  function renderIncidentLab() {
    if (typeof LabModels.runIncident !== "function") return renderLabModelError();
    if (!activeIncidentRun) {
      activeIncidentRun = LabModels.runIncident(defaultIncidentConfig());
      activeIncidentRun.evidence = { ranByStudent: false, changedControls: [] };
    }
    const config = activeIncidentRun.config;
    return `
      <section class="systems-lab" data-incident-lab>
        <aside class="systems-lab-controls sim-controls">
          <span class="eyebrow">Incident timeline</span>
          <h2>Keep forwarding separate from telemetry</h2>
          <p>Move the failure and recovery controls, then inspect request and telemetry behavior on one clock.</p>
          <label>Incident<select name="scenario">
            ${selectOptions([
              ["provider-outage", "Provider A outage"],
              ["provider-slowdown", "Provider A slowdown"],
              ["telemetry-sink-outage", "Telemetry sink outage"],
              ["bad-configuration", "Invalid routing configuration"],
              ["mass-restart", "Gateway fleet restart"]
            ], config.scenario)}
          </select></label>
          <label>Configuration apply<select name="configMode">${selectOptions([["atomic", "Atomic version"], ["partial", "Partial field updates"]], config.configMode)}</select></label>
          <div class="control-pair">${numberControl("Offered RPS", "rps", config.rps, 1, 100000)}${numberControl("Gateway cap", "gatewayCap", config.gatewayCap, 1, 1000000)}</div>
          <div class="control-pair">${numberControl("Provider A cap", "providerCapA", config.providerCapA, 1, 1000000)}${numberControl("Provider B cap", "providerCapB", config.providerCapB, 1, 1000000)}</div>
          <div class="control-pair">${numberControl("Queue cap", "queueCap", config.queueCap, 0, 10000000)}${numberControl("Deadline ms", "deadlineMs", config.deadlineMs, 25, 120000)}</div>
          <div class="control-pair">${numberControl("Fault at sec", "faultStartSec", config.faultStartSec, 0, 600)}${numberControl("Detect in sec", "shiftDelaySec", config.shiftDelaySec, 0, 120)}</div>
          <div class="control-pair">${numberControl("Recover at sec", "recoveryStartSec", config.recoveryStartSec, 0, 600)}${numberControl("Ramp sec", "recoveryRampSec", config.recoveryRampSec, 1, 300)}</div>
          ${numberControl("Timeline duration sec", "durationSec", config.durationSec, 30, 3600)}
          <div class="control-pair">${numberControl("Telemetry buffer bytes", "telemetryQueueBytes", config.telemetryQueueBytes, 0, 1000000000000)}${numberControl("Sink bytes/sec", "telemetrySinkBytesPerSec", config.telemetrySinkBytesPerSec, 0, 10000000000)}</div>
          <details class="advanced-assumptions"><summary>Advanced workload assumptions</summary>
            <div class="control-pair">${numberControl("Base A p95 ms", "baseP95Ams", config.baseP95Ams, 5, 60000)}${numberControl("Base B p95 ms", "baseP95Bms", config.baseP95Bms, 5, 60000)}</div>
            <div class="control-pair">${numberControl("Slowdown added ms", "slowdownMs", config.slowdownMs, 0, 60000)}${numberControl("Cold capacity %", "coldStartPct", config.coldStartPct, 1, 100)}</div>
            <div class="control-pair">${numberControl("Normal A share %", "normalShareA", config.normalShareA, 0, 100)}${numberControl("Probe share %", "probeSharePct", config.probeSharePct, 0, 25)}</div>
            ${numberControl("Telemetry bytes/request", "telemetryBytesPerRequest", config.telemetryBytesPerRequest, 0, 1000000)}
          </details>
          <button class="primary-button" type="button" data-run-incident>Run incident timeline</button>
        </aside>
        <div class="systems-lab-output">
          <div data-incident-output>${renderIncidentResult(activeIncidentRun)}</div>
          ${renderLabDefense("incident", "Name the first useful alert, state what remains available, and explain how recovery avoids a traffic surge.")}
        </div>
      </section>
    `;
  }

  function renderIncidentResult(run) {
    const summary = run.summary || {};
    const points = incidentDisplayPoints(run.timePoints || []);
    const assumptions = run.modelAssumptions || {};
    return `
      <div class="metric-strip systems-metrics" aria-label="Incident simulation summary">
        ${metric("Lowest success", `${valueOr(summary.minSuccessRate, 0)}%`)}
        ${metric("Highest terminal p95", `${valueOr(summary.maxP95Ms, 0)} ms`)}
        ${metric("Peak active", valueOr(summary.maxActiveAttempts, 0))}
        ${metric("Peak queue", valueOr(summary.maxQueueDepth, 0))}
        ${metric("Queue expired", valueOr(summary.totalQueueExpiredRequests, 0))}
        ${metric("Queue rejected", valueOr(summary.totalQueueRejectedRequests, 0))}
        ${metric("Telemetry dropped", formatBytes(valueOr(summary.totalTelemetryDroppedBytes, 0)))}
      </div>
      <section class="incident-trace" aria-labelledby="incident-trace-title">
        <div class="section-heading"><div><span class="eyebrow">Shared clock</span><h3 id="incident-trace-title">Fault, detection, and recovery</h3></div></div>
        <div class="table-scroll"><table><thead><tr><th>Time</th><th>Phase</th><th>Success</th><th>Terminal p95</th><th>A / B share</th><th>Provider health</th><th>Config</th><th>Queue</th><th>Expired</th><th>Rejected</th><th>Sink</th><th>Telemetry dropped</th><th>Buffered</th></tr></thead><tbody>
          ${points.map((point) => `<tr><td>${valueOr(point.timeSec, 0)}s</td><td><span class="phase-chip phase-${escapeAttr(point.phase || "healthy")}">${escapeHTML(point.phase || "healthy")}</span></td><td>${valueOr(point.successRate, 0)}%</td><td>${valueOr(point.p95Ms, 0)} ms</td><td>${valueOr(point.providerShare?.providerA, 0)}% / ${valueOr(point.providerShare?.providerB, 0)}%</td><td>${escapeHTML(point.providerHealth?.providerA || "-")} / ${escapeHTML(point.providerHealth?.providerB || "-")}</td><td>${escapeHTML(point.configurationState || "-")}</td><td>${valueOr(point.queueDepth, 0)}</td><td>${valueOr(point.queueExpired, 0)}</td><td>${valueOr(point.queueDropped, 0)}</td><td>${escapeHTML(point.telemetry?.sinkState || "-")}</td><td>${formatBytes(valueOr(point.telemetry?.droppedBytes, 0))}</td><td>${formatBytes(valueOr(point.telemetry?.bufferedBytes, 0))}</td></tr>`).join("")}
        </tbody></table></div>
      </section>
      <p class="model-assumption-note">Latency uses ${valueOr(assumptions.latencyBucketCount, 0)} deterministic buckets calibrated to A/B p95 values of ${valueOr(run.config?.baseP95Ams, 0)} / ${valueOr(run.config?.baseP95Bms, 0)} ms, plus ${valueOr(assumptions.queueDelayBucketCount, 0)} queue-delay buckets. The normal A share is ${valueOr(run.config?.normalShareA, 0)}%, recovery probes use ${valueOr(run.config?.probeSharePct, 0)}%, restart capacity begins at ${valueOr(run.config?.coldStartPct, 0)}%, and each request emits ${valueOr(run.config?.telemetryBytesPerRequest, 0)} telemetry bytes. Work beyond the deadline expires, while work beyond the queue cap is rejected.</p>
      ${renderInvariantList(run.invariants || [])}
    `;
  }

  function incidentDisplayPoints(points) {
    if (points.length <= 30) return points;
    const stride = Math.max(1, Math.ceil(points.length / 24));
    const extrema = new Set();
    const preserveExtreme = (select, direction) => {
      let selectedIndex = 0;
      for (let index = 1; index < points.length; index += 1) {
        if (direction * select(points[index]) > direction * select(points[selectedIndex])) selectedIndex = index;
      }
      extrema.add(selectedIndex);
    };
    preserveExtreme((point) => Number(point.successRate || 0), -1);
    preserveExtreme((point) => Number(point.p95Ms || 0), 1);
    preserveExtreme((point) => Number(point.queueDepth || 0), 1);
    preserveExtreme((point) => Number(point.queueDropped || 0), 1);
    preserveExtreme((point) => Number(point.queueExpired || 0), 1);
    preserveExtreme((point) => Number(point.telemetry?.droppedBytes || 0), 1);
    preserveExtreme((point) => Number(point.telemetry?.bufferedBytes || 0), 1);
    const signature = (point) => [
      point.phase,
      point.providerHealth?.providerA,
      point.providerHealth?.providerB,
      point.configurationState,
      point.telemetry?.sinkState,
      Number(point.telemetry?.droppedBytes || 0) > 0
    ].join("|");
    return points.filter((point, index) => (
      index === 0
      || index === points.length - 1
      || extrema.has(index)
      || index % stride === 0
      || signature(point) !== signature(points[index - 1])
      || signature(point) !== signature(points[index + 1] || point)
    ));
  }

  function renderModelTimeline(events) {
    if (!events.length) return "";
    return `<section class="model-timeline"><span class="eyebrow">Failure timeline</span><div>${events.map((event) => `<article><span>${event.timeSec === null || event.timeSec === undefined || !Number.isFinite(Number(event.timeSec)) ? "never" : `${event.timeSec}s`}</span><strong>${escapeHTML(event.label || "Event")}</strong><p>${escapeHTML(event.detail || "")}</p></article>`).join("")}</div></section>`;
  }

  function renderInvariantList(invariants) {
    const passing = invariants.filter((invariant) => invariant.ok).length;
    return `
      <section class="invariant-panel" aria-label="Model invariants">
        <div class="section-heading"><div><span class="eyebrow">Executable invariants</span><h3>${passing} of ${invariants.length} hold</h3></div></div>
        <div class="invariant-list">${invariants.map((invariant) => `<article class="${invariant.ok ? "pass" : "fail"}"><span aria-hidden="true">${invariant.ok ? "✓" : "×"}</span><div><strong>${escapeHTML(invariant.name)}</strong><p>${escapeHTML(invariant.detail)}</p></div></article>`).join("")}</div>
      </section>
    `;
  }

  function renderLabDefense(kind, prompt) {
    return `
      <section class="lab-defense">
        <label><span>Defend the result</span><small>${escapeHTML(prompt)}</small><textarea data-${escapeAttr(kind)}-defense placeholder="State the invariant, failure behavior, and trade-off in your own words."></textarea></label>
        <button class="secondary-button" type="button" data-record-${escapeAttr(kind)}>Record this evidence</button>
      </section>
    `;
  }

  function renderLabModelError() {
    return `<section class="empty-state"><h2>The lab model did not load.</h2><p>Reload the page. If the problem remains, use the lesson decision table while the model is repaired.</p></section>`;
  }

  function formatBytes(bytes) {
    const value = Number(bytes || 0);
    if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`;
    if (value >= 1e6) return `${(value / 1e6).toFixed(1)} MB`;
    if (value >= 1e3) return `${(value / 1e3).toFixed(1)} KB`;
    return `${Math.round(value)} B`;
  }

  function defaultPipelineConfig() {
    return {
      pagesPerDay: 100000000,
      peakFactor: 3,
      attemptAmplification: 1.15,
      meanFetchMs: 400,
      p95FetchMs: 2000,
      authorityGapMs: 5000,
      perAuthorityConcurrency: 1,
      meanResponseKiB: 200,
      rawRetentionDays: 30,
      replicationFactor: 2,
      parserCpuMs: 20,
      parserCores: 96,
      fetchConcurrencyCap: 10000,
      activeAuthoritiesAvailable: 25000,
      networkCapacityGbps: 10,
      rawStorageCapacityPB: 2,
      browserRenderFraction: 0.1,
      browserRenderMs: 4000,
      browserRenderMemoryMiB: 512,
      browserRenderConcurrencyCap: 2000,
      browserRenderMemoryGiB: 1024,
      separateRendererPool: true,
      slowdown: { durationSeconds: 600, parserCapacityFactor: 0.2, inputRateMode: "average", queueCapacityPages: 500000, maxRecoverySeconds: 900 }
    };
  }

  function renderCapacityLab() {
    if (typeof LabModels.runCrawlPipeline !== "function") return renderLabModelError();
    if (!activeCrawlerRun || activeCrawlerRun.kind !== "crawl-pipeline") {
      activeCrawlerRun = LabModels.runCrawlPipeline(defaultPipelineConfig());
      activeCrawlerRun.evidence = { ranByStudent: false, changedControls: [] };
    }
    const config = activeCrawlerRun.config;
    return `
      <section class="systems-lab" data-pipeline-lab>
        <aside class="systems-lab-controls sim-controls">
          <span class="eyebrow">Derived capacity model</span>
          <h2>Turn a crawl target into separate limits</h2>
          <p>The same page target produces different fetch, authority, network, parser, and storage requirements.</p>
          <div class="control-pair">${numberControl("Pages per day", "pagesPerDay", config.pagesPerDay, 1000, 10000000000)}${numberControl("Peak factor", "peakFactor", config.peakFactor, 1, 20)}</div>
          <div class="control-pair">${numberControl("Attempt amplification", "attemptAmplification", config.attemptAmplification, 1, 10)}${numberControl("Response KiB", "meanResponseKiB", config.meanResponseKiB, 1, 100000)}</div>
          <div class="control-pair">${numberControl("Mean fetch ms", "meanFetchMs", config.meanFetchMs, 1, 60000)}${numberControl("p95 fetch ms", "p95FetchMs", config.p95FetchMs, 1, 120000)}</div>
          <div class="control-pair">${numberControl("Authority gap ms", "authorityGapMs", config.authorityGapMs, 0, 600000)}${numberControl("Per-authority cap", "perAuthorityConcurrency", config.perAuthorityConcurrency, 1, 64)}</div>
          ${numberControl("Active authorities", "activeAuthoritiesAvailable", config.activeAuthoritiesAvailable, 1, 100000000)}
          <div class="control-pair">${numberControl("Fetch cap", "fetchConcurrencyCap", config.fetchConcurrencyCap, 1, 10000000)}${numberControl("Network Gbps", "networkCapacityGbps", config.networkCapacityGbps, 0.1, 100000)}</div>
          <div class="control-pair">${numberControl("Parser cores", "parserCores", config.parserCores, 1, 100000)}${numberControl("Parser CPU ms", "parserCpuMs", config.parserCpuMs, 0.1, 60000)}</div>
          <div class="control-pair">${numberControl("Raw retention days", "rawRetentionDays", config.rawRetentionDays, 1, 3650)}${numberControl("Replication factor", "replicationFactor", config.replicationFactor, 1, 20)}</div>
          ${numberControl("Raw store PB", "rawStorageCapacityPB", config.rawStorageCapacityPB, 0.01, 100000)}
          <div class="control-pair">${numberControl("Render fraction 0–1", "browserRenderFraction", config.browserRenderFraction, 0, 1)}${numberControl("Render time ms", "browserRenderMs", config.browserRenderMs, 1, 120000)}</div>
          <div class="control-pair">${numberControl("Render task MiB", "browserRenderMemoryMiB", config.browserRenderMemoryMiB, 1, 1000000)}${numberControl("Render memory GiB", "browserRenderMemoryGiB", config.browserRenderMemoryGiB, 1, 10000000)}</div>
          ${numberControl("Render concurrency cap", "browserRenderConcurrencyCap", config.browserRenderConcurrencyCap, 1, 1000000)}
          ${frontierToggle("separateRendererPool", "Keep rendering in a separate pool", config.separateRendererPool)}
          <div class="control-pair">${numberControl("Slow parser factor", "parserCapacityFactor", config.slowdown.parserCapacityFactor, 0, 1)}${numberControl("Queue capacity pages", "queueCapacityPages", config.slowdown.queueCapacityPages, 1, 1000000000)}</div>
          <div class="control-pair">${numberControl("Slowdown seconds", "slowdownDurationSeconds", config.slowdown.durationSeconds, 1, 86400)}${numberControl("Recovery objective sec", "maxRecoverySeconds", config.slowdown.maxRecoverySeconds, 1, 86400)}</div>
          <label>Slowdown input rate<select name="slowdownInputRateMode">${selectOptions([["average", "Average accepted rate"], ["peak", "Peak accepted rate"]], config.slowdown.inputRateMode)}</select></label>
          <button class="primary-button" type="button" data-run-pipeline>Recalculate constraints</button>
        </aside>
        <div class="systems-lab-output">
          <div data-pipeline-output>${renderPipelineResult(activeCrawlerRun)}</div>
          ${renderLabDefense("pipeline", "Identify the first bottleneck, distinguish logical pages from physical attempts, and state one assumption you would measure.")}
        </div>
      </section>
    `;
  }

  function renderPipelineResult(run) {
    const failed = (run.constraints || []).filter((constraint) => !constraint.ok);
    return `
      <div class="metric-strip systems-metrics" aria-label="Crawler capacity summary">
        ${metric("Average pages/s", valueOr(run.rates?.averageAcceptedPagesPerSecond, 0))}
        ${metric("Peak attempts/s", valueOr(run.rates?.peakFetchAttemptsPerSecond, 0))}
        ${metric("Tail sizing proxy", valueOr(run.concurrency?.p95InFlightFetches, 0))}
        ${metric("Authority supply", valueOr(run.concurrency?.activeAuthorityRequirement, 0))}
        ${metric("Failed limits", failed.length)}
      </div>
      <section class="constraint-panel">
        <div class="section-heading"><div><span class="eyebrow">Independent constraints</span><h3>${failed.length ? `First bottleneck: ${escapeHTML(run.firstBottleneck?.label || "Unknown")}` : "Every modeled limit fits"}</h3></div></div>
        <div class="table-scroll"><table><thead><tr><th>Limit</th><th>Required</th><th>Available</th><th>Use</th><th>Result</th></tr></thead><tbody>
          ${(run.constraints || []).map((constraint) => `<tr><td><strong>${escapeHTML(constraint.label)}</strong><small>${escapeHTML(constraint.detail)}</small></td><td>${constraint.required === null ? (constraint.unit === "seconds" ? "never" : "unbounded") : `${constraint.required} ${escapeHTML(constraint.unit)}`}</td><td>${valueOr(constraint.available, 0)} ${escapeHTML(constraint.unit)}</td><td>${constraint.utilizationPercent === null ? "∞" : `${constraint.utilizationPercent}%`}</td><td><span class="constraint-result ${constraint.ok ? "pass" : "fail"}">${constraint.ok ? "Fits" : "Exceeds"}</span></td></tr>`).join("")}
        </tbody></table></div>
      </section>
      ${renderModelTimeline((run.timeline || []).map((event) => ({ ...event, timeSec: event.atSeconds })))}
      <p class="model-assumption-note">This run uses ${valueOr(run.config?.replicationFactor, 0)} raw-body copies, ${valueOr(run.config?.browserRenderMemoryMiB, 0)} MiB per render task, and a ${valueOr(run.config?.slowdown?.durationSeconds, 0)} second parser slowdown at the ${escapeHTML(run.config?.slowdown?.inputRateMode || "average")} accepted rate. Recovery must finish within ${valueOr(run.config?.slowdown?.maxRecoverySeconds, 0)} seconds.</p>
      ${renderInvariantList(run.invariants || [])}
    `;
  }

  function defaultFrontierConfig() {
    return {
      scenario: "mixed",
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
    };
  }

  function renderCrawlerLab() {
    if (typeof LabModels.runFrontierChallenge !== "function") return renderLabModelError();
    if (!activeCrawlerRun || activeCrawlerRun.kind !== "frontier-challenge") activeCrawlerRun = LabModels.runFrontierChallenge(defaultFrontierConfig());
    const controls = activeCrawlerRun.controls;
    return `
      <section class="systems-lab" data-frontier-lab>
        <aside class="systems-lab-controls sim-controls">
          <span class="eyebrow">Break, observe, repair</span>
          <h2>Preserve safety and work ownership</h2>
          <p>Turn off one protection and run the challenge. Repair the failure, rerun it, then defend both results.</p>
          <label>Scenario<select name="scenario">${selectOptions([
            ["mixed", "Mixed frontier"], ["authority-ready", "Authority timing"], ["shared-ip", "Shared IP"], ["robots", "Robots outcomes"], ["lease-expiry", "Worker crash and lease expiry"], ["redirect-revalidation", "Forbidden redirect"], ["dns-rebinding", "DNS rebinding"], ["dedupe", "Approximate dedupe"], ["crawl-trap", "Calendar trap"]
          ], activeCrawlerRun.scenario)}</select></label>
          <label>Scheduler<select name="scheduler">${selectOptions([["authority-ready", "Authority-ready heap"], ["global-fifo", "Global FIFO"]], controls.scheduler)}</select></label>
          <div class="control-pair">${numberControl("Workers", "workers", controls.workers, 1, 64)}${numberControl("Per-authority cap", "perAuthorityConcurrency", controls.perAuthorityConcurrency, 1, 16)}</div>
          <div class="control-pair">${numberControl("Shared-IP cap", "sharedIpCap", controls.sharedIpCap, 1, 32)}${numberControl("Lease ms", "leaseMs", controls.leaseMs, 1, 60000)}</div>
          <label>Robots policy<select name="robotsPolicy">${selectOptions([["rfc9309", "RFC 9309 split"], ["fail-open", "Allow after 5xx or unreachable"], ["block-on-any-error", "Block on every error"]], controls.robotsPolicy)}</select></label>
          <label>Dedupe authority<select name="dedupeMode">${selectOptions([["bloom-plus-exact", "Bloom precheck, exact authority"], ["exact", "Exact only"], ["bloom-only", "Bloom result is final"], ["none", "No duplicate check"]], controls.dedupeMode)}</select></label>
          ${frontierToggle("enforceAuthorityReady", "Enforce authority-ready time", controls.enforceAuthorityReady)}
          ${frontierToggle("enforceSharedIp", "Enforce shared-IP cap", controls.enforceSharedIp)}
          ${frontierToggle("durableLeases", "Use durable leases", controls.durableLeases)}
          ${frontierToggle("requeueExpiredLeases", "Requeue expired leases", controls.requeueExpiredLeases)}
          ${frontierToggle("revalidateRedirects", "Revalidate every redirect", controls.revalidateRedirects)}
          ${frontierToggle("pinValidatedAddress", "Connect to validated address", controls.pinValidatedAddress)}
          ${frontierToggle("enforceEgress", "Block forbidden egress", controls.enforceEgress)}
          ${frontierToggle("enforceCrawlBudget", "Enforce authority crawl budget", controls.enforceCrawlBudget)}
          ${numberControl("URLs per authority", "maxUrlsPerAuthority", controls.maxUrlsPerAuthority, 1, 10000)}
          <button class="primary-button" type="button" data-run-frontier>Run frontier challenge</button>
        </aside>
        <div class="systems-lab-output">
          <div data-frontier-output>${renderFrontierResult(activeCrawlerRun)}</div>
          ${renderLabDefense("frontier", "Name the failure you observed, the owner of the violated state, and why the repaired run preserves coverage or safety.")}
        </div>
      </section>
    `;
  }

  function frontierToggle(name, label, checked) {
    return `<label class="check-control"><input type="checkbox" name="${escapeAttr(name)}" ${checked ? "checked" : ""}><span>${escapeHTML(label)}</span></label>`;
  }

  function renderFrontierResult(run) {
    const metrics = run.metrics || {};
    const events = frontierEventTrace(run.events || []);
    return `
      <div class="metric-strip systems-metrics" aria-label="Frontier challenge summary">
        ${metric("Discovered", valueOr(metrics.discovered, 0))}
        ${metric("Completed", valueOr(metrics.completed, 0))}
        ${metric("Makespan", `${valueOr(metrics.makespanMs, 0)} ms`)}
        ${metric("Eligible-wait p95", `${valueOr(metrics.p95EligibleWaitMs, 0)} ms`)}
        ${metric("Lease renewals", valueOr(metrics.leaseRenewals, 0))}
        ${metric("Lost work", valueOr(metrics.lostLogicalWork, 0))}
        ${metric("Duplicate fetches", valueOr(metrics.duplicateFetches, 0))}
        ${metric("Budget blocked", valueOr(metrics.budgetDrops, 0))}
      </div>
      <section class="frontier-verdict ${run.ok ? "pass" : "fail"}"><span>${run.ok ? "Safe run" : "Invariant failure"}</span><strong>${run.ok ? "Every modeled invariant holds." : `${run.invariants.filter((item) => !item.ok).length} invariants need repair.`}</strong></section>
      ${renderFrontierRepairComparison(run)}
      ${renderInvariantList(run.invariants || [])}
      <section class="frontier-events"><div class="section-heading"><div><span class="eyebrow">Selected event trace</span><h3>From admission to terminal state</h3></div></div><div class="table-scroll"><table><thead><tr><th>Time</th><th>Authority</th><th>Event</th><th>Evidence</th></tr></thead><tbody>
        ${events.map((event) => `<tr class="${event.safetyViolation || event.durabilityViolation ? "event-failure" : ""}"><td>${valueOr(event.atMs, 0)} ms</td><td>${escapeHTML(event.authority || "-")}</td><td>${escapeHTML(String(event.type || "event").replaceAll("_", " "))}</td><td>${escapeHTML(event.detail || "")}</td></tr>`).join("")}
      </tbody></table></div></section>
    `;
  }

  function frontierEventTrace(allEvents) {
    if (allEvents.length <= 36) return allEvents;
    const routine = new Set(["lease_granted", "lease_renewed", "fetch_started", "fetch_completed"]);
    const important = allEvents.filter((event) => !routine.has(event.type) || event.safetyViolation || event.durabilityViolation);
    const ordinary = allEvents.filter((event) => routine.has(event.type) && !event.safetyViolation && !event.durabilityViolation);
    return [...new Set([...important, ...ordinary.slice(0, 6), ...ordinary.slice(-6)])]
      .sort((left, right) => left.atMs - right.atMs);
  }

  function frontierRepairEvaluation(failedRun, repairedRun) {
    if (!failedRun || !repairedRun || failedRun.scenario !== repairedRun.scenario) {
      return { ok: false, reasons: ["The failed and repaired runs must use the same scenario."] };
    }
    const failedNames = new Set(failedRun.invariants.filter((item) => !item.ok).map((item) => item.name));
    const before = failedRun.controls || {};
    const after = repairedRun.controls || {};
    const reasons = [];
    if (failedNames.has("Authority-ready times are respected") && !after.enforceAuthorityReady) reasons.push("Restore authority-ready scheduling instead of removing the timing contract.");
    if (failedNames.has("Shared destinations stay inside their concurrency cap") && (!after.enforceSharedIp || after.sharedIpCap !== before.sharedIpCap)) reasons.push("Restore shared-destination admission while keeping the original destination cap.");
    if (failedNames.has("Robots failures preserve the RFC 9309 safety split") && after.robotsPolicy !== "rfc9309") reasons.push("Restore the RFC 9309 outcome split for robots failures.");
    if (failedNames.has("Redirects repeat destination validation") && !after.revalidateRedirects && !after.enforceEgress) reasons.push("Restore redirect validation or an independent egress boundary.");
    if (failedNames.has("The connected peer matches a validated destination") && !after.pinValidatedAddress && !after.enforceEgress) reasons.push("Restore address pinning or an independent egress boundary.");
    if (failedNames.has("Every authority remains inside its crawl budget") && (!after.enforceCrawlBudget || after.maxUrlsPerAuthority !== before.maxUrlsPerAuthority)) reasons.push("Restore authority-budget admission while keeping the original URL budget.");
    if (failedNames.has("Exact URL identity is fetched at most once") && !["exact", "bloom-plus-exact"].includes(after.dedupeMode)) reasons.push("Restore an exact dedupe authority before fetching.");
    if (failedNames.has("Approximate dedupe cannot silently remove new URLs") && !["exact", "bloom-plus-exact"].includes(after.dedupeMode)) reasons.push("Put an exact check behind the approximate membership filter.");
    if (failedNames.has("Active work keeps durable lease ownership") && !after.durableLeases) reasons.push("Restore durable lease ownership and renewal for active work.");
    if (failedNames.has("Expired leases return unfinished work") && (!after.durableLeases || !after.requeueExpiredLeases)) reasons.push("Restore durable lease expiry and requeue before claiming recovery.");
    if (failedNames.has("Accepted logical work reaches a terminal state") && (!after.durableLeases || !after.requeueExpiredLeases)) reasons.push("Restore the durable recovery path for accepted work.");
    return { ok: reasons.length === 0, reasons };
  }

  function renderFrontierRepairComparison(run) {
    if (!run.ok || !frontierFailedRun || frontierFailedRun.scenario !== run.scenario) return "";
    const failedInvariants = frontierFailedRun.invariants.filter((invariant) => !invariant.ok);
    const changedControls = Object.keys(run.controls || {}).filter((key) => run.controls[key] !== frontierFailedRun.controls?.[key]);
    const failedEvents = (frontierFailedRun.events || []).filter((event) => event.safetyViolation || event.durabilityViolation).slice(0, 6);
    const repair = frontierRepairEvaluation(frontierFailedRun, run);
    return `
      <section class="repair-comparison" aria-label="Broken and repaired frontier comparison">
        <div><span class="eyebrow">Broken run</span><strong>${failedInvariants.length} failed invariant${failedInvariants.length === 1 ? "" : "s"}</strong><ul>${failedInvariants.map((invariant) => `<li>${escapeHTML(invariant.name)}</li>`).join("")}</ul></div>
        <div><span class="eyebrow">Repair</span><strong>${changedControls.length ? `Changed ${changedControls.map(formatControlName).join(", ")}` : "No control changed"}</strong><ul>${failedEvents.map((event) => `<li>${escapeHTML(event.detail || event.type)}</li>`).join("")}</ul></div>
        <div><span class="eyebrow">Repaired run</span><strong>${repair.ok ? `All ${run.invariants.length} invariants hold under the original contract` : "The model passes only because the contract moved"}</strong><p>${escapeHTML(repair.ok ? "The failed and repaired runs keep the same scenario and safety limit." : repair.reasons[0])}</p></div>
      </section>
    `;
  }

  function formatControlName(value) {
    return String(value).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  }

  function renderMockHub() {
    return `
      <section class="mock-hub" aria-labelledby="mock-hub-title"><span class="eyebrow">Timed rehearsals</span><h2 id="mock-hub-title">Practice the three interview loops</h2><div class="mock-card-grid">${course.mocks.map((mock) => `<article><span>${escapeHTML(trackLabels[mock.track])}</span><h3>${escapeHTML(mock.title)}</h3><p>${escapeHTML(mock.artifact)}</p><button class="primary-button compact" type="button" data-route="mock/${mock.id}">Open ${mock.minutes}-minute mock</button></article>`).join("")}</div></section>
    `;
  }

  function quizQuestions(module) {
    const applied = (appliedQuestions[module.id] || []).map((question) => ({
        ...question,
        explanation: question.explanation || question.rationale,
        source: "Applied failure scenario"
      }));
    const recall = [
      ...module.lessons.map((lesson) => ({ ...lesson.check, source: lesson.title })),
      ...(module.quizExtra || []).map((question) => ({ ...question, source: "Scenario drill" }))
    ];
    const interleaved = [];
    for (let index = 0; index < Math.max(recall.length, applied.length); index += 1) {
      if (recall[index]) interleaved.push(recall[index]);
      if (applied[index]) interleaved.push(applied[index]);
    }
    return interleaved.map((question, index) => rebalanceQuestion(question, index, Number(module.number) || 0));
  }

  function rebalanceQuestion(question, index, moduleNumber) {
    const target = (index * 3 + moduleNumber) % question.choices.length;
    const correct = question.choices[question.answer];
    const distractors = question.choices.filter((_, choiceIndex) => choiceIndex !== question.answer);
    const shift = index % Math.max(1, distractors.length);
    const rotated = [...distractors.slice(shift), ...distractors.slice(0, shift)];
    const choices = [...rotated];
    choices.splice(target, 0, correct);
    return { ...question, choices, answer: target };
  }

  function startQuiz(module) {
    return { moduleId: module.id, questions: quizQuestions(module), index: 0, correct: 0, answers: [], selected: null, finished: false };
  }

  function renderQuiz(module) {
    if (!activeQuiz || activeQuiz.moduleId !== module.id) activeQuiz = startQuiz(module);
    renderBreadcrumbs([
      { label: "Control room", route: "home" },
      { label: `Module ${module.number}`, route: `module/${module.id}` },
      { label: "Scenario check" }
    ]);
    if (activeQuiz.finished) {
      renderQuizResult(module);
      return;
    }
    const question = activeQuiz.questions[activeQuiz.index];
    const progress = Math.round((activeQuiz.index / activeQuiz.questions.length) * 100);
    view.innerHTML = `
      <section class="quiz-view" style="--module-color:${module.color};--module-soft:${module.soft}">
        <header class="quiz-header"><span class="eyebrow">Module ${module.number} · retrieval under pressure</span><h1 tabindex="-1">Scenario check</h1><div class="quiz-progress"><span style="width:${progress}%"></span></div><p>Question ${activeQuiz.index + 1} of ${activeQuiz.questions.length}</p></header>
        <article class="quiz-card">
          <span class="question-source">${escapeHTML(question.source)}</span>
          <h2>${escapeHTML(question.question)}</h2>
          <div class="quiz-choices">
            ${question.choices.map((choice, index) => `<button type="button" class="quiz-choice ${activeQuiz.selected === index ? index === question.answer ? "correct" : "incorrect" : ""}" data-quiz-answer="${index}" ${activeQuiz.selected !== null ? "disabled" : ""}><span>${String.fromCharCode(65 + index)}</span>${escapeHTML(choice)}</button>`).join("")}
          </div>
          ${activeQuiz.selected !== null ? `<div class="quiz-feedback ${activeQuiz.selected === question.answer ? "correct" : "incorrect"}" role="status" aria-live="polite" tabindex="-1"><strong>${activeQuiz.selected === question.answer ? "Correct" : `Answer: ${question.choices[question.answer]}`}</strong><p>${escapeHTML(question.explanation)}</p><button class="primary-button" type="button" data-next-question>${activeQuiz.index === activeQuiz.questions.length - 1 ? "See result" : "Next question"}</button></div>` : ""}
        </article>
      </section>
    `;
  }

  function renderQuizResult(module) {
    const total = activeQuiz.questions.length;
    const percent = Math.round((activeQuiz.correct / total) * 100);
    const passed = percent >= passingScore;
    state.quizScores[module.id] = Math.max(Number(state.quizScores[module.id] || 0), percent);
    saveState();
    view.innerHTML = `
      <section class="quiz-result ${passed ? "passed" : "retry"}" style="--module-color:${module.color};--module-soft:${module.soft}">
        <span class="eyebrow">Scenario check complete</span><h1 tabindex="-1">${passed ? "The module signal is recorded." : "Run one more retrieval pass."}</h1>
        <div class="score-ring" aria-label="Score ${percent}%"><strong>${percent}%</strong><span>${activeQuiz.correct} of ${total}</span></div>
        <p>${passed ? "You met the 75% gate. Return later if you want a cleaner explanation under pressure." : "Review the missed failure boundaries, then retry. Your best score is saved."}</p>
        <div class="result-actions"><button class="secondary-button" type="button" data-retry-quiz="${escapeAttr(module.id)}">Retry test</button><button class="secondary-button" type="button" data-route="module/${module.id}">Module overview</button>${passed ? `<button class="primary-button" type="button" data-route="${routeAfterModule(module)}">${escapeHTML(labelAfterModule(module))}</button>` : ""}</div>
        <div class="answer-review"><h2>Answer review</h2>${activeQuiz.answers.map((answer, index) => { const question = activeQuiz.questions[index]; return `<details ${answer.correct ? "" : "open"}><summary><span>${answer.correct ? "✓" : "×"}</span>${escapeHTML(question.question)}</summary><p><strong>${escapeHTML(question.choices[question.answer])}</strong></p><p>${escapeHTML(question.explanation)}</p></details>`; }).join("")}</div>
      </section>
    `;
    updateProgress();
    renderDrawer(parseRoute());
  }

  function mockCheckpointPlan(mock) {
    if (mock.id === "ai-gateway-coding") {
      return [
        { at: 0, label: "Contract" },
        { at: 7 * 60, label: "One provider" },
        { at: 22 * 60, label: "Bounds and fallback" },
        { at: 37 * 60, label: "Adaptation" },
        { at: 52 * 60, label: "Benchmark" },
        { at: 64 * 60, label: "Tests and defense" }
      ];
    }
    return [
      { at: 0, label: "Scope" },
      { at: 5 * 60, label: "Requirements" },
      { at: 10 * 60, label: "Numbers" },
      { at: 17 * 60, label: "Entities" },
      { at: 25 * 60, label: "First sketch" },
      { at: 35 * 60, label: "Scale and faults" },
      { at: 50 * 60, label: "Defense" }
    ];
  }

  function mockFollowupUnlockAt(mock, index) {
    const coding = [22, 37, 52, 64].map((minutes) => minutes * 60);
    const design = [0.2, 0.4, 0.6, 0.78, 0.9].map((ratio) => Math.round(mock.minutes * 60 * ratio));
    return (mock.id === "ai-gateway-coding" ? coding : design)[index] || mock.minutes * 60;
  }

  function renderMockRubric(mock, saved) {
    const objectiveEvidence = mockObjectiveEvidence(mock);
    if (!activeTimer.rubricRevealed) {
      const ready = activeTimer.elapsed >= mock.minutes * 60;
      return `<section class="rubric-panel rubric-locked" aria-labelledby="rubric-title"><span class="eyebrow">Closed until the rep ends</span><h2 id="rubric-title">Evidence rubric</h2><p>The rubric stays hidden so it cannot script the answer. Finish the timer, then reveal the objective artifacts and self-score.</p><button class="primary-button" type="button" data-reveal-rubric ${ready ? "" : "disabled"}>${ready ? "Reveal rubric" : `Available after ${formatClock(activeTimer.remaining)}`}</button></section>`;
    }
    return `<section class="rubric-panel" aria-labelledby="rubric-title"><span class="eyebrow">Score after answering aloud</span><h2 id="rubric-title">Evidence rubric</h2><p>Use 0 for missing, 1 for partial, and 2 for clear and defended.</p>
      <div class="mock-objective-evidence"><strong>Required artifacts from this attempt</strong>${objectiveEvidence.map((item) => `<div class="${item.ok ? "pass" : "pending"}"><span aria-hidden="true">${item.ok ? "✓" : "○"}</span><span>${escapeHTML(item.label)}</span>${item.route && !item.ok ? `<button class="text-button" type="button" data-route="${escapeAttr(item.route)}">Open</button>` : ""}</div>`).join("")}</div>
      <div class="rubric-list">${mock.rubric.map((item, index) => `<label><span><strong>${escapeHTML(item.label)}</strong><small>${escapeHTML(item.detail)}</small></span><select data-rubric-score="${index}" aria-label="Score ${escapeAttr(item.label)}"><option value="">Not scored</option><option value="0" ${saved.scores?.[index] === 0 ? "selected" : ""}>0</option><option value="1" ${saved.scores?.[index] === 1 ? "selected" : ""}>1</option><option value="2" ${saved.scores?.[index] === 2 ? "selected" : ""}>2</option></select></label>`).join("")}</div>
      <label class="mock-evidence-check"><input type="checkbox" data-mock-performed><span>I completed this timed attempt before revealing the rubric, and the ${mock.id === "ai-gateway-coding" ? "notes" : "design board"} records my decisions and failure analysis.</span></label>
      <button class="primary-button" type="button" data-score-mock>Record mock score</button><div class="mock-score-readout">${saved.percent !== undefined ? `<strong>${saved.percent}%</strong><span>${saved.percent >= 70 ? "Promising self-score; verify the weakest row" : "Schedule another rep"}</span>` : "Score every row after completing the rep."}</div>
      ${saved.percent !== undefined ? renderMockRetrospective(mock, saved) : ""}
    </section>`;
  }

  function renderMock(mock) {
    if (!activeTimer || activeTimer.mockId !== mock.id) activeTimer = freshMockTimer(mock);
    syncActiveTimer();
    const historical = state.mockScores[mock.id] || { scores: {} };
    const saved = historical.attemptId && historical.attemptId === activeTimer.attemptId ? historical : { scores: {} };
    const notes = state.mockNotes[mock.id] || "";
    const checkpoints = mockCheckpointPlan(mock);
    const designStudioId = mock.track === "gateway-design" ? "gateway" : mock.track === "crawler-design" ? "crawler" : null;
    renderBreadcrumbs([{ label: "Control room", route: "home" }, { label: trackLabels[mock.track] }, { label: "Mock interview" }]);
    view.innerHTML = `
      <section class="mock-view" data-mock-id="${escapeAttr(mock.id)}">
        <header class="mock-header">
          <div><span class="eyebrow">${escapeHTML(trackLabels[mock.track])} · timed rehearsal</span><h1 tabindex="-1">${escapeHTML(mock.title)}</h1><p>${escapeHTML(mock.artifact)}</p></div>
          <div class="mock-timer" data-timer><output>${formatClock(activeTimer.remaining)}</output><div><button class="primary-button compact" type="button" data-timer-toggle ${activeTimer.remaining === 0 ? "disabled" : ""}>${activeTimer.remaining === 0 ? "Timer complete" : activeTimer.running ? "Pause" : "Start timer"}</button><button class="quiet-button" type="button" data-timer-reset>Reset</button></div></div>
        </header>
        <ol class="mock-checkpoints" aria-label="Timed checkpoints">${checkpoints.map((checkpoint) => `<li data-checkpoint-at="${checkpoint.at}" class="${activeTimer.elapsed >= checkpoint.at ? "reached" : ""}"><span>${formatClock(checkpoint.at)}</span><strong>${escapeHTML(checkpoint.label)}</strong></li>`).join("")}</ol>
        <section class="mock-prompt" aria-labelledby="mock-prompt-title"><span class="eyebrow">Candidate prompt</span><h2 id="mock-prompt-title">Design or build from this brief</h2><p>${escapeHTML(mock.prompt)}</p></section>
        ${mock.id === "ai-gateway-coding" ? `<section class="mock-code-rep" aria-labelledby="mock-code-title"><div class="section-heading"><div><span class="eyebrow">Timed implementation</span><h2 id="mock-code-title">Write and test the request path here</h2></div></div>${renderCodeLab(moduleById.get("coding-execution"))}</section>` : ""}
        ${mock.id === "ai-gateway-coding" ? `<section class="mock-benchmark-rep" aria-labelledby="mock-benchmark-title"><div class="section-heading"><div><span class="eyebrow">Measured comparison</span><h2 id="mock-benchmark-title">Run the benchmark checkpoints here</h2><p>Save two adaptive-routing runs and two concurrency runs. Each pair needs one changed control, a pre-run hypothesis, and a post-run decision.</p></div></div>${renderGatewayConsole("lab-adaptive-routing", false)}${renderGatewayConsole("lab-concurrency-resilience", false)}</section>` : ""}
        ${designStudioId ? renderSystemDesignStudio(designStudioId, { mockId: mock.id }) : ""}
        <div class="mock-layout">
          <section class="mock-work"><label><span>${designStudioId ? "Scratchpad for interviewer answers" : "Whiteboard or coding notes"}</span><textarea data-mock-notes placeholder="${designStudioId ? "Questions, changed assumptions, calculations, and interviewer feedback..." : "Requirements, estimates, invariants, decisions, failure behavior..."}">${escapeHTML(notes)}</textarea></label><div class="followup-deck"><h2>Checkpoint follow-ups</h2>${mock.followups.map((followup, index) => { const unlockAt = mockFollowupUnlockAt(mock, index); const unlocked = activeTimer.elapsed >= unlockAt; return `<div class="followup-card" data-followup-index="${index}" data-unlock-at="${unlockAt}"><div class="followup-locked" ${unlocked ? "hidden" : ""}><span>Card ${index + 1}</span><small>Unlocks at ${formatClock(unlockAt)}</small></div><details ${unlocked ? "" : "hidden"}><summary>Card ${index + 1}</summary><p>${escapeHTML(followup)}</p></details></div>`; }).join("")}</div></section>
          ${renderMockRubric(mock, saved)}
        </div>
        ${designStudioId && saved.percent !== undefined ? renderMockDesignReference(designStudioId) : ""}
      </section>
    `;
    applyMockAttemptControlLock();
    if (activeTimer.running) startTimerInterval();
    saveState();
  }

  function renderMockDesignReference(studioId) {
    const studio = systemDesignStudios[studioId];
    if (!studio) return "";
    return `
      <section class="mock-reference" aria-labelledby="mock-reference-${escapeAttr(studioId)}">
        <div class="section-heading"><div><span class="eyebrow">Open after scoring</span><h2 id="mock-reference-${escapeAttr(studioId)}">Compare every artifact, then choose one revision</h2><p>This is one defensible design under the practice assumptions. Compare its reasoning with your board and keep an alternative when its cost fits a different requirement.</p></div></div>
        <div class="mock-reference-phases">
          ${studio.phases.map((phase) => `<details><summary><span>${escapeHTML(phase.number)}</span><strong>${escapeHTML(phase.short)}</strong><small>${escapeHTML(phase.title)}</small></summary><p>${escapeHTML(phase.coach.lead)}</p><div class="studio-reference-table">${phase.coach.rows.map((row) => `<div class="studio-reference-row"><strong data-label="Decision">${escapeHTML(row[0])}</strong><span data-label="One defensible answer">${escapeHTML(row[1])}</span><span data-label="Why it follows">${escapeHTML(row[2])}</span></div>`).join("")}</div></details>`).join("")}
        </div>
        ${renderWorkedTopology(studio)}
        ${renderArchitectureEvolution(studio)}
        ${renderDesignTradeoffs(studio)}
      </section>
    `;
  }

  function freshMockTimer(mock) {
    return {
      mockId: mock.id,
      remaining: mock.minutes * 60,
      running: false,
      started: false,
      elapsed: 0,
      startedAt: null,
      endedAt: null,
      attemptId: null,
      rubricRevealed: false,
      elapsedAtRunStart: 0,
      runStartedAtMs: null
    };
  }

  function mockObjectiveEvidence(mock) {
    const timerUsed = activeTimer?.mockId === mock.id && Number(activeTimer.elapsed || 0) >= mock.minutes * 60;
    const attemptStartedAt = activeTimer?.startedAt || null;
    const attemptEndedAt = activeTimer?.endedAt || null;
    const attemptId = activeTimer?.attemptId || null;
    const withinAttempt = (value) => {
      const timestamp = new Date(value || 0).getTime();
      const startedAt = new Date(attemptStartedAt || 0).getTime();
      const endedAt = new Date(attemptEndedAt || 0).getTime();
      return endedAt > startedAt && timestamp >= startedAt && timestamp <= endedAt;
    };
    const items = [{
      ok: timerUsed,
      label: timerUsed ? `Full ${mock.minutes}-minute timer completed` : `Complete the ${mock.minutes}-minute timer`
    }];
    if (mock.id !== "ai-gateway-coding") return [...mockDesignObjectiveEvidence(mock), ...items];
    const codeResult = state.codeResults["build-gateway"];
    const currentSource = state.codeDrafts["build-gateway"] || codeExercises["coding-execution"].starter;
    const codeIsFresh = Boolean(
      attemptStartedAt
      && codeResult?.passed === true
      && codeResult.attemptId === attemptId
      && codeResult.sourceFingerprint === Sim.stableFingerprint({ source: currentSource })
      && withinAttempt(codeResult.ranAt)
    );
    return [
      {
        ok: codeIsFresh,
        label: "Current gateway source passes every browser test in this attempt",
        route: "lab/coding-execution"
      },
      {
        ok: Boolean(gatewayComparisonEvidence("adaptive-routing", attemptStartedAt, attemptEndedAt, attemptId)),
        label: "Fresh adaptive-routing comparison includes a measured change and decision",
        route: "lab/adaptive-routing"
      },
      {
        ok: Boolean(gatewayComparisonEvidence("concurrency-resilience", attemptStartedAt, attemptEndedAt, attemptId)),
        label: "Fresh concurrency comparison includes a measured change and decision",
        route: "lab/concurrency-resilience"
      },
      ...items
    ];
  }

  function mockDesignObjectiveEvidence(mock) {
    const studioId = mock.track === "gateway-design" ? "gateway" : mock.track === "crawler-design" ? "crawler" : null;
    const studio = studioId ? systemDesignStudios[studioId] : null;
    const workbook = state.mockDesignWorkbooks[mock.id];
    const startedAt = new Date(activeTimer?.startedAt || 0).getTime();
    const endedAt = new Date(activeTimer?.endedAt || 0).getTime();
    const attemptMatches = Boolean(workbook && workbook.attemptId === activeTimer?.attemptId);
    const withinAttempt = (value) => {
      const timestamp = new Date(value || 0).getTime();
      return endedAt > startedAt && timestamp >= startedAt && timestamp <= endedAt;
    };
    const fresh = (phaseId) => {
      const phase = studio?.phases.find((entry) => entry.id === phaseId);
      const record = workbook?.phases?.[phaseId];
      return Boolean(
        attemptMatches
        && phase
        && record
        && designPhaseComplete(phase, record)
        && withinAttempt(record.verifiedAt)
        && phase.fields.every((field) => withinAttempt(record.fieldUpdatedAt?.[field.id]))
      );
    };
    if (!studio) return [];
    return [
      { ok: fresh("scope") && fresh("requirements"), label: "Fresh scope, functional requirements, non-functional requirements, assumptions, and non-goals" },
      { ok: fresh("scale") && fresh("entities"), label: "Fresh capacity worksheet, entity ownership model, and API or event contracts" },
      { ok: fresh("sketch") && fresh("evolve"), label: "Fresh healthy trace, first architecture, state ownership, and scaled failure behavior" },
      { ok: fresh("defend"), label: "Fresh failure walks, trade-off reversals, and two-minute recap" }
    ];
  }

  function formatClock(seconds) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function renderMockRetrospective(mock, saved) {
    const rows = mock.rubric.map((item, index) => ({ ...item, score: Number(saved.scores?.[index] ?? 0) }));
    const lowest = Math.min(...rows.map((row) => row.score));
    const gaps = rows.filter((row) => row.score === lowest).map((row) => row.label);
    return `<div class="mock-retrospective"><strong>Next evidence target</strong><p>Revisit ${escapeHTML(gaps.join(" and "))}. Record one concrete behavior that would raise the score on the next rep.</p></div>`;
  }

  function startTimerInterval() {
    stopTimer(false);
    if (!activeTimer?.running) return;
    timerInterval = setInterval(() => {
      if (!activeTimer?.running) return;
      refreshTimerDisplay(true);
    }, 1000);
  }

  function syncActiveTimer(nowMs = Date.now()) {
    if (!activeTimer?.running) return;
    const mock = mockById.get(activeTimer.mockId);
    if (!mock) return;
    const total = mock.minutes * 60;
    if (!Number.isFinite(activeTimer.runStartedAtMs)) {
      activeTimer.runStartedAtMs = nowMs;
      activeTimer.elapsedAtRunStart = activeTimer.elapsed;
    }
    const segmentSeconds = Math.max(0, Math.floor((nowMs - activeTimer.runStartedAtMs) / 1000));
    activeTimer.elapsed = Math.min(total, Number(activeTimer.elapsedAtRunStart || 0) + segmentSeconds);
    activeTimer.remaining = Math.max(0, total - activeTimer.elapsed);
    if (activeTimer.remaining === 0) {
      if (!activeTimer.endedAt) {
        const remainingAtRunStart = Math.max(0, total - Number(activeTimer.elapsedAtRunStart || 0));
        activeTimer.endedAt = new Date(Number(activeTimer.runStartedAtMs || nowMs) + remainingAtRunStart * 1000).toISOString();
      }
      activeTimer.running = false;
      activeTimer.elapsedAtRunStart = activeTimer.elapsed;
      activeTimer.runStartedAtMs = null;
    }
  }

  function refreshTimerDisplay(announceCompletion = false) {
    if (!activeTimer) return;
    const wasRunning = activeTimer.running;
    syncActiveTimer();
    const output = document.querySelector("[data-timer] output");
    if (output) output.textContent = formatClock(activeTimer.remaining);
    updateMockTimedReveals();
    const button = document.querySelector("[data-timer-toggle]");
    if (button) {
      button.textContent = activeTimer.remaining === 0 ? "Timer complete" : activeTimer.running ? "Pause" : "Start timer";
      button.disabled = activeTimer.remaining === 0;
    }
    saveState();
    if (wasRunning && !activeTimer.running && activeTimer.remaining === 0) {
      stopTimer(false);
      if (announceCompletion) {
        announce("Mock timer complete.");
        showToast("Time. Finish the sentence you are on.");
      }
    }
  }

  function updateMockTimedReveals() {
    if (!activeTimer) return;
    document.querySelectorAll("[data-checkpoint-at]").forEach((checkpoint) => {
      checkpoint.classList.toggle("reached", activeTimer.elapsed >= Number(checkpoint.dataset.checkpointAt));
    });
    document.querySelectorAll("[data-unlock-at]").forEach((card) => {
      const unlocked = activeTimer.elapsed >= Number(card.dataset.unlockAt);
      const locked = card.querySelector(".followup-locked");
      const details = card.querySelector("details");
      if (locked) locked.hidden = unlocked;
      if (details) details.hidden = !unlocked;
    });
    const reveal = document.querySelector("[data-reveal-rubric]");
    if (reveal) {
      const ready = activeTimer.remaining === 0;
      reveal.disabled = !ready;
      reveal.textContent = ready ? "Reveal rubric" : `Available after ${formatClock(activeTimer.remaining)}`;
    }
    if (activeTimer.remaining === 0) {
      const root = document.querySelector(`[data-studio-mock="${CSS.escape(activeTimer.mockId)}"]`);
      root?.querySelectorAll("[data-studio-field], [data-studio-option], [data-studio-node-input], [data-studio-add-node], [data-studio-node-action], [data-check-studio-phase]").forEach((control) => {
        control.disabled = true;
      });
      const status = root?.querySelector("[data-studio-phase-status]");
      if (status) status.textContent = "Time is complete. This attempt is frozen for scoring.";
    }
    applyMockAttemptControlLock();
  }

  function applyMockAttemptControlLock() {
    const root = document.querySelector(".mock-view");
    if (!root || !activeTimer) return;
    const locked = !activeTimer.started || !activeTimer.running || activeTimer.remaining === 0;
    root.querySelectorAll([
      ".mock-code-rep input",
      ".mock-code-rep textarea",
      ".mock-code-rep select",
      ".mock-code-rep button",
      ".mock-benchmark-rep input",
      ".mock-benchmark-rep textarea",
      ".mock-benchmark-rep select",
      ".mock-benchmark-rep button",
      "[data-mock-notes]"
    ].join(", ")).forEach((control) => {
      control.disabled = locked;
    });
  }

  function stopTimer(clearRunning = true) {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    if (clearRunning && activeTimer) {
      syncActiveTimer();
      activeTimer.running = false;
      activeTimer.elapsedAtRunStart = activeTimer.elapsed;
      activeTimer.runStartedAtMs = null;
      saveState();
    }
  }

  function renderNotebook() {
    renderBreadcrumbs([{ label: "Control room", route: "home" }, { label: "Interview notebook" }]);
    view.innerHTML = `
      <section class="notebook-view">
        <header class="notebook-header"><div><span class="eyebrow">Saved evidence</span><h1 tabindex="-1">Interview notebook</h1><p>Keep strategy changes, fixed inputs, results, and what you learned in one place.</p></div><div class="notebook-actions"><button class="secondary-button" type="button" data-copy-notebook>Copy as Markdown</button><button class="quiet-button" type="button" data-export-progress>Export JSON</button><label class="quiet-button file-button">Import JSON<input type="file" accept="application/json" data-import-progress></label></div></header>
        <section class="benchmark-ledger" aria-labelledby="ledger-title"><div class="section-heading"><div><span class="eyebrow">Gateway benchmark ledger</span><h2 id="ledger-title">One change per run</h2></div></div>
          ${state.benchmarks.length ? `<div class="table-scroll"><table><thead><tr><th>Compare</th><th>Policy</th><th>Scenario</th><th>Success</th><th>Success p95</th><th>Achieved RPS</th><th>Calls/request</th><th>Hypothesis and result</th><th></th></tr></thead><tbody>${state.benchmarks.map((run, index) => `<tr><td><input type="checkbox" data-compare-run="${index}" aria-label="Compare run ${index + 1}"></td><td><strong>${escapeHTML(gatewayPolicyLabels[run.config?.policy] || run.config?.policy || "Policy")}</strong><small>${escapeHTML(run.moduleId || "unscoped")} · ${escapeHTML(run.fingerprint || "")}</small></td><td>${escapeHTML(gatewayScenarioLabels[run.config?.scenario] || run.config?.scenario || "-")}</td><td>${valueOr(run.metrics?.successRate, 0)}%</td><td>${valueOr(run.metrics?.successP95 ?? run.metrics?.p95, 0)} ms</td><td>${valueOr(run.metrics?.achievedRps, 0)}</td><td>${valueOr(run.metrics?.attemptsPerRequest, 0)}</td><td><p class="benchmark-hypothesis-copy"><strong>Before:</strong> ${escapeHTML(run.hypothesis || "Legacy run without a written hypothesis.")}</p><textarea data-benchmark-note="${index}" aria-label="Result note for run ${index + 1}" placeholder="After: what happened, and why?">${escapeHTML(run.note || "")}</textarea></td><td><button class="icon-button" type="button" data-delete-run="${index}" aria-label="Delete run ${index + 1}">×</button></td></tr>`).join("")}</tbody></table></div><div class="compare-bar"><button class="primary-button compact" type="button" data-compare-selected>Compare two runs</button><p data-compare-output>Select a baseline first and its candidate second.</p></div>` : `<div class="empty-state compact"><h3>No saved runs yet.</h3><p>Open the adaptive routing lab, keep one scenario and seed fixed, and save a baseline.</p><button class="primary-button compact" type="button" data-route="lab/adaptive-routing">Open gateway lab</button></div>`}
        </section>
        <section class="artifact-grid" aria-labelledby="artifact-title"><div class="section-heading"><div><span class="eyebrow">Mock artifacts</span><h2 id="artifact-title">Scores and next gaps</h2></div></div><div class="mock-card-grid">${course.mocks.map((mock) => { const saved = state.mockScores[mock.id]; return `<article><span>${escapeHTML(trackLabels[mock.track])}</span><h3>${escapeHTML(mock.title)}</h3><strong>${saved ? `${saved.percent}%` : "Not scored"}</strong><p>${escapeHTML(mock.artifact)}</p><button class="text-button" type="button" data-route="mock/${mock.id}">${saved ? "Run another rep" : "Start mock"} →</button></article>`; }).join("")}</div></section>
      </section>
    `;
  }

  const searchIndex = [
    ...course.modules.map((module) => ({ title: module.title, subtitle: `${moduleTrackLabel(module)} module`, route: `module/${module.id}`, terms: `${module.description} ${module.outcomes.join(" ")}` })),
    ...allLessons.map(({ lesson, module }) => ({ title: lesson.title, subtitle: `${moduleTrackLabel(module)} · Module ${module.number}`, route: `lesson/${lesson.id}`, terms: `${lesson.summary} ${lesson.core.join(" ")} ${lesson.mechanics.map((item) => `${item.title} ${item.text}`).join(" ")}` })),
    ...course.mocks.map((mock) => ({ title: mock.title, subtitle: `${trackLabels[mock.track]} mock`, route: `mock/${mock.id}`, terms: `${mock.prompt} ${mock.followups.join(" ")}` }))
  ];

  function searchMatches(query) {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return searchIndex.slice(0, 10);
    const terms = normalized.split(/\s+/).filter(Boolean);
    return searchIndex
      .map((item) => {
        const title = item.title.toLowerCase();
        const haystack = `${item.title} ${item.subtitle} ${item.terms}`.toLowerCase();
        const matches = terms.filter((term) => haystack.includes(term)).length;
        const score = matches * 4 + terms.filter((term) => title.includes(term)).length * 5 + Number(title.startsWith(normalized)) * 6;
        return { item, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.item.title.localeCompare(b.item.title))
      .slice(0, 12)
      .map(({ item }) => item);
  }

  function renderSearchResults(query = "") {
    const matches = searchMatches(query);
    activeSearchIndex = Math.min(activeSearchIndex, Math.max(0, matches.length - 1));
    searchInput.setAttribute("aria-expanded", String(matches.length > 0));
    searchResults.innerHTML = matches.length
      ? matches.map((item, index) => `<button type="button" role="option" aria-selected="${index === activeSearchIndex}" class="search-result ${index === activeSearchIndex ? "active" : ""}" data-search-route="${escapeAttr(item.route)}"><span>${escapeHTML(item.title)}</span><small>${escapeHTML(item.subtitle)}</small></button>`).join("")
      : `<div class="search-empty"><strong>No match</strong><span>Try provider, deadline, frontier, robots, or quota.</span></div>`;
  }

  function openSearch() {
    if (!searchDialog?.open) searchDialog.showModal();
    activeSearchIndex = 0;
    searchInput.value = "";
    renderSearchResults();
    requestAnimationFrame(() => searchInput.focus());
  }

  function closeSearch() {
    if (searchDialog?.open) searchDialog.close();
    document.querySelector("#search-trigger")?.focus();
  }

  function setMobileMap(open) {
    const mobile = matchMedia("(max-width: 820px)").matches;
    const stage = document.querySelector(".course-stage");
    document.body.classList.toggle("map-open", open);
    document.querySelector("#mobile-map-trigger")?.setAttribute("aria-expanded", String(open));
    if (rail) rail.setAttribute("aria-hidden", String(!open && mobile));
    if (stage) {
      stage.inert = Boolean(open && mobile);
      if (open && mobile) stage.setAttribute("aria-hidden", "true");
      else stage.removeAttribute("aria-hidden");
    }
    if (open) document.querySelector("#mobile-map-close")?.focus();
  }

  async function runCodeExercise(exerciseId, code) {
    const exercise = Object.values(codeExercises).find((item) => item.id === exerciseId);
    if (!exercise) throw new Error("Unknown exercise");
    const workerSource = `
      (() => {
      const reportToHost = self.postMessage.bind(self);
      const safeStringify = JSON.stringify.bind(JSON);
      const safeFreeze = Object.freeze.bind(Object);
      const safeDefineProperty = Object.defineProperty.bind(Object);
      const safeReflectApply = Reflect.apply.bind(Reflect);
      const arrayPush = Array.prototype.push;
      const arrayFilter = Array.prototype.filter;
      const safePush = (target, value) => safeReflectApply(arrayPush, target, [safeFreeze(value)]);
      const safeFilter = (target, predicate) => safeReflectApply(arrayFilter, target, [predicate]);
      const guardedGlobals = [["Object", Object], ["Array", Array], ["Boolean", Boolean], ["Function", Function], ["Promise", Promise], ["Error", Error], ["Map", Map], ["Number", Number], ["Set", Set], ["String", String], ["JSON", JSON], ["Math", Math], ["Reflect", Reflect]];
      for (const [name, value] of guardedGlobals) {
        safeFreeze(value.prototype || value);
        safeFreeze(value);
        safeDefineProperty(self, name, { value, configurable: false, writable: false });
      }
      safeDefineProperty(self, "postMessage", { value: () => { throw new Error("Candidate code cannot send worker messages"); }, configurable: false, writable: false });
      safeDefineProperty(self, "close", { value: () => { throw new Error("Candidate code cannot stop the grader"); }, configurable: false, writable: false });
      const blockedGlobals = ["Date", "performance", "setTimeout", "setInterval", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "importScripts"];
      for (const name of blockedGlobals) {
        try { safeDefineProperty(self, name, { value: undefined, configurable: false, writable: false }); } catch { self[name] = undefined; }
      }
      self.onmessage = async (event) => {
        const data = event.data;
        const cases = [];
        const equal = (a, b) => safeStringify(a) === safeStringify(b);
        const check = async (name, run, expected) => {
          try {
            const actual = await run();
            safePush(cases, { name, ok: equal(actual, expected), message: equal(actual, expected) ? "" : "Expected " + safeStringify(expected) + ", received " + safeStringify(actual) });
          } catch (error) {
            safePush(cases, { name, ok: false, message: error?.message || String(error) });
          }
        };
        try {
          const factory = new Function(data.code + "\\nreturn typeof " + data.functionName + " === 'function' ? " + data.functionName + " : null;");
          const fn = factory();
          if (!fn) throw new Error("Define " + data.functionName + " as a function");
          if (data.exerciseId === "classify-attempt") {
            await check("200 is success", () => fn({ status: 200 }), "success");
            await check("400 is a caller error", () => fn({ status: 400 }), "caller_error");
            await check("429 is provider overload", () => fn({ status: 429, retryAfterMs: 5000 }), "provider_overload");
            await check("500 is provider failure", () => fn({ status: 500 }), "provider_failure");
            await check("transport timeout is provider failure", () => fn({ transportError: "timeout" }), "provider_failure");
            await check("caller cancellation is neutral", () => fn({ cancelledBy: "caller" }), "neutral");
            await check("losing hedge is neutral", () => fn({ cancelledBy: "hedge_winner" }), "neutral");
          } else if (data.exerciseId === "build-gateway") {
            const providerState = (id, score, overrides = {}) => ({ id, score, cooldownUntil: 0, inFlight: 0, maxConcurrency: 1, ...overrides });
            const response = (body, status = 200, elapsedMs = 10) => ({ status, body, elapsedMs });
            const errorResult = async (promise) => {
              try {
                await promise;
                return "resolved";
              } catch (error) {
                return error?.name === "AbortError" ? "AbortError:" + error.message : error?.message || String(error);
              }
            };

            await check("lower score wins with a deterministic ID tie-break", async () => {
              const states = [providerState("B", 1), providerState("A", 1)];
              const gateway = fn({ providers: { A: async () => response("from-a"), B: async () => response("from-b") }, states, maxActive: 2 });
              return gateway.handle({ id: "r1", deadlineAtMs: 500, nowMs: 0 });
            }, { status: 200, body: "from-a", provider: "A", attempts: ["A"] });

            await check("cooldown excludes a provider", async () => {
              const states = [providerState("A", 1, { cooldownUntil: 100 }), providerState("B", 2)];
              const gateway = fn({ providers: { A: async () => response("from-a"), B: async () => response("from-b") }, states, maxActive: 2 });
              return gateway.handle({ id: "r2", deadlineAtMs: 550, nowMs: 50 });
            }, { status: 200, body: "from-b", provider: "B", attempts: ["B"] });

            await check("retryable failure falls back with the remaining deadline", async () => {
              let bDeadline = 0;
              const states = [providerState("A", 1), providerState("B", 2)];
              const gateway = fn({
                providers: {
                  A: async () => response("busy", 503, 80),
                  B: async (attempt) => { bDeadline = attempt.deadlineMs; return response("ok", 200, 120); }
                },
                states,
                maxActive: 2
              });
              const result = await gateway.handle({ id: "r3", deadlineAtMs: 500, nowMs: 0 });
              return { result, bDeadline, inFlight: states.map((item) => item.inFlight) };
            }, { result: { status: 200, body: "ok", provider: "B", attempts: ["A", "B"] }, bDeadline: 420, inFlight: [0, 0] });

            await check("deadline exhaustion stops fallback and releases admission", async () => {
              let bCalls = 0;
              let aCalls = 0;
              const states = [providerState("A", 1), providerState("B", 2)];
              const gateway = fn({ providers: { A: async () => { aCalls += 1; return aCalls === 1 ? response("busy", 503, 100) : response("recovered"); }, B: async () => { bCalls += 1; return response("recovered"); } }, states, maxActive: 1 });
              const outcome = await errorResult(gateway.handle({ id: "r4", deadlineAtMs: 100, nowMs: 0 }));
              const bCallsBeforeRecovery = bCalls;
              const recovered = await gateway.handle({ id: "r4b", deadlineAtMs: 10500, nowMs: 10000 });
              return { outcome, bCallsBeforeRecovery, recoveredStatus: recovered.status, inFlight: states.map((item) => item.inFlight) };
            }, { outcome: "deadline_exhausted", bCallsBeforeRecovery: 0, recoveredStatus: 200, inFlight: [0, 0] });

            await check("caller error does not fall back", async () => {
              let bCalls = 0;
              const outcomes = [];
              const states = [providerState("A", 1), providerState("B", 2)];
              const gateway = fn({ providers: { A: async () => response("bad input", 400, 8), B: async () => { bCalls += 1; return response("wrong"); } }, states, maxActive: 2, recordOutcome: (outcome) => outcomes.push(outcome) });
              const result = await gateway.handle({ id: "r5", deadlineAtMs: 500, nowMs: 0 });
              return { result, bCalls, outcomes, inFlight: states.map((item) => item.inFlight) };
            }, { result: { status: 400, body: "bad input", provider: "A", attempts: ["A"] }, bCalls: 0, outcomes: [{ provider: "A", status: 400, elapsedMs: 8 }], inFlight: [0, 0] });

            await check("429 is retryable provider overload", async () => {
              const outcomes = [];
              const states = [providerState("A", 1), providerState("B", 2)];
              const gateway = fn({ providers: { A: async () => response("busy", 429, 20), B: async (attempt) => response(attempt.deadlineMs, 200, 30) }, states, maxActive: 1, recordOutcome: (outcome) => outcomes.push(outcome) });
              const result = await gateway.handle({ id: "r5b", deadlineAtMs: 500, nowMs: 0 });
              return { result, outcomes, inFlight: states.map((item) => item.inFlight) };
            }, { result: { status: 200, body: 480, provider: "B", attempts: ["A", "B"] }, outcomes: [{ provider: "A", status: 429, elapsedMs: 20 }, { provider: "B", status: 200, elapsedMs: 30 }], inFlight: [0, 0] });

            await check("application cap rejects overlap and later recovers", async () => {
              let release;
              let calls = 0;
              const pending = new Promise((resolve) => { release = resolve; });
              const states = [providerState("A", 1, { maxConcurrency: 2 })];
              const gateway = fn({ providers: { A: async () => { calls += 1; return calls === 1 ? pending : response("next"); } }, states, maxActive: 1 });
              const first = gateway.handle({ id: "r6a", deadlineAtMs: 500, nowMs: 0 });
              await Promise.resolve();
              const overlap = await errorResult(gateway.handle({ id: "r6b", deadlineAtMs: 500, nowMs: 0 }));
              release(response("first"));
              await first;
              const next = await gateway.handle({ id: "r6c", deadlineAtMs: 500, nowMs: 0 });
              return { overlap, next, inFlight: states[0].inFlight };
            }, { overlap: "gateway_overloaded", next: { status: 200, body: "next", provider: "A", attempts: ["A"] }, inFlight: 0 });

            await check("provider cap sends concurrent work to another eligible provider", async () => {
              let release;
              const pending = new Promise((resolve) => { release = resolve; });
              const states = [providerState("A", 1), providerState("B", 2)];
              const gateway = fn({ providers: { A: async () => pending, B: async () => response("second") }, states, maxActive: 2 });
              const first = gateway.handle({ id: "r7a", deadlineAtMs: 500, nowMs: 0 });
              await Promise.resolve();
              const second = await gateway.handle({ id: "r7b", deadlineAtMs: 500, nowMs: 0 });
              release(response("first"));
              const firstResult = await first;
              return { providers: [firstResult.provider, second.provider], inFlight: states.map((item) => item.inFlight) };
            }, { providers: ["A", "B"], inFlight: [0, 0] });

            await check("caller cancellation does not fall back and releases permits", async () => {
              let bCalls = 0;
              let aCalls = 0;
              const states = [providerState("A", 1), providerState("B", 2)];
              const cancelled = new Error("caller_cancelled");
              safeDefineProperty(cancelled, "name", { value: "AbortError" });
              const gateway = fn({ providers: { A: async () => { aCalls += 1; if (aCalls === 1) throw cancelled; return response("recovered"); }, B: async () => { bCalls += 1; return response("recovered"); } }, states, maxActive: 1 });
              const outcome = await errorResult(gateway.handle({ id: "r8", deadlineAtMs: 500, nowMs: 0 }));
              const bCallsBeforeRecovery = bCalls;
              const recovered = await gateway.handle({ id: "r8b", deadlineAtMs: 10500, nowMs: 10000 });
              return { outcome, bCallsBeforeRecovery, recoveredStatus: recovered.status, inFlight: states.map((item) => item.inFlight) };
            }, { outcome: "AbortError:caller_cancelled", bCallsBeforeRecovery: 0, recoveredStatus: 200, inFlight: [0, 0] });

            await check("an already expired absolute deadline starts no provider", async () => {
              let calls = 0;
              const states = [providerState("A", 1), providerState("B", 2)];
              const gateway = fn({ providers: { A: async () => { calls += 1; return response("late"); }, B: async () => { calls += 1; return response("late"); } }, states, maxActive: 1 });
              const outcome = await errorResult(gateway.handle({ id: "r9", deadlineAtMs: 500, nowMs: 501 }));
              const recovered = await gateway.handle({ id: "r9b", deadlineAtMs: 1100, nowMs: 600 });
              return { outcome, calls, recoveredStatus: recovered.status, inFlight: states.map((item) => item.inFlight) };
            }, { outcome: "deadline_exhausted", calls: 1, recoveredStatus: 200, inFlight: [0, 0] });

            await check("ordinary provider errors fall back and release every permit", async () => {
              let aCalls = 0;
              const states = [providerState("A", 1), providerState("B", 2)];
              const gateway = fn({ providers: { A: async () => { aCalls += 1; if (aCalls === 1) throw new Error("socket_reset"); return response("again"); }, B: async () => response("fallback") }, states, maxActive: 1 });
              const first = await gateway.handle({ id: "r10", deadlineAtMs: 500, nowMs: 0 });
              const second = await gateway.handle({ id: "r10b", deadlineAtMs: 1100, nowMs: 600 });
              return { first, secondStatus: second.status, inFlight: states.map((item) => item.inFlight) };
            }, { first: { status: 200, body: "fallback", provider: "B", attempts: ["A", "B"] }, secondStatus: 200, inFlight: [0, 0] });

            await check("a final transport error propagates after cleanup", async () => {
              let fail = true;
              const states = [providerState("A", 1), providerState("B", 2)];
              const gateway = fn({ providers: { A: async () => { if (fail) throw new Error("a_reset"); return response("recovered"); }, B: async () => { throw new Error("b_reset"); } }, states, maxActive: 1 });
              const outcome = await errorResult(gateway.handle({ id: "r10c", deadlineAtMs: 500, nowMs: 0 }));
              fail = false;
              const recovered = await gateway.handle({ id: "r10d", deadlineAtMs: 1100, nowMs: 600 });
              return { outcome, recoveredStatus: recovered.status, inFlight: states.map((item) => item.inFlight) };
            }, { outcome: "b_reset", recoveredStatus: 200, inFlight: [0, 0] });

            await check("a result after the absolute deadline is rejected", async () => {
              let late = true;
              let bCalls = 0;
              const states = [providerState("A", 1), providerState("B", 2)];
              const gateway = fn({ providers: { A: async () => late ? response("too late", 200, 501) : response("recovered"), B: async () => { bCalls += 1; return response("wrong"); } }, states, maxActive: 1 });
              const outcome = await errorResult(gateway.handle({ id: "r10e", deadlineAtMs: 500, nowMs: 0 }));
              late = false;
              const recovered = await gateway.handle({ id: "r10f", deadlineAtMs: 1100, nowMs: 600 });
              return { outcome, bCalls, recoveredStatus: recovered.status, inFlight: states.map((item) => item.inFlight) };
            }, { outcome: "deadline_exhausted", bCalls: 0, recoveredStatus: 200, inFlight: [0, 0] });

            await check("no eligible provider fails before transport", async () => {
              let calls = 0;
              const states = [providerState("A", 1, { cooldownUntil: 1000 }), providerState("B", 2, { inFlight: 1 })];
              const gateway = fn({ providers: { A: async () => { calls += 1; return response("a"); }, B: async () => { calls += 1; return response("b"); } }, states, maxActive: 1 });
              const outcome = await errorResult(gateway.handle({ id: "r11", deadlineAtMs: 500, nowMs: 0 }));
              states[0].cooldownUntil = 0;
              states[1].inFlight = 0;
              const recovered = await gateway.handle({ id: "r11b", deadlineAtMs: 1100, nowMs: 600 });
              return { outcome, calls, recoveredStatus: recovered.status, inFlight: states.map((item) => item.inFlight) };
            }, { outcome: "no_eligible_provider", calls: 1, recoveredStatus: 200, inFlight: [0, 0] });

            await check("every provider result crosses the adaptive feedback boundary", async () => {
              const outcomes = [];
              const states = [providerState("A", 1), providerState("B", 2)];
              const gateway = fn({ providers: { A: async () => response("busy", 503, 20), B: async () => response("ok", 200, 30) }, states, maxActive: 1, recordOutcome: (outcome) => outcomes.push(outcome) });
              const result = await gateway.handle({ id: "r12", deadlineAtMs: 500, nowMs: 0 });
              return { result, outcomes };
            }, { result: { status: 200, body: "ok", provider: "B", attempts: ["A", "B"] }, outcomes: [{ provider: "A", status: 503, elapsedMs: 20 }, { provider: "B", status: 200, elapsedMs: 30 }] });
          } else {
            const base = [
              { id: "A", cooldownUntil: 0, inFlight: 0, maxConcurrency: 2, lastSampleAt: 90, latencyEWMA: 80, failureEWMA: 0.3 },
              { id: "B", cooldownUntil: 0, inFlight: 0, maxConcurrency: 2, lastSampleAt: 100, latencyEWMA: 110, failureEWMA: 0.0 }
            ];
            await check("lower error-aware score wins", () => fn(base, { sequence: 1, nowMs: 200 }), "B");
            await check("cooldown provider is excluded", () => fn([{ ...base[0], cooldownUntil: 300 }, base[1]], { sequence: 1, nowMs: 200 }), "B");
            await check("saturated provider is excluded", () => fn([base[0], { ...base[1], inFlight: 2 }], { sequence: 1, nowMs: 200 }), "A");
            await check("every tenth request explores oldest sample", () => fn(base, { sequence: 10, nowMs: 200 }), "A");
            await check("no eligible provider returns null", () => fn(base.map((item) => ({ ...item, inFlight: 2 })), { sequence: 1, nowMs: 200 }), null);
            const tie = base.map((item) => ({ ...item, latencyEWMA: 100, failureEWMA: 0, lastSampleAt: 50 }));
            await check("ties are deterministic", () => fn(tie, { sequence: 1, nowMs: 200 }), "A");
          }
          const passedCount = safeFilter(cases, (item) => item.ok === true).length;
          reportToHost({ nonce: data.nonce, cases, passedCount, failed: cases.length - passedCount, total: cases.length, passed: passedCount === cases.length });
        } catch (error) {
          reportToHost({ nonce: data.nonce, fatal: true, cases: [{ name: "Load solution", ok: false, message: error?.message || String(error) }], passedCount: 0, failed: 1, total: 1, passed: false });
        }
      };
      })();
    `;
    const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    const worker = new Worker(url);
    const nonce = crypto.randomUUID();
    const expectedTotal = exerciseId === "classify-attempt" ? 7 : exerciseId === "build-gateway" ? 15 : 6;
    try {
      return await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          worker.terminate();
          resolve({ cases: [{ name: "Execution limit", ok: false, message: "The solution exceeded 1.5 seconds." }], passedCount: 0, failed: 1, total: 1, passed: false });
        }, 1500);
        worker.onmessage = (event) => {
          const result = event.data;
          if (result?.nonce !== nonce || !Array.isArray(result?.cases)) return;
          if (result.fatal === true) {
            clearTimeout(timeout);
            resolve({ ...result, passed: false });
            return;
          }
          if (result.total !== expectedTotal || result.cases.length !== expectedTotal) return;
          const cases = result.cases.map((test) => ({ name: String(test.name || "Case"), ok: test.ok === true, message: String(test.message || "") }));
          const passedCount = cases.filter((test) => test.ok).length;
          clearTimeout(timeout);
          resolve({ cases, passedCount, failed: expectedTotal - passedCount, total: expectedTotal, passed: passedCount === expectedTotal });
        };
        worker.onerror = (event) => {
          clearTimeout(timeout);
          resolve({ cases: [{ name: "Worker error", ok: false, message: event.message || "The solution could not run." }], passedCount: 0, failed: 1, total: 1, passed: false });
        };
        worker.postMessage({ exerciseId, functionName: exercise.functionName, code, nonce });
      });
    } finally {
      worker.terminate();
      URL.revokeObjectURL(url);
    }
  }

  function completeLab(moduleId, message) {
    if (!state.completedLabs.includes(moduleId)) state.completedLabs.push(moduleId);
    saveState();
    updateProgress();
    renderDrawer(parseRoute());
    const chip = document.querySelector(".lab-header .completion-chip");
    if (chip) {
      chip.textContent = "Evidence recorded";
      chip.classList.add("complete");
    }
    showToast(message);
  }

  function notebookMarkdown() {
    const lines = ["# Decagon interview benchmark notebook", ""];
    state.benchmarks.forEach((run, index) => {
      lines.push(`## Run ${index + 1}: ${gatewayPolicyLabels[run.config?.policy] || run.config?.policy || "Policy"}`, "", `- Module: ${run.moduleId || "unscoped"}`, `- Fingerprint: \`${run.fingerprint || "n/a"}\``, `- Scenario: ${gatewayScenarioLabels[run.config?.scenario] || run.config?.scenario || "n/a"}`, `- Offered / achieved RPS: ${run.metrics?.offeredRps || run.config?.rps || "n/a"} / ${run.metrics?.achievedRps || 0}`, `- Hypothesis: ${run.hypothesis || "Not recorded"}`, `- Success: ${run.metrics?.successRate || 0}%`, `- Successful-request p50 / p95 / p99: ${run.metrics?.successP50 ?? run.metrics?.p50 ?? 0} / ${run.metrics?.successP95 ?? run.metrics?.p95 ?? 0} / ${run.metrics?.successP99 ?? run.metrics?.p99 ?? 0} ms`, `- Terminal p95: ${run.metrics?.terminalP95 || 0} ms`, `- Calls per request: ${run.metrics?.attemptsPerRequest || 0}`, `- Result: ${run.note || "Add what happened and why."}`, "");
    });
    return lines.join("\n");
  }

  async function copyText(value, message = "Copied.") {
    try {
      await navigator.clipboard.writeText(value);
      showToast(message);
    } catch {
      showToast("Copy failed. Select the text manually.");
    }
  }

  document.addEventListener("click", async (event) => {
    const modeButton = event.target.closest("[data-mode-value]");
    if (modeButton) {
      state.mode = modeButton.dataset.modeValue;
      saveState();
      updateModePicker();
      renderRoute();
      return;
    }

    const routeButton = event.target.closest("[data-route]");
    if (routeButton) {
      goToRoute(routeButton.dataset.route);
      return;
    }

    const searchRoute = event.target.closest("[data-search-route]");
    if (searchRoute) {
      closeSearch();
      goToRoute(searchRoute.dataset.searchRoute);
      return;
    }

    const studioPhaseButton = event.target.closest("[data-studio-phase]");
    if (studioPhaseButton) {
      const root = studioPhaseButton.closest("[data-system-design-studio]");
      if (!root) return;
      const workbook = designWorkbook(root.dataset.systemDesignStudio, { mockId: root.dataset.studioMock || null });
      workbook.activePhase = studioPhaseButton.dataset.studioPhase;
      saveState();
      refreshSystemDesignStudio(root, { focusPhase: true });
      announce(`Opened the ${studioPhaseButton.textContent.trim()} design phase.`);
      return;
    }

    const addStudioNode = event.target.closest("[data-studio-add-node]");
    if (addStudioNode) {
      const root = addStudioNode.closest("[data-system-design-studio]");
      const input = addStudioNode.parentElement?.querySelector("[data-studio-node-input]");
      const node = String(input?.value || "").trim();
      const studioId = root?.dataset.systemDesignStudio;
      const mockId = root?.dataset.studioMock || null;
      const workbook = designWorkbook(studioId, { mockId });
      const phase = systemDesignStudios[studioId]?.phases.find((entry) => entry.id === workbook.activePhase);
      const fieldId = addStudioNode.dataset.studioAddNode;
      const nodes = designDiagramNodes(designPhaseRecord(workbook, phase?.id).fields[fieldId]);
      if (node.length < 3) {
        showToast("Name the component before adding the box.");
        input?.focus();
        return;
      }
      if (nodes.some((entry) => entry.toLowerCase() === node.toLowerCase())) {
        showToast("That box is already in the path.");
        input?.focus();
        return;
      }
      if (nodes.length >= 12) {
        showToast("Keep the main path to 12 boxes or fewer.");
        return;
      }
      updateStudioDiagram(root, fieldId, [...nodes, node]);
      announce(`Added ${node} to the topology.`);
      return;
    }

    const studioNodeAction = event.target.closest("[data-studio-node-action]");
    if (studioNodeAction) {
      const root = studioNodeAction.closest("[data-system-design-studio]");
      const studioId = root?.dataset.systemDesignStudio;
      const mockId = root?.dataset.studioMock || null;
      const workbook = designWorkbook(studioId, { mockId });
      const phase = systemDesignStudios[studioId]?.phases.find((entry) => entry.id === workbook.activePhase);
      const fieldId = studioNodeAction.dataset.studioNodeField;
      const nodes = designDiagramNodes(designPhaseRecord(workbook, phase?.id).fields[fieldId]);
      const index = Number(studioNodeAction.dataset.studioNodeIndex);
      const action = studioNodeAction.dataset.studioNodeAction;
      if (!Number.isInteger(index) || !nodes[index]) return;
      if (action === "remove") nodes.splice(index, 1);
      if (action === "left" && index > 0) [nodes[index - 1], nodes[index]] = [nodes[index], nodes[index - 1]];
      if (action === "right" && index < nodes.length - 1) [nodes[index + 1], nodes[index]] = [nodes[index], nodes[index + 1]];
      updateStudioDiagram(root, fieldId, nodes);
      announce(action === "remove" ? "Removed the topology box." : "Reordered the topology path.");
      return;
    }

    const studioOption = event.target.closest("[data-studio-option]");
    if (studioOption) {
      const root = studioOption.closest("[data-system-design-studio]");
      if (!root || studioOption.disabled) return;
      const studioId = root.dataset.systemDesignStudio;
      const mockId = root.dataset.studioMock || null;
      const workbook = designWorkbook(studioId, { mockId });
      const phase = systemDesignStudios[studioId]?.phases.find((entry) => entry.id === workbook.activePhase);
      if (!phase) return;
      const record = designPhaseRecord(workbook, phase.id);
      const fieldId = studioOption.dataset.studioOptionField;
      record.fields[fieldId] = studioOption.dataset.studioOption;
      record.fieldUpdatedAt[fieldId] = new Date().toISOString();
      record.guidedDecisions[fieldId] = true;
      record.verified = false;
      workbook.attemptId = mockId ? activeTimer?.attemptId || null : workbook.attemptId;
      invalidateStudioEvidence(root);
      saveState();
      refreshSystemDesignStudio(root, { focusSelector: `[data-studio-option="${CSS.escape(studioOption.dataset.studioOption)}"]` });
      announce(`Selected ${studioOption.querySelector("strong")?.textContent || "the design option"}.`);
      return;
    }

    const checkStudioPhase = event.target.closest("[data-check-studio-phase]");
    if (checkStudioPhase) {
      const root = checkStudioPhase.closest("[data-system-design-studio]");
      if (!root || checkStudioPhase.disabled) return;
      const studioId = root.dataset.systemDesignStudio;
      const mockId = root.dataset.studioMock || null;
      const moduleId = root.dataset.studioModule || null;
      const studio = systemDesignStudios[studioId];
      const phase = studio?.phases.find((entry) => entry.id === checkStudioPhase.dataset.checkStudioPhase);
      const workbook = designWorkbook(studioId, { mockId });
      const record = phase ? designPhaseRecord(workbook, phase.id) : null;
      if (!phase || !record) return;
      const missing = phase.fields.filter((field) => !designFieldComplete(field, record));
      if (missing.length) {
        const status = root.querySelector("[data-studio-phase-status]");
        status.textContent = `Finish ${missing.map((field) => field.label).join(" and ")}. Use distinct sections, concrete names or units, and causal reasoning.`;
        status.classList.add("error");
        const first = missing[0];
        const selector = first.kind === "decision"
          ? `[data-studio-option-field="${CSS.escape(first.id)}"]`
          : `[data-studio-field="${CSS.escape(first.id)}"]`;
        root.querySelector(selector)?.focus();
        announce(status.textContent);
        return;
      }
      const now = new Date().toISOString();
      record.attempted = true;
      record.verified = true;
      record.verifiedAt = now;
      workbook.updatedAt = now;
      workbook.attemptId = mockId ? activeTimer?.attemptId || null : workbook.attemptId;
      saveState();
      if (moduleId) maybeCompleteSystemDesignLab(moduleId);
      refreshSystemDesignStudio(root, { focusSelector: "[data-studio-phase-status]" });
      announce(mockId ? `${phase.short} evidence recorded for this attempt.` : `${phase.short} recorded. The worked comparison is now available.`);
      return;
    }

    const checkButton = event.target.closest("[data-check-answer]");
    if (checkButton) {
      const root = checkButton.closest("[data-check-id]");
      const entry = lessonById.get(root.dataset.checkId);
      if (!entry) return;
      const selected = Number(checkButton.dataset.checkAnswer);
      const correct = selected === entry.lesson.check.answer;
      root.querySelectorAll("[data-check-answer]").forEach((button, index) => {
        button.disabled = true;
        if (index === entry.lesson.check.answer) button.classList.add("correct");
        else if (button === checkButton) button.classList.add("incorrect");
      });
      const feedback = root.querySelector(".check-feedback");
      feedback.hidden = false;
      feedback.className = `check-feedback ${correct ? "correct" : "incorrect"}`;
      feedback.innerHTML = `<strong>${correct ? "Correct" : "Not yet"}</strong><p>${escapeHTML(entry.lesson.check.explanation)}</p>${correct ? "" : '<button class="quiet-button" type="button" data-retry-check>Try again</button>'}`;
      announce(`${correct ? "Correct." : "Not yet."} ${entry.lesson.check.explanation}`);
      if (correct) {
        if (!state.completedLessons.includes(entry.lesson.id)) state.completedLessons.push(entry.lesson.id);
        saveState();
        updateProgress();
        renderDrawer(parseRoute());
        root.querySelector(".completion-chip").textContent = "Recorded";
        root.querySelector(".completion-chip").classList.add("complete");
      }
      const nextFocus = correct ? feedback : feedback.querySelector("[data-retry-check]");
      requestAnimationFrame(() => nextFocus?.focus());
      return;
    }

    const retryCheck = event.target.closest("[data-retry-check]");
    if (retryCheck) {
      const root = retryCheck.closest("[data-check-id]");
      root.querySelectorAll("[data-check-answer]").forEach((button) => { button.disabled = false; button.classList.remove("correct", "incorrect"); });
      const feedback = root.querySelector(".check-feedback");
      feedback.hidden = true;
      retryCheck.closest(".quick-check")?.querySelector("[data-check-answer]")?.focus();
      return;
    }

    const quizAnswer = event.target.closest("[data-quiz-answer]");
    if (quizAnswer && activeQuiz && activeQuiz.selected === null) {
      const selected = Number(quizAnswer.dataset.quizAnswer);
      const question = activeQuiz.questions[activeQuiz.index];
      activeQuiz.selected = selected;
      if (selected === question.answer) activeQuiz.correct += 1;
      activeQuiz.answers.push({ selected, correct: selected === question.answer });
      renderQuiz(moduleById.get(activeQuiz.moduleId));
      announce(`${selected === question.answer ? "Correct." : `Answer: ${question.choices[question.answer]}.`} ${question.explanation}`);
      requestAnimationFrame(() => view.querySelector("[data-next-question]")?.focus());
      return;
    }

    if (event.target.closest("[data-next-question]") && activeQuiz) {
      if (activeQuiz.index >= activeQuiz.questions.length - 1) activeQuiz.finished = true;
      else { activeQuiz.index += 1; activeQuiz.selected = null; }
      renderQuiz(moduleById.get(activeQuiz.moduleId));
      requestAnimationFrame(() => view.querySelector("[data-quiz-answer]")?.focus());
      return;
    }

    const retryQuiz = event.target.closest("[data-retry-quiz]");
    if (retryQuiz) {
      const module = moduleById.get(retryQuiz.dataset.retryQuiz);
      activeQuiz = startQuiz(module);
      renderQuiz(module);
      return;
    }

    const gatewayButton = event.target.closest("[data-run-gateway]");
    if (gatewayButton) {
      const scope = gatewayButton.dataset.runGateway;
      const config = gatewayConfigFromDOM(scope);
      const hypothesis = gatewayHypothesisFromDOM(scope);
      const gatewayRoot = gatewayButton.closest("[data-gateway-scope]");
      if (gatewayRoot?.querySelector('[name="hypothesis"]') && hypothesis.length < 20) {
        showToast("Write a testable hypothesis before running this batch.");
        gatewayRoot.querySelector('[name="hypothesis"]')?.focus();
        return;
      }
      activeGatewayRun = Sim.runGateway(config);
      activeGatewayRun.evidence = {
        scope,
        moduleId: gatewayModuleFromScope(scope),
        ranByStudent: true,
        hypothesis,
        configFingerprint: Sim.stableFingerprint(activeGatewayRun.config),
        ranAt: new Date().toISOString()
      };
      const output = gatewayRoot.querySelector("[data-gateway-output]");
      output.innerHTML = renderGatewayResult(activeGatewayRun, scope === "home");
      const status = gatewayRoot.querySelector("[data-run-evidence-status]");
      if (status) status.textContent = "This result matches the controls and pre-run hypothesis.";
      const interpretation = gatewayRoot.querySelector('[name="interpretation"]');
      if (interpretation) interpretation.value = "";
      announce(`Gateway run complete. ${activeGatewayRun.metrics?.successRate || 0}% success, successful-request p95 ${activeGatewayRun.metrics?.successP95 || 0} milliseconds.`);
      return;
    }

    if (event.target.closest("[data-save-benchmark]")) {
      if (!activeGatewayRun?.evidence?.ranByStudent) {
        showToast("Run the batch from this workbench before saving evidence.");
        return;
      }
      const gatewayRoot = event.target.closest("[data-gateway-scope]");
      const scope = gatewayRoot?.dataset.gatewayScope || "";
      const hypothesis = gatewayHypothesisFromDOM(scope);
      const interpretation = gatewayInterpretationFromDOM(scope);
      const moduleId = gatewayModuleFromScope(scope);
      const currentConfig = gatewayConfigFromDOM(scope);
      const controlsChanged = Object.keys(activeGatewayRun.config || {}).some((key) => currentConfig[key] !== activeGatewayRun.config[key]);
      if (activeGatewayRun.evidence.scope !== scope || activeGatewayRun.evidence.moduleId !== moduleId) {
        showToast("Run this workbench before saving its evidence.");
        return;
      }
      if (controlsChanged || Sim.stableFingerprint(activeGatewayRun.config) !== activeGatewayRun.evidence.configFingerprint) {
        showToast("Controls changed after the run. Run the batch again before saving.");
        return;
      }
      if (hypothesis !== activeGatewayRun.evidence.hypothesis) {
        showToast("The hypothesis changed after the run. Run the batch again before saving.");
        gatewayRoot?.querySelector('[name="hypothesis"]')?.focus();
        return;
      }
      if (interpretation.length < 40) {
        showToast("Write what happened, whether it supported the hypothesis, and what you would keep.");
        gatewayRoot?.querySelector('[name="interpretation"]')?.focus();
        return;
      }
      const snapshot = {
        moduleId,
        scope,
        config: structuredClone(activeGatewayRun.config || defaultGatewayConfig()),
        metrics: structuredClone(activeGatewayRun.metrics || {}),
        providers: structuredClone(activeGatewayRun.providers || {}),
        warnings: structuredClone(activeGatewayRun.warnings || []),
        fingerprint: activeGatewayRun.fingerprint || Sim.stableFingerprint(activeGatewayRun.config || {}),
        savedAt: new Date().toISOString(),
        attemptId: activeTimer?.running && activeTimer.mockId === "ai-gateway-coding" ? activeTimer.attemptId : null,
        hypothesis: activeGatewayRun.evidence.hypothesis,
        note: interpretation
      };
      state.benchmarks.unshift(snapshot);
      state.benchmarks = state.benchmarks.slice(0, 40);
      const route = parseRoute();
      const comparison = gatewayComparisonEvidence(moduleId);
      if (route.type === "lab" && ["adaptive-routing", "concurrency-resilience"].includes(route.id) && comparison) {
        completeLab(route.id, `Comparison recorded. You changed ${comparison.changed[0]}.`);
      } else {
        saveState();
        showToast(comparison ? "Benchmark saved. This module now has comparison evidence." : "Benchmark saved. Change one allowed control, keep the scenario and seed fixed, then run again.");
      }
      renderDrawer(parseRoute());
      return;
    }

    const runCodeButton = event.target.closest("[data-run-code]");
    if (runCodeButton) {
      const root = runCodeButton.closest("[data-code-exercise]");
      const editor = root.querySelector("[data-code-editor]");
      const output = root.querySelector("[data-test-results]");
      const exerciseId = runCodeButton.dataset.runCode;
      runCodeButton.disabled = true;
      runCodeButton.textContent = "Running…";
      output.className = "test-results running";
      output.innerHTML = "<p>Running deterministic cases…</p>";
      state.codeDrafts[exerciseId] = editor.value;
      saveState();
      const result = await runCodeExercise(exerciseId, editor.value);
      state.codeResults[exerciseId] = {
        ...result,
        sourceFingerprint: Sim.stableFingerprint({ source: editor.value }),
        attemptId: activeTimer?.running && activeTimer.mockId === "ai-gateway-coding" ? activeTimer.attemptId : null,
        ranAt: new Date().toISOString()
      };
      saveState();
      output.className = `test-results ${result.passed ? "passed" : "failed"}`;
      output.innerHTML = renderCodeResult(result);
      runCodeButton.disabled = false;
      runCodeButton.textContent = "Run tests";
      if (result.passed) {
        const moduleId = Object.entries(codeExercises).find(([, exercise]) => exercise.id === exerciseId)?.[0];
        completeLab(moduleId, "All tests passed. Lab evidence recorded.");
      }
      applyMockAttemptControlLock();
      announce(result.passed ? "All browser tests passed." : `${result.failed} browser tests failed.`);
      return;
    }

    const resetCodeButton = event.target.closest("[data-reset-code]");
    if (resetCodeButton) {
      const exercise = Object.values(codeExercises).find((item) => item.id === resetCodeButton.dataset.resetCode);
      const root = resetCodeButton.closest("[data-code-exercise]");
      root.querySelector("[data-code-editor]").value = exercise.starter;
      root.querySelector("[data-test-results]").innerHTML = "<p>Tests have not run.</p>";
      root.querySelector("[data-test-results]").className = "test-results";
      state.codeDrafts[exercise.id] = exercise.starter;
      delete state.codeResults[exercise.id];
      saveState();
      return;
    }

    if (event.target.closest("[data-run-fleet]")) {
      const root = event.target.closest("[data-fleet-lab]");
      const read = (name) => root.querySelector(`[name="${name}"]`)?.value;
      activeFleetRun = LabModels.runFleet({
        scenario: read("scenario"),
        strategy: read("strategy"),
        replicas: read("replicas"),
        zones: read("zones"),
        localCap: read("localCap"),
        offeredConcurrency: read("offeredConcurrency"),
        providerQuotaA: read("providerQuotaA"),
        providerQuotaB: read("providerQuotaB"),
        failoverReserveB: read("failoverReserveB"),
        normalShareA: read("normalShareA"),
        leaseTtlSec: read("leaseTtlSec"),
        maxAttemptSec: read("maxAttemptSec"),
        coldStartPct: read("coldStartPct"),
        restartRampSec: read("restartRampSec")
      });
      const fleetBaseline = LabModels.runFleet(defaultFleetConfig());
      activeFleetRun.evidence = {
        ranByStudent: true,
        changedControls: changedModelFields(fleetBaseline.config, activeFleetRun.config),
        outcomeChanged: modelOutcomeChanged(fleetBaseline, activeFleetRun),
        ranAt: new Date().toISOString()
      };
      root.querySelector("[data-fleet-output]").innerHTML = renderFleetResult(activeFleetRun);
      announce(`${activeFleetRun.invariants.filter((item) => item.ok).length} of ${activeFleetRun.invariants.length} fleet invariants hold.`);
      return;
    }

    if (event.target.closest("[data-run-incident]")) {
      const root = event.target.closest("[data-incident-lab]");
      const read = (name) => root.querySelector(`[name="${name}"]`)?.value;
      activeIncidentRun = LabModels.runIncident({
        scenario: read("scenario"),
        configMode: read("configMode"),
        durationSec: read("durationSec"),
        rps: read("rps"),
        gatewayCap: read("gatewayCap"),
        providerCapA: read("providerCapA"),
        providerCapB: read("providerCapB"),
        baseP95Ams: read("baseP95Ams"),
        baseP95Bms: read("baseP95Bms"),
        slowdownMs: read("slowdownMs"),
        queueCap: read("queueCap"),
        deadlineMs: read("deadlineMs"),
        normalShareA: read("normalShareA"),
        probeSharePct: read("probeSharePct"),
        faultStartSec: read("faultStartSec"),
        shiftDelaySec: read("shiftDelaySec"),
        recoveryStartSec: read("recoveryStartSec"),
        recoveryRampSec: read("recoveryRampSec"),
        coldStartPct: read("coldStartPct"),
        telemetryQueueBytes: read("telemetryQueueBytes"),
        telemetryBytesPerRequest: read("telemetryBytesPerRequest"),
        telemetrySinkBytesPerSec: read("telemetrySinkBytesPerSec")
      });
      const incidentBaseline = LabModels.runIncident(defaultIncidentConfig());
      activeIncidentRun.evidence = {
        ranByStudent: true,
        changedControls: changedModelFields(incidentBaseline.config, activeIncidentRun.config),
        outcomeChanged: modelOutcomeChanged(incidentBaseline, activeIncidentRun),
        ranAt: new Date().toISOString()
      };
      const durationControl = root.querySelector('[name="durationSec"]');
      if (durationControl) durationControl.value = activeIncidentRun.config.durationSec;
      root.querySelector("[data-incident-output]").innerHTML = renderIncidentResult(activeIncidentRun);
      announce(`${activeIncidentRun.invariants.filter((item) => item.ok).length} of ${activeIncidentRun.invariants.length} incident invariants hold.`);
      return;
    }

    const recordModel = event.target.closest("[data-record-fleet], [data-record-incident]");
    if (recordModel) {
      const fleet = recordModel.hasAttribute("data-record-fleet");
      const root = recordModel.closest(fleet ? "[data-fleet-lab]" : "[data-incident-lab]");
      const run = fleet ? activeFleetRun : activeIncidentRun;
      const moduleId = fleet ? "production-fleet" : "telemetry-recovery";
      const defense = root.querySelector(fleet ? "[data-fleet-defense]" : "[data-incident-defense]")?.value.trim() || "";
      const failed = run?.invariants?.filter((invariant) => !invariant.ok) || [];
      if (!run?.evidence?.ranByStudent) {
        showToast("Run the model yourself before recording evidence.");
        return;
      }
      if (!run.evidence.changedControls?.length) {
        showToast("Change at least one control from the starting model, then run it again.");
        return;
      }
      if (!run.evidence.outcomeChanged) {
        showToast("The changed control did not change modeled behavior in this scenario. Change a relevant control and run again.");
        return;
      }
      if (fleet && run?.config?.scenario === "healthy") {
        showToast("Choose a fleet failure before recording evidence.");
        return;
      }
      if (failed.length) {
        showToast(`Resolve ${failed.length} failing invariant${failed.length === 1 ? "" : "s"} first.`);
        return;
      }
      if (defense.length < 100) {
        showToast("Write at least 100 characters that defend the failure behavior.");
        root.querySelector(fleet ? "[data-fleet-defense]" : "[data-incident-defense]")?.focus();
        return;
      }
      const design = state.designs[moduleId] || {};
      state.designs[moduleId] = {
        ...design,
        modelChecked: true,
        defense,
        config: structuredClone(run.config),
        recordedAt: new Date().toISOString()
      };
      if (!maybeCompleteSystemDesignLab(moduleId)) {
        saveState();
        showToast("Model evidence recorded. Verify every design artifact assigned to this module next.");
      }
      return;
    }

    if (event.target.closest("[data-run-pipeline]")) {
      const root = event.target.closest("[data-pipeline-lab]");
      const read = (name) => root.querySelector(`[name="${name}"]`)?.value;
      activeCrawlerRun = LabModels.runCrawlPipeline({
        pagesPerDay: read("pagesPerDay"),
        peakFactor: read("peakFactor"),
        attemptAmplification: read("attemptAmplification"),
        meanResponseKiB: read("meanResponseKiB"),
        meanFetchMs: read("meanFetchMs"),
        p95FetchMs: read("p95FetchMs"),
        authorityGapMs: read("authorityGapMs"),
        perAuthorityConcurrency: read("perAuthorityConcurrency"),
        activeAuthoritiesAvailable: read("activeAuthoritiesAvailable"),
        fetchConcurrencyCap: read("fetchConcurrencyCap"),
        networkCapacityGbps: read("networkCapacityGbps"),
        parserCores: read("parserCores"),
        parserCpuMs: read("parserCpuMs"),
        rawRetentionDays: read("rawRetentionDays"),
        replicationFactor: read("replicationFactor"),
        rawStorageCapacityPB: read("rawStorageCapacityPB"),
        browserRenderFraction: read("browserRenderFraction"),
        browserRenderMs: read("browserRenderMs"),
        browserRenderMemoryMiB: read("browserRenderMemoryMiB"),
        browserRenderConcurrencyCap: read("browserRenderConcurrencyCap"),
        browserRenderMemoryGiB: read("browserRenderMemoryGiB"),
        separateRendererPool: root.querySelector('[name="separateRendererPool"]')?.checked,
        slowdown: {
          durationSeconds: read("slowdownDurationSeconds"),
          parserCapacityFactor: read("parserCapacityFactor"),
          inputRateMode: read("slowdownInputRateMode"),
          queueCapacityPages: read("queueCapacityPages"),
          maxRecoverySeconds: read("maxRecoverySeconds")
        }
      });
      const pipelineBaseline = LabModels.runCrawlPipeline(defaultPipelineConfig());
      activeCrawlerRun.evidence = {
        ranByStudent: true,
        changedControls: changedModelFields(pipelineBaseline.config, activeCrawlerRun.config),
        outcomeChanged: modelOutcomeChanged(pipelineBaseline, activeCrawlerRun),
        ranAt: new Date().toISOString()
      };
      root.querySelector("[data-pipeline-output]").innerHTML = renderPipelineResult(activeCrawlerRun);
      announce(`${activeCrawlerRun.invariants.filter((item) => item.ok).length} of ${activeCrawlerRun.invariants.length} pipeline invariants hold.`);
      return;
    }

    if (event.target.closest("[data-run-frontier]")) {
      const root = event.target.closest("[data-frontier-lab]");
      const value = (name) => root.querySelector(`[name="${name}"]`);
      activeCrawlerRun = LabModels.runFrontierChallenge({
        scenario: value("scenario").value,
        scheduler: value("scheduler").value,
        workers: value("workers").value,
        perAuthorityConcurrency: value("perAuthorityConcurrency").value,
        sharedIpCap: value("sharedIpCap").value,
        leaseMs: value("leaseMs").value,
        robotsPolicy: value("robotsPolicy").value,
        dedupeMode: value("dedupeMode").value,
        maxUrlsPerAuthority: value("maxUrlsPerAuthority").value,
        enforceAuthorityReady: value("enforceAuthorityReady").checked,
        enforceSharedIp: value("enforceSharedIp").checked,
        durableLeases: value("durableLeases").checked,
        requeueExpiredLeases: value("requeueExpiredLeases").checked,
        revalidateRedirects: value("revalidateRedirects").checked,
        pinValidatedAddress: value("pinValidatedAddress").checked,
        enforceEgress: value("enforceEgress").checked,
        enforceCrawlBudget: value("enforceCrawlBudget").checked
      });
      if (!activeCrawlerRun.ok) frontierFailedRun = structuredClone(activeCrawlerRun);
      root.querySelector("[data-frontier-output]").innerHTML = renderFrontierResult(activeCrawlerRun);
      announce(activeCrawlerRun.ok ? "Every frontier invariant holds." : `${activeCrawlerRun.invariants.filter((item) => !item.ok).length} frontier invariants failed.`);
      return;
    }

    const recordCrawlerModel = event.target.closest("[data-record-pipeline], [data-record-frontier]");
    if (recordCrawlerModel) {
      const pipeline = recordCrawlerModel.hasAttribute("data-record-pipeline");
      const root = recordCrawlerModel.closest(pipeline ? "[data-pipeline-lab]" : "[data-frontier-lab]");
      const run = activeCrawlerRun;
      const moduleId = pipeline ? "crawler-request-path" : "crawler-frontier";
      const defense = root.querySelector(pipeline ? "[data-pipeline-defense]" : "[data-frontier-defense]")?.value.trim() || "";
      const failed = run?.invariants?.filter((invariant) => !invariant.ok) || [];
      if (pipeline && !run?.evidence?.ranByStudent) {
        showToast("Change an assumption and recalculate the model before recording evidence.");
        return;
      }
      if (pipeline && !run.evidence.changedControls?.length) {
        showToast("Change at least one sizing assumption, then recalculate.");
        return;
      }
      if (pipeline && !run.evidence.outcomeChanged) {
        showToast("That assumption did not change the modeled result. Change a relevant input and recalculate.");
        return;
      }
      if (!pipeline && (!frontierFailedRun || frontierFailedRun.scenario !== run?.scenario)) {
        showToast("Break and repair the same scenario before recording evidence.");
        return;
      }
      if (!pipeline) {
        const repair = frontierRepairEvaluation(frontierFailedRun, run);
        if (!repair.ok) {
          showToast(repair.reasons[0]);
          return;
        }
      }
      if (failed.length) {
        showToast(`Resolve ${failed.length} failing invariant${failed.length === 1 ? "" : "s"} first.`);
        return;
      }
      if (defense.length < 100) {
        showToast("Write at least 100 characters that defend the result.");
        root.querySelector(pipeline ? "[data-pipeline-defense]" : "[data-frontier-defense]")?.focus();
        return;
      }
      state.designs[moduleId] = {
        checked: true,
        modelChecked: true,
        defense,
        config: structuredClone(run.config || run.controls),
        recordedAt: new Date().toISOString()
      };
      if (!maybeCompleteSystemDesignLab(moduleId)) {
        saveState();
        showToast("Model evidence recorded. Verify every design artifact assigned to this module next.");
      }
      return;
    }

    if (event.target.closest("[data-timer-toggle]")) {
      if (!activeTimer || activeTimer.remaining === 0) return;
      if (activeTimer.running) {
        syncActiveTimer();
        activeTimer.running = false;
        activeTimer.elapsedAtRunStart = activeTimer.elapsed;
        activeTimer.runStartedAtMs = null;
        stopTimer(false);
      } else {
        if (!activeTimer.started) {
          activeTimer.started = true;
          activeTimer.startedAt = new Date().toISOString();
          activeTimer.attemptId = crypto.randomUUID();
          activeTimer.rubricRevealed = false;
          delete state.mockDesignWorkbooks[activeTimer.mockId];
        }
        activeTimer.elapsedAtRunStart = activeTimer.elapsed;
        activeTimer.runStartedAtMs = Date.now();
        activeTimer.running = true;
        startTimerInterval();
      }
      refreshTimerDisplay();
      const mockStudio = document.querySelector(`[data-studio-mock="${CSS.escape(activeTimer.mockId)}"]`);
      if (mockStudio) refreshSystemDesignStudio(mockStudio);
      return;
    }

    if (event.target.closest("[data-timer-reset]")) {
      const mock = mockById.get(activeTimer.mockId);
      stopTimer(false);
      activeTimer = freshMockTimer(mock);
      delete state.mockNotes[mock.id];
      delete state.mockNoteUpdatedAt[mock.id];
      delete state.mockDesignWorkbooks[mock.id];
      saveState();
      renderMock(mock);
      showToast("Mock attempt reset.");
      return;
    }

    if (event.target.closest("[data-reveal-rubric]")) {
      const root = event.target.closest("[data-mock-id]");
      const mock = mockById.get(root?.dataset.mockId);
      if (!mock || !activeTimer || activeTimer.elapsed < mock.minutes * 60) {
        showToast("Complete the full timer before revealing the rubric.");
        return;
      }
      activeTimer.rubricRevealed = true;
      saveState();
      renderMock(mock);
      return;
    }

    if (event.target.closest("[data-score-mock]")) {
      const root = event.target.closest("[data-mock-id]");
      const mock = mockById.get(root.dataset.mockId);
      if (!activeTimer?.rubricRevealed) {
        showToast("Complete the timer and reveal the rubric before scoring.");
        return;
      }
      const missingEvidence = mockObjectiveEvidence(mock).find((item) => !item.ok);
      if (missingEvidence) {
        showToast(`Required artifact missing: ${missingEvidence.label}.`);
        return;
      }
      const selects = [...root.querySelectorAll("[data-rubric-score]")];
      if (selects.some((select) => select.value === "")) {
        showToast("Score every rubric row first.");
        return;
      }
      const notes = String(state.mockNotes[mock.id] || "").trim();
      if (mock.id === "ai-gateway-coding" && notes.length < 120) {
        showToast("Record at least 120 characters of requirements, decisions, and failure behavior first.");
        root.querySelector("[data-mock-notes]")?.focus();
        return;
      }
      if (mock.id === "ai-gateway-coding" && (
        !activeTimer.startedAt
        || !activeTimer.endedAt
        || new Date(state.mockNoteUpdatedAt[mock.id] || 0).getTime() < new Date(activeTimer.startedAt).getTime()
        || new Date(state.mockNoteUpdatedAt[mock.id] || 0).getTime() > new Date(activeTimer.endedAt).getTime()
      )) {
        showToast("Add or revise your notes during this timed attempt before scoring.");
        root.querySelector("[data-mock-notes]")?.focus();
        return;
      }
      if (!root.querySelector("[data-mock-performed]")?.checked) {
        showToast("Confirm that you completed the rep before self-scoring it.");
        root.querySelector("[data-mock-performed]")?.focus();
        return;
      }
      const scores = Object.fromEntries(selects.map((select) => [select.dataset.rubricScore, Number(select.value)]));
      const earned = Object.values(scores).reduce((sum, value) => sum + value, 0);
      const total = mock.rubric.length * 2;
      const percent = Math.round((earned / total) * 100);
      state.mockScores[mock.id] = { scores, earned, total, percent, notesLength: notes.length, elapsedSec: Number(activeTimer?.elapsed || 0), attemptId: activeTimer.attemptId, scoredAt: new Date().toISOString() };
      saveState();
      if (!state.completedLabs.includes("interview-rehearsals")) state.completedLabs.push("interview-rehearsals");
      saveState();
      showToast(`Mock score recorded: ${percent}%.`);
      renderMock(mock);
      updateProgress();
      renderDrawer(parseRoute());
      return;
    }

    const copyButton = event.target.closest("[data-copy-text]");
    if (copyButton) { await copyText(copyButton.dataset.copyText, "Command copied."); return; }
    if (event.target.closest("[data-copy-notebook]")) { await copyText(notebookMarkdown(), "Notebook copied as Markdown."); return; }

    const deleteRun = event.target.closest("[data-delete-run]");
    if (deleteRun) {
      state.benchmarks.splice(Number(deleteRun.dataset.deleteRun), 1);
      saveState();
      renderNotebook();
      renderDrawer(parseRoute());
      return;
    }

    if (event.target.closest("[data-compare-selected]")) {
      const selected = [...document.querySelectorAll("[data-compare-run]:checked")].map((input) => Number(input.dataset.compareRun));
      const output = document.querySelector("[data-compare-output]");
      if (selected.length !== 2) { output.textContent = "Select exactly two rows."; return; }
      const ordered = selected.map((index) => state.benchmarks[index]).sort((left, right) => new Date(left.savedAt || 0) - new Date(right.savedAt || 0));
      const [baseline, candidate] = ordered;
      if (baseline.moduleId !== candidate.moduleId) { output.textContent = "Compare two runs from the same module."; return; }
      if (baseline.config?.scenario !== candidate.config?.scenario || baseline.config?.seed !== candidate.config?.seed) { output.textContent = "Scenario and seed must match before the result is comparable."; return; }
      const changed = changedGatewayFields(baseline.config, candidate.config);
      if (changed.length !== 1) { output.textContent = `Change exactly one control. This pair changed ${changed.length}.`; return; }
      const successDelta = Number(candidate.metrics.successRate || 0) - Number(baseline.metrics.successRate || 0);
      const latencyDelta = Number(candidate.metrics.successP95 ?? candidate.metrics.p95 ?? 0) - Number(baseline.metrics.successP95 ?? baseline.metrics.p95 ?? 0);
      const callDelta = Number(candidate.metrics.attemptsPerRequest || 0) - Number(baseline.metrics.attemptsPerRequest || 0);
      output.textContent = `Candidate minus baseline: success ${successDelta >= 0 ? "+" : ""}${successDelta.toFixed(1)} points, successful-request p95 ${latencyDelta >= 0 ? "+" : ""}${latencyDelta.toFixed(1)} ms, calls/request ${callDelta >= 0 ? "+" : ""}${callDelta.toFixed(2)}. Changed: ${changed.length ? changed.join(", ") : "no controls"}.`;
      return;
    }

    if (event.target.closest("[data-export-progress]")) {
      const blob = new Blob([JSON.stringify({ format: "decagon-prep-v1", exportedAt: new Date().toISOString(), state }, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "decagon-interview-prep.json";
      link.click();
      URL.revokeObjectURL(url);
      showToast("Preparation record exported.");
      return;
    }

    if (event.target.closest("#search-trigger")) { openSearch(); return; }
    if (event.target.closest("#search-close")) { closeSearch(); return; }
    if (event.target.closest("#mobile-map-trigger")) { setMobileMap(true); return; }
    if (event.target.closest("#mobile-map-close")) {
      setMobileMap(false);
      document.querySelector("#mobile-map-trigger")?.focus();
      return;
    }

    if (event.target.closest("#reset-progress")) {
      if (!confirm("Reset all Decagon course progress, notes, benchmarks, and mock scores?")) return;
      localStorage.removeItem(storageKey);
      localStorage.removeItem(previousStorageKey);
      state = structuredClone(defaultState);
      activeQuiz = null;
      activeGatewayRun = null;
      activeCrawlerRun = null;
      activeFleetRun = null;
      activeIncidentRun = null;
      frontierFailedRun = null;
      activeTimer = null;
      renderRoute();
      showToast("Course progress reset.");
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.matches("[data-studio-field]")) {
      const root = event.target.closest("[data-system-design-studio]");
      const studioId = root?.dataset.systemDesignStudio;
      const mockId = root?.dataset.studioMock || null;
      const workbook = designWorkbook(studioId, { mockId });
      const phase = systemDesignStudios[studioId]?.phases.find((entry) => entry.id === workbook.activePhase);
      if (phase) {
        const record = designPhaseRecord(workbook, phase.id);
        const fieldId = event.target.dataset.studioField;
        record.fields[fieldId] = event.target.value;
        record.fieldUpdatedAt[fieldId] = new Date().toISOString();
        delete record.guidedDecisions[fieldId];
        record.verified = false;
        workbook.updatedAt = new Date().toISOString();
        workbook.attemptId = mockId ? activeTimer?.attemptId || null : workbook.attemptId;
        invalidateStudioEvidence(root);
        const counter = event.target.closest(".studio-field")?.querySelector("[data-studio-counter]");
        const length = event.target.value.trim().length;
        const minimum = Number(event.target.dataset.studioMin || 1);
        if (counter) {
          counter.textContent = `${length}/${minimum} characters`;
          counter.classList.toggle("complete", length >= minimum);
        }
        const status = root.querySelector("[data-studio-phase-status]");
        if (status) {
          status.textContent = "Draft changed. Recheck this phase when the artifact is ready.";
          status.classList.remove("complete", "error");
        }
        saveState();
      }
    }
    if (event.target.matches("[data-code-editor]")) {
      const root = event.target.closest("[data-code-exercise]");
      const exerciseId = root.dataset.codeExercise;
      state.codeDrafts[exerciseId] = event.target.value;
      if (state.codeResults[exerciseId]) {
        delete state.codeResults[exerciseId];
        const moduleId = Object.entries(codeExercises).find(([, exercise]) => exercise.id === exerciseId)?.[0];
        state.completedLabs = state.completedLabs.filter((id) => id !== moduleId);
        const results = root.querySelector("[data-test-results]");
        if (results) {
          results.className = "test-results";
          results.innerHTML = "<p>Code changed. Run the tests again.</p>";
        }
      }
      saveState();
    }
    if (event.target.matches("[data-mock-notes]")) {
      const root = event.target.closest("[data-mock-id]");
      state.mockNotes[root.dataset.mockId] = event.target.value;
      state.mockNoteUpdatedAt[root.dataset.mockId] = new Date().toISOString();
      saveState();
    }
    if (event.target.matches("[data-benchmark-note]")) {
      const run = state.benchmarks[Number(event.target.dataset.benchmarkNote)];
      if (run) { run.note = event.target.value; saveState(); }
    }
    if (event.target === searchInput) {
      activeSearchIndex = 0;
      renderSearchResults(searchInput.value);
    }
  });

  document.addEventListener("change", async (event) => {
    if (event.target.matches("[data-import-progress]")) {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        if (payload.format !== "decagon-prep-v1" || !payload.state) throw new Error("Unsupported preparation record");
        localStorage.setItem(storageKey, JSON.stringify(payload.state));
        state = loadState();
        activeTimer = restoreMockTimer(state.activeMockTimer);
        renderRoute();
        showToast("Preparation record imported.");
      } catch {
        showToast("That file is not a Decagon preparation record.");
      } finally {
        event.target.value = "";
      }
    }
  });

  searchInput?.addEventListener("keydown", (event) => {
    const matches = searchMatches(searchInput.value);
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activeSearchIndex = Math.min(matches.length - 1, activeSearchIndex + 1);
      renderSearchResults(searchInput.value);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      activeSearchIndex = Math.max(0, activeSearchIndex - 1);
      renderSearchResults(searchInput.value);
    } else if (event.key === "Enter" && matches[activeSearchIndex]) {
      event.preventDefault();
      closeSearch();
      goToRoute(matches[activeSearchIndex].route);
    }
  });

  searchDialog?.addEventListener("click", (event) => {
    if (event.target === searchDialog) closeSearch();
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      openSearch();
    }
    if (event.key === "Escape" && document.body.classList.contains("map-open")) {
      setMobileMap(false);
      document.querySelector("#mobile-map-trigger")?.focus();
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && activeTimer?.running) refreshTimerDisplay(true);
  });

  window.addEventListener("hashchange", renderRoute);
  window.addEventListener("resize", () => {
    if (!matchMedia("(max-width: 820px)").matches) setMobileMap(false);
  });

  updateModePicker();
  renderRoute();
})();
