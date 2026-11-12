import { SCHEMA_VERSION } from "./schema.js";
import type { SqlDatabase } from "./sql.js";
import type { Row, Snapshot, Table } from "./sync.js";

export interface StoredState {
  bytes: Uint8Array;
  base: Snapshot;
  revision: string;
  conflict?: { current: Snapshot; conflicts: string[] };
  backups: Array<{ date: string; data: Snapshot }>;
  schemaVersion?: number;
}

export function needsStoredUpgrade(state: Pick<StoredState, "schemaVersion">): boolean {
  const version = state.schemaVersion ?? 0;
  if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) {
    throw new Error("Local data requires a newer application. Original data has been retained.");
  }
  return version < SCHEMA_VERSION;
}

interface Column {
  name: string;
  notnull: number;
  pk: number;
  dflt_value: string | null;
}
const tables: Table[] = ["workspace_folders", "workspaces", "nodes", "tags", "node_tags", "field_definitions", "field_values"];
const compare = (a: Row, b: Row) => {
  for (const key of ["created_at", "id"]) {
    const left = String(a[key]), right = String(b[key]);
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
};

/** Upgrade a sync baseline, not just SQLite bytes, so unsynced edits remain genuine deltas. */
export function upgradeSnapshot(data: Snapshot, db: SqlDatabase): Snapshot {
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid stored snapshot.");
  const upgraded = {} as Snapshot;
  for (const table of tables) {
    // Folders were absent in older versions. Other missing tables are not silently discarded.
    const source = data[table] ?? (table === "workspace_folders" ? [] : undefined);
    if (!Array.isArray(source)) throw new Error(`Stored snapshot is missing ${table}. Original data has been retained.`);
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Column[];
    if (!columns.length) throw new Error(`Database schema is missing ${table}.`);
    const names = new Set(columns.map(column => column.name));
    const defaults = new Map<string, Row[string]>();
    for (const column of columns) {
      if (column.dflt_value !== null) {
        // Expressions come from the application's SQLite schema, never from backup contents.
        defaults.set(column.name, db.prepare(`SELECT ${column.dflt_value} AS value`).get()?.value as Row[string]);
      } else if (!column.notnull && !column.pk) defaults.set(column.name, null);
    }
    upgraded[table] = source.map(row => {
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`Invalid row in ${table}.`);
      if (Object.keys(row).some(key => !names.has(key))) throw new Error(`Unrecognized ${table} columns; update the application.`);
      return Object.fromEntries(columns.map(column => {
        const present = Object.prototype.hasOwnProperty.call(row, column.name);
        if (!present && !defaults.has(column.name)) throw new Error(`Missing ${table}.${column.name}.`);
        const value = present ? row[column.name] : defaults.get(column.name)!;
        if ((value === null && (column.notnull || column.pk)) ||
          (value !== null && typeof value !== "string" && !(typeof value === "number" && Number.isFinite(value)))) {
          throw new Error(`Invalid ${table}.${column.name}.`);
        }
        return [column.name, value];
      }));
    });
  }
  if (data.workspaces.length && data.workspaces.every(row => !("position" in row))) {
    // Match the one-time legacy SQL migration, including deterministic ties.
    const positions = new Map<string, number>();
    for (const workspace of [...upgraded.workspaces].sort(compare)) {
      const key = JSON.stringify([workspace.parent_workspace_id, workspace.parent_workspace_id === null ? workspace.folder_id : null]);
      const position = positions.get(key) ?? 0;
      workspace.position = position;
      positions.set(key, position + 1);
    }
  }
  return upgraded;
}

/** The caller persists this result and the original envelope in one IndexedDB transaction. */
export function upgradeStoredState(state: StoredState, db: SqlDatabase, bytes: Uint8Array): StoredState {
  if (!needsStoredUpgrade(state)) return state;
  return {
    ...state,
    schemaVersion: SCHEMA_VERSION,
    bytes,
    base: upgradeSnapshot(state.base, db),
    conflict: state.conflict ? { ...state.conflict, current: upgradeSnapshot(state.conflict.current, db) } : undefined,
    backups: state.backups.map(backup => ({ ...backup, data: upgradeSnapshot(backup.data, db) }))
  };
}
