import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("PWA app shell contains every local resource and cloud integration module", async () => {
  const source = await readFile(resolve(root, "sw.js"), "utf8");
  const paths = [...source.matchAll(/"(\.\/[^"?]+)"/g)].map((match) => match[1]);
  for (const path of paths.filter((item) => item !== "./")) await access(resolve(root, path.slice(2)));
  for (const required of ["./js/auth.js", "./js/cloud-config.js", "./js/cloud-sync.js"]) {
    assert.ok(paths.includes(required), `${required} must be cached`);
  }
  assert.doesNotMatch(source.match(/const APP_SHELL = \[[\s\S]*?\];/)?.[0] ?? "", /https?:\/\//);
});

test("PWA shell is version-consistent and exposes its build to the boot gate", async () => {
  const [worker, html] = await Promise.all([
    readFile(resolve(root, "sw.js"), "utf8"),
    readFile(resolve(root, "index.html"), "utf8"),
  ]);
  const workerBuild = worker.match(/const CACHE_VERSION = "([^"]+)"/)?.[1];
  const documentBuild = html.match(/<meta name="workout-app-build" content="([^"]+)">/)?.[1];
  assert.ok(workerBuild, "service worker build must be declared");
  assert.equal(documentBuild, workerBuild, "document and service worker builds must match");
  assert.match(worker, /GET_BUILD_VERSION/);
  assert.match(worker, /cache\.match\(INDEX_URL\)/);
  assert.match(worker, /const APP_SHELL_BY_PATH = new Map/);
  assert.match(worker, /const missingShellResponse = \(\) => new Response[\s\S]*?status: 503/);
  assert.match(worker, /const shellUrl = APP_SHELL_BY_PATH\.get\(requestUrl\.pathname\)[\s\S]*?cache\.match\(shellUrl\)[\s\S]*?missingShellResponse\(\)/);
  assert.doesNotMatch(worker, /cache\.put\(INDEX_URL/);
  assert.doesNotMatch(worker, /return cached \|\| refreshed/);
  assert.doesNotMatch(html, /<script\s+type="module"\s+src="\.\/js\/app\.js"/);
  assert.match(html, /import\("\.\/js\/app\.js"\)/);
  assert.match(html, /id="boot-diagnostic"/);
  assert.match(html, /<noscript>/);
});

test("default cloud config is guest-safe and contains no service role credential", async () => {
  const source = await readFile(resolve(root, "js/cloud-config.js"), "utf8");
  assert.match(source, /supabaseUrl:\s*""/);
  assert.match(source, /supabasePublishableKey:\s*""/);
  assert.doesNotMatch(source, /service_role\s*:/i);
});
