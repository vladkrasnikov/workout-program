import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOST = "127.0.0.1";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
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

function completedSession(id, label, date) {
  return {
    id,
    programId: "athlete-full-body-3x",
    dayId: "athlete-day-a",
    programNameSnapshot: label,
    dayNameSnapshot: "День A",
    status: "completed",
    workoutDate: date,
    performedAt: `${date}T12:00:00.000Z`,
    createdAt: `${date}T12:00:00.000Z`,
    completedAt: `${date}T13:00:00.000Z`,
    revision: 1,
    updatedAt: `${date}T13:00:00.000Z`,
  };
}

function findBrowser() {
  return [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].find((candidate) => candidate && existsSync(candidate));
}

function makeServer() {
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

async function freePort() {
  const probe = createServer();
  const port = await listen(probe);
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function debugTarget(port) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://${HOST}:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.url.startsWith("http://"));
      if (page) return page;
    } catch { /* Browser is still starting. */ }
    await delay(100);
  }
  throw new Error("Browser debug target did not start");
}

async function connect(webSocketDebuggerUrl) {
  const socket = new WebSocket(webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      errors.push(message.params.args.map((argument) => argument.value ?? argument.description ?? "").join(" "));
    }
    if (!message.id || !pending.has(message.id)) return;
    const handler = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handler.reject(new Error(message.error.message));
    else handler.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  return { socket, send, errors };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

const browser = findBrowser();
if (!browser) {
  console.log("SKIP account access smoke: Chrome/Edge not found");
  process.exit(0);
}

const server = makeServer();
const profile = await mkdtemp(join(tmpdir(), "workout-account-smoke-"));
const port = await listen(server);
const debugPort = await freePort();
const pageUrl = `http://${HOST}:${port}/`;
const seedUrl = `http://${HOST}:${port}/__account_seed__`;
let chrome;

try {
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

  const target = await debugTarget(debugPort);
  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });

  await cdp.send("Page.navigate", { url: seedUrl });
  await delay(150);
  const legacy = completedSession("legacy-local-session", "Legacy Local — must be explicit", "2026-01-10");
  const seeded = await evaluate(cdp, `(async () => {
    const request = indexedDB.open('workout-program', 2);
    const database = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const db = request.result;
        const sessions = db.createObjectStore('sessions', { keyPath: 'id' });
        sessions.createIndex('by-workout-date', 'workoutDate');
        sessions.createIndex('by-status', 'status');
        sessions.createIndex('by-performed-at', 'performedAt');
        sessions.createIndex('by-program', 'programId');
        const entries = db.createObjectStore('entries', { keyPath: 'id' });
        entries.createIndex('by-session', 'sessionId');
        entries.createIndex('by-exercise', ['exerciseId', 'variantId', 'equipmentKey']);
        entries.createIndex('unique-session-slot', ['sessionId', 'slotId'], { unique: true });
        db.createObjectStore('settings', { keyPath: 'key' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = database.transaction(['sessions', 'settings'], 'readwrite');
    tx.objectStore('sessions').put(${JSON.stringify(legacy)});
    tx.objectStore('settings').put({ key: 'currentProgramId', value: 'athlete-full-body-3x' });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    database.close();
    return true;
  })()`);
  assert.equal(seeded, true);

  await cdp.send("Page.navigate", { url: pageUrl });
  await delay(500);
  const noConfig = await evaluate(cdp, `(async () => {
    const waitFor = async (check, message) => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(message);
    };
    await waitFor(() => document.querySelector('#category-picker')?.options.length === 5, 'Catalog did not boot');
    document.querySelector('.drawer-link[data-nav-id="account"]')?.click();
    return {
      categories: document.querySelector('#category-picker').options.length,
      guidePrograms: document.querySelectorAll('#program-guide-list .program-guide-item').length,
      startDisabled: document.querySelector('#start-workout').disabled,
      addPastDisabled: document.querySelector('#add-past-workout').disabled,
      exportDisabled: document.querySelector('#export-backup').disabled,
      importDisabled: document.querySelector('#import-backup').disabled,
      historyCount: document.querySelectorAll('#history-list .history-item').length,
      account: document.querySelector('#account-summary').textContent,
      status: document.querySelector('#cloud-status').textContent,
      loginDisabled: document.querySelector('#account-login').disabled,
    };
  })()`);
  assert.equal(noConfig.categories, 5);
  assert.equal(noConfig.guidePrograms, 5);
  assert.equal(noConfig.startDisabled, true);
  assert.equal(noConfig.addPastDisabled, true);
  assert.equal(noConfig.exportDisabled, true);
  assert.equal(noConfig.importDisabled, true);
  assert.equal(noConfig.historyCount, 0, "Legacy anonymous data must not be exposed as personal history");
  assert.equal(noConfig.loginDisabled, true);
  assert.doesNotMatch(noConfig.account, /гостьов/i);
  assert.match(`${noConfig.account} ${noConfig.status}`, /налашт|адміністратор|Supabase/i);

  const remoteA = completedSession("remote-a-session", "Cloud A — authoritative", "2026-02-20");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: `
    (() => {
      const userA = { id: ${JSON.stringify(USER_A)}, email: 'a@example.com' };
      const userB = { id: ${JSON.stringify(USER_B)}, email: 'b@example.com' };
      const users = new Map([[userA.email, userA], [userB.email, userB]]);
      const empty = () => ({ sessions: [], entries: [], settings: [] });
      const state = { session: null, listeners: [], writes: 0, rows: new Map() };
      state.rows.set(userA.id, {
        user_id: userA.id,
        snapshot: { sessions: [${JSON.stringify(remoteA)}], entries: [], settings: [] },
        revision: 4,
        updated_at: 'mock-4',
      });
      const notify = (event) => state.listeners.forEach((callback) => callback(event, state.session));
      const client = {
        auth: {
          getSession: async () => ({ data: { session: state.session }, error: null }),
          onAuthStateChange: (callback) => {
            state.listeners.push(callback);
            return { data: { subscription: { unsubscribe() {} } } };
          },
          signInWithPassword: async ({ email }) => {
            const user = users.get(email);
            if (!user) return { data: null, error: new Error('Unknown mock user') };
            state.session = { user };
            notify('SIGNED_IN');
            return { data: { user, session: state.session }, error: null };
          },
          signUp: async ({ email }) => ({ data: { user: users.get(email) ?? null, session: null }, error: null }),
          signOut: async () => {
            state.session = null;
            notify('SIGNED_OUT');
            return { error: null };
          },
          resetPasswordForEmail: async () => ({ error: null }),
          updateUser: async () => ({ data: { user: state.session?.user ?? null }, error: null }),
        },
        from() {
          const query = { operation: 'read', payload: null, filters: {} };
          const builder = {
            select() { return builder; },
            eq(column, value) { query.filters[column] = value; return builder; },
            insert(payload) { query.operation = 'insert'; query.payload = payload; return builder; },
            update(payload) { query.operation = 'update'; query.payload = payload; return builder; },
            async maybeSingle() {
              const current = state.rows.get(query.filters.user_id) ?? null;
              if (query.operation === 'update') {
                if (!current || current.revision !== query.filters.revision) return { data: null, error: null };
                const next = { ...current, ...query.payload, updated_at: 'mock-' + query.payload.revision };
                state.rows.set(query.filters.user_id, next);
                state.writes += 1;
                return { data: next, error: null };
              }
              return { data: current, error: null };
            },
            async single() {
              if (query.operation !== 'insert') return { data: null, error: new Error('Unexpected mock single') };
              const row = { ...query.payload, snapshot: query.payload.snapshot ?? empty(), updated_at: 'mock-' + query.payload.revision };
              state.rows.set(row.user_id, row);
              state.writes += 1;
              return { data: row, error: null };
            },
          };
          return builder;
        },
      };
      window.__mockAccountCloud = state;
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
  await delay(500);

  const configuredUnauth = await evaluate(cdp, `(async () => {
    const waitFor = async (check, message) => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(message);
    };
    await waitFor(() => document.querySelector('#account-login') && !document.querySelector('#account-login').disabled, 'Configured auth did not boot');
    document.querySelector('.drawer-link[data-nav-id="history"]')?.click();
    return {
      historyCount: document.querySelectorAll('#history-list .history-item').length,
      startDisabled: document.querySelector('#start-workout').disabled,
      addPastDisabled: document.querySelector('#add-past-workout').disabled,
      exportDisabled: document.querySelector('#export-backup').disabled,
      importDisabled: document.querySelector('#import-backup').disabled,
      account: document.querySelector('#account-summary').textContent,
      catalogPrograms: document.querySelector('#program-picker').options.length,
    };
  })()`);
  assert.equal(configuredUnauth.historyCount, 0);
  assert.equal(configuredUnauth.startDisabled, true);
  assert.equal(configuredUnauth.addPastDisabled, true);
  assert.equal(configuredUnauth.exportDisabled, true);
  assert.equal(configuredUnauth.importDisabled, true);
  assert.doesNotMatch(configuredUnauth.account, /гостьов/i);
  assert.ok(configuredUnauth.catalogPrograms > 0);

  const account = await evaluate(cdp, `(async () => {
    const waitFor = async (check, message) => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(message);
    };
    const openAccount = () => document.querySelector('.drawer-link[data-nav-id="account"]')?.click();
    const openHistory = () => document.querySelector('.drawer-link[data-nav-id="history"]')?.click();
    const login = async (email) => {
      openAccount();
      document.querySelector('#account-email').value = email;
      document.querySelector('#account-password').value = 'password';
      document.querySelector('#account-login').click();
      await waitFor(() => document.querySelector('#account-summary').textContent.includes(email), 'Login failed for ' + email);
    };
    await login('a@example.com');
    openHistory();
    await waitFor(() => document.querySelectorAll('#history-list .history-item').length === 1, 'Cloud A history did not load authoritatively');
    const beforeImportText = document.querySelector('#history-list').textContent;
    const importButton = document.querySelector('#import-legacy-data');
    await waitFor(() => !importButton.hidden, 'Explicit legacy import action missing');
    const importLabel = importButton.textContent;
    window.confirm = () => true;
    const writesBeforeImport = window.__mockAccountCloud.writes;
    importButton.click();
    await waitFor(() => document.querySelectorAll('#history-list .history-item').length === 2, 'Explicit legacy import did not finish');
    const rowAfterImport = structuredClone(window.__mockAccountCloud.rows.get(${JSON.stringify(USER_A)}));
    const writesAfterImport = window.__mockAccountCloud.writes;
    importButton.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const writesAfterRepeatedImport = window.__mockAccountCloud.writes;
    const markerCount = rowAfterImport.snapshot.settings.filter((item) => item.key === 'cloudLegacyImportV1').length;

    document.querySelector('#account-logout').click();
    await waitFor(() => !document.querySelector('#account-summary').textContent.includes('a@example.com'), 'A did not log out');
    const hiddenAfterLogout = {
      history: document.querySelectorAll('#history-list .history-item').length,
      startDisabled: document.querySelector('#start-workout').disabled,
      legacyVisible: /Legacy Local/.test(document.body.textContent),
    };

    await login('b@example.com');
    openHistory();
    await waitFor(() => window.__mockAccountCloud.rows.has(${JSON.stringify(USER_B)}), 'Empty B cloud row was not initialized');
    const bInitial = {
      history: document.querySelectorAll('#history-list .history-item').length,
      remoteSessions: window.__mockAccountCloud.rows.get(${JSON.stringify(USER_B)}).snapshot.sessions.length,
    };
    document.querySelector('.drawer-link[data-nav-id="journal"]')?.click();
    await waitFor(() => !document.querySelector('#start-workout').disabled, 'Signed-in journal is not writable');
    return {
      beforeImportText,
      importLabel,
      writesBeforeImport,
      writesAfterImport,
      writesAfterRepeatedImport,
      importedSessions: rowAfterImport.snapshot.sessions.map((session) => session.id).sort(),
      markerCount,
      hiddenAfterLogout,
      bInitial,
    };
  })()`);

  assert.match(account.beforeImportText, /Cloud A — authoritative/);
  assert.doesNotMatch(account.beforeImportText, /Legacy Local/);
  assert.match(account.importLabel, /Імпортувати старі локальні дані/i);
  assert.ok(account.writesAfterImport > account.writesBeforeImport);
  assert.equal(account.writesAfterRepeatedImport, account.writesAfterImport, "Legacy import must be idempotent");
  assert.deepEqual(account.importedSessions, ["legacy-local-session", "remote-a-session"]);
  assert.equal(account.markerCount, 1);
  assert.deepEqual(account.hiddenAfterLogout, { history: 0, startDisabled: true, legacyVisible: false });
  assert.deepEqual(account.bInitial, { history: 0, remoteSessions: 0 });

  await cdp.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  const offlinePending = await evaluate(cdp, `(async () => {
    const waitFor = async (check, message) => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(message);
    };
    window.dispatchEvent(new Event('offline'));
    document.querySelector('#start-workout').click();
    await waitFor(() => /очікує синхронізації|офлайн/i.test(document.querySelector('#cloud-status').textContent + ' ' + document.querySelector('#save-status').textContent), 'Offline pending status missing');
    window.confirm = () => false;
    document.querySelector('#account-logout').click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    return {
      logoutBlocked: document.querySelector('#account-summary').textContent.includes('b@example.com'),
      status: document.querySelector('#cloud-status').textContent + ' ' + document.querySelector('#save-status').textContent,
    };
  })()`);
  assert.equal(offlinePending.logoutBlocked, true, "Logout must not silently abandon pending cloud writes");
  assert.match(offlinePending.status, /вихід скасовано|очікує синхронізації|офлайн/i);

  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await evaluate(cdp, "window.dispatchEvent(new Event('online'))");
  const reconnect = await evaluate(cdp, `(async () => {
    const waitFor = async (check, message) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (check()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error(message);
    };
    await waitFor(() => window.__mockAccountCloud.rows.get(${JSON.stringify(USER_B)})?.snapshot.sessions.length === 1, 'Pending B workout did not sync after reconnect');
    await waitFor(() => /хмар|синхроніз|збережено/i.test(document.querySelector('#cloud-status').textContent), 'Cloud saved status missing after reconnect');
    const bWorkoutId = window.__mockAccountCloud.rows.get(${JSON.stringify(USER_B)}).snapshot.sessions[0].id;
    document.querySelector('#finish-workout').click();
    await waitFor(() => window.__mockAccountCloud.rows.get(${JSON.stringify(USER_B)}).snapshot.sessions[0]?.status === 'completed', 'Finishing workout did not await cloud persistence');
    await waitFor(() => /хмар/i.test(document.querySelector('#save-status').textContent + ' ' + document.querySelector('#cloud-status').textContent), 'Finished workout did not report cloud persistence');
    document.querySelector('.drawer-link[data-nav-id="history"]')?.click();
    await waitFor(() => document.querySelectorAll('#history-list .history-item').length === 1, 'Completed B workout missing from history');
    window.confirm = () => true;
    document.querySelector('#history-list .history-item .action-danger').click();
    await waitFor(() => window.__mockAccountCloud.rows.get(${JSON.stringify(USER_B)}).snapshot.sessions.length === 0,
      'Delete did not await cloud persistence: ' + JSON.stringify({
        remote: window.__mockAccountCloud.rows.get(${JSON.stringify(USER_B)}),
        cloudStatus: document.querySelector('#cloud-status').textContent,
        saveStatus: document.querySelector('#save-status').textContent,
        history: document.querySelector('#history-list').textContent,
        syncMeta: localStorage.getItem('workout-program:cloud-sync:' + ${JSON.stringify(USER_B)}),
      }));
    await waitFor(() => document.querySelectorAll('#history-list .history-item').length === 0, 'Deleted B workout remained visible');
    window.confirm = () => true;
    document.querySelector('#account-logout').click();
    await waitFor(() => !document.querySelector('#account-summary').textContent.includes('b@example.com'), 'B did not log out after sync');
    document.querySelector('.drawer-link[data-nav-id="account"]')?.click();
    document.querySelector('#account-email').value = 'a@example.com';
    document.querySelector('#account-password').value = 'password';
    document.querySelector('#account-login').click();
    await waitFor(() => document.querySelector('#account-summary').textContent.includes('a@example.com'), 'A did not sign back in');
    document.querySelector('.drawer-link[data-nav-id="history"]')?.click();
    await waitFor(() => document.querySelectorAll('#history-list .history-item').length === 2, 'A history changed after B sync');
    return {
      aHistory: document.querySelector('#history-list').textContent,
      aRemoteSessions: window.__mockAccountCloud.rows.get(${JSON.stringify(USER_A)}).snapshot.sessions.map((session) => session.id).sort(),
      bWorkoutId,
      bRemoteSessionsAfterDelete: window.__mockAccountCloud.rows.get(${JSON.stringify(USER_B)}).snapshot.sessions.map((session) => session.id),
    };
  })()`);
  assert.match(reconnect.aHistory, /Cloud A — authoritative/);
  assert.match(reconnect.aHistory, /Legacy Local/);
  assert.deepEqual(reconnect.aRemoteSessions, ["legacy-local-session", "remote-a-session"]);
  assert.deepEqual(reconnect.bRemoteSessionsAfterDelete, []);
  assert.ok(!reconnect.aRemoteSessions.includes(reconnect.bWorkoutId), "Account B data leaked into A");
  assert.deepEqual(cdp.errors, []);

  console.log(`PASS account access smoke: ${JSON.stringify({ noConfig, configuredUnauth, account, reconnect })}`);
  cdp.socket.close();
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (chrome && !chrome.killed) chrome.kill();
  await delay(300);
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}
