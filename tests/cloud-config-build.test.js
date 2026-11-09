import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("Pages configuration ships public values and rejects privileged or incomplete credentials", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workout-config-"));
  const output = join(directory, "cloud-config.js");
  const run = (url, key) => spawnSync(process.execPath, ["scripts/configure-cloud.mjs", output], {
    env: { ...process.env, SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: key, SUPABASE_REDIRECT_URL: "https://example.com/workout/" },
    encoding: "utf8",
  });
  try {
    assert.equal(run("", "").status, 0);
    assert.equal(run("https://example.supabase.co", "sb_publishable_test").status, 0);
    const config = await readFile(output, "utf8");
    assert.match(config, /sb_publishable_test/);
    assert.match(config, /https:\/\/example.com\/workout\//);
    const jwt = role => `header.${Buffer.from(JSON.stringify({ role })).toString("base64url")}.signature`;
    for (const key of ["sb_secret_test", jwt("service_role"), "", "arbitrary-key"]) {
      assert.notEqual(run("https://example.supabase.co", key).status, 0);
      assert.equal(await readFile(output, "utf8"), config, "Invalid configuration must not overwrite public output");
    }
    assert.equal(run("https://example.supabase.co", jwt("anon")).status, 0);
    assert.notEqual(run("http://example.supabase.co", "sb_publishable_test").status, 0);
    assert.notEqual(run("", "sb_publishable_test").status, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Published cloud settings invalidate both sides of the PWA boot gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "workout-shell-config-"));
  try {
    const builds = [];
    for (const key of ["sb_publishable_first", "sb_publishable_second"]) {
      await writeFile(join(directory, "sw.js"), 'const CACHE_VERSION = "v8";');
      await writeFile(join(directory, "index.html"), '<meta name="workout-app-build" content="v8">');
      const result = spawnSync(process.execPath, ["scripts/configure-cloud.mjs", join(directory, "cloud-config.js"), directory], {
        env: { ...process.env, SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: key },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const worker = await readFile(join(directory, "sw.js"), "utf8");
      const html = await readFile(join(directory, "index.html"), "utf8");
      const version = worker.match(/CACHE_VERSION = "([^"]+)"/)[1];
      assert.equal(html.match(/content="([^"]+)"/)[1], version);
      builds.push(version);
    }
    assert.notEqual(builds[0], builds[1]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
