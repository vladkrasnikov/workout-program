import test from "node:test";
import assert from "node:assert/strict";
import { getMovement } from "../js/program.js";
import {
  changeEntryChoice,
  comparisonKey,
  createEntryDraft,
  createSessionDraft,
  findPreviousResult,
  findStableWorkingLoad,
  localDateString,
  parseLocalizedNumber,
  validateSet,
} from "../js/workouts.js";

test("localized numbers and set validation preserve empty versus zero", () => {
  assert.equal(parseLocalizedNumber("7,5"), 7.5);
  assert.equal(parseLocalizedNumber("7.5"), 7.5);
  assert.equal(parseLocalizedNumber(""), null);
  assert.equal(parseLocalizedNumber("-2"), null);
  assert.equal(validateSet({ loadKg: "40", reps: "12" }).valid, true);
  assert.equal(validateSet({ loadKg: "", reps: "12" }).valid, false);
  assert.equal(validateSet({ reps: "12.5" }, "reps").valid, false);
  assert.equal(validateSet({ durationSeconds: "45" }, "duration").valid, true);
});

test("local date uses local calendar fields", () => {
  const date = new Date(2026, 9, 29, 0, 5);
  assert.equal(localDateString(date), "2026-10-29");
});

test("sessions are program-aware and support arbitrary days and compound movements", () => {
  const spine = createSessionDraft("spine-safe", "c", { id: "spine-c" });
  assert.equal(spine.session.programId, "spine-safe");
  assert.equal(spine.session.dayId, "c");
  assert.equal(spine.entries.length, 9, "C8 is two independently logged movements");
  assert.equal(spine.entries.some((entry) => entry.slotId === "spine-safe:c:c8-pallof"), true);
  assert.equal(spine.entries.some((entry) => entry.slotId === "spine-safe:c:c8-calf"), true);

  const lower = createSessionDraft("upper-lower-4x", "lower-b", { id: "lower-b" });
  assert.equal(lower.session.dayId, "lower-b");
  assert.equal(lower.entries.length, 7, "compound hip abduction/calves creates two entries");

  const minimalist = createSessionDraft("minimalist-busy-pro-2x", "day-1", { id: "minimalist" });
  assert.equal(minimalist.entries.length, 8, "six source cards include two compound cards");
});

test("same day and session IDs remain isolated by namespaced program slots", () => {
  const spine = createSessionDraft("spine-safe", "a", { id: "same-session" });
  const athlete = createSessionDraft("athlete-full-body-3x", "a", { id: "same-session" });
  assert.equal(spine.entries.every((entry) => entry.programId === "spine-safe" && entry.slotId.startsWith("spine-safe:a:")), true);
  assert.equal(athlete.entries.every((entry) => entry.programId === "athlete-full-body-3x" && entry.slotId.startsWith("athlete-full-body-3x:a:")), true);
  assert.equal(new Set([...spine.entries, ...athlete.entries].map((entry) => entry.id)).size, spine.entries.length + athlete.entries.length);
});

test("invalid performedAt has a domain error", () => {
  assert.throws(() => createSessionDraft("spine-safe", "a", { performedAt: "not-a-date" }), /Некоректна дата/);
});

test("backdated workout keeps actual creation time and catalog snapshots", () => {
  const { session } = createSessionDraft("spine-safe", "a", {
    id: "backdated",
    performedAt: "2026-01-10T08:00:00.000Z",
    createdAt: "2026-10-29T12:00:00.000Z",
  });
  assert.equal(session.performedAt, "2026-01-10T08:00:00.000Z");
  assert.equal(session.createdAt, "2026-10-29T12:00:00.000Z");
  assert.equal(session.updatedAt, session.createdAt);
  assert.equal(typeof session.programNameSnapshot, "string");
  assert.equal(typeof session.dayNameSnapshot, "string");
});

test("changing a choice keeps stable entry identity and resets choice-specific sets", () => {
  const movement = getMovement("spine-safe:a:a1");
  const original = createEntryDraft("choice-session", movement.slotId, movement.defaultChoiceId);
  original.sets[0] = { ...original.sets[0], loadKg: 50, reps: 8, confirmed: true };
  original.notes = "keep note";
  original.revision = 3;
  const alternative = movement.choices.find((choice) => choice.id !== movement.defaultChoiceId);
  const changed = changeEntryChoice(original, alternative.id);
  assert.equal(changed.id, original.id);
  assert.equal(changed.choiceId, alternative.id);
  assert.equal(changed.notes, "keep note");
  assert.equal(changed.revision, 3);
  assert.equal(changed.sets.every((set) => !set.confirmed && set.loadKg === null), true);
});

test("previous result crosses programs for compatible canonical exercise identity", () => {
  const old = createEntryDraft("old", "spine-safe:a:a6", "cable");
  const target = createEntryDraft("new", "athlete-full-body-3x:a:a6", "cable");
  assert.equal(comparisonKey(old), comparisonKey(target));
  old.sets[0] = { ...old.sets[0], loadKg: 7.5, reps: 15, confirmed: true };
  const sessions = [
    { id: "old", programId: "spine-safe", status: "completed", performedAt: "2026-10-01T10:00:00.000Z" },
    { id: "new", programId: "athlete-full-body-3x", status: "draft", performedAt: "2026-10-29T10:00:00.000Z" },
  ];
  const found = findPreviousResult(target, sessions, [old]);
  assert.equal(found.session.id, "old");
  assert.equal(found.entry.sets[0].loadKg, 7.5);
});

