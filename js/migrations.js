export const LEGACY_PROGRAM_ID = "spine-safe";
export const LEGACY_PROGRAM_NAME = "PRO Spine-Safe — Zero-Axial Full Body 3x";

const LEGACY_DAY_NAMES = Object.freeze({
  a: "День A",
  b: "День B",
  c: "День C",
});

export const LEGACY_CHOICE_IDENTITY_REMAP = Object.freeze({
  "a2|leg-press-45": Object.freeze({ exerciseId: "leg-press", variantId: "leg-press-45", choiceId: "leg-press-45" }),
  "a5|incline-dumbbell-w-raise": Object.freeze({ exerciseId: "incline-w-raise", variantId: "incline-dumbbell-w-raise", choiceId: "incline-dumbbell-w-raise" }),
  "a8|bird-dog": Object.freeze({ exerciseId: "bird-dog", variantId: "bird-dog", choiceId: "bird-dog" }),
  "a8|side-plank": Object.freeze({ exerciseId: "side-plank", variantId: "side-plank", choiceId: "side-plank" }),
  "b1|assisted-pull-up": Object.freeze({ exerciseId: "pull-up", variantId: "assisted-pull-up", choiceId: "assisted-pull-up" }),
  "b2|back-extension": Object.freeze({ exerciseId: "back-extension-45", variantId: "back-extension", choiceId: "back-extension" }),
  "b5|leg-extension": Object.freeze({ exerciseId: "leg-extension", variantId: "leg-extension", choiceId: "leg-extension" }),
  "c2|b-stance-dumbbell-rdl": Object.freeze({ exerciseId: "romanian-deadlift", variantId: "b-stance-dumbbell-rdl", choiceId: "b-stance-dumbbell-rdl" }),
  "c2|bench-90": Object.freeze({ exerciseId: "back-extension-90", variantId: "bench-90", choiceId: "bench-90" }),
  "c3|assisted-pull-up": Object.freeze({ exerciseId: "pull-up", variantId: "assisted-pull-up", choiceId: "assisted-pull-up" }),
  "c4|seated-cable-crossover": Object.freeze({ exerciseId: "cable-chest-fly", variantId: "seated-cable-crossover", choiceId: "seated-cable-crossover" }),
  "c5|reverse-cable-lunge": Object.freeze({ exerciseId: "reverse-lunge", variantId: "reverse-cable-lunge", choiceId: "reverse-cable-lunge" }),
  "c8-pallof|side-plank": Object.freeze({ exerciseId: "side-plank", variantId: "side-plank", choiceId: "side-plank" }),
});

const copyRecord = (record) => ({ ...record });

export function inferLegacyDayId(slotId, fallbackDayId = null) {
  if (typeof fallbackDayId === "string" && fallbackDayId) return fallbackDayId;
  if (typeof slotId !== "string") return null;
  return slotId.match(/^([abc])(?:\d|$|-)/i)?.[1]?.toLowerCase() ?? null;
}

export function namespaceLegacySlotId(slotId, dayId, programId = LEGACY_PROGRAM_ID) {
  if (typeof slotId !== "string" || !slotId) return slotId;
  if (slotId.includes(":")) return slotId;
  const resolvedDayId = inferLegacyDayId(slotId, dayId);
  const canonicalLegacyId = programId === LEGACY_PROGRAM_ID && slotId === "c8-calves" ? "c8-calf" : slotId;
  return resolvedDayId ? `${programId}:${resolvedDayId}:${canonicalLegacyId}` : slotId;
}

export function migrateLegacySession(session, options = {}) {
  const programId = session?.programId || options.programId || LEGACY_PROGRAM_ID;
  const dayId = session?.dayId;
  const performedAt = session?.performedAt;
  return {
    ...copyRecord(session ?? {}),
    programId,
    programVersion: session?.programVersion ?? options.programVersion ?? 1,
    programNameSnapshot: session?.programNameSnapshot || options.programName || LEGACY_PROGRAM_NAME,
    dayNameSnapshot: session?.dayNameSnapshot || options.dayName || LEGACY_DAY_NAMES[dayId] || dayId || "—",
    createdAt: session?.createdAt || performedAt,
    updatedAt: session?.updatedAt || session?.completedAt || performedAt,
  };
}

export function migrateLegacyEntry(entry, session = null, options = {}) {
  const programId = entry?.programId || session?.programId || options.programId || LEGACY_PROGRAM_ID;
  const dayId = session?.dayId || inferLegacyDayId(entry?.slotId);
  const localSlotId = typeof entry?.slotId === "string" ? entry.slotId.split(":").at(-1) : null;
  const identityRemap = programId === LEGACY_PROGRAM_ID
    ? LEGACY_CHOICE_IDENTITY_REMAP[`${localSlotId}|${entry?.variantId}`]
    : null;
  return {
    ...copyRecord(entry ?? {}),
    programId,
    slotId: namespaceLegacySlotId(entry?.slotId, dayId, programId),
    choiceId: identityRemap?.choiceId || entry?.choiceId || entry?.variantId,
    exerciseId: identityRemap?.exerciseId || entry?.exerciseId,
    variantId: identityRemap?.variantId || entry?.variantId,
    equipmentKey: entry?.equipmentKey || "default",
    loadConvention: entry?.loadConvention || "total",
    exerciseNameSnapshot: entry?.exerciseNameSnapshot || entry?.exerciseId || "—",
    variantSnapshot: entry?.variantSnapshot || entry?.variantId || "—",
    notes: typeof entry?.notes === "string" ? entry.notes : "",
    updatedAt: entry?.updatedAt || session?.updatedAt || session?.performedAt,
  };
}

export function migrateLegacySetting(setting) {
  if (!setting || typeof setting !== "object") return setting;
  if (setting.key === "currentProgramId" && !setting.value) {
    return { ...setting, value: LEGACY_PROGRAM_ID };
  }
  return copyRecord(setting);
}

export function migrateLegacyData(data, options = {}) {
  const sessions = (data?.sessions ?? []).map((session) => migrateLegacySession(session, options));
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const seenSessionSlots = new Set();
  const entries = (data?.entries ?? []).map((entry) => {
    const migrated = migrateLegacyEntry(entry, sessionsById.get(entry.sessionId), options);
    const key = `${migrated.sessionId}\u0000${migrated.slotId}`;
    if (!seenSessionSlots.has(key)) {
      seenSessionSlots.add(key);
      return migrated;
    }
    const suffix = String(migrated.id ?? "entry").replace(/[^a-z0-9_-]+/gi, "-");
    const uniqueSlotId = `${migrated.slotId}:legacy-${suffix}`;
    seenSessionSlots.add(`${migrated.sessionId}\u0000${uniqueSlotId}`);
    return { ...migrated, originalSlotId: migrated.slotId, slotId: uniqueSlotId, migrationConflict: "duplicate-session-slot" };
  });
  const settings = (data?.settings ?? []).map(migrateLegacySetting).map((setting) => {
    if (setting?.key !== "activeSessionId" || !setting.value) return setting;
    return sessionsById.get(setting.value)?.status === "draft" ? setting : { ...setting, value: null };
  });
  if (!settings.some((setting) => setting?.key === "currentProgramId")) {
    settings.push({ key: "currentProgramId", value: options.programId || LEGACY_PROGRAM_ID });
  }
  return { sessions, entries, settings };
}
