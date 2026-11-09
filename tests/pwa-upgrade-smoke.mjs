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
const MIME = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
]);
const modes = new Map([["broken", "legacy"], ["fixed", "legacy"], ["failure", "current"]]);
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

const legacyIndex = `<!doctype html>
<html><head><meta charset="utf-8"><script type="module" src="./js/app.js"></script></head>
<body><main id="legacy-root">Legacy shell</main><script>navigator.serviceWorker.register('./sw.js');</script></body></html>`;
const ungatedIndex = `<!doctype html>
<html><head><meta charset="utf-8"><script type="module" src="./js/app.js"></script></head>
<body><select id="category-picker"></select><select id="program-picker"></select>
<div id="program-summary"></div><div id="program-guide-list"></div></body></html>`;
const legacyApp = `document.getElementById("legacy-root").textContent = "Legacy app ready";`;
const legacyWorker = (scope) => `
const CACHE = "legacy-mixed-shell-${scope}";
const BASE = new URL("./", self.location.href);
self.addEventListener("install", (event) => event.waitUntil(
  caches.open(CACHE).then((cache) => cache.addAll(["./", "./index.html", "./js/app.js"].map((path) => new URL(path, BASE))))
));
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("message", (event) => { if (event.data?.type === "APPLY_UPDATE") self.skipWaiting(); });
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    event.respondWith(fetch(event.request).catch(() => caches.match(new URL("./index.html", BASE))));
    return;
  }
  event.respondWith(caches.match(event.request).then((cached) => {
    const refreshed = fetch(event.request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(event.request, response.clone()));
      return response;
    });
    return cached || refreshed;
  }));
});`;

function makeServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, `http://${HOST}`);
      const parts = url.pathname.split("/").filter(Boolean);
      const scope = parts.shift();
      if (!modes.has(scope)) throw new Error("Unknown test scope");
      const relative = parts.join("/") || "index.html";
      const mode = modes.get(scope);
      response.setHeader("cache-control", "no-store");

      if (mode === "legacy") {
        if (relative === "index.html") {
          response.setHeader("content-type", "text/html; charset=utf-8");
          return void response.end(legacyIndex);
        }
        if (relative === "sw.js") {
          response.setHeader("content-type", "text/javascript; charset=utf-8");
          return void response.end(legacyWorker(scope));
        }
        if (relative === "js/app.js") {
          response.setHeader("content-type", "text/javascript; charset=utf-8");
          return void response.end(legacyApp);
        }
        throw new Error("Missing legacy fixture");
      }
      if (mode === "broken" && relative === "index.html") {
        response.setHeader("content-type", "text/html; charset=utf-8");
        return void response.end(ungatedIndex);
      }
      if (mode === "broken" && relative === "sw.js") {
        response.setHeader("content-type", "text/javascript; charset=utf-8");
        return void response.end(legacyWorker(scope));
      }
      if (scope === "failure" && relative === "js/app.js") {
        response.writeHead(503, { "content-type": "text/javascript; charset=utf-8" });
        response.end("Module unavailable");
        return;
      }
      if (mode === "incompatible" && relative === "js/app.js") {
        response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
        response.end("globalThis.__INCOMPATIBLE_FUTURE_APP_RAN__ = true; throw new Error('incompatible future app reached the old shell')");
        return;
      }

      if (relative === 'js/cloud-config.js') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        response.end('export default {supabaseUrl:"",supabasePublishableKey:""};');
        return;
      }

      const safeRelative = normalize(relative).replace(/^[/\\]+/, "");
      const filename = join(ROOT, safeRelative);
      if (!filename.startsWith(ROOT)) throw new Error("Invalid path");
      const info = await stat(filename);
      if (!info.isFile()) throw new Error("Not a file");
      response.setHeader("content-type", MIME.get(extname(filename)) ?? "application/octet-stream");
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

