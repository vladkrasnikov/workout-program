import { LEGACY_SPINE } from "./legacy-spine.js";

const CATEGORY_META = {
  "spine-care": ["Захист спини", "Програми з мінімізованим осьовим навантаженням."],
  performance: ["Атлетизм", "Сила, вільні ваги й контроль тренувальної втоми."],
  "glute-shape": ["Сідниці та постава", "Фокус на формі, пропорціях, поставі й корі."],
  splits: ["Спліти", "Спеціалізовані тренування окремих частин тіла."],
  "time-efficient": ["Коли мало часу", "Мінімальний ефективний обсяг для щільного графіка."],
};

export const CATEGORIES = Object.entries(CATEGORY_META).map(([id, [name, description]], order) => ({ id, name, description, order }));

const slug = (value) => String(value)
  .normalize("NFKD")
  .toLowerCase()
  .replace(/[°]/g, "")
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 64) || "choice";

const canonicalExerciseId = (value) => {
  const name = String(value).toLowerCase();
  const rules = [
    [/face pull.*external rotation|rope face pull/, "face-pull-external-rotation"],
    [/single-arm cable lateral|cable lateral raise/, "single-arm-lateral-raise"],
    [/overhead cable triceps/, "overhead-triceps-extension"],
    [/dead bug/, "dead-bug"],
    [/chest-supported.*wide|chest-supported machine or db row.*wide/, "chest-supported-wide-row"],
    [/belt squat/, "belt-squat"],
    [/incline.*press.*30|press \(30|press 30/, "incline-press-30"],
    [/seated.*leg curl|seated leg curl|lying leg curl/, "seated-leg-curl"],
    [/neutral.*lat pulldown/, "neutral-lat-pulldown"],
    [/machine hip thrust|glute drive|barbell.*hip thrust/, "hip-thrust"],
    [/unilateral seated cable row/, "unilateral-seated-row"],
    [/high-incline.*shoulder press|75.*shoulder press/, "high-incline-shoulder-press"],
    [/unilateral leg press/, "unilateral-leg-press"],
    [/45.*leg press|leg press 45/, "leg-press"],
    [/y-raise/, "incline-y-raise"],
    [/bayesian.*curl|incline db curl/, "lengthened-biceps-curl"],
    [/calf raise/, "leg-press-calf-raise"],
    [/iso-lateral row|isolateral row/, "chest-supported-isolateral-row"],
    [/45.*back extension|back extension.*45/, "back-extension-45"],
    [/medium-wide.*lat pulldown|pronated lat pulldown/, "pronated-lat-pulldown"],
    [/flat.*machine.*press|slight-decline machine press/, "flat-machine-chest-press"],
    [/bulgarian split squat/, "bulgarian-split-squat"],
    [/reverse pec deck/, "reverse-pec-deck"],
    [/pallof press/, "pallof-press"],
    [/romanian deadlift|barbell rdl|dumbbell rdl|b-stance rdl/, "romanian-deadlift"],
    [/back squat/, "back-squat"],
    [/hack squat|pendulum squat/, "hack-squat"],
    [/pull-up|pullup|chin-up|chinup/, "pull-up"],
    [/leg extension/, "leg-extension"],
    [/hip abduction/, "hip-abduction"],
    [/rkc plank/, "rkc-plank"],
    [/ab wheel/, "ab-wheel"],
    [/hanging leg raise/, "hanging-leg-raise"],
    [/triceps pushdown/, "triceps-pushdown"],
  ];
  return rules.find(([pattern]) => pattern.test(name))?.[1] ?? slug(value);
};

const variantIdForName = (value) => {
  const name = String(value).toLowerCase();
  if (/assisted pull|гравітрон/.test(name)) return "assisted-pull-up";
  if (/side plank|бічна планка/.test(name)) return "side-plank";
  if (/bird dog/.test(name)) return "bird-dog";
  if (/leg extension|розгинання ніг/.test(name)) return "leg-extension";
  if (/45.*leg press|leg press 45/.test(name)) return "leg-press-45";
  if (/back extension|гіперекстензі/.test(name)) return "back-extension";
  if (/cable crossover|кросовер сидячи/.test(name)) return "seated-cable-crossover";
  if (/reverse.*lunge|випади назад/.test(name)) return "reverse-cable-lunge";
  if (/w-raise/.test(name)) return "incline-dumbbell-w-raise";
  if (/bodyweight|власн/.test(name)) return "bodyweight";
  if (/smith|сміт/.test(name)) return "smith";
  if (/dumbbell| db |гантел/.test(` ${name} `)) return "dumbbell";
  if (/barbell|штанг/.test(name)) return "barbell";
  if (/cable|блок|кросовер/.test(name)) return "cable";
  if (/band|гумк/.test(name)) return "band";
  if (/leg press/.test(name)) return "leg-press";
  if (/machine|тренаж/.test(name)) return "machine";
  if (/plate|млин/.test(name)) return "plate";
  return slug(value).slice(0, 32);
};

const choiceOptions = (name) => {
  const lower = String(name).toLowerCase();
  const metric = /plank|side plank|планк/.test(lower) ? "duration" : /dead bug|bodyweight|ab wheel|hanging leg|band/.test(lower) ? "reps" : "load-reps";
  const unilateral = /single|one-arm|unilateral|однією|одній|бік|нога/.test(lower);
  const loadConvention = metric !== "load-reps" ? "none" : /dumbbell|гантел/.test(lower) ? "per-hand" : unilateral ? "per-side" : "total";
  return { metric, loadConvention, unilateral, equipmentKey: "default" };
};

const makeChoice = (name, index, usedIds, override = {}) => {
  const baseId = override.variantId ?? variantIdForName(name);
  let id = baseId;
  let suffix = 2;
  while (usedIds.has(id)) id = `${baseId}-${suffix++}`;
  usedIds.add(id);
  return {
    id,
    exerciseId: override.exerciseId ?? canonicalExerciseId(name),
    variantId: override.variantId ?? id,
    name: String(name).trim(),
    ...choiceOptions(name),
    ...override,
    id,
  };
};

const alternativeNames = (card, movementName, explicitNames) => {
  if (explicitNames?.length) return [...new Set(explicitNames.map((item) => item.trim()).filter(Boolean))];
  const short = String(card.shortAlternative ?? "").replace(/^.*?(?:Заміна|Альтернатива):\s*/iu, "");
  const candidates = movementName.split(/\s*\(?\s*(?:або|or)\s+/iu);
  if (short && short !== movementName) candidates.push(...short.split(/\s*\(?\s*(?:або|or)\s+/iu));
  for (const alternative of card.content.alternatives ?? []) {
    const compact = alternative.replace(/^(?:План [^ ]+\s*)/u, "").split(":")[0].trim();
    if (compact) candidates.push(compact);
  }
  return [...new Set(candidates.map((item) => item.trim()).filter(Boolean))].slice(0, 6);
};

const parsePrescription = (label, params = [], override = {}) => {
  const source = override.label ?? label ?? params[0] ?? "";
  const setsMatch = source.match(/(\d+)\s*(?:[–-]\s*(\d+))?\s*[×x]/u);
  const targetMatch = source.match(/[×x]\s*(\d+)\s*(?:[–-]\s*(\d+))?/u);
  const duration = /(?:\d\s*)?(?:с|сек|sec)(?:\s|$)/iu.test(source);
  const setsMin = Number(override.sets?.min ?? setsMatch?.[1] ?? 2);
  const setsMax = Number(override.sets?.max ?? setsMatch?.[2] ?? setsMin);
  const targetMin = Number(override.target?.min ?? targetMatch?.[1] ?? 1);
  const targetMax = Number(override.target?.max ?? targetMatch?.[2] ?? targetMin);
  return {
    sets: { min: setsMin, max: setsMax, default: Number(override.sets?.default ?? setsMin) },
    target: { kind: override.target?.kind ?? (duration ? "duration" : "reps"), min: targetMin, max: targetMax },
    perSide: override.perSide ?? /\/\s*(?:бік|нога|leg|side)/iu.test(source),
    note: override.note ?? params.slice(1).join(" • "),
    label: source,
  };
};

const COMPOUNDS = {
  "spine-safe:c:c8": [
    { key: "pallof", name: "Standing Cable Pallof Press", label: "2 × 10–12 / бік", perSide: true },
    { key: "calf", legacyKey: "c8-calves", name: "Leg Press Calf Raise", label: "2 × 12–15" },
  ],
  "athlete-full-body-3x:c:c8": [
    { key: "pallof", name: "Cable Pallof Press", label: "2 × 10–12 / бік", perSide: true },
    { key: "calves", name: "Calf Raise", label: "2 × 12–15" },
  ],
  "glute-shape-posture-3x:c:c8": [
    { key: "pallof", name: "Cable Pallof Press", label: "2 × 12 / бік", perSide: true },
    { key: "calves", name: "Leg Press Calf Raise", label: "2 × 15" },
  ],
  "upper-lower-4x:upper-a:a7": [
    { key: "triceps", name: "Overhead Cable Triceps Extension", label: "2 × 10–15" },
    { key: "biceps", name: "Bayesian Cable Curl", label: "2 × 10–15" },
  ],
  "upper-lower-4x:upper-b:b7": [
    { key: "biceps", name: "Bayesian Cable Curl", label: "2 × 10–15" },
    { key: "triceps", name: "Rope Triceps Pushdown / Overhead", label: "2 × 10–15" },
  ],
  "upper-lower-4x:lower-b:b5": [
    { key: "abduction", name: "Seated Hip Abduction", label: "2 × 15" },
    { key: "calves", name: "Leg Press Calf Raise", label: "3 × 10–15" },
  ],
  "minimalist-busy-pro-2x:day-1:m5": [
    { key: "face-pull", name: "Rope Face Pull", label: "2 × 12–15" },
    { key: "lateral", name: "Cable Lateral Raise", label: "2 × 12–15" },
  ],
  "minimalist-busy-pro-2x:day-1:m6": [
    { key: "triceps", name: "Overhead Cable Triceps Extension", label: "2 × 10–15" },
    { key: "dead-bug", name: "Dead Bug", label: "2 × 10–15" },
  ],
  "minimalist-busy-pro-2x:day-2:m5": [
    { key: "y-raise", name: "Incline Y-Raise", label: "2 × 12–15" },
    { key: "rear-delt", name: "Reverse Pec Deck", label: "2 × 12–15" },
  ],
  "minimalist-busy-pro-2x:day-2:m6": [
    { key: "biceps", name: "Bayesian Cable Curl", label: "2 × 10–15" },
    { key: "calves-pallof", name: "Leg Press Calf Raise / Pallof Press", label: "2 × 10–15", choiceNames: ["Leg Press Calf Raise", "Pallof Press"] },
  ],
};

const MINIMAL_AGGREGATES = {
  "day-1": {
    label: "День 1 (Вівторок) • Комплекс А • Повне тіло за 45 хвилин (6 вправ × 2 важкі сети)",
    name: "Сесія 1: Chest-Supported Row + Belt Squat/Leg Press + Incline Press 30° + Seated Leg Curl + Rope Face Pull + Overhead Triceps/Dead Bug",
    shortAlternative: "🔄 Заміна: Працює в будь-якому залі",
    params: ["6 вправ × 2 сети (6–10 повт.)", "RIR 0–1", "Осьове: 0–1/10", "2–2.5 хв"],
  },
  "day-2": {
    label: "День 2 (П'ятниця/Субота) • Комплекс Б • Повне тіло за 45 хвилин (6 вправ × 2 важкі сети)",
    name: "Сесія 2: Lat Pulldown + Glute Drive/Back Extension + Unilateral Leg Press/Split Squat + High-Incline Press 75° + Incline Y-Raise/Rear Delt + Bayesian Curl/Pallof Press",
    shortAlternative: "🔄 Заміна: Працює в будь-якому залі",
    params: ["6 вправ × 2 сети (6–10 повт.)", "RIR 0–1", "Осьове: 0–1/10", "2–2.5 хв"],
  },
};

// Historical spine slots used one exercise id for every selectable alternative.
// V2 keeps the primary ids stable while assigning genuinely different movements
// their own identities so previous-result matching cannot cross incompatible work.
const LEGACY_CHOICE_EXERCISE_IDS = {
  "a2:leg-press-45": "leg-press",
  "a5:incline-dumbbell-w-raise": "incline-w-raise",
  "a8:bird-dog": "bird-dog",
  "a8:side-plank": "side-plank",
  "b1:assisted-pull-up": "pull-up",
  "b2:back-extension": "back-extension-45",
  "b5:leg-extension": "leg-extension",
  "c2:b-stance-dumbbell-rdl": "romanian-deadlift",
  "c2:bench-90": "back-extension-90",
  "c3:assisted-pull-up": "pull-up",
  "c4:seated-cable-crossover": "cable-chest-fly",
  "c5:reverse-cable-lunge": "reverse-lunge",
  "c8-pallof:side-plank": "side-plank",
};

const legacyKey = (dayId, cardId, spec) => spec?.legacyKey ?? (spec?.key ? `${cardId}-${spec.key}` : cardId);

const makeMovement = (program, day, card, spec, index) => {
  const movementName = spec?.name ?? card.name;
  const localLegacyKey = legacyKey(day.id, card.localId, spec);
  const legacy = program.id === "spine-safe" ? LEGACY_SPINE[localLegacyKey] : null;
  const usedIds = new Set();
  const choices = legacy
    ? legacy.variants.map((variant) => makeChoice(variant.name, 0, usedIds, {
      exerciseId: LEGACY_CHOICE_EXERCISE_IDS[`${localLegacyKey}:${variant.id}`] ?? legacy.exerciseId,
      variantId: variant.id,
      metric: variant.metric,
      loadConvention: variant.loadConvention,
      unilateral: variant.unilateral,
      equipmentKey: variant.equipmentKey,
    }))
    : alternativeNames(card, movementName, spec?.choiceNames).map((name, choiceIndex) => makeChoice(name, choiceIndex, usedIds, choiceIndex === 0 && spec?.exerciseId ? { exerciseId: spec.exerciseId } : {}));
  const defaultChoice = choices[0];
  const prescription = parsePrescription(card.params[0], card.params, spec ?? {});
  const slotId = spec ? `${card.id}-${spec.key}` : card.id;
  const movement = {
    slotId,
    name: movementName,
    prescription,
    choices,
    defaultChoiceId: legacy?.defaultVariantId ?? defaultChoice.id,
    parentCardId: card.id,
    exerciseId: defaultChoice.exerciseId,
    legacySlotId: localLegacyKey,
  };
  // Compatibility for the pre-catalog workout engine during staged migration.
  movement.sets = prescription.sets.default;
  movement.repRange = [prescription.target.min, prescription.target.max];
  movement.variants = choices;
  movement.defaultVariantId = movement.defaultChoiceId;
  movement.parentSlotId = spec ? card.id : undefined;
  return movement;
};

export function defineProgram(rawProgram) {
  const program = { ...rawProgram };
  program.days = rawProgram.days.map((rawDay) => {
    const day = { ...rawDay };
    day.cards = rawDay.cards.map((rawCard) => {
      const card = {
        ...rawCard,
        localId: rawCard.id,
        id: `${program.id}:${rawDay.id}:${rawCard.id}`,
      };
      const compound = COMPOUNDS[`${program.id}:${rawDay.id}:${rawCard.id}`];
      card.movements = (compound ?? [null]).map((spec, index) => makeMovement(program, day, card, spec, index));
      return card;
    });
    const sourceAggregate = program.id === "minimalist-busy-pro-2x" ? MINIMAL_AGGREGATES[day.id] : null;
    if (sourceAggregate) {
      day.sourceAggregate = {
        ...sourceAggregate,
        content: {
          technique: day.cards[0].content.technique,
          alternatives: day.cards[0].content.alternatives.slice(0, -1),
          cue: day.cards[0].content.cue,
        },
      };
    }
    // Compatibility alias; cards remain the canonical model.
    day.slots = day.cards.flatMap((card) => card.movements);
    return day;
  });
  return program;
}

export const catalogInternals = { canonicalExerciseId, parsePrescription };
