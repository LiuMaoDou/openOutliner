import type { SqlDatabase, SqlValue } from "./sql.js";
import { TODAY_ROOT_NODE_ID, TODAY_WORKSPACE_ID } from "./systemWorkspaces.js";

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
    .map(row => ({ key: rowKey(table, row), row }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(entry => entry.row)])) as Snapshot;
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
// Deletion/restoration and concurrent content changes are semantic conflicts.
// Position/timestamp-only changes may be ordinary sibling reordering.
const nodeContentFields = ["title", "body", "due_date", "done", "collapsed", "parent_id", "workspace_id"] as const;
function lifecycleConflict(before: Row, local: Row, remote: Row): boolean {
  const localLifecycle = local.deleted_at !== before.deleted_at;
  const remoteLifecycle = remote.deleted_at !== before.deleted_at;
  if (localLifecycle === remoteLifecycle) return false;
  const other = localLifecycle ? remote : local;
  return nodeContentFields.some(field => other[field] !== before[field]);
}

// Merge different fields independently; never silently overwrite the same field.
export function mergeChanges(current: Snapshot, changes: Change[]): Snapshot {
  const result = structuredClone(current);
  // Index each affected table once. Map insertion order preserves row order,
  // including a delete followed by a reinsert in the same batch.
  const indexed = new Map<Table, Map<string, Row>>();
  const conflicts: string[] = [];
  for (const change of changes) {
    let rows = indexed.get(change.table);
    if (!rows) {
      rows = new Map(result[change.table].map(row => [rowKey(change.table, row), row]));
      indexed.set(change.table, rows);
    }
    const remote = rows.get(change.key) ?? null;
    let merged = change.after;
    if (equal(remote, change.after)) continue; // Acknowledgement lost: already applied.
    if (!equal(remote, change.before)) {
      if (remote && change.before && change.after) {
        if (change.table === "nodes" && lifecycleConflict(change.before, change.after, remote)) {
          conflicts.push(`节点：${String(remote.title ?? change.key)}（删除/恢复与内容编辑冲突）`);
          continue;
        }
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
    if (merged === null) rows.delete(change.key);
    else rows.set(change.key, merged);
  }
  if (conflicts.length) throw new SyncConflict(current, conflicts);
  for (const [table, rows] of indexed) result[table] = [...rows.values()];
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
  const roots = new Map(data.workspaces.map(row => [row.id, row.root_node_id]));
  for (const workspace of data.workspaces) {
    const root = nodes.get(workspace.root_node_id);
    if (!root || root.parent_id !== null || root.workspace_id !== workspace.id || root.deleted_at !== null) throw new Error("工作区根节点冲突");
    if (workspace.id === TODAY_WORKSPACE_ID &&
        (workspace.root_node_id !== TODAY_ROOT_NODE_ID || workspace.parent_workspace_id !== null || workspace.folder_id !== null || workspace.name !== "Today")) {
      throw new Error("系统 Today 工作区结构冲突");
    }
  }
  // Along with foreign-key and edge/cycle checks, this establishes reachability.
  for (const node of data.nodes) {
    if (node.deleted_at === null && node.parent_id === null && roots.get(node.workspace_id) !== node.id) {
      throw new Error(`孤立节点：「${node.title}」没有连接到工作区根节点`);
    }
  }
  const tags = new Map(data.tags.map(row => [row.id, row]));
  const fields = new Map(data.field_definitions.map(row => [row.id, row]));
  for (const field of data.field_definitions) {
    if (tags.get(field.tag_id)?.workspace_id !== field.workspace_id) throw new Error("字段与标签不属于同一工作区");
  }
  // Tombstones may retain metadata from their historical workspace.
  for (const relation of data.node_tags) {
    const node = nodes.get(relation.node_id);
    if (node?.deleted_at === null && tags.get(relation.tag_id)?.workspace_id !== node.workspace_id) throw new Error("节点与标签不属于同一工作区");
  }
  for (const relation of data.field_values) {
    const node = nodes.get(relation.node_id);
    if (node?.deleted_at === null && fields.get(relation.field_id)?.workspace_id !== node.workspace_id) throw new Error("节点与字段不属于同一工作区");
  }
  for (const [rows, parentField] of [[data.nodes, "parent_id"], [data.workspaces, "parent_workspace_id"]] as const) {
    const map = new Map(rows.map(row => [row.id, row]));
    const validated = new Set<Row["id"]>();
    for (const row of rows) {
      const seen = new Set<Row["id"]>();
      let cursor: Row | undefined = row;
      while (cursor && !validated.has(cursor.id)) {
        if (seen.has(cursor.id)) throw new Error("移动冲突：不能形成循环层级");
        seen.add(cursor.id);
        const parent: Row | undefined = map.get(cursor[parentField]);
        // Deleted records retain historical parent/workspace links when only the
        // live subtree moves. Validate each active edge, not the starting row
        // against every ancestor, and keep tombstones unchanged for recovery.
        if (parentField === "parent_id" && cursor.deleted_at === null && parent) {
          if (parent.workspace_id !== cursor.workspace_id) throw new Error(`节点父级冲突：「${cursor.title}」的父级属于其他工作区`);
          if (parent.deleted_at !== null) throw new Error(`节点父级冲突：「${cursor.title}」的父级已删除`);
        }
        cursor = parent;
      }
      for (const id of seen) validated.add(id);
    }
  }
}
