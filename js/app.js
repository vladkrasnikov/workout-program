import { CATEGORIES, DEFAULT_PROGRAM_ID, PROGRAM_LIST, getCard, getChoice, getDay, getProgram } from "./program.js";
import {
  changeEntryChoice, findPreviousResult, findStableWorkingLoad, finishSession, getActiveSession, localDateString,
  makeDraftSet, parseLocalizedNumber, startSession, validWorkingSets, validateSet,
} from "./workouts.js";
import {
  RevisionConflictError, deleteSession, exportAllData, getSetting, listEntries,
  listEntriesForSession, listSessions, putEntry, putSession, putSetting,
} from "./storage.js";
import { createBackup, downloadBackup, planMerge, restoreBackup, validateBackup } from "./backup.js";
import {
  formatEntryResult, formatWorkoutDate, renderExerciseHistory, renderHistoryFilters,
  renderSessionDetail, renderSessionList,
} from "./history.js";

const state = {
  active: null,
  sessions: [],
  entries: [],
  selectedProgramId: DEFAULT_PROGRAM_ID,
  selectedDayId: null,
  historyFilters: { programId: "all", dayId: "all" },
  saveTimers: new Map(),
  saveQueues: new Map(),
  dirtyEntries: new Set(),
  saveBlocked: false,
};

const byId = (id) => document.getElementById(id);
const element = (tag, options = {}) => {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type) node.type = options.type;
  return node;
};

function setStatus(message, isError = false) {
  const output = byId("save-status");
  if (!output) return;
  output.textContent = message;
  output.classList.toggle("status-error", isError);
}

function setBackupStatus(message, isError = false) {
  const output = byId("backup-status");
  if (!output) return;
  output.textContent = message;
  output.classList.toggle("status-error", isError);
}

function reportError(error, target = "save") {
  const message = error instanceof RevisionConflictError
    ? "Запис змінено в іншій вкладці. Перезавантаж сторінку, щоб не затерти нові дані."
    : (error?.message || "Невідома помилка");
  if (target === "backup") setBackupStatus(message, true);
  else setStatus(message, true);
  console.error(error);
}

function currentProgram() {
  return getProgram(state.selectedProgramId) ?? getProgram(DEFAULT_PROGRAM_ID);
}

function currentDay() {
  const program = currentProgram();
  return getDay(program.id, state.selectedDayId) ?? program.days[0];
}

function selectProgram(programId, dayId = null) {
  const program = getProgram(programId) ?? getProgram(DEFAULT_PROGRAM_ID);
  state.selectedProgramId = program.id;
  state.selectedDayId = getDay(program.id, dayId)?.id ?? program.days[0].id;
}

function showMainTab(id) {
  const radio = byId(`nav-${id}`);
  if (radio) radio.checked = true;
  updateTabAria();
}

function updateTabAria() {
  document.querySelectorAll('.bottom-nav label[role="tab"][for]').forEach((label) => {
    const selected = Boolean(byId(label.htmlFor)?.checked);
    label.setAttribute("aria-selected", String(selected));
    label.tabIndex = selected ? 0 : -1;
  });
}

function performedAtForDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Обери коректну дату тренування");
  const [year, month, day] = date.split("-").map(Number);
  const now = new Date();
  const candidate = new Date(year, month - 1, day, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  if (Number.isNaN(candidate.getTime()) || candidate.getFullYear() !== year || candidate.getMonth() !== month - 1 || candidate.getDate() !== day) {
    throw new Error("Обери коректну дату тренування");
  }
  return candidate.toISOString();
}

async function refreshData() {
  [state.sessions, state.entries] = await Promise.all([listSessions(), listEntries()]);
}

function entryForSlot(slotId) {
  return state.active?.entries.find((entry) => entry.slotId === slotId) ?? null;
}

function replaceActiveEntry(next) {
  const index = state.active.entries.findIndex((entry) => entry.id === next.id);
  if (index >= 0) state.active.entries[index] = next;
}

