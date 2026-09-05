import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type OpenOutlinerDb } from "../src/backend/db/database.js";
import { OutlinerService } from "../src/backend/services/outliner.js";
import { exportMarkdown, importMarkdown } from "../src/backend/importExport/markdown.js";
import { exportOpml, importOpml } from "../src/backend/importExport/opml.js";

let db: OpenOutlinerDb;
let service: OutlinerService;
beforeEach(() => { db = openDatabase(":memory:"); service = new OutlinerService(db); });
afterEach(() => { db.close(); vi.restoreAllMocks(); });

function historyBytes(workspaceId: string): number {
  return Number(db.prepare(`SELECT COALESCE(SUM(LENGTH(CAST(before_snapshot AS BLOB)) + LENGTH(CAST(after_snapshot AS BLOB))), 0) AS bytes
    FROM outline_history WHERE workspace_id = ?`).get(workspaceId)!.bytes);
}

describe("safe imports", () => {
  it.each([
    ["Markdown", importMarkdown, ""], ["Markdown whitespace", importMarkdown, " \n\t"],
    ["Markdown without outlines", importMarkdown, "just some text"],
    ["misclassified XML", importMarkdown, '<opml><body><outline text="Alpha" /></body></opml>'],
    ["OPML", importOpml, ""], ["unclosed XML", importOpml, '<opml><body><outline text="Alpha" />'],
    ["unrelated XML", importOpml, '<document><outline text="Alpha" /></document>'],
    ["empty OPML", importOpml, '<opml><body /></opml>'],
    ["empty wrapper", importOpml, '<opml><body><outline text="" /></body></opml>']
  ])("rejects %s without touching existing data or history", (_name, importer, content) => {
    const ws = service.createWorkspace("Keep this");
    const node = service.createNode({ parentId: ws.rootNodeId, title: "Original" });
    const beforeHistory = historyBytes(ws.id);
    expect(() => importer(service, { content })).toThrow();
    expect(service.listWorkspaces().map(item => item.id)).toEqual([ws.id]);
    expect(service.getNode(node.id).title).toBe("Original");
    expect(historyBytes(ws.id)).toBe(beforeHistory);
  });

  it.each([["Markdown", importMarkdown, exportMarkdown], ["OPML", importOpml, exportOpml]])(
    "%s preserves all existing workspaces and their undo history", (_name, importer, exporter) => {
      const ws = service.createWorkspace("Keep this");
      service.createNode({ parentId: ws.rootNodeId, title: "Original" });
      const existingHistory = historyBytes(ws.id);
      const result = importer(service, { content: exporter(service) });
      expect(service.listWorkspaces()).toHaveLength(2);
      expect(result.workspaceId).not.toBe(ws.id);
      expect(historyBytes(ws.id)).toBe(existingHistory);
      expect(service.getTree(ws.rootNodeId).children[0].title).toBe("Original");
    }
  );

  it("rolls back all imported workspaces after a late invalid value", () => {
    const keep = service.createWorkspace("Keep");
    const content = '<opml><body><outline text="First" openoutlinerWorkspace="true"><outline text="Valid" /></outline>' +
      '<outline text="Second" openoutlinerWorkspace="true"><outline text="Invalid" dueDate="not-a-date" /></outline></body></opml>';
    expect(() => importOpml(service, { content })).toThrow();
    expect(service.listWorkspaces().map(item => item.id)).toEqual([keep.id]);
    expect(Number(db.prepare("SELECT COUNT(*) AS count FROM outline_history").get()!.count)).toBe(0);
  });

  it("rejects a truncated Markdown note rather than consuming another outline node", () => {
    const ws = service.createWorkspace("Keep");
    service.createNode({ parentId: ws.rootNodeId, title: "Parent", body: "Note" });
    service.createNode({ parentId: ws.rootNodeId, title: "Sibling" });
    const content = exportMarkdown(service, ws.id).replace("  Note\n", "");
    expect(() => importMarkdown(service, { content })).toThrow("truncated");
    expect(service.listWorkspaces()).toHaveLength(1);
    expect(service.getTree(ws.rootNodeId).children).toHaveLength(2);
  });

  it("imports into an existing workspace as one undoable operation", () => {
    const ws = service.createWorkspace("Target");
    const original = service.createNode({ parentId: ws.rootNodeId, title: "Keep" });
    importMarkdown(service, { workspaceId: ws.id, content: "- First\n  - Child\n- Second" });
    service.undoOutline(ws.id);
    expect(service.getTree(ws.rootNodeId).children.map(node => node.id)).toEqual([original.id]);
    service.redoOutline(ws.id);
    expect(service.getTree(ws.rootNodeId).children.map(node => node.title)).toEqual(["Keep", "First", "Second"]);
  });
});

