import { migrate } from "../shared/schema.js";
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