test("previous result skips drafts, unconfirmed sets and incompatible conventions", () => {
  const target = createEntryDraft("new", "spine-safe:a:a6", "cable");
  const draft = createEntryDraft("draft", "spine-safe:c:c7", "cable");
  draft.sets[0] = { ...draft.sets[0], loadKg: 9, reps: 15, confirmed: true };
  const unconfirmed = createEntryDraft("unconfirmed", "spine-safe:c:c7", "cable");
  unconfirmed.sets[0] = { ...unconfirmed.sets[0], loadKg: 8, reps: 15, confirmed: false };
  const incompatible = { ...createEntryDraft("different", "spine-safe:c:c7", "cable"), loadConvention: "per-hand" };
  incompatible.sets[0] = { ...incompatible.sets[0], loadKg: 10, reps: 15, confirmed: true };
  const sessions = [
    { id: "draft", status: "draft", performedAt: "2026-10-25T10:00:00.000Z" },
    { id: "unconfirmed", status: "completed", performedAt: "2026-10-26T10:00:00.000Z" },
    { id: "different", status: "completed", performedAt: "2026-10-27T10:00:00.000Z" },
    { id: "new", status: "draft", performedAt: "2026-10-29T10:00:00.000Z" },
  ];
  assert.equal(findPreviousResult(target, sessions, [draft, unconfirmed, incompatible]), null);
});

const completedSession = (id, performedAt) => ({ id, status: "completed", performedAt });
const loggedLoad = (id, loadKg, performedAt, { confirmed = true } = {}) => {
  const entry = createEntryDraft(id, "spine-safe:a:a6", "cable");
  entry.sets[0] = {
    ...entry.sets[0],
    loadKg,
    reps: 12,
    confirmed,
    completedAt: performedAt,
  };
  return entry;
};

test("stable working load ignores empty, unconfirmed and lower deload results", () => {
  const target = createEntryDraft("target", "spine-safe:a:a6", "cable");
  const high = loggedLoad("high", 12, "2026-09-01T10:00:00.000Z");
  const deload = loggedLoad("deload", 8, "2026-10-01T10:00:00.000Z");
  const unconfirmed = loggedLoad("unconfirmed", 20, "2026-10-10T10:00:00.000Z", { confirmed: false });
  const empty = loggedLoad("empty", null, "2026-10-20T10:00:00.000Z");
  const sessions = [
    completedSession("high", "2026-09-01T10:00:00.000Z"),
    completedSession("deload", "2026-10-01T10:00:00.000Z"),
    completedSession("unconfirmed", "2026-10-10T10:00:00.000Z"),
    completedSession("empty", "2026-10-20T10:00:00.000Z"),
  ];
  const anchor = findStableWorkingLoad(target, sessions, [high, deload, unconfirmed, empty]);
  assert.equal(anchor.loadKg, 12);
  assert.equal(anchor.session.id, "high");
});

test("stable working load increases and uses the newest result at equal max", () => {
  const target = createEntryDraft("target", "spine-safe:a:a6", "cable");
  const old = loggedLoad("old", 12, "2026-08-01T10:00:00.000Z");
  const higherOld = loggedLoad("higher-old", 15, "2026-09-01T10:00:00.000Z");
  const higherNew = loggedLoad("higher-new", 15, "2026-10-01T10:00:00.000Z");
  const sessions = [
    completedSession("old", "2026-08-01T10:00:00.000Z"),
    completedSession("higher-old", "2026-09-01T10:00:00.000Z"),
    completedSession("higher-new", "2026-10-01T10:00:00.000Z"),
  ];
  const anchor = findStableWorkingLoad(target, sessions, [old, higherOld, higherNew]);
  assert.equal(anchor.loadKg, 15);
  assert.equal(anchor.session.id, "higher-new");
});

test("stable working load falls back after the highest session is deleted", () => {
  const target = createEntryDraft("target", "spine-safe:a:a6", "cable");
  const fallback = loggedLoad("fallback", 10, "2026-09-01T10:00:00.000Z");
  const removed = loggedLoad("removed", 14, "2026-10-01T10:00:00.000Z");
  const sessions = [
    completedSession("fallback", "2026-09-01T10:00:00.000Z"),
    completedSession("removed", "2026-10-01T10:00:00.000Z"),
  ];
  assert.equal(findStableWorkingLoad(target, sessions, [fallback, removed]).loadKg, 14);
  assert.equal(findStableWorkingLoad(target, sessions.filter((session) => session.id !== "removed"), [fallback]).loadKg, 10);
});

test("stable working load is only defined for load-based movements", () => {
  const target = { ...createEntryDraft("target", "spine-safe:a:a8", "bodyweight"), metric: "reps" };
  assert.equal(findStableWorkingLoad(target, [], []), null);
});