describe("lossless outline exports", () => {
  it.each([
    ["Markdown CRLF", importMarkdown, exportMarkdown, "\r\n"],
    ["Markdown CR", importMarkdown, exportMarkdown, "\r"],
    ["Markdown LF", importMarkdown, exportMarkdown, "\n"],
    ["OPML CRLF", importOpml, exportOpml, "\r\n"],
    ["OPML CR", importOpml, exportOpml, "\r"],
    ["OPML LF", importOpml, exportOpml, "\n"]
  ])("%s retains original title, note and tag line endings", (_name, importer, exporter, newline) => {
    const ws = service.createWorkspace("Line endings");
    const title = `First${newline}Second`;
    const body = `a${newline}b${newline}`;
    const tag = `Project${newline}Plan`;
    const node = service.createNode({ parentId: ws.rootNodeId, title, body });
    service.setNodeTag(node.id, tag);
    const result = importer(service, { content: exporter(service, ws.id) });
    const restored = service.getTree(service.getWorkspace(result.workspaceId!).rootNodeId).children[0];
    expect(restored).toMatchObject({ title, body });
    expect(restored.tags.map(item => item.name)).toEqual([tag]);
  });

  it.each([
    ["title", "- Original #project", "- Edited #project"],
    ["completion", "- Original #project", "- [x] Original #project"],
    ["tags", "- Original #project", "- Original #changed"]
  ])("rejects externally edited Markdown %s rather than silently restoring metadata", (_field, before, after) => {
    const ws = service.createWorkspace("External edit");
    const node = service.createNode({ parentId: ws.rootNodeId, title: "Original" });
    service.setNodeTag(node.id, "project");
    const content = exportMarkdown(service, ws.id).replace(before, after);
    expect(() => importMarkdown(service, { content })).toThrow("differ from their export metadata");
    expect(service.listWorkspaces()).toHaveLength(1);
    expect(service.getNode(node.id).title).toBe("Original");
  });

  it.each([
    ["text", 'text="Original"', 'text="Edited"'],
    ["note", '_note="Keep note"', '_note="Edited note"'],
    ["tags", 'tags="project"', 'tags="changed"'],
    ["completion", 'done="false"', 'done="true"']
  ])("rejects externally edited OPML %s rather than silently restoring metadata", (_field, before, after) => {
    const ws = service.createWorkspace("External edit");
    const node = service.createNode({ parentId: ws.rootNodeId, title: "Original", body: "Keep note" });
    service.setNodeTag(node.id, "project");
    const content = exportOpml(service, ws.id).replace(before, after);
    expect(() => importOpml(service, { content })).toThrow("differ from their export metadata");
    expect(service.listWorkspaces()).toHaveLength(1);
    expect(service.getNode(node.id)).toMatchObject({ title: "Original", body: "Keep note" });
  });

  it.each([["Markdown", importMarkdown, exportMarkdown], ["OPML", importOpml, exportOpml]])(
    "%s retains multiline titles, note lists/code/spacing, tags, dates and folded state", (_name, importer, exporter) => {
      const ws = service.createWorkspace("Round trip");
      const body = "\n  leading spaces\n\n- note list\n  - nested note list\n\n```md\n# code heading\n- code list\n```\n\n    indented code\n\n";
      const node = service.createNode({ parentId: ws.rootNodeId, title: "  First line\nSecond #literal  ", body, done: true });
      service.updateNode(node.id, { dueDate: "2026-10-09", collapsed: true });
      service.setNodeTag(node.id, "project plan");
      service.setNodeTag(node.id, "中文 标签");
      service.createNode({ parentId: node.id, title: "Real child" });
      const output = exporter(service, ws.id);
      const result = importer(service, { content: output });
      const root = service.getTree(service.getWorkspace(result.workspaceId!).rootNodeId);
      expect(result.imported).toBe(2);
      expect(root.children).toHaveLength(1);
      expect(root.children[0]).toMatchObject({ title: "  First line\nSecond #literal  ", body, done: true, dueDate: "2026-10-09", collapsed: true });
      expect(root.children[0].tags.map(tag => tag.name).sort()).toEqual(["project plan", "中文 标签"].sort());
      expect(root.children[0].children.map(child => child.title)).toEqual(["Real child"]);
    }
  );

  it.each([["Markdown", importMarkdown, exportMarkdown], ["OPML", importOpml, exportOpml]])(
    "%s retains notes on nodes with an empty title", (_name, importer, exporter) => {
      const ws = service.createWorkspace("Untitled note");
      service.createNode({ parentId: ws.rootNodeId, title: "", body: "Do not discard me" });
      const result = importer(service, { content: exporter(service, ws.id) });
      expect(service.getTree(service.getWorkspace(result.workspaceId!).rootNodeId).children[0])
        .toMatchObject({ title: "", body: "Do not discard me" });
    }
  );

  it.each([["Markdown", importMarkdown, exportMarkdown], ["OPML", importOpml, exportOpml]])(
    "%s preserves blank nodes, hierarchy, completion and collapse state", (_name, importer, exporter) => {
      const ws = service.createWorkspace("Blank outlines");
      const parent = service.createNode({ parentId: ws.rootNodeId, title: "", done: true });
      service.updateNode(parent.id, { collapsed: true });
      service.createNode({ parentId: parent.id, title: "" });
      service.createNode({ parentId: ws.rootNodeId, title: "" });
      const result = importer(service, { content: exporter(service, ws.id) });
      const root = service.getTree(service.getWorkspace(result.workspaceId!).rootNodeId);
      expect(result.imported).toBe(3);
      expect(root.children).toHaveLength(2);
      expect(root.children[0]).toMatchObject({ title: "", done: true, collapsed: true });
      expect(root.children[0].children).toHaveLength(1);
      expect(root.children[0].children[0].title).toBe("");
      expect(root.children[1].title).toBe("");
    }
  );
});

