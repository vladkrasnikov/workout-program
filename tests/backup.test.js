import test from "node:test";
import assert from "node:assert/strict";
import { BACKUP_APP_ID, BACKUP_SCHEMA_VERSION, planMerge, validateBackup } from "../js/backup.js";

const session = { id: "s1", dayId: "a", workoutDate: "2026-10-29", performedAt: "2026-10-29T10:00:00.000Z", status: "completed", completedAt: "2026-10-29T11:00:00.000Z", revision: 1 };
const entry = { id: "e1", sessionId: "s1", slotId: "a1", exerciseId: "row", variantId: "machine", equipmentKey: "default", metric: "load-reps", revision: 1, sets: [{ id: "set-1", order: 1, side: "both", kind: "working", metric: "load-reps", confirmed: true, completedAt: "2026-10-29T10:15:00.000Z", loadKg: 40, reps: 12, durationSeconds: null }] };
const payload = { appId: BACKUP_APP_ID, schemaVersion: BACKUP_SCHEMA_VERSION, sessions: [session], entries: [entry], settings: [] };

test("valid backup passes and invalid references fail", () => {
  assert.equal(validateBackup(payload).valid, true);
  assert.equal(validateBackup({ ...payload, entries: [{ ...entry, sessionId: "missing" }] }).valid, false);
  assert.equal(validateBackup({ ...payload, schemaVersion: 99 }).valid, false);
  assert.equal(validateBackup({ ...payload, entries: [{ ...entry, sets: [{ ...entry.sets[0], reps: -1 }] }] }).valid, false);
});

test("confirmed sets require typed confirmation and values for their metric", () => {
  const emptyConfirmed = { ...entry.sets[0], loadKg: null, reps: null };
  assert.equal(validateBackup({ ...payload, entries: [{ ...entry, sets: [emptyConfirmed] }] }).valid, false);
  const stringConfirmed = { ...entry.sets[0], confirmed: "true" };
  assert.equal(validateBackup({ ...payload, entries: [{ ...entry, sets: [stringConfirmed] }] }).valid, false);
  const brokenDuration = { ...entry, metric: "duration", sets: [{ ...entry.sets[0], metric: "duration", loadKg: null, reps: null, durationSeconds: null }] };
  assert.equal(validateBackup({ ...payload, entries: [brokenDuration] }).valid, false);
});

test("repeat import is idempotent", () => {
  const plan = planMerge(payload, payload);
  assert.equal(plan.additions, 0);
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.duplicates.length, 2);
});

test("same stable id with different content is a conflict", () => {
  const changed = { ...payload, entries: [{ ...entry, sets: [{ ...entry.sets[0], loadKg: 45 }] }] };
  const plan = planMerge(payload, changed);
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].id, "e1");
});

test("merge preserves local active session and only accepts a valid imported draft", () => {
  const local = { ...payload, settings: [{ key: "activeSessionId", value: "local-draft" }], sessions: [{ ...session, id: "local-draft", status: "draft", completedAt: null }] };
  const incomingDraft = { ...payload, settings: [{ key: "activeSessionId", value: "imported-draft" }], sessions: [{ ...session, id: "imported-draft", status: "draft", completedAt: null }], entries: [] };
  assert.equal(planMerge(local, incomingDraft).data.settings.find((item) => item.key === "activeSessionId").value, "local-draft");

  const noLocalActive = { ...local, settings: [] };
  assert.equal(planMerge(noLocalActive, incomingDraft).data.settings.find((item) => item.key === "activeSessionId").value, "imported-draft");

  const missingDraft = { ...incomingDraft, settings: [{ key: "activeSessionId", value: "missing" }] };
  assert.equal(planMerge(noLocalActive, missingDraft).data.settings.some((item) => item.key === "activeSessionId"), false);
});
