import { migrateLegacyData } from "./migrations.js";
import { exportAllData, importDataAtomic } from "./storage.js";

export const BACKUP_APP_ID = "workout-program";
export const BACKUP_SCHEMA_VERSION = 2;

const METRICS = new Set(["load-reps", "reps", "duration"]);
const PROTECTED_LOCAL_SETTINGS = new Set(["activeSessionId", "currentProgramId"]);
const isIsoDate = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const isRevision = (value) => Number.isInteger(value) && value >= 0;
const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
const isWorkoutDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
};

const setIsValid = (set, entryMetric) => {
  if (!set || typeof set !== "object") return false;
  if (!isNonEmptyString(set.id) || !Number.isInteger(set.order) || set.order <= 0) return false;
  if (typeof set.confirmed !== "boolean" || !METRICS.has(set.metric) || set.metric !== entryMetric) return false;
  if (set.completedAt !== null && set.completedAt !== undefined && !isIsoDate(set.completedAt)) return false;
  if (set.loadKg !== null && set.loadKg !== undefined && (typeof set.loadKg !== "number" || !Number.isFinite(set.loadKg) || set.loadKg < 0)) return false;
  if (set.reps !== null && set.reps !== undefined && (!Number.isInteger(set.reps) || set.reps <= 0)) return false;
  if (set.durationSeconds !== null && set.durationSeconds !== undefined && (!Number.isInteger(set.durationSeconds) || set.durationSeconds <= 0)) return false;
  if (!["both", "left", "right"].includes(set.side) || !["working", "warmup"].includes(set.kind)) return false;
  if (!set.confirmed) return true;
  if (set.metric === "load-reps") return set.loadKg !== null && set.loadKg !== undefined && set.reps !== null && set.reps !== undefined;
  if (set.metric === "reps") return set.reps !== null && set.reps !== undefined;
  return set.durationSeconds !== null && set.durationSeconds !== undefined;
};

