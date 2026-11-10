import test from "node:test";
import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { randomUUID } from "node:crypto";
import { createCloudSync, createSupabaseRecordStore, getLegacyImportMarker, prepareGuestTransfer, applyScopeTransfer } from "../js/cloud-sync.js";
import { createScopedRecordStore, setStorageScope, putSession, putEntry, saveSessionBundle, deleteSession, putSetting, exportAllData, importDataAtomic, openDatabase, databaseNameForScope } from "../js/storage.js";
import { canonical, clone, normalizeSnapshot, recordKey, snapshotRecords } from "../js/sync-records.js";
import { getActiveSession } from "../js/workouts.js";

const legacyStorage = new Map();
globalThis.localStorage = { getItem: (key) => legacyStorage.get(key) ?? null, removeItem: (key) => legacyStorage.delete(key) };

const empty = () => ({ sessions: [], entries: [], settings: [] });
const session = (id, label = id) => ({ id, programId: "spine-safe", dayId: "a", status: "completed", workoutDate: "2026-11-09",
  performedAt: "2026-11-09T12:00:00.000Z", createdAt: "2026-11-09T12:00:00.000Z", completedAt: "2026-11-09T13:00:00.000Z",
  updatedAt: "2026-11-09T13:00:00.000Z", revision: 1, label });
const snapshot = (...ids) => ({ ...empty(), sessions: ids.map((id) => session(id)) });
const local = () => createScopedRecordStore(randomUUID());
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const save = async (store, id, label) => {
  setStorageScope(store.scope);
  const old = (await store.exportSnapshot()).sessions.find((row) => row.id === id);
  return putSession({ ...session(id, label), ...old, label: label ?? old?.label ?? id });
};
const ids = async (store) => (await store.exportSnapshot()).sessions.map(({ id }) => id).sort();

function remote(initial = empty()) {
  const rows = new Map(snapshotRecords(initial).map((row) => [recordKey(row.kind, row.id), {
    kind: row.kind, id: row.id, payload: row.payload, format_version: 1, revision: 1, updated_at: "t1", deleted_at: null,
  }]));
  const receipts = new Map();
  const reads = [];
  const operations = [];
  return {
    rows, reads, operations,
    async changes(versions, keys = null) {
      const changed = [...rows.values()].filter((row) => row.revision > (versions[recordKey(row.kind, row.id)] ?? 0)
        && (!keys || keys.includes(recordKey(row.kind, row.id))));
      reads.push(changed.map((row) => recordKey(row.kind, row.id)));
      return clone(changed);
    },
    async write(op) {
      operations.push(clone(op));
      if (receipts.has(op.operation_id)) return clone(receipts.get(op.operation_id));
      const key = recordKey(op.kind, op.id);
      const current = rows.get(key);
      if ((current?.revision ?? 0) !== op.expected_revision) return { status: "conflict", record: clone(current) };
      const revision = op.expected_revision + 1;
      rows.set(key, { kind: op.kind, id: op.id, payload: op.deleted ? {} : clone(op.payload), format_version: 1,
        revision, updated_at: `t${revision}`, deleted_at: op.deleted ? "deleted" : null });
      const accepted = { status: "applied", revision };
      receipts.set(op.operation_id, accepted);
      return clone(accepted);
    },
    external(id, label) {
      const key = recordKey("session", id), row = rows.get(key);
      rows.set(key, { ...row, payload: { session: session(id, label), entries: [] }, revision: row.revision + 1 });
    },
  };
}

async function seedCache(store, data) {
  const db = await openDatabase(store.scope);
  const tx = db.transaction(["sessions", "entries", "settings"], "readwrite");
  for (const [name, field] of [["sessions", "id"], ["entries", "id"], ["settings", "key"]]) {
    for (const value of data[name]) { assert.ok(value[field]); tx.objectStore(name).put(value); }
  }
  await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
  db.close();
}

test("clean old account cache is replaced from cloud without uploading stale records", async () => {
  const store = local(), cloud = remote(snapshot("cloud"));
  await seedCache(store, snapshot("stale-cache"));
  const result = await createCloudSync({ local: store, remote: cloud }).initializeFromCloud();
  assert.equal(result.status, "pulled");
  assert.deepEqual(await ids(store), ["cloud"]);
  assert.equal(cloud.operations.length, 0);
});

test("local mutations enqueue atomically and survive a new sync instance without markPending", async () => {
  const store = local(), cloud = remote();
  await save(store, "session-offline");
  assert.equal(await createCloudSync({ local: store, remote: cloud, isOnline: () => false }).hasPending(), true);
  const sync = createCloudSync({ local: createScopedRecordStore(store.scope), remote: cloud });
  await sync.sync();
  assert.equal(cloud.rows.get("session:session-offline").revision, 1);
  assert.equal(await sync.hasPending(), false);
});

