import { CATEGORIES, DEFAULT_PROGRAM_ID, PROGRAM_LIST, getCard, getChoice, getDay, getProgram } from "./program.js";
import {
  changeEntryChoice, findPreviousResult, findStableWorkingLoad, finishSession, getActiveSession, localDateString,
  makeDraftSet, parseLocalizedNumber, startSession, validWorkingSets, validateSet,
} from "./workouts.js";
import {
  RevisionConflictError, deleteSession, exportAllData, getSetting, listEntries,
  listEntriesForSession, listSessions, putEntry, putSession, putSetting,
  exportLegacyAnonymousData, hasLegacyAnonymousData, setStorageScope,
} from "./storage.js";
import { createBackup, downloadBackup, planMerge, restoreBackup, validateBackup } from "./backup.js";
import {
  formatEntryResult, formatWorkoutDate, renderExerciseHistory, renderHistoryFilters,
  renderSessionDetail, renderSessionList,
} from "./history.js";
import cloudConfig from "./cloud-config.js";
import { createSupabaseAuth, isCloudConfigured } from "./auth.js";
import {
  LEGACY_IMPORT_MARKER_KEY, createCloudSync,
  createScopedRecordStore, createSupabaseRecordStore,
} from "./cloud-sync.js";

const CLOUD_SCOPE_HINT_KEY = "workout-program:account-scope";
const LOCAL_CONSENT_KEY = "workout-program:local-consent-v1";
const SECTION_IDS = ["journal", "history", "guide", "account"];
let activeSectionId = "journal";
let activeNavigationId = "journal";
let drawerReturnFocus = null;

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
  localMode: false,
  cloud: {
    auth: null,
    session: null,
    user: null,
    sync: null,
    syncPromise: Promise.resolve(),
    conflict: null,
    configured: false,
    config: cloudConfig,
    sdkError: null,
    switching: false,
    offlineIdentity: false,
    accessReady: false,
    retryDelay: 2000,
  },
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

function setCloudStatus(message, isError = false) {
  const output = byId("cloud-status");
  if (!output) return;
  output.textContent = message;
  output.classList.toggle("status-error", isError);
}

function accountHint() {
  try { return JSON.parse(localStorage.getItem(CLOUD_SCOPE_HINT_KEY) ?? "null"); } catch { return null; }
}

function saveAccountHint(user) {
  if (!user?.id) return;
  localStorage.setItem(CLOUD_SCOPE_HINT_KEY, JSON.stringify({ id: user.id, email: user.email ?? "" }));
}

function clearAccountHint() {
  localStorage.removeItem(CLOUD_SCOPE_HINT_KEY);
}

function resetInMemoryWorkoutState() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = null;
  for (const timer of state.saveTimers.values()) clearTimeout(timer);
  state.saveTimers.clear();
  state.saveQueues.clear();
  state.dirtyEntries.clear();
  state.saveBlocked = false;
  state.active = null;
  state.sessions = [];
  state.entries = [];
  byId("history-list")?.replaceChildren();
  byId("exercise-list")?.replaceChildren();
  if (byId("active-session-summary")) byId("active-session-summary").textContent = "Особисті дані приховано";
  const detail = byId("history-detail");
  if (detail) {
    detail.hidden = true;
    detail.replaceChildren();
  }
  setBackupStatus("");
}

function makeSyncFor(userId) {
  if (!state.cloud.auth?.client) return null;
  return createCloudSync({
    remote: createSupabaseRecordStore(state.cloud.auth.client, { userId }),
    local: createScopedRecordStore(userId),
    beforePull: async () => { if (state.cloud.user?.id === userId) await flushSaves(); },
  });
}

function makeOfflineSyncFor(userId) {
  const local = createScopedRecordStore(userId);
  return Object.freeze({
    async markPending() {
      return { status: "pending" };
    },
    async hasPending() { return (await local.state()).pending.length > 0; },
    async sync() { return { status: "offline" }; },
  });
}

const hasAccount = () => Boolean(state.cloud.user?.id && state.cloud.sync && state.cloud.accessReady);
const hasWorkoutAccess = () => hasAccount() || (state.localMode && state.cloud.accessReady);

function localConsentAccepted() {
  try { return localStorage.getItem(LOCAL_CONSENT_KEY) === "accepted"; } catch { return false; }
}

async function enableLocalMode() {
  if (state.cloud.user || state.cloud.switching) return;
  if (!confirm("Тренування без акаунта зберігаються лише в цьому браузері. Очищення даних браузера може видалити історію; на іншому пристрої чи в іншому акаунті вона не з’явиться автоматично. Регулярно експортуйте JSON. Приймаєте ці ризики?")) return;
  try {
    localStorage.setItem(LOCAL_CONSENT_KEY, "accepted");
    await enterAnonymousMode();
    updateConnectionStatus();
  } catch (error) { reportError(error); }
}

