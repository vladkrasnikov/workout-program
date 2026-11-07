import test from "node:test";
import assert from "node:assert/strict";
import {
  applyScopeTransfer,
  CloudRevisionConflictError,
  createCloudSync,
  createMemorySyncMetaStore,
  createSupabaseSnapshotStore,
  getLegacyImportMarker,
  LEGACY_IMPORT_MARKER_KEY,
  normalizeSnapshot,
  prepareGuestTransfer,
} from "../js/cloud-sync.js";

const empty = () => ({ sessions: [], entries: [], settings: [] });
const snapshot = (...ids) => ({ sessions: ids.map((id) => ({ id })), entries: [], settings: [] });
const copy = (value) => JSON.parse(JSON.stringify(value));

const memoryLocal = (initial) => {
  let value = normalizeSnapshot(initial);
  let replacements = 0;
  return {
    read: async () => copy(value),
    replace: async (next) => { value = normalizeSnapshot(next); replacements += 1; },
    set: (next) => { value = normalizeSnapshot(next); },
    value: () => copy(value),
    replacements: () => replacements,
  };
};

const memoryRemote = (initial = null) => {
  let value = initial ? copy(initial) : null;
  let writes = 0;
  return {
    read: async () => copy(value),
    create: async (next) => {
      if (value) throw new Error("already exists");
      value = { snapshot: normalizeSnapshot(next), revision: 1, updatedAt: "t1" };
      writes += 1;
      return copy(value);
    },
    update: async (next, expected) => {
      if (!value || value.revision !== expected) throw new Error("revision conflict");
      value = { snapshot: normalizeSnapshot(next), revision: expected + 1, updatedAt: `t${expected + 1}` };
      writes += 1;
      return copy(value);
    },
    external: (next) => { value = { snapshot: normalizeSnapshot(next), revision: (value?.revision ?? 0) + 1, updatedAt: "external" }; },
    value: () => copy(value),
    writes: () => writes,
  };
};

test("initial local data is pushed and later deletion is not resurrected", async () => {
  const local = memoryLocal(snapshot("s1"));
  const remote = memoryRemote();
  const sync = createCloudSync({ remote, local, meta: createMemorySyncMetaStore(), isOnline: () => true });

  assert.equal((await sync.sync()).status, "pushed");
  local.set(empty());
  const result = await sync.sync();
  assert.equal(result.status, "pushed");
  assert.equal(result.revision, 2);
  assert.deepEqual(remote.value().snapshot.sessions, []);
});

test("remote-only change pulls when local is unchanged", async () => {
  const local = memoryLocal(snapshot("s1"));
  const remote = memoryRemote();
  const sync = createCloudSync({ remote, local, meta: createMemorySyncMetaStore(), isOnline: () => true });
  await sync.sync();
  remote.external(snapshot("s1", "s2"));

  const result = await sync.sync();
  assert.equal(result.status, "pulled");
  assert.deepEqual(local.value().sessions.map(({ id }) => id), ["s1", "s2"]);
});

test("concurrent changes return an explicit conflict without overwriting either side", async () => {
  const local = memoryLocal(snapshot("s1"));
  const remote = memoryRemote();
  const sync = createCloudSync({ remote, local, meta: createMemorySyncMetaStore(), isOnline: () => true });
  await sync.sync();
  local.set(snapshot("s1", "local"));
  remote.external(snapshot("s1", "remote"));
  const beforeWrites = remote.writes();
  const beforeReplacements = local.replacements();

  const result = await sync.sync();
  assert.equal(result.status, "conflict");
  assert.equal(result.reason, "both-changed");
  assert.equal(remote.writes(), beforeWrites);
  assert.equal(local.replacements(), beforeReplacements);
});

test("explicit conflict resolution supports cloud or local choice", async () => {
  const local = memoryLocal({ sessions: [{ id: "same", source: "local" }], entries: [], settings: [] });
  const remote = memoryRemote({ snapshot: { sessions: [{ id: "same", source: "remote" }], entries: [], settings: [] }, revision: 4, updatedAt: "t4" });
  const sync = createCloudSync({ remote, local, meta: createMemorySyncMetaStore(), isOnline: () => true });

  const conflict = await sync.sync();
  assert.equal(conflict.status, "conflict");
  assert.equal((await sync.resolveConflict("cloud", conflict)).status, "pulled");
  assert.deepEqual(local.value().sessions, [{ id: "same", source: "remote" }]);

  local.set(snapshot("chosen-local"));
  remote.external(snapshot("changed-cloud"));
  const nextConflict = await sync.sync();
  assert.equal(nextConflict.status, "conflict");
  const localResult = await sync.resolveConflict("local", nextConflict);
  assert.equal(localResult.status, "pushed");
  assert.deepEqual(remote.value().snapshot.sessions.map(({ id }) => id), ["chosen-local"]);
});

