import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/backend/db/database.js";
import { NotFoundError, OutlinerService } from "../src/backend/services/outliner.js";
import { CreationJournal, replayCreation } from "../src/web/creationJournal.js";

function storage() {
  const data = new Map<string, string>();
  return { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); } };
}

describe("durable node creation", () => {
  it("keeps staged creation attachments hidden until their restore commits", () => {
    const disk = storage(), id = crypto.randomUUID();
    const committed = new Set<string>();
    const source = new CreationJournal(disk, "active");
    source.begin(id, "parent", 0, "Original");
    const intent = source.get(id)!;
    const recovered = new CreationJournal(disk, "other-tab", restoreId => committed.has(restoreId));
    recovered.restore([intent], "committed");
    recovered.restore([intent], "failed");
    expect(recovered.list()).toEqual([intent]);
    committed.add("committed");
    expect(recovered.list()).toHaveLength(2);
    expect(recovered.list().some(entry => entry.restoreId === "failed")).toBe(false);
    recovered.discardRestore("failed");
    expect(disk.length).toBe(2);
  });

  it("replays typing before the initial create completed and does not duplicate a reserved id", () => {
    const db = openDatabase(":memory:");
    try {
      const service = new OutlinerService(db), ws = service.ensureTodayWorkspace();
      const disk = storage(), id = crypto.randomUUID();
      const beforeCrash = new CreationJournal(disk, "tab");
      beforeCrash.begin(id, ws.rootNodeId, 0, "");
      beforeCrash.stage(id, { title: "Uncommitted title", body: "Uncommitted note" });
      const reopened = new CreationJournal(disk, "tab");
      const intent = reopened.get(id)!;
      const missing = (error: unknown) => error instanceof NotFoundError;
      replayCreation(intent, service, missing);
      replayCreation(intent, service, missing);
      expect(service.getTree(ws.rootNodeId).children).toMatchObject([{ id, title: "Uncommitted title", body: "Uncommitted note" }]);
      expect(service.createNode({ id, parentId: ws.rootNodeId, title: "" }).id).toBe(id);
      reopened.acknowledge(intent);
      expect(reopened.list()).toEqual([]);
    } finally { db.close(); }
  });
  it("preserves a conflict instead of overwriting an independently edited node", () => {
    const db = openDatabase(":memory:");
    try {
      const service = new OutlinerService(db), ws = service.ensureTodayWorkspace();
      const disk = storage(), id = crypto.randomUUID(), journal = new CreationJournal(disk, "tab");
      journal.begin(id, ws.rootNodeId, 0, "");
      journal.stage(id, { title: "draft" });
      service.createNode({ id, parentId: ws.rootNodeId, title: "other edit" });
      expect(() => replayCreation(journal.get(id)!, service, error => error instanceof NotFoundError)).toThrow("冲突");
      expect(journal.get(id)?.title).toBe("draft");
      expect(service.getNode(id).title).toBe("other edit");
    } finally { db.close(); }
  });
  it("does not recreate a cancelled or tombstoned node", () => {
    const db = openDatabase(":memory:");
    try {
      const service = new OutlinerService(db), ws = service.ensureTodayWorkspace();
      const id = crypto.randomUUID(), journal = new CreationJournal(storage(), "tab");
      journal.begin(id, ws.rootNodeId, 0, "");
      journal.stage(id, { cancelled: true });
      replayCreation(journal.get(id)!, service, error => error instanceof NotFoundError);
      expect(service.getTree(ws.rootNodeId).children).toEqual([]);
      service.createNode({ id, parentId: ws.rootNodeId, title: "" });
      service.deleteNode(id);
      expect(() => service.createNode({ id, parentId: ws.rootNodeId, title: "" })).toThrow("no longer available");
    } finally { db.close(); }
  });
});