const validateDataCollections = (payload, { legacy = false } = {}) => {
  const errors = [];
  if (!Array.isArray(payload.sessions) || !Array.isArray(payload.entries) || (payload.settings !== undefined && !Array.isArray(payload.settings))) {
    return ["Немає коректних масивів sessions/entries/settings"];
  }
  const sessionIds = new Set();
  for (const session of payload.sessions) {
    if (!isNonEmptyString(session?.id) || sessionIds.has(session.id)) errors.push(`Некоректний або повторний ID сесії: ${session?.id ?? "—"}`);
    sessionIds.add(session?.id);
    const commonValid = isNonEmptyString(session?.dayId)
      && isWorkoutDate(session?.workoutDate)
      && isRevision(session?.revision)
      && isIsoDate(session?.performedAt)
      && ["draft", "completed"].includes(session?.status)
      && (session?.completedAt === null || session?.completedAt === undefined || isIsoDate(session.completedAt));
    const v2Valid = legacy || (isNonEmptyString(session?.programId)
      && Number.isInteger(session?.programVersion) && session.programVersion > 0
      && isNonEmptyString(session?.programNameSnapshot)
      && isNonEmptyString(session?.dayNameSnapshot)
      && isIsoDate(session?.createdAt)
      && isIsoDate(session?.updatedAt));
    if (!commonValid || !v2Valid || (legacy && !["a", "b", "c"].includes(session.dayId))) {
      errors.push(`Некоректна сесія: ${session?.id ?? "—"}`);
    }
  }
  const sessionsById = new Map(payload.sessions.map((session) => [session.id, session]));

  const entryIds = new Set();
  const sessionSlots = new Set();
  for (const entry of payload.entries) {
    if (!isNonEmptyString(entry?.id) || entryIds.has(entry.id)) errors.push(`Некоректний або повторний ID запису: ${entry?.id ?? "—"}`);
    entryIds.add(entry?.id);
    if (!sessionIds.has(entry?.sessionId)) errors.push(`Запис ${entry?.id ?? "—"} посилається на відсутню сесію`);
    const sets = entry?.sets;
    const setIds = new Set();
    const setOrders = new Set();
    const validSets = Array.isArray(sets) && sets.every((set) => {
      const unique = !setIds.has(set?.id) && !setOrders.has(set?.order);
      setIds.add(set?.id);
      setOrders.add(set?.order);
      return unique && setIsValid(set, entry.metric);
    });
    const commonValid = isNonEmptyString(entry?.sessionId)
      && isNonEmptyString(entry?.slotId)
      && isNonEmptyString(entry?.exerciseId)
      && isNonEmptyString(entry?.variantId)
      && isNonEmptyString(entry?.equipmentKey)
      && METRICS.has(entry?.metric)
      && isRevision(entry?.revision)
      && validSets;
    const relatedSession = sessionsById.get(entry?.sessionId);
    const v2Valid = legacy || (isNonEmptyString(entry?.programId)
      && entry.programId === relatedSession?.programId
      && entry.slotId.includes(":")
      && isNonEmptyString(entry?.choiceId)
      && isNonEmptyString(entry?.loadConvention)
      && isNonEmptyString(entry?.exerciseNameSnapshot)
      && isNonEmptyString(entry?.variantSnapshot)
      && typeof entry?.notes === "string"
      && isIsoDate(entry?.updatedAt));
    if (!commonValid || !v2Valid) errors.push(`Некоректний запис вправи: ${entry?.id ?? "—"}`);
    if (!legacy) {
      const sessionSlotKey = `${entry?.sessionId}\u0000${entry?.slotId}`;
      if (sessionSlots.has(sessionSlotKey)) errors.push(`Повторний слот ${entry?.slotId ?? "—"} у сесії ${entry?.sessionId ?? "—"}`);
      sessionSlots.add(sessionSlotKey);
    }
  }

  const settingKeys = new Set();
  for (const setting of payload.settings ?? []) {
    if (!isNonEmptyString(setting?.key) || settingKeys.has(setting.key) || !("value" in setting)) {
      errors.push(`Некоректне або повторне налаштування: ${setting?.key ?? "—"}`);
    }
    settingKeys.add(setting?.key);
    if (setting?.key === "activeSessionId" && setting.value !== null && !isNonEmptyString(setting.value)) errors.push("Некоректне активне тренування");
    if (!legacy && setting?.key === "activeSessionId" && setting.value) {
      const activeSession = sessionsById.get(setting.value);
      if (activeSession?.status !== "draft") errors.push("Активне тренування відсутнє або вже завершене");
    }
    if (setting?.key === "currentProgramId" && !isNonEmptyString(setting.value)) errors.push("Некоректна поточна програма");
  }
  return errors;
};

const validationError = (errors) => {
  const error = new Error(errors.join("\n"));
  error.name = "BackupValidationError";
  error.errors = errors;
  return error;
};

export function normalizeBackupPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw validationError(["Файл не містить JSON-об'єкт"]);
  if (payload.appId !== BACKUP_APP_ID) throw validationError(["Це файл іншого застосунку"]);
  if (!Number.isInteger(payload.schemaVersion)) throw validationError(["Не вказано версію резервної копії"]);
  if (payload.schemaVersion > BACKUP_SCHEMA_VERSION) throw validationError(["Файл створено новішою версією застосунку"]);
  if (![1, BACKUP_SCHEMA_VERSION].includes(payload.schemaVersion)) throw validationError(["Непідтримувана версія резервної копії"]);

  let normalized;
  let migratedFrom = null;
  if (payload.schemaVersion === 1) {
    const legacyErrors = validateDataCollections(payload, { legacy: true });
    if (legacyErrors.length) throw validationError(legacyErrors);
    normalized = {
      ...payload,
      schemaVersion: BACKUP_SCHEMA_VERSION,
      ...migrateLegacyData(payload),
    };
    migratedFrom = 1;
  } else {
    normalized = {
      ...payload,
      sessions: payload.sessions?.map((item) => ({ ...item })),
      entries: payload.entries?.map((item) => ({ ...item, sets: item.sets?.map((set) => ({ ...set })) })),
      settings: payload.settings?.map((item) => ({ ...item })) ?? [],
    };
  }
  const errors = validateDataCollections(normalized);
  if (errors.length) throw validationError(errors);
  return { payload: normalized, migratedFrom };
}

