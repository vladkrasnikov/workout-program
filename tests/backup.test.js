import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKUP_APP_ID,
  BACKUP_SCHEMA_VERSION,
  normalizeBackupPayload,
  planMerge,
  validateBackup,
} from "../js/backup.js";

const session = {
  id: "s1",
  programId: "athlete",
  dayId: "a",
  programVersion: 2,
  programNameSnapshot: "Athlete Full Body",
  dayNameSnapshot: "День A",
  workoutDate: "2026-10-29",
  performedAt: "2026-10-29T10:00:00.000Z",
  createdAt: "2026-10-29T10:00:00.000Z",
  updatedAt: "2026-10-29T11:00:00.000Z",
  status: "completed",
  completedAt: "2026-10-29T11:00:00.000Z",
  revision: 1,
};

const entry = {
  id: "e1",
  sessionId: "s1",
  programId: "athlete",
  slotId: "athlete:a:a1",
  choiceId: "machine",
  exerciseId: "row",
  variantId: "machine",
  equipmentKey: "default",
  loadConvention: "total",
  exerciseNameSnapshot: "Row",
  variantSnapshot: "Machine",
  metric: "load-reps",
  notes: "",
  revision: 1,
  updatedAt: "2026-10-29T10:15:00.000Z",
  sets: [{ id: "set-1", order: 1, side: "both", kind: "working", metric: "load-reps", confirmed: true, completedAt: "2026-10-29T10:15:00.000Z", loadKg: 40, reps: 12, durationSeconds: null }],
};

const payload = {
  appId: BACKUP_APP_ID,
  schemaVersion: BACKUP_SCHEMA_VERSION,
  sessions: [session],
  entries: [entry],
  settings: [{ key: "currentProgramId", value: "athlete" }],
};

test("strict schema v2 validation accepts a complete backup and rejects broken references", () => {
  assert.equal(validateBackup(payload).valid, true);
  assert.equal(validateBackup({ ...payload, entries: [{ ...entry, sessionId: "missing" }] }).valid, false);
  assert.equal(validateBackup({ ...payload, sessions: [{ ...session, workoutDate: "2026-02-30" }] }).valid, false);
  assert.equal(validateBackup({ ...payload, entries: [{ ...entry, slotId: "a1" }] }).valid, false);
  assert.equal(validateBackup({ ...payload, entries: [{ ...entry, sets: [{ ...entry.sets[0], reps: -1 }] }] }).valid, false);
  assert.equal(validateBackup({ ...payload, settings: [{ key: "activeSessionId", value: "missing" }] }).valid, false);
});

test("confirmed sets require typed confirmation and values for their metric", () => {
  const emptyConfirmed = { ...entry.sets[0], loadKg: null, reps: null };
  assert.equal(validateBackup({ ...payload, entries: [{ ...entry, sets: [emptyConfirmed] }] }).valid, false);
  const stringConfirmed = { ...entry.sets[0], confirmed: "true" };
  assert.equal(validateBackup({ ...payload, entries: [{ ...entry, sets: [stringConfirmed] }] }).valid, false);
  const brokenDuration = { ...entry, metric: "duration", sets: [{ ...entry.sets[0], metric: "duration", loadKg: null, reps: null, durationSeconds: null }] };
  assert.equal(validateBackup({ ...payload, entries: [brokenDuration] }).valid, false);
});

test("schema v1 backup is validated and normalized to spine-safe schema v2", () => {
  const legacySession = {
    id: "old",
    dayId: "b",
    programVersion: 1,
    workoutDate: "2026-09-01",
    performedAt: "2026-09-01T08:00:00.000Z",
    status: "completed",
    completedAt: "2026-09-01T09:00:00.000Z",
    revision: 2,
  };
  const legacyEntry = {
    id: "old-entry",
    sessionId: "old",
    slotId: "b1",
    exerciseId: "neutral-lat-pulldown",
    variantId: "assisted-pull-up",
    equipmentKey: "default",
    metric: "load-reps",
    revision: 2,
    sets: [{ ...entry.sets[0], id: "old-set" }],
  };
  const legacy = { appId: BACKUP_APP_ID, schemaVersion: 1, sessions: [legacySession], entries: [legacyEntry], settings: [{ key: "activeSessionId", value: null }] };
  const validation = validateBackup(legacy);
  assert.equal(validation.valid, true);
  assert.equal(validation.migratedFrom, 1);
  assert.equal(validation.normalized.schemaVersion, 2);
  assert.equal(validation.normalized.sessions[0].programId, "spine-safe");
  assert.equal(validation.normalized.entries[0].slotId, "spine-safe:b:b1");
  assert.equal(validation.normalized.entries[0].exerciseId, "pull-up");
  assert.equal(validation.normalized.entries[0].variantId, "assisted-pull-up");
  assert.equal(validation.normalized.entries[0].id, "old-entry");
  assert.equal(validation.normalized.entries[0].sets[0].loadKg, 40);
});

test("future and unsupported backup versions produce clear compatibility errors", () => {
  assert.throws(() => normalizeBackupPayload({ ...payload, schemaVersion: 99 }), /новішою версією/);
  assert.throws(() => normalizeBackupPayload({ ...payload, schemaVersion: 0 }), /Непідтримувана версія/);
});

test("repeat import is idempotent and changed stable IDs conflict", () => {
  const same = planMerge(payload, payload);
  assert.equal(same.additions, 0);
  assert.equal(same.conflicts.length, 0);
  assert.equal(same.duplicates.length, 2);

  const changed = { ...payload, entries: [{ ...entry, sets: [{ ...entry.sets[0], loadKg: 45 }] }] };
  const different = planMerge(payload, changed);
  assert.equal(different.conflicts.length, 1);
  assert.equal(different.conflicts[0].id, "e1");

  const collidingStableSlot = { ...payload, entries: [{ ...entry, id: "different-id" }] };
  const slotPlan = planMerge(payload, collidingStableSlot);
  assert.equal(slotPlan.conflicts.length, 1);
  assert.equal(slotPlan.conflicts[0].reason, "session-slot");
  assert.equal(slotPlan.additions, 0);
});

test("merge preserves local active session and current program", () => {
  const localSession = { ...session, id: "local-draft", status: "draft", completedAt: null };
  const localEntry = { ...entry, id: "local-entry", sessionId: "local-draft" };
  const local = {
    ...payload,
    sessions: [localSession],
    entries: [localEntry],
    settings: [{ key: "activeSessionId", value: "local-draft" }, { key: "currentProgramId", value: "athlete" }],
  };
  const importedSession = { ...session, id: "imported-draft", programId: "spine-safe", status: "draft", completedAt: null };
  const incoming = {
    ...payload,
    sessions: [importedSession],
    entries: [],
    settings: [{ key: "activeSessionId", value: "imported-draft" }, { key: "currentProgramId", value: "spine-safe" }],
  };
  const merged = planMerge(local, incoming).data.settings;
  assert.equal(merged.find((item) => item.key === "activeSessionId").value, "local-draft");
  assert.equal(merged.find((item) => item.key === "currentProgramId").value, "athlete");

  const withoutLocal = planMerge({ ...local, settings: [] }, incoming).data.settings;
  assert.equal(withoutLocal.find((item) => item.key === "activeSessionId").value, "imported-draft");
  assert.equal(withoutLocal.find((item) => item.key === "currentProgramId").value, "spine-safe");

  const missingDraft = { ...incoming, settings: [{ key: "activeSessionId", value: "missing" }] };
  assert.equal(planMerge({ ...local, settings: [] }, missingDraft).data.settings.some((item) => item.key === "activeSessionId"), false);
});