async function loadCurrentScope({ render = true } = {}) {
  state.active = await getActiveSession();
  await refreshData();
  const programId = state.active?.session.programId ?? await getSetting("currentProgramId");
  selectProgram(programId, state.active?.session.dayId);
  if (render) {
    renderJournal();
    renderHistory();
  }
}

async function refreshSyncedScope() {
  const panels = [byId("tab-journal"), byId("tab-history")];
  panels.forEach((panel) => { panel.inert = true; });
  try {
    await flushSaves();
    await loadCurrentScope();
  } finally { panels.forEach((panel) => { panel.inert = false; }); }
}

async function enterAnonymousMode({ message = "Увійдіть, щоб вести особистий журнал тренувань." } = {}) {
  resetInMemoryWorkoutState();
  state.cloud.user = null;
  state.cloud.session = null;
  state.cloud.sync = null;
  state.cloud.conflict = null;
  state.cloud.offlineIdentity = false;
  state.cloud.accessReady = false;
  state.localMode = localConsentAccepted();
  setStorageScope("guest");
  if (state.localMode) {
    await loadCurrentScope({ render: false });
    state.cloud.accessReady = true;
    message = "Локальний режим · історія зберігається лише в цьому браузері. Робіть резервні копії JSON.";
  }
  renderJournal();
  renderHistory();
  renderAccount();
  setCloudStatus(message);
}

async function switchStorageProfile(user, { initialize = true } = {}) {
  if (state.cloud.switching) return;
  state.cloud.switching = true;
  try {
    if (state.active || state.dirtyEntries.size) await flushSaves();
    resetInMemoryWorkoutState();
    if (!user?.id) {
      await enterAnonymousMode();
      return;
    }
    state.cloud.user = user;
    state.localMode = false;
    setStorageScope(user.id);
    state.cloud.sync = makeSyncFor(user.id);
    state.cloud.accessReady = false;
    state.cloud.conflict = null;
    if (initialize && navigator.onLine !== false) {
      const result = await state.cloud.sync.initializeFromCloud();
      if (result.status === "conflict") {
        state.cloud.conflict = result;
        setCloudStatus("Є конфлікт незбережених локальних змін і хмарної історії.", true);
      }
    }
    state.cloud.accessReady = true;
    await loadCurrentScope();
    renderAccount();
    await updateLegacyImportAvailability();
    const pending = await state.cloud.sync.hasPending();
    if (pending) setCloudStatus(navigator.onLine === false ? "Офлайн · очікує синхронізації" : "Локальні зміни очікують синхронізації.");
    else if (navigator.onLine === false) setCloudStatus("Офлайн · відкрито кеш цього акаунта.");
    else setCloudStatus("Збережено у хмарі.");
  } catch (error) {
    resetInMemoryWorkoutState();
    state.cloud.accessReady = false;
    renderJournal();
    renderHistory();
    renderAccount();
    setCloudStatus(`Не вдалося завантажити хмарну історію: ${error.message}`, true);
    throw error;
  } finally {
    state.cloud.switching = false;
  }
}

function renderAccount() {
  const configured = state.cloud.configured;
  const signedIn = Boolean(state.cloud.user?.id);
  const ready = hasAccount();
  const form = byId("account-form");
  const logout = byId("account-logout");
  const tools = byId("account-tools");
  const setup = byId("cloud-setup-message");
  const backup = byId("backup-tools");
  const conflict = byId("sync-conflict-actions");
  form.hidden = signedIn;
  [...form.elements].forEach((control) => { control.disabled = !configured; });
  logout.hidden = !signedIn;
  tools.hidden = !ready;
  backup.hidden = !hasWorkoutAccess();
  byId("local-mode-options").hidden = signedIn || state.localMode;
  setup.hidden = configured;
  conflict.hidden = !state.cloud.conflict;
  byId("sync-conflict-details").textContent = state.cloud.conflict?.reason === "legacy-import"
    ? "Імпорт містить записи з однаковими ID. Збережіть JSON-копії та усуньте дублікати."
    : (state.cloud.conflict?.conflicts ?? []).map((item) => item.kind === "session"
      ? `${item.local?.payload?.session?.workoutDate ?? item.remote?.payload?.session?.workoutDate ?? "Тренування"} · ${item.local?.payload?.session?.dayNameSnapshot ?? item.id}`
      : "Налаштування імпорту").join("; ");
  if (ready) {
    byId("account-summary").textContent = `${state.cloud.user.email || "Акаунт"} · особиста історія синхронізується з Supabase`;
  } else if (signedIn) {
    byId("account-summary").textContent = `${state.cloud.user.email || "Акаунт"} · хмарну історію поки не завантажено`;
  } else if (state.localMode) {
    byId("account-summary").textContent = "Локальний режим без акаунта · історія лише в цьому браузері.";
  } else if (!configured) {
    byId("account-summary").textContent = "Тренуйтеся без акаунта, прийнявши умови локального зберігання.";
  } else {
    byId("account-summary").textContent = "Увійдіть або зареєструйтеся, щоб зберігати власний прогрес у хмарі.";
  }
  renderAccessState();
  updateConnectionStatus();
}

