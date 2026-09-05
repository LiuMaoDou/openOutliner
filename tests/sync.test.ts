import { describe, it, expect } from "vitest";
import { openDatabase } from "../src/backend/db/database.js";
import { OutlinerService } from "../src/backend/services/outliner.js";
import { SyncService } from "../src/backend/services/sync.js";
import { changesBetween, mergeChanges, snapshot, replaceSnapshot, SyncConflict } from "../src/backend/shared/sync.js";
import { dispatch } from "../src/backend/shared/dispatch.js";
import initSqlJs from "sql.js";
import { migrate } from "../src/backend/shared/schema.js";
import type { SqlDatabase } from "../src/backend/shared/sql.js";
function fixture() {
  const db = openDatabase(":memory:");
  const service = new OutlinerService(db);
  const workspace = service.createWorkspace("Sync test");
  const node = service.createNode({ parentId: workspace.rootNodeId, title: "Original" });
  return { db, service, workspace, node, sync: new SyncService(db) };
}
describe("offline sync", () => {
  it("imports deleted descendants after their live ancestor moved to another workspace", () => {
    const { db, service, node, sync } = fixture();
    const replica = openDatabase(":memory:");
    try {
      const removed = service.createNode({ parentId: node.id, title: "Deleted before move" });
      const nested = service.createNode({ parentId: removed.id, title: "Deleted nested child" });
      service.deleteNode(removed.id);
      const destination = service.createWorkspace("Destination");
      service.moveNodesToWorkspace([node.id], destination.id);
      const remote = sync.pull().data;
      // Historical tombstones retain their source workspace; no records may be lost.
      expect(() => replaceSnapshot(replica, remote)).not.toThrow();
      expect(snapshot(replica)).toEqual(remote);
      expect(remote.nodes.find(row => row.id === removed.id)!.deleted_at).not.toBeNull();
      expect(remote.nodes.find(row => row.id === nested.id)!.deleted_at).not.toBeNull();
      const local = new OutlinerService(replica);
      local.updateNode(node.id, { title: "Edited offline after first sync" });
      sync.push({ changes: changesBetween(remote, snapshot(replica)) });
      expect(service.getNode(node.id).title).toBe("Edited offline after first sync");
    } finally { replica.close(); db.close(); }
  });
  it("still rejects active nodes with cross-workspace parents and rolls back", () => {
    const { db, service, node } = fixture();
    try {
      const other = service.createWorkspace("Other");
      const before = snapshot(db), invalid = structuredClone(before);
      invalid.nodes.find(row => row.id === node.id)!.parent_id = other.rootNodeId;
      expect(() => replaceSnapshot(db, invalid)).toThrow("父级");
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(); }
  });
  it("still rejects an active child under a deleted parent", () => {
    const { db, service, node } = fixture();
    try {
      service.createNode({ parentId: node.id, title: "Active child" });
      const before = snapshot(db), invalid = structuredClone(before);
      invalid.nodes.find(row => row.id === node.id)!.deleted_at = new Date().toISOString();
      expect(() => replaceSnapshot(db, invalid)).toThrow("父级");
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(); }
  });
  it("merges independent fields and retains remote records", () => {
    const { db, service, node, workspace, sync } = fixture();
    try {
      const base = snapshot(db), local = structuredClone(base);
      local.nodes.find(row => row.id === node.id)!.title = "Offline title";
      service.updateNode(node.id, { body: "Remote body" });
      const remoteNode = service.createNode({ parentId: workspace.rootNodeId, title: "Remote addition" });
      const response = sync.push({ changes: changesBetween(base, local) });
      expect(service.getNode(node.id)).toMatchObject({ title: "Offline title", body: "Remote body" });
      expect(response.data.nodes.some(row => row.id === remoteNode.id)).toBe(true);
    } finally { db.close(); }
  });
  it("retries lost acknowledgements without duplicate rows or clearing history again", () => {
    const { db, service, workspace, sync } = fixture();
    try {
      const base = snapshot(db);
      const added = service.createNode({ parentId: workspace.rootNodeId, title: "Offline added" });
      const local = snapshot(db); replaceSnapshot(db, base);
      const request = { changes: changesBetween(base, local) };
      const first = sync.push(request);
      const second = sync.push(request);
      expect(second.revision).toBe(first.revision);
      expect(service.listChildren(workspace.rootNodeId).filter(row => row.id === added.id)).toHaveLength(1);
    } finally { db.close(); }
  });
  it("rejects same-field conflicts atomically with both versions available", () => {
    const { db, service, node, sync } = fixture();
    try {
      const base = snapshot(db), local = structuredClone(base);
      local.nodes.find(row => row.id === node.id)!.title = "Offline";
      service.updateNode(node.id, { title: "Cloud" });
      expect(() => sync.push({ changes: changesBetween(base, local) })).toThrow(SyncConflict);
      expect(service.getNode(node.id).title).toBe("Cloud");
      expect(local.nodes.find(row => row.id === node.id)!.title).toBe("Offline");
    } finally { db.close(); }
  });
  it("protects against offline child creation after remote workspace deletion", () => {
    const { db, service, workspace, sync } = fixture();
    try {
      const base = snapshot(db);
      service.createNode({ parentId: workspace.rootNodeId, title: "Unsynced child" });
      const local = snapshot(db); replaceSnapshot(db, base);
      service.deleteWorkspace(workspace.id);
      const remote = snapshot(db);
      expect(() => sync.push({ changes: changesBetween(base, local) })).toThrow(SyncConflict);
      expect(snapshot(db)).toEqual(remote);
    } finally { db.close(); }
  });
  it("rejects cycles introduced by two valid moves on different devices", () => {
    const { db, service, workspace, node, sync } = fixture();
    try {
      const second = service.createNode({ parentId: workspace.rootNodeId, title: "Second" });
      const base = snapshot(db);
      service.moveNode(node.id, second.id);
      const local = snapshot(db); replaceSnapshot(db, base);
      service.moveNode(second.id, node.id);
      const remote = snapshot(db);
      expect(() => sync.push({ changes: changesBetween(base, local) })).toThrow(SyncConflict);
      expect(snapshot(db)).toEqual(remote);
    } finally { db.close(); }
  });
  it("keeps new edits made while an earlier upload is in flight", () => {
    const { db, node } = fixture();
    try {
      const sent = snapshot(db), latest = structuredClone(sent), remote = structuredClone(sent);
      latest.nodes.find(row => row.id === node.id)!.title = "Typed during sync";
      remote.nodes.find(row => row.id === node.id)!.body = "Other device";
      const result = mergeChanges(remote, changesBetween(sent, latest));
      expect(result.nodes.find(row => row.id === node.id)).toMatchObject({ title: "Typed during sync", body: "Other device" });
    } finally { db.close(); }
  });
  it("rejects malformed keys without changing cloud data", () => {
    const { db, node, sync } = fixture();
    try {
      const base = snapshot(db), local = structuredClone(base);
      local.nodes.find(row => row.id === node.id)!.title = "Changed";
      const changes = changesBetween(base, local); changes[0].key = "wrong";
      expect(() => sync.push({ changes })).toThrow();
      expect(snapshot(db)).toEqual(base);
    } finally { db.close(); }
  });
  it("executes existing routes, undo, imports and export with browser SQLite", async () => {
    const SQL = await initSqlJs();
    const db = new SQL.Database();
    const sql: SqlDatabase = { exec: text => db.run(text), prepare: text => {
      const all = (...values: any[]) => {
        const stmt = db.prepare(text); try { stmt.bind(values); const rows = []; while (stmt.step()) rows.push(stmt.getAsObject()); return rows; } finally { stmt.free(); }
      };
      return { all, get: (...values) => all(...values)[0], run: all };
    } };
    try {
      db.run("PRAGMA foreign_keys=ON"); migrate(sql);
      const source = fixture();
      try {
        const removed = source.service.createNode({ parentId: source.node.id, title: "Historical deleted child" });
        source.service.deleteNode(removed.id);
        const destination = source.service.createWorkspace("Moved destination");
        source.service.moveNodesToWorkspace([source.node.id], destination.id);
        const incoming = source.sync.pull().data;
        replaceSnapshot(sql, incoming);
        expect(snapshot(sql)).toEqual(incoming);
      } finally { source.db.close(); }
      const service = new OutlinerService(sql);
      const workspace = dispatch(service, "POST", "/api/workspaces", { name: "Browser" });
      const node = dispatch(service, "POST", "/api/nodes", { parentId: workspace.rootNodeId, title: "Offline" });
      dispatch(service, "PATCH", `/api/nodes/${node.id}`, { title: "Edited" });
      expect(dispatch(service, "GET", `/api/nodes/${node.id}`).title).toBe("Edited");
      dispatch(service, "POST", `/api/workspaces/${workspace.id}/undo`);
      expect(dispatch(service, "GET", `/api/nodes/${node.id}`).title).toBe("Offline");
      dispatch(service, "POST", "/api/import/markdown", { workspaceId: workspace.id, content: "- Imported" });
      expect(dispatch(service, "GET", "/api/export/markdown")).toContain("Imported");
      const exported = db.export();
      const restored = new SQL.Database(exported);
      expect(restored.exec("SELECT title FROM nodes WHERE title='Imported'")[0].values[0][0]).toBe("Imported");
      restored.close();
    } finally { db.close(); }
  });
});
