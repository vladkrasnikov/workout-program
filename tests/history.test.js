import test from "node:test";
import assert from "node:assert/strict";
import { buildProgressSeries } from "../js/history.js";

const makeSet = (metric, value, order = 1) => ({
  id: `${metric}-${order}`,
  order,
  kind: "working",
  metric,
  loadKg: metric === "load-reps" ? value : null,
  reps: metric === "reps" || metric === "load-reps" ? value : null,
  durationSeconds: metric === "duration" ? value : null,
  side: "both",
  confirmed: true,
  completedAt: "2026-10-01T10:00:00.000Z",
});

const makeEntry = (sessionId, metric, values) => ({
  id: `entry-${sessionId}`,
  sessionId,
  exerciseId: "raise",
  variantId: "cable",
  equipmentKey: "default",
  metric,
  sets: values.map((value, index) => makeSet(metric, value, index + 1)),
});

const sessions = [
  { id: "new", status: "completed", workoutDate: "2026-10-20", performedAt: "2026-10-20T10:00:00.000Z" },
  { id: "old", status: "completed", workoutDate: "2026-06-01", performedAt: "2026-06-01T10:00:00.000Z" },
  { id: "sixty", status: "completed", workoutDate: "2026-09-01", performedAt: "2026-09-01T10:00:00.000Z" },
  { id: "middle", status: "completed", workoutDate: "2026-10-10", performedAt: "2026-10-10T10:00:00.000Z" },
  { id: "draft", status: "draft", workoutDate: "2026-10-25", performedAt: "2026-10-25T10:00:00.000Z" },
];

test("load series uses highest confirmed load and sorts chronologically", () => {
  const target = makeEntry("target", "load-reps", [0]);
  const entries = [makeEntry("new", "load-reps", [20, 22]), makeEntry("old", "load-reps", [12]), makeEntry("middle", "load-reps", [18]), makeEntry("draft", "load-reps", [30])];
  const series = buildProgressSeries(target, sessions, entries, "all", new Date("2026-10-29T00:00:00.000Z"));
  assert.deepEqual(series.map((point) => point.sessionId), ["old", "middle", "new"]);
  assert.deepEqual(series.map((point) => point.value), [12, 18, 22]);
});

test("period filter keeps entries inside 30 or 90 days", () => {
  const target = makeEntry("target", "load-reps", [0]);
  const entries = [makeEntry("new", "load-reps", [22]), makeEntry("old", "load-reps", [12]), makeEntry("sixty", "load-reps", [16]), makeEntry("middle", "load-reps", [18])];
  const now = new Date("2026-10-29T00:00:00.000Z");
  assert.deepEqual(buildProgressSeries(target, sessions, entries, "30", now).map((point) => point.sessionId), ["middle", "new"]);
  assert.deepEqual(buildProgressSeries(target, sessions, entries, "90", now).map((point) => point.sessionId), ["sixty", "middle", "new"]);
});

test("reps and duration series select the metric-specific maximum", () => {
  const repsTarget = makeEntry("target-reps", "reps", [0]);
  const durationTarget = makeEntry("target-duration", "duration", [0]);
  const reps = buildProgressSeries(repsTarget, sessions, [makeEntry("new", "reps", [10, 15])], "all");
  const duration = buildProgressSeries(durationTarget, sessions, [makeEntry("new", "duration", [35, 45])], "all");
  assert.equal(reps[0].value, 15);
  assert.equal(duration[0].value, 45);
});

test("series isolates variant and equipment", () => {
  const target = makeEntry("target", "load-reps", [0]);
  const matching = makeEntry("new", "load-reps", [22]);
  const otherVariant = { ...makeEntry("middle", "load-reps", [50]), variantId: "dumbbell" };
  const otherMachine = { ...makeEntry("old", "load-reps", [60]), equipmentKey: "gym-2" };
  assert.deepEqual(buildProgressSeries(target, sessions, [matching, otherVariant, otherMachine]).map((point) => point.value), [22]);
});