describe("restore deletion batches", () => {
  it("restores only descendants deleted with their parent, even within one millisecond", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-09-05T00:00:00.000Z"));
    const ws = service.createWorkspace("Deleted");
    const parent = service.createNode({ parentId: ws.rootNodeId, title: "Parent" });
    const oldChild = service.createNode({ parentId: parent.id, title: "Deleted earlier" });
    const child = service.createNode({ parentId: parent.id, title: "Deleted with parent" });
    service.deleteNode(oldChild.id);
    service.deleteNode(parent.id);
    expect(service.restoreNode(parent.id).children.map(node => node.id)).toEqual([child.id]);
    expect(() => service.getNode(oldChild.id)).toThrow();
    service.undoOutline(ws.id);
    expect(() => service.getNode(parent.id)).toThrow();
    service.redoOutline(ws.id);
    expect(service.getTree(parent.id).children.map(node => node.id)).toEqual([child.id]);
  });

  it("rejects restoration below a parent moved into another workspace", () => {
    const source = service.createWorkspace("Source");
    const target = service.createWorkspace("Target");
    const parent = service.createNode({ parentId: source.rootNodeId, title: "Parent" });
    const child = service.createNode({ parentId: parent.id, title: "Deleted" });
    service.deleteNode(child.id);
    service.moveNodesToWorkspace([parent.id], target.id);
    expect(() => service.restoreNode(child.id)).toThrow("another workspace");
    expect(() => service.getNode(child.id)).toThrow();
    expect(service.getTree(parent.id).children).toEqual([]);
  });
});

