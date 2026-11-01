import {
  DEFAULT_PROGRAM_ID,
  PROGRAM_VERSION,
  getCardsForDay,
  getChoice,
  getDay,
  getMovement,
  getProgram,
} from "./program.js";
import * as storage from "./storage.js";

const randomId = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
export const comparisonKey = (entry) => `${entry.exerciseId}|${entry.variantId}|${entry.equipmentKey ?? "default"}|${entry.loadConvention ?? "total"}|${entry.metric ?? "load-reps"}`;

const setCountFor = (movement) => {
  const sets = movement?.prescription?.sets ?? movement?.sets;
  if (Number.isInteger(sets) && sets > 0) return sets;
  if (sets && typeof sets === "object") {
    const preferred = sets.default ?? sets.min ?? sets.max;
    if (Number.isInteger(preferred) && preferred > 0) return preferred;
  }
  return 1;
};

const programIdFromSlot = (slotId) => typeof slotId === "string" && slotId.includes(":")
  ? slotId.split(":", 1)[0]
  : DEFAULT_PROGRAM_ID;

const movementsForDay = (programId, dayId) => {
  const seen = new Set();
  return (getCardsForDay(programId, dayId) ?? []).flatMap((card) => card.movements ?? [])
    .map((movement) => typeof movement === "string" ? getMovement(movement) : movement)
    .filter((movement) => movement?.slotId && !seen.has(movement.slotId) && seen.add(movement.slotId));
};

export function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseLocalizedNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || !value.trim()) return null;
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function validateSet(input, metric = "load-reps") {
  const loadKg = parseLocalizedNumber(input.loadKg);
  const reps = parseLocalizedNumber(input.reps);
  const durationSeconds = parseLocalizedNumber(input.durationSeconds);
  const errors = {};
  if (metric === "load-reps" && (loadKg === null || loadKg < 0)) errors.loadKg = "Вкажіть вагу";
  if ((metric === "load-reps" || metric === "reps") && (!Number.isInteger(reps) || reps <= 0)) errors.reps = "Повтори мають бути цілим додатним числом";
  if (metric === "duration" && (!Number.isInteger(durationSeconds) || durationSeconds <= 0)) errors.durationSeconds = "Секунди мають бути цілим додатним числом";
  return { valid: Object.keys(errors).length === 0, errors, values: { loadKg: metric === "load-reps" ? loadKg : null, reps: metric === "duration" ? null : reps, durationSeconds: metric === "duration" ? durationSeconds : null } };
}

export function makeDraftSet(order, metric, values = {}) {
  return {
    id: values.id ?? randomId("set"),
    order,
    kind: values.kind ?? "working",
    loadKg: values.loadKg ?? null,
    reps: values.reps ?? null,
    durationSeconds: values.durationSeconds ?? null,
    side: values.side ?? "both",
    confirmed: values.confirmed ?? false,
    completedAt: values.completedAt ?? null,
    metric,
  };
}

export function createSessionDraft(programId, dayId, options = {}) {
  if (typeof dayId === "object") {
    options = dayId;
    dayId = programId;
    programId = DEFAULT_PROGRAM_ID;
  }
  const program = getProgram(programId);
  const day = getDay(programId, dayId);
  if (!program) throw new Error(`Невідома програма: ${programId}`);
  if (!day) throw new Error(`Невідомий день: ${programId}/${dayId}`);
  const performedDate = options.performedAt ? new Date(options.performedAt) : new Date();
  const createdDate = options.createdAt ? new Date(options.createdAt) : new Date();
  if (Number.isNaN(performedDate.getTime())) throw new Error("Некоректна дата або час тренування");
  if (Number.isNaN(createdDate.getTime())) throw new Error("Некоректна дата створення запису");
  const performedAt = performedDate.toISOString();
  const createdAt = createdDate.toISOString();
  const sessionId = options.id ?? randomId("session");
  const session = {
    id: sessionId,
    programId,
    dayId,
    programVersion: program.version ?? PROGRAM_VERSION,
    programNameSnapshot: program.name,
    dayNameSnapshot: day.name,
    workoutDate: options.workoutDate ?? localDateString(performedDate),
    performedAt,
    createdAt,
    updatedAt: createdAt,
    status: "draft",
    completedAt: null,
    revision: 0,
  };
  const entries = movementsForDay(programId, dayId).map((movement) => createEntryDraft(sessionId, movement.slotId, movement.defaultChoiceId, { programId }));
  return { session, entries };
}

