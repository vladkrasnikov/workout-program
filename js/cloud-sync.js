import { planMerge } from "./backup.js";
import {
  exportDataForScope,
  importDataForScope,
  normalizeStorageScope,
} from "./storage.js";

export class CloudRevisionConflictError extends Error {
  constructor(expectedRevision) {
    super("Хмарну історію вже змінено на іншому пристрої");
    this.name = "CloudRevisionConflictError";
    this.expectedRevision = expectedRevision;
  }
}

export class CloudOfflineError extends Error {
  constructor() {
    super("Немає мережі; зміни залишилися локально");
    this.name = "CloudOfflineError";
  }
}

const clone = (value) => globalThis.structuredClone
  ? globalThis.structuredClone(value)
  : JSON.parse(JSON.stringify(value));

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export function normalizeSnapshot(snapshot = {}) {
  const sortById = (records) => [...(records ?? [])].map(clone).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const settings = [...(snapshot.settings ?? [])].map(clone).sort((a, b) => String(a.key).localeCompare(String(b.key)));
  return {
    sessions: sortById(snapshot.sessions),
    entries: sortById(snapshot.entries),
    settings,
  };
}

export const snapshotFingerprint = (snapshot) => canonical(normalizeSnapshot(snapshot));

export function isSnapshotEmpty(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  return normalized.sessions.length === 0 && normalized.entries.length === 0;
}

const throwResultError = (result) => {
  if (result?.error) throw result.error;
  return result?.data ?? null;
};

const normalizeUserScope = (userId) => {
  const normalized = normalizeStorageScope(userId);
  if (normalized === "guest") throw new TypeError("Для хмарної операції потрібен UUID користувача");
  return normalized;
};

/** Supabase table adapter. The caller must pass the authenticated user's UUID. */
export function createSupabaseSnapshotStore(client, { userId, table = "workout_snapshots" } = {}) {
  const normalizedUserId = normalizeUserScope(userId);
  if (!client?.from) throw new TypeError("Потрібен Supabase client");

  return Object.freeze({
    userId: normalizedUserId,

    async read() {
      const result = await client
        .from(table)
        .select("user_id,snapshot,revision,updated_at")
        .eq("user_id", normalizedUserId)
        .maybeSingle();
      const row = throwResultError(result);
      return row ? {
        snapshot: normalizeSnapshot(row.snapshot),
        revision: Number(row.revision),
        updatedAt: row.updated_at,
      } : null;
    },

    async create(snapshot) {
      const result = await client
        .from(table)
        .insert({ user_id: normalizedUserId, snapshot: normalizeSnapshot(snapshot), revision: 1 })
        .select("user_id,snapshot,revision,updated_at")
        .single();
      const row = throwResultError(result);
      return { snapshot: normalizeSnapshot(row.snapshot), revision: Number(row.revision), updatedAt: row.updated_at };
    },

    async update(snapshot, expectedRevision) {
      const result = await client
        .from(table)
        .update({ snapshot: normalizeSnapshot(snapshot), revision: expectedRevision + 1, updated_at: new Date().toISOString() })
        .eq("user_id", normalizedUserId)
        .eq("revision", expectedRevision)
        .select("user_id,snapshot,revision,updated_at")
        .maybeSingle();
      const row = throwResultError(result);
      if (!row) throw new CloudRevisionConflictError(expectedRevision);
      return { snapshot: normalizeSnapshot(row.snapshot), revision: Number(row.revision), updatedAt: row.updated_at };
    },
  });
}

export function createScopedLocalSnapshotStore(scope) {
  const normalizedScope = normalizeStorageScope(scope);
  return Object.freeze({
    scope: normalizedScope,
    read: () => exportDataForScope(normalizedScope),
    replace: (snapshot) => importDataForScope(normalizedScope, normalizeSnapshot(snapshot), { replace: true }),
  });
}

export function createMemorySyncMetaStore(initial = null) {
  let value = initial ? clone(initial) : null;
  return Object.freeze({
    async get() { return value ? clone(value) : null; },
    async set(next) { value = next ? clone(next) : null; },
    async clear() { value = null; },
  });
}

export function createBrowserSyncMetaStore(userId, {
  storage = globalThis.localStorage,
  keyPrefix = "workout-program:cloud-sync:",
} = {}) {
  const key = `${keyPrefix}${normalizeUserScope(userId)}`;
  return Object.freeze({
    async get() {
      try { return JSON.parse(storage?.getItem(key) ?? "null"); } catch { return null; }
    },
    async set(value) { storage?.setItem(key, JSON.stringify(value)); },
    async clear() { storage?.removeItem(key); },
  });
}

const mergeFirstSync = (localSnapshot, remoteSnapshot) => {
  const plan = planMerge(normalizeSnapshot(localSnapshot), normalizeSnapshot(remoteSnapshot));
  return { ...plan, data: normalizeSnapshot(plan.data) };
};