describe("bounded incremental history", () => {
  it("stores 50 title edits in a 1000-node workspace in under 64 KiB and replays them", () => {
    const ws = service.createWorkspace("Large");
    const insert = db.prepare(`INSERT INTO nodes (id, workspace_id, parent_id, position, title, body, done, collapsed, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`);
    const now = new Date().toISOString();
    for (let index = 0; index < 1000; index += 1) insert.run(`node-${index}`, ws.id, ws.rootNodeId, index, `Node ${index}`, "x".repeat(200), now, now);
    for (let index = 0; index < 50; index += 1) service.updateNode(`node-${index}`, { title: `Edited ${index}` });
    const bytes = historyBytes(ws.id);
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThan(64 * 1024);
    for (let index = 0; index < 50; index += 1) service.undoOutline(ws.id);
    expect(service.getNode("node-0").title).toBe("Node 0");
    expect(service.getNode("node-49").title).toBe("Node 49");
    for (let index = 0; index < 50; index += 1) service.redoOutline(ws.id);
    expect(service.getNode("node-0").title).toBe("Edited 0");
    expect(service.getNode("node-49").title).toBe("Edited 49");
  }, 30_000);

  it("does not overwrite unrelated later fields when undoing a title", () => {
    const ws = service.createWorkspace("Fields");
    const node = service.createNode({ parentId: ws.rootNodeId, title: "Before", body: "Before note" });
    service.updateNode(node.id, { title: "After" });
    db.prepare("UPDATE nodes SET body = ? WHERE id = ?").run("New remote note", node.id);
    service.undoOutline(ws.id);
    expect(service.getNode(node.id)).toMatchObject({ title: "Before", body: "New remote note" });
  });

  it("enforces the byte budget without making undo jump past discarded edits", () => {
    const ws = service.createWorkspace("Budget");
    const a = service.createNode({ parentId: ws.rootNodeId, title: "A" });
    const b = service.createNode({ parentId: ws.rootNodeId, title: "B" });
    service.updateNode(a.id, { body: "a".repeat(5 * 1024 * 1024) });
    service.updateNode(b.id, { body: "b".repeat(5 * 1024 * 1024) });
    expect(historyBytes(ws.id)).toBeLessThanOrEqual(8 * 1024 * 1024);
    service.undoOutline(ws.id);
    expect(service.getNode(b.id).body).toBe("");
    expect(service.getNode(a.id).body).toHaveLength(5 * 1024 * 1024);
    expect(service.getOutlineHistoryState(ws.id).canUndo).toBe(false);
  });

  it("continues to replay existing full-snapshot history", () => {
    const ws = service.createWorkspace("Legacy");
    const node = service.createNode({ parentId: ws.rootNodeId, title: "Before" });
    const capture = () => db.prepare("SELECT * FROM nodes WHERE workspace_id = ?").all(ws.id).map(row => ({
      id: row.id, parentId: row.parent_id, position: row.position, title: row.title, body: row.body,
      dueDate: row.due_date, done: Boolean(row.done), collapsed: Boolean(row.collapsed), deletedAt: row.deleted_at,
      createdAt: row.created_at, updatedAt: row.updated_at
    }));
    const before = JSON.stringify(capture());
    service.updateNode(node.id, { title: "After" });
    const after = JSON.stringify(capture());
    db.prepare("UPDATE outline_history SET before_snapshot = ?, after_snapshot = ? WHERE seq = (SELECT MAX(seq) FROM outline_history)").run(before, after);
    service.undoOutline(ws.id);
    expect(service.getNode(node.id).title).toBe("Before");
    service.redoOutline(ws.id);
    expect(service.getNode(node.id).title).toBe("After");
  });
});
