import test from "node:test";
import assert from "node:assert/strict";
import {
  ALL_MOVEMENTS,
  CATEGORIES,
  DEFAULT_PROGRAM_ID,
  PROGRAM_LIST,
  getCard,
  getCardsForDay,
  getChoice,
  getDay,
  getMovement,
  getMovementsForCard,
  getProgram,
} from "../js/program.js";

const inventory = Object.fromEntries(PROGRAM_LIST.map((program) => [program.id, {
  days: program.days.length,
  cards: program.days.reduce((sum, day) => sum + day.cards.length, 0),
  movements: program.days.reduce((sum, day) => sum + day.cards.reduce((count, card) => count + card.movements.length, 0), 0),
}]));

test("v6 catalog contains five independently addressable programs", () => {
  assert.equal(DEFAULT_PROGRAM_ID, "spine-safe");
  assert.equal(PROGRAM_LIST.length, 5);
  assert.deepEqual(inventory, {
    "spine-safe": { days: 3, cards: 24, movements: 25 },
    "athlete-full-body-3x": { days: 3, cards: 24, movements: 25 },
    "glute-shape-posture-3x": { days: 3, cards: 24, movements: 25 },
    "upper-lower-4x": { days: 4, cards: 26, movements: 29 },
    "minimalist-busy-pro-2x": { days: 2, cards: 12, movements: 16 },
  });
  assert.equal(CATEGORIES.length, 5);
  assert.equal(ALL_MOVEMENTS.length, 120);
});

test("catalog ids are globally namespaced and unique", () => {
  const cards = PROGRAM_LIST.flatMap((program) => program.days.flatMap((day) => day.cards));
  assert.equal(new Set(cards.map((card) => card.id)).size, 110);
  assert.equal(new Set(ALL_MOVEMENTS.map((movement) => movement.slotId)).size, 120);
  assert.equal(cards.every((card) => card.id.startsWith(`${card.id.split(":")[0]}:`)), true);
  assert.equal(ALL_MOVEMENTS.every((movement) => movement.slotId === movement.parentCardId || movement.slotId.startsWith(`${movement.parentCardId}-`)), true);
  assert.equal(ALL_MOVEMENTS.every((movement) => new Set(movement.choices.map((choice) => choice.id)).size === movement.choices.length), true);
});

test("all source cards preserve guidance, alternatives and cues", () => {
  const cards = PROGRAM_LIST.flatMap((program) => program.days.flatMap((day) => day.cards));
  for (const card of cards) {
    assert.ok(card.label, card.id);
    assert.ok(card.name, card.id);
    assert.ok(card.shortAlternative, card.id);
    assert.ok(card.params.length, card.id);
    assert.ok(card.content.technique.length, card.id);
    assert.ok(card.content.alternatives.length, card.id);
    assert.ok(card.content.cue, card.id);
    assert.ok(card.movements.length, card.id);
    assert.equal(card.movements.every((movement) => movement.choices.length >= 1), true, card.id);
  }
});

test("spine-safe uses v6 base ranges", () => {
  const expected = {
    a1: [6, 8], a2: [6, 8], a3: [6, 8],
    b1: [6, 8], b2: [6, 8], b3: [6, 8], b4: [6, 8], b5: [6, 8],
    c1: [6, 8], c3: [6, 8], c4: [6, 8],
  };
  for (const [legacySlotId, range] of Object.entries(expected)) {
    const movement = ALL_MOVEMENTS.find((item) => item.legacySlotId === legacySlotId && item.slotId.startsWith("spine-safe:"));
    assert.deepEqual([movement.prescription.target.min, movement.prescription.target.max], range, legacySlotId);
  }
  assert.deepEqual(getMovement("spine-safe:c:c5").repRange, [8, 12]);
});

test("canonical slot ids preserve legacy landing convention", () => {
  assert.equal(getMovement("spine-safe:a:a1").slotId, "spine-safe:a:a1");
  assert.equal(getMovement("spine-safe:c:c8-pallof").slotId, "spine-safe:c:c8-pallof");
  assert.equal(getMovement("spine-safe:c:c8-calf").slotId, "spine-safe:c:c8-calf");
  assert.equal(getMovement("spine-safe:a:a1:main"), null);
});

test("compound cards expose each independently loggable movement", () => {
  const expected = [
    "spine-safe:c:c8",
    "athlete-full-body-3x:c:c8",
    "glute-shape-posture-3x:c:c8",
    "upper-lower-4x:upper-a:a7",
    "upper-lower-4x:upper-b:b7",
    "upper-lower-4x:lower-b:b5",
    "minimalist-busy-pro-2x:day-1:m5",
    "minimalist-busy-pro-2x:day-1:m6",
    "minimalist-busy-pro-2x:day-2:m5",
    "minimalist-busy-pro-2x:day-2:m6",
  ];
  for (const cardId of expected) assert.equal(getMovementsForCard(cardId).length, 2, cardId);
  const calfOrPallof = getMovement("minimalist-busy-pro-2x:day-2:m6-calves-pallof");
  assert.deepEqual(calfOrPallof.choices.map((choice) => choice.exerciseId), ["leg-press-calf-raise", "pallof-press"]);
});

