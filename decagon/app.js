(() => {
  "use strict";

  const course = window.DECAGON_COURSE;
  const Sim = window.DecagonSim;
  if (!course || !Sim) return;

  course.modules.sort((a, b) => Number(a.number) - Number(b.number));

  const allLessons = course.modules.flatMap((module) =>
    module.lessons.map((lesson, index) => ({ lesson, module, index }))
  );
  const lessonById = new Map(allLessons.map((entry) => [entry.lesson.id, entry]));
  const moduleById = new Map(course.modules.map((module) => [module.id, module]));
  const mockById = new Map(course.mocks.map((mock) => [mock.id, mock]));
  const passingScore = 75;
  const storageKey = `decagon-prep:v${course.version}`;
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
    mode: "learn",
    lastRoute: "home"
  };

  let state = loadState();
  let activeQuiz = null;
  let activeSearchIndex = 0;
  let activeGatewayRun = null;
  let activeCrawlerRun = null;
  let activeTimer = null;
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
  const modeSelect = document.querySelector("#mode-select");

  const trackLabels = {
    coding: "AI coding",
    "gateway-design": "Gateway design",
    "crawler-design": "Crawler design"
  };

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (!saved || typeof saved !== "object") return structuredClone(defaultState);
      return {
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
        mockNotes: objectOrEmpty(saved.mockNotes)
      };
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

  function saveState() {
    try {
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
    const modules = course.modules.filter((module) => module.track === trackId);
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
    }
    const nextMock = course.mocks.find((mock) => Number(state.mockScores[mock.id]?.percent || 0) < 70);
    return nextMock ? routeFor("mock", nextMock.id) : "home";
  }

  function renderNav(activeModuleId) {
    moduleNav.innerHTML = course.tracks
      .map((track) => {
        const modules = course.modules.filter((module) => module.track === track.id);
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
    renderBreadcrumbs([{ label: "Interview control room" }]);
    if (!activeGatewayRun) activeGatewayRun = Sim.runGateway(defaultGatewayConfig());
    const stats = overallStats();

    view.innerHTML = `
      <div class="home-view decagon-home">
        <section class="decagon-hero" aria-labelledby="home-title">
          <div class="hero-copy">
            <span class="eyebrow">Decagon infrastructure interview lab</span>
            <span class="freshness-stamp">Source audit · ${escapeHTML(course.verified.date)}</span>
            <h1 class="hero-title" id="home-title"><span>Build it.</span><span>Scale it.</span><span>Defend it.</span></h1>
            <p class="hero-lede">
              Prepare for the AI gateway coding round, its production design follow-up, and the web crawler design round through measured practice.
            </p>
            <div class="hero-actions">
              <button class="primary-button" type="button" data-route="${nextRoute()}">${stats.complete ? "Continue the next rep" : "Start with one request"}</button>
              <button class="secondary-button" type="button" data-route="mock/ai-gateway-coding">Open a timed mock</button>
            </div>
            <ul class="hero-facts" aria-label="Course facts">
              <li>${allLessons.length} lessons</li>
              <li>${course.modules.length} workbenches</li>
              <li>${course.mocks.length} scored mocks</li>
              <li>Progress stays in this browser</li>
            </ul>
          </div>
          <div class="hero-console-wrap">
            ${renderGatewayConsole("home", true)}
          </div>
        </section>

        <section class="readiness-section" aria-labelledby="readiness-title">
          <div class="section-heading">
            <div><span class="eyebrow">Three interview lanes</span><h2 id="readiness-title">Readiness is earned by evidence</h2></div>
            <button class="quiet-button" type="button" data-route="notebook">Open interview notebook</button>
          </div>
          <div class="track-grid">
            ${course.tracks.map(renderTrackCard).join("")}
          </div>
        </section>

        <section class="dependency-section" aria-labelledby="dependency-title">
          <div class="section-heading">
            <div><span class="eyebrow">Learning order</span><h2 id="dependency-title">The prototype becomes the design prompt</h2></div>
          </div>
          <div class="dependency-map" role="img" aria-label="AI coding leads to gateway system design. Interview operating skills also lead to the independent crawler system design.">
            <div class="dependency-node shared"><strong>Interview loop</strong><span>ask · estimate · decide · test</span></div>
            <span class="dependency-arrow" aria-hidden="true">→</span>
            <div class="dependency-stack">
              <div class="dependency-node coding"><strong>AI coding</strong><span>working gateway + benchmark</span></div>
              <span class="dependency-arrow vertical" aria-hidden="true">↓</span>
              <div class="dependency-node gateway"><strong>Gateway design</strong><span>fleet state + quotas + telemetry</span></div>
            </div>
            <span class="dependency-branch" aria-hidden="true">↘</span>
            <div class="dependency-node crawler"><strong>Crawler design</strong><span>frontier + politeness + durable capture</span></div>
          </div>
        </section>

        <section class="module-map-section" aria-labelledby="map-title">
          <div class="section-heading"><div><span class="eyebrow">Course map</span><h2 id="map-title">Nine focused workbenches</h2></div></div>
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
        <div class="module-card-top"><span class="module-number">${escapeHTML(module.number)}</span><span class="module-track">${escapeHTML(trackLabels[module.track])}</span></div>
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
          <span class="eyebrow">${escapeHTML(trackLabels[module.track])} · ${formatMinutes(module.duration)}</span>
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
    const position = allLessons.findIndex((entry) => entry.lesson.id === lesson.id);
    const next = allLessons[position + 1];
    const complete = state.completedLessons.includes(lesson.id);
    renderBreadcrumbs([
      { label: "Control room", route: "home" },
      { label: `Module ${module.number}`, route: `module/${module.id}` },
      { label: lesson.title }
    ]);

    view.innerHTML = `
      <article class="lesson-view" style="--module-color:${module.color};--module-soft:${module.soft}">
        <header class="lesson-header">
          <span class="eyebrow">Lesson ${escapeHTML(lesson.number)} · ${formatMinutes(lesson.duration)}</span>
          <h1 id="lesson-title" tabindex="-1">${escapeHTML(lesson.title)}</h1>
          <p class="lesson-summary">${escapeHTML(lesson.summary)}</p>
          <div class="prediction-card"><span>Predict before reading</span><p>${escapeHTML(lesson.prediction)}</p></div>
        </header>
        <div class="lesson-body">
          <section class="prose-section" aria-labelledby="model-title">
            <span class="eyebrow">Working model</span><h2 id="model-title">Trace the system boundary</h2>
            ${lesson.core.map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`).join("")}
          </section>
          <section class="mechanics-grid" aria-label="Key mechanisms">
            ${lesson.mechanics.map((item) => `<article><span class="mechanic-mark" aria-hidden="true"></span><h3>${escapeHTML(item.title)}</h3><p>${escapeHTML(item.text)}</p></article>`).join("")}
          </section>
          ${renderLessonVisual(lesson.visual, module)}
          <details class="deep-section" ${state.mode === "interview" ? "open" : ""}>
            <summary><span>Go one level deeper</span><small>implementation and trade-offs</small></summary>
            <div>${lesson.deep.map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`).join("")}</div>
          </details>
          <div class="lesson-callouts">
            <aside class="bridge-card"><span>Interview bridge</span><h3>${escapeHTML(lesson.bridge.title)}</h3><p>${escapeHTML(lesson.bridge.text)}</p></aside>
            <aside class="failure-card"><span>Failure test</span><h3>${escapeHTML(lesson.failure.title)}</h3><p>${escapeHTML(lesson.failure.text)}</p></aside>
          </div>
          ${renderQuickCheck(lesson, complete)}
          <section class="sources-section" aria-labelledby="sources-title">
            <span class="eyebrow">Direct sources</span><h2 id="sources-title">Read the contract, not a recap</h2>
            <ul>${lesson.sources.map(([label, url]) => `<li><a href="${escapeAttr(url)}" target="_blank" rel="noreferrer">${escapeHTML(label)} <span aria-hidden="true">↗</span></a></li>`).join("")}</ul>
          </section>
        </div>
        <footer class="lesson-footer">
          <button class="secondary-button" type="button" data-route="module/${module.id}">Module overview</button>
          ${next ? `<button class="primary-button" type="button" data-route="lesson/${next.lesson.id}">Next: ${escapeHTML(next.lesson.title)}</button>` : `<button class="primary-button" type="button" data-route="lab/${module.id}">Open the lab</button>`}
        </footer>
      </article>
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
        <div class="check-feedback" hidden></div>
      </section>
    `;
  }

  function renderDrawer(route) {
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
            <div class="latest-run"><strong>${escapeHTML(latest.policyLabel || latest.config?.policy || "Saved run")}</strong><span>${latest.metrics.successRate}% success · p95 ${latest.metrics.p95} ms</span><small>${escapeHTML(latest.fingerprint || "")}</small></div>
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
    stopTimer();
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
    if (modeSelect) modeSelect.value = state.mode;
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

  function renderGatewayConsole(scope, compact = false) {
    const run = activeGatewayRun || Sim.runGateway(defaultGatewayConfig());
    const config = run.config || defaultGatewayConfig();
    const scenarios = [
      ["steady", "Steady"],
      ["flaky-fast", "A is fast but flaky"],
      ["brownout", "Provider brownout"],
      ["recovery", "Failure then recovery"],
      ["slow-tail", "Long latency tail"]
    ];
    const policies = [
      ["fixed", "Fixed A"],
      ["round-robin", "Round robin"],
      ["least-inflight", "Least in flight"],
      ["adaptive", "Error-aware EWMA"],
      ["hedge", "Adaptive + delayed hedge"]
    ];

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
            `}
            <div class="sim-actions">
              <button class="primary-button compact" type="button" data-run-gateway="${escapeAttr(scope)}">Run batch</button>
              ${compact ? `<button class="text-button" type="button" data-route="lab/adaptive-routing">Open full lab</button>` : `<button class="secondary-button compact" type="button" data-save-benchmark>Save result</button>`}
            </div>
          </form>
          <div class="sim-output" data-gateway-output>${renderGatewayResult(run, compact)}</div>
        </div>
      </section>
    `;
  }

  function numberControl(label, name, value, min, max) {
    return `<label>${escapeHTML(label)}<input type="number" name="${escapeAttr(name)}" value="${escapeAttr(value)}" min="${min}" max="${max}" inputmode="numeric"></label>`;
  }

  function renderGatewayResult(run, compact = false) {
    const metrics = run.metrics || {};
    const rows = (run.requests || run.rows || []).slice(0, compact ? 6 : 18);
    const providers = run.providers || {};
    const deadlineMs = Math.max(1, Number(run.config?.deadlineMs || 1000));
    const warnings = Array.isArray(run.warnings) ? run.warnings : [];

    return `
      <div class="metric-strip" aria-label="Gateway batch summary">
        ${metric("Success", `${valueOr(metrics.successRate, 0)}%`)}
        ${metric("p50", `${valueOr(metrics.p50, 0)} ms`)}
        ${metric("p95", `${valueOr(metrics.p95, 0)} ms`)}
        ${metric("p99", `${valueOr(metrics.p99, 0)} ms`)}
        ${metric("Calls/request", valueOr(metrics.attemptsPerRequest, 0))}
      </div>
      <div class="provider-state-row">
        ${renderProviderState("A", providers.A || providers.a)}
        ${renderProviderState("B", providers.B || providers.b)}
      </div>
      <div class="request-waterfall" aria-label="Sample request waterfall">
        <div class="waterfall-axis"><span>arrival</span><span>deadline</span></div>
        ${rows.length ? rows.map((row, index) => renderRequestRow(row, index, deadlineMs)).join("") : `<p class="empty-inline">Run a batch to draw request attempts.</p>`}
      </div>
      <details class="sim-table-details" ${compact ? "" : "open"}>
        <summary>Text result table</summary>
        <div class="table-scroll"><table><thead><tr><th>Metric</th><th>Value</th><th>What it tests</th></tr></thead><tbody>
          <tr><td>Success rate</td><td>${valueOr(metrics.successRate, 0)}%</td><td>End-user result before the deadline</td></tr>
          <tr><td>Queue p95</td><td>${valueOr(metrics.queueP95, 0)} ms</td><td>Admission pressure hidden by provider latency</td></tr>
          <tr><td>Dropped</td><td>${valueOr(metrics.dropped, 0)}</td><td>Bounded overload behavior</td></tr>
          <tr><td>Retries</td><td>${valueOr(metrics.retries, 0)}</td><td>Post-failure extra attempts</td></tr>
          <tr><td>Hedges</td><td>${valueOr(metrics.hedges, 0)}</td><td>Pre-failure extra attempts</td></tr>
        </tbody></table></div>
      </details>
      ${warnings.length ? `<div class="sim-warnings" role="note">${warnings.map((warning) => `<p><span aria-hidden="true">!</span>${escapeHTML(warning)}</p>`).join("")}</div>` : ""}
    `;
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
        <dl><div><dt>State</dt><dd>${escapeHTML(provider.state || "closed")}</dd></div><div><dt>Share</dt><dd>${valueOr(provider.share, provider.sharePct || 0)}%</dd></div><div><dt>EWMA</dt><dd>${Math.round(valueOr(provider.latencyEWMA, provider.ewmaLatency || 0))} ms</dd></div></dl>
      </article>
    `;
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
      <div class="lab-view" style="--module-color:${module.color};--module-soft:${module.soft}">
        <header class="lab-header">
          <div><span class="eyebrow">${escapeHTML(module.lab.badge || "Interactive workbench")}</span><h1 tabindex="-1">${escapeHTML(module.lab.title)}</h1><p>${escapeHTML(module.lab.intro)}</p></div>
          <span class="completion-chip ${complete ? "complete" : ""}">${complete ? "Evidence recorded" : "Evidence required"}</span>
        </header>
        ${renderLabWorkbench(module)}
        ${renderNotebookCommands(module.lab.notebook)}
        <footer class="lab-footer"><button class="secondary-button" type="button" data-route="module/${module.id}">Module overview</button><p data-lab-requirement>${labRequirement(module)}</p></footer>
      </div>
    `;
  }

  function renderLabWorkbench(module) {
    if (["adaptive-routing", "concurrency-resilience"].includes(module.id)) {
      if (!activeGatewayRun) activeGatewayRun = Sim.runGateway(defaultGatewayConfig());
      return renderGatewayConsole(`lab-${module.id}`, false);
    }
    if (["request-contract", "coding-execution"].includes(module.id)) return renderCodeLab(module);
    if (["production-fleet", "telemetry-recovery"].includes(module.id)) return renderDesignBoard(module);
    if (module.id === "crawler-request-path") return renderCapacityLab(module);
    if (module.id === "crawler-frontier") return renderCrawlerLab(module);
    return renderMockHub();
  }

  function labRequirement(module) {
    if (["adaptive-routing", "concurrency-resilience"].includes(module.id)) return "Save one benchmark result to complete this lab.";
    if (["request-contract", "coding-execution"].includes(module.id)) return "Pass every browser test to complete this lab.";
    if (["production-fleet", "telemetry-recovery"].includes(module.id)) return "Choose each boundary, inject a failure, and record a rationale.";
    if (module.id === "crawler-request-path") return "Calculate the five capacity constraints.";
    if (module.id === "crawler-frontier") return "Finish with zero policy violations.";
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
      id: "choose-provider",
      title: "Choose without starving recovery",
      prompt: "Implement chooseProvider(states, request). Exclude cooldown and saturated providers. Every tenth request explores the provider with the oldest sample. Otherwise minimize the supplied score.",
      functionName: "chooseProvider",
      starter: `function chooseProvider(states, request) {
  const eligible = states.filter((provider) =>
    provider.cooldownUntil <= request.nowMs &&
    provider.inFlight < provider.maxConcurrency
  );

  // Return the selected provider id, or null.
  return eligible[0]?.id ?? null;
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
          <ul class="test-preview">
            <li>Normal result</li><li>Failure boundary</li><li>Cancellation or saturation</li><li>Deterministic tie</li>
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

  function renderDesignBoard(module) {
    const current = state.designs[module.id] || {};
    const gatewayBoard = module.id === "production-fleet";
    const decisions = gatewayBoard ? [
      { id: "health", label: "Health state", options: [["", "Choose a boundary"], ["local-aggregate", "Local decisions + expiring fleet hints"], ["shared-read", "Shared read on every request"], ["local-only", "Local memory only"]] },
      { id: "quota", label: "Provider quota", options: [["", "Choose an owner"], ["leases", "Leased fleet capacity + local burst bucket"], ["local-caps", "Independent local caps"], ["central-call", "Central check on every attempt"]] },
      { id: "config", label: "Routing config", options: [["", "Choose a rollout"], ["versioned", "Versioned snapshot + expiry + last known good"], ["mutable", "Mutable shared object"], ["startup", "Read once at startup"]] }
    ] : [
      { id: "telemetry", label: "Request telemetry", options: [["", "Choose a write path"], ["bounded-async", "Bounded async queue"], ["synchronous", "Synchronous export"], ["unbounded", "Unbounded memory queue"]] },
      { id: "audit", label: "Billing or audit events", options: [["", "Choose durability"], ["durable-event", "Durable event ID + replay + dedupe"], ["best-effort", "Best-effort log line"], ["request-db", "Database transaction in request path"]] },
      { id: "tracing", label: "Attempt tracing", options: [["", "Choose span shape"], ["logical-child", "One logical span + child per attempt"], ["single", "One span for all attempts"], ["provider-request-id", "Provider request ID as metric label"]] }
    ];
    const failures = gatewayBoard
      ? ["Shared health store is unavailable", "One zone cannot reach Provider A", "All replicas restart", "Surviving provider lacks failover capacity"]
      : ["Log sink stops accepting writes", "Collector queue is full", "Clients cancel long requests", "A bad config names a missing provider"];

    return `
      <section class="design-workbench" data-design-board="${escapeAttr(module.id)}">
        <div class="topology-board" aria-labelledby="topology-title">
          <div class="section-heading"><div><span class="eyebrow">Guided topology</span><h2 id="topology-title">Keep optional state off the request path</h2></div></div>
          <div class="topology-flow" role="img" aria-label="Client to edge to gateway replicas to two providers, with separate health, quota, and telemetry branches.">
            <div class="topology-node">Client</div><span>→</span><div class="topology-node">Edge</div><span>→</span><div class="topology-node strong">Gateway replicas</div><span>→</span><div class="topology-providers"><div>▲ Provider A</div><div>● Provider B</div></div>
            <div class="topology-branches"><span>↘ health policy</span><span>↘ quota owner</span><span>↘ event buffer</span></div>
          </div>
        </div>
        <div class="decision-grid">
          ${decisions.map((decision) => `
            <label class="decision-card"><span>${escapeHTML(decision.label)}</span><select data-design-field="${escapeAttr(decision.id)}">${decision.options.map(([value, label]) => `<option value="${value}" ${current[decision.id] === value ? "selected" : ""}>${escapeHTML(label)}</option>`).join("")}</select><small>${designConsequence(decision.id, current[decision.id])}</small></label>
          `).join("")}
        </div>
        <div class="failure-injector">
          <label><span>Inject a failure</span><select data-design-field="failure"><option value="">Choose a failure</option>${failures.map((failure) => `<option value="${escapeAttr(failure)}" ${current.failure === failure ? "selected" : ""}>${escapeHTML(failure)}</option>`).join("")}</select></label>
          <div class="failure-readout" data-failure-readout>${renderFailureReadout(current.failure, module.id)}</div>
        </div>
        <label class="rationale-field"><span>Defend the design in 2 to 4 sentences</span><textarea data-design-field="rationale" placeholder="State the invariant, the failure behavior, and the trade-off.">${escapeHTML(current.rationale || "")}</textarea></label>
        <div class="design-actions"><button class="primary-button" type="button" data-check-design="${escapeAttr(module.id)}">Check design evidence</button><p data-design-status>${current.checked ? "Design evidence recorded." : "Complete each decision and explain why."}</p></div>
      </section>
    `;
  }

  function designConsequence(field, value) {
    const consequences = {
      health: {
        "local-aggregate": "Fast local reaction, slower fleet hints, no shared read in the hot path.",
        "shared-read": "The shared store becomes a latency and availability dependency.",
        "local-only": "Replicas react independently and cannot coordinate account-level evidence."
      },
      quota: {
        leases: "The fleet stays inside the account budget without one central call per request.",
        "local-caps": "Replica count multiplies the effective provider cap.",
        "central-call": "Exact accounting adds a hot-path dependency and a new overload point."
      },
      config: {
        versioned: "Replicas can reject stale policy and keep a known usable snapshot.",
        mutable: "Partial updates can expose an invalid mixed state.",
        startup: "A provider incident cannot change routing until restart."
      },
      telemetry: {
        "bounded-async": "A slow sink causes explicit telemetry loss, not unbounded request memory.",
        synchronous: "The sink adds latency and can fail requests.",
        unbounded: "A long outage can exhaust process memory."
      },
      audit: {
        "durable-event": "Stable IDs make replay and consumer deduplication possible.",
        "best-effort": "Loss is acceptable only if the record is not a billing or audit contract.",
        "request-db": "Strong durability now shares the request latency and failure budget."
      },
      tracing: {
        "logical-child": "One user request stays connected to every physical provider attempt.",
        single: "Retry and hedge behavior becomes hard to attribute.",
        "provider-request-id": "Unbounded identifiers create unsafe metric cardinality."
      }
    };
    return consequences[field]?.[value] || "Choose an option to expose its consequence.";
  }

  function renderFailureReadout(failure, moduleId) {
    if (!failure) return `<p>Choose a failure and state what remains available.</p>`;
    const copy = {
      "Shared health store is unavailable": "Forwarding should continue from local state and the last valid, expiring fleet hint. New global policy may pause.",
      "One zone cannot reach Provider A": "Local observations should remove A in that zone without declaring A globally dead.",
      "All replicas restart": "Start from conservative caps and cold health. Probe or ramp traffic instead of restoring full weight at once.",
      "Surviving provider lacks failover capacity": "Admission control must shed excess work. Routing cannot create missing upstream capacity.",
      "Log sink stops accepting writes": "The bounded telemetry queue fills, then applies its stated loss policy while requests continue.",
      "Collector queue is full": "Record dropped telemetry and queue saturation. Adding senders may add pressure to the same blocked sink.",
      "Clients cancel long requests": "Propagate cancellation, release permits once, and classify intentional cancellation as neutral health evidence.",
      "A bad config names a missing provider": "Reject the new version atomically and keep the last known usable config."
    };
    return `<p><strong>Expected boundary:</strong> ${escapeHTML(copy[failure] || `State the request-path behavior for ${moduleId}.`)}</p>`;
  }

  function renderCapacityLab(module) {
    return `
      <section class="capacity-workbench" data-capacity-lab>
        <div class="capacity-inputs">
          <span class="eyebrow">Capacity worksheet</span><h2>Start with rates and ownership</h2>
          ${numberControl("Pages per day", "pagesPerDay", 100000000, 1000, 10000000000)}
          ${numberControl("Mean response KiB", "responseKiB", 200, 1, 100000)}
          ${numberControl("Mean fetch ms", "fetchMs", 400, 1, 60000)}
          ${numberControl("Minimum authority gap ms", "authorityGapMs", 5000, 0, 600000)}
          ${numberControl("Raw retention days", "retentionDays", 30, 1, 3650)}
          ${numberControl("Replication factor", "replication", 2, 1, 5)}
          <button class="primary-button" type="button" data-run-capacity>Calculate constraints</button>
        </div>
        <div class="capacity-output" data-capacity-output>
          <div class="empty-calculator"><span aria-hidden="true">∑</span><p>Run the worksheet. Peak headroom, retries, parse load, and long-tail latency remain separate decisions.</p></div>
        </div>
      </section>
    `;
  }

  function defaultCrawlerConfig() {
    return { scheduler: "host-aware", workers: 8, perHostCap: 1, perIpCap: 2, minDelayMs: 1000, respectRobots: true, seed: 17, scenario: "mixed" };
  }

  function renderCrawlerLab(module) {
    if (!activeCrawlerRun) activeCrawlerRun = Sim.runCrawler(defaultCrawlerConfig());
    return `
      <section class="crawler-workbench" data-crawler-lab>
        <div class="crawler-controls sim-controls">
          <label>Scheduler<select name="scheduler"><option value="host-aware">Host-aware ready heap</option><option value="fifo">Global FIFO</option></select></label>
          <label>Scenario<select name="scenario"><option value="mixed">Mixed public web</option><option value="robots-503">robots.txt 503</option><option value="shared-ip">Two hosts share an IP</option><option value="trap">Infinite calendar trap</option><option value="partition">Stale shard owner</option></select></label>
          <div class="control-pair">${numberControl("Workers", "workers", 8, 1, 64)}${numberControl("Per-host cap", "perHostCap", 1, 1, 8)}</div>
          <div class="control-pair">${numberControl("Per-IP cap", "perIpCap", 2, 1, 16)}${numberControl("Host gap ms", "minDelayMs", 1000, 0, 60000)}</div>
          <label class="check-control"><input type="checkbox" name="respectRobots" checked><span>Respect robots policy</span></label>
          ${numberControl("Seed", "seed", 17, 1, 99999)}
          <button class="primary-button" type="button" data-run-crawler>Drain valid frontier</button>
        </div>
        <div class="crawler-output" data-crawler-output>${renderCrawlerResult(activeCrawlerRun)}</div>
      </section>
    `;
  }

  function renderCrawlerResult(run) {
    const metrics = run.metrics || {};
    const events = (run.events || []).slice(0, 24);
    const hosts = run.hosts || run.hostSummaries || [];
    return `
      <div class="metric-strip crawler-metrics">
        ${metric("Fetched", valueOr(metrics.fetched, 0))}
        ${metric("Blocked", valueOr(metrics.blocked, 0))}
        ${metric("Retries", valueOr(metrics.retries, 0))}
        ${metric("Violations", valueOr(metrics.policyViolations, 0))}
        ${metric("Frontier age p95", `${valueOr(metrics.frontierAgeP95, 0)} ms`)}
      </div>
      <div class="host-queue-grid">
        ${hosts.length ? hosts.map((host) => `<article><div><strong>${escapeHTML(host.host || host.authority || "authority")}</strong><span>${escapeHTML(host.ip || "resolved IP")}</span></div><dl><div><dt>Fetched</dt><dd>${valueOr(host.fetched, 0)}</dd></div><div><dt>Blocked</dt><dd>${valueOr(host.blocked, 0)}</dd></div><div><dt>Next eligible</dt><dd>${valueOr(host.nextAllowedAt, host.nextEligibleAt || 0)} ms</dd></div></dl></article>`).join("") : `<p>No host state returned.</p>`}
      </div>
      <div class="crawler-timeline table-scroll"><table><thead><tr><th>Time</th><th>Authority</th><th>Action</th><th>Reason</th></tr></thead><tbody>
        ${events.map((event) => `<tr><td>${valueOr(event.timeMs, event.at || 0)} ms</td><td>${escapeHTML(event.host || event.authority || "-")}</td><td>${escapeHTML(event.action || event.type || "fetch")}</td><td>${escapeHTML(event.reason || event.status || "eligible")}</td></tr>`).join("")}
      </tbody></table></div>
      ${(run.warnings || []).length ? `<div class="sim-warnings">${run.warnings.map((warning) => `<p><span aria-hidden="true">!</span>${escapeHTML(warning)}</p>`).join("")}</div>` : ""}
    `;
  }

  function renderMockHub() {
    return `
      <section class="mock-hub" aria-labelledby="mock-hub-title"><span class="eyebrow">Timed rehearsals</span><h2 id="mock-hub-title">Practice the three interview loops</h2><div class="mock-card-grid">${course.mocks.map((mock) => `<article><span>${escapeHTML(trackLabels[mock.track])}</span><h3>${escapeHTML(mock.title)}</h3><p>${escapeHTML(mock.artifact)}</p><button class="primary-button compact" type="button" data-route="mock/${mock.id}">Open ${mock.minutes}-minute mock</button></article>`).join("")}</div></section>
    `;
  }

  function quizQuestions(module) {
    return [
      ...module.lessons.map((lesson) => ({ ...lesson.check, source: lesson.title })),
      ...(module.quizExtra || []).map((question) => ({ ...question, source: "Scenario drill" }))
    ];
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
          ${activeQuiz.selected !== null ? `<div class="quiz-feedback ${activeQuiz.selected === question.answer ? "correct" : "incorrect"}"><strong>${activeQuiz.selected === question.answer ? "Correct" : `Answer: ${question.choices[question.answer]}`}</strong><p>${escapeHTML(question.explanation)}</p><button class="primary-button" type="button" data-next-question>${activeQuiz.index === activeQuiz.questions.length - 1 ? "See result" : "Next question"}</button></div>` : ""}
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
        <div class="result-actions"><button class="primary-button" type="button" data-retry-quiz="${escapeAttr(module.id)}">Retry test</button><button class="secondary-button" type="button" data-route="module/${module.id}">Module overview</button></div>
        <div class="answer-review"><h2>Answer review</h2>${activeQuiz.answers.map((answer, index) => { const question = activeQuiz.questions[index]; return `<details ${answer.correct ? "" : "open"}><summary><span>${answer.correct ? "✓" : "×"}</span>${escapeHTML(question.question)}</summary><p><strong>${escapeHTML(question.choices[question.answer])}</strong></p><p>${escapeHTML(question.explanation)}</p></details>`; }).join("")}</div>
      </section>
    `;
    updateProgress();
    renderDrawer(parseRoute());
  }

  function renderMock(mock) {
    const saved = state.mockScores[mock.id] || { scores: {} };
    const notes = state.mockNotes[mock.id] || "";
    if (!activeTimer || activeTimer.mockId !== mock.id) activeTimer = { mockId: mock.id, remaining: mock.minutes * 60, running: false };
    renderBreadcrumbs([{ label: "Control room", route: "home" }, { label: trackLabels[mock.track] }, { label: "Mock interview" }]);
    view.innerHTML = `
      <section class="mock-view" data-mock-id="${escapeAttr(mock.id)}">
        <header class="mock-header">
          <div><span class="eyebrow">${escapeHTML(trackLabels[mock.track])} · opt-in timer</span><h1 tabindex="-1">${escapeHTML(mock.title)}</h1><p>${escapeHTML(mock.artifact)}</p></div>
          <div class="mock-timer" data-timer><output>${formatClock(activeTimer.remaining)}</output><div><button class="primary-button compact" type="button" data-timer-toggle>${activeTimer.running ? "Pause" : "Start timer"}</button><button class="quiet-button" type="button" data-timer-reset>Reset</button></div></div>
        </header>
        <section class="mock-prompt" aria-labelledby="mock-prompt-title"><span class="eyebrow">Candidate prompt</span><h2 id="mock-prompt-title">Design or build from this brief</h2><p>${escapeHTML(mock.prompt)}</p></section>
        <div class="mock-layout">
          <section class="mock-work"><label><span>Whiteboard or coding notes</span><textarea data-mock-notes placeholder="Requirements, estimates, invariants, decisions, failure behavior...">${escapeHTML(notes)}</textarea></label><div class="followup-deck"><h2>Follow-up cards</h2>${mock.followups.map((followup, index) => `<details><summary>Card ${index + 1}</summary><p>${escapeHTML(followup)}</p></details>`).join("")}</div></section>
          <section class="rubric-panel" aria-labelledby="rubric-title"><span class="eyebrow">Score after answering aloud</span><h2 id="rubric-title">Evidence rubric</h2><p>Use 0 for missing, 1 for partial, and 2 for clear and defended.</p>
            <div class="rubric-list">${mock.rubric.map((item, index) => `<label><span><strong>${escapeHTML(item.label)}</strong><small>${escapeHTML(item.detail)}</small></span><select data-rubric-score="${index}" aria-label="Score ${escapeAttr(item.label)}"><option value="">Not scored</option><option value="0" ${saved.scores?.[index] === 0 ? "selected" : ""}>0</option><option value="1" ${saved.scores?.[index] === 1 ? "selected" : ""}>1</option><option value="2" ${saved.scores?.[index] === 2 ? "selected" : ""}>2</option></select></label>`).join("")}</div>
            <button class="primary-button" type="button" data-score-mock>Record mock score</button><div class="mock-score-readout">${saved.percent !== undefined ? `<strong>${saved.percent}%</strong><span>${saved.percent >= 70 ? "Ready signal" : "Schedule another rep"}</span>` : "Score every row when the mock ends."}</div>
          </section>
        </div>
      </section>
    `;
    if (activeTimer.running) startTimerInterval();
  }

  function formatClock(seconds) {
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
  }

  function startTimerInterval() {
    stopTimer(false);
    if (!activeTimer?.running) return;
    timerInterval = setInterval(() => {
      if (!activeTimer?.running) return;
      activeTimer.remaining = Math.max(0, activeTimer.remaining - 1);
      const output = document.querySelector("[data-timer] output");
      if (output) output.textContent = formatClock(activeTimer.remaining);
      if (activeTimer.remaining === 0) {
        activeTimer.running = false;
        stopTimer(false);
        announce("Mock timer complete.");
        showToast("Time. Finish the sentence you are on.");
        const button = document.querySelector("[data-timer-toggle]");
        if (button) button.textContent = "Start timer";
      }
    }, 1000);
  }

  function stopTimer(clearRunning = true) {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    if (clearRunning && activeTimer) activeTimer.running = false;
  }

  function renderNotebook() {
    renderBreadcrumbs([{ label: "Control room", route: "home" }, { label: "Interview notebook" }]);
    view.innerHTML = `
      <section class="notebook-view">
        <header class="notebook-header"><div><span class="eyebrow">Saved evidence</span><h1 tabindex="-1">Interview notebook</h1><p>Keep strategy changes, fixed inputs, results, and what you learned in one place.</p></div><div class="notebook-actions"><button class="secondary-button" type="button" data-copy-notebook>Copy as Markdown</button><button class="quiet-button" type="button" data-export-progress>Export JSON</button><label class="quiet-button file-button">Import JSON<input type="file" accept="application/json" data-import-progress></label></div></header>
        <section class="benchmark-ledger" aria-labelledby="ledger-title"><div class="section-heading"><div><span class="eyebrow">Gateway benchmark ledger</span><h2 id="ledger-title">One change per run</h2></div></div>
          ${state.benchmarks.length ? `<div class="table-scroll"><table><thead><tr><th>Compare</th><th>Policy</th><th>Scenario</th><th>Success</th><th>p95</th><th>Calls/request</th><th>Note</th><th></th></tr></thead><tbody>${state.benchmarks.map((run, index) => `<tr><td><input type="checkbox" data-compare-run="${index}" aria-label="Compare run ${index + 1}"></td><td><strong>${escapeHTML(run.config?.policy || "policy")}</strong><small>${escapeHTML(run.fingerprint || "")}</small></td><td>${escapeHTML(run.config?.scenario || "-")}</td><td>${valueOr(run.metrics?.successRate, 0)}%</td><td>${valueOr(run.metrics?.p95, 0)} ms</td><td>${valueOr(run.metrics?.attemptsPerRequest, 0)}</td><td><textarea data-benchmark-note="${index}" aria-label="Note for run ${index + 1}" placeholder="What changed and why?">${escapeHTML(run.note || "")}</textarea></td><td><button class="icon-button" type="button" data-delete-run="${index}" aria-label="Delete run ${index + 1}">×</button></td></tr>`).join("")}</tbody></table></div><div class="compare-bar"><button class="primary-button compact" type="button" data-compare-selected>Compare two runs</button><p data-compare-output>Select exactly two rows.</p></div>` : `<div class="empty-state compact"><h3>No saved runs yet.</h3><p>Open the adaptive routing lab, run a fixed seed, and save the result.</p><button class="primary-button compact" type="button" data-route="lab/adaptive-routing">Open gateway lab</button></div>`}
        </section>
        <section class="artifact-grid" aria-labelledby="artifact-title"><div class="section-heading"><div><span class="eyebrow">Mock artifacts</span><h2 id="artifact-title">Scores and next gaps</h2></div></div><div class="mock-card-grid">${course.mocks.map((mock) => { const saved = state.mockScores[mock.id]; return `<article><span>${escapeHTML(trackLabels[mock.track])}</span><h3>${escapeHTML(mock.title)}</h3><strong>${saved ? `${saved.percent}%` : "Not scored"}</strong><p>${escapeHTML(mock.artifact)}</p><button class="text-button" type="button" data-route="mock/${mock.id}">${saved ? "Run another rep" : "Start mock"} →</button></article>`; }).join("")}</div></section>
      </section>
    `;
  }

  const searchIndex = [
    ...course.modules.map((module) => ({ title: module.title, subtitle: `${trackLabels[module.track]} module`, route: `module/${module.id}`, terms: `${module.description} ${module.outcomes.join(" ")}` })),
    ...allLessons.map(({ lesson, module }) => ({ title: lesson.title, subtitle: `${trackLabels[module.track]} · Module ${module.number}`, route: `lesson/${lesson.id}`, terms: `${lesson.summary} ${lesson.core.join(" ")} ${lesson.mechanics.map((item) => `${item.title} ${item.text}`).join(" ")}` })),
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
      self.fetch = () => { throw new Error("Network access is disabled in this exercise"); };
      self.XMLHttpRequest = undefined;
      self.WebSocket = undefined;
      self.onmessage = async (event) => {
        const data = event.data;
        const cases = [];
        const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
        const check = async (name, run, expected) => {
          try {
            const actual = await run();
            cases.push({ name, ok: equal(actual, expected), message: equal(actual, expected) ? "" : "Expected " + JSON.stringify(expected) + ", received " + JSON.stringify(actual) });
          } catch (error) {
            cases.push({ name, ok: false, message: error?.message || String(error) });
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
          const passedCount = cases.filter((item) => item.ok).length;
          self.postMessage({ cases, passedCount, failed: cases.length - passedCount, total: cases.length, passed: passedCount === cases.length });
        } catch (error) {
          self.postMessage({ cases: [{ name: "Load solution", ok: false, message: error?.message || String(error) }], passedCount: 0, failed: 1, total: 1, passed: false });
        }
      };
    `;
    const url = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }));
    const worker = new Worker(url);
    try {
      return await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          worker.terminate();
          resolve({ cases: [{ name: "Execution limit", ok: false, message: "The solution exceeded 1.5 seconds." }], passedCount: 0, failed: 1, total: 1, passed: false });
        }, 1500);
        worker.onmessage = (event) => {
          clearTimeout(timeout);
          resolve(event.data);
        };
        worker.onerror = (event) => {
          clearTimeout(timeout);
          resolve({ cases: [{ name: "Worker error", ok: false, message: event.message || "The solution could not run." }], passedCount: 0, failed: 1, total: 1, passed: false });
        };
        worker.postMessage({ exerciseId, functionName: exercise.functionName, code });
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
      lines.push(`## Run ${index + 1}: ${run.config?.policy || "policy"}`, "", `- Fingerprint: \`${run.fingerprint || "n/a"}\``, `- Scenario: ${run.config?.scenario || "n/a"}`, `- Offered RPS: ${run.config?.rps || "n/a"}`, `- Success: ${run.metrics?.successRate || 0}%`, `- p50 / p95 / p99: ${run.metrics?.p50 || 0} / ${run.metrics?.p95 || 0} / ${run.metrics?.p99 || 0} ms`, `- Calls per request: ${run.metrics?.attemptsPerRequest || 0}`, `- Note: ${run.note || "Add the hypothesis and result."}`, "");
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
      if (correct) {
        if (!state.completedLessons.includes(entry.lesson.id)) state.completedLessons.push(entry.lesson.id);
        saveState();
        updateProgress();
        renderDrawer(parseRoute());
        root.querySelector(".completion-chip").textContent = "Recorded";
        root.querySelector(".completion-chip").classList.add("complete");
        announce("Correct answer. Lesson evidence recorded.");
      }
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
      return;
    }

    if (event.target.closest("[data-next-question]") && activeQuiz) {
      if (activeQuiz.index >= activeQuiz.questions.length - 1) activeQuiz.finished = true;
      else { activeQuiz.index += 1; activeQuiz.selected = null; }
      renderQuiz(moduleById.get(activeQuiz.moduleId));
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
      activeGatewayRun = Sim.runGateway(config);
      const output = gatewayButton.closest("[data-gateway-scope]").querySelector("[data-gateway-output]");
      output.innerHTML = renderGatewayResult(activeGatewayRun, scope === "home");
      announce(`Gateway run complete. ${activeGatewayRun.metrics?.successRate || 0}% success, p95 ${activeGatewayRun.metrics?.p95 || 0} milliseconds.`);
      return;
    }

    if (event.target.closest("[data-save-benchmark]")) {
      if (!activeGatewayRun) return;
      const snapshot = {
        config: structuredClone(activeGatewayRun.config || defaultGatewayConfig()),
        metrics: structuredClone(activeGatewayRun.metrics || {}),
        providers: structuredClone(activeGatewayRun.providers || {}),
        warnings: structuredClone(activeGatewayRun.warnings || []),
        fingerprint: activeGatewayRun.fingerprint || Sim.stableFingerprint(activeGatewayRun.config || {}),
        savedAt: new Date().toISOString(),
        note: ""
      };
      state.benchmarks.unshift(snapshot);
      state.benchmarks = state.benchmarks.slice(0, 40);
      const route = parseRoute();
      if (route.type === "lab" && ["adaptive-routing", "concurrency-resilience"].includes(route.id)) completeLab(route.id, "Benchmark saved. Lab evidence recorded.");
      else { saveState(); showToast("Benchmark saved."); }
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
      state.codeResults[exerciseId] = result;
      saveState();
      output.className = `test-results ${result.passed ? "passed" : "failed"}`;
      output.innerHTML = renderCodeResult(result);
      runCodeButton.disabled = false;
      runCodeButton.textContent = "Run tests";
      if (result.passed) {
        const moduleId = Object.entries(codeExercises).find(([, exercise]) => exercise.id === exerciseId)?.[0];
        completeLab(moduleId, "All tests passed. Lab evidence recorded.");
      }
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

    const checkDesignButton = event.target.closest("[data-check-design]");
    if (checkDesignButton) {
      const moduleId = checkDesignButton.dataset.checkDesign;
      const design = state.designs[moduleId] || {};
      const required = moduleId === "production-fleet" ? ["health", "quota", "config"] : ["telemetry", "audit", "tracing"];
      const missing = required.filter((field) => !design[field]);
      const status = checkDesignButton.parentElement.querySelector("[data-design-status]");
      if (missing.length || !design.failure || String(design.rationale || "").trim().length < 40) {
        status.textContent = "Choose every boundary, inject a failure, and write at least 40 characters of rationale.";
        status.classList.add("error");
      } else {
        design.checked = true;
        state.designs[moduleId] = design;
        completeLab(moduleId, "Design evidence recorded.");
        status.textContent = "Design evidence recorded. Practice saying the rationale without reading it.";
        status.classList.remove("error");
      }
      return;
    }

    if (event.target.closest("[data-run-capacity]")) {
      const root = event.target.closest("[data-capacity-lab]");
      const value = (name) => Number(root.querySelector(`[name="${name}"]`).value);
      const pages = value("pagesPerDay");
      const qps = pages / 86400;
      const bytesPerDay = pages * value("responseKiB") * 1024;
      const inflight = qps * (value("fetchMs") / 1000);
      const authorities = qps * (value("authorityGapMs") / 1000);
      const retained = bytesPerDay * value("retentionDays") * value("replication");
      root.querySelector("[data-capacity-output]").innerHTML = `<div class="capacity-result-grid">${metric("Average fetch rate", `${qps.toLocaleString(undefined, { maximumFractionDigits: 0 })} /s`)}${metric("Raw ingress", `${(bytesPerDay / 1e12).toFixed(2)} TB/day`)}${metric("Mean in flight", inflight.toLocaleString(undefined, { maximumFractionDigits: 0 }))}${metric("Ready authorities", authorities.toLocaleString(undefined, { maximumFractionDigits: 0 }))}${metric("Retained raw bytes", `${(retained / 1e15).toFixed(2)} PB`)}</div><div class="formula-sheet"><code>fetch_qps = pages_per_day / 86,400</code><code>mean_inflight = fetch_qps × mean_fetch_seconds</code><code>active_authorities ≥ fetch_qps × authority_gap_seconds</code><p>Now add peak headroom, retries, parse throughput, long tails, indexes, and metadata.</p></div>`;
      completeLab("crawler-request-path", "Capacity worksheet recorded.");
      return;
    }

    if (event.target.closest("[data-run-crawler]")) {
      const root = event.target.closest("[data-crawler-lab]");
      const read = (name) => root.querySelector(`[name="${name}"]`);
      const config = {
        scheduler: read("scheduler").value,
        scenario: read("scenario").value,
        workers: Number(read("workers").value),
        perHostCap: Number(read("perHostCap").value),
        perIpCap: Number(read("perIpCap").value),
        minDelayMs: Number(read("minDelayMs").value),
        respectRobots: read("respectRobots").checked,
        seed: Number(read("seed").value)
      };
      activeCrawlerRun = Sim.runCrawler(config);
      root.querySelector("[data-crawler-output]").innerHTML = renderCrawlerResult(activeCrawlerRun);
      const violations = Number(activeCrawlerRun.metrics?.policyViolations || 0);
      if (violations === 0) completeLab("crawler-frontier", "Frontier drained with zero policy violations.");
      else showToast(`${violations} policy violation${violations === 1 ? "" : "s"}. Adjust the scheduler or limits.`);
      announce(`Crawler run complete with ${violations} policy violations.`);
      return;
    }

    if (event.target.closest("[data-timer-toggle]")) {
      activeTimer.running = !activeTimer.running;
      event.target.closest("[data-timer-toggle]").textContent = activeTimer.running ? "Pause" : "Start timer";
      if (activeTimer.running) startTimerInterval(); else stopTimer(false);
      return;
    }

    if (event.target.closest("[data-timer-reset]")) {
      const mock = mockById.get(activeTimer.mockId);
      activeTimer.remaining = mock.minutes * 60;
      activeTimer.running = false;
      stopTimer(false);
      document.querySelector("[data-timer] output").textContent = formatClock(activeTimer.remaining);
      document.querySelector("[data-timer-toggle]").textContent = "Start timer";
      return;
    }

    if (event.target.closest("[data-score-mock]")) {
      const root = event.target.closest("[data-mock-id]");
      const mock = mockById.get(root.dataset.mockId);
      const selects = [...root.querySelectorAll("[data-rubric-score]")];
      if (selects.some((select) => select.value === "")) {
        showToast("Score every rubric row first.");
        return;
      }
      const scores = Object.fromEntries(selects.map((select) => [select.dataset.rubricScore, Number(select.value)]));
      const earned = Object.values(scores).reduce((sum, value) => sum + value, 0);
      const total = mock.rubric.length * 2;
      const percent = Math.round((earned / total) * 100);
      state.mockScores[mock.id] = { scores, earned, total, percent, scoredAt: new Date().toISOString() };
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
      const [a, b] = selected.map((index) => state.benchmarks[index]);
      const successDelta = Number(b.metrics.successRate || 0) - Number(a.metrics.successRate || 0);
      const latencyDelta = Number(b.metrics.p95 || 0) - Number(a.metrics.p95 || 0);
      const callDelta = Number(b.metrics.attemptsPerRequest || 0) - Number(a.metrics.attemptsPerRequest || 0);
      output.textContent = `Second minus first: success ${successDelta >= 0 ? "+" : ""}${successDelta.toFixed(1)} points, p95 ${latencyDelta >= 0 ? "+" : ""}${latencyDelta} ms, calls/request ${callDelta >= 0 ? "+" : ""}${callDelta.toFixed(2)}.`;
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
      state = structuredClone(defaultState);
      activeQuiz = null;
      activeGatewayRun = null;
      activeCrawlerRun = null;
      activeTimer = null;
      renderRoute();
      showToast("Course progress reset.");
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.matches("[data-code-editor]")) {
      const root = event.target.closest("[data-code-exercise]");
      state.codeDrafts[root.dataset.codeExercise] = event.target.value;
      saveState();
    }
    if (event.target.matches("[data-design-field]")) {
      const root = event.target.closest("[data-design-board]");
      const design = state.designs[root.dataset.designBoard] || {};
      design[event.target.dataset.designField] = event.target.value;
      state.designs[root.dataset.designBoard] = design;
      saveState();
      if (event.target.tagName === "SELECT" && event.target.dataset.designField !== "failure") {
        const small = event.target.closest("label")?.querySelector("small");
        if (small) small.textContent = designConsequence(event.target.dataset.designField, event.target.value);
      }
      if (event.target.dataset.designField === "failure") {
        const readout = root.querySelector("[data-failure-readout]");
        if (readout) readout.innerHTML = renderFailureReadout(event.target.value, root.dataset.designBoard);
      }
    }
    if (event.target.matches("[data-mock-notes]")) {
      const root = event.target.closest("[data-mock-id]");
      state.mockNotes[root.dataset.mockId] = event.target.value;
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
    if (event.target === modeSelect) {
      state.mode = modeSelect.value;
      saveState();
      if (parseRoute().type === "lesson") renderRoute();
    }
    if (event.target.matches("[data-import-progress]")) {
      const file = event.target.files?.[0];
      if (!file) return;
      try {
        const payload = JSON.parse(await file.text());
        if (payload.format !== "decagon-prep-v1" || !payload.state) throw new Error("Unsupported preparation record");
        localStorage.setItem(storageKey, JSON.stringify(payload.state));
        state = loadState();
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
    if (event.key === "Escape" && document.body.classList.contains("map-open")) setMobileMap(false);
  });

  window.addEventListener("hashchange", renderRoute);
  window.addEventListener("resize", () => {
    if (!matchMedia("(max-width: 820px)").matches) setMobileMap(false);
  });

  if (modeSelect) modeSelect.value = state.mode;
  renderRoute();
})();