test("remote pull cannot overwrite a local change saved while the network request is pending", async () => {
  const store = local(), cloud = remote(snapshot("same"));
  const sync = createCloudSync({ local: store, remote: cloud });
  await sync.sync();
  cloud.external("same", "remote");
  const entered = deferred(), release = deferred();
  const read = cloud.changes;
  cloud.changes = async (...args) => { const rows = await read(...args); entered.resolve(); await release.promise; return rows; };
  const running = sync.sync();
  await entered.promise;
  await save(store, "same", "new-local-edit");
  release.resolve();
  const result = await running;
  assert.equal(result.status, "conflict");
  assert.equal((await store.exportSnapshot()).sessions[0].label, "new-local-edit");
  assert.equal(await sync.hasPending(), true);
});

test("different workouts edited on two devices synchronize without an account-wide conflict", async () => {
  const a = local(), b = local(), cloud = remote(snapshot("monday", "friday"));
  const sa = createCloudSync({ local: a, remote: cloud }), sb = createCloudSync({ local: b, remote: cloud });
  await sa.sync(); await sb.sync();
  await save(a, "monday", "phone"); await save(b, "friday", "laptop");
  assert.notEqual((await sa.sync()).status, "conflict");
  assert.notEqual((await sb.sync()).status, "conflict");
  await sa.sync();
  assert.deepEqual((await a.exportSnapshot()).sessions.map(({ id, label }) => [id, label]).sort(), [["friday", "laptop"], ["monday", "phone"]]);
  assert.equal(cloud.rows.get("session:monday").revision, 2);
  assert.equal(cloud.rows.get("session:friday").revision, 2);
  assert.ok(cloud.reads.some((keys) => keys.length === 1 && keys[0] === "session:monday"));
});

test("same-workout conflict resolution preserves unrelated workouts and detects a newer unseen cloud revision", async () => {
  const store = local(), cloud = remote(snapshot("same", "other"));
  const sync = createCloudSync({ local: store, remote: cloud });
  await sync.sync();
  await save(store, "same", "local"); await save(store, "other", "independent");
  cloud.external("same", "remote");
  const conflict = await sync.sync();
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(cloud.rows.get("session:other").payload.session.label, "independent");
  cloud.external("same", "newer");
  const newer = await sync.resolveConflict("local", conflict);
  assert.equal(newer.status, "conflict");
  assert.equal(cloud.rows.get("session:same").payload.session.label, "newer");
  assert.notEqual((await sync.resolveConflict("local", newer)).status, "conflict");
  assert.equal(cloud.rows.get("session:same").payload.session.label, "local");
  assert.equal(cloud.rows.get("session:other").payload.session.label, "independent");
});

test("cloud conflict choice refuses to discard local edits made after the conflict was displayed", async () => {
  const store = local(), cloud = remote(snapshot("same"));
  const sync = createCloudSync({ local: store, remote: cloud }); await sync.sync();
  await save(store, "same", "local"); cloud.external("same", "remote");
  const conflict = await sync.sync();
  await save(store, "same", "new-local");
  const updated = await sync.resolveConflict("cloud", conflict);
  assert.equal(updated.status, "conflict");
  assert.equal((await store.exportSnapshot()).sessions[0].label, "new-local");
  await sync.resolveConflict("cloud", updated);
  assert.equal((await store.exportSnapshot()).sessions[0].label, "remote");
});

test("an edit made during upload remains queued and uses the acknowledged remote revision", async () => {
  const store = local(), cloud = remote();
  const sync = createCloudSync({ local: store, remote: cloud }); await sync.sync();
  await save(store, "same", "first");
  const entered = deferred(), release = deferred();
  const write = cloud.write;
  cloud.write = async (op) => { entered.resolve(); await release.promise; return write(op); };
  const running = sync.sync(); await entered.promise;
  await save(store, "same", "second"); release.resolve();
  assert.equal((await running).status, "pending");
  assert.equal((await store.exportSnapshot()).sessions[0].label, "second");
  await sync.sync();
  assert.equal(cloud.rows.get("session:same").revision, 2);
  assert.equal(cloud.rows.get("session:same").payload.session.label, "second");
});

test("a lost response retries the same durable operation after restart, even after another cloud edit", async () => {
  const store = local(), cloud = remote();
  const sync = createCloudSync({ local: store, remote: cloud }); await sync.sync();
  await save(store, "same", "first");
  const write = cloud.write; let fail = true;
  cloud.write = async (op) => { const result = await write(op); if (fail) { fail = false; throw new Error("connection lost"); } return result; };
  await assert.rejects(sync.sync(), /connection lost/);
  const operationId = cloud.operations[0].operation_id;
  cloud.external("same", "another-device");
  await createCloudSync({ local: createScopedRecordStore(store.scope), remote: cloud }).sync();
  assert.equal(cloud.operations[1].operation_id, operationId);
  assert.equal(cloud.rows.get("session:same").revision, 2);
  assert.equal((await store.exportSnapshot()).sessions[0].label, "another-device");
});

