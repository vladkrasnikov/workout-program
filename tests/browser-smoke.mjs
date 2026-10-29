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
  chrome = spawn(browser, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    pageUrl,
  ], { stdio: "ignore", windowsHide: true });

  const target = await getDebugTarget(debugPort);
  const cdp = await connectCdp(target.webSocketDebuggerUrl);
  await cdp.send("Runtime.enable");

  const result = await evaluate(cdp, `(async () => {
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
    document.querySelector('#start-workout').click();
    await waitFor(() => document.querySelectorAll('.exercise-log').length === 8, 'Day A forms were not rendered');
    const row = document.querySelector('[data-slot-id="a1"] .set-row');
    const numbers = row.querySelectorAll('input[type="number"]');
    numbers[0].value = '40';
    numbers[0].dispatchEvent(new Event('input', { bubbles: true }));
    numbers[1].value = '12';
    numbers[1].dispatchEvent(new Event('input', { bubbles: true }));
    const completed = row.querySelector('input[type="checkbox"]');
    completed.checked = true;
    completed.dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => document.querySelector('#save-status').textContent === 'Збережено', 'Set was not saved');
    document.querySelector('#finish-workout').click();
    await waitFor(() => !document.querySelector('#start-workout').disabled, 'Workout was not completed');
    document.querySelector('#nav-history').checked = true;
    document.querySelector('#nav-history').dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => document.querySelectorAll('.history-item').length > 0, 'Completed workout missing from history');
    document.querySelector('#nav-workout').checked = true;
    document.querySelector('#nav-workout').dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('#start-workout').click();
    await waitFor(() => document.querySelectorAll('.exercise-log').length === 8, 'Second workout did not start');
    const previous = document.querySelector('[data-slot-id="a1"] .last-result').textContent;
    return {
      forms: document.querySelectorAll('.exercise-log').length,
      historyItems: document.querySelectorAll('.history-item').length,
      previous,
      saveStatus: document.querySelector('#save-status').textContent,
    };
  })()`);

  assert.equal(result.forms, 8);
  assert.ok(result.historyItems > 0);
  assert.match(result.previous, /40.*12/);
  assert.deepEqual(cdp.exceptions, []);
  console.log(`PASS browser smoke: ${JSON.stringify(result)}`);
  cdp.socket.close();
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (chrome && !chrome.killed) chrome.kill();
  await delay(300);
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
}
