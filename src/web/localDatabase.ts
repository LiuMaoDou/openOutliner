import initSqlJs, { type Database, type SqlJsStatic, type SqlValue as BrowserValue } from "sql.js";
import wasmUrl from "sql.js/dist/sql-wasm.wasm?url";
import type { SqlDatabase, SqlValue } from "../backend/shared/sql.js";
import { migrate } from "../backend/shared/schema.js";
let runtime: Promise<SqlJsStatic> | undefined;

async function loadRuntime() {
  // sql.js memoizes its own initializer, including failures. Fetch and validate before calling it.
  const response = await fetch(wasmUrl, { signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error(`无法加载本机数据库模块 (${response.status})。`);
  const wasmBinary = await response.arrayBuffer();
  if (!WebAssembly.validate(wasmBinary)) throw new Error("本机数据库模块无效。");
  return initSqlJs({ wasmBinary });
}

export async function openLocal(bytes?: Uint8Array): Promise<{ db: Database; sql: SqlDatabase }> {
  const SQL = await (runtime ??= loadRuntime().catch(error => {
    runtime = undefined;
    throw error;
  }));
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
  const sql: SqlDatabase = { exec: sql => { db.run(sql); }, prepare: sql => ({
    all: (...values) => query(sql, values), get: (...values) => query(sql, values)[0], run: (...values) => query(sql, values)
  }) };
  try {
    migrate(sql);
    return { db, sql };
  } catch (error) {
    db.close();
    throw error;
  }
}
