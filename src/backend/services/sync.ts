import { createHash } from "node:crypto";
import { z } from "zod";
import type { SqlDatabase } from "../shared/sql.js";
import { tables, rowKey, changesBetween, snapshot, mergeChanges, replaceSnapshot, SyncConflict, type Change } from "../shared/sync.js";

const row = z.record(z.string(), z.union([z.string(), z.number().finite(), z.null()]));
const payload = z.object({ changes: z.array(z.object({ table: z.enum(tables), key: z.string(), before: row.nullable(), after: row.nullable() })).max(100000) });
export class SyncService {
  constructor(private db: SqlDatabase) {}
  pull() {
    const data = snapshot(this.db);
    return { version: 1, revision: createHash("sha256").update(JSON.stringify(data)).digest("hex"), data };
  }
  push(input: unknown) {
    const { changes } = payload.parse(input);
    for (const change of changes) {
      const columns = this.db.prepare(`PRAGMA table_info(${change.table})`).all().map(column => String(column.name));
      for (const value of [change.before, change.after]) {
        if (value && (rowKey(change.table, value) !== change.key || Object.keys(value).length !== columns.length || columns.some(key => !(key in value)))) throw new Error("同步数据结构不匹配，请刷新应用。");
      }
    }
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const current = snapshot(this.db);
      const merged = mergeChanges(current, changes as Change[]);
      try { if (changesBetween(current, merged).length) replaceSnapshot(this.db, merged); }
      catch (error) { throw new SyncConflict(current, [error instanceof Error ? error.message : "数据关联冲突"]); }
      const result = this.pull();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) { this.db.exec("ROLLBACK;"); throw error; }
  }
}
