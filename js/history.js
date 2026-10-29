import { validWorkingSets } from "./workouts.js";

export function formatWorkoutDate(value) {
  if (!value) return "—";
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return value;
  return new Intl.DateTimeFormat("uk-UA", { day: "2-digit", month: "2-digit", year: "numeric" })
    .format(new Date(year, month - 1, day));
}

export function formatSet(set, metric = set.metric) {
  const side = set.side && set.side !== "both" ? ` (${set.side === "left" ? "ліва" : "права"})` : "";
  if (metric === "duration") return `${set.durationSeconds} с${side}`;
  if (metric === "reps") return `${set.reps} повт.${side}`;
  return `${new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 2 }).format(set.loadKg)} кг × ${set.reps}${side}`;
}

export function formatEntryResult(entry) {
  return validWorkingSets(entry).map((set) => formatSet(set, entry.metric)).join("; ");
}

export function buildProgressSeries(targetEntry, sessions, entries, period = "all", now = new Date()) {
  const sessionMap = new Map(sessions.map((session) => [session.id, session]));
  const days = period === "all" ? null : Number(period);
  const cutoff = Number.isFinite(days) ? now.getTime() - days * 24 * 60 * 60 * 1000 : null;
  const valueFor = (entry) => {
    const sets = validWorkingSets(entry);
    if (!sets.length) return null;
    if (entry.metric === "duration") return Math.max(...sets.map((set) => set.durationSeconds));
    if (entry.metric === "reps") return Math.max(...sets.map((set) => set.reps));
    return Math.max(...sets.map((set) => set.loadKg));
  };

  return entries
    .filter((entry) => entry.exerciseId === targetEntry.exerciseId
      && entry.variantId === targetEntry.variantId
      && entry.equipmentKey === targetEntry.equipmentKey
      && entry.metric === targetEntry.metric)
    .map((entry) => ({ entry, session: sessionMap.get(entry.sessionId), value: valueFor(entry) }))
    .filter(({ session, value }) => session?.status === "completed"
      && value !== null
      && (cutoff === null || new Date(session.performedAt).getTime() >= cutoff))
    .sort((a, b) => a.session.performedAt.localeCompare(b.session.performedAt))
    .map(({ entry, session, value }) => ({
      sessionId: session.id,
      workoutDate: session.workoutDate,
      performedAt: session.performedAt,
      value,
      entry,
    }));
}

const element = (tag, options = {}) => {
  const node = document.createElement(tag);
  if (options.className) node.className = options.className;
  if (options.text !== undefined) node.textContent = options.text;
  if (options.type) node.type = options.type;
  return node;
};

const SVG_NS = "http://www.w3.org/2000/svg";

function metricLabel(metric, value) {
  const number = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 2 }).format(value);
  if (metric === "duration") return `${number} с`;
  if (metric === "reps") return `${number} повторів`;
  return `${number} кг`;
}

