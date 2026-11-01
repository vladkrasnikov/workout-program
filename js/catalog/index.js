import spineSafeRaw from "./spine-safe.js";
import athleteRaw from "./athlete.js";
import gluteShapeRaw from "./glute-shape.js";
import upperLowerRaw from "./upper-lower.js";
import minimalistRaw from "./minimalist.js";
import { CATEGORIES, defineProgram } from "./shared.js";

export { CATEGORIES };

export const DEFAULT_PROGRAM_ID = "spine-safe";

export const PROGRAM_LIST = [spineSafeRaw, athleteRaw, gluteShapeRaw, upperLowerRaw, minimalistRaw].map(defineProgram);
export const PROGRAMS = Object.fromEntries(PROGRAM_LIST.map((program) => [program.id, program]));

const CARD_BY_ID = new Map();
const MOVEMENT_BY_ID = new Map();
for (const program of PROGRAM_LIST) {
  for (const day of program.days) {
    for (const card of day.cards) {
      CARD_BY_ID.set(card.id, card);
      for (const movement of card.movements) MOVEMENT_BY_ID.set(movement.slotId, movement);
    }
  }
}

export function getProgram(programId = DEFAULT_PROGRAM_ID) {
  return PROGRAMS[programId] ?? null;
}

export function getDay(programId, dayId) {
  return getProgram(programId)?.days.find((day) => day.id === dayId) ?? null;
}

export function getCard(cardId) {
  return CARD_BY_ID.get(cardId) ?? null;
}

export function getMovement(slotId) {
  return MOVEMENT_BY_ID.get(slotId) ?? null;
}

export function getChoice(slotId, choiceId) {
  return getMovement(slotId)?.choices.find((choice) => choice.id === choiceId || choice.variantId === choiceId) ?? null;
}

export function getCardsForDay(programId, dayId) {
  return getDay(programId, dayId)?.cards ?? [];
}

export function getMovementsForCard(cardId) {
  return getCard(cardId)?.movements ?? [];
}

export const ALL_CARDS = PROGRAM_LIST.flatMap((program) => program.days.flatMap((day) => day.cards));
export const ALL_MOVEMENTS = ALL_CARDS.flatMap((card) => card.movements);
