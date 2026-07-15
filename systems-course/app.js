(() => {
  "use strict";

  const course = window.COURSE;
  course.modules.sort((a, b) => Number(a.number) - Number(b.number));

  const allLessons = course.modules.flatMap((module) =>
    module.lessons.map((lesson, index) => ({ lesson, module, index }))
  );
  const lessonById = new Map(allLessons.map((entry) => [entry.lesson.id, entry]));
  const moduleById = new Map(course.modules.map((module) => [module.id, module]));
  const storageKey = `below-the-pod:v${course.version}`;
  const defaultState = {
    completedLessons: [],
    completedLabs: [],
    quizScores: {},
    capstoneComplete: false,
    depth: "core",
    lastRoute: "home"
  };

  let state = loadState();
  let activeQuiz = null;
  let activeLab = null;
  let activeIncident = { evidence: [], hypothesis: null };
  let activeSearchIndex = 0;
  let toastTimer;

  const view = document.querySelector("#course-view");
  const moduleNav = document.querySelector("#module-nav");
  const drawer = document.querySelector("#context-drawer");
  const breadcrumbs = document.querySelector("#breadcrumbs");
  const searchDialog = document.querySelector("#search-dialog");
  const searchInput = document.querySelector("#search-input");
  const searchResults = document.querySelector("#search-results");
  const depthSelect = document.querySelector("#depth-select");

  function loadState() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (!saved || typeof saved !== "object") return structuredClone(defaultState);
      return {
        ...structuredClone(defaultState),
        ...saved,
        completedLessons: Array.isArray(saved.completedLessons) ? saved.completedLessons : [],
        completedLabs: Array.isArray(saved.completedLabs) ? saved.completedLabs : [],
        quizScores: saved.quizScores && typeof saved.quizScores === "object" ? saved.quizScores : {}
      };
    } catch {
      return structuredClone(defaultState);
    }
  }

  function saveState() {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      announce("Progress could not be saved in this browser.");
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

  function goToRoute(route) {
    setMobileMap(false);
    const nextHash = `#${route}`;
    if (location.hash === nextHash) {
      renderRoute();
    } else {
      location.hash = route;
    }
  }

  function currentRoute() {
    const raw = location.hash.replace(/^#\/?/, "");
    return raw || state.lastRoute || "home";
  }

  function parseRoute() {
    const [type = "home", id] = currentRoute().split("/");
    return { type, id };
  }

  function completedLessonCount(module) {
    return module.lessons.filter((lesson) => state.completedLessons.includes(lesson.id)).length;
  }

  function moduleComplete(module) {
    return (
      completedLessonCount(module) === module.lessons.length &&
      state.completedLabs.includes(module.id) &&
      Object.hasOwn(state.quizScores, module.id)
    );
  }

  function progressStats() {
    const total = allLessons.length + course.modules.length * 2 + 1;
    const complete =
      state.completedLessons.length +
      state.completedLabs.length +
      Object.keys(state.quizScores).length +
      Number(state.capstoneComplete);
    return { total, complete, percent: Math.round((complete / total) * 100) };
  }

  function moduleStyle(module) {
    return `--module-color:${module.color};--module-soft:${module.soft}`;
  }

  function lessonPosition(lessonId) {
    return allLessons.findIndex((entry) => entry.lesson.id === lessonId);
  }

  function formatMinutes(minutes) {
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    return rest ? `${hours} hr ${rest} min` : `${hours} hr`;
  }

  function announce(message) {
    document.querySelector("#live-region").textContent = message;
  }

  function showToast(message) {
    const toast = document.querySelector("#toast");
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.classList.add("show");
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
  }

  function renderNav(activeModuleId) {
    moduleNav.innerHTML = course.modules
      .map((module) => {
        const complete = moduleComplete(module);
        return `
          <button
            class="module-nav-button"
            type="button"
            data-route="${routeFor("module", module.id)}"
            ${activeModuleId === module.id ? 'aria-current="page"' : ""}
          >
            <span class="nav-index">${module.number}</span>
            <span class="nav-label">${escapeHTML(module.shortTitle)}</span>
            <span class="nav-status ${complete ? "complete" : ""}" aria-label="${complete ? "Complete" : "In progress"}"></span>
          </button>
        `;
      })
      .join("");
  }

  function updateProgress() {
    const stats = progressStats();
    const bar = document.querySelector("#progress-bar");
    const track = bar.parentElement;
    document.querySelector("#progress-percent").textContent = `${stats.percent}%`;
    document.querySelector("#progress-detail").textContent = `${stats.complete} of ${stats.total} course checkpoints complete`;
    bar.style.width = `${stats.percent}%`;
    track.setAttribute("aria-valuenow", String(stats.percent));
  }

  function renderBreadcrumbs(parts) {
    breadcrumbs.innerHTML = parts
      .map((part, index) => {
        const item = part.route
          ? `<button type="button" data-route="${part.route}">${escapeHTML(part.label)}</button>`
          : `<span aria-current="page">${escapeHTML(part.label)}</span>`;
        return `${index ? '<span class="breadcrumb-separator" aria-hidden="true">/</span>' : ""}${item}`;
      })
      .join("");
  }

  function renderHome() {
    const nextLesson = allLessons.find(({ lesson }) => !state.completedLessons.includes(lesson.id)) || allLessons[0];
    const stats = progressStats();
    renderBreadcrumbs([{ label: "Course home" }]);

    view.innerHTML = `
      <div class="home-view">
        <section class="hero-grid" aria-labelledby="home-title">
          <div class="hero-copy">
            <span class="eyebrow">Interactive systems course</span>
            <h1 class="hero-title" id="home-title"><span>Below</span><span>the Pod</span></h1>
            <p class="hero-lede">
              Start with the Kubernetes objects you know, then trace execution down to syscalls,
              page tables, KVM, virtio queues, block requests, and CPU cache lines.
            </p>
            <div class="hero-actions">
              <button class="primary-button" type="button" data-route="${routeFor("lesson", nextLesson.lesson.id)}">
                ${stats.complete ? "Continue course" : "Start the systems trace"}
              </button>
              <button class="secondary-button" type="button" data-route="module/kernel-boundary">View course map</button>
            </div>
            <ul class="hero-facts" aria-label="Course facts">
              <li>30 lessons</li>
              <li>10 workbenches</li>
              <li>10 retrieval checks</li>
              <li>1 incident capstone</li>
            </ul>
          </div>

          <div class="stack-console" id="stack-console">
            <div class="stack-panel">
              <span class="stack-panel-label">Scope lens · select a layer</span>
              ${course.stackLayers
                .map(
                  (layer, index) => `
                    <button class="stack-layer ${index === 0 ? "active" : ""}" type="button" data-stack-id="${layer.id}">
                      <span class="stack-layer-index">${String(index + 1).padStart(2, "0")}</span>
                      <span class="stack-layer-name">${escapeHTML(layer.name)}</span>
                      <span class="stack-layer-scope">${escapeHTML(layer.scope)}</span>
                    </button>
                  `
                )
                .join("")}
            </div>
            <div class="stack-inspector">
              <div class="stack-pulse" aria-hidden="true"><span class="pulse-line"></span></div>
              <div class="stack-readout" id="stack-readout"></div>
            </div>
          </div>
        </section>

        <section aria-labelledby="course-shape-title">
          <div class="section-heading">
            <span class="eyebrow">Learning model</span>
            <h2 id="course-shape-title">One machine trace, three levels of detail</h2>
            <p>Every lesson starts with a working model. Change the depth control when you want kernel mechanics or repository code.</p>
          </div>
          <div class="course-brief">
            <div class="brief-stat"><strong>${course.modules.length}</strong><span>ordered modules</span></div>
            <div class="brief-stat"><strong>${formatMinutes(course.totalMinutes)}</strong><span>with labs</span></div>
            <div class="brief-stat"><strong>${stats.percent}%</strong><span>saved on this device</span></div>
          </div>
        </section>

        <section aria-labelledby="modules-title">
          <div class="section-heading">
            <span class="eyebrow">Course map</span>
            <h2 id="modules-title">Build the stack in dependency order</h2>
            <p>Modules are self-contained, but the abstraction trace becomes more useful when completed in order.</p>
          </div>
          <div class="module-grid">
            ${course.modules.map(renderModuleCard).join("")}
          </div>
        </section>

        <section class="path-note" aria-labelledby="capstone-note-title">
          <strong>XI</strong>
          <div>
            <h3 id="capstone-note-title">Capstone: trace one sandbox incident</h3>
            <p>Scheduler placement concentrates cold caches on one node. Use pressure, cgroup, NBD, mmap, and S3 evidence to prove the bottleneck.</p>
            <button class="small-button" type="button" data-route="capstone">Open the incident</button>
          </div>
        </section>
      </div>
    `;

    initStackExplorer();
  }

  function renderModuleCard(module) {
    const complete = completedLessonCount(module);
    const percent = Math.round((complete / module.lessons.length) * 100);
    return `
      <button
        class="module-card"
        type="button"
        data-route="${routeFor("module", module.id)}"
        style="${moduleStyle(module)}"
      >
        <span>
          <span class="module-card-head">
            <span class="module-index">MODULE ${module.number}</span>
            <span class="module-duration">${formatMinutes(module.duration)}</span>
          </span>
          <h3>${escapeHTML(module.title)}</h3>
          <p>${escapeHTML(module.description)}</p>
        </span>
        <span>
          <span class="module-topic-list" aria-label="Lessons">
            ${module.lessons.map((lesson) => `<span>${escapeHTML(lesson.title)}</span>`).join("")}
          </span>
          <span class="card-progress">
            <span class="card-progress-track"><span style="width:${percent}%"></span></span>
            ${complete}/${module.lessons.length} lessons
          </span>
        </span>
      </button>
    `;
  }

  function initStackExplorer() {
    const first = course.stackLayers[0];
    updateStackReadout(first);
  }

  function updateStackReadout(layer) {
    const readout = document.querySelector("#stack-readout");
    if (!readout) return;
    readout.innerHTML = `
      <span class="eyebrow">${escapeHTML(layer.scope)} scope</span>
      <h2>${escapeHTML(layer.name)}</h2>
      <p>${escapeHTML(layer.next)}.</p>
      <div class="readout-grid">
        <div class="readout-cell"><span>Owns</span><strong>${escapeHTML(layer.owns)}</strong></div>
        <div class="readout-cell"><span>Hides</span><strong>${escapeHTML(layer.hides)}</strong></div>
      </div>
    `;
  }

  function renderModule(module) {
    const complete = completedLessonCount(module);
    renderBreadcrumbs([
      { label: "Course home", route: "home" },
      { label: `Module ${module.number}` }
    ]);

    view.innerHTML = `
      <div class="module-view" style="${moduleStyle(module)}">
        <header class="module-hero">
          <div class="module-hero-copy">
            <span class="eyebrow">Module ${module.number} · ${formatMinutes(module.duration)}</span>
            <h1>${escapeHTML(module.title)}</h1>
            <p>${escapeHTML(module.description)}</p>
          </div>
          <div class="module-schematic" aria-label="Module trace">
            <span class="schematic-label">Working trace</span>
            <div class="schematic-track">
              ${module.trace
                .map(
                  (step, index) => `
                    <div class="schematic-node">
                      <span>${String(index + 1).padStart(2, "0")}</span>
                      <span>${escapeHTML(step)}</span>
                    </div>
                  `
                )
                .join("")}
            </div>
          </div>
        </header>

        <section class="module-outcomes" aria-label="Learning outcomes">
          ${module.outcomes
            .map(
              (outcome, index) => `
                <div class="outcome-card">
                  <span>Outcome ${index + 1}</span>
                  <p>${escapeHTML(outcome)}</p>
                </div>
              `
            )
            .join("")}
        </section>

        <section aria-labelledby="lesson-lane-title">
          <div class="section-heading">
            <span class="eyebrow">${complete}/${module.lessons.length} lessons complete</span>
            <h2 id="lesson-lane-title">Lessons</h2>
          </div>
          <div class="lesson-lane">
            ${module.lessons
              .map((lesson) => {
                const isComplete = state.completedLessons.includes(lesson.id);
                return `
                  <button
                    class="lesson-card ${isComplete ? "complete" : ""}"
                    type="button"
                    data-route="${routeFor("lesson", lesson.id)}"
                  >
                    <span class="lesson-card-index">${isComplete ? "✓" : lesson.number}</span>
                    <span class="lesson-card-copy">
                      <h3>${escapeHTML(lesson.title)}</h3>
                      <p>${escapeHTML(lesson.summary)}</p>
                    </span>
                    <span class="lesson-card-meta"><span>${lesson.duration} min</span><span>${isComplete ? "complete" : "not started"}</span></span>
                  </button>
                `;
              })
              .join("")}
          </div>
        </section>

        <section class="module-gates" aria-label="Module practice">
          <article class="gate-card">
            <div>
              <span class="eyebrow">Work the model</span>
              <h3>${escapeHTML(module.lab.title)}</h3>
              <p>${escapeHTML(module.lab.intro)}</p>
            </div>
            <button class="primary-button" type="button" data-route="${routeFor("lab", module.id)}">
              ${state.completedLabs.includes(module.id) ? "Reopen workbench" : "Open workbench"}
            </button>
          </article>
          <article class="gate-card">
            <div>
              <span class="eyebrow">Retrieval check</span>
              <h3>Explain it without the diagram</h3>
              <p>Answer a short set drawn from this module. Every choice includes a mechanism-level explanation.</p>
            </div>
            <button class="secondary-button" type="button" data-route="${routeFor("quiz", module.id)}">
              ${Object.hasOwn(state.quizScores, module.id) ? `Retry · best ${state.quizScores[module.id]}%` : "Start check"}
            </button>
          </article>
        </section>
      </div>
    `;
  }

  function renderFlowVisual(lesson, module) {
    if (!lesson.visual) return "";
    return `
      <div class="inline-visual" style="${moduleStyle(module)}">
        <div class="visual-head">
          <h3>${escapeHTML(lesson.visual.title)}</h3>
          <span>Select each boundary</span>
        </div>
        <div class="flow-diagram">
          ${lesson.visual.nodes
            .map(
              ([name, label], index) => `
                ${index ? '<span class="flow-arrow" aria-hidden="true">→</span>' : ""}
                <button class="flow-node ${index === 0 ? "active" : ""}" type="button" data-flow-step="${index}">
                  <strong>${escapeHTML(name)}</strong>
                  <small>${escapeHTML(label)}</small>
                </button>
              `
            )
            .join("")}
        </div>
      </div>
    `;
  }

  function renderLesson(lesson, module) {
    const globalIndex = lessonPosition(lesson.id);
    const previous = allLessons[globalIndex - 1];
    const next = allLessons[globalIndex + 1];
    const isComplete = state.completedLessons.includes(lesson.id);
    renderBreadcrumbs([
      { label: "Course home", route: "home" },
      { label: `Module ${module.number}`, route: routeFor("module", module.id) },
      { label: lesson.title }
    ]);

    view.innerHTML = `
      <article class="lesson-view" style="${moduleStyle(module)}">
        <header class="lesson-header">
          <div>
            <div class="lesson-kicker">
              <span>Lesson ${lesson.number}</span>
              <span>${lesson.duration} min</span>
              <span>${escapeHTML(module.shortTitle)}</span>
            </div>
            <h1>${escapeHTML(lesson.title)}</h1>
            <p class="lesson-deck">${escapeHTML(lesson.summary)}</p>
          </div>
          <div class="lesson-number-plate" aria-hidden="true">${lesson.number}</div>
        </header>

        <aside class="prediction-card" aria-labelledby="prediction-title">
          <span class="prediction-icon">?</span>
          <div>
            <h2 id="prediction-title">Predict before reading</h2>
            <p>${escapeHTML(lesson.prediction)}</p>
          </div>
        </aside>

        <section class="concept-section" aria-labelledby="model-title">
          <div class="concept-label"><span>01 · Mental model</span><h2 id="model-title">Build the boundary</h2></div>
          <div class="concept-body">
            ${lesson.core.map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`).join("")}
            ${renderFlowVisual(lesson, module)}
          </div>
        </section>

        <section class="concept-section" aria-labelledby="mechanics-title">
          <div class="concept-label"><span>02 · Mechanics</span><h2 id="mechanics-title">Name the moving parts</h2></div>
          <div class="concept-body">
            <div class="mechanic-grid">
              ${lesson.mechanics
                .map(
                  (item) => `
                    <article class="mechanic-card">
                      <h3>${escapeHTML(item.title)}</h3>
                      <p>${escapeHTML(item.text)}</p>
                    </article>
                  `
                )
                .join("")}
            </div>
            <div class="depth-kernel">
              ${lesson.kernel.map((paragraph) => `<p>${escapeHTML(paragraph)}</p>`).join("")}
            </div>
          </div>
        </section>

        <section class="concept-section" aria-labelledby="bridge-title">
          <div class="concept-label"><span>03 · Production</span><h2 id="bridge-title">Connect it to the platform</h2></div>
          <div class="concept-body">
            <div class="bridge-card"><h3>${escapeHTML(lesson.bridge.title)}</h3><p>${escapeHTML(lesson.bridge.text)}</p></div>
            <div class="failure-card"><h3>${escapeHTML(lesson.failure.title)}</h3><p>${escapeHTML(lesson.failure.text)}</p></div>
            ${lesson.codebase
              ? `
                <div class="codebase-card depth-code">
                  <h3>${escapeHTML(lesson.codebase.title)}</h3>
                  <p>${escapeHTML(lesson.codebase.text)}</p>
                  <a class="codebase-link" href="${escapeAttr(lesson.codebase.url)}" target="_blank" rel="noopener">${escapeHTML(lesson.codebase.label)} ↗</a>
                </div>
              `
              : ""}
          </div>
        </section>

        <section class="lesson-check" aria-labelledby="lesson-check-title">
          <span class="eyebrow">Quick check</span>
          <h2 id="lesson-check-title">${escapeHTML(lesson.check.question)}</h2>
          <div class="micro-choice-grid">
            ${lesson.check.choices
              .map(
                (choice, index) => `
                  <button
                    class="micro-choice"
                    type="button"
                    data-micro-answer="${index}"
                    data-correct-answer="${lesson.check.answer}"
                  >${escapeHTML(choice)}</button>
                `
              )
              .join("")}
          </div>
          <p class="micro-feedback" id="micro-feedback" aria-live="polite">Choose an answer to reveal the mechanism.</p>
        </section>

        <section class="lesson-sources-inline" aria-labelledby="lesson-sources-title">
          <span class="eyebrow">Primary sources</span>
          <h2 id="lesson-sources-title">Continue with the source material</h2>
          <ul class="source-list">
            ${lesson.sources
              .map(
                ([title, url], index) => `
                  <li><a class="source-link" href="${escapeAttr(url)}" target="_blank" rel="noopener"><span class="source-icon">${String(index + 1).padStart(2, "0")}</span><span>${escapeHTML(title)} ↗</span></a></li>
                `
              )
              .join("")}
          </ul>
        </section>

        <nav class="lesson-footer-nav" aria-label="Lesson navigation">
          ${previous
            ? `<button class="secondary-button" type="button" data-route="${routeFor("lesson", previous.lesson.id)}">← ${escapeHTML(previous.lesson.title)}</button>`
            : `<button class="secondary-button" type="button" data-route="home">← Course home</button>`}
          ${next
            ? `<button class="primary-button" type="button" data-route="${routeFor("lesson", next.lesson.id)}">${escapeHTML(next.lesson.title)} →</button>`
            : `<button class="primary-button" type="button" data-route="capstone">Open capstone →</button>`}
        </nav>
      </article>
    `;

    if (isComplete) announce(`${lesson.title} is marked complete.`);
  }

  function renderDrawer(route) {
    const stats = progressStats();
    if (route.type === "lesson" && lessonById.has(route.id)) {
      const { lesson, module } = lessonById.get(route.id);
      const isComplete = state.completedLessons.includes(lesson.id);
      drawer.innerHTML = `
        <div class="drawer-inner" style="${moduleStyle(module)}">
          <section class="drawer-section">
            <span class="eyebrow">Lesson ${lesson.number}</span>
            <h2>${escapeHTML(lesson.title)}</h2>
            <button class="primary-button ${isComplete ? "complete" : ""}" type="button" data-complete-lesson="${lesson.id}">
              ${isComplete ? "✓ Lesson complete" : "Mark lesson complete"}
            </button>
          </section>
          <section class="drawer-section">
            <h3>Primary sources</h3>
            <ul class="source-list">
              ${lesson.sources
                .map(
                  ([title, url], index) => `
                    <li><a class="source-link" href="${escapeAttr(url)}" target="_blank" rel="noopener"><span class="source-icon">${String(index + 1).padStart(2, "0")}</span><span>${escapeHTML(title)} ↗</span></a></li>
                  `
                )
                .join("")}
            </ul>
          </section>
          <section class="drawer-section">
            <h3>Module map</h3>
            <ul class="lesson-mini-map">
              ${module.lessons
                .map(
                  (item) => `
                    <li>
                      <button class="lesson-mini-link" type="button" data-route="${routeFor("lesson", item.id)}">
                        <span class="mini-status ${state.completedLessons.includes(item.id) ? "complete" : ""}">${state.completedLessons.includes(item.id) ? "✓" : item.number}</span>
                        <span>${escapeHTML(item.title)}</span>
                      </button>
                    </li>
                  `
                )
                .join("")}
            </ul>
          </section>
        </div>
      `;
      return;
    }

    if (["module", "quiz", "lab"].includes(route.type) && moduleById.has(route.id)) {
      const module = moduleById.get(route.id);
      const percent = Math.round((completedLessonCount(module) / module.lessons.length) * 100);
      drawer.innerHTML = `
        <div class="drawer-inner" style="${moduleStyle(module)}">
          <section class="drawer-section">
            <span class="eyebrow">Module ${module.number}</span>
            <h2>${escapeHTML(module.title)}</h2>
            <div class="drawer-meter" style="--value:${percent * 3.6}deg"><strong>${percent}%</strong></div>
            <p>${completedLessonCount(module)} of ${module.lessons.length} lessons complete.</p>
          </section>
          <section class="drawer-section">
            <h3>Practice status</h3>
            <p>${state.completedLabs.includes(module.id) ? "Workbench complete." : "Workbench not complete."}</p>
            <p>${Object.hasOwn(state.quizScores, module.id) ? `Best check score: ${state.quizScores[module.id]}%.` : "Retrieval check not attempted."}</p>
          </section>
        </div>
      `;
      return;
    }

    drawer.innerHTML = `
      <div class="drawer-inner drawer-home">
        <section class="drawer-section">
          <span class="eyebrow">Saved locally</span>
          <h2>Your systems model</h2>
          <div class="drawer-meter" style="--value:${stats.percent * 3.6}deg"><strong>${stats.percent}%</strong></div>
          <p>${stats.complete} of ${stats.total} checkpoints complete on this device.</p>
        </section>
        <section class="drawer-section">
          <h3>Depth control</h3>
          <p>Core model keeps the reading path short. Kernel view adds implementation details. Code view adds repository anchors.</p>
        </section>
      </div>
    `;
  }

  function renderRoute() {
    let route = parseRoute();
    const valid =
      route.type === "home" ||
      route.type === "capstone" ||
      (["module", "quiz", "lab"].includes(route.type) && moduleById.has(route.id)) ||
      (route.type === "lesson" && lessonById.has(route.id));
    if (!valid) route = { type: "home", id: undefined };
    state.lastRoute = route.id ? routeFor(route.type, route.id) : route.type;
    saveState();

    let activeModuleId = null;
    if (route.type === "module" && moduleById.has(route.id)) {
      activeModuleId = route.id;
      renderModule(moduleById.get(route.id));
    } else if (route.type === "lesson" && lessonById.has(route.id)) {
      const entry = lessonById.get(route.id);
      activeModuleId = entry.module.id;
      renderLesson(entry.lesson, entry.module);
    } else if (route.type === "quiz" && moduleById.has(route.id)) {
      activeModuleId = route.id;
      renderQuiz(moduleById.get(route.id));
    } else if (route.type === "lab" && moduleById.has(route.id)) {
      activeModuleId = route.id;
      renderLab(moduleById.get(route.id));
    } else if (route.type === "capstone") {
      renderCapstone();
    } else {
      renderHome();
    }

    renderNav(activeModuleId);
    renderDrawer(route);
    updateProgress();
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function questionsFor(module) {
    return [
      ...module.lessons.map((lesson) => ({ ...lesson.check, lessonTitle: lesson.title })),
      ...(module.quizExtra || []).map((question) => ({ ...question, lessonTitle: "Module synthesis" }))
    ];
  }

  function newQuiz(module) {
    return {
      moduleId: module.id,
      questions: questionsFor(module),
      index: 0,
      selected: null,
      answers: [],
      revealed: false,
      finished: false
    };
  }

  function renderQuiz(module) {
    if (!activeQuiz || activeQuiz.moduleId !== module.id) activeQuiz = newQuiz(module);

    renderBreadcrumbs([
      { label: "Course home", route: "home" },
      { label: `Module ${module.number}`, route: routeFor("module", module.id) },
      { label: "Retrieval check" }
    ]);

    if (activeQuiz.finished) {
      const correct = activeQuiz.answers.filter((answer) => answer.correct).length;
      const score = Math.round((correct / activeQuiz.questions.length) * 100);
      view.innerHTML = `
        <div class="quiz-view" style="${moduleStyle(module)}">
          <header class="quiz-header">
            <span class="eyebrow">Module ${module.number} · retrieval check</span>
            <h1>Model checked.</h1>
            <p>The score is saved on this device. Retry now or return after another pass through the module.</p>
          </header>
          <section class="quiz-result" aria-labelledby="quiz-result-title">
            <strong>${score}%</strong>
            <h2 id="quiz-result-title">${correct} of ${activeQuiz.questions.length} mechanisms identified</h2>
            <p>${score >= 80 ? "You can now explain the main boundaries without the diagrams." : "Review the missed boundaries, then retrieve the model again."}</p>
            <div class="quiz-actions">
              <button class="secondary-button" type="button" data-route="${routeFor("module", module.id)}">Review module</button>
              <button class="primary-button" type="button" data-quiz-retry>Retry check</button>
            </div>
          </section>
        </div>
      `;
      return;
    }

    const question = activeQuiz.questions[activeQuiz.index];
    view.innerHTML = `
      <div class="quiz-view" style="${moduleStyle(module)}">
        <header class="quiz-header">
          <span class="eyebrow">Module ${module.number} · retrieval check</span>
          <h1>Explain it without the diagram.</h1>
          <p>Choose once, inspect the mechanism, then move forward. A score records the attempt, not mastery.</p>
        </header>
        <div class="quiz-shell">
          <section class="quiz-question-card" aria-labelledby="quiz-question">
            <span class="quiz-counter">Question ${activeQuiz.index + 1} of ${activeQuiz.questions.length} · ${escapeHTML(question.lessonTitle)}</span>
            <fieldset>
              <legend id="quiz-question">${escapeHTML(question.question)}</legend>
              <div class="quiz-options">
                ${question.choices
                  .map((choice, index) => {
                    const selected = activeQuiz.selected === index;
                    const correct = activeQuiz.revealed && index === question.answer;
                    const incorrect = activeQuiz.revealed && selected && index !== question.answer;
                    return `
                      <label class="quiz-option ${selected ? "selected" : ""} ${correct ? "correct" : ""} ${incorrect ? "incorrect" : ""}">
                        <input
                          type="radio"
                          name="quiz-answer"
                          value="${index}"
                          data-quiz-answer="${index}"
                          ${selected ? "checked" : ""}
                          ${activeQuiz.revealed ? "disabled" : ""}
                        >
                        <span class="option-key">${String.fromCharCode(65 + index)}</span>
                        <span>${escapeHTML(choice)}</span>
                      </label>
                    `;
                  })
                  .join("")}
              </div>
            </fieldset>
            ${
              activeQuiz.revealed
                ? `<p class="quiz-feedback ${activeQuiz.selected === question.answer ? "correct" : "incorrect"}">${escapeHTML(question.explanation)}</p>`
                : '<p class="quiz-feedback">Commit to an answer before revealing the explanation.</p>'
            }
            <div class="quiz-actions">
              ${
                activeQuiz.revealed
                  ? `<button class="primary-button" type="button" data-quiz-next>${activeQuiz.index === activeQuiz.questions.length - 1 ? "Finish check" : "Next question"}</button>`
                  : '<button class="primary-button" type="button" data-quiz-check>Check answer</button>'
              }
            </div>
          </section>
          <aside class="quiz-map" aria-label="Question progress">
            ${activeQuiz.questions
              .map((_, index) => {
                const answer = activeQuiz.answers[index];
                return `<span class="quiz-dot ${index === activeQuiz.index ? "active" : ""} ${answer ? (answer.correct ? "correct" : "incorrect") : ""}">${index + 1}</span>`;
              })
              .join("")}
          </aside>
        </div>
      </div>
    `;
  }

  function initialLabState(kind) {
    const states = {
      "event-stepper": { event: "syscall", step: 0 },
      "container-builder": { namespaces: false, cgroups: false, capabilities: false, seccomp: false, rootfs: false },
      scheduler: { weight: 100, quota: 100, affinity: true, workingSet: 4, tick: 0 },
      memory: { pageSize: 4, resolver: "kernel", resident: 0, fault: -1 },
      storage: { path: "nbd", step: 0 },
      virtio: { step: 0, nested: false },
      "vmm-selector": { broadDevices: false, hotplug: false, fastStart: true, vmBoundary: true },
      network: { scenario: "clusterip", step: 0 },
      ebpf: { program: "map", step: 0 },
      binpack: { strategy: "best", placed: 0, reveal: false }
    };
    return structuredClone(states[kind] || {});
  }

  function ensureLab(module) {
    if (!activeLab || activeLab.moduleId !== module.id) {
      activeLab = { moduleId: module.id, kind: module.lab.kind, state: initialLabState(module.lab.kind) };
    }
    return activeLab.state;
  }

  function renderLab(module) {
    ensureLab(module);
    const complete = state.completedLabs.includes(module.id);
    renderBreadcrumbs([
      { label: "Course home", route: "home" },
      { label: `Module ${module.number}`, route: routeFor("module", module.id) },
      { label: "Workbench" }
    ]);

    view.innerHTML = `
      <div class="lab-view" style="${moduleStyle(module)}">
        <header class="lab-header">
          <span class="eyebrow">Module ${module.number} · workbench</span>
          <h1>${escapeHTML(module.lab.title)}</h1>
          <p>${escapeHTML(module.lab.intro)}</p>
          <div class="lab-badges">
            <span class="lab-badge">${escapeHTML(module.lab.badge)}</span>
            <span class="lab-badge">State stays in this tab</span>
          </div>
        </header>

        <div id="lab-interactive"></div>

        <section class="lab-notebook" aria-labelledby="notebook-title">
          <div class="notebook-head">
            <h2 id="notebook-title">Run it on a real system</h2>
            <span class="lab-badge">Commands do not run in the browser</span>
          </div>
          <div class="notebook-body">
            ${module.lab.notebook
              .map(
                (step, index) => `
                  <article class="lab-step">
                    <span class="lab-step-index">${String(index + 1).padStart(2, "0")}</span>
                    <div>
                      <h3>${escapeHTML(step.title)}</h3>
                      <p>${escapeHTML(step.text)}</p>
                      <pre class="command-block"><code>${escapeHTML(step.command)}</code><button class="copy-command" type="button" data-copy-command="${index}">Copy</button></pre>
                    </div>
                  </article>
                `
              )
              .join("")}
          </div>
        </section>

        ${module.lab.codeChallenge ? renderCodeChallenge(module.lab.codeChallenge) : ""}

        <nav class="lesson-footer-nav" aria-label="Workbench navigation">
          <button class="secondary-button" type="button" data-route="${routeFor("module", module.id)}">← Module overview</button>
          <button class="primary-button ${complete ? "complete" : ""}" type="button" data-complete-lab="${module.id}">
            ${complete ? "✓ Workbench complete" : "Mark workbench complete"}
          </button>
        </nav>
      </div>
    `;

    renderLabWorkbench(module);
  }

  function workbenchShell(controls, stage) {
    return `
      <section class="workbench" aria-label="Interactive browser model">
        <div class="workbench-controls">${controls}</div>
        <div class="workbench-stage"><div class="stage-content" aria-live="polite">${stage}</div></div>
      </section>
    `;
  }

  function renderLabWorkbench(module) {
    const root = document.querySelector("#lab-interactive");
    if (!root) return;
    const labState = ensureLab(module);
    const renderers = {
      "event-stepper": renderEventStepper,
      "container-builder": renderContainerBuilder,
      scheduler: renderSchedulerWorkbench,
      memory: renderMemoryWorkbench,
      storage: renderStorageWorkbench,
      virtio: renderVirtioWorkbench,
      "vmm-selector": renderVMMSelector,
      network: renderNetworkWorkbench,
      ebpf: renderEBPFWorkbench,
      binpack: renderBinpackWorkbench
    };
    const renderer = renderers[module.lab.kind];
    root.innerHTML = renderer ? renderer(labState) : '<p class="empty-state">This model is unavailable.</p>';
  }

  function renderEventStepper(labState) {
    const events = {
      syscall: [
        ["Process", "executes a library wrapper"],
        ["CPU gate", "changes privilege level"],
        ["Kernel", "validates the request"],
        ["VFS", "dispatches to the file path"],
        ["Process", "resumes with a result"]
      ],
      fault: [
        ["Load", "references a virtual address"],
        ["MMU", "finds no usable translation"],
        ["Exception", "enters the fault handler"],
        ["Kernel", "maps or rejects the page"],
        ["Load", "restarts after resolution"]
      ],
      interrupt: [
        ["Device", "finishes asynchronous work"],
        ["Interrupt", "notifies a CPU"],
        ["Driver", "acknowledges completion"],
        ["Kernel", "wakes a blocked task"],
        ["Process", "becomes runnable"]
      ]
    };
    const steps = events[labState.event];
    const step = Math.min(labState.step, steps.length - 1);
    return workbenchShell(
      `
        <h2>Choose an entry path</h2>
        <p>A syscall and a fault are synchronous. A device interrupt arrives independently of the current instruction.</p>
        <div class="control-group">
          <label><span>Event</span>
            <select data-lab-field="event">
              <option value="syscall" ${labState.event === "syscall" ? "selected" : ""}>System call</option>
              <option value="fault" ${labState.event === "fault" ? "selected" : ""}>Page fault</option>
              <option value="interrupt" ${labState.event === "interrupt" ? "selected" : ""}>Device interrupt</option>
            </select>
          </label>
        </div>
        <div class="simulation-actions">
          <button type="button" data-lab-action="next">Advance</button>
          <button type="button" data-lab-action="reset">Reset</button>
        </div>
      `,
      `
        <div class="packet-path">
          ${steps
            .map(
              ([name, detail], index) => `
                <div class="packet-node ${index === step ? "active" : ""}">
                  <strong>${escapeHTML(name)}</strong><small>${escapeHTML(detail)}</small>
                </div>
              `
            )
            .join("")}
        </div>
        <div class="stage-readout"><strong>Active owner:</strong> ${escapeHTML(steps[step][0])}. ${escapeHTML(steps[step][1])}.</div>
      `
    );
  }

  function renderContainerBuilder(labState) {
    const primitives = [
      ["namespaces", "Namespaces", "Limit which resources the process can name."],
      ["cgroups", "cgroup v2", "Account and control CPU, memory, and I/O."],
      ["capabilities", "Capabilities", "Remove portions of root authority."],
      ["seccomp", "seccomp", "Filter allowed syscall numbers and arguments."],
      ["rootfs", "Root filesystem", "Provide the process filesystem view."]
    ];
    const enabled = primitives.filter(([key]) => labState[key]).length;
    const missing = primitives.filter(([key]) => !labState[key]).map(([, name]) => name);
    return workbenchShell(
      `
        <h2>Assemble a container</h2>
        <p>No single switch creates a container. A runtime composes kernel controls around ordinary processes.</p>
        <div class="toggle-list">
          ${primitives
            .map(
              ([key, name]) => `
                <label class="toggle-control"><span>${escapeHTML(name)}</span><input type="checkbox" data-lab-toggle="${key}" ${labState[key] ? "checked" : ""}></label>
              `
            )
            .join("")}
        </div>
        <div class="simulation-actions"><button type="button" data-lab-action="reset">Clear controls</button></div>
      `,
      `
        <div class="primitive-rack">
          ${primitives
            .map(
              ([key, name, detail]) => `
                <div class="primitive-card ${labState[key] ? "active" : ""}">
                  <strong>${escapeHTML(name)}</strong><small>${escapeHTML(detail)}</small>
                </div>
              `
            )
            .join("")}
        </div>
        <div class="sandbox-score"><strong>${enabled}/5 controls</strong><span class="score-track"><span style="width:${enabled * 20}%"></span></span></div>
        <div class="stage-readout"><strong>Model:</strong> ${missing.length ? `The process still lacks ${escapeHTML(missing.join(", "))}.` : "The controls are assembled. Their exact configuration still determines isolation."}</div>
      `
    );
  }

  function renderSchedulerWorkbench(labState) {
    const weightShare = labState.weight / (labState.weight + 100);
    const quotaShare = Math.min(1, labState.quota / 100);
    const runtimeShare = Math.min(weightShare, quotaShare);
    const busy = Math.max(1, Math.round(runtimeShare * 12));
    const warmth = Math.max(5, Math.min(100, (labState.affinity ? 105 : 72) - labState.workingSet * 8));
    const throttled = quotaShare < weightShare;
    return workbenchShell(
      `
        <h2>Tune one runnable task</h2>
        <p>Weight decides proportional service under contention. Quota is a hard ceiling. Affinity can preserve cache state.</p>
        <div class="control-group">
          <label><span>CPU weight · ${labState.weight}</span><input type="range" min="10" max="300" step="10" value="${labState.weight}" data-lab-field="weight"></label>
          <label><span>Quota · ${labState.quota}% of one CPU</span><input type="range" min="25" max="200" step="25" value="${labState.quota}" data-lab-field="quota"></label>
          <label><span>Working set · ${labState.workingSet} MiB</span><input type="range" min="1" max="12" value="${labState.workingSet}" data-lab-field="workingSet"></label>
          <label class="toggle-control"><span>Keep CPU affinity</span><input type="checkbox" data-lab-toggle="affinity" ${labState.affinity ? "checked" : ""}></label>
        </div>
        <div class="simulation-actions"><button type="button" data-lab-action="run">Run another period</button><button type="button" data-lab-action="reset">Reset</button></div>
      `,
      `
        <div class="task-pool">
          <div class="task-chip running">workload</div>
          <div class="task-chip waiting">competitor</div>
          <div class="task-chip">period ${labState.tick}</div>
        </div>
        <div class="timeline-track">
          ${Array.from({ length: 12 }, (_, index) => `<span class="timeline-slot ${index < busy ? "busy" : ""}">${index < busy ? "run" : "wait"}</span>`).join("")}
        </div>
        <div class="sandbox-score"><strong>cache warmth ${warmth}%</strong><span class="score-track"><span style="width:${warmth}%"></span></span></div>
        <div class="stage-readout"><strong>Result:</strong> about ${Math.round(runtimeShare * 100)}% of one contended CPU in this simplified period. ${throttled ? "The quota becomes the limiting control." : "Competition and weight set the smaller share."}</div>
      `
    );
  }

  function renderMemoryWorkbench(labState) {
    const totalPages = 16;
    const pageSizeBytes = labState.pageSize * 1024;
    const tlbCoverageMiB = (64 * pageSizeBytes) / (1024 * 1024);
    return workbenchShell(
      `
        <h2>Resolve demand faults</h2>
        <p>Virtual mappings reserve address ranges. Physical residency appears as pages are touched and resolved.</p>
        <div class="control-group">
          <label><span>Page size</span>
            <select data-lab-field="pageSize">
              <option value="4" ${labState.pageSize === 4 ? "selected" : ""}>4 KiB</option>
              <option value="2048" ${labState.pageSize === 2048 ? "selected" : ""}>2 MiB huge page</option>
            </select>
          </label>
          <label><span>Resolver</span>
            <select data-lab-field="resolver">
              <option value="kernel" ${labState.resolver === "kernel" ? "selected" : ""}>Kernel fault path</option>
              <option value="uffd" ${labState.resolver === "uffd" ? "selected" : ""}>Userspace UFFD handler</option>
            </select>
          </label>
        </div>
        <div class="simulation-actions"><button type="button" data-lab-action="touch">Touch next page</button><button type="button" data-lab-action="reset">Drop model state</button></div>
      `,
      `
        <div class="page-grid">
          ${Array.from({ length: totalPages }, (_, index) => `<span class="page-cell ${index < labState.resident ? "resident" : ""} ${index === labState.fault ? "faulting" : ""}">${index}</span>`).join("")}
        </div>
        <div class="sandbox-score"><strong>${labState.resident}/${totalPages} resident</strong><span class="score-track"><span style="width:${(labState.resident / totalPages) * 100}%"></span></span></div>
        <div class="stage-readout"><strong>Translation model:</strong> 64 TLB entries cover about ${tlbCoverageMiB < 1 ? `${Math.round(tlbCoverageMiB * 1024)} KiB` : `${tlbCoverageMiB.toFixed(0)} MiB`} at this page size. ${labState.resolver === "uffd" ? "UFFD moves selected fault resolution to a registered userspace handler." : "The kernel resolves the fault from zero-fill, a file, swap, or an error path."}</div>
      `
    );
  }

  function renderStorageWorkbench(labState) {
    const paths = {
      buffered: [["read()", "userspace call"], ["VFS", "file lookup"], ["Page cache", "cached file pages"], ["Block layer", "bio and request"], ["Device", "storage completion"]],
      mmap: [["Load", "memory instruction"], ["Page fault", "missing file page"], ["Page cache", "file-backed page"], ["Block layer", "fill on miss"], ["Resume", "restart the load"]],
      nbd: [["ext4", "filesystem read"], ["/dev/nbd", "kernel client"], ["Socket", "NBD request"], ["Go handler", "userspace server"], ["mmap / S3", "cache or range fetch"]],
      io_uring: [["Submit", "write SQ entries"], ["SQ", "shared ring"], ["Kernel I/O", "operation runs"], ["CQ", "completion entry"], ["Resume", "consume result"]]
    };
    const nodes = paths[labState.path];
    const step = Math.min(labState.step, nodes.length - 1);
    return workbenchShell(
      `
        <h2>Choose an I/O path</h2>
        <p>Page cache, a block cache, and a device queue are different state. Follow one request before comparing latency.</p>
        <div class="control-group">
          <label><span>Read path</span>
            <select data-lab-field="path">
              <option value="buffered" ${labState.path === "buffered" ? "selected" : ""}>Buffered file read</option>
              <option value="mmap" ${labState.path === "mmap" ? "selected" : ""}>mmap load</option>
              <option value="nbd" ${labState.path === "nbd" ? "selected" : ""}>sandbox-blockstore NBD</option>
              <option value="io_uring" ${labState.path === "io_uring" ? "selected" : ""}>io_uring submission</option>
            </select>
          </label>
        </div>
        <div class="simulation-actions"><button type="button" data-lab-action="next">Advance request</button><button type="button" data-lab-action="reset">Reset</button></div>
      `,
      `
        <div class="packet-path">
          ${nodes.map(([name, detail], index) => `<div class="packet-node ${index === step ? "active" : ""}"><strong>${escapeHTML(name)}</strong><small>${escapeHTML(detail)}</small></div>`).join("")}
        </div>
        <div class="stage-readout"><strong>Boundary ${step + 1}:</strong> ${escapeHTML(nodes[step][0])}. ${escapeHTML(nodes[step][1])}. io_uring changes submission and completion mechanics; it does not remove storage latency.</div>
      `
    );
  }

  function renderVirtioWorkbench(labState) {
    const steps = [
      ["Guest driver", "writes descriptor addresses and lengths"],
      ["Available ring", "publishes a descriptor-chain head"],
      ["Notification", "a kick, poll, or event tells the backend"],
      ["Backend", "performs host I/O through the VMM or another process"],
      ["Used ring", "returns completion to the guest driver"]
    ];
    const step = Math.min(labState.step, steps.length - 1);
    return workbenchShell(
      `
        <h2>Move one virtqueue request</h2>
        <p>Shared guest memory carries descriptors. Notifications coordinate ownership; the device model still performs the host-side work.</p>
        <div class="control-group">
          <label class="toggle-control"><span>Add an L1 hypervisor</span><input type="checkbox" data-lab-toggle="nested" ${labState.nested ? "checked" : ""}></label>
        </div>
        <div class="simulation-actions"><button type="button" data-lab-action="next">Advance queue</button><button type="button" data-lab-action="reset">Reset</button></div>
      `,
      `
        <div class="queue-rings">
          <div class="queue-ring"><h3>available ring</h3>${Array.from({ length: 4 }, (_, index) => `<span class="ring-slot ${step >= 1 && index === 0 ? "filled" : ""}">${index}</span>`).join("")}</div>
          <div class="queue-ring"><h3>used ring</h3>${Array.from({ length: 4 }, (_, index) => `<span class="ring-slot ${step >= 4 && index === 0 ? "complete" : ""}">${index}</span>`).join("")}</div>
        </div>
        <div class="thread-grid">
          <div class="thread-lane">${steps.slice(0, 3).map(([name], index) => `<span class="thread-step ${index === step ? "active" : ""}">${escapeHTML(name)}</span>`).join("")}</div>
          <div class="memory-cell">${step + 1}/5</div>
          <div class="thread-lane">${steps.slice(3).map(([name], index) => `<span class="thread-step ${index + 3 === step ? "active" : ""}">${escapeHTML(name)}</span>`).join("")}</div>
        </div>
        <div class="stage-readout"><strong>${escapeHTML(steps[step][0])}:</strong> ${escapeHTML(steps[step][1])}. ${labState.nested ? "With nesting, selected privileged operations may pass through L1 and L0, so exit cost depends on the operation and hardware support." : "A hypercall is an intentional guest request. A VM exit is the broader transfer caused by configured events or privileged operations."}</div>
      `
    );
  }

  function renderVMMSelector(labState) {
    const requirements = [
      ["broadDevices", "Broad legacy device model"],
      ["hotplug", "Runtime device hotplug"],
      ["fastStart", "Small startup path"],
      ["vmBoundary", "Hardware VM boundary"]
    ];
    const candidates = [
      { name: "QEMU + KVM", detail: "Broad machine and device coverage", traits: { broadDevices: 2, hotplug: 2, fastStart: 0, vmBoundary: 1 } },
      { name: "Firecracker", detail: "Purpose-built microVM device surface", traits: { broadDevices: 0, hotplug: 0, fastStart: 2, vmBoundary: 1 } },
      { name: "Cloud Hypervisor", detail: "Cloud-focused VMM with virtio devices", traits: { broadDevices: 1, hotplug: 1, fastStart: 1, vmBoundary: 1 } },
      { name: "Kata + selected VMM", detail: "Container delivery with a guest kernel", traits: { broadDevices: 1, hotplug: 1, fastStart: 0, vmBoundary: 1 } },
      { name: "runc", detail: "Host-kernel container boundary", traits: { broadDevices: 1, hotplug: 1, fastStart: 2, vmBoundary: 0 } }
    ];
    const scored = candidates
      .map((candidate) => ({
        ...candidate,
        score: requirements.reduce((score, [key]) => score + (labState[key] ? candidate.traits[key] : 0), 0)
      }))
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const best = scored[0];
    return workbenchShell(
      `
        <h2>State the requirements</h2>
        <p>This is a fit model, not a universal ranking. Security depends on configuration, host hardening, and the complete runtime path.</p>
        <div class="toggle-list">
          ${requirements.map(([key, label]) => `<label class="toggle-control"><span>${escapeHTML(label)}</span><input type="checkbox" data-lab-toggle="${key}" ${labState[key] ? "checked" : ""}></label>`).join("")}
        </div>
        <div class="simulation-actions"><button type="button" data-lab-action="reset">Reset requirements</button></div>
      `,
      `
        <div class="primitive-rack">
          ${scored.map((candidate, index) => `<div class="primitive-card ${index === 0 ? "active" : ""}"><strong>${escapeHTML(candidate.name)} · ${candidate.score}</strong><small>${escapeHTML(candidate.detail)}</small></div>`).join("")}
        </div>
        <div class="stage-readout"><strong>Closest fit:</strong> ${escapeHTML(best.name)} for the selected properties. Kata is a container runtime architecture that delegates VM work to a VMM; it is not itself another VMM.</div>
      `
    );
  }

  function renderNetworkWorkbench(labState) {
    const scenarios = {
      pod: [["Source Pod", "process in a netns"], ["veth / CNI", "namespace boundary"], ["Node path", "route or data plane"], ["veth / CNI", "destination boundary"], ["Target Pod", "socket receives bytes"]],
      clusterip: [["Pod socket", "destination is a Service IP"], ["Pod netns", "route leaves namespace"], ["Service data plane", "selects an endpoint"], ["Node network", "forwards rewritten traffic"], ["Endpoint Pod", "reply follows connection state"]],
      outbound: [["Pod", "private source address"], ["Pod netns", "default route"], ["Node", "forwarding path"], ["SNAT", "source may be rewritten"], ["Remote", "sees translated source"]],
      l4: [["Client", "opens a transport flow"], ["L4 balancer", "uses IP, port, and protocol"], ["Backend flow", "connection is forwarded"], ["Service", "handles bytes"], ["Reply", "flow state returns traffic"]],
      l7: [["Client", "sends an application request"], ["Proxy", "terminates transport"], ["L7 policy", "reads host, path, or method"], ["Backend request", "new or pooled connection"], ["Response", "proxy returns application data"]]
    };
    const nodes = scenarios[labState.scenario];
    const step = Math.min(labState.step, nodes.length - 1);
    return workbenchShell(
      `
        <h2>Select a packet story</h2>
        <p>A namespace changes the network view. Routing, filtering, NAT, and proxying are separate decisions.</p>
        <div class="control-group">
          <label><span>Scenario</span>
            <select data-lab-field="scenario">
              <option value="pod" ${labState.scenario === "pod" ? "selected" : ""}>Pod to Pod</option>
              <option value="clusterip" ${labState.scenario === "clusterip" ? "selected" : ""}>ClusterIP Service</option>
              <option value="outbound" ${labState.scenario === "outbound" ? "selected" : ""}>Outbound NAT</option>
              <option value="l4" ${labState.scenario === "l4" ? "selected" : ""}>L4 balancing</option>
              <option value="l7" ${labState.scenario === "l7" ? "selected" : ""}>L7 proxying</option>
            </select>
          </label>
        </div>
        <div class="simulation-actions"><button type="button" data-lab-action="next">Advance packet</button><button type="button" data-lab-action="reset">Reset</button></div>
      `,
      `
        <div class="packet-path">${nodes.map(([name, detail], index) => `<div class="packet-node ${index === step ? "active" : ""}"><strong>${escapeHTML(name)}</strong><small>${escapeHTML(detail)}</small></div>`).join("")}</div>
        <div class="stage-readout"><strong>${escapeHTML(nodes[step][0])}:</strong> ${escapeHTML(nodes[step][1])}. The exact Kubernetes data plane may use nftables, iptables compatibility, IPVS, eBPF, or a cloud implementation.</div>
      `
    );
  }

  function renderEBPFWorkbench(labState) {
    const programs = {
      map: [
        ["R1 = ctx", "R1 has a context-pointer type"],
        ["map lookup", "helper may return a map-value pointer or null"],
        ["null check", "the branch refines the pointer type"],
        ["value load", "bounded access can be accepted"]
      ],
      packet: [
        ["load bounds", "read data and data_end pointers"],
        ["add header", "compute a candidate packet pointer"],
        ["bounds check", "prove the header ends before data_end"],
        ["packet load", "verified bytes can be read"]
      ]
    };
    const steps = programs[labState.program];
    const step = Math.min(labState.step, steps.length - 1);
    return workbenchShell(
      `
        <h2>Carry verifier facts</h2>
        <p>The verifier explores paths and tracks types, ranges, initialization, and lifetime. Acceptance does not predict runtime cost.</p>
        <div class="control-group">
          <label><span>Program shape</span>
            <select data-lab-field="program">
              <option value="map" ${labState.program === "map" ? "selected" : ""}>Nullable map lookup</option>
              <option value="packet" ${labState.program === "packet" ? "selected" : ""}>Packet bounds check</option>
            </select>
          </label>
        </div>
        <div class="simulation-actions"><button type="button" data-lab-action="next">Advance verifier</button><button type="button" data-lab-action="reset">Reset</button></div>
      `,
      `
        <div class="thread-lane">${steps.map(([name, detail], index) => `<div class="thread-step ${index === step ? "active" : ""}"><strong>${escapeHTML(name)}</strong><br>${escapeHTML(detail)}</div>`).join("")}</div>
        <div class="stage-readout"><strong>Verifier state ${step + 1}/${steps.length}:</strong> ${escapeHTML(steps[step][1])}. Unsafe paths must be rejected or made unreachable by a proof the verifier understands.</div>
      `
    );
  }

  function placePods(strategy, count) {
    const nodes = [
      { id: "node-a", cpu: 8, memory: 32, gpu: 1, huge: 2, usedCPU: 0, usedMemory: 0, usedGPU: 0, usedHuge: 0, actualCPU: 0 },
      { id: "node-b", cpu: 8, memory: 32, gpu: 0, huge: 4, usedCPU: 0, usedMemory: 0, usedGPU: 0, usedHuge: 0, actualCPU: 0 },
      { id: "node-c", cpu: 12, memory: 48, gpu: 2, huge: 0, usedCPU: 0, usedMemory: 0, usedGPU: 0, usedHuge: 0, actualCPU: 0 }
    ];
    const pods = [
      { id: "api", cpu: 2, memory: 4, gpu: 0, huge: 0, actualCPU: 5 },
      { id: "model", cpu: 4, memory: 8, gpu: 1, huge: 0, actualCPU: 7 },
      { id: "database", cpu: 3, memory: 12, gpu: 0, huge: 2, actualCPU: 4 },
      { id: "batch", cpu: 6, memory: 8, gpu: 0, huge: 0, actualCPU: 9 }
    ];
    const placements = [];

    for (const pod of pods.slice(0, count)) {
      const feasible = nodes.filter(
        (node) =>
          node.cpu - node.usedCPU >= pod.cpu &&
          node.memory - node.usedMemory >= pod.memory &&
          node.gpu - node.usedGPU >= pod.gpu &&
          node.huge - node.usedHuge >= pod.huge
      );
      feasible.sort((left, right) => {
        const leftFree = left.cpu - left.usedCPU - pod.cpu;
        const rightFree = right.cpu - right.usedCPU - pod.cpu;
        return (strategy === "best" ? leftFree - rightFree : rightFree - leftFree) || left.id.localeCompare(right.id);
      });
      const node = feasible[0];
      if (!node) {
        placements.push({ pod: pod.id, node: null });
        continue;
      }
      node.usedCPU += pod.cpu;
      node.usedMemory += pod.memory;
      node.usedGPU += pod.gpu;
      node.usedHuge += pod.huge;
      node.actualCPU += pod.actualCPU;
      placements.push({ pod: pod.id, node: node.id });
    }
    return { nodes, pods, placements };
  }

  function renderBinpackWorkbench(labState) {
    const model = placePods(labState.strategy, labState.placed);
    const nextPod = model.pods[labState.placed];
    return workbenchShell(
      `
        <h2>Place requested resources</h2>
        <p>Filter first, then score. Runtime use is hidden until placement is complete so requests and observed demand stay separate.</p>
        <div class="control-group">
          <label><span>CPU scoring model</span>
            <select data-lab-field="strategy">
              <option value="best" ${labState.strategy === "best" ? "selected" : ""}>Tightest feasible CPU fit</option>
              <option value="spread" ${labState.strategy === "spread" ? "selected" : ""}>Most CPU headroom</option>
            </select>
          </label>
        </div>
        <div class="simulation-actions"><button type="button" data-lab-action="place" ${nextPod ? "" : "disabled"}>${nextPod ? `Place ${escapeHTML(nextPod.id)}` : "All Pods placed"}</button><button type="button" data-lab-action="reveal">${labState.reveal ? "Hide runtime use" : "Reveal runtime use"}</button><button type="button" data-lab-action="reset">Reset</button></div>
        <div class="stage-readout"><strong>Placement log:</strong> ${model.placements.length ? model.placements.map((item) => `${escapeHTML(item.pod)} → ${escapeHTML(item.node || "pending")}`).join(" · ") : "No Pods placed."}</div>
      `,
      `
        <div class="node-rack">
          ${model.nodes
            .map((node) => {
              const shownCPU = labState.reveal ? node.actualCPU : node.usedCPU;
              const hot = shownCPU > node.cpu;
              return `
                <article class="node-card ${hot ? "selected" : ""}">
                  <h3>${escapeHTML(node.id)}</h3>
                  <div class="capacity-row"><span>${labState.reveal ? "actual" : "CPU req"}</span><span class="capacity-track"><span class="${hot ? "hot" : ""}" style="width:${Math.min(100, (shownCPU / node.cpu) * 100)}%"></span></span><strong>${shownCPU}/${node.cpu}</strong></div>
                  <div class="capacity-row"><span>memory</span><span class="capacity-track"><span style="width:${(node.usedMemory / node.memory) * 100}%"></span></span><strong>${node.usedMemory}/${node.memory}</strong></div>
                  <div class="stage-readout">GPU ${node.usedGPU}/${node.gpu} · huge pages ${node.usedHuge}/${node.huge}</div>
                </article>
              `;
            })
            .join("")}
        </div>
        <div class="stage-readout"><strong>${labState.reveal ? "Runtime view" : "Scheduler view"}:</strong> ${labState.reveal ? "Actual CPU can exceed requests and create contention after a valid placement." : "The scheduler sees declared requests, hard resource availability, constraints, and scores. It does not place from live CPU use."}</div>
      `
    );
  }

  function renderCodeChallenge(challenge) {
    return `
      <section class="code-lab" aria-labelledby="code-title-${escapeAttr(challenge.id)}">
        <div class="code-lab-head">
          <div>
            <span class="eyebrow">Browser code lab</span>
            <h2 id="code-title-${escapeAttr(challenge.id)}">${escapeHTML(challenge.title)}</h2>
          </div>
          <div class="simulation-actions">
            <button class="small-button" type="button" data-code-reset="${escapeAttr(challenge.id)}">Reset</button>
            <button class="primary-button" type="button" data-code-run="${escapeAttr(challenge.id)}">Run tests</button>
          </div>
        </div>
        <div class="notebook-body">
          <p>${escapeHTML(challenge.prompt)}</p>
          <p class="micro-feedback">Runs in a browser worker with a short timeout. Do not paste secrets.</p>
        </div>
        <div class="code-lab-grid">
          <div class="code-editor-wrap">
            <textarea class="code-editor" id="code-editor-${escapeAttr(challenge.id)}" spellcheck="false" aria-label="JavaScript solution">${escapeHTML(challenge.starter)}</textarea>
          </div>
          <aside class="test-panel">
            <h3>Tests</h3>
            <ul class="test-list" id="test-list-${escapeAttr(challenge.id)}">
              ${challenge.tests.map((test) => `<li class="test-item"><span>○</span><span>${escapeHTML(test.label)}</span></li>`).join("")}
            </ul>
            <div class="test-output" id="test-output-${escapeAttr(challenge.id)}">Edit the function, then run the tests.</div>
          </aside>
        </div>
      </section>
    `;
  }

  function currentChallenge(challengeId) {
    const route = parseRoute();
    const module = route.type === "lab" ? moduleById.get(route.id) : null;
    const challenge = module?.lab.codeChallenge;
    return challenge?.id === challengeId ? challenge : null;
  }

  function updateCodeResults(challenge, results, message) {
    const list = document.querySelector(`#test-list-${challenge.id}`);
    const output = document.querySelector(`#test-output-${challenge.id}`);
    if (!list || !output) return;
    list.innerHTML = challenge.tests
      .map((test, index) => {
        const result = results?.[index];
        const status = result ? (result.pass ? "pass" : "fail") : "";
        const mark = result ? (result.pass ? "✓" : "×") : "○";
        const detail = result && !result.pass ? `<br>received ${escapeHTML(result.actual || result.error || "error")}` : "";
        return `<li class="test-item ${status}"><span>${mark}</span><span>${escapeHTML(test.label)}${detail}</span></li>`;
      })
      .join("");
    output.textContent = message;
  }

  function runCodeChallenge(challengeId) {
    const challenge = currentChallenge(challengeId);
    const editor = document.querySelector(`#code-editor-${challengeId}`);
    const button = document.querySelector(`[data-code-run="${challengeId}"]`);
    if (!challenge || !editor || !button) return;
    if (!/^[A-Za-z_$][\w$]*$/.test(challenge.functionName)) return;

    button.disabled = true;
    updateCodeResults(challenge, null, "Running in an isolated worker...");

    const source = `
      "use strict";
      self.fetch = undefined;
      self.WebSocket = undefined;
      self.XMLHttpRequest = undefined;
      self.importScripts = undefined;

      function sameValue(actual, expected) {
        if (expected === "Infinity") return actual === Infinity;
        if (Object.is(actual, expected)) return true;
        try { return JSON.stringify(actual) === JSON.stringify(expected); }
        catch { return false; }
      }

      function show(value) {
        if (value === Infinity) return "Infinity";
        if (value === undefined) return "undefined";
        try { return JSON.stringify(value); }
        catch { return String(value); }
      }

      self.onmessage = (event) => {
        const { code, functionName, tests } = event.data;
        let candidate;
        try {
          candidate = new Function('"use strict";\\n' + code + '\\nreturn ' + functionName + ';')();
          if (typeof candidate !== "function") throw new Error(functionName + " is not a function");
        } catch (error) {
          self.postMessage({ fatal: error instanceof Error ? error.message : String(error) });
          return;
        }

        const results = tests.map((test) => {
          try {
            const actual = candidate(...structuredClone(test.args));
            if (actual && typeof actual.then === "function") throw new Error("Async results are not supported in this lab");
            return { pass: sameValue(actual, test.expected), actual: show(actual) };
          } catch (error) {
            return { pass: false, error: error instanceof Error ? error.message : String(error) };
          }
        });
        self.postMessage({ results });
      };
    `;

    const blobURL = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(blobURL);
    const timeout = setTimeout(() => {
      worker.terminate();
      URL.revokeObjectURL(blobURL);
      button.disabled = false;
      updateCodeResults(challenge, [], "Stopped after 1.2 seconds. Check for an infinite loop.");
    }, 1200);

    worker.onmessage = ({ data }) => {
      clearTimeout(timeout);
      worker.terminate();
      URL.revokeObjectURL(blobURL);
      button.disabled = false;
      if (data.fatal) {
        updateCodeResults(challenge, [], `Could not load the function: ${data.fatal}`);
        return;
      }
      const passed = data.results.filter((result) => result.pass).length;
      updateCodeResults(challenge, data.results, `${passed} of ${challenge.tests.length} tests passed.`);
      if (passed === challenge.tests.length) showToast("All browser tests passed.");
    };

    worker.onerror = (event) => {
      clearTimeout(timeout);
      worker.terminate();
      URL.revokeObjectURL(blobURL);
      button.disabled = false;
      updateCodeResults(challenge, [], `Worker error: ${event.message || "unknown error"}`);
    };

    worker.postMessage({
      code: editor.value,
      functionName: challenge.functionName,
      tests: challenge.tests.map((test) => ({ args: test.args, expected: test.expected }))
    });
  }

  function renderCapstone() {
    const incident = course.capstone;
    const selectedEvidence = incident.evidence.find((item) => activeIncident.evidence.includes(item.id));
    const selectedHypothesis = incident.hypotheses.find((item) => item.id === activeIncident.hypothesis);
    renderBreadcrumbs([{ label: "Course home", route: "home" }, { label: "Incident capstone" }]);

    view.innerHTML = `
      <div class="capstone-view">
        <header class="capstone-header">
          <span class="eyebrow">Capstone · ${incident.duration} min</span>
          <h1>${escapeHTML(incident.title)}</h1>
          <p>${escapeHTML(incident.summary)}</p>
          <div class="incident-strip">
            ${incident.metrics.map(([label, value]) => `<div class="incident-metric"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong></div>`).join("")}
          </div>
        </header>

        <section class="concept-section" aria-labelledby="incident-trace-title">
          <div class="concept-label"><span>01 · Trace</span><h2 id="incident-trace-title">Follow the read path</h2></div>
          <div class="concept-body">
            <div class="schematic-track">${incident.trace.map((step, index) => `<div class="schematic-node"><span>${String(index + 1).padStart(2, "0")}</span><span>${escapeHTML(step)}</span></div>`).join("")}</div>
          </div>
        </section>

        <div class="incident-board">
          <section class="evidence-panel" aria-labelledby="evidence-title">
            <h2 id="evidence-title">Inspect evidence</h2>
            <ul class="evidence-list">
              ${incident.evidence.map((item) => `<li><button class="evidence-button ${activeIncident.evidence.includes(item.id) ? "active" : ""}" type="button" data-evidence="${escapeAttr(item.id)}">${escapeHTML(item.title)}</button></li>`).join("")}
            </ul>
            <div class="incident-detail" aria-live="polite">
              ${selectedEvidence ? `<strong>${escapeHTML(selectedEvidence.title)}</strong><p>${escapeHTML(selectedEvidence.detail)}</p>` : "Select an evidence source. Build the chain before choosing a cause."}
            </div>
          </section>

          <section class="hypothesis-panel" aria-labelledby="hypothesis-title">
            <h2 id="hypothesis-title">Choose the causal boundary</h2>
            <ul class="hypothesis-list">
              ${incident.hypotheses.map((item) => `<li><button class="hypothesis-button ${activeIncident.hypothesis === item.id ? "active" : ""}" type="button" data-hypothesis="${escapeAttr(item.id)}">${escapeHTML(item.title)}</button></li>`).join("")}
            </ul>
            <div class="incident-detail ${selectedHypothesis ? (selectedHypothesis.correct ? "correct" : "incorrect") : ""}" aria-live="polite">
              ${selectedHypothesis ? `<strong>${selectedHypothesis.correct ? "Causal chain found" : "Evidence does not support this"}</strong><p>${escapeHTML(selectedHypothesis.reason)}</p>` : "Select a hypothesis only after the evidence forms a mechanism."}
            </div>
          </section>
        </div>

        ${
          selectedHypothesis?.correct
            ? `<section class="capstone-resolution"><span class="eyebrow">Mitigation and proof</span><h2>Change the contested boundary.</h2><p>${escapeHTML(incident.mitigation)}</p><strong>${state.capstoneComplete ? "✓ Capstone complete" : "Completion will be saved on this device."}</strong></section>`
            : ""
        }

        <nav class="lesson-footer-nav" aria-label="Capstone navigation">
          <button class="secondary-button" type="button" data-route="home">← Course home</button>
          <button class="primary-button" type="button" data-route="module/kernel-boundary">Revisit the stack →</button>
        </nav>
      </div>
    `;
  }

  function searchEntries() {
    return [
      ...course.modules.flatMap((module) => [
        {
          type: "Module",
          index: module.number,
          title: module.title,
          description: module.description,
          route: routeFor("module", module.id),
          terms: `${module.title} ${module.description} ${module.lessons.map((lesson) => lesson.title).join(" ")}`
        },
        ...module.lessons.map((lesson) => ({
          type: "Lesson",
          index: lesson.number,
          title: lesson.title,
          description: `${module.shortTitle} · ${lesson.summary}`,
          route: routeFor("lesson", lesson.id),
          terms: `${lesson.title} ${lesson.summary} ${lesson.core.join(" ")} ${module.title}`
        })),
        {
          type: "Workbench",
          index: module.number,
          title: module.lab.title,
          description: module.lab.intro,
          route: routeFor("lab", module.id),
          terms: `${module.lab.title} ${module.lab.intro} ${module.title}`
        }
      ]),
      {
        type: "Capstone",
        index: "XI",
        title: course.capstone.title,
        description: course.capstone.summary,
        route: "capstone",
        terms: `${course.capstone.title} ${course.capstone.summary} ${course.capstone.trace.join(" ")}`
      }
    ];
  }

  const courseSearchIndex = searchEntries();

  function matchingSearchEntries(query) {
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length) return courseSearchIndex.slice(0, 12);
    return courseSearchIndex.filter((entry) => words.every((word) => entry.terms.toLowerCase().includes(word))).slice(0, 20);
  }

  function renderSearchResults(query = "") {
    const matches = matchingSearchEntries(query);
    activeSearchIndex = Math.min(activeSearchIndex, Math.max(0, matches.length - 1));
    searchResults.innerHTML = matches.length
      ? matches
          .map(
            (entry, index) => `
              <button
                class="search-result ${index === activeSearchIndex ? "active" : ""}"
                type="button"
                role="option"
                aria-selected="${index === activeSearchIndex}"
                data-search-route="${escapeAttr(entry.route)}"
              >
                <span class="search-result-index">${escapeHTML(entry.index)}</span>
                <span><strong>${escapeHTML(entry.title)}</strong><small>${escapeHTML(entry.description)}</small></span>
                <span class="search-result-type">${escapeHTML(entry.type)}</span>
              </button>
            `
          )
          .join("")
      : '<p class="empty-state">No matching concept. Try a boundary such as KVM, cgroup, or NBD.</p>';
  }

  function openSearch() {
    activeSearchIndex = 0;
    searchInput.value = "";
    renderSearchResults();
    searchDialog.showModal();
    requestAnimationFrame(() => searchInput.focus());
  }

  function closeSearch() {
    if (searchDialog.open) searchDialog.close();
  }

  async function copyText(value) {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      const field = document.createElement("textarea");
      field.value = value;
      field.style.position = "fixed";
      field.style.opacity = "0";
      document.body.append(field);
      field.select();
      document.execCommand("copy");
      field.remove();
    }
    showToast("Command copied.");
  }

  function refreshCourseChrome() {
    const route = parseRoute();
    const moduleId = route.type === "lesson" ? lessonById.get(route.id)?.module.id : moduleById.has(route.id) ? route.id : null;
    renderNav(moduleId);
    renderDrawer(route);
    updateProgress();
  }

  function handleLabAction(action) {
    const route = parseRoute();
    const module = route.type === "lab" ? moduleById.get(route.id) : null;
    if (!module || !activeLab || activeLab.moduleId !== module.id) return;
    const labState = activeLab.state;

    if (action === "reset") {
      activeLab.state = initialLabState(activeLab.kind);
    } else if (action === "next") {
      labState.step = Math.min(4, (labState.step || 0) + 1);
    } else if (action === "run") {
      labState.tick += 1;
    } else if (action === "touch") {
      if (labState.resident < 16) {
        labState.fault = labState.resident;
        labState.resident += 1;
      } else {
        labState.fault = -1;
      }
    } else if (action === "place") {
      labState.placed = Math.min(4, labState.placed + 1);
    } else if (action === "reveal") {
      labState.reveal = !labState.reveal;
    }

    renderLabWorkbench(module);
  }

  document.addEventListener("click", (event) => {
    const skipLink = event.target.closest(".skip-link");
    if (skipLink) {
      event.preventDefault();
      view.focus();
      return;
    }

    const routeButton = event.target.closest("[data-route]");
    if (routeButton) {
      goToRoute(routeButton.dataset.route);
      return;
    }

    const stackButton = event.target.closest("[data-stack-id]");
    if (stackButton) {
      document.querySelectorAll("[data-stack-id]").forEach((button) => button.classList.toggle("active", button === stackButton));
      const layer = course.stackLayers.find((item) => item.id === stackButton.dataset.stackId);
      if (layer) updateStackReadout(layer);
      return;
    }

    const flowButton = event.target.closest("[data-flow-step]");
    if (flowButton) {
      flowButton.parentElement.querySelectorAll("[data-flow-step]").forEach((button) => button.classList.toggle("active", button === flowButton));
      return;
    }

    const microButton = event.target.closest("[data-micro-answer]");
    if (microButton) {
      const route = parseRoute();
      const lesson = lessonById.get(route.id)?.lesson;
      if (!lesson) return;
      const selected = Number(microButton.dataset.microAnswer);
      const buttons = microButton.parentElement.querySelectorAll("[data-micro-answer]");
      buttons.forEach((button) => {
        const index = Number(button.dataset.microAnswer);
        button.classList.toggle("correct", index === lesson.check.answer);
        button.classList.toggle("incorrect", button === microButton && selected !== lesson.check.answer);
      });
      document.querySelector("#micro-feedback").textContent = lesson.check.explanation;
      announce(selected === lesson.check.answer ? "Correct. Explanation revealed." : "Not quite. The mechanism is now revealed.");
      return;
    }

    const lessonComplete = event.target.closest("[data-complete-lesson]");
    if (lessonComplete) {
      const id = lessonComplete.dataset.completeLesson;
      const complete = state.completedLessons.includes(id);
      state.completedLessons = complete ? state.completedLessons.filter((item) => item !== id) : [...state.completedLessons, id];
      saveState();
      refreshCourseChrome();
      showToast(complete ? "Lesson marked incomplete." : "Lesson complete.");
      return;
    }

    const quizAnswer = event.target.closest("[data-quiz-answer]");
    if (quizAnswer && activeQuiz && !activeQuiz.revealed) {
      activeQuiz.selected = Number(quizAnswer.dataset.quizAnswer);
      const module = moduleById.get(activeQuiz.moduleId);
      if (module) renderQuiz(module);
      return;
    }

    if (event.target.closest("[data-quiz-check]")) {
      if (!activeQuiz || activeQuiz.selected === null) {
        showToast("Choose an answer first.");
        return;
      }
      const question = activeQuiz.questions[activeQuiz.index];
      activeQuiz.revealed = true;
      activeQuiz.answers[activeQuiz.index] = { selected: activeQuiz.selected, correct: activeQuiz.selected === question.answer };
      const module = moduleById.get(activeQuiz.moduleId);
      if (module) renderQuiz(module);
      return;
    }

    if (event.target.closest("[data-quiz-next]")) {
      if (!activeQuiz?.revealed) return;
      const module = moduleById.get(activeQuiz.moduleId);
      if (!module) return;
      if (activeQuiz.index === activeQuiz.questions.length - 1) {
        activeQuiz.finished = true;
        const score = Math.round((activeQuiz.answers.filter((answer) => answer?.correct).length / activeQuiz.questions.length) * 100);
        state.quizScores[module.id] = Math.max(state.quizScores[module.id] || 0, score);
        saveState();
        renderQuiz(module);
        refreshCourseChrome();
      } else {
        activeQuiz.index += 1;
        activeQuiz.selected = null;
        activeQuiz.revealed = false;
        renderQuiz(module);
      }
      return;
    }

    if (event.target.closest("[data-quiz-retry]")) {
      if (!activeQuiz) return;
      const module = moduleById.get(activeQuiz.moduleId);
      if (!module) return;
      activeQuiz = newQuiz(module);
      renderQuiz(module);
      return;
    }

    const labAction = event.target.closest("[data-lab-action]");
    if (labAction) {
      handleLabAction(labAction.dataset.labAction);
      return;
    }

    const labComplete = event.target.closest("[data-complete-lab]");
    if (labComplete) {
      const id = labComplete.dataset.completeLab;
      const complete = state.completedLabs.includes(id);
      state.completedLabs = complete ? state.completedLabs.filter((item) => item !== id) : [...state.completedLabs, id];
      saveState();
      labComplete.classList.toggle("complete", !complete);
      labComplete.textContent = complete ? "Mark workbench complete" : "✓ Workbench complete";
      refreshCourseChrome();
      showToast(complete ? "Workbench marked incomplete." : "Workbench complete.");
      return;
    }

    const copyButton = event.target.closest("[data-copy-command]");
    if (copyButton) {
      const route = parseRoute();
      const module = moduleById.get(route.id);
      const command = module?.lab.notebook[Number(copyButton.dataset.copyCommand)]?.command;
      if (command) copyText(command);
      return;
    }

    const codeRun = event.target.closest("[data-code-run]");
    if (codeRun) {
      runCodeChallenge(codeRun.dataset.codeRun);
      return;
    }

    const codeReset = event.target.closest("[data-code-reset]");
    if (codeReset) {
      const challenge = currentChallenge(codeReset.dataset.codeReset);
      const editor = challenge ? document.querySelector(`#code-editor-${challenge.id}`) : null;
      if (challenge && editor) {
        editor.value = challenge.starter;
        updateCodeResults(challenge, null, "Starter restored. Edit the function, then run the tests.");
      }
      return;
    }

    const evidenceButton = event.target.closest("[data-evidence]");
    if (evidenceButton) {
      activeIncident.evidence = [evidenceButton.dataset.evidence];
      renderCapstone();
      return;
    }

    const hypothesisButton = event.target.closest("[data-hypothesis]");
    if (hypothesisButton) {
      activeIncident.hypothesis = hypothesisButton.dataset.hypothesis;
      const hypothesis = course.capstone.hypotheses.find((item) => item.id === activeIncident.hypothesis);
      if (hypothesis?.correct) {
        state.capstoneComplete = true;
        saveState();
      }
      renderCapstone();
      refreshCourseChrome();
      return;
    }

    const searchRoute = event.target.closest("[data-search-route]");
    if (searchRoute) {
      closeSearch();
      goToRoute(searchRoute.dataset.searchRoute);
      return;
    }
  });

  document.addEventListener("change", (event) => {
    const field = event.target.closest("[data-lab-field]");
    const toggle = event.target.closest("[data-lab-toggle]");
    if (!field && !toggle) return;
    const route = parseRoute();
    const module = route.type === "lab" ? moduleById.get(route.id) : null;
    if (!module || !activeLab || activeLab.moduleId !== module.id) return;
    const labState = activeLab.state;

    if (field) {
      const key = field.dataset.labField;
      labState[key] = typeof labState[key] === "number" ? Number(field.value) : field.value;
      if (["event", "path", "scenario", "program"].includes(key)) labState.step = 0;
      if (key === "pageSize") Object.assign(labState, { resident: 0, fault: -1 });
      if (key === "strategy") Object.assign(labState, { placed: 0, reveal: false });
    }
    if (toggle) labState[toggle.dataset.labToggle] = toggle.checked;
    renderLabWorkbench(module);
  });

  depthSelect.addEventListener("change", () => {
    state.depth = depthSelect.value;
    document.body.dataset.depth = state.depth;
    saveState();
    announce(`${depthSelect.options[depthSelect.selectedIndex].text} selected.`);
  });

  document.querySelector("#search-trigger").addEventListener("click", openSearch);
  document.querySelector("#search-close").addEventListener("click", closeSearch);
  searchInput.addEventListener("input", () => {
    activeSearchIndex = 0;
    renderSearchResults(searchInput.value);
  });
  searchInput.addEventListener("keydown", (event) => {
    const matches = matchingSearchEntries(searchInput.value);
    if (event.key === "ArrowDown" && matches.length) {
      event.preventDefault();
      activeSearchIndex = (activeSearchIndex + 1) % matches.length;
      renderSearchResults(searchInput.value);
    } else if (event.key === "ArrowUp" && matches.length) {
      event.preventDefault();
      activeSearchIndex = (activeSearchIndex - 1 + matches.length) % matches.length;
      renderSearchResults(searchInput.value);
    } else if (event.key === "Enter" && matches[activeSearchIndex]) {
      event.preventDefault();
      closeSearch();
      goToRoute(matches[activeSearchIndex].route);
    }
  });
  searchDialog.addEventListener("click", (event) => {
    if (event.target === searchDialog) closeSearch();
  });

  const mobileMapButton = document.querySelector("#mobile-map-trigger");
  const mobileMapCloseButton = document.querySelector("#mobile-map-close");
  const courseRail = document.querySelector(".course-rail");
  const mobileMedia = window.matchMedia("(max-width: 760px)");

  function syncMobileMapAccess() {
    const hidden = mobileMedia.matches && !document.body.classList.contains("map-open");
    courseRail.inert = hidden;
    if (hidden) courseRail.setAttribute("aria-hidden", "true");
    else courseRail.removeAttribute("aria-hidden");
  }

  function setMobileMap(open) {
    document.body.classList.toggle("map-open", open);
    mobileMapButton.setAttribute("aria-expanded", String(open));
    syncMobileMapAccess();
  }

  mobileMapButton.addEventListener("click", () => {
    const open = !document.body.classList.contains("map-open");
    setMobileMap(open);
    if (open) requestAnimationFrame(() => mobileMapCloseButton.focus());
  });
  mobileMapCloseButton.addEventListener("click", () => {
    setMobileMap(false);
    mobileMapButton.focus();
  });
  mobileMedia.addEventListener("change", syncMobileMapAccess);

  document.querySelector("#reset-progress").addEventListener("click", () => {
    if (!window.confirm("Reset lesson, workbench, quiz, and capstone progress on this device?")) return;
    state = structuredClone(defaultState);
    activeQuiz = null;
    activeLab = null;
    activeIncident = { evidence: [], hypothesis: null };
    document.body.dataset.depth = state.depth;
    depthSelect.value = state.depth;
    saveState();
    renderRoute();
    showToast("Course progress reset.");
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      searchDialog.open ? closeSearch() : openSearch();
    }
    if (event.key === "Escape" && document.body.classList.contains("map-open")) {
      setMobileMap(false);
    }
  });

  function sanitizeState() {
    const lessonIds = new Set(allLessons.map(({ lesson }) => lesson.id));
    const moduleIds = new Set(course.modules.map((module) => module.id));
    state.completedLessons = [...new Set(state.completedLessons)].filter((id) => lessonIds.has(id));
    state.completedLabs = [...new Set(state.completedLabs)].filter((id) => moduleIds.has(id));
    state.quizScores = Object.fromEntries(
      Object.entries(state.quizScores)
        .filter(([id, score]) => moduleIds.has(id) && Number.isFinite(Number(score)))
        .map(([id, score]) => [id, Math.max(0, Math.min(100, Number(score)))])
    );
    if (!new Set(["core", "kernel", "code"]).has(state.depth)) state.depth = "core";
    if (typeof state.capstoneComplete !== "boolean") state.capstoneComplete = false;
  }

  sanitizeState();
  document.body.dataset.depth = state.depth;
  depthSelect.value = state.depth;
  syncMobileMapAccess();
  if (location.hash === "#course-view") history.replaceState(null, "", `${location.pathname}${location.search}`);
  window.addEventListener("hashchange", renderRoute);
  renderRoute();
})();
