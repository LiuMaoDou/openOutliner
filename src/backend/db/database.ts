import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type OpenOutlinerDb = DatabaseSync;

export function getDefaultDbPath(): string {
  return process.env.OPENOUTLINER_DB ?? resolve(process.cwd(), "data", "openoutliner.sqlite");
}

export function openDatabase(dbPath = getDefaultDbPath()): OpenOutlinerDb {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON;");
  if (dbPath !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  migrate(db);
  return db;
}

function migrate(db: OpenOutlinerDb): void {
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
  ensureColumn(db, "workspaces", "position", "INTEGER NOT NULL DEFAULT 0");
  normalizeWorkspacePositions(db);
}

function normalizeWorkspacePositions(db: OpenOutlinerDb): void {
  const rows = db
    .prepare("SELECT id, folder_id FROM workspaces ORDER BY folder_id ASC, position ASC, created_at ASC")
    .all() as Array<{ id: unknown; folder_id: unknown }>;
  const positions = new Map<string, number>();
  const update = db.prepare("UPDATE workspaces SET position = ? WHERE id = ?");

  for (const row of rows) {
    const folderKey = row.folder_id === null ? "root" : String(row.folder_id);
    const position = positions.get(folderKey) ?? 0;
    positions.set(folderKey, position + 1);
    update.run(position, row.id);
  }
}

function ensureColumn(db: OpenOutlinerDb, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: unknown }>;
  if (columns.some(row => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}
