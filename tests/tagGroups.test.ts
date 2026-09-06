import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenOutlinerDb } from "../src/backend/db/database";
import { OutlinerService } from "../src/backend/services/outliner";
import { dispatch } from "../src/backend/shared/dispatch";

let db: OpenOutlinerDb;
let service: OutlinerService;
beforeEach(() => { db = openDatabase(":memory:"); service = new OutlinerService(db); });
afterEach(() => db.close());

describe("central tag management", () => {
  it("includes unused tags only when requested and keeps the global name ordering", () => {
    const workspace = service.createWorkspace("Test");
    const node = service.createNode({ parentId: workspace.rootNodeId, title: "Outline" });
    service.setNodeTag(node.id, "zebra");
    service.createTag(workspace.id, "Alpha");
    expect(service.listTaggedNodeGroups().map(group => group.name)).toEqual(["zebra"]);
    const groups = dispatch(service, "GET", "/api/system/tag-tree?includeUnused=1");
    expect(groups.map((group: { name: string }) => group.name)).toEqual(["Alpha", "zebra"]);
    expect(groups[0].results).toEqual([]);
    expect(dispatch(service, "GET", "/api/system/tags")).toHaveLength(2);
  });

  it("renames a group across all workspaces without changing node text, tag ids or colors", () => {
    const first = service.createWorkspace("First");
    const second = service.createWorkspace("Second");
    const node = service.createNode({ parentId: first.rootNodeId, title: "Keep this text" });
    const tag = service.setNodeTag(node.id, "计划/旧名");
    service.createTag(second.id, tag.name);
    dispatch(service, "PATCH", `/api/system/tags/${encodeURIComponent(tag.name)}`, { name: "新计划" });
    expect(service.listAllTags().map(tag => tag.name)).toEqual(["新计划", "新计划"]);
    expect(service.getTag(tag.id)).toMatchObject({ id: tag.id, name: "新计划", color: tag.color });
    expect(service.listNodeTags(node.id)[0].name).toBe("新计划");
    expect(service.getNode(node.id).title).toBe("Keep this text");
    expect(service.listTaggedNodeGroups(true)).toHaveLength(1);
  });

  it("rolls back the entire rename if any workspace already has the new name", () => {
    const first = service.createWorkspace("First");
    const second = service.createWorkspace("Second");
    const one = service.createTag(first.id, "old");
    const two = service.createTag(second.id, "old");
    service.createTag(second.id, "taken");
    expect(() => service.renameTagGroup("old", "taken")).toThrow("Tag already exists");
    expect(service.getTag(one.id).name).toBe("old");
    expect(service.getTag(two.id).name).toBe("old");
  });

  it("deletes tags and their associations globally while retaining outlines and other tags", () => {
    for (const name of ["First", "Second"]) {
      const workspace = service.createWorkspace(name);
      const node = service.createNode({ parentId: workspace.rootNodeId, title: `${name} outline` });
      service.setNodeTag(node.id, "remove");
      service.setNodeTag(node.id, "keep");
    }
    const nodes = service.listNodesByTagName("remove");
    dispatch(service, "DELETE", "/api/system/tags/remove");
    expect(service.listAllTags().every(tag => tag.name === "keep")).toBe(true);
    expect(service.listNodesByTagName("remove")).toEqual([]);
    for (const result of nodes) {
      expect(service.getNode(result.node.id).title).toBe(result.node.title);
      expect(service.listNodeTags(result.node.id).map(tag => tag.name)).toEqual(["keep"]);
    }
  });

  it("rejects blank names and missing groups without mutating existing tags", () => {
    const workspace = service.createWorkspace("Test");
    service.createTag(workspace.id, "keep");
    expect(() => service.renameTagGroup("keep", "#")).toThrow("Tag name is required");
    expect(() => service.renameTagGroup("missing", "new")).toThrow("Tag not found");
    expect(() => service.deleteTagGroup("missing")).toThrow("Tag not found");
    expect(service.listAllTags().map(tag => tag.name)).toEqual(["keep"]);
  });
});
