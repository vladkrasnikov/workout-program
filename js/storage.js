import { LEGACY_PROGRAM_ID, migrateLegacyData } from "./migrations.js";

export const DB_NAME = "workout-program";
export const DB_VERSION = 2;
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

export const putSession = (session, expectedRevision) => withTransaction(["sessions"], "readwrite", (tx) => checkedPut(tx.objectStore("sessions"), session, expectedRevision, "Сесію"));
export const putEntry = (entry, expectedRevision) => withTransaction(["entries"], "readwrite", (tx) => checkedPut(tx.objectStore("entries"), entry, expectedRevision, "Запис"));

export function saveSessionBundle(session, entries, expected = {}) {
  return withTransaction(["sessions", "entries"], "readwrite", async (tx) => {
    const storedSession = await checkedPut(tx.objectStore("sessions"), session, expected.sessionRevision, "Сесію");
    const storedEntries = [];
    for (const entry of entries) {
      storedEntries.push(await checkedPut(tx.objectStore("entries"), entry, expected.entryRevisions?.[entry.id], "Запис"));
    }
    return { session: storedSession, entries: storedEntries };
  });
}

export function deleteSession(id) {
  return withTransaction(["sessions", "entries"], "readwrite", async (tx) => {
    const entriesStore = tx.objectStore("entries");
    const related = await requestAsPromise(entriesStore.index("by-session").getAllKeys(id));
    related.forEach((key) => entriesStore.delete(key));
    tx.objectStore("sessions").delete(id);
  });
}

export const getSetting = (key) => withTransaction(["settings"], "readonly", async (tx) => (await requestAsPromise(tx.objectStore("settings").get(key)))?.value);
export const putSetting = (key, value) => withTransaction(["settings"], "readwrite", (tx) => requestAsPromise(tx.objectStore("settings").put({ key, value })));

export async function exportAllData(scope = activeStorageScope) {
  return withTransaction(["sessions", "entries", "settings"], "readonly", async (tx) => ({
    sessions: await requestAsPromise(tx.objectStore("sessions").getAll()),
    entries: await requestAsPromise(tx.objectStore("entries").getAll()),
    settings: await requestAsPromise(tx.objectStore("settings").getAll()),
  }), scope);
}

export function importDataAtomic(data, { replace = false, scope = activeStorageScope } = {}) {
  return withTransaction(["sessions", "entries", "settings"], "readwrite", async (tx) => {
    const stores = {
      sessions: tx.objectStore("sessions"),
      entries: tx.objectStore("entries"),
      settings: tx.objectStore("settings"),
    };
    if (replace) await Promise.all(Object.values(stores).map((store) => requestAsPromise(store.clear())));
    for (const session of data.sessions) await requestAsPromise(stores.sessions.put(session));
    for (const entry of data.entries) await requestAsPromise(stores.entries.put(entry));
    for (const setting of data.settings ?? []) await requestAsPromise(stores.settings.put(setting));
  }, scope);
}

export const exportDataForScope = (scope) => exportAllData(normalizeStorageScope(scope));
export const importDataForScope = (scope, data, options = {}) => importDataAtomic(data, {
  ...options,
  scope: normalizeStorageScope(scope),
});

export async function scopeHasWorkoutData(scope = activeStorageScope) {
  const data = await exportAllData(scope);
  return data.sessions.length > 0 || data.entries.length > 0;
}
