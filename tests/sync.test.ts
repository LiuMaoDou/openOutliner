import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/backend/db/database.js";
import { OutlinerService } from "../src/backend/services/outliner.js";
import { SyncService } from "../src/backend/services/sync.js";
import { changesBetween, mergeChanges, rowKey, snapshot, replaceSnapshot, SyncConflict, type Change } from "../src/backend/shared/sync.js";
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
  it("reads one SQLite revision while a CLI connection creates a workspace", () => {
    const directory = mkdtempSync(join(tmpdir(), "openoutliner-sync-test-"));
    const path = join(directory, "test.sqlite");
    const reader = openDatabase(path), writer = openDatabase(path);
    try {
      const service = new OutlinerService(writer);
      service.createWorkspace("Before pull");
      const before = new SyncService(reader).pull();
      let wrote = false;
      const concurrent: SqlDatabase = {
        exec: text => reader.exec(text),
        prepare: text => {
          const statement = reader.prepare(text);
          if (text !== "SELECT * FROM workspaces") return statement;
          return {
            all: (...values) => {
              const rows = statement.all(...values);
              if (!wrote) {
                service.createWorkspace("Written during pull");
                wrote = true;
              }
              return rows;
            },
            get: (...values) => statement.get(...values),
            run: (...values) => statement.run(...values)
          };
        }
      };
      expect(new SyncService(concurrent).pull()).toEqual(before);
      expect(new SyncService(reader).pull().data.workspaces).toHaveLength(2);
    } finally {
      reader.close(); writer.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("coalesces independently created tags and fields with their note references", () => {
    const { db, service, workspace, node, sync } = fixture();
    const replica = openDatabase(":memory:");
    try {
      const second = service.createNode({ parentId: workspace.rootNodeId, title: "Second note" });
      const base = snapshot(db);
      replaceSnapshot(replica, base);
      const local = new OutlinerService(replica);
      const localTag = local.setNodeTag(node.id, "project");
      const cloudTag = service.setNodeTag(second.id, "project");
      local.setNodeTag(second.id, "project");
      const localField = local.createFieldDefinition({ workspaceId: workspace.id, tagId: localTag.id, name: "Status", type: "text" });
      const cloudField = service.createFieldDefinition({ workspaceId: workspace.id, tagId: cloudTag.id, name: "Status", type: "text" });
      local.setFieldValue(node.id, localField.id, "started");
      local.setFieldValue(second.id, localField.id, "finished");
      service.setFieldValue(second.id, cloudField.id, "finished");
      const sent = snapshot(replica), changes = changesBetween(base, sent);
      const acknowledged = sync.push({ changes });
      expect(acknowledged.data.tags.map(row => row.id)).toEqual([cloudTag.id]);
      expect(acknowledged.data.field_definitions.map(row => row.id)).toEqual([cloudField.id]);
      expect(acknowledged.data.node_tags).toEqual(expect.arrayContaining([
        { node_id: node.id, tag_id: cloudTag.id }, { node_id: second.id, tag_id: cloudTag.id }
      ]));
      expect(service.listFieldValues(node.id)).toEqual([expect.objectContaining({ fieldId: cloudField.id, value: "started" })]);
      expect(service.listFieldValues(second.id)).toEqual([expect.objectContaining({ fieldId: cloudField.id, value: "finished" })]);
      expect(sync.push({ changes }).revision).toBe(acknowledged.revision);

      local.updateTag(localTag.id, { name: "renamed" });
      local.setFieldValue(node.id, localField.id, "edited during upload");
      const latest = mergeChanges(acknowledged.data, changesBetween(sent, snapshot(replica)), changes);
      expect(latest.tags).toEqual([expect.objectContaining({ id: cloudTag.id, name: "renamed" })]);
      expect(latest.field_values.find(row => row.node_id === node.id)).toMatchObject({ field_id: cloudField.id, value: "edited during upload" });
    } finally { replica.close(); db.close(); }
  });

  it("preserves conflicting field data instead of coalescing it silently", () => {
    const { db, service, workspace, node, sync } = fixture();
    const replica = openDatabase(":memory:");
    try {
      const base = snapshot(db);
      replaceSnapshot(replica, base);
      const local = new OutlinerService(replica);
      const localTag = local.setNodeTag(node.id, "project");
      const cloudTag = service.setNodeTag(node.id, "project");
      const field = { workspaceId: workspace.id, name: "Status", type: "text" as const };
      const localField = local.createFieldDefinition({ ...field, tagId: localTag.id });
      const cloudField = service.createFieldDefinition({ ...field, tagId: cloudTag.id });
      local.setFieldValue(node.id, localField.id, "offline value");
      service.setFieldValue(node.id, cloudField.id, "cloud value");
      const cloud = snapshot(db);
      expect(() => sync.push({ changes: changesBetween(base, snapshot(replica)) })).toThrow(SyncConflict);
      expect(snapshot(db)).toEqual(cloud);
      expect(local.listFieldValues(node.id)).toEqual([expect.objectContaining({ value: "offline value" })]);
    } finally { replica.close(); db.close(); }
  });

  it("assigns contiguous sibling positions after simultaneous inserts and retries without moving them", () => {
    const { db, service, workspace, node, sync } = fixture();
    const replica = openDatabase(":memory:"), reverse = openDatabase(":memory:");
    try {
      const existing = service.createNode({ parentId: workspace.rootNodeId, title: "Last note" });
      const child = service.createNode({ parentId: node.id, title: "Unrelated legacy position" });
      db.prepare("UPDATE nodes SET position = 7 WHERE id = ?").run(child.id);
      const timestamp = "2026-01-01T00:00:00.000Z";
      db.prepare("UPDATE nodes SET updated_at = ? WHERE id = ?").run(timestamp, existing.id);
      const base = snapshot(db);
      replaceSnapshot(replica, base);
      const local = new OutlinerService(replica);
      const left = local.createNode({ parentId: workspace.rootNodeId, position: 1, title: "Left insert" });
      const right = service.createNode({ parentId: workspace.rootNodeId, position: 1, title: "Right insert" });
      replica.prepare("UPDATE nodes SET updated_at = ? WHERE id = ?").run(timestamp, existing.id);
      db.prepare("UPDATE nodes SET updated_at = ? WHERE id = ?").run("2026-01-02T00:00:00.000Z", existing.id);
      replica.prepare("UPDATE nodes SET created_at = ? WHERE id = ?").run(timestamp, left.id);
      db.prepare("UPDATE nodes SET created_at = ? WHERE id = ?").run(timestamp, right.id);
      replaceSnapshot(reverse, snapshot(replica));
      const reverseRequest = { changes: changesBetween(base, snapshot(db)) };
      const request = { changes: changesBetween(base, snapshot(replica)) };
      const originalRequest = structuredClone(request);
      const response = sync.push(request);
      const ids = [node.id, ...[left.id, right.id].sort(), existing.id];
      expect(service.listChildren(workspace.rootNodeId).map(row => [row.id, row.position])).toEqual(ids.map((id, position) => [id, position]));
      expect(request).toEqual(originalRequest);
      expect(sync.push(request).revision).toBe(response.revision);
      expect(service.getNode(child.id).position).toBe(7);
      const reverseService = new SyncService(reverse);
      const reverseResponse = reverseService.push(reverseRequest);
      expect(new OutlinerService(reverse).listChildren(workspace.rootNodeId).map(row => row.id)).toEqual(ids);
      expect(reverseService.push(reverseRequest).revision).toBe(reverseResponse.revision);
      const insertedBelow = service.createNode({ parentId: workspace.rootNodeId, position: 2, title: "After the first insert" });
      expect(service.listChildren(workspace.rootNodeId).map(row => row.id)).toEqual([ids[0], ids[1], insertedBelow.id, ...ids.slice(2)]);
    } finally { replica.close(); reverse.close(); db.close(); }
  });

  it("merges Today lists independently created offline without duplicating the list or losing tasks", () => {
    const { db, service, sync } = fixture();
    const replica = openDatabase(":memory:");
    try {
      const base = snapshot(db);
      replaceSnapshot(replica, base);
      const local = new OutlinerService(replica);
      local.createWorkspace("Local workspace");
      const localToday = local.ensureTodayWorkspace();
      const localTask = local.createNode({ parentId: localToday.rootNodeId, title: "Local task" });
      const remoteToday = service.ensureTodayWorkspace();
      const remoteTask = service.createNode({ parentId: remoteToday.rootNodeId, title: "Remote task" });
      sync.push({ changes: changesBetween(base, snapshot(replica)) });
      expect(service.listWorkspaces().filter(workspace => workspace.id === localToday.id)).toHaveLength(1);
      expect(service.getTree(remoteToday.rootNodeId).children.map(node => node.id).sort()).toEqual([localTask.id, remoteTask.id].sort());
      expect(service.getNode(localTask.id).dueDate).toBeNull();
    } finally { replica.close(); db.close(); }
  });

  it("syncs independent conversions of the same legacy folder and retains an offline edit", () => {
    const { db, service, sync } = fixture();
    const replica = openDatabase(":memory:");
    try {
      const folder = service.createWorkspaceFolder("Projects");
      const child = service.createWorkspace("Child", undefined, folder.id);
      const base = snapshot(db);
      replaceSnapshot(replica, base);
      const local = new OutlinerService(replica);
      local.mergeWorkspaceFolders();
      const note = local.createNode({ parentId: child.rootNodeId, title: "Offline note" });
      service.mergeWorkspaceFolders();

      sync.push({ changes: changesBetween(base, snapshot(replica)) });

      expect(service.listWorkspaces().filter(workspace => workspace.id === folder.id)).toHaveLength(1);
      expect(service.getWorkspace(child.id).parentWorkspaceId).toBe(folder.id);
      expect(service.getNode(note.id).title).toBe("Offline note");
    } finally { replica.close(); db.close(); }
  });

  it("applies sequential edits, deletion and reinsertion of one key in order", () => {
    const { db, node } = fixture();
    try {
      const current = snapshot(db), original = structuredClone(current);
      const before = current.nodes.find(row => row.id === node.id)!;
      const edited = { ...before, title: "First edit" };
      const restored = { ...before, title: "Reinserted" };
      const changes: Change[] = [
        { table: "nodes", key: rowKey("nodes", before), before, after: edited },
        { table: "nodes", key: rowKey("nodes", before), before: edited, after: null },
        { table: "nodes", key: rowKey("nodes", before), before: null, after: restored }
      ];
      const result = mergeChanges(current, changes);
      expect(result.nodes.at(-1)).toEqual(restored);
      expect(result.nodes.filter(row => row.id === node.id)).toHaveLength(1);
      expect(current).toEqual(original);
    } finally { db.close(); }
  });

  it("keeps composite relation keys distinct in a mixed batch", () => {
    const { db } = fixture();
    try {
      const current = snapshot(db);
      current.node_tags = [{ node_id: "a", tag_id: "one" }, { node_id: "a", tag_id: "two" }];
      current.field_values = [{ node_id: "a", field_id: "one", value: "old", updated_at: "before" }];
      const desired = structuredClone(current);
      desired.node_tags = [current.node_tags[1], { node_id: "b", tag_id: "one" }];
      desired.field_values[0].value = "new";
      const changes = changesBetween(current, desired);
      expect(mergeChanges(current, changes)).toEqual(desired);
      expect(mergeChanges(desired, changes)).toEqual(desired);
    } finally { db.close(); }
  });

  it("validates a table schema once per push instead of once per changed row", () => {
    const { db, service, workspace } = fixture();
    try {
      service.createNode({ parentId: workspace.rootNodeId, title: "Second" });
      service.createNode({ parentId: workspace.rootNodeId, title: "Third" });
      const base = snapshot(db), local = structuredClone(base);
      for (const row of local.nodes) if (row.parent_id) row.title = `Changed ${row.title}`;
      let schemaReads = 0;
      const sql: SqlDatabase = { exec: text => db.exec(text), prepare: text => {
        if (text === "PRAGMA table_info(nodes)") schemaReads += 1;
        return db.prepare(text);
      } };
      const response = new SyncService(sql).push({ changes: changesBetween(base, local) });
      expect(response.data).toEqual(local);
      // One validation read and one incremental application schema read.
      expect(schemaReads).toBe(2);
    } finally { db.close(); }
  });

  it("rejects workspace cycles even after validating a separate branch", () => {
    const { db, service } = fixture();
    try {
      const a = service.createWorkspace("A"), b = service.createWorkspace("B");
      const before = snapshot(db), invalid = structuredClone(before);
      invalid.workspaces.find(row => row.id === a.id)!.parent_workspace_id = b.id;
      invalid.workspaces.find(row => row.id === b.id)!.parent_workspace_id = a.id;
      expect(() => replaceSnapshot(db, invalid)).toThrow("循环");
      expect(snapshot(db)).toEqual(before);
    } finally { db.close(); }
  });

  it("syncs an emptied recycle bin and rejects a stale restore without resurrecting content", () => {
    const { db, service, node, sync } = fixture();
    const replica = openDatabase(":memory:");
    try {
      const removed = service.createNode({ parentId: node.id, title: "Deleted" });
      service.setNodeTag(removed.id, "removed-tag");
      service.deleteNode(removed.id);
      const base = snapshot(db);
      replaceSnapshot(replica, base);
      const local = new OutlinerService(replica);
      local.restoreNode(removed.id);
      const staleRestore = changesBetween(base, snapshot(replica));
      replaceSnapshot(replica, base);
      dispatch(local, "DELETE", "/api/recycle-bin");
      const request = { changes: changesBetween(base, snapshot(replica)) };
      const response = sync.push(request);
      expect(response.data.nodes.some(row => row.id === removed.id)).toBe(false);
      expect(service.getNode(node.id).title).toBe("Original");
      expect(sync.push(request).revision).toBe(response.revision);
      expect(() => sync.push({ changes: staleRestore })).toThrow(SyncConflict);
      expect(service.listRecycleBin()).toEqual([]);
      expect(snapshot(db)).toEqual(response.data);
    } finally { replica.close(); db.close(); }
  });
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
      dispatch(service, "DELETE", `/api/nodes/${node.id}`);
      expect(dispatch(service, "DELETE", "/api/recycle-bin").deletedCount).toBeGreaterThan(0);
      expect(dispatch(service, "GET", "/api/recycle-bin")).toEqual([]);
      expect(snapshot(sql).nodes.some(row => row.id === node.id)).toBe(false);
      const exported = db.export();
      const restored = new SQL.Database(exported);
      expect(restored.exec("SELECT title FROM nodes WHERE title='Imported'")[0].values[0][0]).toBe("Imported");
      restored.close();
    } finally { db.close(); }
  });
});