test("two browser tabs share the prepared operation and cannot acknowledge away a newer generation", async () => {
  const a = local(), b = createScopedRecordStore(a.scope);
  await save(a, "same", "first"); await a.state();
  const [one, two] = await Promise.all([a.prepare("session:same"), b.prepare("session:same")]);
  assert.equal(one.operation_id, two.operation_id);
  await save(b, "same", "second");
  await a.acknowledge(one, { revision: 1 }); await b.acknowledge(two, { revision: 1 });
  const next = await a.prepare("session:same");
  assert.notEqual(next.operation_id, one.operation_id);
  assert.equal(next.expected_revision, 1);
  assert.equal(next.payload.session.label, "second");
});

test("tombstones remove a stale device copy and a stale offline edit cannot resurrect a deletion", async () => {
  const a = local(), b = local(), cloud = remote(snapshot("same"));
  const sa = createCloudSync({ local: a, remote: cloud }), sb = createCloudSync({ local: b, remote: cloud });
  await sa.sync(); await sb.sync();
  setStorageScope(a.scope); await deleteSession("same"); await sa.sync();
  assert.ok(cloud.rows.get("session:same").deleted_at);
  await save(b, "same", "offline-edit");
  assert.equal((await sb.sync()).status, "conflict");
  assert.ok(cloud.rows.get("session:same").deleted_at);
  const conflict = await sb.sync(); await sb.resolveConflict("cloud", conflict);
  assert.deepEqual(await ids(b), []);
});

test("clean devices apply remote deletion without a conflict", async () => {
  const a = local(), b = local(), cloud = remote(snapshot("same"));
  const sa = createCloudSync({ local: a, remote: cloud }), sb = createCloudSync({ local: b, remote: cloud });
  await sa.sync(); await sb.sync(); setStorageScope(a.scope); await deleteSession("same"); await sa.sync();
  await sb.sync(); assert.deepEqual(await ids(b), []);
});

test("a failed bundle transaction rolls back both data and its outbox generation", async () => {
  const store = local(); setStorageScope(store.scope);
  await assert.rejects(saveSessionBundle(session("s"), [{ id: "e", sessionId: "other" }]), /іншому/);
  assert.deepEqual(await ids(store), []);
  assert.deepEqual((await store.state()).pending, []);
});

test("entry changes queue the parent workout; active UI pointers stay on their device", async () => {
  const store = local(), cloud = remote(); setStorageScope(store.scope);
  await putSession(session("s"));
  await putEntry({ id: "e", sessionId: "s", sets: [] });
  await putSetting("activeSessionId", "s"); await putSetting("currentProgramId", "spine-safe");
  const sync = createCloudSync({ local: store, remote: cloud }); await sync.sync();
  assert.equal(cloud.rows.size, 1);
  assert.equal(cloud.rows.get("session:s").payload.entries.length, 1);
  assert.equal((await store.exportSnapshot()).settings.find(({ key }) => key === "activeSessionId").value, "s");
});

test("an open clean draft is not replaced while its editor may contain unpersisted input", async () => {
  const store = local(), data = snapshot("same"); data.sessions[0].status = "draft";
  const cloud = remote(data), sync = createCloudSync({ local: store, remote: cloud });
  await sync.sync(); setStorageScope(store.scope);
  await putSetting("activeSessionId", "same");
  cloud.external("same", "finished-on-another-device");
  const conflict = await sync.sync();
  assert.equal(conflict.status, "conflict");
  assert.equal((await store.exportSnapshot()).sessions[0].status, "draft");
  await sync.resolveConflict("cloud", conflict);
  assert.equal((await store.exportSnapshot()).sessions[0].status, "completed");
  assert.equal((await store.exportSnapshot()).settings.find(({ key }) => key === "activeSessionId").value, null);
});

test("a draft pulled onto a new device can be resumed without a synchronized active pointer", async () => {
  const store = local(), data = snapshot("draft"); data.sessions[0].status = "draft";
  await createCloudSync({ local: store, remote: remote(data) }).sync();
  setStorageScope(store.scope);
  assert.equal((await getActiveSession()).session.id, "draft");
});

