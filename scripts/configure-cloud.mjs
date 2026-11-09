import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import config from "../js/cloud-config.js";

const target = process.argv[2];
if (!target) throw new Error("Pass the output cloud-config.js path");
const overrideConnection = Boolean(process.env.SUPABASE_URL?.trim() || process.env.SUPABASE_PUBLISHABLE_KEY?.trim());
const supabaseUrl = (overrideConnection ? process.env.SUPABASE_URL ?? "" : config.supabaseUrl).trim();
const supabasePublishableKey = (overrideConnection ? process.env.SUPABASE_PUBLISHABLE_KEY ?? "" : config.supabasePublishableKey).trim();
if (Boolean(supabaseUrl) !== Boolean(supabasePublishableKey)) {
  throw new Error("Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY");
}
if (supabaseUrl) {
  const url = new URL(supabaseUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("SUPABASE_URL must be a public HTTPS project URL");
  }
  let legacyRole;
  try { legacyRole = JSON.parse(Buffer.from(supabasePublishableKey.split(".")[1], "base64url").toString()).role; } catch {}
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(supabasePublishableKey) && legacyRole !== "anon") {
    throw new Error("Only a public publishable key or legacy anon key may be shipped to browsers");
  }
}
const redirectTo = (process.env.SUPABASE_REDIRECT_URL || config.emailRedirectTo).trim();
const source = `// Generated public browser configuration.\nexport default Object.freeze(${JSON.stringify({
  ...config, supabaseUrl, supabasePublishableKey,
  emailRedirectTo: redirectTo,
  passwordResetRedirectTo: redirectTo || config.passwordResetRedirectTo,
}, null, 2)});\n`;
await writeFile(target, source);
// A changed project configuration must also replace the cached PWA shell.
const siteRoot = process.argv[3];
if (siteRoot) {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 12);
  const workerPath = join(siteRoot, "sw.js");
  const htmlPath = join(siteRoot, "index.html");
  const worker = await readFile(workerPath, "utf8");
  const html = await readFile(htmlPath, "utf8");
  const baseVersion = worker.match(/const CACHE_VERSION = "([^"]+)"/)?.[1];
  if (!baseVersion) throw new Error("PWA cache version missing");
  const version = `${baseVersion}-${digest}`;
  await writeFile(workerPath, worker.replace(/const CACHE_VERSION = "[^"]+"/, `const CACHE_VERSION = "${version}"`));
  await writeFile(htmlPath, html.replace(/(<meta name="workout-app-build" content=")[^"]+/, `$1${version}`));
}
console.log(supabaseUrl ? "Public Supabase configuration prepared" : "Local workouts enabled; cloud project not configured");
