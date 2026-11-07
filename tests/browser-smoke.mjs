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

  const readOnlyState = await evaluate(cdp, `(async () => {
    const waitFor = async (check, message) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(message);
    };
    await waitFor(() => document.querySelector('#category-picker')?.options.length === 5
      && document.querySelector('#start-workout')?.disabled
      && !document.querySelector('#history-locked')?.hidden,
    'Read-only catalog did not finish booting');

    const category = document.querySelector('#category-picker');
    category.value = 'performance';
    category.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => document.querySelector('#program-picker')?.value === 'athlete-full-body-3x',
      'Read-only program selection stopped working');

    const openDatabase = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('workout-program');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const readSnapshot = async () => {
      const database = await openDatabase();
      const transaction = database.transaction(['sessions', 'entries'], 'readonly');
      const read = (store, id) => new Promise((resolve, reject) => {
        const request = transaction.objectStore(store).get(id);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const count = (store) => new Promise((resolve, reject) => {
        const request = transaction.objectStore(store).count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const result = await Promise.all([
        read('sessions', 'legacy-session'),
        read('entries', 'legacy-entry'),
        count('sessions'),
        count('entries'),
      ]);
      const version = database.version;
      database.close();
      return { version, session: result[0], entry: result[1], sessions: result[2], entries: result[3] };
    };
    const before = await readSnapshot();

    const start = document.querySelector('#start-workout');
    start.click();
    await new Promise((resolve) => setTimeout(resolve, 100));

    document.querySelector('.drawer-link[data-nav-id="history"]').click();
    await waitFor(() => !document.querySelector('#tab-history').hidden, 'History section did not open');
    const historyState = {
      lockedVisible: !document.querySelector('#history-locked').hidden,
      personalHidden: document.querySelector('#personal-history-content').hidden,
      renderedItems: document.querySelectorAll('#history-list .history-item').length,
      addPastDisabled: document.querySelector('#add-past-workout').disabled,
    };
    document.querySelector('#history-locked .open-account').click();
    await waitFor(() => !document.querySelector('#tab-account').hidden, 'Account CTA did not open');
    const accountState = {
      currentNavigation: document.querySelector('#app-drawer [aria-current="page"]')?.dataset.navId,
      setupVisible: !document.querySelector('#cloud-setup-message').hidden,
      setupText: document.querySelector('#cloud-setup-message').textContent,
      summary: document.querySelector('#account-summary').textContent,
      cloudStatus: document.querySelector('#cloud-status').textContent,
      formDisabled: [...document.querySelector('#account-form').elements].every((control) => control.disabled),
      importLegacyHidden: document.querySelector('#import-legacy-data').hidden,
      backupHidden: document.querySelector('#backup-tools').hidden,
    };
    document.querySelector('.drawer-link[data-nav-id="journal"]').click();
    const after = await readSnapshot();

    return {
      before,
      after,
      startDisabled: start.disabled,
      startText: start.textContent,
      dateDisabled: document.querySelector('#workout-date').disabled,
      finishDisabled: document.querySelector('#finish-workout').disabled,
      sessionHint: document.querySelector('#session-access-hint').textContent,
      forms: document.querySelectorAll('.exercise-log').length,
      inactiveHints: document.querySelectorAll('.inactive-log-hint').length,
      historyState,
      accountState,
      programId: document.querySelector('#program-picker').value,
      categories: document.querySelector('#category-picker').options.length,
      guideItems: document.querySelectorAll('#program-guide-list .program-guide-item').length,
      sessionPosition: getComputedStyle(document.querySelector('.session-card')).position,
      viewportMeta: document.querySelector('meta[name="viewport"]').content,
      mobileControls: ['#category-picker', '#program-picker'].map((selector) => ({
        selector,
        fontSize: Number.parseFloat(getComputedStyle(document.querySelector(selector)).fontSize),
      })),
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      userDatabases: (await indexedDB.databases()).map(({ name }) => name).filter((name) => name?.startsWith('workout-program-user-')),
    };
  })()`);

  assert.equal(readOnlyState.before.version, 1);
  assert.equal(readOnlyState.before.session.id, 'legacy-session');
  assert.equal(readOnlyState.before.session.programId, undefined);
  assert.equal(readOnlyState.before.entry.slotId, 'a1');
  assert.equal(readOnlyState.before.entry.sets[0].loadKg, 35);
  assert.equal(readOnlyState.before.sessions, 1);
  assert.equal(readOnlyState.before.entries, 1);
  assert.deepEqual(readOnlyState.after, readOnlyState.before);
  assert.equal(readOnlyState.startDisabled, true);
  assert.match(readOnlyState.startText, /вхід/i);
  assert.equal(readOnlyState.dateDisabled, true);
  assert.equal(readOnlyState.finishDisabled, true);
  assert.match(readOnlyState.sessionHint, /увійдіть/i);
  assert.equal(readOnlyState.forms, 0);
  assert.ok(readOnlyState.inactiveHints > 0);
  assert.deepEqual(readOnlyState.historyState, {
    lockedVisible: true,
    personalHidden: true,
    renderedItems: 0,
    addPastDisabled: true,
  });
  assert.equal(readOnlyState.accountState.currentNavigation, 'account');
  assert.equal(readOnlyState.accountState.setupVisible, true);
  assert.match(readOnlyState.accountState.setupText, /Supabase/i);
  assert.match(readOnlyState.accountState.summary, /запис тренувань вимкнено/i);
  assert.match(readOnlyState.accountState.cloudStatus, /каталог/i);
  assert.equal(readOnlyState.accountState.formDisabled, true);
  assert.equal(readOnlyState.accountState.importLegacyHidden, true);
  assert.equal(readOnlyState.accountState.backupHidden, true);
  assert.equal(readOnlyState.programId, 'athlete-full-body-3x');
  assert.equal(readOnlyState.categories, 5);
  assert.equal(readOnlyState.guideItems, 5);
  assert.notEqual(readOnlyState.sessionPosition, 'sticky');
  assert.notEqual(readOnlyState.sessionPosition, 'fixed');
  assert.doesNotMatch(readOnlyState.viewportMeta, /maximum-scale|user-scalable/i);
  assert.equal(readOnlyState.mobileControls.every(({ fontSize }) => fontSize >= 16), true);
  assert.equal(readOnlyState.horizontalOverflow, false);
  assert.deepEqual(readOnlyState.userDatabases, []);

  await cdp.send("Page.reload", { ignoreCache: true });
  await delay(300);
  const reloadState = await evaluate(cdp, `(async () => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (document.querySelector('#category-picker')?.options.length === 5
        && document.querySelectorAll('#program-guide-list .program-guide-item').length === 5
        && document.querySelector('#start-workout')?.disabled) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open('workout-program');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction(['sessions', 'entries'], 'readonly');
    const count = (store) => new Promise((resolve, reject) => {
      const request = transaction.objectStore(store).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [sessions, entries] = await Promise.all([count('sessions'), count('entries')]);
    database.close();
    return {
      categories: document.querySelector('#category-picker').options.length,
      guideItems: document.querySelectorAll('#program-guide-list .program-guide-item').length,
      startDisabled: document.querySelector('#start-workout').disabled,
      historyLocked: !document.querySelector('#history-locked').hidden,
      personalHistoryHidden: document.querySelector('#personal-history-content').hidden,
      sessions,
      entries,
    };
  })()`);
  assert.deepEqual(reloadState, {
    categories: 5,
    guideItems: 5,
    startDisabled: true,
    historyLocked: true,
    personalHistoryHidden: true,
    sessions: 1,
    entries: 1,
  });

  assert.deepEqual(cdp.exceptions, []);
  assert.deepEqual(cdp.consoleErrors, []);
  assert.deepEqual(cdp.logErrors, []);
  assert.deepEqual(cdp.httpErrors, []);
  console.log(`PASS browser smoke: ${JSON.stringify({
    readOnly: readOnlyState,
    reload: reloadState,
    screenshots: [mobileDashboardScreenshot, mobileDrawerScreenshot, desktopDashboardScreenshot, desktopDrawerScreenshot],
  })}`);
  cdp.socket.close();
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (chrome && !chrome.killed) chrome.kill();
  await delay(300);
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}
