import test from "node:test";
import assert from "node:assert/strict";
import { ALL_SLOTS, getSlot } from "../js/program.js";
import { createEntryDraft, createSessionDraft, findPreviousResult, localDateString, parseLocalizedNumber, validateSet } from "../js/workouts.js";

test("catalog has all DOM slots and deliberate compound C8", () => {
  assert.equal(ALL_SLOTS.length, 25);
  assert.equal(new Set(ALL_SLOTS.map((slot) => slot.parentSlotId ?? slot.slotId)).size, 24);
  assert.equal(getSlot("a6").exerciseId, getSlot("c7").exerciseId);
  assert.equal(getSlot("b8").exerciseId, getSlot("c8-calves").exerciseId);
});

test("every DOM card maps explicit alternatives", () => {
  assert.equal(ALL_SLOTS.every((slot) => slot.variants.length >= 2), true);
  assert.equal(getSlot("a1").variants.some((item) => item.id === "incline-dumbbell"), true);
  assert.equal(getSlot("a4").variants.some((item) => item.id === "standing-single-leg"), true);
  assert.equal(getSlot("b1").variants.some((item) => item.id === "assisted-pull-up"), true);
  assert.equal(getSlot("b8").variants.some((item) => item.id === "single-leg-dumbbell"), true);
  assert.equal(getSlot("c1").variants.some((item) => item.id === "cable-v-handle"), true);
  assert.deepEqual(getSlot("b8").variants.map((item) => item.id), getSlot("c8-calves").variants.map((item) => item.id));
});

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

test("invalid performedAt has a domain error", () => {
  assert.throws(() => createSessionDraft("a", { performedAt: "not-a-date" }), /Некоректна дата/);
});

test("backdated workout keeps actual creation time", () => {
  const { session } = createSessionDraft("a", {
    id: "backdated",
    performedAt: "2026-01-10T08:00:00.000Z",
    createdAt: "2026-10-29T12:00:00.000Z",
  });
  assert.equal(session.performedAt, "2026-01-10T08:00:00.000Z");
  assert.equal(session.createdAt, "2026-10-29T12:00:00.000Z");
  assert.equal(session.updatedAt, session.createdAt);
});

test("previous result crosses A6/C7 and skips drafts, unconfirmed and skipped sessions", () => {
  const target = createEntryDraft("new", "c7", "cable");
  const old = createEntryDraft("old", "a6", "cable");
  old.sets[0] = { ...old.sets[0], loadKg: 7.5, reps: 15, confirmed: true };
  const skipped = createEntryDraft("skipped", "c7", "cable");
  const draft = createEntryDraft("draft", "a6", "cable");
  draft.sets[0] = { ...draft.sets[0], loadKg: 9, reps: 15, confirmed: true };
  const unconfirmed = createEntryDraft("unconfirmed", "a6", "cable");
  unconfirmed.sets[0] = { ...unconfirmed.sets[0], loadKg: 8, reps: 15, confirmed: false };
  const sessions = [
    { id: "old", status: "completed", performedAt: "2026-10-01T10:00:00.000Z" },
    { id: "skipped", status: "completed", performedAt: "2026-10-20T10:00:00.000Z" },
    { id: "draft", status: "draft", performedAt: "2026-10-25T10:00:00.000Z" },
    { id: "unconfirmed", status: "completed", performedAt: "2026-10-26T10:00:00.000Z" },
    { id: "new", status: "draft", performedAt: "2026-10-29T10:00:00.000Z" },
  ];
  const found = findPreviousResult(target, sessions, [old, skipped, draft, unconfirmed]);
  assert.equal(found.session.id, "old");
  assert.equal(found.entry.sets[0].loadKg, 7.5);
});

test("different variants never share previous result", () => {
  const target = createEntryDraft("new", "a3", "smith");
  const old = createEntryDraft("old", "a3", "dumbbell");
  old.sets[0] = { ...old.sets[0], loadKg: 20, reps: 12, confirmed: true };
  const sessions = [
    { id: "old", status: "completed", performedAt: "2026-10-01T10:00:00.000Z" },
    { id: "new", status: "draft", performedAt: "2026-10-29T10:00:00.000Z" },
  ];
  assert.equal(findPreviousResult(target, sessions, [old]), null);
});
