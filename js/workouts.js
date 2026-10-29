import { PROGRAM_VERSION, getDay, getSlot, getVariant } from "./program.js";
import * as storage from "./storage.js";

const randomId = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
export const comparisonKey = (entry) => `${entry.exerciseId}|${entry.variantId}|${entry.equipmentKey ?? "default"}|${entry.loadConvention ?? "total"}`;

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

export function createSessionDraft(dayId, options = {}) {
  const day = getDay(dayId);
  if (!day) throw new Error(`Невідомий день: ${dayId}`);
  const performedDate = options.performedAt ? new Date(options.performedAt) : new Date();
  const createdDate = options.createdAt ? new Date(options.createdAt) : new Date();
  if (Number.isNaN(performedDate.getTime())) throw new Error("Некоректна дата або час тренування");
  if (Number.isNaN(createdDate.getTime())) throw new Error("Некоректна дата створення запису");
  const performedAt = performedDate.toISOString();
  const createdAt = createdDate.toISOString();
  const sessionId = options.id ?? randomId("session");
  const session = { id: sessionId, dayId, programVersion: PROGRAM_VERSION, workoutDate: options.workoutDate ?? localDateString(performedDate), performedAt, createdAt, updatedAt: createdAt, status: "draft", completedAt: null, revision: 0 };
  const entries = day.slots.map((slot) => createEntryDraft(sessionId, slot.slotId, slot.defaultVariantId));
  return { session, entries };
}

export function createEntryDraft(sessionId, slotId, variantId) {
  const slot = getSlot(slotId);
  const chosen = getVariant(slotId, variantId);
  if (!slot || !chosen) throw new Error(`Невідомий слот або варіант: ${slotId}/${variantId}`);
  return {
    id: `${sessionId}:${slotId}:${slot.exerciseId}`,
    sessionId,
    slotId,
    exerciseId: slot.exerciseId,
    variantId: chosen.id,
    equipmentKey: chosen.equipmentKey,
    loadConvention: chosen.loadConvention,
    exerciseNameSnapshot: slot.name,
    variantSnapshot: chosen.name,
    metric: chosen.metric,
    sets: Array.from({ length: slot.sets }, (_, index) => makeDraftSet(index + 1, chosen.metric)),
    notes: "",
    revision: 0,
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

export function completeSessionDraft(session, entries, now = new Date()) {
  const timestamp = now.toISOString();
  return { ...session, status: "completed", completedAt: timestamp, updatedAt: timestamp, confirmedSetCount: entries.reduce((sum, entry) => sum + validWorkingSets(entry).length, 0) };
}

export async function startSession(dayId, options = {}) {
  const draft = createSessionDraft(dayId, options);
  const saved = await storage.saveSessionBundle(draft.session, draft.entries, { sessionRevision: 0, entryRevisions: Object.fromEntries(draft.entries.map((entry) => [entry.id, 0])) });
  await storage.putSetting("activeSessionId", saved.session.id);
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