function scheduleSave(entry, immediate = false) {
  state.dirtyEntries.add(entry.id);
  setStatus("Збереження…");
  const timer = state.saveTimers.get(entry.id);
  if (timer) clearTimeout(timer);
  if (immediate) {
    state.saveTimers.delete(entry.id);
    void persistEntry(entry);
  } else {
    state.saveTimers.set(entry.id, setTimeout(() => {
      state.saveTimers.delete(entry.id);
      void persistEntry(entry);
    }, 400));
  }
}

const clone = (value) => globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));

function persistEntry(entry) {
  const previous = state.saveQueues.get(entry.id) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const current = entryForSlot(entry.slotId);
    if (!current || current.id !== entry.id || !state.dirtyEntries.has(entry.id)) return current;
    state.dirtyEntries.delete(entry.id);
    const saved = await putEntry(clone(current), current.revision);
    current.revision = saved.revision;
    current.updatedAt = saved.updatedAt;
    state.saveBlocked = false;
    setStatus("Збережено");
    return saved;
  }).catch((error) => {
    state.saveBlocked = error instanceof RevisionConflictError;
    state.dirtyEntries.add(entry.id);
    reportError(error);
    return null;
  });
  state.saveQueues.set(entry.id, task);
  return task;
}

async function flushSaves() {
  for (const timer of state.saveTimers.values()) clearTimeout(timer);
  state.saveTimers.clear();
  for (const id of [...state.dirtyEntries]) {
    const entry = state.active?.entries.find((item) => item.id === id);
    if (entry) void persistEntry(entry);
  }
  await Promise.all([...state.saveQueues.values()]);
  if (state.saveBlocked || state.dirtyEntries.size) throw new Error("Не всі зміни збережено. Усунь конфлікт перед завершенням.");
}

function fieldLabel(text, control, className = "") {
  const label = element("label", { className: `field-label ${className}`.trim(), text });
  label.append(control);
  return label;
}

function numberInput(value, label, step = "1") {
  const input = element("input");
  input.type = "number";
  input.inputMode = "decimal";
  input.min = "0";
  input.step = step;
  input.value = value ?? "";
  input.setAttribute("aria-label", label);
  return input;
}

function previousFor(entry) {
  return findPreviousResult(entry, state.sessions, state.entries, state.active?.session.performedAt);
}

function stableLoadFor(entry) {
  return findStableWorkingLoad(entry, state.sessions, state.entries, state.active?.session.performedAt);
}

function fillEmptyLoads(entry, stableLoad) {
  if (!stableLoad || entry.metric !== "load-reps") return false;
  let changed = false;
  for (const set of entry.sets) {
    if (set.loadKg === null || set.loadKg === undefined || set.loadKg === "") {
      set.loadKg = stableLoad.loadKg;
      changed = true;
    }
  }
  return changed;
}

