import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/backend/db/database.js";
import { OutlinerService } from "../src/backend/services/outliner.js";
import { SyncService } from "../src/backend/services/sync.js";
import { applySnapshotChanges, changesBetween, snapshot } from "../src/backend/shared/sync.js";
import { applyExactDelta, canonicalSnapshot, decodeEnvelope, RevisionWindow } from "../src/backend/shared/syncProtocol.js";

const digest = async (value: string) => createHash("sha256").update(value).digest("hex");

describe("incremental sync", () => {
  it("returns a verified delta for a known revision and an empty delta when unchanged", async () => {
    const db = openDatabase(":memory:");
    try {
      const service = new OutlinerService(db), sync = new SyncService(db);
      const ws = service.ensureTodayWorkspace();
      const node = service.createNode({ parentId: ws.rootNodeId, title: "old" });
      for (let i = 0; i < 12; i++) service.createNode({ parentId: ws.rootNodeId, title: "unchanged " + i });
      const base = sync.pull();
      expect(sync.incremental(base).version).toBe(1);
      service.updateNode(node.id, { title: "new" });
      const next = sync.pull(), delta = sync.incremental(next, base.revision);
      expect(delta.version).toBe(2);
      expect(await decodeEnvelope(delta, base.data, base.revision, digest)).toMatchObject({ revision: next.revision });
      if (delta.version !== 2) throw new Error("expected delta");
      expect(changesBetween(applyExactDelta(base.data, delta.changes), next.data)).toEqual([]);
      expect(sync.incremental(next, next.revision)).toMatchObject({ version: 2, changes: [] });
      expect(new SyncService(db).incremental(next, base.revision).version).toBe(1);
      await expect(decodeEnvelope({ ...delta, revision: "bad" }, base.data, base.revision, digest)).rejects.toThrow("checksum");
      expect(() => applyExactDelta(next.data, delta.changes)).toThrow("baseline");
    } finally { db.close(); }
  });

  it("applies a title change without rebuilding tables and rolls back invalid data", () => {
    const db = openDatabase(":memory:");
    try {
      const service = new OutlinerService(db);
      const ws = service.ensureTodayWorkspace(), node = service.createNode({ parentId: ws.rootNodeId, title: "old" });
      const base = snapshot(db), target = structuredClone(base);
      target.nodes.find(row => row.id === node.id)!.title = "new";
      const statements: string[] = [];
      applySnapshotChanges({ exec: sql => { statements.push(sql); db.exec(sql); }, prepare: sql => { statements.push(sql); return db.prepare(sql); } }, base, target);
      expect(snapshot(db)).toEqual(target);
      expect(statements.some(sql => sql === "DELETE FROM nodes;")).toBe(false);
      const invalid = structuredClone(target);
      invalid.nodes.find(row => row.id === node.id)!.parent_id = null;
      expect(() => applySnapshotChanges(db, target, invalid)).toThrow("孤立节点");
      expect(snapshot(db)).toEqual(target);
    } finally { db.close(); }
  });

  it("expires old checkpoints and forgets physically removed records", async () => {
    const db = openDatabase(":memory:");
    try {
      const service = new OutlinerService(db), sync = new SyncService(db);
      const ws = service.ensureTodayWorkspace(), node = service.createNode({ parentId: ws.rootNodeId, title: "old" });
      const window = new RevisionWindow(1024 * 1024, 3, 100);
      const base = sync.pull();
      window.response(base, undefined, 0);
      service.updateNode(node.id, { title: "new" });
      const next = sync.pull();
      expect(window.response(next, base.revision, 101).version).toBe(1);
      service.deleteNode(node.id); service.emptyRecycleBin();
      const removed = sync.pull();
      expect(window.response(removed, next.revision, 102).version).toBe(1);
      expect(await digest(canonicalSnapshot(removed.data))).toBe(removed.revision);
    } finally { db.close(); }
  });
});
