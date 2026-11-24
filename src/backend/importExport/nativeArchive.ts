import type { SqlDatabase, SqlValue } from "../shared/sql.js";
import { replaceSnapshot, snapshot, type Row, type Snapshot } from "../shared/sync.js";
import { removesToday } from "../shared/syncSafety.js";
import { upgradeSnapshot } from "../shared/storedState.js";

export const NATIVE_ARCHIVE_FORMAT = "openoutliner-recovery-v1";
export interface NativeArchive {
  format: typeof NATIVE_ARCHIVE_FORMAT;
  local: Snapshot;
  outlineHistory?: Row[];
}
const historyColumns = ["seq", "id", "workspace_id", "label", "before_snapshot", "after_snapshot",
  "coalesce_key", "undone", "created_at", "updated_at"] as const;
const historyFields = new Set(["id", "parentId", "position", "title", "body", "dueDate", "done",
  "collapsed", "deletedAt", "createdAt", "updatedAt"]);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function validHistoryNode(value: unknown): boolean {
  if (!object(value)) return false;
  return Object.entries(value).every(([key, field]) => {
    if (!historyFields.has(key)) return false;
    if (key === "position") return typeof field === "number" && Number.isSafeInteger(field);
    if (key === "done" || key === "collapsed") return typeof field === "boolean";
    if (key === "parentId" || key === "dueDate" || key === "deletedAt") return field === null || typeof field === "string";
    return typeof field === "string";
  });
}
function validHistoryPayload(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) return value.every(row => validHistoryNode(row) && typeof row.id === "string" &&
      Object.keys(row).length === historyFields.size);
    return object(value) && value.version === 2 && object(value.nodes) &&
      Object.entries(value.nodes).every(([id, row]) => !!id && (row === null || validHistoryNode(row)));
  } catch { return false; }
}
export function readOutlineHistory(db: SqlDatabase): Row[] {
  return db.prepare("SELECT * FROM outline_history ORDER BY seq ASC").all() as Row[];
}
export function validateHistoryRows(value: unknown, data: Snapshot): Row[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid outline history");
  const workspaces = new Set(data.workspaces.map(row => row.id)), ids = new Set<unknown>(), sequences = new Set<unknown>();
  for (const row of value) {
    if (!object(row) || Object.keys(row).length !== historyColumns.length || historyColumns.some(key => !(key in row)) ||
        typeof row.seq !== "number" || !Number.isSafeInteger(row.seq) || row.seq < 1 ||
        typeof row.id !== "string" || !row.id || typeof row.workspace_id !== "string" || !workspaces.has(row.workspace_id) ||
        typeof row.label !== "string" || typeof row.created_at !== "string" || typeof row.updated_at !== "string" ||
        (row.coalesce_key !== null && typeof row.coalesce_key !== "string") || (row.undone !== 0 && row.undone !== 1) ||
        typeof row.before_snapshot !== "string" || typeof row.after_snapshot !== "string" ||
        !validHistoryPayload(row.before_snapshot) || !validHistoryPayload(row.after_snapshot) ||
        ids.has(row.id) || sequences.has(row.seq)) throw new Error("Invalid outline history; original database retained");
    ids.add(row.id); sequences.add(row.seq);
  }
  return value as Row[];
}

export function exportNativeArchive(db: SqlDatabase): NativeArchive {
  return { format: NATIVE_ARCHIVE_FORMAT, local: snapshot(db), outlineHistory: readOutlineHistory(db) };
}

/** Read old recovery-v1 files as well. The sync baseline is intentionally
 * not restored: an archive is local data, not an acknowledgement by a server. */
export function parseNativeArchive(db: SqlDatabase, input: unknown): NativeArchive {
  if (!object(input) || input.format !== NATIVE_ARCHIVE_FORMAT || !object(input.local)) throw new Error("Invalid OpenOutliner native archive");
  const local = upgradeSnapshot(input.local as unknown as Snapshot, db);
  return { format: NATIVE_ARCHIVE_FORMAT, local, outlineHistory: validateHistoryRows(input.outlineHistory, local) };
}

export function restoreNativeArchive(db: SqlDatabase, input: unknown): NativeArchive {
  const archive = parseNativeArchive(db, input);
  if (removesToday(snapshot(db), archive.local)) throw new Error("Archive omits the existing system Today workspace");
  db.exec("SAVEPOINT native_restore;");
  try {
    replaceSnapshot(db, archive.local);
    const insert = db.prepare(`INSERT INTO outline_history (${historyColumns.join(",")}) VALUES (${historyColumns.map(() => "?").join(",")})`);
    for (const row of archive.outlineHistory ?? []) insert.run(...historyColumns.map(key => row[key] as SqlValue));
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Archive contains invalid foreign keys");
    db.exec("RELEASE native_restore;");
    return archive;
  } catch (error) {
    db.exec("ROLLBACK TO native_restore; RELEASE native_restore;");
    throw error;
  }
}
