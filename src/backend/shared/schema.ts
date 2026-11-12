import type { SqlDatabase } from "./sql.js";

export const SCHEMA_VERSION = 1;

/** Version zero is the historical, unversioned schema. Never downgrade a newer database. */
export function migrate(db: SqlDatabase): boolean {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) {
    throw new Error("Database schema is newer than this application. Update the app; do not clear local data.");
  }
  if (version === SCHEMA_VERSION) return false;
  db.exec("SAVEPOINT upgrade_schema;");
  try {
    migrateUnversioned(db);
    if (db.prepare("PRAGMA foreign_key_check").all().length) {
      throw new Error("Schema upgrade found inconsistent references. Original data has been retained.");
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; RELEASE upgrade_schema;`);
    return true;
  } catch (error) {
    db.exec("ROLLBACK TO upgrade_schema; RELEASE upgrade_schema;");
    throw error;
  }
}

function migrateUnversioned(db: SqlDatabase): void {
  const hadPosition = db.prepare("PRAGMA table_info(workspaces)").all().some(row => row.name === "position");
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_folders (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL DEFAULT 'folder-tree',
      folder_id TEXT REFERENCES workspace_folders(id) ON DELETE SET NULL,
      parent_workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
      position INTEGER NOT NULL DEFAULT 0,
      root_node_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      due_date TEXT,
      done INTEGER NOT NULL DEFAULT 0,
      collapsed INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_nodes_workspace_parent
      ON nodes(workspace_id, parent_id, position);

    CREATE INDEX IF NOT EXISTS idx_nodes_search
      ON nodes(workspace_id, title, body);

    CREATE TABLE IF NOT EXISTS outline_history (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      before_snapshot TEXT NOT NULL,
      after_snapshot TEXT NOT NULL,
      coalesce_key TEXT,
      undone INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_outline_history_workspace_state
      ON outline_history(workspace_id, undone, seq);

    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(workspace_id, name)
    );

    CREATE TABLE IF NOT EXISTS node_tags (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY(node_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS field_definitions (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
      tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('text', 'number', 'date', 'checkbox', 'select')),
      options TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(tag_id, name)
    );

    CREATE TABLE IF NOT EXISTS field_values (
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      field_id TEXT NOT NULL REFERENCES field_definitions(id) ON DELETE CASCADE,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(node_id, field_id)
    );
  `);
  ensureColumn(db, "workspaces", "icon", "TEXT NOT NULL DEFAULT 'folder-tree'");
  ensureColumn(db, "workspaces", "folder_id", "TEXT REFERENCES workspace_folders(id) ON DELETE SET NULL");
  ensureColumn(db, "workspaces", "parent_workspace_id", "TEXT REFERENCES workspaces(id) ON DELETE SET NULL");
  ensureColumn(db, "workspaces", "position", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "nodes", "due_date", "TEXT");
  ensureColumn(db, "nodes", "deleted_at", "TEXT");
  // Existing positions are user data. Only assign positions to schemas that lacked them.
  if (!hadPosition) normalizeWorkspacePositions(db);
}

function normalizeWorkspacePositions(db: SqlDatabase): void {
  const rows = db
    .prepare("SELECT id, folder_id, parent_workspace_id FROM workspaces ORDER BY parent_workspace_id ASC, folder_id ASC, position ASC, created_at ASC, id ASC")
    .all() as Array<{ id: unknown; folder_id: unknown; parent_workspace_id: unknown }>;
  const positions = new Map<string, number>();
  const update = db.prepare("UPDATE workspaces SET position = ? WHERE id = ?");

  for (const row of rows) {
    const containerKey = row.parent_workspace_id === null
      ? row.folder_id === null ? "root" : `folder:${String(row.folder_id)}`
      : `workspace:${String(row.parent_workspace_id)}`;
    const position = positions.get(containerKey) ?? 0;
    positions.set(containerKey, position + 1);
    update.run(position, String(row.id));
  }
}

function ensureColumn(db: SqlDatabase, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: unknown }>;
  if (columns.some(row => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}
