import initSqlJs, { type Database, type SqlJsStatic, type SqlValue as BrowserValue } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { SqlDatabase, SqlValue } from "../backend/shared/sql.js";
let runtime: Promise<SqlJsStatic> | undefined;
export async function openLocal(bytes?: Uint8Array): Promise<{ db: Database; sql: SqlDatabase }> {
  const SQL = await (runtime ??= initSqlJs({ locateFile: () => wasmUrl }));
  const db = new SQL.Database(bytes);
  db.run("PRAGMA foreign_keys = ON;");
  const query = (sql: string, values: SqlValue[]) => {
    const statement = db.prepare(sql);
    try {
      statement.bind(values.map(value => typeof value === "bigint" ? Number(value) : value) as BrowserValue[]);
      const rows: Record<string, unknown>[] = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally { statement.free(); }
  };
  return { db, sql: { exec: sql => db.run(sql), prepare: sql => ({
    all: (...values) => query(sql, values), get: (...values) => query(sql, values)[0], run: (...values) => query(sql, values)
  }) } };
}
