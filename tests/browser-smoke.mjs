import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, PROGRAM_LIST } from "../js/program.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOST = "127.0.0.1";
const QA_ARTIFACTS = join(tmpdir(), "workout-program-qa");
const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function makeStaticServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${HOST}`);
      const pathname = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const relative = normalize(pathname).replace(/^[/\\]+/, "");
      const filename = join(ROOT, relative);
      if (!filename.startsWith(ROOT)) throw new Error("Invalid path");
      const info = await stat(filename);
      if (!info.isFile()) throw new Error("Not a file");
      response.writeHead(200, { "content-type": MIME.get(extname(filename)) ?? "application/octet-stream" });
      createReadStream(filename).pipe(response);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    }
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, resolve);
  });
  return server.address().port;
}

async function findFreePort() {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function getDebugTarget(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://${HOST}:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.url.startsWith("http://"));
      if (page) return page;
    } catch { /* Chrome is still starting. */ }
    await delay(100);
  }
  throw new Error("Chrome DevTools target did not start");
}

async function connectCdp(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  const consoleErrors = [];
  const logErrors = [];
  const httpErrors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      consoleErrors.push(message.params.args.map((argument) => argument.value ?? argument.description ?? "").join(" "));
    }
    if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      logErrors.push(message.params.entry.text);
    }
    if (message.method === "Network.responseReceived" && message.params.response.status >= 400) {
      httpErrors.push(`${message.params.response.status} ${message.params.response.url}`);
    }
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  return { socket, send, exceptions, consoleErrors, logErrors, httpErrors };
}

function formatDurationMinutes(duration) {
  if (Number.isFinite(duration)) return `близько ${duration} хв`;
  if (duration && Number.isFinite(duration.min) && Number.isFinite(duration.max)) {
    return duration.min === duration.max ? `${duration.min} хв` : `${duration.min}–${duration.max} хв`;
  }
  return "тривалість залежить від темпу";
}

const EXPECTED_CATALOG_MATRIX = {
  categories: CATEGORIES.map(({ id, name }) => ({ id, name })),
  programs: PROGRAM_LIST.map((program) => ({
    id: program.id,
    categoryId: program.categoryId,
    name: program.name,
    description: program.description,
    audience: `Для кого: ${program.audience}`,
    frequency: `${program.frequency.sessionsPerWeek}× на тиждень · ${formatDurationMinutes(program.frequency.durationMinutes)}`,
    days: program.days.map((day) => ({
      id: day.id,
      name: day.name,
      focus: day.focus,
      cards: day.cards.map((card) => ({
        id: card.id,
        name: card.name,
        shortAlternative: card.shortAlternative ?? "",
        params: [...card.params],
        technique: (card.content?.technique ?? []).map(({ heading, text }) => ({ heading, text })),
        alternatives: [...(card.content?.alternatives ?? [])],
        cue: card.content?.cue ?? "",
      })),
    })),
  })),
  guide: PROGRAM_LIST.map((program) => ({
    id: program.id,
    name: program.name,
    description: program.description,
    audience: `Для кого: ${program.audience}`,
    meta: `${program.frequency.sessionsPerWeek}× на тиждень · ${formatDurationMinutes(program.frequency.durationMinutes)} · ${program.days.length} типи тренувань`,
    action: "Обрати програму",
  })),
};

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
}

async function captureScreenshot(cdp, filename) {
  await mkdir(QA_ARTIFACTS, { recursive: true });
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const path = join(QA_ARTIFACTS, filename);
  await writeFile(path, Buffer.from(result.data, "base64"));
  return path;
}

const browser = findBrowser();
if (!browser) {
  console.log("SKIP browser smoke: Chrome/Edge not found");
  process.exit(0);
}

const server = makeStaticServer();
const profile = await mkdtemp(join(tmpdir(), "workout-program-smoke-"));
const debugPort = await findFreePort();
let chrome;

try {
  const sitePort = await listen(server);
  const pageUrl = `http://${HOST}:${sitePort}/`;
  const seedUrl = `http://${HOST}:${sitePort}/__legacy_seed__`;
  chrome = spawn(browser, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--window-size=390,844",
    "--force-device-scale-factor=1",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    seedUrl,
  ], { stdio: "ignore", windowsHide: true });

  const target = await getDebugTarget(debugPort);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });

  await cdp.send("Page.navigate", { url: seedUrl });
  const seedOrigin = new URL(seedUrl).origin;
  let seedDocumentReady = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    seedDocumentReady = await evaluate(cdp, `location.origin === ${JSON.stringify(seedOrigin)} && document.readyState === 'complete'`);
    if (seedDocumentReady) break;
    await delay(50);
  }
  assert.equal(seedDocumentReady, true, "Seed page did not commit a ready same-origin document");

  const seeded = await evaluate(cdp, `(async () => {
    const request = indexedDB.open('workout-program', 1);
    const database = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const db = request.result;
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('by-workout-date', 'workoutDate');
        sessions.createIndex('by-status', 'status');
        sessions.createIndex('by-performed-at', 'performedAt');
        const entries = db.createObjectStore('entries', { keyPath: 'id' });
        entries.createIndex('by-session', 'sessionId');
        entries.createIndex('by-exercise', ['exerciseId', 'variantId', 'equipmentKey']);
        entries.createIndex('unique-session-slot', ['sessionId', 'slotId'], { unique: true });
        db.createObjectStore('settings', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = database.transaction(['sessions', 'entries', 'settings'], 'readwrite');
    const performedAt = '2026-10-01T10:00:00.000Z';
    tx.objectStore('sessions').put({
      id: 'legacy-session', dayId: 'a', programVersion: 1,
      workoutDate: '2026-10-01', performedAt, createdAt: performedAt,
      updatedAt: performedAt, status: 'completed', completedAt: performedAt, revision: 1,
    });
    tx.objectStore('entries').put({
      id: 'legacy-entry', sessionId: 'legacy-session', slotId: 'a1',
      exerciseId: 'chest-supported-wide-row', variantId: 'machine',
      equipmentKey: 'default', loadConvention: 'total',
      exerciseNameSnapshot: 'Chest-Supported Machine Row (Wide Grip)',
      variantSnapshot: 'Тренажер', notes: '', updatedAt: performedAt, revision: 1,
      sets: [{ id: 'legacy-set', order: 1, kind: 'working', loadKg: 35, reps: 8,
        durationSeconds: null, side: 'both', confirmed: true, completedAt: performedAt }],
    });
    tx.objectStore('settings').put({ key: 'activeSessionId', value: null });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
      tx.onerror = () => reject(tx.error);
    });
    database.close();
    return true;
  })()`);
  assert.equal(seeded, true);
  cdp.exceptions.length = 0;
  cdp.consoleErrors.length = 0;
  cdp.logErrors.length = 0;
  cdp.httpErrors.length = 0;
  await cdp.send("Page.navigate", { url: pageUrl });
  await delay(300);

  const catalogMatrix = await evaluate(cdp, `(async () => {
    const waitFor = async (check, message) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(message);
    };
    await waitFor(() => document.querySelector('#category-picker')?.options.length === 5
      && document.querySelectorAll('#program-guide-list .program-guide-item').length === 5,
    'Program catalog did not render');
    const readOptions = (select) => [...select.options].map((option) => ({ id: option.value, name: option.textContent }));
    const programs = [];
    const programOptionsByCategory = {};
    for (const expected of ${JSON.stringify(EXPECTED_CATALOG_MATRIX.programs)}) {
      const category = document.querySelector('#category-picker');
      category.value = expected.categoryId;
      category.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => document.querySelector('#program-picker')?.value === expected.id,
        'Program picker did not follow category ' + expected.categoryId);
      const programPicker = document.querySelector('#program-picker');
      programOptionsByCategory[expected.categoryId] = readOptions(programPicker);
      programPicker.value = expected.id;
      programPicker.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => document.querySelector('#program-summary .program-title')?.textContent === expected.name,
        'Program summary did not render ' + expected.id);
      const days = [];
      for (const expectedDay of expected.days) {
        document.querySelector('.day-tab[data-day-id="' + expectedDay.id + '"]').click();
        await waitFor(() => document.querySelector('#exercises-title')?.textContent.startsWith(expectedDay.name)
          && document.querySelectorAll('#exercise-list .exercise-item').length === expectedDay.cards.length,
        'Day cards did not render ' + expected.id + '/' + expectedDay.id);
        days.push({
          id: expectedDay.id,
          name: document.querySelector('.day-tab[aria-selected="true"]').title,
          focus: document.querySelector('#day-focus').textContent,
          cards: [...document.querySelectorAll('#exercise-list .exercise-item')].map((card) => ({
            id: card.dataset.cardId,
            name: card.querySelector('.exercise-name')?.textContent ?? '',
            shortAlternative: card.querySelector('.exercise-sub-alt')?.textContent ?? '',
            params: [...card.querySelectorAll('.exercise-params .param-badge')].map((node) => node.textContent),
            technique: [...card.querySelectorAll('.tech-item')].map((node) => ({
              heading: node.querySelector('strong')?.textContent ?? '',
              text: node.querySelector('p')?.textContent ?? '',
            })),
            alternatives: [...card.querySelectorAll('.alt-item')].map((node) => node.textContent),
            cue: card.querySelector('.cue-box')?.textContent ?? '',
          })),
        });
      }
      programs.push({
        id: expected.id,
        categoryId: expected.categoryId,
        name: document.querySelector('#program-summary .program-title').textContent,
        description: document.querySelector('#program-summary .program-title + p').textContent,
        audience: document.querySelector('#program-summary .program-audience').textContent,
        frequency: document.querySelector('#program-summary .program-meta').textContent,
        days,
      });
    }
    const guide = [...document.querySelectorAll('#program-guide-list .program-guide-item')].map((item) => ({
      id: item.dataset.programId,
      name: item.querySelector('h3')?.textContent ?? '',
      description: item.querySelector('.program-guide-description')?.textContent ?? '',
      audience: item.querySelector('.program-guide-audience')?.textContent ?? '',
      meta: item.querySelector('.program-meta')?.textContent ?? '',
      action: item.querySelector('.guide-select-program')?.textContent ?? '',
    }));
    const guideSelections = [];
    for (const expected of ${JSON.stringify(EXPECTED_CATALOG_MATRIX.guide)}) {
      document.querySelector('#program-guide-list [data-program-id="' + expected.id + '"] .guide-select-program').click();
      await waitFor(() => document.querySelector('#program-picker')?.value === expected.id,
        'Guide action did not select ' + expected.id);
      guideSelections.push(document.querySelector('#program-picker').value);
    }
    return {
      categories: readOptions(document.querySelector('#category-picker')),
      programOptionsByCategory,
      programs,
      guide,
      guideSelections,
    };
  })()`);

  assert.deepEqual(catalogMatrix.categories, EXPECTED_CATALOG_MATRIX.categories);
  assert.deepEqual(catalogMatrix.programs, EXPECTED_CATALOG_MATRIX.programs);
  assert.deepEqual(catalogMatrix.guide, EXPECTED_CATALOG_MATRIX.guide);
  assert.deepEqual(catalogMatrix.guideSelections, EXPECTED_CATALOG_MATRIX.guide.map(({ id }) => id));
  for (const program of EXPECTED_CATALOG_MATRIX.programs) {
    assert.deepEqual(catalogMatrix.programOptionsByCategory[program.categoryId], [{ id: program.id, name: program.name }]);
  }

  const navigationQa = await evaluate(cdp, `(async () => {
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const toggle = document.querySelector('#menu-toggle');
    const drawer = document.querySelector('#app-drawer');
    const backdrop = document.querySelector('#menu-backdrop');
    toggle.focus();
    toggle.click();
    await nextFrame();
    const opened = {
      expanded: toggle.getAttribute('aria-expanded'),
      controls: toggle.getAttribute('aria-controls'),
      drawerVisible: !drawer.hidden,
      backdropVisible: !backdrop.hidden,
      mainInert: document.querySelector('main').inert,
      bodyOverflow: getComputedStyle(document.body).overflow,
      focusInside: drawer.contains(document.activeElement),
    };
    const focusable = [...drawer.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.hidden && node.getClientRects().length > 0);
    focusable.at(-1).focus();
    drawer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const forwardTrap = document.activeElement === focusable[0];
    focusable[0].focus();
    drawer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    const backwardTrap = document.activeElement === focusable.at(-1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextFrame();
    const escaped = { hidden: drawer.hidden, expanded: toggle.getAttribute('aria-expanded'), focusReturned: document.activeElement === toggle };
    toggle.click();
    await nextFrame();
    drawer.querySelector('[data-nav-id="guide"]').click();
    await nextFrame();
    const selection = {
      drawerHidden: drawer.hidden,
      guideVisible: !document.querySelector('#tab-guide').hidden,
      journalHidden: document.querySelector('#tab-journal').hidden,
      current: drawer.querySelector('[aria-current="page"]')?.dataset.navId,
      focused: document.activeElement?.id,
    };
    toggle.click();
    await nextFrame();
    drawer.querySelector('[data-nav-id="journal"]').click();
    await nextFrame();
    return {
      opened,
      forwardTrap,
      backwardTrap,
      escaped,
      selection,
      minTargets: ['#menu-toggle', '#start-workout', '#category-picker', '.day-tab'].map((selector) => ({
        selector,
        height: document.querySelector(selector).getBoundingClientRect().height,
      })),
      mobileDashboardColumns: getComputedStyle(document.querySelector('.journal-dashboard')).gridTemplateColumns.split(' ').length,
    };
  })()`);
  assert.deepEqual(navigationQa.opened, {
    expanded: "true",
    controls: "app-drawer",
    drawerVisible: true,
    backdropVisible: true,
    mainInert: true,
    bodyOverflow: "hidden",
    focusInside: true,
  });
  assert.equal(navigationQa.forwardTrap, true);
  assert.equal(navigationQa.backwardTrap, true);
  assert.deepEqual(navigationQa.escaped, { hidden: true, expanded: "false", focusReturned: true });
  assert.deepEqual(navigationQa.selection, {
    drawerHidden: true,
    guideVisible: true,
    journalHidden: true,
    current: "guide",
    focused: "guide-title",
  });
  assert.equal(navigationQa.minTargets.every(({ height }) => height >= 44), true);
  assert.equal(navigationQa.mobileDashboardColumns, 1);
  const mobileDashboardScreenshot = await captureScreenshot(cdp, "dashboard-390x844.png");
  await evaluate(cdp, "document.querySelector('#menu-toggle').click()");
  await delay(100);
  const mobileDrawerScreenshot = await captureScreenshot(cdp, "drawer-390x844.png");
  await evaluate(cdp, "document.querySelector('#menu-close').click()");

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const desktopQa = await evaluate(cdp, `(async () => {
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const toggle = document.querySelector('#menu-toggle');
    const drawer = document.querySelector('#app-drawer');
    toggle.focus();
    toggle.click();
    await nextFrame();
    const focusable = [...drawer.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
      .filter((node) => !node.hidden && node.getClientRects().length > 0);
    focusable.at(-1).focus();
    drawer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    const forwardTrap = document.activeElement === focusable[0];
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextFrame();
    return {
      viewport: [innerWidth, innerHeight],
      menuVisible: getComputedStyle(toggle).display !== 'none',
      menuHeight: toggle.getBoundingClientRect().height,
      dashboardColumns: getComputedStyle(document.querySelector('.journal-dashboard')).gridTemplateColumns.split(' ').length,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      forwardTrap,
      escapeClosed: drawer.hidden,
      focusReturned: document.activeElement === toggle,
    };
  })()`);
  assert.deepEqual(desktopQa.viewport, [1440, 900]);
  assert.equal(desktopQa.menuVisible, true);
  assert.ok(desktopQa.menuHeight >= 44);
  assert.equal(desktopQa.dashboardColumns, 2);
  assert.equal(desktopQa.horizontalOverflow, false);
  assert.equal(desktopQa.forwardTrap, true);
  assert.equal(desktopQa.escapeClosed, true);
  assert.equal(desktopQa.focusReturned, true);
  const desktopDashboardScreenshot = await captureScreenshot(cdp, "dashboard-1440x900.png");
  await evaluate(cdp, "document.querySelector('#menu-toggle').click()");
  await delay(100);
  const desktopDrawerScreenshot = await captureScreenshot(cdp, "drawer-1440x900.png");
  await evaluate(cdp, "document.querySelector('#menu-close').click()");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });

  const migration = await evaluate(cdp, `(async () => {
    const waitFor = async (check, message) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(message);
    };
    await waitFor(() => document.querySelector('#history-filters select')
      && document.querySelector('#start-workout')
      && !document.querySelector('#start-workout').disabled, 'App did not boot');

    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('workout-program');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = database.transaction(['sessions', 'entries'], 'readonly');
    const legacySession = await new Promise((resolve, reject) => {
      const request = tx.objectStore('sessions').get('legacy-session');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const legacyEntry = await new Promise((resolve, reject) => {
      const request = tx.objectStore('entries').get('legacy-entry');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const databaseVersion = database.version;
    database.close();

    const mobileControls = ['#workout-date', '#category-picker', '#program-picker'].map((selector) => {
      const control = document.querySelector(selector);
      control.focus();
      return {
        selector,
        fontSize: Number.parseFloat(getComputedStyle(control).fontSize),
        focused: document.activeElement === control,
      };
    });

    const category = document.querySelector('#category-picker');
    category.value = 'performance';
    category.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => document.querySelector('#program-picker').value === 'athlete-full-body-3x', 'Athlete program was not selected');
    document.querySelector('#start-workout').click();
    await waitFor(() => document.querySelectorAll('.exercise-log').length === 8
      && document.querySelector('[data-slot-id="athlete-full-body-3x:a:a1"]'), 'Athlete Day A forms were not rendered');
    return {
      databaseVersion,
      migratedProgram: legacySession?.programId,
      migratedSlot: legacyEntry?.slotId,
      migratedLoad: legacyEntry?.sets?.[0]?.loadKg,
      programId: document.querySelector('#program-picker').value,
      forms: document.querySelectorAll('.exercise-log').length,
      viewport: [innerWidth, innerHeight],
      mobileControls,
      sessionPosition: getComputedStyle(document.querySelector('.session-card')).position,
      viewportMeta: document.querySelector('meta[name="viewport"]').content,
    };
  })()`);

  assert.equal(migration.databaseVersion, 2);
  assert.equal(migration.migratedProgram, 'spine-safe');
  assert.equal(migration.migratedSlot, 'spine-safe:a:a1');
  assert.equal(migration.migratedLoad, 35);
  assert.equal(migration.programId, 'athlete-full-body-3x');
  assert.equal(migration.forms, 8);
  assert.deepEqual(migration.viewport, [390, 844]);
  assert.equal(migration.mobileControls.every((control) => control.fontSize >= 16 && control.focused), true);
  assert.notEqual(migration.sessionPosition, 'sticky');
  assert.notEqual(migration.sessionPosition, 'fixed');
  assert.doesNotMatch(migration.viewportMeta, /maximum-scale|user-scalable/i);

  await cdp.send("Page.reload", { ignoreCache: true });
  await delay(300);

  const result = await evaluate(cdp, `(async () => {
    const waitFor = async (check, message) => {
      for (let attempt = 0; attempt < 80; attempt += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(message);
    };
    await waitFor(() => document.querySelector('#start-workout')?.disabled
      && document.querySelectorAll('.exercise-log').length === 8, 'Active athlete workout was not resumed');
    const slotSelector = '[data-slot-id="athlete-full-body-3x:a:a1"]';
    const row = document.querySelector(slotSelector + ' .set-row');
    const numbers = row.querySelectorAll('input[type="number"]');
    numbers[0].value = '50';
    numbers[0].dispatchEvent(new Event('input', { bubbles: true }));
    numbers[1].value = '6';
    numbers[1].dispatchEvent(new Event('input', { bubbles: true }));
    const completed = row.querySelector('input[type="checkbox"]');
    completed.checked = true;
    completed.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => document.querySelector('#save-status').textContent === 'Збережено', 'Set was not saved');
    document.querySelector('#finish-workout').click();
    await waitFor(() => !document.querySelector('#start-workout').disabled, 'Workout was not completed');
    document.querySelector('.drawer-link[data-nav-id="history"]').click();
    await waitFor(() => document.querySelectorAll('.history-item').length >= 2, 'Migrated and completed workouts missing from history');
    const historyText = document.querySelector('#history-list').textContent;
    document.querySelector('.drawer-link[data-nav-id="journal"]').click();

    const dateControl = document.querySelector('#workout-date');
    dateControl.focus();
    const dateFocus = document.activeElement === dateControl;
    const dateFontSize = Number.parseFloat(getComputedStyle(dateControl).fontSize);

    const startNextWorkout = async (message) => {
      document.querySelector('#start-workout').click();
      await waitFor(() => document.querySelectorAll('.exercise-log').length === 8, message);
    };
    const saveWorkingSet = async (load, reps) => {
      const activeRow = document.querySelector(slotSelector + ' .set-row');
      const activeNumbers = activeRow.querySelectorAll('input[type="number"]');
      activeNumbers[0].value = String(load);
      activeNumbers[0].dispatchEvent(new Event('input', { bubbles: true }));
      activeNumbers[1].value = String(reps);
      activeNumbers[1].dispatchEvent(new Event('input', { bubbles: true }));
      const activeCompleted = activeRow.querySelector('input[type="checkbox"]');
      activeCompleted.checked = true;
      activeCompleted.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => document.querySelector('#save-status').textContent === 'Збережено', 'Set was not saved');
    };
    const finishActiveWorkout = async () => {
      document.querySelector('#finish-workout').click();
      await waitFor(() => !document.querySelector('#start-workout').disabled, 'Workout was not completed');
    };

    await startNextWorkout('Second athlete workout did not start');
    const previous = document.querySelector(slotSelector + ' .last-result').textContent;
    const stableAtFifty = document.querySelector(slotSelector + ' .stable-result').textContent;
    const secondNumbers = document.querySelector(slotSelector + ' .set-row').querySelectorAll('input[type="number"]');
    const autoFilledFifty = secondNumbers[0].value;
    const repsRemainEmpty = secondNumbers[1].value;
    const mobileActiveControls = [
      document.querySelector(slotSelector + ' input[type="number"]'),
      document.querySelector(slotSelector + ' input[type="text"]'),
      document.querySelector(slotSelector + ' select'),
    ].map((control) => {
      control.focus();
      return {
        fontSize: Number.parseFloat(getComputedStyle(control).fontSize),
        focused: document.activeElement === control,
      };
    });
    const stableCopy = [...document.querySelectorAll(slotSelector + ' .workout-actions button')]
      .find((button) => button.textContent.startsWith('Повторити з орієнтиром'));
    stableCopy.click();
    await waitFor(() => document.querySelector(slotSelector + ' .set-row input[aria-label="Повтори"]')?.value === '6', 'Stable-load copy did not preserve actual reps');
    const copiedNumbers = document.querySelector(slotSelector + ' .set-row').querySelectorAll('input[type="number"]');
    const copiedStableLoad = copiedNumbers[0].value;
    const copiedActualReps = copiedNumbers[1].value;
    await saveWorkingSet(40, 8);
    await finishActiveWorkout();

    await startNextWorkout('Third athlete workout did not start');
    const stableAfterLower = document.querySelector(slotSelector + ' .stable-result').textContent;
    await saveWorkingSet(60, 5);
    await finishActiveWorkout();

    await startNextWorkout('Fourth athlete workout did not start');
    const stableAtSixty = document.querySelector(slotSelector + ' .stable-result').textContent;
    document.querySelector('.drawer-link[data-nav-id="history"]').click();
    const beforeDeleteCount = document.querySelectorAll('#history-list .history-item').length;

    const readDatabase = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('workout-program');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const getAll = (store) => new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const beforeDeleteDb = await readDatabase();
    const beforeDeleteTx = beforeDeleteDb.transaction(['sessions', 'entries'], 'readonly');
    const [sessionsBeforeDelete, entriesBeforeDelete] = await Promise.all([
      getAll(beforeDeleteTx.objectStore('sessions')),
      getAll(beforeDeleteTx.objectStore('entries')),
    ]);
    beforeDeleteDb.close();
    const highEntry = entriesBeforeDelete.find((entry) => entry.sets?.some((set) => set.confirmed && set.loadKg === 60));
    const highSessionId = highEntry?.sessionId;
    const newestCompletedId = sessionsBeforeDelete
      .filter((session) => session.status === 'completed')
      .sort((a, b) => b.performedAt.localeCompare(a.performedAt))[0]?.id;

    window.confirm = () => true;
    document.querySelector('#history-list .history-item .action-danger').click();
    await waitFor(() => document.querySelectorAll('#history-list .history-item').length === beforeDeleteCount - 1, 'History card was not deleted');

    const afterDeleteDb = await readDatabase();
    const afterDeleteTx = afterDeleteDb.transaction(['sessions', 'entries'], 'readonly');
    const [sessionsAfterDelete, entriesAfterDelete] = await Promise.all([
      getAll(afterDeleteTx.objectStore('sessions')),
      getAll(afterDeleteTx.objectStore('entries')),
    ]);
    afterDeleteDb.close();
    document.querySelector('.drawer-link[data-nav-id="journal"]').click();
    const stableAfterDelete = document.querySelector(slotSelector + ' .stable-result').textContent;
    return {
      forms: document.querySelectorAll('.exercise-log').length,
      historyItems: beforeDeleteCount,
      historyText,
      previous,
      stableAtFifty,
      autoFilledFifty,
      repsRemainEmpty,
      copiedStableLoad,
      copiedActualReps,
      stableAfterLower,
      stableAtSixty,
      stableAfterDelete,
      highSessionId,
      newestCompletedId,
      deletedSession: !sessionsAfterDelete.some((session) => session.id === highSessionId),
      cascadedEntries: !entriesAfterDelete.some((entry) => entry.sessionId === highSessionId),
      mobileActiveControls,
      dateFocus,
      dateFontSize,
      saveStatus: document.querySelector('#save-status').textContent,
      resumedProgram: document.querySelector('#program-picker').value,
      hasHorizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  })()`);

  assert.equal(result.forms, 8);
  assert.ok(result.historyItems >= 2);
  assert.match(result.historyText, /PRO Spine-Safe/);
  assert.match(result.historyText, /Classic Athletic/);
  assert.match(result.previous, /50.*6/);
  assert.match(result.stableAtFifty, /50 кг/);
  assert.equal(result.autoFilledFifty, '50');
  assert.equal(result.repsRemainEmpty, '');
  assert.equal(result.copiedStableLoad, '50');
  assert.equal(result.copiedActualReps, '6');
  assert.match(result.stableAfterLower, /50 кг/);
  assert.match(result.stableAtSixty, /60 кг/);
  assert.match(result.stableAfterDelete, /50 кг/);
  assert.equal(result.highSessionId, result.newestCompletedId);
  assert.equal(result.deletedSession, true);
  assert.equal(result.cascadedEntries, true);
  assert.equal(result.mobileActiveControls.every((control) => control.fontSize >= 16 && control.focused), true);
  assert.equal(result.dateFocus, true);
  assert.ok(result.dateFontSize >= 16);
  assert.equal(result.resumedProgram, 'athlete-full-body-3x');
  assert.equal(result.hasHorizontalOverflow, false);

  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    (() => {
      const users = {
        'a@example.com': { id: '11111111-1111-4111-8111-111111111111', email: 'a@example.com' },
        'b@example.com': { id: '22222222-2222-4222-8222-222222222222', email: 'b@example.com' },
      };
      const state = { session: null, listeners: [], rows: new Map() };
      const notify = (event) => state.listeners.forEach((callback) => callback(event, state.session));
      const client = {
        auth: {
          getSession: async () => ({ data: { session: state.session }, error: null }),
          onAuthStateChange: (callback) => {
            state.listeners.push(callback);
            return { data: { subscription: { unsubscribe() {} } } };
          },
          signInWithPassword: async ({ email }) => {
            const user = users[email];
            if (!user) return { data: null, error: new Error('Unknown mock user') };
            state.session = { user };
            notify('SIGNED_IN');
            return { data: { user, session: state.session }, error: null };
          },
          signUp: async ({ email }) => ({ data: { user: users[email] || null, session: null }, error: null }),
          signOut: async () => {
            state.session = null;
            notify('SIGNED_OUT');
            return { error: null };
          },
          resetPasswordForEmail: async () => ({ error: null }),
          updateUser: async () => ({ data: { user: state.session?.user || null }, error: null }),
        },
        from() {
          const query = { operation: 'read', payload: null, filters: {} };
          const builder = {
            select() { return builder; },
            eq(column, value) { query.filters[column] = value; return builder; },
            insert(payload) { query.operation = 'insert'; query.payload = payload; return builder; },
            update(payload) { query.operation = 'update'; query.payload = payload; return builder; },
            async maybeSingle() {
              const userId = query.filters.user_id;
              const current = state.rows.get(userId) || null;
              if (query.operation === 'update') {
                if (!current || current.revision !== query.filters.revision) return { data: null, error: null };
                const next = { ...current, ...query.payload };
                state.rows.set(userId, next);
                return { data: next, error: null };
              }
              return { data: current, error: null };
            },
            async single() {
              if (query.operation !== 'insert') return { data: null, error: new Error('Unexpected mock single') };
              const row = { ...query.payload, updated_at: 'mock-' + query.payload.revision };
              state.rows.set(row.user_id, row);
              return { data: row, error: null };
            },
          };
          return builder;
        },
      };
      window.__mockCloudState = state;
      window.__WORKOUT_CLOUD_TEST__ = {
        config: {
          supabaseUrl: 'https://mock.supabase.co',
          supabasePublishableKey: 'sb_publishable_mock',
          table: 'workout_snapshots',
        },
        createClient: () => client,
      };
    })();
  ` });
  await cdp.send("Page.reload", { ignoreCache: true });
  await delay(400);

  const accountResult = await evaluate(cdp, `(async () => {
    const waitFor = async (check, message) => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(message);
    };
    await waitFor(() => document.querySelector('#account-login') && !document.querySelector('#account-login').disabled, 'Configured account UI did not boot');
    document.querySelector('.drawer-link[data-nav-id="history"]').click();
    const guestCount = document.querySelectorAll('#history-list .history-item').length;
    document.querySelector('#account-email').value = 'a@example.com';
    document.querySelector('#account-password').value = 'password';
    document.querySelector('#account-register').click();
    await waitFor(() => document.querySelector('#cloud-status').textContent.includes('Підтвердь email'), 'Email confirmation state missing');
    const confirmationState = document.querySelector('#cloud-status').textContent;
    document.querySelector('#account-reset').click();
    await waitFor(() => document.querySelector('#cloud-status').textContent.includes('відновлення пароля'), 'Password reset state missing');
    const resetState = document.querySelector('#cloud-status').textContent;
    const login = async (email) => {
      document.querySelector('#account-email').value = email;
      document.querySelector('#account-password').value = 'password';
      document.querySelector('#account-login').click();
      await waitFor(() => document.querySelector('#account-summary').textContent.includes(email), 'Account did not sign in: ' + email);
    };
    await login('a@example.com');
    await waitFor(() => !document.querySelector('#transfer-guest-history').hidden, 'Explicit guest transfer action missing');
    const accountBeforeTransfer = document.querySelectorAll('#history-list .history-item').length;
    window.confirm = () => true;
    document.querySelector('#transfer-guest-history').click();
    await waitFor(() => document.querySelectorAll('#history-list .history-item').length === guestCount, 'Guest history was not explicitly transferred');
    const accountAfterTransfer = document.querySelectorAll('#history-list .history-item').length;
    const beforeAccountDelete = accountAfterTransfer;
    document.querySelector('#history-list .history-item .action-danger').click();
    await waitFor(() => document.querySelectorAll('#history-list .history-item').length === beforeAccountDelete - 1, 'Account-only delete failed');
    const accountAfterDelete = document.querySelectorAll('#history-list .history-item').length;
    document.querySelector('#history-list .history-item .action-secondary').click();
    const accountDetailWasVisible = !document.querySelector('#history-detail').hidden && document.querySelector('#history-detail').textContent.length > 0;
    document.querySelector('#account-logout').click();
    await waitFor(() => document.querySelector('#account-summary').textContent.includes('гостьовий'), 'Logout did not switch to guest');
    const guestAfterLogout = document.querySelectorAll('#history-list .history-item').length;
    const accountDetailClearedOnLogout = document.querySelector('#history-detail').hidden && document.querySelector('#history-detail').textContent === '';
    await login('b@example.com');
    const userBBeforeTransfer = document.querySelectorAll('#history-list .history-item').length;
    const dbNames = (await indexedDB.databases()).map((item) => item.name).sort();
    return {
      guestCount,
      accountBeforeTransfer,
      accountAfterTransfer,
      accountAfterDelete,
      accountDetailWasVisible,
      accountDetailClearedOnLogout,
      guestAfterLogout,
      userBBeforeTransfer,
      transferVisibleForB: !document.querySelector('#transfer-guest-history').hidden,
      summary: document.querySelector('#account-summary').textContent,
      cloudStatus: document.querySelector('#cloud-status').textContent,
      confirmationState,
      resetState,
      remoteRows: window.__mockCloudState.rows.size,
      dbNames,
    };
  })()`);

  assert.ok(accountResult.guestCount > 0);
  assert.equal(accountResult.accountBeforeTransfer, 0);
  assert.equal(accountResult.accountAfterTransfer, accountResult.guestCount);
  assert.equal(accountResult.accountAfterDelete, accountResult.accountAfterTransfer - 1);
  assert.equal(accountResult.accountDetailWasVisible, true);
  assert.equal(accountResult.accountDetailClearedOnLogout, true);
  assert.equal(accountResult.guestAfterLogout, accountResult.guestCount);
  assert.equal(accountResult.userBBeforeTransfer, 0);
  assert.equal(accountResult.transferVisibleForB, true);
  assert.match(accountResult.summary, /b@example\.com/);
  assert.match(accountResult.confirmationState, /Підтвердь email/);
  assert.match(accountResult.resetState, /відновлення пароля/);
  assert.ok(accountResult.remoteRows >= 2);
  assert.ok(accountResult.dbNames.includes('workout-program'));
  assert.ok(accountResult.dbNames.includes('workout-program-user-11111111-1111-4111-8111-111111111111'));
  assert.ok(accountResult.dbNames.includes('workout-program-user-22222222-2222-4222-8222-222222222222'));
  assert.deepEqual(cdp.exceptions, []);
  assert.deepEqual(cdp.consoleErrors, []);
  assert.deepEqual(cdp.logErrors, []);
  assert.deepEqual(cdp.httpErrors, []);
  console.log(`PASS browser smoke: ${JSON.stringify({
    guest: result,
    account: accountResult,
    screenshots: [mobileDashboardScreenshot, mobileDrawerScreenshot, desktopDashboardScreenshot, desktopDrawerScreenshot],
  })}`);
  cdp.socket.close();
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (chrome && !chrome.killed) chrome.kill();
  await delay(300);
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}
