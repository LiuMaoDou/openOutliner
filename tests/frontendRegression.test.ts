import { describe, expect, it } from "vitest";
import { computeVisibleIds, fromNestedTree, searchNodeIds } from "../src/web/flatTree.js";
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
