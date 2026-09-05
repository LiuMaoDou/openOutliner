import { describe, expect, it } from "vitest";
import { computeVisibleIds, fromNestedTree, searchNodeIds } from "../src/web/flatTree.js";
import type { OutlineTreeNode } from "../src/web/api.js";

const node = (id: string, title: string, children: OutlineTreeNode[] = [], patch: Partial<OutlineTreeNode> = {}): OutlineTreeNode => ({
  id, title, children, workspaceId: "workspace", parentId: null, position: 0,
  body: "", dueDate: null, done: false, collapsed: false, createdAt: "", updatedAt: "", tags: [], fieldValues: [], ...patch
});

describe("outline search", () => {
  it("finds nested titles and notes inside collapsed branches without expanding them", () => {
    const { state } = fromNestedTree(node("root", "Workspace", [
      node("parent", "Parent", [
        node("child", "Hidden TARGET"),
        node("nested", "Nested", [node("deep", "Deep", [], { body: "target in notes" })], { collapsed: true })
      ], { collapsed: true }),
      node("sibling", "Another target")
    ]));
    expect(computeVisibleIds(state)).toEqual(["parent", "sibling"]);
    expect(searchNodeIds(state, " TARGET ")).toEqual(["child", "deep", "sibling"]);
    expect(state.nodes.parent.collapsed).toBe(true);
    expect(searchNodeIds(state, "")).toEqual(["parent", "sibling"]);
    expect(searchNodeIds(state, "Workspace")).toEqual([]);
  });
});
