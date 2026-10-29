import { getSlot, getSlotsForDomSlot, getVariant } from "./program.js";
import {
  createEntryDraft,
  findPreviousResult,
  finishSession,
  getActiveSession,
  localDateString,
  makeDraftSet,
  parseLocalizedNumber,
  startSession,
  validWorkingSets,
  validateSet,
} from "./workouts.js";
import {
  RevisionConflictError,
  deleteSession,
  exportAllData,
  listEntries,
  listEntriesForSession,
  listSessions,
  putEntry,
  putSession,
  putSetting,
} from "./storage.js";
import {
  createBackup,
  downloadBackup,
  planMerge,
  restoreBackup,
  validateBackup,
} from "./backup.js";
import {
  formatEntryResult,
  formatWorkoutDate,
  renderExerciseHistory,
  renderHistoryFilters,
  renderSessionDetail,
  renderSessionList,
} from "./history.js";

const state = {
  active: null,
  sessions: [],
  entries: [],
  historyDay: "all",
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
  output.style.color = isError ? "#fca5a5" : "#86efac";
}

function setBackupStatus(message, isError = false) {
  const output = byId("backup-status");
  if (!output) return;
  output.textContent = message;
  output.style.color = isError ? "#fca5a5" : "#86efac";
}

function reportError(error, target = "save") {
  const message = error instanceof RevisionConflictError
    ? "Запис змінено в іншій вкладці. Перезавантаж сторінку, щоб не затерти нові дані."
    : (error?.message || "Невідома помилка");
  if (target === "backup") setBackupStatus(message, true);
  else setStatus(message, true);
  console.error(error);
}

function selectedDayId() {
  return document.querySelector('input[name="day-nav"]:checked')?.id.match(/day-([abc])-radio/)?.[1] ?? "a";
}

function selectDay(dayId) {
  const radio = byId(`day-${dayId}-radio`);
  if (radio) radio.checked = true;
  updateTabAria();
}

function updateTabAria() {
  document.querySelectorAll('label[role="tab"][for]').forEach((label) => {
    const control = byId(label.htmlFor);
    label.setAttribute("aria-selected", String(Boolean(control?.checked)));
  });
}

function performedAtForDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Обери коректну дату тренування");
  const [year, month, day] = date.split("-").map(Number);
  const now = new Date();
  const candidate = new Date(year, month - 1, day, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  if (Number.isNaN(candidate.getTime())
    || candidate.getFullYear() !== year
    || candidate.getMonth() !== month - 1
    || candidate.getDate() !== day) {
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
  const currentTimer = state.saveTimers.get(entry.id);
  if (currentTimer) clearTimeout(currentTimer);
  if (immediate) {
    state.saveTimers.delete(entry.id);
    void persistEntry(entry);
    return;
  }
  state.saveTimers.set(entry.id, setTimeout(() => {
    state.saveTimers.delete(entry.id);
    void persistEntry(entry);
  }, 400));
}

function clone(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function persistEntry(entry) {
  const previous = state.saveQueues.get(entry.id) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(async () => {
    const activeEntry = entryForSlot(entry.slotId);
    if (!activeEntry || activeEntry.id !== entry.id || !state.dirtyEntries.has(entry.id)) return activeEntry;
    state.dirtyEntries.delete(entry.id);
    const snapshot = clone(activeEntry);
    const expectedRevision = activeEntry.revision;
    const saved = await putEntry(snapshot, expectedRevision);
    activeEntry.revision = saved.revision;
    activeEntry.updatedAt = saved.updatedAt;
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
    if (entry) persistEntry(entry);
  }
  await Promise.all([...state.saveQueues.values()]);
  if (state.saveBlocked || state.dirtyEntries.size) throw new Error("Не всі зміни збережено. Усунь конфлікт перед завершенням.");
}

function fieldLabel(text, control) {
  const label = element("label", { className: "field-label", text });
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

function renderSetRow(entry, set, variant) {
  const row = element("div", { className: "set-row" });
  row.dataset.setId = set.id;
  row.append(element("span", { className: "set-number", text: String(set.order) }));

  let loadInput = null;
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

  const countInput = numberInput(
    entry.metric === "duration" ? set.durationSeconds : set.reps,
    entry.metric === "duration" ? "Секунди" : "Повтори",
  );
  countInput.addEventListener("input", () => {
    if (entry.metric === "duration") set.durationSeconds = parseLocalizedNumber(countInput.value);
    else set.reps = parseLocalizedNumber(countInput.value);
    set.confirmed = false;
    confirmInput.checked = false;
    scheduleSave(entry);
  });
  row.append(fieldLabel(entry.metric === "duration" ? "Секунди" : "Повтори", countInput));

  if (variant.unilateral) {
    const side = element("select");
    side.setAttribute("aria-label", "Сторона");
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
    row.append(fieldLabel("Сторона", side));
  }

  const confirmLabel = element("label", { className: "confirm-set" });
  confirmLabel.title = "Підтвердити виконаний підхід";
  const confirmInput = element("input");
  confirmInput.type = "checkbox";
  confirmInput.checked = Boolean(set.confirmed);
  confirmInput.setAttribute("aria-label", `Підхід ${set.order} виконано`);
  confirmInput.addEventListener("change", () => {
    if (confirmInput.checked) {
      const check = validateSet(set, entry.metric);
      if (!check.valid) {
        confirmInput.checked = false;
        set.confirmed = false;
        const message = Object.values(check.errors).join(". ");
        countInput.setCustomValidity(message);
        countInput.reportValidity();
        return;
      }
      countInput.setCustomValidity("");
      if (loadInput) loadInput.setCustomValidity("");
      Object.assign(set, check.values, { confirmed: true, completedAt: new Date().toISOString() });
    } else {
      set.confirmed = false;
      set.completedAt = null;
    }
    scheduleSave(entry, true);
  });
  confirmLabel.append(confirmInput);
  row.append(confirmLabel);

  if (entry.sets.length > 1) {
    const remove = element("button", { className: "action-btn action-danger", text: "−", type: "button" });
    remove.setAttribute("aria-label", `Видалити підхід ${set.order}`);
    remove.addEventListener("click", () => {
      entry.sets = entry.sets.filter((item) => item.id !== set.id).map((item, index) => ({ ...item, order: index + 1 }));
      scheduleSave(entry, true);
      renderActiveWorkout();
    });
    row.append(remove);
  }
  return row;
}

function renderMovement(entry, slot) {
  const block = element("section", { className: "exercise-log" });
  if (slot.parentSlotId) block.append(element("h3", { text: slot.name }));
  const variant = getVariant(slot.slotId, entry.variantId) ?? slot.variants[0];

  const previous = previousFor(entry);
  const previousText = previous
    ? `Минулого разу ${formatWorkoutDate(previous.session.workoutDate)}: ${formatEntryResult(previous.entry)}`
    : "Ще немає записів для цього варіанта.";
  block.append(element("p", { className: "last-result", text: previousText }));

  const controls = element("div", { className: "workout-actions" });
  const variantSelect = element("select");
  variantSelect.setAttribute("aria-label", `Варіант вправи ${slot.name}`);
  for (const item of slot.variants) {
    const option = element("option", { text: item.name });
    option.value = item.id;
    option.selected = item.id === entry.variantId;
    variantSelect.append(option);
  }
  variantSelect.addEventListener("change", () => {
    const replacement = createEntryDraft(entry.sessionId, slot.slotId, variantSelect.value);
    replacement.revision = entry.revision;
    replacement.notes = entry.notes;
    replaceActiveEntry(replacement);
    scheduleSave(replacement, true);
    renderActiveWorkout();
  });
  controls.append(fieldLabel("Варіант", variantSelect));

  const equipment = element("input");
  equipment.type = "text";
  equipment.value = entry.equipmentKey === "default" ? "" : entry.equipmentKey;
  equipment.placeholder = "default";
  equipment.autocomplete = "off";
  equipment.addEventListener("change", () => {
    entry.equipmentKey = equipment.value.trim() || "default";
    scheduleSave(entry, true);
    renderActiveWorkout();
  });
  controls.append(fieldLabel("Тренажер / шкала", equipment));
  block.append(controls);

  const rows = element("div");
  entry.sets.forEach((set) => rows.append(renderSetRow(entry, set, variant)));
  block.append(rows);

  const actions = element("div", { className: "workout-actions" });
  const add = element("button", { className: "action-btn action-secondary", text: "+ Підхід", type: "button" });
  add.addEventListener("click", () => {
    entry.sets.push(makeDraftSet(entry.sets.length + 1, entry.metric));
    scheduleSave(entry, true);
    renderActiveWorkout();
  });
  actions.append(add);
  const copy = element("button", { className: "action-btn action-secondary", text: "Повторити попередні", type: "button" });
  copy.disabled = !previous;
  copy.addEventListener("click", () => {
    entry.sets = validWorkingSets(previous.entry).map((set, index) => makeDraftSet(index + 1, entry.metric, {
      loadKg: set.loadKg,
      reps: set.reps,
      durationSeconds: set.durationSeconds,
      side: set.side,
      confirmed: false,
    }));
    scheduleSave(entry, true);
    renderActiveWorkout();
  });
  actions.append(copy);
  const history = element("button", { className: "action-btn action-secondary", text: "Історія вправи", type: "button" });
  history.addEventListener("click", () => {
    byId("nav-history").checked = true;
    updateTabAria();
    renderExerciseHistory(byId("history-detail"), entry, state.sessions, state.entries);
    byId("history-detail").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  actions.append(history);
  block.append(actions);
  return { block, previousText };
}

function ensureHost(card) {
  let host = card.querySelector(":scope > .exercise-body > .workout-form-host");
  if (!host) {
    host = element("div", { className: "workout-form-host" });
    card.querySelector(":scope > .exercise-body")?.prepend(host);
  }
  return host;
}

function renderActiveWorkout() {
  document.querySelectorAll(".exercise-item").forEach((card) => {
    ensureHost(card).replaceChildren();
    card.querySelector(".exercise-last-summary")?.remove();
  });
  if (!state.active) return;

  for (const card of document.querySelectorAll(".exercise-item[data-slot-id]")) {
    const domSlot = card.dataset.slotId;
    const slots = getSlotsForDomSlot(domSlot);
    if (!slots.some((slot) => slot.dayId === state.active.session.dayId)) continue;
    const host = ensureHost(card);
    let firstSummary = null;
    for (const slot of slots) {
      const entry = entryForSlot(slot.slotId);
      if (!entry) continue;
      const rendered = renderMovement(entry, slot);
      host.append(rendered.block);
      firstSummary ??= rendered.previousText;
    }
    if (firstSummary) {
      const badge = element("span", { className: "exercise-last-summary", text: firstSummary });
      card.querySelector(".exercise-title-group")?.append(badge);
    }
  }
}

function updateSessionHeader() {
  const summary = byId("active-session-summary");
  const start = byId("start-workout");
  const finish = byId("finish-workout");
  const date = byId("workout-date");
  if (state.active) {
    summary.textContent = `${formatWorkoutDate(state.active.session.workoutDate)} · День ${state.active.session.dayId.toUpperCase()}`;
    start.textContent = "Тренування триває";
    start.disabled = true;
    finish.disabled = false;
    date.value = state.active.session.workoutDate;
    date.disabled = true;
  } else {
    summary.textContent = "Вибери день і почни тренування.";
    start.textContent = "Почати тренування";
    start.disabled = false;
    finish.disabled = true;
    date.disabled = false;
  }
}

async function beginWorkout({ past = false } = {}) {
  if (state.active) {
    selectDay(state.active.session.dayId);
    setStatus("Спочатку заверши поточне тренування");
    return;
  }
  const date = byId("workout-date").value;
  try {
    state.active = await startSession(selectedDayId(), { workoutDate: date, performedAt: performedAtForDate(date) });
    selectDay(state.active.session.dayId);
    await refreshData();
    updateSessionHeader();
    renderActiveWorkout();
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
    updateSessionHeader();
    renderActiveWorkout();
    renderHistory();
    setStatus("Тренування збережено в історії");
  } catch (error) {
    reportError(error);
  }
}

function renderHistory() {
  renderHistoryFilters(byId("history-filters"), state.historyDay, (value) => {
    state.historyDay = value;
    renderHistory();
  });
  renderSessionList(byId("history-list"), state.sessions, state.entries, {
    onOpen: (session) => renderSessionDetail(byId("history-detail"), session, state.entries, historyHandlers),
  }, state.historyDay);
}

const historyHandlers = {
  onEdit: async (session) => {
    if (state.active) {
      alert("Спочатку заверши поточне тренування.");
      return;
    }
    try {
      const updated = await putSession({ ...session, status: "draft", completedAt: null }, session.revision);
      await putSetting("activeSessionId", updated.id);
      state.active = { session: updated, entries: await listEntriesForSession(updated.id) };
      selectDay(updated.dayId);
      byId("nav-workout").checked = true;
      byId("history-detail").hidden = true;
      await refreshData();
      updateSessionHeader();
      renderActiveWorkout();
      renderHistory();
      setStatus("Історичне тренування відкрито для редагування");
    } catch (error) {
      reportError(error);
    }
  },
  onDelete: async (session) => {
    if (!confirm(`Видалити тренування ${formatWorkoutDate(session.workoutDate)}? Цю дію не можна скасувати.`)) return;
    try {
      await deleteSession(session.id);
      byId("history-detail").hidden = true;
      await refreshData();
      renderHistory();
      renderActiveWorkout();
      setStatus("Тренування видалено");
    } catch (error) {
      reportError(error);
    }
  },
};

async function exportBackup() {
  try {
    if (state.active) await flushSaves();
    const payload = await createBackup();
    downloadBackup(payload);
    setBackupStatus(`Експортовано ${payload.sessions.length} тренувань`);
  } catch (error) {
    reportError(error, "backup");
  }
}

async function importBackup(file) {
  if (!file) return;
  try {
    const payload = JSON.parse(await file.text());
    const validation = validateBackup(payload);
    if (!validation.valid) throw new Error(validation.errors.join(". "));
    if (state.active) await flushSaves();
    const current = await exportAllData();
    const merge = planMerge(current, payload);
    let conflictMode = true;
    if (merge.conflicts.length) {
      downloadBackup(await createBackup(), `workout-program-before-import-${localDateString()}.json`);
      const useIncoming = confirm(
        `Знайдено ${merge.conflicts.length} конфліктів. Поточну копію вже завантажено. Натисни OK, щоб використати дані з файлу; Cancel — щоб зберегти поточні версії та додати лише нові записи.`,
      );
      conflictMode = useIncoming ? "incoming" : true;
    }
    await restoreBackup(payload, { allowConflicts: conflictMode });
    state.active = await getActiveSession();
    await refreshData();
    if (state.active) selectDay(state.active.session.dayId);
    updateSessionHeader();
    renderActiveWorkout();
    renderHistory();
    setBackupStatus(`Імпортовано нових записів: ${merge.additions}; дублів: ${merge.duplicates.length}`);
  } catch (error) {
    reportError(error, "backup");
  } finally {
    byId("import-backup").value = "";
  }
}

function wireControls() {
  byId("start-workout")?.addEventListener("click", () => beginWorkout());
  byId("finish-workout")?.addEventListener("click", completeWorkout);
  byId("add-past-workout")?.addEventListener("click", () => {
    byId("nav-workout").checked = true;
    updateTabAria();
    setStatus("Обери день і дату, потім натисни «Почати тренування»");
    byId("workout-date").focus();
  });
  byId("export-backup")?.addEventListener("click", exportBackup);
  byId("import-backup")?.addEventListener("change", (event) => importBackup(event.target.files?.[0]));

  document.querySelectorAll('input[name="day-nav"], input[name="main-nav"]').forEach((radio) => {
    radio.addEventListener("change", updateTabAria);
  });
  document.querySelectorAll('label[role="tab"]').forEach((label) => {
    label.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        label.click();
      }
    });
  });
}

function updateConnectionStatus() {
  const status = byId("app-connection-status");
  if (!status) return;
  status.textContent = navigator.onLine ? "Локальний журнал" : "Офлайн";
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
        } catch (error) {
          reportError(error);
        }
      };
    };
    showUpdate(registration.waiting);
    registration.addEventListener("updatefound", () => {
      const worker = registration.installing;
      worker?.addEventListener("statechange", () => {
        if (worker.state === "installed") showUpdate(worker);
      });
    });
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) {
        updateButton.hidden = true;
        updateConnectionStatus();
      } else if (!refreshing) {
        refreshing = true;
        location.reload();
      }
    });
  } catch (error) {
    console.warn("Service worker не зареєстровано", error);
  }
}

async function boot() {
  byId("workout-date").value = localDateString();
  wireControls();
  updateTabAria();
  updateConnectionStatus();
  addEventListener("online", updateConnectionStatus);
  addEventListener("offline", updateConnectionStatus);
  try {
    state.active = await getActiveSession();
    await refreshData();
    if (state.active) {
      selectDay(state.active.session.dayId);
      setStatus("Незавершене тренування відновлено");
    }
    updateSessionHeader();
    renderActiveWorkout();
    renderHistory();
  } catch (error) {
    reportError(error);
    byId("start-workout").disabled = true;
    byId("active-session-summary").textContent = "Локальне сховище недоступне. Перевір режим браузера та дозволи сайту.";
  }
  void registerServiceWorker();
}

boot();