test("minimalist has six source slots per day and inherited session guidance", () => {
  const program = getProgram("minimalist-busy-pro-2x");
  assert.deepEqual(program.days.map((day) => day.cards.length), [6, 6]);
  assert.deepEqual(program.days.map((day) => day.slots.length), [8, 8]);
  for (const day of program.days) {
    assert.ok(day.sessionContent.setup);
    assert.ok(day.sessionContent.feel);
    assert.ok(day.sessionContent.avoid);
    assert.ok(day.sessionContent.mistakes);
    assert.ok(day.sessionContent.cue);
    assert.deepEqual(day.sourceAggregate.params, ["6 вправ × 2 сети (6–10 повт.)", "RIR 0–1", "Осьове: 0–1/10", "2–2.5 хв"]);
    assert.ok(day.sourceAggregate.content.technique.length);
    assert.ok(day.sourceAggregate.content.alternatives.length);
    assert.ok(day.sourceAggregate.content.cue);
  }
});

test("set ranges and non-repetition targets remain structured", () => {
  const lowerA1 = getMovement("upper-lower-4x:lower-a:a1");
  assert.deepEqual(lowerA1.prescription.sets, { min: 2, max: 3, default: 2 });
  const plank = getMovement("glute-shape-posture-3x:b:b8");
  assert.equal(plank.prescription.target.kind, "duration");
  assert.deepEqual([plank.prescription.target.min, plank.prescription.target.max], [35, 45]);
});

test("shared movements retain global exercise identity across programs", () => {
  const ids = [
    "spine-safe:a:a5",
    "athlete-full-body-3x:a:a5",
    "glute-shape-posture-3x:a:a7",
    "upper-lower-4x:upper-a:a5",
  ].map((slotId) => getMovement(slotId).exerciseId);
  assert.deepEqual([...new Set(ids)], ["face-pull-external-rotation"]);

  const lateralIds = [
    "spine-safe:a:a6",
    "athlete-full-body-3x:a:a6",
    "glute-shape-posture-3x:b:b4",
    "upper-lower-4x:upper-b:b6",
  ].map((slotId) => getMovement(slotId).exerciseId);
  assert.deepEqual([...new Set(lateralIds)], ["single-arm-lateral-raise"]);

  const beltSquat = getMovement("spine-safe:a:a2");
  assert.equal(getChoice(beltSquat.slotId, "machine").exerciseId, "belt-squat");
  assert.equal(getChoice(beltSquat.slotId, "leg-press-45").exerciseId, "leg-press");
});

test("legacy alternatives use explicit canonical exercise identities", () => {
  const expected = [
    ["spine-safe:a:a2", "leg-press-45", "leg-press"],
    ["spine-safe:b:b2", "back-extension", "back-extension-45"],
    ["spine-safe:b:b5", "leg-extension", "leg-extension"],
    ["spine-safe:b:b1", "assisted-pull-up", "pull-up"],
    ["spine-safe:a:a8", "side-plank", "side-plank"],
    ["spine-safe:a:a8", "bird-dog", "bird-dog"],
    ["spine-safe:a:a5", "incline-dumbbell-w-raise", "incline-w-raise"],
    ["spine-safe:c:c2", "b-stance-dumbbell-rdl", "romanian-deadlift"],
    ["spine-safe:c:c4", "seated-cable-crossover", "cable-chest-fly"],
    ["spine-safe:c:c5", "reverse-cable-lunge", "reverse-lunge"],
  ];
  for (const [slotId, choiceId, exerciseId] of expected) {
    assert.equal(getChoice(slotId, choiceId).exerciseId, exerciseId, `${slotId}/${choiceId}`);
    assert.notEqual(getChoice(slotId, choiceId).exerciseId, getMovement(slotId).exerciseId, `${slotId}/${choiceId} must not inherit the card primary identity`);
  }
});

test("compatible alternatives share the complete previous-result identity tuple", () => {
  const tuple = (slotId, choiceId) => {
    const choice = getChoice(slotId, choiceId);
    return [choice.exerciseId, choice.variantId, choice.loadConvention, choice.metric];
  };
  assert.deepEqual(tuple("spine-safe:a:a2", "leg-press-45"), tuple("upper-lower-4x:lower-a:a1", "leg-press-45"));
  assert.deepEqual(tuple("spine-safe:b:b1", "assisted-pull-up"), tuple("athlete-full-body-3x:a:a3", "assisted-pull-up"));
  assert.deepEqual(tuple("spine-safe:b:b2", "back-extension"), tuple("athlete-full-body-3x:c:c4", "back-extension"));
  assert.deepEqual(tuple("spine-safe:a:a8", "side-plank"), tuple("upper-lower-4x:lower-b:b6", "side-plank"));
});

test("catalog lookup API resolves programs, days, cards, movements and choices", () => {
  const program = getProgram("upper-lower-4x");
  const day = getDay("upper-lower-4x", "upper-a");
  const cards = getCardsForDay(program.id, day.id);
  const card = getCard(cards[0].id);
  const movement = getMovement(card.movements[0].slotId);
  const choice = getChoice(movement.slotId, movement.defaultChoiceId);
  assert.equal(day.name, "Верх A");
  assert.equal(card.id, cards[0].id);
  assert.equal(choice.id, movement.defaultChoiceId);
});