function renderAccessState() {
  const signedIn = hasWorkoutAccess();
  const historyLocked = byId("history-locked");
  const historyContent = byId("personal-history-content");
  if (historyLocked) historyLocked.hidden = signedIn;
  if (historyContent) historyContent.hidden = !signedIn;
  if (byId("add-past-workout")) byId("add-past-workout").disabled = !signedIn;
  if (byId("export-backup")) byId("export-backup").disabled = !signedIn;
  if (byId("import-backup")) byId("import-backup").disabled = !signedIn;
  const hint = byId("session-access-hint");
  if (hint) {
    hint.textContent = state.localMode
      ? "Без акаунта: історія лише в цьому браузері. На іншому пристрої або в акаунті вона не з’явиться автоматично. Експортуйте JSON для резервної копії."
      : signedIn
      ? (navigator.onLine === false
        ? "Офлайн: чернетка збережеться в кеші цього акаунта й очікуватиме синхронізації."
        : "Зміни кешуються для цього акаунта та синхронізуються з Supabase.")
      : "Увійдіть або оберіть тренування без акаунта.";
  }
  updateSessionHeader();
}

async function updateLegacyImportAvailability() {
  const button = byId("import-legacy-data");
  if (!button) return;
  if (!hasAccount()) {
    button.hidden = true;
    return;
  }
  const [hasLegacy, marker] = await Promise.all([
    hasLegacyAnonymousData(),
    getSetting(LEGACY_IMPORT_MARKER_KEY),
  ]);
  button.hidden = !hasLegacy || Boolean(marker);
}

async function runCloudSync(reason = "зміни") {
  if (!state.cloud.sync || !state.cloud.user) return { status: "read-only" };
  const sync = state.cloud.sync;
  const userId = state.cloud.user.id;
  const task = state.cloud.syncPromise.catch(() => {}).then(async () => {
    if (state.cloud.sync !== sync || state.cloud.user?.id !== userId) return { status: "stale" };
    setCloudStatus(`Очікує синхронізації · ${reason}…`);
    try {
      if (state.dirtyEntries.size) await flushSaves();
      const result = await sync.sync();
      if (state.cloud.sync !== sync || state.cloud.user?.id !== userId) return { ...result, stale: true };
      state.cloud.retryDelay = 2000;
      if (result.changed) await refreshSyncedScope();
      if (result.status === "conflict") {
        state.cloud.conflict = result;
        renderAccount();
        setCloudStatus("Одне або кілька тренувань змінено на двох пристроях. Решта історії синхронізується незалежно.", true);
        setStatus("Конфлікт синхронізації", true);
      } else if (result.status === "offline") {
        setCloudStatus("Офлайн · очікує синхронізації.");
        setStatus("Збережено локально · очікує синхронізації");
      } else if (result.status === "pending") {
        setCloudStatus("Нові зміни збережено локально; очікують наступної синхронізації.");
        setStatus("Збережено локально · очікує синхронізації");
        scheduleCloudSync(reason);
      } else {
        state.cloud.conflict = null;
        setCloudStatus("Збережено у хмарі.");
        setStatus("Збережено у хмарі");
        renderAccount();
      }
      return result;
    } catch (error) {
      if (state.cloud.sync !== sync || state.cloud.user?.id !== userId) return { status: "stale" };
      setCloudStatus(`Помилка синхронізації: ${error.message}`, true);
      console.error(error);
      if (navigator.onLine !== false) {
        scheduleCloudSync("повтор після помилки", state.cloud.retryDelay);
        state.cloud.retryDelay = Math.min(state.cloud.retryDelay * 2, 60000);
      }
      return { status: "error", error };
    }
  });
  state.cloud.syncPromise = task;
  return task;
}