test("explicit legacy import uses a short digest, persists its outbox and is idempotent", async () => {
  const store = local(), cloud = remote(snapshot("account"));
  const sync = createCloudSync({ local: store, remote: cloud });
  await assert.rejects(sync.importLegacy(snapshot("guest")), /підтвердження/);
  const result = await sync.importLegacy(snapshot("guest"), { confirmed: true });
  assert.equal(result.status, "imported");
  const marker = getLegacyImportMarker(await store.exportSnapshot());
  assert.equal(marker.digest.length, 64); assert.equal(marker.fingerprint, undefined);
  const writes = cloud.operations.length;
  assert.equal((await sync.importLegacy(snapshot("guest"), { confirmed: true })).status, "already-imported");
  assert.equal(cloud.operations.length, writes);
  assert.deepEqual(await ids(store), ["account", "guest"]);
});

test("legacy pending deletion survives bootstrap and keeps unrelated remote workouts", async () => {
  const store = local(), cloud = remote(snapshot("deleted", "other"));
  const key = `workout-program:cloud-sync:${store.scope}`;
  legacyStorage.set(key, JSON.stringify({ pending: true, revision: 1, fingerprint: canonical(normalizeSnapshot(snapshot("deleted"))) }));
    await createCloudSync({ local: store, remote: cloud }).sync();
    assert.ok(cloud.rows.get("session:deleted").deleted_at);
    assert.deepEqual(await ids(store), ["other"]);
    assert.equal(legacyStorage.has(key), false);
});

test("v2 changes survive the crash window even when legacy pending is false", async () => {
  const store = local(), base = snapshot("same"), changed = snapshot("same");
  changed.sessions[0].label = "saved-before-crash";
  await seedCache(store, changed);
  legacyStorage.set(`workout-program:cloud-sync:${store.scope}`, JSON.stringify({ pending: false, revision: 1, fingerprint: canonical(base) }));
  const cloud = remote(base);
  await createCloudSync({ local: store, remote: cloud }).sync();
  assert.equal(cloud.rows.get("session:same").payload.session.label, "saved-before-crash");
});

test("legacy deletion already missing from the old cloud snapshot is acknowledged safely", async () => {
  const store = local(), cloud = remote();
  legacyStorage.set(`workout-program:cloud-sync:${store.scope}`, JSON.stringify({ pending: false, revision: 7, fingerprint: canonical(snapshot("deleted")) }));
  const sync = createCloudSync({ local: store, remote: cloud });
  assert.notEqual((await sync.sync()).status, "conflict");
  assert.equal(await sync.hasPending(), false);
  assert.deepEqual(await ids(store), []);
});

test("a legacy offline edit of an absent cloud workout requires an explicit restore choice", async () => {
  for (const choice of ["local", "cloud"]) {
    const store = local(), changed = snapshot("deleted"), cloud = remote();
    changed.sessions[0].label = "offline-edit";
    await seedCache(store, changed);
    legacyStorage.set(`workout-program:cloud-sync:${store.scope}`, JSON.stringify({ pending: true, revision: 7, fingerprint: canonical(snapshot("deleted")) }));
    const sync = createCloudSync({ local: store, remote: cloud });
    const conflict = await sync.sync();
    assert.equal(conflict.status, "conflict");
    assert.equal(conflict.conflicts[0].remote.missing, true);
    await sync.resolveConflict(choice, conflict);
    assert.deepEqual(await ids(store), choice === "local" ? ["deleted"] : []);
    assert.equal(cloud.rows.size, choice === "local" ? 1 : 0);
  }
});

test("RPC binds the authenticated account to the local queue and never sends local generations", async () => {
  const calls = [];
  const owner = randomUUID();
  const remote = createSupabaseRecordStore({ rpc: async (name, args) => { calls.push([name, args]); return { data: name === "workout_get_changes" ? [] : { status: "applied", revision: 1 } }; } }, { userId: owner });
  await remote.changes({ "session:s": 1 });
  await remote.write({ kind: "session", id: "s", operation_id: randomUUID(), generation: 5, expected_revision: 0, format_version: 1, payload: {}, deleted: false });
  assert.equal(calls[0][0], "workout_get_changes");
  assert.equal(calls[1][0], "workout_apply_change");
  assert.equal(calls[1][1].p_generation, undefined);
  assert.equal(calls[1][1].p_user_id, undefined);
  assert.equal(calls[0][1].p_expected_user_id, owner);
  assert.equal(calls[1][1].p_expected_user_id, owner);
  assert.throws(() => createSupabaseRecordStore({ rpc() {} }, { userId: "guest" }), /UUID/);
});

test("guest transfer remains explicit and stable-ID conflicts are reported", async () => {
  const plan = prepareGuestTransfer(snapshot("guest"), snapshot("account"));
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.data.sessions.length, 2);
  assert.ok(prepareGuestTransfer(snapshot("same"), { ...snapshot("same"), sessions: [session("same", "changed")] }).conflicts.length);
  await assert.rejects(applyScopeTransfer(randomUUID(), plan), /підтвердження/);
});