test("local conflict resolution cannot overwrite a newer unseen cloud revision", async () => {
  const local = memoryLocal({ sessions: [{ id: "same", source: "local" }], entries: [], settings: [] });
  const remote = memoryRemote({ snapshot: { sessions: [{ id: "same", source: "cloud" }], entries: [], settings: [] }, revision: 4, updatedAt: "t4" });
  const sync = createCloudSync({ remote, local, meta: createMemorySyncMetaStore(), isOnline: () => true });
  const displayedConflict = await sync.sync();
  assert.equal(displayedConflict.status, "conflict");
  assert.equal(displayedConflict.remote.revision, 4);

  remote.external({ sessions: [{ id: "same", source: "newer-cloud" }], entries: [], settings: [] });
  const writesBeforeResolution = remote.writes();
  const resolution = await sync.resolveConflict("local", displayedConflict);

  assert.equal(resolution.status, "conflict");
  assert.equal(resolution.reason, "remote-changed-after-conflict");
  assert.equal(resolution.remote.revision, 5);
  assert.equal(remote.writes(), writesBeforeResolution);
  assert.deepEqual(remote.value().snapshot.sessions, [{ id: "same", source: "newer-cloud" }]);
});

test("offline sync keeps local data untouched", async () => {
  const local = memoryLocal(snapshot("s1"));
  const remote = memoryRemote();
  const result = await createCloudSync({ remote, local, meta: createMemorySyncMetaStore(), isOnline: () => false }).sync();
  assert.equal(result.status, "offline");
  assert.equal(remote.writes(), 0);
  assert.deepEqual(local.value().sessions.map(({ id }) => id), ["s1"]);
});

test("account initialization treats cloud as authoritative and never uploads stale scoped cache", async () => {
  const local = memoryLocal(snapshot("stale-local"));
  const remote = memoryRemote({ snapshot: snapshot("cloud"), revision: 7, updatedAt: "t7" });
  const sync = createCloudSync({
    remote,
    local,
    meta: createMemorySyncMetaStore(),
    isOnline: () => true,
    remoteAuthoritativeOnFirstSync: true,
  });

  const result = await sync.initializeFromCloud();
  assert.equal(result.status, "pulled");
  assert.deepEqual(local.value().sessions.map(({ id }) => id), ["cloud"]);
  assert.equal(remote.writes(), 0);
});

test("empty cloud account initializes empty instead of uploading anonymous-looking cache", async () => {
  const local = memoryLocal(snapshot("must-not-upload"));
  const remote = memoryRemote();
  const sync = createCloudSync({
    remote,
    local,
    meta: createMemorySyncMetaStore(),
    isOnline: () => true,
    remoteAuthoritativeOnFirstSync: true,
  });

  const result = await sync.initializeFromCloud();
  assert.equal(result.status, "initialized-empty");
  assert.deepEqual(local.value(), normalizeSnapshot(empty()));
  assert.deepEqual(remote.value().snapshot, normalizeSnapshot(empty()));
});

test("pending per-account changes survive reconnect and clear only after cloud persistence", async () => {
  let online = false;
  const local = memoryLocal(snapshot("cached"));
  const remote = memoryRemote({ snapshot: snapshot("cached"), revision: 3, updatedAt: "t3" });
  const meta = createMemorySyncMetaStore({
    revision: 3,
    fingerprint: JSON.stringify(normalizeSnapshot(snapshot("cached"))),
    pending: false,
  });
  const sync = createCloudSync({ remote, local, meta, isOnline: () => online, remoteAuthoritativeOnFirstSync: true });

  local.set(snapshot("cached", "offline-edit"));
  await sync.markPending();
  assert.equal(await sync.hasPending(), true);
  assert.equal((await sync.sync()).status, "offline");
  assert.equal(await sync.hasPending(), true);

  online = true;
  assert.equal((await sync.sync()).status, "pushed");
  assert.equal(await sync.hasPending(), false);
  assert.deepEqual(remote.value().snapshot.sessions.map(({ id }) => id), ["cached", "offline-edit"]);
});

test("a mutation made during an in-flight upload remains pending for the next revision", async () => {
  const local = memoryLocal(snapshot("base"));
  const remote = memoryRemote();
  const sync = createCloudSync({ remote, local, meta: createMemorySyncMetaStore(), isOnline: () => true });
  await sync.sync();

  const originalUpdate = remote.update;
  let releaseUpload;
  let reportStarted;
  const uploadStarted = new Promise((resolve) => { reportStarted = resolve; });
  const uploadGate = new Promise((resolve) => { releaseUpload = resolve; });
  remote.update = async (...args) => {
    reportStarted();
    await uploadGate;
    return originalUpdate(...args);
  };

  local.set(snapshot("base", "first-edit"));
  await sync.markPending();
  const firstUpload = sync.sync();
  await uploadStarted;
  local.set(snapshot("base", "first-edit", "second-edit"));
  await sync.markPending();
  releaseUpload();
  await firstUpload;

  assert.equal(await sync.hasPending(), true);
  assert.deepEqual(remote.value().snapshot.sessions.map(({ id }) => id), ["base", "first-edit"]);
  await sync.sync();
  assert.equal(await sync.hasPending(), false);
  assert.deepEqual(remote.value().snapshot.sessions.map(({ id }) => id), ["base", "first-edit", "second-edit"]);
});