async function getTarget(port) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const targets = await (await fetch(`http://${HOST}:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === "page" && target.url.startsWith("http://"));
      if (page) return page;
    } catch { /* Browser is starting. */ }
    await delay(100);
  }
  throw new Error("Browser target did not start");
}

async function connectCdp(url, origin) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const errors = [];
  const failedRequests = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Runtime.exceptionThrown") {
      errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    }
    if (message.method === "Runtime.consoleAPICalled" && message.params.type === "error") {
      errors.push(message.params.args.map((item) => item.value ?? item.description ?? "error").join(" "));
    }
    if (message.method === "Network.responseReceived") {
      const response = message.params.response;
      if (response.url.startsWith(origin) && response.status >= 400) failedRequests.push(`${response.status} ${response.url}`);
    }
    if (message.method === "Network.loadingFailed") failedRequests.push(message.params.errorText);
    if (!message.id || !pending.has(message.id)) return;
    const handlers = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) handlers.reject(new Error(message.error.message));
    else handlers.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  return { socket, send, errors, failedRequests };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(cdp, expression, message, attempts = 120) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await evaluate(cdp, expression)) return;
    await delay(100);
  }
  throw new Error(message);
}

const browser = findBrowser();
if (!browser) {
  console.log("SKIP PWA upgrade smoke: Chrome/Edge not found");
  process.exit(0);
}

const server = makeServer();
const profile = await mkdtemp(join(tmpdir(), "workout-pwa-upgrade-"));
const debugPort = await findFreePort();
let chrome;

try {
  const sitePort = await listen(server);
  const origin = `http://${HOST}:${sitePort}`;
  chrome = spawn(browser, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, `${origin}/broken/`,
  ], { stdio: "ignore", windowsHide: true });
  const target = await getTarget(debugPort);
  const cdp = await connectCdp(target.webSocketDebuggerUrl, origin);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");

  await waitFor(cdp, "navigator.serviceWorker?.controller && document.querySelector('#legacy-root')?.textContent === 'Legacy app ready'", "Legacy broken shell did not take control");
  modes.set("broken", "broken");
  const brokenErrorStart = cdp.errors.length;
  await cdp.send("Page.navigate", { url: `${origin}/broken/` });
  await waitFor(cdp, "document.readyState === 'complete' && document.querySelector('#category-picker')", "Ungated mixed page did not load");
  await delay(300);
  const reproduction = await evaluate(cdp, `({
    categories: document.querySelector('#category-picker').options.length,
    programs: document.querySelector('#program-picker').options.length,
    summary: document.querySelector('#program-summary').textContent,
    guide: document.querySelector('#program-guide-list').textContent,
  })`);
  const reproductionErrors = cdp.errors.slice(brokenErrorStart);
  assert.deepEqual(reproduction, { categories: 0, programs: 0, summary: "", guide: "" });
  assert.ok(reproductionErrors.some((message) => /legacy-root|textContent/i.test(message)), "Mixed-version reproduction must capture the stale module error");

  await cdp.send("Page.navigate", { url: `${origin}/fixed/` });
  await waitFor(cdp, "document.querySelector('#legacy-root')?.textContent === 'Legacy app ready'", "Legacy fixed shell did not load");
  await waitFor(cdp, "navigator.serviceWorker?.controller?.scriptURL.includes('/fixed/sw.js')", "Legacy fixed worker did not control the page");
  modes.set("fixed", "current");
  const fixedErrorStart = cdp.errors.length;
  const fixedFailureStart = cdp.failedRequests.length;
  await cdp.send("Page.navigate", { url: `${origin}/fixed/` });
  await waitFor(cdp, "!document.querySelector('#boot-diagnostic')?.hidden && document.querySelector('#boot-diagnostic-action')?.textContent.includes('Застосувати')", "Version gate did not offer the coherent update");
  const gateMessage = await evaluate(cdp, "document.querySelector('#boot-diagnostic-message').textContent");
  await evaluate(cdp, "document.querySelector('#boot-diagnostic-action').click()");
  try {
    await waitFor(cdp, "document.querySelector('#category-picker')?.options.length === 5 && document.querySelectorAll('#program-guide-list .program-guide-item').length === 5", "Catalog did not recover after atomic update");
  } catch (error) {
    const state = await evaluate(cdp, `(async () => {
      const versionCache = await caches.open('workout-program-shell-v8');
      return {
        href: location.href,
        controller: navigator.serviceWorker.controller?.scriptURL,
        diagnostic: document.querySelector('#boot-diagnostic-message')?.textContent,
        action: document.querySelector('#boot-diagnostic-action')?.textContent,
        categories: document.querySelector('#category-picker')?.options.length,
        caches: await caches.keys(),
        versionEntries: (await versionCache.keys()).map((request) => request.url),
      };
    })()`);
    console.error("PWA recovery state", state, cdp.errors, cdp.failedRequests);
    throw error;
  }

  const recovered = await evaluate(cdp, `({
    categories: [...document.querySelector('#category-picker').options].map((item) => [item.value, item.textContent]),
    programs: [...document.querySelector('#program-picker').options].map((item) => [item.value, item.textContent]),
    summary: document.querySelector('#program-summary').textContent,
    guideCount: document.querySelectorAll('#program-guide-list .program-guide-item').length,
    diagnosticHidden: document.querySelector('#boot-diagnostic').hidden,
  })`);
  const controllerInfo = await evaluate(cdp, `new Promise((resolve) => {
    const channel = new MessageChannel();
    channel.port1.onmessage = (event) => resolve(event.data);
    navigator.serviceWorker.controller.postMessage({ type: 'GET_BUILD_VERSION' }, [channel.port2]);
  })`);
  const fixedErrors = cdp.errors.slice(fixedErrorStart);
  const fixedFailures = cdp.failedRequests.slice(fixedFailureStart);
  assert.equal(recovered.categories.length, 5);
  assert.ok(recovered.programs.length > 0);
  assert.match(recovered.summary, /Для кого:/);
  assert.equal(recovered.guideCount, 5);
  assert.equal(recovered.diagnosticHidden, true);
  assert.deepEqual(controllerInfo, {
    type: "BUILD_VERSION",
    build: "v8",
    shellPolicy: "cache-only",
    baseUrl: `${origin}/fixed/`,
  });
  assert.deepEqual(fixedErrors, []);
  assert.deepEqual(fixedFailures, []);
  assert.match(gateMessage, /несумісні версії/);

  await cdp.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await cdp.send("Page.reload");
  await waitFor(cdp, "document.querySelector('#category-picker')?.options.length === 5 && document.querySelectorAll('#program-guide-list .program-guide-item').length === 5", "Versioned shell did not remain populated offline");
  const offline = await evaluate(cdp, `({
    categories: document.querySelector('#category-picker').options.length,
    programs: document.querySelector('#program-picker').options.length,
    guideCount: document.querySelectorAll('#program-guide-list .program-guide-item').length,
    diagnosticHidden: document.querySelector('#boot-diagnostic').hidden,
  })`);
  assert.deepEqual(offline, { categories: 5, programs: 1, guideCount: 5, diagnosticHidden: true });

  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  const deletedShellModule = await evaluate(cdp, `caches.open('workout-program-shell-v8').then((cache) => cache.delete(new URL('./js/app.js', location.href)))`);
  assert.equal(deletedShellModule, true, "Test must remove the cached v8 app module");
  modes.set("fixed", "incompatible");
  await cdp.send("Page.reload");
  await waitFor(cdp, "!document.querySelector('#boot-diagnostic')?.hidden && /модулі застосунку/i.test(document.querySelector('#boot-diagnostic-message')?.textContent)", "Corrupted shell did not stop at a visible diagnostic");
  const corruptedShell = await evaluate(cdp, `({
    message: document.querySelector('#boot-diagnostic-message').textContent,
    action: document.querySelector('#boot-diagnostic-action').textContent,
    categories: document.querySelector('#category-picker').options.length,
  })`);
  const incompatibleModuleRan = await evaluate(cdp, "globalThis.__INCOMPATIBLE_FUTURE_APP_RAN__ === true");
  assert.equal(incompatibleModuleRan, false, "Missing v8 shell module must never execute the future network asset");
  assert.match(corruptedShell.message, /не вдалося завантажити модулі/i);
  assert.equal(corruptedShell.action, "Спробувати ще раз");
  assert.equal(corruptedShell.categories, 0);

  await cdp.send("Page.navigate", { url: `${origin}/failure/` });
  await waitFor(cdp, "!document.querySelector('#boot-diagnostic')?.hidden && document.querySelector('#boot-diagnostic-action')", "Module failure was not exposed as a visible retry state");
  const failureDiagnostic = await evaluate(cdp, `({
    message: document.querySelector('#boot-diagnostic-message').textContent,
    action: document.querySelector('#boot-diagnostic-action').textContent,
    categories: document.querySelector('#category-picker').options.length,
  })`);
  assert.match(failureDiagnostic.message, /не вдалося завантажити модулі/i);
  assert.equal(failureDiagnostic.action, "Спробувати ще раз");
  assert.equal(failureDiagnostic.categories, 0);

  console.log(`PASS PWA upgrade smoke: ${JSON.stringify({ reproduction, reproductionErrors, gateMessage, recovered, controllerInfo, offline, corruptedShell, failureDiagnostic })}`);
  cdp.socket.close();
} finally {
  if (chrome && chrome.exitCode === null) {
    const exited = new Promise((resolve) => chrome.once("exit", resolve));
    chrome.kill();
    await Promise.race([exited, delay(5000)]);
  }
  await new Promise((resolve) => server.close(resolve));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(profile, { recursive: true, force: true });
      break;
    } catch (error) {
      if (error.code !== "EBUSY" || attempt === 4) throw error;
      await delay(200);
    }
  }
}