export function validateBackup(payload) {
  try {
    const normalized = normalizeBackupPayload(payload);
    return { valid: true, errors: [], normalized: normalized.payload, migratedFrom: normalized.migratedFrom };
  } catch (error) {
    return { valid: false, errors: error.errors ?? [error.message] };
  }
}

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

export function planMerge(current, incoming) {
  const result = { sessions: [], entries: [], settings: [] };
  const conflicts = [];
  const duplicates = [];
  for (const collection of ["sessions", "entries"]) {
    const existing = new Map((current[collection] ?? []).map((record) => [record.id, record]));
    const existingBySessionSlot = collection === "entries"
      ? new Map((current.entries ?? []).map((record) => [`${record.sessionId}\u0000${record.slotId}`, record]))
      : null;
    result[collection] = [...(current[collection] ?? [])];
    for (const record of incoming[collection] ?? []) {
      const old = existing.get(record.id);
      const slotCollision = !old && existingBySessionSlot?.get(`${record.sessionId}\u0000${record.slotId}`);
      if (slotCollision) conflicts.push({ collection, id: slotCollision.id, current: slotCollision, incoming: record, reason: "session-slot" });
      else if (!old) {
        result[collection].push(record);
        existingBySessionSlot?.set(`${record.sessionId}\u0000${record.slotId}`, record);
      }
      else if (canonical(old) === canonical(record)) duplicates.push({ collection, id: record.id });
      else conflicts.push({ collection, id: record.id, current: old, incoming: record });
    }
  }

  const settingMap = new Map((current.settings ?? []).map((setting) => [setting.key, setting]));
  for (const setting of incoming.settings ?? []) {
    if (!PROTECTED_LOCAL_SETTINGS.has(setting.key)) settingMap.set(setting.key, setting);
  }
  let localActive = settingMap.get("activeSessionId");
  if (localActive?.value && !result.sessions.some((session) => session.id === localActive.value && session.status === "draft")) {
    settingMap.delete("activeSessionId");
    localActive = null;
  }
  const incomingActive = (incoming.settings ?? []).find((setting) => setting.key === "activeSessionId");
  if (!localActive?.value && incomingActive?.value) {
    const importedActiveIsDraft = result.sessions.some((session) => session.id === incomingActive.value && session.status === "draft");
    if (importedActiveIsDraft) settingMap.set("activeSessionId", incomingActive);
  }
  const localProgram = settingMap.get("currentProgramId");
  const incomingProgram = (incoming.settings ?? []).find((setting) => setting.key === "currentProgramId");
  if (!localProgram?.value && incomingProgram?.value) settingMap.set("currentProgramId", incomingProgram);
  result.settings = [...settingMap.values()];
  return {
    data: result,
    conflicts,
    duplicates,
    additions: result.sessions.length + result.entries.length - (current.sessions?.length ?? 0) - (current.entries?.length ?? 0),
  };
}

export async function createBackup() {
  const data = await exportAllData();
  return { appId: BACKUP_APP_ID, schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: new Date().toISOString(), ...data };
}

export async function restoreBackup(payload, options = {}) {
  const normalized = normalizeBackupPayload(payload).payload;
  if (options.replace) return importDataAtomic(normalized, { replace: true });
  const current = await exportAllData();
  const plan = planMerge(current, normalized);
  if (plan.conflicts.length && !options.allowConflicts) {
    const error = new Error(`Знайдено конфлікти: ${plan.conflicts.map((item) => `${item.collection}/${item.id}`).join(", ")}`);
    error.name = "BackupConflictError";
    error.conflicts = plan.conflicts;
    throw error;
  }
  if (options.allowConflicts === "incoming") {
    for (const conflict of plan.conflicts) {
      const collection = plan.data[conflict.collection];
      const index = collection.findIndex((item) => item.id === conflict.id);
      collection[index] = conflict.incoming;
    }
  }
  return importDataAtomic(plan.data, { replace: true });
}

export function downloadBackup(payload, filename = `workout-program-${new Date().toISOString().slice(0, 10)}.json`) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
