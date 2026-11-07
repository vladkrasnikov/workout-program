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

export const LEGACY_IMPORT_MARKER_KEY = "cloudLegacyImportV1";

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

const emptySnapshot = () => ({ sessions: [], entries: [], settings: [] });

export function getLegacyImportMarker(snapshot) {
  return normalizeSnapshot(snapshot).settings.find(({ key }) => key === LEGACY_IMPORT_MARKER_KEY)?.value ?? null;
}

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
export function createCloudSync({
  remote,
  local,
  meta,
  isOnline = () => globalThis.navigator?.onLine !== false,
  remoteAuthoritativeOnFirstSync = false,
} = {}) {
  if (!remote?.read || !remote?.create || !remote?.update) throw new TypeError("Некоректне хмарне сховище");
  if (!local?.read || !local?.replace) throw new TypeError("Некоректне локальне сховище");
  if (!meta?.get || !meta?.set) throw new TypeError("Некоректне сховище стану синхронізації");

  let mutationGeneration = 0;

  const remember = async (record, snapshot, savedGeneration = mutationGeneration) => {
    const fingerprint = snapshotFingerprint(snapshot);
    const currentFingerprint = snapshotFingerprint(await local.read());
    const latest = await meta.get();
    const changedWhileSaving = mutationGeneration !== savedGeneration
      || currentFingerprint !== fingerprint
      || Boolean(latest?.pending && latest.pendingFingerprint && latest.pendingFingerprint !== fingerprint);
    const next = {
      revision: record.revision,
      fingerprint,
      updatedAt: record.updatedAt ?? null,
      pending: changedWhileSaving,
      ...(changedWhileSaving ? {
        pendingFingerprint: latest?.pendingFingerprint ?? currentFingerprint,
        pendingAt: latest?.pendingAt ?? new Date().toISOString(),
      } : {}),
    };
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
    const savedGeneration = mutationGeneration;
    const saved = record
      ? await remote.update(normalizeSnapshot(snapshot), record.revision)
      : await remote.create(normalizeSnapshot(snapshot));
    await remember(saved, snapshot, savedGeneration);
    return { status: "pushed", snapshot: normalizeSnapshot(snapshot), revision: saved.revision };
  };

  const synchronize = async () => {
    if (!isOnline()) return { status: "offline", error: new CloudOfflineError() };
    const [localSnapshotRaw, remoteRecord, previous] = await Promise.all([local.read(), remote.read(), meta.get()]);
    const localSnapshot = normalizeSnapshot(localSnapshotRaw);
    const localFingerprint = snapshotFingerprint(localSnapshot);

    if (!remoteRecord) {
      if (previous?.pending || !remoteAuthoritativeOnFirstSync) return push(localSnapshot, null);
      const initial = emptySnapshot();
      const created = await remote.create(initial);
      await local.replace(initial);
      await remember(created, initial);
      return { status: "initialized-empty", snapshot: initial, revision: created.revision };
    }
    const remoteSnapshot = normalizeSnapshot(remoteRecord.snapshot);

    if (!Number.isInteger(previous?.revision)) {
      if (previous?.pending) {
        if (isSnapshotEmpty(remoteSnapshot)) return push(localSnapshot, remoteRecord);
        return { status: "conflict", reason: "pending-before-first-pull", local: localSnapshot, remote: remoteRecord, conflicts: [] };
      }
      if (remoteAuthoritativeOnFirstSync) return pull(remoteRecord);
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
      if (localFingerprint === previous.fingerprint && !previous.pending) {
        await remember(remoteRecord, localSnapshot);
        return { status: "synced", snapshot: localSnapshot, revision: remoteRecord.revision };
      }
      return push(localSnapshot, remoteRecord);
    }

    if (localFingerprint === previous.fingerprint && !previous.pending) return pull(remoteRecord);
    return { status: "conflict", reason: "both-changed", local: localSnapshot, remote: remoteRecord, conflicts: [] };
  };

  return Object.freeze({
    /**
     * Pulls the authenticated account before showing its progress. A pending
     * per-user queue is never discarded; it is synchronized or reported as a
     * conflict instead.
     */
    async initializeFromCloud() {
      if (!isOnline()) return { status: "offline", error: new CloudOfflineError() };
      const previous = await meta.get();
      if (previous?.pending) return synchronize();
      const record = await remote.read();
      if (record) return pull(record);
      const initial = emptySnapshot();
      const created = await remote.create(initial);
      await local.replace(initial);
      await remember(created, initial);
      return { status: "initialized-empty", snapshot: initial, revision: created.revision };
    },

    async markPending() {
      mutationGeneration += 1;
      const [previous, snapshot] = await Promise.all([meta.get(), local.read()]);
      await meta.set({
        ...(previous ?? {}),
        pending: true,
        pendingFingerprint: snapshotFingerprint(snapshot),
        pendingAt: new Date().toISOString(),
      });
      return { status: "pending" };
    },

    async hasPending() {
      return Boolean((await meta.get())?.pending);
    },

    async sync() {
      return synchronize();
    },

    /**
     * Explicit, cloud-first one-time import of the preserved anonymous DB.
     * The marker is written in the same cloud revision as the imported data,
     * so a failed upload never makes the action disappear locally.
     */
    async importLegacy(legacySnapshot, { confirmed = false } = {}) {
      if (!confirmed) throw new Error("Імпорт старих локальних даних потребує явного підтвердження");
      if (!isOnline()) return { status: "offline", error: new CloudOfflineError() };

      const record = await remote.read();
      const accountSnapshot = normalizeSnapshot(record?.snapshot ?? emptySnapshot());
      const existingMarker = getLegacyImportMarker(accountSnapshot);
      if (existingMarker) {
        if (record) await pull(record);
        return { status: "already-imported", marker: existingMarker, snapshot: accountSnapshot, revision: record?.revision ?? null };
      }

      const legacy = normalizeSnapshot(legacySnapshot);
      const plan = planMerge(accountSnapshot, legacy);
      if (plan.conflicts.length) {
        return {
          status: "conflict",
          reason: "legacy-import",
          local: legacy,
          remote: record,
          conflicts: plan.conflicts,
        };
      }

      const importedAt = new Date().toISOString();
      const marker = { version: 1, fingerprint: snapshotFingerprint(legacy), importedAt };
      const imported = normalizeSnapshot({
        ...plan.data,
        settings: [
          ...plan.data.settings.filter(({ key }) => key !== LEGACY_IMPORT_MARKER_KEY),
          { key: LEGACY_IMPORT_MARKER_KEY, value: marker },
        ],
      });
      const saved = record
        ? await remote.update(imported, record.revision)
        : await remote.create(imported);
      await local.replace(imported);
      await remember(saved, imported);
      return { status: "imported", marker, snapshot: imported, revision: saved.revision };
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