function renderSetRow(entry, set, choice) {
  const row = element("div", { className: "set-row" });
  row.dataset.setId = set.id;
  row.append(element("span", { className: "set-number", text: `#${set.order}` }));
  let loadInput = null;
  let confirmInput;
  if (entry.metric === "load-reps") {
    loadInput = numberInput(set.loadKg, "Вага, кг", "0.25");
    loadInput.addEventListener("input", () => {
      set.loadKg = parseLocalizedNumber(loadInput.value);
      set.confirmed = false;
      confirmInput.checked = false;
      scheduleSave(entry);
    });
    row.append(fieldLabel("Вага, кг", loadInput));
  }
  const countLabel = entry.metric === "duration" ? "Секунди" : "Повтори";
  const countInput = numberInput(entry.metric === "duration" ? set.durationSeconds : set.reps, countLabel);
  countInput.addEventListener("input", () => {
    if (entry.metric === "duration") set.durationSeconds = parseLocalizedNumber(countInput.value);
    else set.reps = parseLocalizedNumber(countInput.value);
    set.confirmed = false;
    confirmInput.checked = false;
    scheduleSave(entry);
  });
  row.append(fieldLabel(countLabel, countInput));
  if (choice.unilateral) {
    const side = element("select");
    for (const [value, text] of [["both", "Обидві"], ["left", "Ліва"], ["right", "Права"]]) {
      const option = element("option", { text });
      option.value = value;
      option.selected = set.side === value;
      side.append(option);
    }
    side.addEventListener("change", () => {
      set.side = side.value;
      set.confirmed = false;
      confirmInput.checked = false;
      scheduleSave(entry);
    });
    row.append(fieldLabel("Сторона", side, "side-field"));
  }
  const confirmLabel = element("label", { className: "confirm-set" });
  confirmInput = element("input");
  confirmInput.type = "checkbox";
  confirmInput.checked = Boolean(set.confirmed);
  confirmInput.setAttribute("aria-label", `Підхід ${set.order} виконано`);
  confirmInput.addEventListener("change", () => {
    if (confirmInput.checked) {
      const check = validateSet(set, entry.metric);
      if (!check.valid) {
        confirmInput.checked = false;
        set.confirmed = false;
        countInput.setCustomValidity(Object.values(check.errors).join(". "));
        countInput.reportValidity();
        return;
      }
      countInput.setCustomValidity("");
      Object.assign(set, check.values, { confirmed: true, completedAt: new Date().toISOString() });
    } else {
      set.confirmed = false;
      set.completedAt = null;
    }
    scheduleSave(entry, true);
  });
  confirmLabel.append(confirmInput, element("span", { text: "✓" }));
  row.append(confirmLabel);
  if (entry.sets.length > 1) {
    const remove = element("button", { className: "action-btn action-danger compact-btn", text: "−", type: "button" });
    remove.setAttribute("aria-label", `Видалити підхід ${set.order}`);
    remove.addEventListener("click", () => {
      entry.sets = entry.sets.filter((item) => item.id !== set.id).map((item, index) => ({ ...item, order: index + 1 }));
      scheduleSave(entry, true);
      renderJournal();
    });
    row.append(remove);
  }
  return row;
}