async function markPendingAndSync(reason, { awaitCloud = false } = {}) {
  if (state.localMode && hasWorkoutAccess()) {
    setStatus("Збережено локально в цьому браузері");
    return { status: "local" };
  }
  if (!hasAccount()) throw new Error("Увійдіть в акаунт, щоб зберігати тренування");
  await state.cloud.sync.markPending();
  setStatus(navigator.onLine === false ? "Збережено локально · очікує синхронізації" : "Збережено локально · очікує хмару");
  setCloudStatus(navigator.onLine === false ? "Офлайн · очікує синхронізації." : `Очікує синхронізації · ${reason}…`);
  if (navigator.onLine === false) return { status: "offline-pending" };
  if (!awaitCloud) {
    scheduleCloudSync(reason);
    return { status: "pending" };
  }
  const result = await runCloudSync(reason);
  if (result.status === "offline") {
    throw new Error("Хмарний сервіс недоступний. Зміни збережено в кеші акаунта й вони очікують синхронізації.");
  }
  if (["error", "conflict"].includes(result.status)) {
    throw result.error ?? new Error("Не вдалося зберегти зміни у хмарі. Локальна копія очікує синхронізації.");
  }
  if (result.status === "pending") throw new Error("Зміни збережено локально й очікують синхронізації.");
  return result;
}

let syncTimer = null;
function scheduleCloudSync(reason = "редагування", delay = 700) {
  if (!hasAccount()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => void runCloudSync(reason), delay);
}

async function resolveSyncConflict(strategy) {
  if (!state.cloud.sync || !state.cloud.conflict) return;
  const sync = state.cloud.sync;
  const userId = state.cloud.user?.id;
  const conflict = state.cloud.conflict;
  byId("tab-journal").inert = true;
  try {
    const result = await sync.resolveConflict(strategy, conflict);
    if (state.cloud.sync !== sync || state.cloud.user?.id !== userId) return;
    if (result.status === "offline") throw result.error;
    if (result.status === "conflict") {
      state.cloud.conflict = result;
      renderAccount();
      setCloudStatus("Хмара змінилася ще раз. Перевір конфлікт повторно.", true);
      return;
    }
    state.cloud.conflict = null;
    await loadCurrentScope();
    renderAccount();
    setCloudStatus(result.pending ? "Зміни збережено локально; очікують синхронізації." : "Конфліктні тренування синхронізовано.");
    if (result.pending) scheduleCloudSync("розв’язання конфлікту");
  } catch (error) {
    if (state.cloud.sync === sync && state.cloud.user?.id === userId) setCloudStatus(error.message, true);
  } finally { byId("tab-journal").inert = false; }
}

async function applyAuthSession(session, event = "SESSION") {
  const user = session?.user ?? null;
  state.cloud.session = session ?? null;
  if (user) {
    saveAccountHint(user);
    state.cloud.offlineIdentity = false;
    if (state.cloud.user?.id !== user.id || !state.cloud.accessReady) await switchStorageProfile(user, { initialize: true });
    else {
      state.cloud.user = user;
      renderAccount();
    }
    if (event === "PASSWORD_RECOVERY") byId("password-recovery-form").hidden = false;
  } else if (event === "SIGNED_OUT" || state.cloud.user) {
    clearAccountHint();
    await enterAnonymousMode({ message: "Вихід виконано. Особисті дані приховано; доступний каталог." });
  }
}

