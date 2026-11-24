import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/backend/db/database.js";
import { OutlinerService } from "../src/backend/services/outliner.js";
import { exportNativeArchive, restoreNativeArchive } from "../src/backend/importExport/nativeArchive.js";
import { snapshot } from "../src/backend/shared/sync.js";

describe("native lossless archives", () => {
  it("round-trips system IDs, hierarchy, tags, fields, tombstones and undo history", () => {
    const source = openDatabase(":memory:"), dest = openDatabase(":memory:");
    try {
      const service = new OutlinerService(source);
      const today = service.ensureTodayWorkspace(), ws = service.createWorkspace("Nested", "book-open", null, today.id);
      const node = service.createNode({ parentId: ws.rootNodeId, title: "Note", body: "Unicode 中文" });
      service.updateNode(node.id, { dueDate: "2026-11-24", done: true });
      const tag = service.createTag(ws.id, "Status", "#123456");
      service.setNodeTag(node.id, tag.name);
      const field = service.createFieldDefinition({ workspaceId: ws.id, tagId: tag.id, name: "Value", type: "text" });
      service.setFieldValue(node.id, field.id, "exact");
      const deleted = service.createNode({ parentId: ws.rootNodeId, title: "Recycle me" });
      service.deleteNode(deleted.id);
      const archive = exportNativeArchive(source);
      restoreNativeArchive(dest, JSON.parse(JSON.stringify(archive)));
      expect(exportNativeArchive(dest)).toEqual(archive);
      expect(new OutlinerService(dest).getOutlineHistoryState(ws.id).canUndo).toBe(true);
      expect(new OutlinerService(dest).listRecycleBin().map(row => row.node.id)).toContain(deleted.id);
    } finally { source.close(); dest.close(); }
  });
  it("rejects malformed history and leaves the destination unchanged", () => {
    const db = openDatabase(":memory:");
    try {
      const service = new OutlinerService(db), ws = service.ensureTodayWorkspace();
      service.createNode({ parentId: ws.rootNodeId, title: "Keep" });
      const before = exportNativeArchive(db), bad = structuredClone(before);
      bad.outlineHistory![0].before_snapshot = "{broken";
      expect(() => restoreNativeArchive(db, bad)).toThrow("Invalid outline history");
      expect(exportNativeArchive(db)).toEqual(before);
    } finally { db.close(); }
  });
  it("accepts legacy v1 archives without undo history", () => {
    const db = openDatabase(":memory:");
    try {
      const service = new OutlinerService(db), ws = service.ensureTodayWorkspace();
      service.createNode({ parentId: ws.rootNodeId, title: "Keep" });
      const local = snapshot(db);
      restoreNativeArchive(db, { format: "openoutliner-recovery-v1", local });
      expect(snapshot(db)).toEqual(local);
      expect(service.getOutlineHistoryState(ws.id).canUndo).toBe(false);
    } finally { db.close(); }
  });
  it("restores historical fractional positions but rejects new ones", () => {
    const source = openDatabase(":memory:"), dest = openDatabase(":memory:");
    try {
      const service = new OutlinerService(source), ws = service.createWorkspace("Legacy positions");
      const node = service.createNode({ parentId: ws.rootNodeId, title: "Existing" });
      expect(() => service.createNode({ parentId: ws.rootNodeId, title: "Invalid position", position: 0.5 })).toThrow("must be an integer");
      const archive = exportNativeArchive(source);
      archive.local.nodes.find(row => row.id === node.id)!.position = 0.5;
      const history = archive.outlineHistory!.at(-1)!;
      const after = JSON.parse(String(history.after_snapshot));
      after.nodes[node.id].position = 0.5;
      history.after_snapshot = JSON.stringify(after);
      restoreNativeArchive(dest, archive);
      expect(exportNativeArchive(dest)).toEqual(archive);
    } finally { source.close(); dest.close(); }
  });
});
