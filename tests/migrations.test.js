import test from "node:test";
import assert from "node:assert/strict";
import { getChoice } from "../js/program.js";
import {
  LEGACY_CHOICE_IDENTITY_REMAP,
  LEGACY_PROGRAM_ID,
  migrateLegacyData,
  migrateLegacyEntry,
  migrateLegacySession,
  namespaceLegacySlotId,
} from "../js/migrations.js";

const legacySession = {
  id: "legacy-session",
  dayId: "c",
  programVersion: 1,
  workoutDate: "2026-10-20",
  performedAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T11:00:00.000Z",
  status: "draft",
  completedAt: null,
  revision: 3,
};

const legacyEntry = {
  id: "legacy-entry-id-must-stay",
  sessionId: legacySession.id,
  slotId: "c8-pallof",
  exerciseId: "pallof-press",
  variantId: "cable",
  equipmentKey: "cable",
  metric: "load-reps",
  revision: 4,
  sets: [{ id: "set-1", loadKg: 20, reps: 12, confirmed: true }],
};

test("legacy records migrate to spine-safe without changing stable history", () => {
  const data = migrateLegacyData({ sessions: [legacySession], entries: [legacyEntry], settings: [{ key: "activeSessionId", value: legacySession.id }] });
  assert.equal(data.sessions[0].programId, LEGACY_PROGRAM_ID);
  assert.equal(data.sessions[0].dayNameSnapshot, "День C");
  assert.equal(data.entries[0].programId, LEGACY_PROGRAM_ID);
  assert.equal(data.entries[0].slotId, "spine-safe:c:c8-pallof");
  assert.equal(data.entries[0].id, legacyEntry.id);
  assert.equal(data.entries[0].revision, legacyEntry.revision);
  assert.deepEqual(data.entries[0].sets, legacyEntry.sets);
  assert.equal(data.settings.find((setting) => setting.key === "activeSessionId").value, legacySession.id);
  assert.equal(data.settings.find((setting) => setting.key === "currentProgramId").value, LEGACY_PROGRAM_ID);
  assert.equal(legacyEntry.slotId, "c8-pallof", "migration must not mutate source data");
});

test("migration is idempotent for already namespaced records", () => {
  const session = migrateLegacySession(legacySession);
  const entry = migrateLegacyEntry(legacyEntry, session);
  assert.deepEqual(migrateLegacySession(session), session);
  assert.deepEqual(migrateLegacyEntry(entry, session), entry);
  assert.equal(namespaceLegacySlotId(entry.slotId, "c"), entry.slotId);
  assert.equal(namespaceLegacySlotId("a1", "a"), "spine-safe:a:a1");
  assert.equal(namespaceLegacySlotId("c8-pallof", "c"), "spine-safe:c:c8-pallof");
  assert.equal(namespaceLegacySlotId("c8-calves", "c"), "spine-safe:c:c8-calf");
});

test("duplicate legacy session slots preserve both entries for the new unique index", () => {
  const duplicate = { ...legacyEntry, id: "second-entry", exerciseId: "different-exercise" };
  const data = migrateLegacyData({ sessions: [legacySession], entries: [legacyEntry, duplicate], settings: [] });
  assert.equal(data.entries.length, 2);
  assert.equal(new Set(data.entries.map((entry) => entry.slotId)).size, 2);
  assert.equal(data.entries[1].originalSlotId, "spine-safe:c:c8-pallof");
  assert.equal(data.entries[1].migrationConflict, "duplicate-session-slot");
});

test("legacy alternative identities remap to canonical choices without changing history", () => {
  const fixtures = [
    { dayId: "a", slotId: "a2", variantId: "leg-press-45", oldExerciseId: "belt-squat", exerciseId: "leg-press" },
    { dayId: "b", slotId: "b2", variantId: "back-extension", oldExerciseId: "hip-thrust", exerciseId: "back-extension-45" },
    { dayId: "a", slotId: "a8", variantId: "side-plank", oldExerciseId: "dead-bug", exerciseId: "side-plank" },
  ];
  assert.equal(Object.isFrozen(LEGACY_CHOICE_IDENTITY_REMAP), true);
  for (const [index, fixture] of fixtures.entries()) {
    const session = migrateLegacySession({ ...legacySession, id: `session-${index}`, dayId: fixture.dayId });
    const source = {
      ...legacyEntry,
      id: `entry-${index}`,
      sessionId: session.id,
      slotId: fixture.slotId,
      exerciseId: fixture.oldExerciseId,
      variantId: fixture.variantId,
      revision: 7,
      sets: [{ id: `set-${index}`, order: 1, loadKg: 42, reps: 9, confirmed: true }],
    };
    const migrated = migrateLegacyEntry(source, session);
    assert.equal(migrated.slotId, `spine-safe:${fixture.dayId}:${fixture.slotId}`);
    assert.equal(migrated.exerciseId, fixture.exerciseId);
    assert.equal(migrated.variantId, fixture.variantId);
    assert.equal(migrated.choiceId, fixture.variantId);
    assert.equal(migrated.id, source.id);
    assert.equal(migrated.revision, source.revision);
    assert.deepEqual(migrated.sets, source.sets);
    assert.deepEqual(migrateLegacyEntry(migrated, session), migrated);
  }
});

test("frozen legacy identity map stays aligned with current catalog choices", () => {
  for (const [key, identity] of Object.entries(LEGACY_CHOICE_IDENTITY_REMAP)) {
    const [legacySlotId, legacyVariantId] = key.split("|");
    const slotId = namespaceLegacySlotId(legacySlotId, legacySlotId[0]);
    const choice = getChoice(slotId, identity.choiceId);
    assert.ok(choice, `${key} must resolve in the catalog`);
    assert.equal(choice.exerciseId, identity.exerciseId, `${key} exercise identity drifted`);
    assert.equal(choice.variantId, identity.variantId, `${key} variant identity drifted`);
    assert.equal(identity.choiceId, legacyVariantId, `${key} changed legacy selector identity`);
  }
});
