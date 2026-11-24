import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SyncUploadStore } from "../src/backend/server/syncUploads.js";
import { SyncService } from "../src/backend/services/sync.js";
import { openDatabase } from "../src/backend/db/database.js";
import { OutlinerService } from "../src/backend/services/outliner.js";
import { changesBetween, snapshot } from "../src/backend/shared/sync.js";
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("atomic staged synchronization", () => {
  it("does not change the database until a complete, verified upload is committed", () => {
    const db = openDatabase(":memory:"), uploads = new SyncUploadStore();
    try {
      const service = new OutlinerService(db), ws = service.ensureTodayWorkspace();
      const node = service.createNode({ parentId: ws.rootNodeId, title: "Before" });
      const base = snapshot(db), after = structuredClone(base);
      after.nodes.find(row => row.id === node.id)!.title = "After";
      const data = Buffer.from(JSON.stringify({ changes: changesBetween(base, after) }));
      const { id } = uploads.start({ bytes: data.length, digest: digest(data) });
      const middle = Math.floor(data.length / 2);
      uploads.append(id, 0, data.subarray(0, middle));
      expect(snapshot(db)).toEqual(base);
      expect(() => uploads.append(id, 2, data.subarray(middle))).toThrow("out-of-order");
      uploads.append(id, 1, data.subarray(middle));
      const payload = uploads.finish(id);
      expect(snapshot(db)).toEqual(base);
      new SyncService(db).push(payload);
      expect(service.getNode(node.id).title).toBe("After");
      expect(() => uploads.finish(id)).toThrow("not found");
    } finally { uploads.dispose(); db.close(); }
  });
  it("rejects partial data, corrupt checksums, and cancelled transfers", () => {
    const uploads = new SyncUploadStore();
    try {
      const data = Buffer.from('{"changes":[]}');
      const partial = uploads.start({ bytes: data.length, digest: digest(data) }).id;
      uploads.append(partial, 0, data.subarray(0, 4));
      expect(() => uploads.finish(partial)).toThrow("Incomplete");
      const corrupt = uploads.start({ bytes: data.length, digest: "0".repeat(64) }).id;
      uploads.append(corrupt, 0, data);
      expect(() => uploads.finish(corrupt)).toThrow("checksum");
      const cancel = uploads.start({ bytes: data.length, digest: digest(data) }).id;
      uploads.abort(cancel);
      expect(() => uploads.append(cancel, 0, data)).toThrow("expired");
    } finally { uploads.dispose(); }
  });
});
