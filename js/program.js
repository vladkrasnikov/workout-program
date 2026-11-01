import {
  ALL_MOVEMENTS,
  CATEGORIES,
  DEFAULT_PROGRAM_ID,
  PROGRAM_LIST,
  PROGRAMS,
  getCard,
  getCardsForDay,
  getChoice as getCatalogChoice,
  getDay as getCatalogDay,
  getMovement as getCatalogMovement,
  getMovementsForCard,
  getProgram,
} from "./catalog/index.js";

export const PROGRAM_VERSION = 2;
export { CATEGORIES, DEFAULT_PROGRAM_ID, PROGRAM_LIST, PROGRAMS, getCard, getCardsForDay, getMovementsForCard, getProgram };

const defaultProgram = getProgram(DEFAULT_PROGRAM_ID);

// Temporary compatibility shape for consumers migrating from the original
// single-program catalog. New code should use PROGRAMS / PROGRAM_LIST.
export const PROGRAM = {
  ...defaultProgram,
  version: PROGRAM_VERSION,
  days: Object.fromEntries(defaultProgram.days.map((day) => [day.id, day])),
};

export const ALL_SLOTS = defaultProgram.days.flatMap((day) => day.cards.flatMap((card) => card.movements).map((movement) => ({ ...movement, dayId: day.id })));

const legacySlotAliases = new Map();
for (const movement of ALL_SLOTS) {
  legacySlotAliases.set(movement.slotId, movement);
  legacySlotAliases.set(movement.legacySlotId, movement);
}

export const SLOT_BY_ID = new Map(ALL_SLOTS.map((slot) => [slot.slotId, slot]));

export function getDay(programId, dayId) {
  if (dayId === undefined) return getCatalogDay(DEFAULT_PROGRAM_ID, programId);
  return getCatalogDay(programId, dayId);
}

export function getSlot(slotId) {
  return getMovement(slotId);
}

export function getVariant(slotId, variantId) {
  return getChoice(slotId, variantId);
}

export function getMovement(slotId) {
  return getCatalogMovement(slotId) ?? legacySlotAliases.get(slotId) ?? null;
}

export function getChoice(slotId, choiceId) {
  return getCatalogChoice(slotId, choiceId) ?? getMovement(slotId)?.choices.find((choice) => choice.id === choiceId || choice.variantId === choiceId) ?? null;
}

export function getSlotsForDomSlot(slotId) {
  return ALL_SLOTS.filter((slot) => slot.legacySlotId === slotId || slot.legacySlotId.startsWith(`${slotId}-`));
}

export { ALL_MOVEMENTS };
