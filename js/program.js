export const PROGRAM_VERSION = 1;

const variant = (id, name, options = {}) => ({
  id,
  name,
  metric: "load-reps",
  equipmentKey: "default",
  unilateral: false,
  loadConvention: "total",
  ...options,
});

const movement = (exerciseId, name, sets, repRange, variants, options = {}) => ({
  exerciseId,
  name,
  sets,
  repRange,
  variants,
  defaultVariantId: variants[0].id,
  ...options,
});

export const PROGRAM = {
  version: PROGRAM_VERSION,
  days: {
    a: {
      id: "a",
      name: "День A",
      slots: [
        movement("chest-supported-wide-row", "Chest-Supported Machine Row (Wide Grip)", 2, [8, 12], [
          variant("machine", "Тренажер"),
          variant("incline-dumbbell", "Тяга гантелей на лаві 30°", { loadConvention: "per-hand" }),
          variant("wide-cable", "Широка тяга в нижньому блоці"),
        ], { slotId: "a1" }),
        movement("belt-squat", "Belt Squat", 2, [8, 12], [
          variant("machine", "Belt Squat"),
          variant("leg-press-45", "Жим ногами 45°"),
          variant("cable-belt-squat", "Belt Squat у кросовері"),
        ], { slotId: "a2" }),
        movement("incline-press-30", "Incline Press 30°", 2, [8, 12], [
          variant("smith", "Тренажер Сміта"),
          variant("machine", "Жимова машина"),
          variant("barbell", "Штанга", { loadConvention: "total" }),
          variant("dumbbell", "Гантелі", { loadConvention: "per-hand" }),
        ], { slotId: "a3" }),
        movement("seated-leg-curl", "Seated Leg Curl", 2, [10, 15], [
          variant("machine", "Згинання ніг сидячи"),
          variant("lying-machine", "Згинання ніг лежачи"),
          variant("standing-single-leg", "Згинання стоячи по одній нозі", { unilateral: true, loadConvention: "per-side" }),
        ], { slotId: "a4" }),
        movement("face-pull-external-rotation", "High-Pulley Rope Face Pull + External Rotation", 2, [12, 15], [
          variant("cable", "Канат у блоці"),
          variant("incline-dumbbell-w-raise", "W-Raise з гантелями", { loadConvention: "per-hand" }),
          variant("band-face-pull", "Face Pull з гумкою", { metric: "reps", loadConvention: "none" }),
        ], { slotId: "a5" }),
        movement("single-arm-lateral-raise", "Single-Arm Cable Lateral Raise", 2, [12, 15], [
          variant("cable", "Нижній блок", { unilateral: true, loadConvention: "per-side" }),
          variant("dumbbell", "Гантель", { unilateral: true, loadConvention: "per-hand" }),
          variant("machine", "Тренажер махів"),
        ], { slotId: "a6" }),
        movement("overhead-triceps-extension", "Overhead Cable Triceps Extension", 2, [10, 15], [
          variant("cable", "Канат у блоці"),
          variant("incline-ez-bar", "Французький жим EZ-штанги", { loadConvention: "total" }),
          variant("incline-dumbbell", "Французький жим гантелей", { loadConvention: "per-hand" }),
        ], { slotId: "a7" }),
        movement("dead-bug", "Dead Bug", 2, [8, 10], [
          variant("bodyweight", "Dead Bug", { metric: "reps", loadConvention: "none", unilateral: true }),
          variant("bench", "Bench Dead Bug", { metric: "reps", loadConvention: "none", unilateral: true }),
          variant("bird-dog", "Bird Dog", { metric: "reps", loadConvention: "none", unilateral: true }),
          variant("side-plank", "Side Plank", { metric: "duration", loadConvention: "none", unilateral: true }),
        ], { slotId: "a8" }),
      ],
    },
    b: {
      id: "b",
      name: "День B",
      slots: [
        movement("neutral-lat-pulldown", "Neutral-Grip Lat Pulldown", 2, [8, 12], [
          variant("cable", "Верхній блок"),
          variant("assisted-pull-up", "Підтягування у гравітроні"),
          variant("hammer", "Хаммер верхня тяга"),
        ], { slotId: "b1" }),
        movement("hip-thrust", "Machine Hip Thrust / Glute Drive", 2, [8, 12], [
          variant("machine", "Glute Drive"),
          variant("smith", "Тренажер Сміта"),
          variant("back-extension", "Гіперекстензія"),
        ], { slotId: "b2" }),
        movement("unilateral-seated-row", "Unilateral Seated Cable Row", 2, [8, 12], [
          variant("cable", "Нижній блок", { unilateral: true, loadConvention: "per-side" }),
          variant("one-arm-dumbbell", "Тяга гантелі з опорою", { unilateral: true, loadConvention: "per-hand" }),
        ], { slotId: "b3" }),
        movement("high-incline-shoulder-press", "High-Incline Shoulder Press", 2, [8, 12], [
          variant("smith", "Тренажер Сміта"),
          variant("machine", "Жимова машина"),
          variant("dumbbell", "Гантелі", { loadConvention: "per-hand" }),
        ], { slotId: "b4" }),
        movement("unilateral-leg-press", "Unilateral Leg Press", 2, [10, 12], [
          variant("machine", "Жим ногами", { unilateral: true, loadConvention: "per-side" }),
          variant("horizontal-machine", "Горизонтальний жим ногами", { unilateral: true, loadConvention: "per-side" }),
          variant("leg-extension", "Розгинання ніг сидячи", { unilateral: true, loadConvention: "per-side" }),
        ], { slotId: "b5" }),
        movement("incline-y-raise", "Chest-Supported Incline Y-Raise", 2, [12, 15], [
          variant("cable", "Кабель"),
          variant("dumbbell", "Гантелі", { loadConvention: "per-hand" }),
          variant("plate", "Млинці", { loadConvention: "per-hand" }),
        ], { slotId: "b6" }),
        movement("lengthened-biceps-curl", "Bayesian Cable Curl / Incline DB Curl", 2, [10, 15], [
          variant("bayesian-cable", "Bayesian Cable Curl", { unilateral: true, loadConvention: "per-side" }),
          variant("incline-dumbbell", "Incline DB Curl", { loadConvention: "per-hand" }),
        ], { slotId: "b7" }),
        movement("leg-press-calf-raise", "Leg Press Calf Raise", 2, [10, 15], [
          variant("leg-press", "Жим ногами"),
          variant("single-leg-dumbbell", "На одній нозі з гантеллю", { unilateral: true, loadConvention: "per-hand" }),
          variant("seated", "Підйом на носки сидячи"),
        ], { slotId: "b8" }),
      ],
    },
    c: {
      id: "c",
      name: "День C",
      slots: [
        movement("chest-supported-isolateral-row", "Chest-Supported Iso-Lateral Row", 2, [8, 12], [
          variant("hammer", "Hammer / ізолатеральний тренажер"),
          variant("incline-dumbbell", "Тяга двох гантелей на лаві 30°", { loadConvention: "per-hand" }),
          variant("cable-v-handle", "Тяга блока з V-ручкою"),
        ], { slotId: "c1" }),
        movement("back-extension-45", "45° Back Extension", 2, [10, 15], [
          variant("plate", "З млинцем"),
          variant("bodyweight", "Власна вага", { metric: "reps", loadConvention: "none" }),
          variant("b-stance-dumbbell-rdl", "B-Stance RDL з гантеллю", { unilateral: true, loadConvention: "per-hand" }),
          variant("bench-90", "Гіперекстензія на лаві 90°"),
        ], { slotId: "c2" }),
        movement("pronated-lat-pulldown", "Medium-Wide Pronated Lat Pulldown", 2, [8, 12], [
          variant("cable", "Верхній блок"),
          variant("hammer", "Iso-Lateral Pulldown"),
          variant("assisted-pull-up", "Гравітрон"),
        ], { slotId: "c3" }),
        movement("flat-machine-chest-press", "Flat / Slight-Decline Machine Chest Press", 2, [8, 12], [
          variant("machine", "Жимова машина"),
          variant("smith", "Тренажер Сміта"),
          variant("barbell", "Жим штанги", { loadConvention: "total" }),
          variant("seated-cable-crossover", "Кросовер сидячи"),
        ], { slotId: "c4" }),
        movement("bulgarian-split-squat", "Bulgarian Split Squat", 2, [8, 12], [
          variant("dumbbell", "Гантель", { unilateral: true, loadConvention: "per-hand" }),
          variant("cable", "Нижній блок", { unilateral: true, loadConvention: "per-side" }),
          variant("bodyweight", "Власна вага", { metric: "reps", unilateral: true, loadConvention: "none" }),
          variant("smith", "Спліт-присідання у Сміті", { unilateral: true, loadConvention: "per-side" }),
          variant("reverse-cable-lunge", "Випади назад з нижнього блоку", { unilateral: true, loadConvention: "per-side" }),
        ], { slotId: "c5" }),
        movement("reverse-pec-deck", "Reverse Pec Deck", 2, [12, 15], [
          variant("machine", "Тренажер"),
          variant("cable-cross", "Перехресне розведення тросів"),
          variant("incline-dumbbell", "Махи лежачи на лаві 30°", { loadConvention: "per-hand" }),
        ], { slotId: "c6" }),
        movement("single-arm-lateral-raise", "Single-Arm Cable Lateral Raise", 2, [12, 15], [
          variant("cable", "Нижній блок", { unilateral: true, loadConvention: "per-side" }),
          variant("dumbbell", "Гантель", { unilateral: true, loadConvention: "per-hand" }),
          variant("machine", "Тренажер махів"),
        ], { slotId: "c7" }),
        movement("pallof-press", "Standing Cable Pallof Press", 2, [10, 12], [
          variant("cable", "Блок", { unilateral: true, loadConvention: "per-side" }),
          variant("band", "Гумка", { metric: "reps", unilateral: true, loadConvention: "none" }),
          variant("side-plank", "Side Plank", { metric: "duration", unilateral: true, loadConvention: "none" }),
        ], { slotId: "c8-pallof", parentSlotId: "c8" }),
        movement("leg-press-calf-raise", "Leg Press Calf Raise", 2, [12, 15], [
          variant("leg-press", "Жим ногами"),
          variant("single-leg-dumbbell", "На одній нозі з гантеллю", { unilateral: true, loadConvention: "per-hand" }),
          variant("seated", "Підйом на носки сидячи"),
        ], { slotId: "c8-calves", parentSlotId: "c8" }),
      ],
    },
  },
};

export const ALL_SLOTS = Object.values(PROGRAM.days).flatMap((day) => day.slots.map((slot) => ({ ...slot, dayId: day.id })));
export const SLOT_BY_ID = new Map(ALL_SLOTS.map((slot) => [slot.slotId, slot]));

export function getDay(dayId) {
  return PROGRAM.days[dayId] ?? null;
}

export function getSlot(slotId) {
  return SLOT_BY_ID.get(slotId) ?? null;
}

export function getVariant(slotId, variantId) {
  return getSlot(slotId)?.variants.find((item) => item.id === variantId) ?? null;
}

export function getSlotsForDomSlot(slotId) {
  return ALL_SLOTS.filter((slot) => slot.slotId === slotId || slot.parentSlotId === slotId);
}