test("explicit legacy import persists marker atomically and cannot double-import", async () => {
  const local = memoryLocal(empty());
  const remote = memoryRemote({ snapshot: snapshot("account"), revision: 4, updatedAt: "t4" });
  const sync = createCloudSync({ remote, local, meta: createMemorySyncMetaStore(), isOnline: () => true });
  const legacy = snapshot("legacy");

  await assert.rejects(() => sync.importLegacy(legacy), /явного підтвердження/);
  const imported = await sync.importLegacy(legacy, { confirmed: true });
  assert.equal(imported.status, "imported");
  assert.deepEqual(imported.snapshot.sessions.map(({ id }) => id).sort(), ["account", "legacy"]);
  assert.equal(getLegacyImportMarker(imported.snapshot).version, 1);
  assert.ok(imported.snapshot.settings.some(({ key }) => key === LEGACY_IMPORT_MARKER_KEY));
  const writesAfterFirstImport = remote.writes();

  const second = await sync.importLegacy(legacy, { confirmed: true });
  assert.equal(second.status, "already-imported");
  assert.equal(remote.writes(), writesAfterFirstImport);
  assert.deepEqual(remote.value().snapshot.sessions.map(({ id }) => id).sort(), ["account", "legacy"]);
});

test("failed legacy cloud write does not replace cache or create a local migration marker", async () => {
  const local = memoryLocal(snapshot("account"));
  const remote = memoryRemote({ snapshot: snapshot("account"), revision: 2, updatedAt: "t2" });
  remote.update = async () => { throw new Error("network failed"); };
  const sync = createCloudSync({ remote, local, meta: createMemorySyncMetaStore(), isOnline: () => true });

  await assert.rejects(() => sync.importLegacy(snapshot("legacy"), { confirmed: true }), /network failed/);
  assert.deepEqual(local.value().sessions.map(({ id }) => id), ["account"]);
  assert.equal(getLegacyImportMarker(local.value()), null);
});

test("Supabase snapshot adapter applies user and revision filters", async () => {
  const calls = [];
  let mode = "read";
  const row = { user_id: "11111111-1111-4111-8111-111111111111", snapshot: snapshot("s1"), revision: 8, updated_at: "t8" };
  const builder = {
    select(columns) { calls.push(["select", columns]); return this; },
    eq(column, value) { calls.push(["eq", column, value]); return this; },
    insert(value) { mode = "insert"; calls.push(["insert", value]); return this; },
    update(value) { mode = "update"; calls.push(["update", value]); return this; },
    async single() { return { data: { ...row, revision: 1 }, error: null }; },
    async maybeSingle() { return { data: mode === "update" ? { ...row, revision: 8 } : row, error: null }; },
  };
  const store = createSupabaseSnapshotStore({ from: (table) => { calls.push(["from", table]); return builder; } }, { userId: row.user_id });

  assert.equal((await store.read()).revision, 8);
  await store.create(snapshot("s1"));
  await store.update(snapshot("s2"), 7);
  assert.ok(calls.some((call) => call[0] === "eq" && call[1] === "user_id" && call[2] === row.user_id));
  assert.ok(calls.some((call) => call[0] === "eq" && call[1] === "revision" && call[2] === 7));
  assert.ok(calls.some((call) => call[0] === "update" && call[1].revision === 8));
});

test("Supabase snapshot adapter reports a lost optimistic update", async () => {
  const builder = {
    update() { return this; }, eq() { return this; }, select() { return this; },
    async maybeSingle() { return { data: null, error: null }; },
  };
  const store = createSupabaseSnapshotStore({ from: () => builder }, { userId: "11111111-1111-4111-8111-111111111111" });
  await assert.rejects(() => store.update(empty(), 4), CloudRevisionConflictError);
  assert.throws(() => createSupabaseSnapshotStore({ from() {} }, { userId: "guest" }), /UUID/);
});

test("guest transfer is a preview and reports stable-ID conflicts", () => {
  const disjoint = prepareGuestTransfer(snapshot("guest"), snapshot("account"));
  assert.equal(disjoint.conflicts.length, 0);
  assert.deepEqual(disjoint.data.sessions.map(({ id }) => id).sort(), ["account", "guest"]);

  const conflict = prepareGuestTransfer(snapshot("same"), { sessions: [{ id: "same", changed: true }], entries: [], settings: [] });
  assert.equal(conflict.conflicts.length, 1);
});

test("scope transfer cannot mutate data without explicit confirmation", async () => {
  await assert.rejects(
    () => applyScopeTransfer("11111111-1111-4111-8111-111111111111", { data: empty(), conflicts: [] }),
    /явного підтвердження/,
  );
});
