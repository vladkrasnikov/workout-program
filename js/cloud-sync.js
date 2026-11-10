import { planMerge } from "./backup.js";
import { exportDataForScope, importDataForScope, normalizeStorageScope } from "./storage.js";
import { LEGACY_IMPORT_MARKER_KEY, clone, normalizeSnapshot, recordKey, snapshotDigest } from "./sync-records.js";
export { LEGACY_IMPORT_MARKER_KEY, normalizeSnapshot } from "./sync-records.js";
export { createScopedRecordStore } from "./storage.js";

export class CloudOfflineError extends Error {
  constructor() { super("Немає мережі; зміни залишилися локально"); this.name = "CloudOfflineError"; }
}
export const getLegacyImportMarker = (snapshot) => snapshot.settings?.find(({ key }) => key === LEGACY_IMPORT_MARKER_KEY)?.value ?? null;
const accountScope = (userId) => {
  const scope = normalizeStorageScope(userId);
  if (scope === "guest") throw new TypeError("Для хмарної операції потрібен UUID користувача");
  return scope;
};
const unwrap = (result) => { if (result?.error) throw result.error; return result?.data; };
// Legacy whole-account snapshots cannot describe tombstones for old deletions.
const missingRecord = (kind, id) => ({ kind, id, revision: 0, format_version: 1, payload: {}, deleted_at: new Date(0).toISOString(), missing: true });
const ordered = (row) => {
  const value = clone(row);
  if (value.kind === "session" && value.payload?.entries) value.payload.entries.sort((a, b) => a.id.localeCompare(b.id));
  return value;
};

/** Send only IDs/revisions and changed payloads, rather than the entire account. */
export function createSupabaseRecordStore(client, { userId } = {}) {
  const expectedUser = accountScope(userId);
  if (!client?.rpc) throw new TypeError("Потрібен Supabase client з RPC");
  return Object.freeze({
    async changes(versions, keys = null) {
      return (unwrap(await client.rpc("workout_get_changes", { p_expected_user_id: expectedUser, p_versions: versions, p_keys: keys })) ?? []).map(ordered);
    },
    async write(operation) {
      const result = unwrap(await client.rpc("workout_apply_change", {
        p_expected_user_id: expectedUser,
        p_operation_id: operation.operation_id, p_kind: operation.kind, p_id: operation.id,
        p_expected_revision: operation.expected_revision, p_format_version: operation.format_version,
        p_payload: operation.payload, p_deleted: operation.deleted,
      }));
      return result.record ? { ...result, record: ordered(result.record) } : result;
    },
  });
}

