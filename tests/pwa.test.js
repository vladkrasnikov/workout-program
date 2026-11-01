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

test("default cloud config is guest-safe and contains no service role credential", async () => {
  const source = await readFile(resolve(root, "js/cloud-config.js"), "utf8");
  assert.match(source, /supabaseUrl:\s*""/);
  assert.match(source, /supabasePublishableKey:\s*""/);
  assert.doesNotMatch(source, /service_role\s*:/i);
});
