import type { SqlDatabase, SqlValue } from "./sql.js";

export const tables = ["workspace_folders", "workspaces", "nodes", "tags", "node_tags", "field_definitions", "field_values"] as const;
export type Table = typeof tables[number];
export type Row = Record<string, string | number | null>;
export type Snapshot = Record<Table, Row[]>;
export interface Change { table: Table; key: string; before: Row | null; after: Row | null }
export function rowKey(table: Table, row: Row): string {
  return JSON.stringify(table === "node_tags" ? [row.node_id, row.tag_id] : table === "field_values" ? [row.node_id, row.field_id] : [row.id]);
}
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => left[key] === right[key]);
}
export function snapshot(db: SqlDatabase): Snapshot {
  return Object.fromEntries(tables.map(table => [table, (db.prepare(`SELECT * FROM ${table}`).all() as Row[])
    .sort((a, b) => rowKey(table, a).localeCompare(rowKey(table, b)))])) as Snapshot;
}
export function changesBetween(before: Snapshot, after: Snapshot): Change[] {
  return tables.flatMap(table => {
    const old = new Map(before[table].map(row => [rowKey(table, row), row]));
    const next = new Map(after[table].map(row => [rowKey(table, row), row]));
    return [...new Set([...old.keys(), ...next.keys()])].flatMap(key => {
      const a = old.get(key) ?? null, b = next.get(key) ?? null;
      return equal(a, b) ? [] : [{ table, key, before: a, after: b }];
    });
  });
}
export class SyncConflict extends Error {
  statusCode = 409;
  constructor(public readonly current: Snapshot, public readonly conflicts: string[]) { super("其他设备也修改了这些数据，请选择要保留的版本。"); }
}
// Merge different fields independently; never silently overwrite the same field.
export function mergeChanges(current: Snapshot, changes: Change[]): Snapshot {
  const result = structuredClone(current);
  const conflicts: string[] = [];
  for (const change of changes) {
    const rows = result[change.table];
    const index = rows.findIndex(row => rowKey(change.table, row) === change.key);
    const remote = rows[index] ?? null;
    let merged = change.after;
    if (equal(remote, change.after)) continue; // Acknowledgement lost: already applied.
    if (!equal(remote, change.before)) {
      if (remote && change.before && change.after) {
        merged = { ...remote };
        for (const field of Object.keys(change.after)) {
          if (change.after[field] === change.before[field]) continue;
          if (field !== "updated_at" && remote[field] !== change.before[field] && remote[field] !== change.after[field]) {
            conflicts.push(`${change.table}: ${String(remote.title ?? remote.name ?? change.key)} (${field})`);
          }
          merged[field] = change.after[field];
        }
      } else conflicts.push(`${change.table}: ${String(remote?.title ?? change.before?.title ?? change.key)} (新增或删除)`);
    }
    if (merged === null) { if (index >= 0) rows.splice(index, 1); }
    else if (index >= 0) rows[index] = merged;
    else rows.push(merged);
  }
  if (conflicts.length) throw new SyncConflict(current, conflicts);
  return result;
}
export function replaceSnapshot(db: SqlDatabase, data: Snapshot, clearHistory = true): void {
  db.exec("SAVEPOINT replace_snapshot; PRAGMA defer_foreign_keys = ON;");
  try {
    if (clearHistory) db.exec("DELETE FROM outline_history;");
    for (const table of [...tables].reverse()) db.exec(`DELETE FROM ${table};`);
    for (const table of tables) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name));
      const insert = db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      for (const row of data[table]) insert.run(...columns.map(column => row[column] as SqlValue));
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("数据关联冲突（目标可能已删除），请先处理同步冲突。");
    validateTrees(data);
    db.exec("RELEASE replace_snapshot;");
  } catch (error) { db.exec("ROLLBACK TO replace_snapshot; RELEASE replace_snapshot;"); throw error; }
}
function validateTrees(data: Snapshot): void {
  const nodes = new Map(data.nodes.map(row => [row.id, row]));
  for (const workspace of data.workspaces) {
    const root = nodes.get(workspace.root_node_id);
    if (!root || root.parent_id !== null || root.workspace_id !== workspace.id || root.deleted_at !== null) throw new Error("工作区根节点冲突");
  }
  for (const [rows, parentField] of [[data.nodes, "parent_id"], [data.workspaces, "parent_workspace_id"]] as const) {
    const map = new Map(rows.map(row => [row.id, row]));
    for (const row of rows) {
      const seen = new Set();
      let cursor: Row | undefined = row;
      while (cursor) {
        if (seen.has(cursor.id)) throw new Error("移动冲突：不能形成循环层级");
        seen.add(cursor.id);
        const parent: Row | undefined = map.get(cursor[parentField]);
        if (parentField === "parent_id" && parent && (parent.workspace_id !== row.workspace_id || (row.deleted_at === null && parent.deleted_at !== null))) throw new Error("节点父级冲突");
        cursor = parent;
      }
    }
  }
}