function renderMovement(entry, movement) {
  const block = element("section", { className: "exercise-log" });
  block.dataset.slotId = movement.slotId;
  if (getCard(movement.parentCardId)?.movements.length > 1) block.append(element("h3", { text: movement.name }));
  const choice = getChoice(movement.slotId, entry.choiceId ?? entry.variantId) ?? movement.choices[0];
  const previous = previousFor(entry);
  const stableLoad = stableLoadFor(entry);
  if (fillEmptyLoads(entry, stableLoad)) scheduleSave(entry);
  block.append(element("p", {
    className: "last-result",
    text: previous ? `Минулого разу ${formatWorkoutDate(previous.session.workoutDate)}: ${formatEntryResult(previous.entry)}` : "Ще немає записів для цього варіанта.",
  }));
  if (stableLoad) {
    block.append(element("p", {
      className: "stable-result",
      text: `Закріплений робочий орієнтир: ${stableLoad.loadKg} кг · ${formatWorkoutDate(stableLoad.session.workoutDate)}`,
    }));
  }
  const controls = element("div", { className: "workout-actions" });
  const choiceSelect = element("select");
  choiceSelect.setAttribute("aria-label", `Варіант вправи ${movement.name}`);
  for (const item of movement.choices) {
    const option = element("option", { text: item.name });
    option.value = item.id;
    option.selected = item.id === choice.id;
    choiceSelect.append(option);
  }
  choiceSelect.addEventListener("change", () => {
    const replacement = changeEntryChoice(entry, choiceSelect.value);
    replaceActiveEntry(replacement);
    scheduleSave(replacement, true);
    renderJournal();
  });
  controls.append(fieldLabel("Варіант", choiceSelect));
  const equipment = element("input");
  equipment.type = "text";
  equipment.value = entry.equipmentKey === "default" ? "" : entry.equipmentKey;
  equipment.placeholder = "default";
  equipment.autocomplete = "off";
  equipment.addEventListener("change", () => {
    entry.equipmentKey = equipment.value.trim() || "default";
    scheduleSave(entry, true);
  });
  controls.append(fieldLabel("Тренажер / шкала", equipment));
  block.append(controls);
  const rows = element("div", { className: "set-list" });
  entry.sets.forEach((set) => rows.append(renderSetRow(entry, set, choice)));
  block.append(rows);
  const actions = element("div", { className: "workout-actions" });
  const add = element("button", { className: "action-btn action-secondary", text: "+ Підхід", type: "button" });
  add.addEventListener("click", () => {
    entry.sets.push(makeDraftSet(entry.sets.length + 1, entry.metric));
    scheduleSave(entry, true);
    renderJournal();
  });
  const copy = element("button", {
    className: "action-btn action-secondary",
    text: stableLoad ? `Повторити з орієнтиром ${stableLoad.loadKg} кг` : "Повторити попередні",
    type: "button",
  });
  copy.disabled = !previous;
  copy.addEventListener("click", () => {
    entry.sets = validWorkingSets(previous.entry).map((set, index) => makeDraftSet(index + 1, entry.metric, {
      loadKg: stableLoad?.loadKg ?? set.loadKg,
      reps: set.reps,
      durationSeconds: set.durationSeconds,
      side: set.side,
      confirmed: false,
    }));
    scheduleSave(entry, true);
    renderJournal();
  });
  const history = element("button", { className: "action-btn action-secondary", text: "Прогрес", type: "button" });
  history.addEventListener("click", () => {
    showMainTab("history");
    renderExerciseHistory(byId("history-detail"), entry, state.sessions, state.entries);
    byId("history-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  actions.append(add, copy, history);
  block.append(actions);
  return block;
}

function renderTechnique(card, body) {
  const content = card.content ?? {};
  if (content.technique?.length) {
    const details = element("details", { className: "sub-detail" });
    const summary = element("summary", { className: "sub-header tech-color", text: "Техніка виконання" });
    const inner = element("div", { className: "sub-body" });
    const grid = element("div", { className: "tech-grid" });
    for (const item of content.technique) {
      const section = element("article", { className: "tech-item" });
      section.append(element("strong", { text: item.heading }), element("p", { text: item.text }));
      grid.append(section);
    }
    inner.append(grid);
    details.append(summary, inner);
    body.append(details);
  }
  if (content.alternatives?.length) {
    const details = element("details", { className: "sub-detail" });
    const summary = element("summary", { className: "sub-header alt-color", text: "Альтернативи" });
    const inner = element("div", { className: "sub-body" });
    content.alternatives.forEach((text) => inner.append(element("p", { className: "alt-item", text })));
    details.append(summary, inner);
    body.append(details);
  }
  if (content.cue) body.append(element("div", { className: "cue-box", text: content.cue }));
}

function renderExerciseCard(card, index) {
  const details = element("details", { className: "exercise-item" });
  details.dataset.cardId = card.id;
  details.open = index === 0;
  const summary = element("summary", { className: "exercise-header" });
  const title = element("div", { className: "exercise-title-group" });
  title.append(element("span", { className: "exercise-number", text: card.label }), element("span", { className: "exercise-name", text: card.name }));
  if (card.shortAlternative) title.append(element("span", { className: "exercise-sub-alt", text: card.shortAlternative }));
  const params = element("div", { className: "exercise-params" });
  card.params.forEach((text, paramIndex) => params.append(element("span", { className: `param-badge ${paramIndex === 0 ? "sets" : ""}`.trim(), text })));
  title.append(params);
  summary.append(title, element("span", { className: "chevron", text: "⌄" }));
  const body = element("div", { className: "exercise-body" });
  const host = element("div", { className: "workout-form-host" });
  if (state.active?.session.programId === state.selectedProgramId && state.active.session.dayId === state.selectedDayId) {
    for (const movement of card.movements) {
      const entry = entryForSlot(movement.slotId);
      if (entry) host.append(renderMovement(entry, movement));
    }
  } else {
    host.append(element("p", { className: "inactive-log-hint", text: "Почни тренування, щоб записувати підходи." }));
  }
  body.append(host);
  renderTechnique(card, body);
  details.append(summary, body);
  return details;
}

function renderProgramPickers() {
  const program = currentProgram();
  const categorySelect = byId("category-picker");
  const programSelect = byId("program-picker");
  categorySelect.replaceChildren();
  for (const item of CATEGORIES) {
    const option = element("option", { text: item.name });
    option.value = item.id;
    option.selected = item.id === program.categoryId;
    categorySelect.append(option);
  }
  programSelect.replaceChildren();
  for (const item of PROGRAM_LIST.filter((candidate) => candidate.categoryId === program.categoryId)) {
    const option = element("option", { text: item.name });
    option.value = item.id;
    option.selected = item.id === program.id;
    programSelect.append(option);
  }
  categorySelect.disabled = Boolean(state.active);
  programSelect.disabled = Boolean(state.active);
  const summary = byId("program-summary");
  summary.replaceChildren(
    element("strong", { text: program.name }),
    element("p", { text: program.description }),
    element("p", { text: `Для кого: ${program.audience}` }),
    element("span", { className: "program-meta", text: `${program.frequency.sessionsPerWeek}× на тиждень · близько ${program.frequency.durationMinutes} хв` }),
  );
}

function renderDayTabs() {
  const container = byId("day-tabs");
  container.replaceChildren();
  const program = currentProgram();
  for (const day of program.days) {
    const button = element("button", { className: "day-tab", text: day.shortName || day.name, type: "button" });
    const selected = day.id === state.selectedDayId;
    button.dataset.dayId = day.id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(selected));
    button.setAttribute("aria-controls", "exercise-list");
    button.tabIndex = selected ? 0 : -1;
    button.disabled = Boolean(state.active) && !selected;
    button.title = day.name;
    button.addEventListener("click", () => {
      if (state.active) return;
      state.selectedDayId = day.id;
      renderJournal();
    });
    button.addEventListener("keydown", (event) => {
      if (state.active || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const index = program.days.findIndex((item) => item.id === day.id);
      const next = program.days[(index + direction + program.days.length) % program.days.length];
      state.selectedDayId = next.id;
      renderJournal();
      [...container.querySelectorAll("button[data-day-id]")].find((item) => item.dataset.dayId === next.id)?.focus();
    });
    container.append(button);
  }
}

function updateSessionHeader() {
  const summary = byId("active-session-summary");
  const start = byId("start-workout");
  const finish = byId("finish-workout");
  const date = byId("workout-date");
  if (state.active) {
    summary.textContent = `${state.active.session.programNameSnapshot} · ${state.active.session.dayNameSnapshot} · ${formatWorkoutDate(state.active.session.workoutDate)}`;
    start.textContent = "Тренування триває";
    start.disabled = true;
    finish.disabled = false;
    date.value = state.active.session.workoutDate;
    date.disabled = true;
  } else {
    summary.textContent = `${currentProgram().name} · ${currentDay().name}`;
    start.textContent = "Почати тренування";
    start.disabled = false;
    finish.disabled = true;
    date.disabled = false;
  }
}

function renderJournal() {
  renderProgramPickers();
  renderDayTabs();
  const day = currentDay();
  byId("day-focus").textContent = day.focus;
  byId("exercises-title").textContent = `${day.name}: вправи`;
  byId("exercise-list").replaceChildren(...day.cards.map(renderExerciseCard));
  updateSessionHeader();
}

async function beginWorkout({ past = false } = {}) {
  if (state.active) {
    setStatus("Спочатку заверши поточне тренування", true);
    return;
  }
  const date = byId("workout-date").value;
  try {
    state.active = await startSession(state.selectedProgramId, state.selectedDayId, { workoutDate: date, performedAt: performedAtForDate(date) });
    await refreshData();
    renderJournal();
    renderHistory();
    setStatus(past ? "Минуле тренування створено" : "Тренування розпочато");
    navigator.storage?.persist?.().catch(() => {});
  } catch (error) {
    reportError(error);
  }
}

async function completeWorkout() {
  if (!state.active) return;
  try {
    await flushSaves();
    setStatus("Завершення…");
    await finishSession(state.active.session, state.active.entries);
    state.active = null;
    await refreshData();
    renderJournal();
    renderHistory();
    setStatus("Тренування збережено в історії");
  } catch (error) {
    reportError(error);
  }
}

function renderHistory() {
  renderHistoryFilters(byId("history-filters"), state.historyFilters, PROGRAM_LIST, (filters) => {
    state.historyFilters = filters;
    renderHistory();
  });
  renderSessionList(byId("history-list"), state.sessions, state.entries, {
    onOpen: (session) => renderSessionDetail(byId("history-detail"), session, state.entries, historyHandlers),
    onDelete: (session) => historyHandlers.onDelete(session),
  }, state.historyFilters);
}

const historyHandlers = {
  onEdit: async (session) => {
    if (state.active) return alert("Спочатку заверши поточне тренування.");
    try {
      const updated = await putSession({ ...session, status: "draft", completedAt: null }, session.revision);
      await putSetting("activeSessionId", updated.id);
      await putSetting("currentProgramId", updated.programId);
      state.active = { session: updated, entries: await listEntriesForSession(updated.id) };
      selectProgram(updated.programId, updated.dayId);
      showMainTab("journal");
      byId("history-detail").hidden = true;
      await refreshData();
      renderJournal();
      renderHistory();
      setStatus("Історичне тренування відкрито для редагування");
    } catch (error) { reportError(error); }
  },
  onDelete: async (session) => {
    if (state.active?.session.id === session.id || session.status !== "completed") {
      alert("Активне тренування не можна видалити зі списку історії.");
      return;
    }
    if (!confirm(`Видалити тренування ${formatWorkoutDate(session.workoutDate)}? Цю дію не можна скасувати.`)) return;
    try {
      await deleteSession(session.id);
      byId("history-detail").hidden = true;
      await refreshData();
      renderJournal();
      renderHistory();
      setStatus("Тренування видалено");
    } catch (error) { reportError(error); }
  },
};

async function exportBackup() {
  try {
    if (state.active) await flushSaves();
    const payload = await createBackup();
    downloadBackup(payload);
    setBackupStatus(`Експортовано ${payload.sessions.length} тренувань`);
  } catch (error) { reportError(error, "backup"); }
}

async function importBackup(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const validation = validateBackup(payload);
    if (!validation.valid) throw new Error(validation.errors.join(". "));
    if (state.active) await flushSaves();
    const current = await exportAllData();
    const merge = planMerge(current, validation.normalized);
    let conflictMode = true;
    if (merge.conflicts.length) {
      downloadBackup(await createBackup(), `workout-program-before-import-${localDateString()}.json`);
      conflictMode = confirm(`Знайдено ${merge.conflicts.length} конфліктів. Поточну копію завантажено. Використати версії з файлу?`) ? "incoming" : true;
    }
    await restoreBackup(validation.normalized, { allowConflicts: conflictMode });
    state.active = await getActiveSession();
    await refreshData();
    const programId = state.active?.session.programId ?? await getSetting("currentProgramId");
    selectProgram(programId, state.active?.session.dayId);
    renderJournal();
    renderHistory();
    setBackupStatus(`Імпортовано нових записів: ${merge.additions}; дублів: ${merge.duplicates.length}`);
  } catch (error) { reportError(error, "backup"); }
  finally { byId("import-backup").value = ""; }
}

function renderProgramGuide() {
  const host = byId("program-guide-list");
  if (!host) return;
  host.replaceChildren(...PROGRAM_LIST.map((program) => {
    const item = element("article", { className: "program-guide-item" });
    item.append(
      element("h3", { text: program.name }),
      element("p", { text: program.audience }),
      element("span", { className: "program-meta", text: `${program.frequency.sessionsPerWeek}×/тиждень · ${program.frequency.durationMinutes} хв · ${program.days.length} типи тренувань` }),
    );
    return item;
  }));
}

function wireControls() {
  byId("category-picker").addEventListener("change", async (event) => {
    if (state.active) return;
    const next = PROGRAM_LIST.find((program) => program.categoryId === event.target.value);
    if (!next) return;
    selectProgram(next.id);
    await putSetting("currentProgramId", next.id);
    renderJournal();
  });
  byId("program-picker").addEventListener("change", async (event) => {
    if (state.active) return;
    selectProgram(event.target.value);
    await putSetting("currentProgramId", state.selectedProgramId);
    renderJournal();
  });
  byId("start-workout").addEventListener("click", () => beginWorkout());
  byId("finish-workout").addEventListener("click", completeWorkout);
  byId("add-past-workout").addEventListener("click", () => {
    showMainTab("journal");
    setStatus("Обери програму, день і дату, потім почни тренування");
    byId("workout-date").focus();
  });
  byId("export-backup").addEventListener("click", exportBackup);
  byId("import-backup").addEventListener("change", (event) => importBackup(event.target.files?.[0]));
  document.querySelectorAll('input[name="main-nav"]').forEach((radio) => radio.addEventListener("change", updateTabAria));
  document.querySelectorAll('.bottom-nav label[role="tab"]').forEach((label) => {
    label.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        label.click();
        return;
      }
      if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        const tabs = [...document.querySelectorAll('.bottom-nav label[role="tab"]')];
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const next = tabs[(tabs.indexOf(label) + direction + tabs.length) % tabs.length];
        next.click();
        next.focus();
      }
    });
  });
}

