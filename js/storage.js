export const DB_NAME = "workout-program";
export const DB_VERSION = 1;

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

export function openDatabase() {
  if (!("indexedDB" in globalThis)) return Promise.reject(new Error("IndexedDB недоступна"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Закрийте інші вкладки для оновлення бази"));
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("sessions")) {
        const sessions = db.createObjectStore("sessions", { keyPath: "id" });
        sessions.createIndex("by-workout-date", "workoutDate");
        sessions.createIndex("by-status", "status");
        sessions.createIndex("by-performed-at", "performedAt");
      }
      if (!db.objectStoreNames.contains("entries")) {
        const entries = db.createObjectStore("entries", { keyPath: "id" });
        entries.createIndex("by-session", "sessionId");
        entries.createIndex("by-exercise", ["exerciseId", "variantId", "equipmentKey"]);
        entries.createIndex("unique-session-slot", ["sessionId", "slotId", "exerciseId"], { unique: true });
      }
      if (!db.objectStoreNames.contains("settings")) db.createObjectStore("settings", { keyPath: "key" });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
  });
}

async function withTransaction(storeNames, mode, callback) {
  const db = await openDatabase();
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

export async function exportAllData() {
  return withTransaction(["sessions", "entries", "settings"], "readonly", async (tx) => ({
    sessions: await requestAsPromise(tx.objectStore("sessions").getAll()),
    entries: await requestAsPromise(tx.objectStore("entries").getAll()),
    settings: await requestAsPromise(tx.objectStore("settings").getAll()),
  }));
}

export function importDataAtomic(data, { replace = false } = {}) {
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
  });
}
