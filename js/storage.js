import { LEGACY_PROGRAM_ID, migrateLegacyData } from "./migrations.js";
import { DEVICE_SETTINGS, clone, recordKey, sameValue, snapshotRecords, valueOfRemote } from "./sync-records.js";

export const DB_NAME = "workout-program";
export const DB_VERSION = 3;
export const GUEST_STORAGE_SCOPE = "guest";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let activeStorageScope = GUEST_STORAGE_SCOPE;

export function normalizeStorageScope(scope = GUEST_STORAGE_SCOPE) {
  if (scope === null || scope === undefined || scope === "" || scope === GUEST_STORAGE_SCOPE) return GUEST_STORAGE_SCOPE;
  const value = String(scope).trim().toLowerCase().replace(/^user:/, "");
  if (!UUID_PATTERN.test(value)) throw new Error("Некоректний ідентифікатор локального профілю");
  return value;
}

export function databaseNameForScope(scope = activeStorageScope) {
  const normalized = normalizeStorageScope(scope);
  return normalized === GUEST_STORAGE_SCOPE ? DB_NAME : `${DB_NAME}-user-${normalized}`;
}

export function setStorageScope(scope = GUEST_STORAGE_SCOPE) {
  activeStorageScope = normalizeStorageScope(scope);
  return activeStorageScope;
}

export function getStorageScope() {
  return activeStorageScope;
}

export class RevisionConflictError extends Error {
  constructor(entity, id, expected, actual) {
    super(`${entity} ${id} змінено в іншій вкладці (очікувалась ревізія ${expected}, актуальна ${actual})`);
    this.name = "RevisionConflictError";
    this.entity = entity;
    this.id = id;
    this.expected = expected;
    this.actual = actual;
  }
}

const requestAsPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transaction.error);
  transaction.onabort = () => reject(transaction.error ?? new Error("Транзакцію скасовано"));
});