function updateConnectionStatus() {
  byId("app-connection-status").textContent = navigator.onLine ? "Локальний журнал" : "Офлайн";
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  try {
    const hadController = Boolean(navigator.serviceWorker.controller);
    const registration = await navigator.serviceWorker.register("./sw.js", { scope: "./" });
    const updateButton = byId("apply-update");
    const showUpdate = (worker) => {
      if (!worker || !navigator.serviceWorker.controller) return;
      updateButton.hidden = false;
      updateButton.onclick = async () => {
        try {
          if (state.active) await flushSaves();
          worker.postMessage({ type: "APPLY_UPDATE" });
        } catch (error) { reportError(error); }
      };
    };
    showUpdate(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => worker.state === "installed" && showUpdate(worker));
    });
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) updateButton.hidden = true;
      else if (!refreshing) { refreshing = true; location.reload(); }
    });
  } catch (error) { console.warn("Service worker не зареєстровано", error); }
}

async function boot() {
  byId("workout-date").value = localDateString();
  wireControls();
  renderProgramGuide();
  updateTabAria();
  updateConnectionStatus();
  addEventListener("online", updateConnectionStatus);
  addEventListener("offline", updateConnectionStatus);
  try {
    state.active = await getActiveSession();
    await refreshData();
    const programId = state.active?.session.programId ?? await getSetting("currentProgramId");
    selectProgram(programId, state.active?.session.dayId);
    if (state.active) setStatus("Незавершене тренування відновлено");
    renderJournal();
    renderHistory();
  } catch (error) {
    reportError(error);
    byId("start-workout").disabled = true;
    byId("active-session-summary").textContent = "Локальне сховище недоступне. Перевір режим браузера та дозволи сайту.";
  }
  void registerServiceWorker();
}

void boot();