export function createEntryDraft(sessionId, slotId, choiceId, options = {}) {
  const movement = getMovement(slotId);
  const resolvedChoiceId = choiceId ?? movement?.defaultChoiceId;
  const chosen = getChoice(slotId, resolvedChoiceId);
  if (!movement || !chosen) throw new Error(`Невідомий слот або варіант: ${slotId}/${resolvedChoiceId}`);
  const programId = options.programId ?? programIdFromSlot(slotId);
  return {
    id: `${sessionId}:${slotId}`,
    sessionId,
    programId,
    slotId,
    choiceId: chosen.id,
    exerciseId: chosen.exerciseId,
    variantId: chosen.variantId,
    equipmentKey: chosen.equipmentKey ?? "default",
    loadConvention: chosen.loadConvention ?? "total",
    exerciseNameSnapshot: chosen.exerciseName ?? movement.exerciseName ?? movement.name ?? chosen.name,
    variantSnapshot: chosen.name,
    metric: chosen.metric ?? "load-reps",
    sets: Array.from({ length: setCountFor(movement) }, (_, index) => makeDraftSet(index + 1, chosen.metric ?? "load-reps")),
    notes: "",
    revision: 0,
    updatedAt: new Date().toISOString(),
  };
}

export function changeEntryChoice(entry, choiceId) {
  const replacement = createEntryDraft(entry.sessionId, entry.slotId, choiceId, { programId: entry.programId });
  return {
    ...replacement,
    id: entry.id,
    notes: entry.notes ?? "",
    revision: entry.revision ?? 0,
    updatedAt: new Date().toISOString(),
  };
}

export function validWorkingSets(entry) {
  return (entry.sets ?? []).filter((set) => set.kind === "working" && set.confirmed && validateSet(set, entry.metric).valid);
}

export function findPreviousResult(targetEntry, sessions, entries, before = null) {
  const sessionMap = new Map(sessions.map((session) => [session.id, session]));
  const cutoff = before ?? sessionMap.get(targetEntry.sessionId)?.performedAt ?? new Date().toISOString();
  return entries
    .filter((entry) => entry.id !== targetEntry.id && comparisonKey(entry) === comparisonKey(targetEntry) && validWorkingSets(entry).length > 0)
    .map((entry) => ({ entry, session: sessionMap.get(entry.sessionId) }))
    .filter(({ session }) => session?.status === "completed" && session.performedAt < cutoff)
    .sort((a, b) => b.session.performedAt.localeCompare(a.session.performedAt))[0] ?? null;
}

/**
 * Returns the highest confirmed working load for a compatible movement.
 *
 * The value is intentionally derived from completed history instead of stored
 * separately. Deloads remain in history without lowering the anchor, and
 * removing the top session automatically reveals the next highest load.
 */
export function findStableWorkingLoad(targetEntry, sessions, entries, before = null) {
  if ((targetEntry?.metric ?? "load-reps") !== "load-reps") return null;
  const sessionMap = new Map(sessions.map((session) => [session.id, session]));
  const candidates = [];

  for (const entry of entries) {
    if (comparisonKey(entry) !== comparisonKey(targetEntry)) continue;
    const session = sessionMap.get(entry.sessionId);
    if (session?.status !== "completed" || (before && session.performedAt >= before)) continue;
    const loadSets = validWorkingSets(entry).filter((set) => Number.isFinite(set.loadKg));
    if (!loadSets.length) continue;
    const maxLoad = Math.max(...loadSets.map((set) => set.loadKg));
    const set = loadSets
      .filter((item) => item.loadKg === maxLoad)
      .sort((a, b) => String(b.completedAt ?? "").localeCompare(String(a.completedAt ?? "")) || b.order - a.order)[0];
    candidates.push({ loadKg: maxLoad, set, entry, session });
  }

  return candidates.sort((a, b) => (
    b.loadKg - a.loadKg
    || b.session.performedAt.localeCompare(a.session.performedAt)
    || String(b.set.completedAt ?? b.entry.updatedAt ?? "").localeCompare(String(a.set.completedAt ?? a.entry.updatedAt ?? ""))
  ))[0] ?? null;
}

export function completeSessionDraft(session, entries, now = new Date()) {
  const timestamp = now.toISOString();
  return { ...session, status: "completed", completedAt: timestamp, updatedAt: timestamp, confirmedSetCount: entries.reduce((sum, entry) => sum + validWorkingSets(entry).length, 0) };
}

export async function startSession(programId, dayId, options = {}) {
  if (typeof dayId === "object") {
    options = dayId;
    dayId = programId;
    programId = DEFAULT_PROGRAM_ID;
  }
  const draft = createSessionDraft(programId, dayId, options);
  const saved = await storage.saveSessionBundle(draft.session, draft.entries, { sessionRevision: 0, entryRevisions: Object.fromEntries(draft.entries.map((entry) => [entry.id, 0])) });
  await storage.putSetting("activeSessionId", saved.session.id);
  await storage.putSetting("currentProgramId", saved.session.programId);
  return saved;
}

export async function getActiveSession() {
  const id = await storage.getSetting("activeSessionId");
  if (!id) return null;
  const session = await storage.getSession(id);
  if (!session || session.status !== "draft") return null;
  return { session, entries: await storage.listEntriesForSession(id) };
}

export async function finishSession(session, entries) {
  const completed = completeSessionDraft(session, entries);
  const saved = await storage.saveSessionBundle(completed, entries, { sessionRevision: session.revision, entryRevisions: Object.fromEntries(entries.map((entry) => [entry.id, entry.revision])) });
  await storage.putSetting("activeSessionId", null);
  return saved;
}
