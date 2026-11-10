// The wire format is versioned independently from JSON backups and the catalog.
export const SYNC_FORMAT_VERSION = 1;
export const DEVICE_SETTINGS = new Set(["activeSessionId", "currentProgramId"]);
export const LEGACY_IMPORT_MARKER_KEY = "cloudLegacyImportV1";
export const clone = (value) => structuredClone(value);
export const recordKey = (kind, id) => `${kind}:${id}`;
export const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
export function normalizeSnapshot(snapshot = {}) {
  const sort = (rows, field) => [...(rows ?? [])].map(clone).sort((a, b) => String(a[field]).localeCompare(String(b[field])));
  return { sessions: sort(snapshot.sessions, "id"), entries: sort(snapshot.entries, "id"), settings: sort(snapshot.settings, "key") };
}
export function snapshotRecords(snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  const grouped = new Map(normalized.sessions.map((session) => [session.id, { session, entries: [] }]));
  for (const entry of normalized.entries) {
    if (!grouped.has(entry.sessionId)) throw new Error(`Запис ${entry.id} не має тренування`);
    grouped.get(entry.sessionId).entries.push(entry);
  }
  return [
    ...[...grouped].map(([id, payload]) => ({ kind: "session", id, payload, deleted: false })),
    ...normalized.settings.filter(({ key }) => !DEVICE_SETTINGS.has(key)).map((setting) => ({ kind: "setting", id: setting.key, payload: setting, deleted: false })),
  ];
}
export const valueOfRemote = (row) => ({ payload: row.payload, deleted: Boolean(row.deleted_at) });
export const sameValue = (a, b) => Boolean(a?.deleted) === Boolean(b?.deleted)
  && (a?.deleted || canonical(a?.payload) === canonical(b?.payload));
export async function snapshotDigest(snapshot) {
  const bytes = new TextEncoder().encode(canonical(normalizeSnapshot(snapshot)));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
