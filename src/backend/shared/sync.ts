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

function remapMetadataRow(table: Table, row: Row | null, tags: Map<Row["id"], Row>, fields: Map<Row["id"], Row>): Row | null {
  if (!row) return null;
  if (table === "tags" || table === "field_definitions") {
    const replacement = (table === "tags" ? tags : fields).get(row.id);
    if (replacement) return { ...row, id: replacement.id, ...(table === "field_definitions" ? { tag_id: replacement.tag_id } : {}), created_at: replacement.created_at };
  }
  if (table === "node_tags" || table === "field_definitions") {
    const tag = tags.get(row.tag_id);
    if (tag) return { ...row, tag_id: tag.id };
  }
  if (table === "field_values") {
    const field = fields.get(row.field_id);
    if (field) return { ...row, field_id: field.id };
  }
  return row;
}

/** Two replicas can create the same named tag or field while offline. Keep the
 * stored IDs and rewrite the new replica's references through the merge. */
function coalesceMetadataChanges(current: Snapshot, changes: readonly Change[], acknowledged: readonly Change[]): readonly Change[] {
  const additions = [...acknowledged, ...changes].filter(change => !change.before && change.after &&
    (change.table === "tags" || change.table === "field_definitions"));
  if (!additions.length) return changes;
  const aliases = new Map<Row["id"], Row>(), fieldAliases = new Map<Row["id"], Row>();
  const conflicts: string[] = [];
  for (const [table, parent, replacements, properties] of [
    ["tags", "workspace_id", aliases, ["color"]],
    ["field_definitions", "tag_id", fieldAliases, ["workspace_id", "type", "options"]]
  ] as const) {
    const existingIds = new Set(current[table].map(row => row.id));
    // A deliberate rename or deletion in the batch must retain its own identity.
    const changedKeys = new Set(changes.filter(change => change.table === table && change.before).map(change => change.key));
    const byName = new Map(current[table].filter(row => !changedKeys.has(rowKey(table, row)))
      .map(row => [JSON.stringify([row[parent], row.name]), row]));
    for (const change of additions) {
      if (change.table !== table || !change.after || existingIds.has(change.after.id)) continue;
      const row = remapMetadataRow(table, change.after, aliases, fieldAliases)!;
      const existing = byName.get(JSON.stringify([row[parent], row.name]));
      if (!existing) continue;
      const differences = properties.filter(property => row[property] !== existing[property]);
      if (differences.length) conflicts.push(`${table}: ${String(row.name)} (${differences.join(", ")})`);
      else replacements.set(change.after.id, existing);
    }
  }
  if (conflicts.length) throw new SyncConflict(current, conflicts);
  if (!aliases.size && !fieldAliases.size) return changes;
  return changes.flatMap(change => {
    const before = remapMetadataRow(change.table, change.before, aliases, fieldAliases);
    const after = remapMetadataRow(change.table, change.after, aliases, fieldAliases);
    if (before === change.before && after === change.after) return [change];
    if (!change.before && change.after && after?.id !== change.after.id) return [];
    return [{ ...change, key: rowKey(change.table, (after ?? before)!), before, after }];
  });
}

function activeParent(row: Row | null | undefined): string | undefined {
  return row?.deleted_at === null && typeof row.parent_id === "string" ? row.parent_id : undefined;
}

function equalExceptPositionAndTimestamp(left: Row, right: Row): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length &&
    keys.every(key => key === "position" || key === "updated_at" || left[key] === right[key]);
}

function countPositionsBefore(positions: number[], position: number): number {
  let first = 0, last = positions.length;
  while (first < last) {
    const middle = Math.floor((first + last) / 2);
    if (positions[middle] < position) first = middle + 1;
    else last = middle;
  }
  return first;
}

