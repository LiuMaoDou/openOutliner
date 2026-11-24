import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/backend/db/database.js";
import { OutlinerService } from "../src/backend/services/outliner.js";
import { SyncService } from "../src/backend/services/sync.js";
import { changesBetween, mergeChanges, replaceSnapshot, snapshot, SyncConflict } from "../src/backend/shared/sync.js";
import { AUTOMATIC_SYNC_BACKUP_LIMIT, backupBeforeSync, incomingRemovalConflicts, type SnapshotBackup } from "../src/backend/shared/syncSafety.js";
import { computeVisibleIds, fromNestedTree } from "../src/web/flatTree.js";

function fixture() {
  const db = openDatabase(":memory:");
  const service = new OutlinerService(db);
  const today = service.ensureTodayWorkspace();
  const task = service.createNode({ parentId: today.rootNodeId, title: "Keep this task" });
  return { db, service, today, task };
}

describe("data integrity and recovery", () => {
  it("pauses on a rolled-back cloud snapshot that lost acknowledged Today nodes", () => {
    const { db, service, task } = fixture();
    try {
      const current = snapshot(db), stale = structuredClone(current);
      stale.nodes = stale.nodes.filter(row => row.id !== task.id);
      expect(changesBetween(current, current)).toEqual([]);
      expect(incomingRemovalConflicts(current, stale)).toEqual(expect.arrayContaining([expect.stringContaining("Keep this task")]));
      service.deleteNode(task.id);
      expect(incomingRemovalConflicts(current, snapshot(db))).toEqual([]);
      const deleted = snapshot(db);
      service.emptyRecycleBin();
      expect(incomingRemovalConflicts(deleted, snapshot(db))).toEqual([]);
    } finally { db.close(); }
  });

  it("keeps the latest automatic backups without pruning explicit recovery copies", () => {
    const { db, service, task } = fixture();
    try {
      const original = snapshot(db);
      let backups: SnapshotBackup[] = [{ date: "explicit", data: original }];
      for (let i = 0; i < 5; i++) {
        service.updateNode(task.id, { title: String(i) });
        backups = backupBeforeSync(backups, snapshot(db), String(i));
      }
      expect(backups.filter(item => item.kind === "sync")).toHaveLength(AUTOMATIC_SYNC_BACKUP_LIMIT);
      expect(backups.map(item => item.date)).toEqual(["explicit", "2", "3", "4"]);
      expect(backups[0].data).toEqual(original);
    } finally { db.close(); }
  });

  it("rejects concurrent deletion and content edits in both directions", () => {
    const { db, service, task } = fixture();
    try {
      const base = snapshot(db), edited = structuredClone(base);
      edited.nodes.find(row => row.id === task.id)!.title = "Offline edit";
      service.deleteNode(task.id);
      const deleted = snapshot(db);
      expect(() => mergeChanges(deleted, changesBetween(base, edited))).toThrow(SyncConflict);
      expect(() => mergeChanges(edited, changesBetween(base, deleted))).toThrow(SyncConflict);
      expect(snapshot(db)).toEqual(deleted);
    } finally { db.close(); }
  });

  it("rejects a second live root and rolls back the replacement", () => {
    const { db, task } = fixture();
    try {
      const base = snapshot(db), invalid = structuredClone(base);
      invalid.nodes.find(row => row.id === task.id)!.parent_id = null;
      expect(() => replaceSnapshot(db, invalid)).toThrow("孤立节点");
      expect(snapshot(db)).toEqual(base);
    } finally { db.close(); }
  });

  it("does not allow sync to remove the system Today workspace", () => {
    const { db, today } = fixture();
    try {
      const base = snapshot(db), invalid = structuredClone(base);
      invalid.workspaces = invalid.workspaces.filter(row => row.id !== today.id);
      invalid.nodes = invalid.nodes.filter(row => row.workspace_id !== today.id);
      expect(incomingRemovalConflicts(base, invalid)).toEqual(expect.arrayContaining([expect.stringContaining("Today")]));
      expect(() => new SyncService(db).push({ changes: changesBetween(base, invalid) })).toThrow(SyncConflict);
      expect(snapshot(db)).toEqual(base);
    } finally { db.close(); }
  });

  it("shows children even if a legacy workspace root was collapsed", () => {
    const { db, service, today, task } = fixture();
    try {
      db.prepare("UPDATE nodes SET collapsed = 1 WHERE id = ?").run(today.rootNodeId);
      const loaded = fromNestedTree(service.getTree(today.rootNodeId));
      expect(loaded.visibleIds).toEqual([task.id]);
      expect(computeVisibleIds(loaded.state)).toEqual(loaded.visibleIds);
      expect(() => service.updateNode(today.rootNodeId, { collapsed: true })).toThrow("cannot be collapsed");
    } finally { db.close(); }
  });

  it("rejects impossible dates while retaining leap days", () => {
    const { db, service, task } = fixture();
    try {
      expect(() => service.updateNode(task.id, { dueDate: "2026-02-30" })).toThrow("YYYY-MM-DD");
      expect(() => service.updateNode(task.id, { dueDate: "2026-04-31" })).toThrow("YYYY-MM-DD");
      expect(service.updateNode(task.id, { dueDate: "2028-02-29" }).dueDate).toBe("2028-02-29");
    } finally { db.close(); }
  });

  it("rejects cross-workspace field definitions and values in direct writes and snapshots", () => {
    const { db, service, today, task } = fixture();
    try {
      const other = service.createWorkspace("Other");
      const tag = service.createTag(other.id, "Status");
      expect(() => service.createFieldDefinition({ workspaceId: today.id, tagId: tag.id, name: "State", type: "text" })).toThrow("selected workspace");
      const field = service.createFieldDefinition({ workspaceId: other.id, tagId: tag.id, name: "State", type: "text" });
      expect(() => service.setFieldValue(task.id, field.id, "Invalid")).toThrow("node workspace");
      const base = snapshot(db), invalid = structuredClone(base);
      invalid.field_values.push({ node_id: task.id, field_id: field.id, value: "Invalid", updated_at: "2026-11-24T00:00:00.000Z" });
      expect(() => replaceSnapshot(db, invalid)).toThrow("节点与字段");
      expect(snapshot(db)).toEqual(base);
    } finally { db.close(); }
  });
});