/** The durable outbox and all local concurrency checks live in IndexedDB transactions. */
export function createCloudSync({ remote, local, isOnline = () => globalThis.navigator?.onLine !== false, beforePull = async () => {} } = {}) {
  if (!remote?.changes || !remote?.write || !local?.state || !local?.applyRemote) throw new TypeError("Некоректне сховище синхронізації");
  let queue = Promise.resolve();
  const enqueue = (task) => {
    const next = queue.catch(() => {}).then(() => globalThis.navigator?.locks
      ? navigator.locks.request(`workout-sync:${local.scope}`, task) : task());
    queue = next;
    return next;
  };
  const synchronize = async () => {
    if (!isOnline()) return { status: "offline", error: new CloudOfflineError() };
    const conflicts = new Map();
    let changed = false;
    const apply = async (row) => {
      const result = await local.applyRemote(row);
      changed ||= Boolean(result.changed);
      if (result.conflict) conflicts.set(result.conflict.key, result.conflict);
      else conflicts.delete(recordKey(row.kind, row.id));
      return result;
    };
    let state = await local.state();
    if (!state.initialized) {
      const rows = await remote.changes({});
      await beforePull();
      for (const row of rows) await apply(row);
      changed = await local.finishInitialization(rows.map((row) => recordKey(row.kind, row.id))) || changed;
    }
    state = await local.state();
    const pending = state.pending.sort((a, b) => (a.kind === "setting") - (b.kind === "setting"));
    for (const item of pending) {
      if (conflicts.has(item.key)) continue;
      // Do not publish the import marker until every imported workout is uploaded.
      if (item.kind === "setting" && item.id === LEGACY_IMPORT_MARKER_KEY
        && (await local.state()).pending.some((row) => row.kind === "session")) continue;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const operation = await local.prepare(item.key);
        if (!operation) break;
        const result = await remote.write(operation);
        if (result.status === "applied") {
          await local.acknowledge(operation, result);
          break;
        }
        if (result.status !== "conflict") throw new Error("Некоректна відповідь синхронізації");
        if (!(await apply(result.record ?? missingRecord(operation.kind, operation.id))).rebased) break;
      }
    }
    state = await local.state();
    const rows = await remote.changes(state.versions);
    await beforePull();
    for (const row of rows) await apply(row);
    if (conflicts.size) return { status: "conflict", reason: "workouts-changed", conflicts: [...conflicts.values()], changed };
    const remaining = (await local.state()).pending.length;
    return { status: remaining ? "pending" : changed ? "pulled" : "synced", changed, pending: Boolean(remaining) };
  };
  return Object.freeze({
    initializeFromCloud: () => enqueue(synchronize),
    sync: () => enqueue(synchronize),
    // Every storage mutation has already enqueued its aggregate atomically.
    async markPending() { return { status: "pending" }; },
    async hasPending() { return (await local.state()).pending.length > 0; },
    resolveConflict(strategy, conflict) {
      if (!["local", "cloud"].includes(strategy)) throw new TypeError("Стратегія має бути 'local' або 'cloud'");
      return enqueue(async () => {
        if (!isOnline()) return { status: "offline", error: new CloudOfflineError() };
        await beforePull();
        const rows = await remote.changes({}, conflict.conflicts.map(({ key }) => key));
        const current = new Map(rows.map((row) => [recordKey(row.kind, row.id), row]));
        const remaining = [];
        let changed = false;
        for (const item of conflict.conflicts) {
          const row = current.get(item.key) ?? missingRecord(item.kind, item.id);
          const result = await local.resolve(item, row, strategy);
          changed ||= Boolean(result.changed);
          if (result.conflict) remaining.push(result.conflict);
        }
        if (remaining.length) return { status: "conflict", reason: "changed-after-conflict", conflicts: remaining, changed };
        const result = await synchronize();
        return { ...result, changed: changed || result.changed };
      });
    },
    importLegacy(legacySnapshot, { confirmed = false } = {}) {
      if (!confirmed) return Promise.reject(new Error("Імпорт старих локальних даних потребує явного підтвердження"));
      return enqueue(async () => {
        const result = await synchronize();
        if (["offline", "conflict", "pending"].includes(result.status)) return result;
        const account = await local.exportSnapshot();
        const existing = getLegacyImportMarker(account);
        if (existing) return { status: "already-imported", marker: existing };
        const legacy = normalizeSnapshot(legacySnapshot);
        const plan = planMerge(account, legacy);
        if (plan.conflicts.length) return { status: "conflict", reason: "legacy-import", conflicts: plan.conflicts };
        const marker = { version: 1, digest: await snapshotDigest(legacy), importedAt: new Date().toISOString() };
        await local.importSnapshot({ ...plan.data, settings: [
          ...plan.data.settings.filter(({ key }) => key !== LEGACY_IMPORT_MARKER_KEY), { key: LEGACY_IMPORT_MARKER_KEY, value: marker },
        ] });
        const saved = await synchronize();
        return ["conflict", "offline", "pending"].includes(saved.status) ? saved : { ...saved, status: "imported", marker };
      });
    },
  });
}

export function prepareGuestTransfer(guestSnapshot, accountSnapshot) {
  const plan = planMerge(normalizeSnapshot(accountSnapshot), normalizeSnapshot(guestSnapshot));
  return { ...plan, data: normalizeSnapshot(plan.data) };
}
export async function prepareScopeTransfer(userId) {
  const [guest, account] = await Promise.all([exportDataForScope("guest"), exportDataForScope(accountScope(userId))]);
  return prepareGuestTransfer(guest, account);
}
export async function applyScopeTransfer(userId, plan, { confirmed = false } = {}) {
  if (!confirmed) throw new Error("Перенесення локальної історії потребує явного підтвердження");
  if (plan?.conflicts?.length) throw new Error("Спочатку розв'яжіть конфлікти перенесення");
  return importDataForScope(accountScope(userId), normalizeSnapshot(plan.data), { replace: true });
}
