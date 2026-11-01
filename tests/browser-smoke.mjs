import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOST = "127.0.0.1";
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
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params.exceptionDetails.text);
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
  return { socket, send, exceptions };
}

async function evaluate(cdp, expression) {
  const response = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text);
  return response.result.value;
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
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });

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
  await cdp.send("Page.navigate", { url: pageUrl });
  await delay(300);

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
    document.querySelector('label[for="nav-history"]').click();
    await waitFor(() => document.querySelectorAll('.history-item').length >= 2, 'Migrated and completed workouts missing from history');
    const historyText = document.querySelector('#history-list').textContent;
    document.querySelector('label[for="nav-journal"]').click();

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
    document.querySelector('label[for="nav-history"]').click();
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
    document.querySelector('label[for="nav-journal"]').click();
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
  assert.deepEqual(cdp.exceptions, []);
  console.log(`PASS browser smoke: ${JSON.stringify(result)}`);
  cdp.socket.close();
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (chrome && !chrome.killed) chrome.kill();
  await delay(300);
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}
