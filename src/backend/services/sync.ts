import { createHash } from "node:crypto";
import { z } from "zod";
import { removesToday } from "../shared/syncSafety.js";
import { canonicalSnapshot, RevisionWindow, type FullEnvelope } from "../shared/syncProtocol.js";
import type { SqlDatabase } from "../shared/sql.js";
import { MAX_SYNC_CHANGES } from "../shared/uploadLimits.js";
import { tables, rowKey, snapshot, mergeChanges, applySnapshotChanges, SyncConflict, type Change, type Table } from "../shared/sync.js";

const row = z.record(z.string(), z.union([z.string(), z.number().finite(), z.null()]));
const payload = z.object({ changes: z.array(z.object({ table: z.enum(tables), key: z.string(), before: row.nullable(), after: row.nullable() })).max(MAX_SYNC_CHANGES) });
export class SyncService {
  private revisions = new RevisionWindow();
  constructor(private db: SqlDatabase) {}
  pull(): FullEnvelope {
    this.db.exec("SAVEPOINT sync_pull");
    let data: ReturnType<typeof snapshot>;
    try {
      data = snapshot(this.db);
      this.db.exec("RELEASE sync_pull");
    } catch (error) {
      this.db.exec("ROLLBACK TO sync_pull; RELEASE sync_pull");
      throw error;
    }
    return { version: 1, revision: createHash("sha256").update(canonicalSnapshot(data)).digest("hex"), data };
  }
  incremental(full: FullEnvelope, baseRevision?: string | null) {
    return this.revisions.response(full, baseRevision);
  }
  push(input: unknown) {
    const { changes } = payload.parse(input);
    const columnsByTable = new Map<Table, string[]>();
    for (const change of changes) {
      let columns = columnsByTable.get(change.table);
      if (!columns) {
        columns = this.db.prepare(`PRAGMA table_info(${change.table})`).all().map(column => String(column.name));
        columnsByTable.set(change.table, columns);
      }
      for (const value of [change.before, change.after]) {
        if (value && (rowKey(change.table, value) !== change.key || Object.keys(value).length !== columns.length || columns.some(key => !(key in value)))) throw new Error("同步数据结构不匹配，请刷新应用。");
      }
    }
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const current = snapshot(this.db);
      const merged = mergeChanges(current, changes as Change[]);
      if (removesToday(current, merged)) throw new SyncConflict(current, ["系统 Today 工作区不能通过同步删除。请保留 Today 或恢复缺失的节点。"]);
      try { applySnapshotChanges(this.db, current, merged); }
      catch (error) { throw new SyncConflict(current, [error instanceof Error ? error.message : "数据关联冲突"]); }
      const result = this.pull();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) { this.db.exec("ROLLBACK;"); throw error; }
  }
}