function compareText(left: Row[string], right: Row[string]): number {
  const a = String(left), b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeInsertedSiblings(nodes: Row[], parents: Set<string>): void {
  if (!parents.size) return;
  const siblings = new Map<string, Row[]>();
  for (const row of nodes) {
    const parent = activeParent(row);
    if (parent === undefined || !parents.has(parent)) continue;
    const group = siblings.get(parent);
    if (group) group.push(row); else siblings.set(parent, [row]);
  }
  for (const group of siblings.values()) {
    // Leave existing gaps alone unless concurrent additions collide.
    if (new Set(group.map(row => row.position)).size === group.length) continue;
    group.sort((a, b) => Number(a.position) - Number(b.position) ||
      compareText(a.created_at, b.created_at) || compareText(a.id, b.id));
    group.forEach((row, position) => { row.position = position; });
  }
}

// Merge different fields independently; never silently overwrite the same field.
export function mergeChanges(current: Snapshot, incoming: readonly Change[], acknowledged: readonly Change[] = []): Snapshot {
  const changes = coalesceMetadataChanges(current, incoming, acknowledged);
  const result = structuredClone(current);
  const insertedParents = new Set<string>();
  const replayedInsertions = new Map<string, number[]>();
  if (changes.some(change => change.table === "nodes" && !change.before && activeParent(change.after) !== undefined)) {
    const nodes = new Map(result.nodes.map(row => [rowKey("nodes", row), row]));
    for (const change of changes) {
      if (change.table !== "nodes" || change.before || !change.after) continue;
      const parent = activeParent(change.after), remote = nodes.get(change.key);
      if (parent === undefined) continue;
      if (!remote) insertedParents.add(parent);
      else if (equalExceptPositionAndTimestamp(remote, change.after)) {
        const positions = replayedInsertions.get(parent) ?? [];
        positions.push(Number(change.after.position));
        replayedInsertions.set(parent, positions);
      }
    }
    for (const positions of replayedInsertions.values()) positions.sort((a, b) => a - b);
  }
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
    if (remote && change.after) {
      if (change.table === "field_values" && !change.before && remote.value === change.after.value) continue;
      if (change.table === "nodes") {
        const parent = activeParent(change.after), beforeParent = activeParent(change.before);
        const replayed = parent === undefined ? undefined : replayedInsertions.get(parent);
        // A retry may have stale positions after the server made simultaneous inserts contiguous.
        if (replayed && equalExceptPositionAndTimestamp(remote, change.after)) {
          const position = Number(change.after.position);
          if (!change.before || (beforeParent === parent && Number(change.before.position) +
            countPositionsBefore(replayed, position) === position)) continue;
        }
      }
    }
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
    else rows.set(change.key, { ...merged });
  }
  if (conflicts.length) throw new SyncConflict(current, conflicts);
  for (const [table, rows] of indexed) result[table] = [...rows.values()];
  normalizeInsertedSiblings(result.nodes, insertedParents);
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
/** Apply common row additions/updates without deleting and reinserting the
 * whole database. Complex physical deletes or constraint-order collisions
 * use the existing checked, atomic snapshot replacement instead. */
export function applySnapshotChanges(db: SqlDatabase, current: Snapshot, target: Snapshot): void {
  const changes = changesBetween(current, target);
  if (!changes.length) return;
  if (changes.some(change => change.after === null)) { replaceSnapshot(db, target); return; }
  validateTrees(target);
  db.exec("SAVEPOINT apply_snapshot_changes; PRAGMA defer_foreign_keys = ON;");
  try {
    db.exec("DELETE FROM outline_history;");
    for (const table of tables) {
      const affected = changes.filter(change => change.table === table);
      if (!affected.length) continue;
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name));
      const keys = table === "node_tags" ? ["node_id", "tag_id"] : table === "field_values" ? ["node_id", "field_id"] : ["id"];
      const insert = db.prepare(`INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
      const mutable = columns.filter(column => !keys.includes(column));
      const update = mutable.length ? db.prepare(`UPDATE ${table} SET ${mutable.map(column => column + " = ?").join(",")} WHERE ${keys.map(column => column + " = ?").join(" AND ")}`) : undefined;
      for (const change of affected) {
        const row = change.after!;
        if (Object.keys(row).length !== columns.length || columns.some(column => !(column in row))) throw new Error("Invalid snapshot columns");
        if (change.before === null) insert.run(...columns.map(column => row[column] as SqlValue));
        else if (update) update.run(...[...mutable, ...keys].map(column => row[column] as SqlValue));
      }
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length ||
        changesBetween(snapshot(db), target).length) throw new Error("Incremental snapshot mismatch");
    db.exec("RELEASE apply_snapshot_changes;");
  } catch {
    db.exec("ROLLBACK TO apply_snapshot_changes; RELEASE apply_snapshot_changes;");
    replaceSnapshot(db, target);
  }
}

export function validateTrees(data: Snapshot): void {
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
