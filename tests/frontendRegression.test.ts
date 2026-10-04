import { describe, expect, it } from "vitest";
import { computeVisibleIds, fromNestedTree, isDescendant, removeNodes, searchNodeIds } from "../src/web/flatTree.js";
import type { OutlineTreeNode } from "../src/web/api.js";
import { getDueReminderCutoff, getDueReminderNodes } from "../src/web/dueTasks.js";

const node = (id: string, title: string, children: OutlineTreeNode[] = [], patch: Partial<OutlineTreeNode> = {}): OutlineTreeNode => ({
  id, title, children, workspaceId: "workspace", parentId: null, position: 0,
  body: "", dueDate: null, done: false, collapsed: false, createdAt: "", updatedAt: "", tags: [], fieldValues: [], ...patch
});

describe("due reminders", () => {
  it("includes overdue, today and tomorrow tasks, excluding completed, undated and later tasks", () => {
    const { state } = fromNestedTree(node("root", "Workspace", [
      node("tomorrow", "Tomorrow", [], { dueDate: "2026-09-22" }),
      node("later", "Later", [], { dueDate: "2026-09-23" }),
      node("today", "Today", [], { dueDate: "2026-09-21" }),
      node("overdue", "Overdue", [], { dueDate: "2026-09-20" }),
      node("done", "Done", [], { dueDate: "2026-09-20", done: true }),
      node("undated", "Undated")
    ], { dueDate: "2026-09-20" }));
    const cutoff = getDueReminderCutoff(new Date(2026, 8, 21, 0, 1));
    expect(getDueReminderNodes(state, cutoff).map(item => item.id)).toEqual(["overdue", "today", "tomorrow"]);
    expect(getDueReminderNodes(null, cutoff)).toEqual([]);
  });

  it("merges other pages with live edits without duplicates or stale current-page tasks", () => {
    const cutoff = "2026-09-22";
    const previous = [
      node("edited", "Old title", [], { dueDate: "2026-09-20" }),
      node("removed", "Removed", [], { dueDate: "2026-09-20" }),
      node("completed", "Completed", [], { dueDate: "2026-09-20" }),
      node("rescheduled", "Rescheduled", [], { dueDate: "2026-09-20" }),
      node("other", "Other page", [], { workspaceId: "other-page", dueDate: "2026-09-19" })
    ];
    const { state } = fromNestedTree(node("root", "Page", [
      node("edited", "New title", [], { dueDate: "2026-09-21" }),
      node("completed", "Completed", [], { dueDate: "2026-09-20", done: true }),
      node("rescheduled", "Rescheduled", [], { dueDate: "2026-09-23" })
    ]));
    expect(getDueReminderNodes(state, cutoff, previous).map(item => [item.id, item.title]))
      .toEqual([["other", "Other page"], ["edited", "New title"]]);
    expect(getDueReminderNodes(null, cutoff, previous)).toHaveLength(5);
    const moved = node("edited", "New title", [], { workspaceId: "destination", dueDate: "2026-09-21" });
    expect(getDueReminderNodes(state, cutoff, [moved]).map(item => item.id)).toEqual(["edited"]);
  });

  it.each([
    [new Date(2026, 8, 30, 23, 59), "2026-10-01"],
    [new Date(2026, 11, 31, 0, 1), "2027-01-01"],
    [new Date(2028, 1, 28, 12), "2028-02-29"],
    [new Date(2026, 2, 8, 0, 1), "2026-03-09"]
  ])("uses the next local calendar day for %s", (now, expected) => {
    expect(getDueReminderCutoff(now)).toBe(expected);
  });
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

describe("large outline operations", () => {
  it("deletes overlapping selections across parents without mutating the original tree", () => {
    const { state } = fromNestedTree(node("root", "Root", [
      node("keep", "Keep"),
      node("parent", "Parent", [node("child", "Child")], { position: 1 }),
      node("other", "Other", [node("remove", "Remove"), node("stay", "Stay", [], { position: 1 })], { position: 2 })
    ]));
    const next = removeNodes(state, ["parent", "child", "parent", "remove", "missing", "root"]);
    expect(computeVisibleIds(next)).toEqual(["keep", "other", "stay"]);
    expect(next.nodes.other.position).toBe(1);
    expect(next.nodes.stay.position).toBe(0);
    expect(next.nodes.keep).toBe(state.nodes.keep);
    expect(next.nodes.child).toBeUndefined();
    expect(computeVisibleIds(state)).toEqual(["keep", "parent", "child", "other", "remove", "stay"]);
    expect(removeNodes(state, ["root", "missing"])).toBe(state);
  });

  it("converts, searches and deletes a 12000-level tree without overflowing the call stack", () => {
    const root = node("root", "Root");
    let parent = root;
    for (let index = 0; index < 12000; index += 1) {
      const child = node(`deep-${index}`, index === 11999 ? "Target" : "Node");
      parent.children.push(child);
      parent = child;
    }
    const { state, visibleIds } = fromNestedTree(root);
    expect(visibleIds).toHaveLength(12000);
    expect(computeVisibleIds(state)).toEqual(visibleIds);
    expect(searchNodeIds(state, "target")).toEqual(["deep-11999"]);
    expect(isDescendant(state, "deep-0", "deep-11999")).toBe(true);
    expect(isDescendant(state, "deep-11999", "deep-0")).toBe(false);
    expect(isDescendant(state, "missing", "deep-0")).toBe(false);
    const next = removeNodes(state, ["deep-0"]);
    expect(Object.keys(next.nodes)).toEqual(["root"]);
    expect(next.nodes.root.childIds).toEqual([]);
    expect(state.nodes.root.childIds).toEqual(["deep-0"]);
  });
});
