import test from "node:test";
import assert from "node:assert/strict";
import {
  CloudNotConfiguredError,
  createSupabaseAuth,
  isCloudConfigured,
} from "../js/auth.js";

test("disabled cloud remains a clean guest mode", async () => {
  const auth = createSupabaseAuth({ config: {} });
  assert.equal(auth.configured, false);
  assert.equal(await auth.getSession(), null);
  assert.doesNotThrow(() => auth.onAuthStateChange(() => {}).unsubscribe());
  await assert.rejects(() => auth.signIn({ email: "a@b.c", password: "secret" }), CloudNotConfiguredError);
});

test("configuration accepts publishable and legacy anon public keys", () => {
  assert.equal(isCloudConfigured({ supabaseUrl: "https://example.supabase.co", supabasePublishableKey: "sb_publishable_x" }), true);
  assert.equal(isCloudConfigured({ supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "public-anon" }), true);
  assert.equal(isCloudConfigured({ supabaseUrl: "", supabasePublishableKey: "x" }), false);
});

test("auth adapter delegates session lifecycle to official client with local-only sign out", async () => {
  const calls = [];
  const subscription = { unsubscribe() {} };
  const client = {
    auth: {
      getSession: async () => ({ data: { session: { user: { id: "u1" } } }, error: null }),
      onAuthStateChange: (callback) => { calls.push(["listen", callback]); return { data: { subscription } }; },
      signUp: async (input) => { calls.push(["signup", input]); return { data: { user: { id: "u1" }, session: null }, error: null }; },
      signInWithPassword: async (input) => { calls.push(["signin", input]); return { data: { user: { id: "u1" } }, error: null }; },
      signOut: async (input) => { calls.push(["signout", input]); return { error: null }; },
      resetPasswordForEmail: async (email, options) => { calls.push(["reset", email, options]); return { error: null }; },
      updateUser: async (input) => { calls.push(["update", input]); return { data: { user: { id: "u1" } }, error: null }; },
    },
  };
  let createArgs;
  const auth = createSupabaseAuth({
    config: {
      supabaseUrl: "https://example.supabase.co",
      supabasePublishableKey: "sb_publishable_x",
      emailRedirectTo: "https://example.github.io/app/",
    },
    createClient: (...args) => { createArgs = args; return client; },
  });

  assert.deepEqual(createArgs.slice(0, 2), ["https://example.supabase.co", "sb_publishable_x"]);
  assert.deepEqual(createArgs[2].auth, { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true });
  assert.equal((await auth.getSession()).user.id, "u1");
  assert.equal(auth.onAuthStateChange(() => {}), subscription);
  await auth.signUp({ email: "me@example.com", password: "password" });
  await auth.signIn({ email: "me@example.com", password: "password" });
  await auth.signOut();
  await auth.resetPasswordForEmail("me@example.com");
  await auth.updatePassword("new-password");

  assert.deepEqual(calls.find(([name]) => name === "signout"), ["signout", { scope: "local" }]);
  assert.equal(calls.find(([name]) => name === "signup")[1].options.emailRedirectTo, "https://example.github.io/app/");
  assert.equal(calls.find(([name]) => name === "reset")[2].redirectTo, "https://example.github.io/app/");
});

test("auth adapter surfaces Supabase errors", async () => {
  const expected = new Error("invalid login");
  const auth = createSupabaseAuth({
    config: { supabaseUrl: "https://example.supabase.co", supabaseAnonKey: "anon" },
    createClient: () => ({ auth: { signInWithPassword: async () => ({ error: expected }) } }),
  });
  await assert.rejects(() => auth.signIn({ email: "x@y.z", password: "bad" }), expected);
});