async function initializeCloud() {
  const test = globalThis.__WORKOUT_CLOUD_TEST__;
  const config = test?.config ?? cloudConfig;
  state.cloud.config = config;
  state.cloud.configured = isCloudConfigured(config);
  if (!state.cloud.configured) {
    await enterAnonymousMode({ message: "Хмарна синхронізація поки недоступна. Можна тренуватися локально без акаунта." });
    return;
  }
  try {
    const createClient = test?.createClient ?? (await import(config.supabaseClientUrl || cloudConfig.supabaseClientUrl)).createClient;
    state.cloud.auth = createSupabaseAuth({ config, createClient });
    state.cloud.sdkError = null;
    state.cloud.offlineIdentity = false;
    const session = await state.cloud.auth.getSession();
    if (session?.user) {
      state.cloud.session = session;
      saveAccountHint(session.user);
      await switchStorageProfile(session.user, { initialize: true });
    } else {
      clearAccountHint();
      await enterAnonymousMode();
    }
    state.cloud.auth.onAuthStateChange((event, nextSession) => {
      setTimeout(() => void applyAuthSession(nextSession, event), 0);
    });
  } catch (error) {
    state.cloud.sdkError = error;
    const hint = accountHint();
    if (hint?.id) {
      try {
        setStorageScope(hint.id);
        state.cloud.user = hint;
        state.cloud.offlineIdentity = true;
        state.cloud.sync = makeSyncFor(hint.id) ?? makeOfflineSyncFor(hint.id);
        state.cloud.accessReady = true;
        await loadCurrentScope();
        setCloudStatus("Хмарний сервіс недоступний. Відкрито ізольований кеш останнього акаунта; зміни очікуватимуть синхронізації.", true);
      } catch {
        clearAccountHint();
        await enterAnonymousMode({ message: `Хмара недоступна: ${error.message}. Можна тренуватися локально без акаунта.` });
      }
    } else {
      await enterAnonymousMode({ message: `Хмара недоступна: ${error.message}. Можна тренуватися локально без акаунта.` });
    }
  }
  renderAccount();
  updateConnectionStatus();
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

function updateNavigationState() {
  document.querySelectorAll(".drawer-link[data-nav-id]").forEach((button) => {
    if (button.dataset.navId === activeNavigationId) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function setBackgroundInert(inert) {
  const main = document.querySelector("main");
  const brand = document.querySelector(".brand-block");
  const headerActions = document.querySelector(".header-actions");
  if (main) main.inert = inert;
  if (brand) brand.inert = inert;
  if (headerActions) headerActions.inert = inert;
}

function closeMenu({ restoreFocus = true } = {}) {
  const drawer = byId("app-drawer");
  const backdrop = byId("menu-backdrop");
  const toggle = byId("menu-toggle");
  if (!drawer || drawer.hidden) return;
  drawer.hidden = true;
  backdrop.hidden = true;
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Відкрити меню");
  document.body.classList.remove("menu-open");
  setBackgroundInert(false);
  if (restoreFocus) (drawerReturnFocus?.isConnected ? drawerReturnFocus : toggle).focus();
  drawerReturnFocus = null;
}

function openMenu() {
  const drawer = byId("app-drawer");
  const backdrop = byId("menu-backdrop");
  const toggle = byId("menu-toggle");
  if (!drawer || !drawer.hidden) return;
  drawerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : toggle;
  drawer.hidden = false;
  backdrop.hidden = false;
  toggle.setAttribute("aria-expanded", "true");
  toggle.setAttribute("aria-label", "Закрити меню");
  document.body.classList.add("menu-open");
  setBackgroundInert(true);
  requestAnimationFrame(() => (
    drawer.querySelector('[aria-current="page"]')
    || drawer.querySelector("button:not([disabled])")
  )?.focus());
}

function showSection(id, { focus = false, focusTarget = null, navigationId = id } = {}) {
  if (!SECTION_IDS.includes(id)) return;
  activeSectionId = id;
  activeNavigationId = navigationId;
  for (const sectionId of SECTION_IDS) {
    const section = byId(`tab-${sectionId}`);
    if (section) section.hidden = sectionId !== id;
  }
  updateNavigationState();
  if (focus) {
    const target = focusTarget ? byId(focusTarget) : byId(`${id}-title`);
    requestAnimationFrame(() => target?.focus());
  }
}

function trapDrawerFocus(event) {
  if (event.key !== "Tab") return;
  const drawer = byId("app-drawer");
  const focusable = [...drawer.querySelectorAll('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.hidden && node.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
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
    await markPendingAndSync("редагування підходів");
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
    showSection("history");
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
    host.append(element("p", {
      className: "inactive-log-hint",
      text: hasWorkoutAccess() ? "Почни тренування, щоб записувати підходи." : "Увійдіть або оберіть тренування без акаунта, щоб записувати вагу й повторення.",
    }));
  }
  body.append(host);
  renderTechnique(card, body);
  details.append(summary, body);
  return details;
}

function formatDurationMinutes(duration) {
  if (Number.isFinite(duration)) return `близько ${duration} хв`;
  if (duration && Number.isFinite(duration.min) && Number.isFinite(duration.max)) {
    return duration.min === duration.max ? `${duration.min} хв` : `${duration.min}–${duration.max} хв`;
  }
  return "тривалість залежить від темпу";
}

function formatProgramFrequency(program) {
  return `${program.frequency.sessionsPerWeek}× на тиждень · ${formatDurationMinutes(program.frequency.durationMinutes)}`;
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
    element("strong", { className: "program-title", text: program.name }),
    element("p", { text: program.description }),
    element("p", { className: "program-audience", text: `Для кого: ${program.audience}` }),
    element("span", { className: "program-meta", text: formatProgramFrequency(program) }),
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
  if (!hasWorkoutAccess()) {
    summary.textContent = "Увійдіть або оберіть тренування без акаунта";
    start.textContent = "Обрати спосіб збереження";
    start.disabled = false;
    finish.disabled = true;
    date.disabled = true;
  } else if (state.active) {
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
  if (!hasWorkoutAccess()) {
    showSection("account", { focus: true });
    setCloudStatus("Увійдіть або прийміть умови тренувань без акаунта.");
    return;
  }
  if (state.active) {
    setStatus("Спочатку заверши поточне тренування", true);
    return;
  }
  const date = byId("workout-date").value;
  try {
    state.active = await startSession(state.selectedProgramId, state.selectedDayId, { workoutDate: date, performedAt: performedAtForDate(date) });
    await markPendingAndSync("початок тренування");
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
    state.active = await getActiveSession();
    await refreshData();
    renderJournal();
    renderHistory();
    await markPendingAndSync("завершення тренування", { awaitCloud: true });
    setStatus(state.localMode ? "Тренування збережено локально" : navigator.onLine === false ? "Завершено локально · очікує синхронізації" : "Тренування збережено у хмарі");
  } catch (error) {
    reportError(error);
  }
}

function renderHistory() {
  if (!hasWorkoutAccess()) {
    byId("history-filters")?.replaceChildren();
    byId("history-list")?.replaceChildren();
    const detail = byId("history-detail");
    if (detail) {
      detail.hidden = true;
      detail.replaceChildren();
    }
    renderAccessState();
    return;
  }
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
    if (!hasWorkoutAccess()) return;
    if (state.active) return alert("Спочатку заверши поточне тренування.");
    try {
      const updated = await putSession({ ...session, status: "draft", completedAt: null }, session.revision);
      await putSetting("activeSessionId", updated.id);
      await putSetting("currentProgramId", updated.programId);
      state.active = { session: updated, entries: await listEntriesForSession(updated.id) };
      selectProgram(updated.programId, updated.dayId);
      showSection("journal");
      byId("history-detail").hidden = true;
      await refreshData();
      renderJournal();
      renderHistory();
      await markPendingAndSync("редагування тренування", { awaitCloud: true });
      setStatus("Історичне тренування відкрито для редагування");
    } catch (error) { reportError(error); }
  },
  onDelete: async (session) => {
    if (!hasWorkoutAccess()) return;
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
      await markPendingAndSync("видалення тренування", { awaitCloud: true });
      setStatus(state.localMode ? "Тренування видалено локально" : navigator.onLine === false ? "Видалено локально · очікує синхронізації" : "Тренування видалено з хмари");
    } catch (error) { reportError(error); }
  },
};

async function exportBackup() {
  try {
    if (!hasWorkoutAccess()) throw new Error("Оберіть спосіб збереження тренувань");
    if (state.active) await flushSaves();
    const payload = await createBackup();
    downloadBackup(payload);
    setBackupStatus(`Експортовано ${payload.sessions.length} тренувань`);
  } catch (error) { reportError(error, "backup"); }
}

async function importBackup(file) {
  if (!file) return;
  try {
    if (!hasWorkoutAccess()) throw new Error("Оберіть спосіб збереження тренувань");
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
    await markPendingAndSync("імпорт резервної копії", { awaitCloud: true });
    setBackupStatus(`${state.localMode ? "Імпортовано локально" : navigator.onLine === false ? "Імпортовано локально; очікує синхронізації" : "Імпортовано у хмару"}. Нових записів: ${merge.additions}; дублів: ${merge.duplicates.length}`);
  } catch (error) { reportError(error, "backup"); }
  finally { byId("import-backup").value = ""; }
}

function renderProgramGuide() {
  const host = byId("program-guide-list");
  if (!host) return;
  host.replaceChildren(...PROGRAM_LIST.map((program) => {
    const item = element("article", { className: "program-guide-item" });
    item.dataset.programId = program.id;
    const action = element("button", { className: "action-btn action-secondary guide-select-program", text: "Обрати програму", type: "button" });
    action.dataset.programId = program.id;
    action.addEventListener("click", async () => {
      if (state.active) {
        showSection("journal", { focus: true, focusTarget: "active-session-summary" });
        setStatus("Заверши поточне тренування, перш ніж змінювати програму", true);
        return;
      }
      try {
        selectProgram(program.id);
        if (hasWorkoutAccess()) {
          await putSetting("currentProgramId", program.id);
          await markPendingAndSync("вибір програми");
        }
        renderJournal();
        showSection("journal", { focus: true, focusTarget: "program-summary" });
        setStatus(`Обрано програму: ${program.name}`);
      } catch (error) { reportError(error); }
    });
    item.append(
      element("h3", { text: program.name }),
      element("p", { className: "program-guide-description", text: program.description }),
      element("p", { className: "program-guide-audience", text: `Для кого: ${program.audience}` }),
      element("span", { className: "program-meta", text: `${formatProgramFrequency(program)} · ${program.days.length} типи тренувань` }),
      action,
    );
    return item;
  }));
}

async function signIn(event) {
  event.preventDefault();
  if (!state.cloud.auth) return;
  try {
    const result = await state.cloud.auth.signIn({
      email: byId("account-email").value.trim(),
      password: byId("account-password").value,
    });
    byId("account-password").value = "";
    await applyAuthSession(result.session ?? (result.user ? { user: result.user } : null), "SIGNED_IN");
    setCloudStatus("Вхід виконано. Завантажено хмарну історію цього акаунта.");
  } catch (error) { setCloudStatus(error.message, true); }
}

async function registerAccount() {
  if (!state.cloud.auth || !byId("account-form").reportValidity()) return;
  try {
    const result = await state.cloud.auth.signUp({
      email: byId("account-email").value.trim(),
      password: byId("account-password").value,
    });
    byId("account-password").value = "";
    if (result.session) await applyAuthSession(result.session, "SIGNED_IN");
    else setCloudStatus("Реєстрацію створено. Підтвердь email за посиланням у листі, потім увійди.");
  } catch (error) { setCloudStatus(error.message, true); }
}

async function requestPasswordReset() {
  const email = byId("account-email");
  if (!state.cloud.auth || !email.reportValidity()) return;
  try {
    await state.cloud.auth.resetPasswordForEmail(email.value.trim());
    setCloudStatus("Посилання для відновлення пароля надіслано на email.");
  } catch (error) { setCloudStatus(error.message, true); }
}

async function updateRecoveredPassword(event) {
  event.preventDefault();
  const password = byId("account-new-password");
  if (!state.cloud.auth || !password.reportValidity()) return;
  try {
    await state.cloud.auth.updatePassword(password.value);
    byId("password-recovery-form").hidden = true;
    password.value = "";
    setCloudStatus("Новий пароль збережено.");
  } catch (error) { setCloudStatus(error.message, true); }
}

async function logoutAccount() {
  if (!hasAccount()) return;
  try {
    if (state.active || state.dirtyEntries.size || state.saveQueues.size) await flushSaves();
    if (await state.cloud.sync.hasPending()) {
      if (navigator.onLine !== false) await runCloudSync("вихід");
      if (await state.cloud.sync.hasPending()) {
        const approved = confirm("Є зміни, які ще не потрапили в хмару. Вийти все одно? Вони залишаться в ізольованому кеші цього акаунта й синхронізуються після наступного входу.");
        if (!approved) {
          setCloudStatus("Вихід скасовано: спочатку синхронізуйте зміни.", true);
          return;
        }
      }
    }
    if (state.cloud.auth) await state.cloud.auth.signOut();
  } catch (error) {
    setCloudStatus(`Не вдалося завершити вихід: ${error.message}`, true);
    return;
  }
  clearAccountHint();
  await enterAnonymousMode({ message: "Вихід виконано. Особисті дані приховано; доступний каталог." });
}

async function importLegacyData() {
  if (!hasAccount()) return;
  if (!confirm("Імпортувати збережені раніше локальні дані в цей акаунт? Це одноразова явна міграція; автоматично дані не приєднуються.")) return;
  try {
    const legacy = await exportLegacyAnonymousData();
    const result = await state.cloud.sync.importLegacy(legacy, { confirmed: true });
    if (result.status === "offline") {
      setCloudStatus("Імпорт потребує мережі: старі дані залишено без змін.", true);
      return;
    }
    if (result.status === "conflict") {
      setCloudStatus(`Імпорт зупинено: ${result.conflicts.length} конфліктів. Старі дані не змінено.`, true);
      return;
    }
    if (result.status === "pending") {
      await loadCurrentScope();
      await updateLegacyImportAvailability();
      setCloudStatus("Імпорт збережено локально; очікує синхронізації.");
      scheduleCloudSync("імпорт");
      return;
    }
    await loadCurrentScope();
    await updateLegacyImportAvailability();
    setCloudStatus(result.status === "already-imported" ? "Старі локальні дані вже були імпортовані." : "Старі локальні дані імпортовано та збережено у хмарі.");
  } catch (error) { setCloudStatus(error.message, true); }
}

function wireControls() {
  byId("enable-local-mode").addEventListener("click", () => void enableLocalMode());
  byId("category-picker").addEventListener("change", async (event) => {
    if (state.active) return;
    const next = PROGRAM_LIST.find((program) => program.categoryId === event.target.value);
    if (!next) return;
    selectProgram(next.id);
    if (hasWorkoutAccess()) {
      await putSetting("currentProgramId", next.id);
      await markPendingAndSync("вибір програми");
    }
    renderJournal();
  });
  byId("program-picker").addEventListener("change", async (event) => {
    if (state.active) return;
    selectProgram(event.target.value);
    if (hasWorkoutAccess()) {
      await putSetting("currentProgramId", state.selectedProgramId);
      await markPendingAndSync("вибір програми");
    }
    renderJournal();
  });
  byId("start-workout").addEventListener("click", () => beginWorkout());
  byId("finish-workout").addEventListener("click", completeWorkout);
  byId("add-past-workout").addEventListener("click", () => {
    showSection("journal");
    setStatus("Обери програму, день і дату, потім почни тренування");
    byId("workout-date").focus();
  });
  byId("export-backup").addEventListener("click", exportBackup);
  byId("import-backup").addEventListener("change", (event) => importBackup(event.target.files?.[0]));
  byId("account-form").addEventListener("submit", signIn);
  byId("account-register").addEventListener("click", registerAccount);
  byId("account-reset").addEventListener("click", requestPasswordReset);
  byId("account-logout").addEventListener("click", logoutAccount);
  byId("password-recovery-form").addEventListener("submit", updateRecoveredPassword);
  byId("import-legacy-data").addEventListener("click", importLegacyData);
  byId("sync-use-local").addEventListener("click", () => resolveSyncConflict("local"));
  byId("sync-use-cloud").addEventListener("click", () => resolveSyncConflict("cloud"));
  document.querySelectorAll(".open-account").forEach((button) => button.addEventListener("click", () => {
    showSection("account", { focus: true });
  }));
  byId("menu-toggle").addEventListener("click", () => {
    if (byId("app-drawer").hidden) openMenu();
    else closeMenu();
  });
  byId("menu-close").addEventListener("click", () => closeMenu());
  byId("menu-backdrop").addEventListener("click", () => closeMenu());
  byId("app-drawer").addEventListener("keydown", trapDrawerFocus);
  document.querySelectorAll(".drawer-link[data-section]").forEach((button) => {
    button.addEventListener("click", () => {
      const sectionId = button.dataset.section;
      const focusTarget = button.dataset.focusTarget || null;
      closeMenu({ restoreFocus: false });
      showSection(sectionId, {
        focus: true,
        focusTarget,
        navigationId: button.dataset.navId || sectionId,
      });
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !byId("app-drawer").hidden) {
      event.preventDefault();
      closeMenu();
    }
  });
}

function updateConnectionStatus() {
  const label = state.localMode ? "Локально · без акаунта" : !state.cloud.configured
    ? "Оберіть збереження"
    : !hasAccount()
      ? "Оберіть збереження"
      : state.cloud.sdkError ? "Кеш акаунта" : navigator.onLine === false ? "Офлайн · кеш" : "Хмара онлайн";
  byId("app-connection-status").textContent = label;
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
          updateButton.disabled = true;
          updateButton.textContent = "Оновлення…";
          if (state.active) await flushSaves();
          worker.postMessage({ type: "APPLY_UPDATE" });
        } catch (error) {
          updateButton.disabled = false;
          updateButton.textContent = "Оновити";
          reportError(error);
        }
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
  try {
    byId("workout-date").value = localDateString();
    wireControls();
    renderProgramGuide();
    showSection(activeSectionId);
    updateConnectionStatus();
    selectProgram(DEFAULT_PROGRAM_ID);
    renderJournal();
    renderHistory();
    renderAccount();
    addEventListener("online", () => {
      updateConnectionStatus();
      if (state.cloud.offlineIdentity) void initializeCloud();
      else void runCloudSync("відновлення мережі");
    });
    addEventListener("offline", () => {
      updateConnectionStatus();
      renderAccessState();
    });
    await initializeCloud();
    if (state.active) setStatus("Незавершене тренування відновлено");
    renderJournal();
    renderHistory();
    renderAccount();
    await updateLegacyImportAvailability();
    updateConnectionStatus();
    globalThis.__WORKOUT_BOOT__?.ready();
  } catch (error) {
    reportError(error);
    byId("start-workout").disabled = true;
    byId("active-session-summary").textContent = "Локальне сховище недоступне. Перевір режим браузера та дозволи сайту.";
    globalThis.__WORKOUT_BOOT__?.fail(`Застосунок запустився не повністю: ${error.message}`);
  } finally {
    void registerServiceWorker();
  }
}

void boot();