/**
 * Offline-first synchronization. `sync()` never overwrites when both sides changed:
 * it returns an explicit conflict for the UI to resolve.
 */
export function createCloudSync({ remote, local, meta, isOnline = () => globalThis.navigator?.onLine !== false } = {}) {
  if (!remote?.read || !remote?.create || !remote?.update) throw new TypeError("Некоректне хмарне сховище");
  if (!local?.read || !local?.replace) throw new TypeError("Некоректне локальне сховище");
  if (!meta?.get || !meta?.set) throw new TypeError("Некоректне сховище стану синхронізації");

  const remember = async (record, snapshot) => {
    const next = { revision: record.revision, fingerprint: snapshotFingerprint(snapshot), updatedAt: record.updatedAt ?? null };
    await meta.set(next);
    return next;
  };

  const pull = async (record) => {
    const snapshot = normalizeSnapshot(record.snapshot);
    await local.replace(snapshot);
    await remember(record, snapshot);
    return { status: "pulled", snapshot, revision: record.revision };
  };

  const push = async (snapshot, record) => {
    const saved = record
      ? await remote.update(normalizeSnapshot(snapshot), record.revision)
      : await remote.create(normalizeSnapshot(snapshot));
    await remember(saved, snapshot);
    return { status: "pushed", snapshot: normalizeSnapshot(snapshot), revision: saved.revision };
  };

  return Object.freeze({
    async sync() {
      if (!isOnline()) return { status: "offline", error: new CloudOfflineError() };
      const [localSnapshotRaw, remoteRecord, previous] = await Promise.all([local.read(), remote.read(), meta.get()]);
      const localSnapshot = normalizeSnapshot(localSnapshotRaw);
      const localFingerprint = snapshotFingerprint(localSnapshot);

      if (!remoteRecord) return push(localSnapshot, null);
      const remoteSnapshot = normalizeSnapshot(remoteRecord.snapshot);

      if (!previous) {
        if (isSnapshotEmpty(localSnapshot)) return pull(remoteRecord);
        if (isSnapshotEmpty(remoteSnapshot)) return push(localSnapshot, remoteRecord);
        const plan = mergeFirstSync(localSnapshot, remoteSnapshot);
        if (plan.conflicts.length) {
          return { status: "conflict", reason: "first-sync", local: localSnapshot, remote: remoteRecord, conflicts: plan.conflicts };
        }
        await local.replace(plan.data);
        return push(plan.data, remoteRecord);
      }

      if (remoteRecord.revision === previous.revision) {
        if (localFingerprint === previous.fingerprint) {
          await remember(remoteRecord, localSnapshot);
          return { status: "synced", snapshot: localSnapshot, revision: remoteRecord.revision };
        }
        return push(localSnapshot, remoteRecord);
      }

      if (localFingerprint === previous.fingerprint) return pull(remoteRecord);
      return { status: "conflict", reason: "both-changed", local: localSnapshot, remote: remoteRecord, conflicts: [] };
    },

    async resolveConflict(strategy, conflict) {
      if (!isOnline()) return { status: "offline", error: new CloudOfflineError() };
      const latest = await remote.read();
      if (!latest) return push(await local.read(), null);
      if (strategy === "cloud") return pull(latest);
      if (strategy === "local") {
        const observedRevision = conflict?.remote?.revision;
        if (!Number.isInteger(observedRevision)) throw new TypeError("Конфлікт не містить версію хмарної копії");
        if (latest.revision !== observedRevision) {
          return {
            status: "conflict",
            reason: "remote-changed-after-conflict",
            local: normalizeSnapshot(conflict?.local ?? await local.read()),
            remote: latest,
            conflicts: [],
          };
        }
        return push(normalizeSnapshot(conflict?.local ?? await local.read()), latest);
      }
      throw new TypeError("Стратегія має бути 'local' або 'cloud'");
    },
  });
}

export function prepareGuestTransfer(guestSnapshot, accountSnapshot) {
  const plan = planMerge(normalizeSnapshot(accountSnapshot), normalizeSnapshot(guestSnapshot));
  return { ...plan, data: normalizeSnapshot(plan.data) };
}

export async function prepareScopeTransfer(accountScope) {
  const normalizedAccountScope = normalizeUserScope(accountScope);
  const [guest, account] = await Promise.all([
    exportDataForScope("guest"),
    exportDataForScope(normalizedAccountScope),
  ]);
  return prepareGuestTransfer(guest, account);
}

/** This mutation requires the UI to pass confirmed=true after an explicit user action. */
export async function applyScopeTransfer(accountScope, plan, { confirmed = false } = {}) {
  if (!confirmed) throw new Error("Перенесення локальної історії потребує явного підтвердження");
  if (plan?.conflicts?.length) throw new Error("Спочатку розв'яжіть конфлікти перенесення");
  return importDataForScope(normalizeUserScope(accountScope), normalizeSnapshot(plan.data), { replace: true });
}
