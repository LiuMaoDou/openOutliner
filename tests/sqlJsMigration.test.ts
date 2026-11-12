import { describe, expect, it } from "vitest";
import initSqlJs, { type Database, type SqlValue as BrowserValue } from "sql.js";
import type { SqlDatabase, SqlValue } from "../src/backend/shared/sql.js";
import { migrate, SCHEMA_VERSION } from "../src/backend/shared/schema.js";
import { snapshot } from "../src/backend/shared/sync.js";
import { upgradeStoredState } from "../src/backend/shared/storedState.js";

function adapter(db: Database): SqlDatabase {
  return { exec: sql => db.run(sql), prepare: sql => {
    const query = (...values: SqlValue[]) => {
      const statement = db.prepare(sql);
      try {
        statement.bind(values as BrowserValue[]);
        const rows: Record<string, unknown>[] = [];
        while (statement.step()) rows.push(statement.getAsObject());
        return rows;
      } finally { statement.free(); }
    };
    return { all: query, get: (...values) => query(...values)[0], run: query };
  } };
}

describe("migration using the browser's actual sql.js engine", () => {
  it("upgrades persisted old bytes, aligns the baseline, and survives a reopen", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    let reopened: Database | undefined;
    try {
      const sql = adapter(db);
      migrate(sql);
      sql.exec(`INSERT INTO workspaces (id,name,root_node_id,created_at,updated_at) VALUES ('w','Old','r','2026-01-01','2026-01-01');
        INSERT INTO nodes (id,workspace_id,title,body,created_at,updated_at) VALUES ('r','w','Old','Keep me','2026-01-01','2026-01-01');
        PRAGMA user_version=0; ALTER TABLE nodes DROP COLUMN due_date;`);
      const base = snapshot(sql), bytes = db.export();
      sql.exec("UPDATE nodes SET body='Pending edit' WHERE id='r'");
      migrate(sql);
      const upgraded = upgradeStoredState({ bytes, base, revision: "remote", backups: [] }, sql, db.export());
      reopened = new SQL.Database(upgraded.bytes);
      const next = adapter(reopened);
      expect(migrate(next)).toBe(false);
      expect(next.prepare("PRAGMA user_version").get()?.user_version).toBe(SCHEMA_VERSION);
      expect(next.prepare("SELECT body, due_date FROM nodes WHERE id='r'").get()).toEqual({ body: "Pending edit", due_date: null });
      expect(upgraded.base.nodes[0].body).toBe("Keep me");
      expect(upgraded.base.nodes[0].due_date).toBeNull();
    } finally { reopened?.close(); db.close(); }
  });
});