function renderProgressChart(series, metric) {
  const figure = element("figure", { className: "progress-chart" });
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 360 180");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Графік історії: ${series.length} точок, показник ${metric === "load-reps" ? "вага" : metric === "reps" ? "повтори" : "секунди"}`);
  const title = document.createElementNS(SVG_NS, "title");
  title.textContent = "Зміна фактичного показника вправи за часом";
  svg.append(title);

  const left = 34;
  const right = 340;
  const top = 20;
  const bottom = 145;
  const values = series.map((point) => point.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const xFor = (index) => series.length === 1 ? (left + right) / 2 : left + index * (right - left) / (series.length - 1);
  const yFor = (value) => min === max ? (top + bottom) / 2 : bottom - (value - min) * (bottom - top) / (max - min);

  const axis = document.createElementNS(SVG_NS, "path");
  axis.setAttribute("class", "progress-axis");
  axis.setAttribute("d", `M ${left} ${top} V ${bottom} H ${right}`);
  svg.append(axis);

  const points = series.map((point, index) => `${xFor(index)},${yFor(point.value)}`).join(" ");
  if (series.length > 1) {
    const line = document.createElementNS(SVG_NS, "polyline");
    line.setAttribute("class", "progress-line");
    line.setAttribute("points", points);
    svg.append(line);
  }
  series.forEach((point, index) => {
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("class", "progress-point");
    circle.setAttribute("cx", String(xFor(index)));
    circle.setAttribute("cy", String(yFor(point.value)));
    circle.setAttribute("r", "5");
    const pointTitle = document.createElementNS(SVG_NS, "title");
    pointTitle.textContent = `${formatWorkoutDate(point.workoutDate)}: ${metricLabel(metric, point.value)}. Підходи: ${formatEntryResult(point.entry)}`;
    circle.append(pointTitle);
    svg.append(circle);
  });

  figure.append(svg);
  const caption = element("figcaption", { text: "Точки показують максимальне підтверджене значення кожної сесії. Точні підходи наведені нижче." });
  figure.append(caption);
  return figure;
}

function renderProgressTable(series) {
  const wrapper = element("div", { className: "table-wrapper progress-table" });
  const table = element("table");
  const thead = element("thead");
  const headRow = element("tr");
  headRow.append(element("th", { text: "Дата" }), element("th", { text: "Фактичні підходи" }));
  thead.append(headRow);
  const tbody = element("tbody");
  [...series].reverse().forEach((point) => {
    const row = element("tr");
    row.append(
      element("td", { text: formatWorkoutDate(point.workoutDate) }),
      element("td", { text: formatEntryResult(point.entry) }),
    );
    tbody.append(row);
  });
  table.append(thead, tbody);
  wrapper.append(table);
  return wrapper;
}

export function renderHistoryFilters(container, value, onChange) {
  container.replaceChildren();
  const label = element("label", { className: "field-label", text: "День" });
  const select = element("select");
  select.setAttribute("aria-label", "Фільтр історії за днем");
  for (const [id, title] of [["all", "Усі"], ["a", "День A"], ["b", "День B"], ["c", "День C"]]) {
    const option = element("option", { text: title });
    option.value = id;
    option.selected = id === value;
    select.append(option);
  }
  select.addEventListener("change", () => onChange(select.value));
  label.append(select);
  container.append(label);
}

export function renderSessionList(container, sessions, entries, handlers = {}, dayFilter = "all") {
  container.replaceChildren();
  const completed = sessions
    .filter((session) => session.status === "completed" && (dayFilter === "all" || session.dayId === dayFilter))
    .sort((a, b) => b.performedAt.localeCompare(a.performedAt));

  if (!completed.length) {
    container.append(element("p", { className: "empty-state", text: "Історія з’явиться після першого завершеного тренування." }));
    return;
  }

  for (const session of completed) {
    const confirmedCount = entries
      .filter((entry) => entry.sessionId === session.id)
      .reduce((total, entry) => total + validWorkingSets(entry).length, 0);
    const article = element("article", { className: "history-item" });
    const header = element("div", { className: "history-item-header" });
    const copy = element("div");
    copy.append(
      element("strong", { text: `${formatWorkoutDate(session.workoutDate)} · День ${session.dayId.toUpperCase()}` }),
      element("p", { text: `${confirmedCount} підтверджених підходів` }),
    );
    const open = element("button", { className: "action-btn action-secondary", text: "Переглянути", type: "button" });
    open.addEventListener("click", () => handlers.onOpen?.(session));
    header.append(copy, open);
    article.append(header);
    container.append(article);
  }
}

export function renderSessionDetail(container, session, entries, handlers = {}) {
  container.replaceChildren();
  container.hidden = false;
  const heading = element("div", { className: "history-item-header" });
  heading.append(element("h2", { text: `${formatWorkoutDate(session.workoutDate)} · День ${session.dayId.toUpperCase()}` }));
  const close = element("button", { className: "action-btn action-secondary", text: "Закрити", type: "button" });
  close.addEventListener("click", () => {
    container.hidden = true;
    container.replaceChildren();
  });
  heading.append(close);
  container.append(heading);

  const sessionEntries = entries.filter((entry) => entry.sessionId === session.id);
  for (const entry of sessionEntries) {
    const result = formatEntryResult(entry);
    if (!result) continue;
    const row = element("article", { className: "history-item" });
    row.append(
      element("strong", { text: `${entry.exerciseNameSnapshot} · ${entry.variantSnapshot}` }),
      element("p", { text: result }),
    );
    container.append(row);
  }

  if (!sessionEntries.some((entry) => validWorkingSets(entry).length)) {
    container.append(element("p", { className: "empty-state", text: "У цій сесії немає підтверджених підходів." }));
  }
  const actions = element("div", { className: "workout-actions" });
  const edit = element("button", { className: "action-btn action-secondary", text: "Редагувати", type: "button" });
  edit.addEventListener("click", () => handlers.onEdit?.(session));
  const remove = element("button", { className: "action-btn action-danger", text: "Видалити", type: "button" });
  remove.addEventListener("click", () => handlers.onDelete?.(session));
  actions.append(edit, remove);
  container.append(actions);
}

export function renderExerciseHistory(container, targetEntry, sessions, entries) {
  const render = (period = "all") => {
    container.replaceChildren();
    container.hidden = false;
    const heading = element("div", { className: "history-item-header" });
    heading.append(element("h2", { text: `Прогрес: ${targetEntry.exerciseNameSnapshot}` }));
    const close = element("button", { className: "action-btn action-secondary", text: "Закрити", type: "button" });
    close.addEventListener("click", () => {
      container.hidden = true;
      container.replaceChildren();
    });
    heading.append(close);
    container.append(heading);

    const periodSelect = element("select");
    periodSelect.setAttribute("aria-label", "Період прогресу");
    for (const [value, text] of [["30", "30 днів"], ["90", "90 днів"], ["all", "Увесь час"]]) {
      const option = element("option", { text });
      option.value = value;
      option.selected = value === period;
      periodSelect.append(option);
    }
    periodSelect.addEventListener("change", () => render(periodSelect.value));
    container.append(fieldLabelForHistory("Період", periodSelect));

    const series = buildProgressSeries(targetEntry, sessions, entries, period);
    if (!series.length) {
      container.append(element("p", { className: "empty-state", text: "Для цього варіанта й періоду ще немає завершених результатів." }));
      return;
    }
    container.append(renderProgressChart(series, targetEntry.metric), renderProgressTable(series));
  };
  render();
}

function fieldLabelForHistory(text, control) {
  const label = element("label", { className: "field-label", text });
  label.append(control);
  return label;
}