export function openDatabase(scope = activeStorageScope) {
  if (!("indexedDB" in globalThis)) return Promise.reject(new Error("IndexedDB недоступна"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseNameForScope(scope), DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Закрийте інші вкладки для оновлення бази"));
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const tx = request.transaction;
      if (!db.objectStoreNames.contains("sync_records")) db.createObjectStore("sync_records", { keyPath: "key" });
      if (!db.objectStoreNames.contains("sessions")) {
        const sessions = db.createObjectStore("sessions", { keyPath: "id" });
        sessions.createIndex("by-workout-date", "workoutDate");
        sessions.createIndex("by-status", "status");
        sessions.createIndex("by-performed-at", "performedAt");
        sessions.createIndex("by-program", "programId");
      }
      if (!db.objectStoreNames.contains("entries")) {
        const entries = db.createObjectStore("entries", { keyPath: "id" });
        entries.createIndex("by-session", "sessionId");
        entries.createIndex("by-exercise", ["exerciseId", "variantId", "equipmentKey"]);
        entries.createIndex("unique-session-slot", ["sessionId", "slotId"], { unique: true });
      }
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });

      const sessionsStore = tx.objectStore("sessions");
      const entriesStore = tx.objectStore("entries");
      const settingsStore = tx.objectStore("settings");
      if (!sessionsStore.indexNames.contains("by-program")) sessionsStore.createIndex("by-program", "programId");
      if (event.oldVersion > 0 && event.oldVersion < 2) {
        if (entriesStore.indexNames.contains("unique-session-slot")) entriesStore.deleteIndex("unique-session-slot");
        const abortMigration = (error) => {
          console.error("IndexedDB migration failed", error);
          try { tx.abort(); } catch { /* The versionchange transaction may already be aborting. */ }
        };

        const snapshot = { sessions: null, entries: null, settings: null };
        const migrateWhenReady = () => {
          if (!snapshot.sessions || !snapshot.entries || !snapshot.settings) return;
          try {
            const migrated = migrateLegacyData(snapshot);
            migrated.sessions.forEach((session) => sessionsStore.put(session));
            migrated.settings.forEach((setting) => settingsStore.put(setting));
            const clearEntries = entriesStore.clear();
            clearEntries.onsuccess = () => {
              let entryIndex = 0;
              const writeNextEntry = () => {
                if (entryIndex >= migrated.entries.length) {
                  try {
                    entriesStore.createIndex("unique-session-slot", ["sessionId", "slotId"], { unique: true });
                  } catch (error) {
                    abortMigration(error);
                  }
                  return;
                }
                const writeRequest = entriesStore.put(migrated.entries[entryIndex]);
                entryIndex += 1;
                writeRequest.onsuccess = writeNextEntry;
              };
              writeNextEntry();
            };
          } catch (error) {
            abortMigration(error);
          }
        };
        const sessionsRequest = sessionsStore.getAll();
        sessionsRequest.onsuccess = () => { snapshot.sessions = sessionsRequest.result; migrateWhenReady(); };
        const entriesRequest = entriesStore.getAll();
        entriesRequest.onsuccess = () => { snapshot.entries = entriesRequest.result; migrateWhenReady(); };
        const settingsRequest = settingsStore.getAll();
        settingsRequest.onsuccess = () => { snapshot.settings = settingsRequest.result; migrateWhenReady(); };
      } else if (event.oldVersion === 0) {
        settingsStore.put({ key: "currentProgramId", value: LEGACY_PROGRAM_ID });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

async function withTransaction(storeNames, mode, callback, scope = activeStorageScope) {
  const db = await openDatabase(scope);
  const tx = db.transaction(storeNames, mode);
  const done = transactionDone(tx);
  try {
    const result = await callback(tx);
    await done;
    return result;
  } catch (error) {
    try { tx.abort(); } catch { /* The transaction may already be closing. */ }
    await done.catch(() => {});
    throw error;
  } finally {
    db.close();
  }
}

export const getSession = (id) => withTransaction(["sessions"], "readonly", (tx) => requestAsPromise(tx.objectStore("sessions").get(id)));
export const getEntry = (id) => withTransaction(["entries"], "readonly", (tx) => requestAsPromise(tx.objectStore("entries").get(id)));
export const listSessions = () => withTransaction(["sessions"], "readonly", (tx) => requestAsPromise(tx.objectStore("sessions").getAll()));
export const listEntries = () => withTransaction(["entries"], "readonly", (tx) => requestAsPromise(tx.objectStore("entries").getAll()));
export const listEntriesForSession = (sessionId) => withTransaction(["entries"], "readonly", (tx) => requestAsPromise(tx.objectStore("entries").index("by-session").getAll(sessionId)));

async function checkedPut(store, value, expectedRevision, entityName) {
  const current = await requestAsPromise(store.get(value.id));
  if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) {
    throw new RevisionConflictError(entityName, value.id, expectedRevision, current?.revision ?? 0);
  }
  const revision = (current?.revision ?? 0) + 1;
  const next = { ...value, revision, updatedAt: new Date().toISOString() };
  await requestAsPromise(store.put(next));
  return next;
}

const MUTATION_STORES = ["sessions", "entries", "settings", "sync_records"];

async function touchSync(tx, kind, id) {
  const store = tx.objectStore("sync_records");
  const key = recordKey(kind, id);
  const previous = await requestAsPromise(store.get(key));
  await requestAsPromise(store.put({ ...previous, key, kind, id,
    revision: previous?.revision ?? 0, generation: (previous?.generation ?? 0) + 1, dirty: true }));
}

export const putSession = (session, expectedRevision) => withTransaction(MUTATION_STORES, "readwrite", async (tx) => {
  const saved = await checkedPut(tx.objectStore("sessions"), session, expectedRevision, "Сесію");
  await touchSync(tx, "session", session.id);
  return saved;
});
export const putEntry = (entry, expectedRevision) => withTransaction(MUTATION_STORES, "readwrite", async (tx) => {
  if (!await requestAsPromise(tx.objectStore("sessions").get(entry.sessionId))) throw new Error("Тренування запису не існує");
  const saved = await checkedPut(tx.objectStore("entries"), entry, expectedRevision, "Запис");
  await touchSync(tx, "session", entry.sessionId);
  return saved;
});

export function saveSessionBundle(session, entries, expected = {}) {
  return withTransaction(MUTATION_STORES, "readwrite", async (tx) => {
    const storedSession = await checkedPut(tx.objectStore("sessions"), session, expected.sessionRevision, "Сесію");
    const storedEntries = [];
    for (const entry of entries) {
      if (entry.sessionId !== session.id) throw new Error("Запис належить іншому тренуванню");
      storedEntries.push(await checkedPut(tx.objectStore("entries"), entry, expected.entryRevisions?.[entry.id], "Запис"));
    }
    for (const setting of expected.settings ?? []) await requestAsPromise(tx.objectStore("settings").put(setting));
    await touchSync(tx, "session", session.id);
    return { session: storedSession, entries: storedEntries };
  });
}

export function deleteSession(id) {
  return withTransaction(MUTATION_STORES, "readwrite", async (tx) => {
    const entriesStore = tx.objectStore("entries");
    const related = await requestAsPromise(entriesStore.index("by-session").getAllKeys(id));
    related.forEach((key) => entriesStore.delete(key));
    tx.objectStore("sessions").delete(id);
    if ((await requestAsPromise(tx.objectStore("settings").get("activeSessionId")))?.value === id) tx.objectStore("settings").put({ key: "activeSessionId", value: null });
    await touchSync(tx, "session", id);
  });
}

export const getSetting = (key) => withTransaction(["settings"], "readonly", async (tx) => (await requestAsPromise(tx.objectStore("settings").get(key)))?.value);
export const putSetting = (key, value) => withTransaction(MUTATION_STORES, "readwrite", async (tx) => {
  await requestAsPromise(tx.objectStore("settings").put({ key, value }));
  if (!DEVICE_SETTINGS.has(key)) await touchSync(tx, "setting", key);
});

export async function exportAllData(scope = activeStorageScope) {
  return withTransaction(["sessions", "entries", "settings"], "readonly", async (tx) => ({
    sessions: await requestAsPromise(tx.objectStore("sessions").getAll()),
    entries: await requestAsPromise(tx.objectStore("entries").getAll()),
    settings: await requestAsPromise(tx.objectStore("settings").getAll()),
  }), scope);
}

export function importDataAtomic(data, { replace = false, scope = activeStorageScope } = {}) {
  return withTransaction(MUTATION_STORES, "readwrite", async (tx) => {
    const before = snapshotRecords(await readSnapshotInTransaction(tx));
    const stores = {
      sessions: tx.objectStore("sessions"),
      entries: tx.objectStore("entries"),
      settings: tx.objectStore("settings"),
    };
    if (replace) await Promise.all(Object.values(stores).map((store) => requestAsPromise(store.clear())));
    for (const session of data.sessions) await requestAsPromise(stores.sessions.put(session));
    for (const entry of data.entries) await requestAsPromise(stores.entries.put(entry));
    for (const setting of data.settings ?? []) await requestAsPromise(stores.settings.put(setting));
    const after = snapshotRecords(await readSnapshotInTransaction(tx));
    const old = new Map(before.map((row) => [recordKey(row.kind, row.id), row]));
    const next = new Map(after.map((row) => [recordKey(row.kind, row.id), row]));
    for (const [key, row] of new Map([...old, ...next])) {
      if (!sameValue(old.get(key) ?? { deleted: true }, next.get(key) ?? { deleted: true })) await touchSync(tx, row.kind, row.id);
    }
  }, scope);
}

export const exportDataForScope = (scope) => exportAllData(normalizeStorageScope(scope));
export const importDataForScope = (scope, data, options = {}) => importDataAtomic(data, {
  ...options,
  scope: normalizeStorageScope(scope),
});

/** Read-only access to the preserved pre-account database for explicit import. */
export const exportLegacyAnonymousData = () => exportDataForScope(GUEST_STORAGE_SCOPE);

export async function scopeHasWorkoutData(scope = activeStorageScope) {
  const data = await exportAllData(scope);
  return data.sessions.length > 0 || data.entries.length > 0;
}

export const hasLegacyAnonymousData = () => scopeHasWorkoutData(GUEST_STORAGE_SCOPE);

async function readSnapshotInTransaction(tx) {
  return {
    sessions: await requestAsPromise(tx.objectStore("sessions").getAll()),
    entries: await requestAsPromise(tx.objectStore("entries").getAll()),
    settings: await requestAsPromise(tx.objectStore("settings").getAll()),
  };
}

async function localValue(tx, kind, id) {
  if (kind === "setting") {
    const setting = await requestAsPromise(tx.objectStore("settings").get(id));
    return setting ? { payload: setting, deleted: false } : { payload: null, deleted: true };
  }
  const session = await requestAsPromise(tx.objectStore("sessions").get(id));
  const entries = await requestAsPromise(tx.objectStore("entries").index("by-session").getAll(id));
  entries.sort((a, b) => a.id.localeCompare(b.id));
  return session ? { payload: { session, entries }, deleted: false } : { payload: null, deleted: true };
}

async function replaceRecord(tx, row) {
  if (row.kind === "setting") {
    if (DEVICE_SETTINGS.has(row.id)) throw new Error("Хмара не може змінювати налаштування цього пристрою");
    const store = tx.objectStore("settings");
    if (row.deleted_at) await requestAsPromise(store.delete(row.id));
    else await requestAsPromise(store.put(row.payload));
    return;
  }
  const sessions = tx.objectStore("sessions");
  const entries = tx.objectStore("entries");
  const old = await requestAsPromise(entries.index("by-session").getAllKeys(row.id));
  for (const key of old) await requestAsPromise(entries.delete(key));
  if (row.deleted_at) {
    await requestAsPromise(sessions.delete(row.id));
  } else {
    if (row.payload?.session?.id !== row.id || !Array.isArray(row.payload.entries)) throw new Error("Некоректна хмарна сесія");
    await requestAsPromise(sessions.put(row.payload.session));
    for (const entry of row.payload.entries) {
      if (entry.sessionId !== row.id) throw new Error("Хмарний запис посилається на інше тренування");
      const existing = await requestAsPromise(entries.get(entry.id));
      if (existing && existing.sessionId !== row.id) throw new Error("Повторний ID вправи між тренуваннями");
      await requestAsPromise(entries.put(entry));
    }
  }
  const active = (await requestAsPromise(tx.objectStore("settings").get("activeSessionId")))?.value;
  if (active === row.id && (row.deleted_at || row.payload?.session?.status !== "draft")) {
    await requestAsPromise(tx.objectStore("settings").put({ key: "activeSessionId", value: null }));
  }
}

const conflictFor = (state, row, value) => ({ key: state.key, kind: state.kind, id: state.id,
  generation: state.generation, remote: clone(row), local: clone(value) });

/** Local changes, generations, pending operations and cloud application share one IDB transaction. */
export function createScopedRecordStore(scope) {
  const normalized = normalizeStorageScope(scope);
  const transaction = (mode, callback) => withTransaction(MUTATION_STORES, mode, callback, normalized);
  const bootstrap = async () => {
    await transaction("readwrite", async (tx) => {
      const store = tx.objectStore("sync_records");
      if (await requestAsPromise(store.get("meta"))) return;
      let legacy = null;
      try { legacy = JSON.parse(globalThis.localStorage?.getItem(`workout-program:cloud-sync:${normalized}`) ?? "null"); } catch { /* No legacy metadata. */ }
      const current = snapshotRecords(await readSnapshotInTransaction(tx));
      let baseline = [];
      let hasBaseline = false;
      if (legacy?.fingerprint) {
        try { baseline = snapshotRecords(JSON.parse(legacy.fingerprint)); hasBaseline = true; } catch { /* Preserve explicitly pending records instead. */ }
      }
      const currentMap = new Map(current.map((row) => [recordKey(row.kind, row.id), row]));
      const baseMap = new Map(baseline.map((row) => [recordKey(row.kind, row.id), row]));
      for (const [key, row] of new Map([...baseMap, ...currentMap])) {
        if (await requestAsPromise(store.get(key))) continue;
        const value = currentMap.get(key) ?? { payload: null, deleted: true };
        const base = baseMap.get(key);
        // Detect v2's crash window: data may have committed before localStorage.pending.
        const dirty = Boolean((legacy?.pending || hasBaseline) && (!base || !sameValue(value, base)));
        await requestAsPromise(store.put({ key, kind: row.kind, id: row.id, revision: dirty ? legacy?.revision ?? 0 : 0,
          generation: 0, dirty, ...(dirty && base ? { baseValue: { payload: base.payload, deleted: false } } : {}) }));
      }
      await requestAsPromise(store.put({ key: "meta", initialized: false }));
    });
    // The v2 fingerprint can be a complete copy of the user's history. It is no
    // longer needed after the migration state/outbox has committed durably.
    try { globalThis.localStorage?.removeItem?.(`workout-program:cloud-sync:${normalized}`); } catch { /* IDB remains authoritative. */ }
  };

  return Object.freeze({
    scope: normalized, bootstrap,
    exportSnapshot: () => exportAllData(normalized),
    importSnapshot: (snapshot) => importDataAtomic(snapshot, { replace: true, scope: normalized }),
    async state() {
      await bootstrap();
      return transaction("readonly", async (tx) => {
        const rows = await requestAsPromise(tx.objectStore("sync_records").getAll());
        return { initialized: Boolean(rows.find((row) => row.key === "meta")?.initialized),
          versions: Object.fromEntries(rows.filter((row) => row.kind && row.revision > 0).map((row) => [row.key, row.revision])),
          pending: rows.filter((row) => row.dirty).map(({ key, kind, id }) => ({ key, kind, id })) };
      });
    },
    async prepare(key) {
      return transaction("readwrite", async (tx) => {
        const store = tx.objectStore("sync_records");
        const state = await requestAsPromise(store.get(key));
        if (!state?.dirty) return null;
        if (!state.operation) {
          const value = await localValue(tx, state.kind, state.id);
          state.operation = { operation_id: crypto.randomUUID(), kind: state.kind, id: state.id, expected_revision: state.revision,
            generation: state.generation, format_version: 1, ...value };
          await requestAsPromise(store.put(state));
        }
        return clone(state.operation);
      });
    },
    async acknowledge(operation, accepted) {
      return transaction("readwrite", async (tx) => {
        const store = tx.objectStore("sync_records");
        const state = await requestAsPromise(store.get(recordKey(operation.kind, operation.id)));
        if (state?.operation?.operation_id !== operation.operation_id) return;
        state.revision = Number(accepted.revision);
        state.dirty = state.generation !== operation.generation;
        delete state.operation;
        delete state.baseValue;
        await requestAsPromise(store.put(state));
      });
    },
    async applyRemote(row) {
      if (row.format_version !== 1) throw new Error("Оновіть застосунок для нового формату історії");
      return transaction("readwrite", async (tx) => {
        const store = tx.objectStore("sync_records");
        const key = recordKey(row.kind, row.id);
        const state = await requestAsPromise(store.get(key)) ?? { key, kind: row.kind, id: row.id, revision: 0, generation: 0, dirty: false };
        if (row.revision <= state.revision && !state.baseValue && !(row.missing && state.dirty)) return { changed: false };
        // An open draft may have UI input not yet persisted by the debounce timer.
        // Never replace that editor silently, even if its last saved generation is clean.
        const active = (await requestAsPromise(tx.objectStore("settings").get("activeSessionId")))?.value;
        if (!state.dirty && row.kind === "session" && active === row.id) {
          const value = await localValue(tx, "session", row.id);
          if (value.payload?.session?.status === "draft" && !sameValue(value, valueOfRemote(row))) {
            state.dirty = true;
            state.generation += 1;
            await requestAsPromise(store.put(state));
            return { conflict: conflictFor(state, row, value), changed: false };
          }
        }
        if (state.dirty) {
          const value = await localValue(tx, state.kind, state.id);
          if (sameValue(value, valueOfRemote(row))) {
            state.dirty = false;
            delete state.operation;
          } else if (state.baseValue && sameValue(state.baseValue, valueOfRemote(row))) {
            delete state.operation;
          } else return { conflict: conflictFor(state, row, value), changed: false };
          state.revision = row.revision;
          delete state.baseValue;
          await requestAsPromise(store.put(state));
          return { changed: false, rebased: state.dirty };
        }
        await replaceRecord(tx, row);
        await requestAsPromise(store.put({ key, kind: row.kind, id: row.id, revision: row.revision,
          generation: state.generation + 1, dirty: false }));
        return { changed: true };
      });
    },
    async finishInitialization(remoteKeys) {
      return transaction("readwrite", async (tx) => {
        const store = tx.objectStore("sync_records");
        const meta = await requestAsPromise(store.get("meta"));
        if (meta?.initialized) return false;
        const rows = await requestAsPromise(store.getAll());
        let changed = false;
        for (const state of rows) {
          if (!state.kind || state.dirty || state.revision > 0 || remoteKeys.includes(state.key)) continue;
          await replaceRecord(tx, { kind: state.kind, id: state.id, deleted_at: new Date().toISOString() });
          await requestAsPromise(store.delete(state.key));
          changed = true;
        }
        await requestAsPromise(store.put({ key: "meta", initialized: true }));
        return changed;
      });
    },
    async resolve(conflict, row, strategy) {
      return transaction("readwrite", async (tx) => {
        const store = tx.objectStore("sync_records");
        const state = await requestAsPromise(store.get(conflict.key));
        if (!state?.dirty) return { changed: false };
        if (state.generation !== conflict.generation || row.revision !== conflict.remote.revision) {
          return { conflict: conflictFor(state, row, await localValue(tx, state.kind, state.id)) };
        }
        if (strategy === "cloud") await replaceRecord(tx, row);
        state.revision = row.revision;
        state.dirty = strategy === "local";
        state.generation += 1;
        delete state.operation;
        delete state.baseValue;
        await requestAsPromise(store.put(state));
        return { changed: strategy === "cloud" };
      });
    },
  });
}
