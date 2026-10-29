import { exportAllData, importDataAtomic } from "./storage.js";

export const BACKUP_APP_ID = "workout-program";
export const BACKUP_SCHEMA_VERSION = 1;

const isIsoDate = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value));
const METRICS = new Set(["load-reps", "reps", "duration"]);
const isRevision = (value) => Number.isInteger(value) && value >= 0;
const isWorkoutDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`));

const setIsValid = (set, entryMetric) => {
  if (!set || typeof set !== "object") return false;
  if (typeof set.id !== "string" || !set.id || !Number.isInteger(set.order) || set.order <= 0) return false;
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

export function validateBackup(payload) {
  const errors = [];
  if (!payload || typeof payload !== "object") return { valid: false, errors: ["Файл не містить JSON-об'єкт"] };
  if (payload.appId !== BACKUP_APP_ID) errors.push("Це файл іншого застосунку");
  if (payload.schemaVersion !== BACKUP_SCHEMA_VERSION) errors.push(payload.schemaVersion > BACKUP_SCHEMA_VERSION ? "Файл створено новішою версією застосунку" : "Непідтримувана версія резервної копії");
  if (!Array.isArray(payload.sessions) || !Array.isArray(payload.entries)) errors.push("Немає масивів sessions/entries");
  if (errors.length) return { valid: false, errors };
  const sessionIds = new Set();
  for (const session of payload.sessions) {
    if (typeof session?.id !== "string" || !session.id || sessionIds.has(session.id)) errors.push(`Некоректний або повторний ID сесії: ${session?.id ?? "—"}`);
    sessionIds.add(session?.id);
    if (!["a", "b", "c"].includes(session?.dayId)
      || !isWorkoutDate(session?.workoutDate)
      || !isRevision(session?.revision)
      || !isIsoDate(session?.performedAt)
      || !["draft", "completed"].includes(session?.status)
      || (session?.completedAt !== null && session?.completedAt !== undefined && !isIsoDate(session.completedAt))) {
      errors.push(`Некоректна сесія: ${session?.id ?? "—"}`);
    }
  }
  const entryIds = new Set();
  for (const entry of payload.entries) {
    if (typeof entry?.id !== "string" || !entry.id || entryIds.has(entry.id)) errors.push(`Некоректний або повторний ID запису: ${entry?.id ?? "—"}`);
    entryIds.add(entry?.id);
    if (!sessionIds.has(entry?.sessionId)) errors.push(`Запис ${entry?.id ?? "—"} посилається на відсутню сесію`);
    if (typeof entry?.sessionId !== "string"
      || typeof entry?.slotId !== "string" || !entry.slotId
      || typeof entry?.exerciseId !== "string" || !entry.exerciseId
      || typeof entry?.variantId !== "string" || !entry.variantId
      || typeof entry?.equipmentKey !== "string" || !entry.equipmentKey
      || !METRICS.has(entry?.metric)
      || !isRevision(entry?.revision)
      || !Array.isArray(entry?.sets)
      || !entry.sets.every((set) => setIsValid(set, entry.metric))) {
      errors.push(`Некоректний запис вправи: ${entry?.id ?? "—"}`);
    }
  }
  return { valid: errors.length === 0, errors };
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
    result[collection] = [...(current[collection] ?? [])];
    for (const record of incoming[collection] ?? []) {
      const old = existing.get(record.id);
      if (!old) {
        result[collection].push(record);
      } else if (canonical(old) === canonical(record)) {
        duplicates.push({ collection, id: record.id });
      } else {
        conflicts.push({ collection, id: record.id, current: old, incoming: record });
      }
    }
  }
  const settingMap = new Map((current.settings ?? []).map((setting) => [setting.key, setting]));
  for (const setting of incoming.settings ?? []) {
    if (setting.key !== "activeSessionId") settingMap.set(setting.key, setting);
  }
  const currentActive = settingMap.get("activeSessionId");
  const incomingActive = (incoming.settings ?? []).find((setting) => setting.key === "activeSessionId");
  if (!currentActive?.value && incomingActive?.value) {
    const importedActiveIsDraft = result.sessions.some((session) => session.id === incomingActive.value && session.status === "draft");
    if (importedActiveIsDraft) settingMap.set("activeSessionId", incomingActive);
  }
  result.settings = [...settingMap.values()];
  return { data: result, conflicts, duplicates, additions: result.sessions.length + result.entries.length - (current.sessions?.length ?? 0) - (current.entries?.length ?? 0) };
}

export async function createBackup() {
  const data = await exportAllData();
  return { appId: BACKUP_APP_ID, schemaVersion: BACKUP_SCHEMA_VERSION, exportedAt: new Date().toISOString(), ...data };
}

export async function restoreBackup(payload, options = {}) {
  const validation = validateBackup(payload);
  if (!validation.valid) throw new Error(validation.errors.join("\n"));
  if (options.replace) return importDataAtomic(payload, { replace: true });
  const current = await exportAllData();
  const plan = planMerge(current, payload);
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
