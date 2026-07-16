import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenOutlinerDb } from "../src/backend/db/database.js";
import { exportMarkdown, importMarkdown } from "../src/backend/importExport/markdown.js";
import { exportOpml, importOpml } from "../src/backend/importExport/opml.js";
import { OutlinerService } from "../src/backend/services/outliner.js";
import type { OutlineTreeNode } from "../src/web/api.js";
import {
  createWorkspaceRequestBody,
  formatNodeDate,
  getChildCountLabel,
  nextCollapsedWorkspaceIds,
  shouldIgnoreTextInputKeyDown,
  nextCollapsedWorkspaceFolderIds,
  splitTitleAtSelection
} from "../src/web/App.js";
import {
  fromNestedTree,
  moveNode as moveFlatNode,
  moveNodeInside,
  computeVisibleIds,
  replaceNode
} from "../src/web/flatTree.js";
import {
  insertTreeNode,
  moveTreeNode,
  removeTreeNode,
  replaceTreeNode,
  updateTreeNode
} from "../src/web/treeOps.js";

let tempDir = "";
let db: OpenOutlinerDb;
let service: OutlinerService;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "openoutliner-test-"));
  db = openDatabase(join(tempDir, "test.sqlite"));
  service = new OutlinerService(db);
});

afterEach(() => {
  db.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("OutlinerService", () => {
  it("creates and moves nodes while preserving sibling order", () => {
    const workspace = service.createWorkspace("Test");
    const alpha = service.createNode({ parentId: workspace.rootNodeId, title: "Alpha" });
    const beta = service.createNode({ parentId: workspace.rootNodeId, title: "Beta" });
    const gamma = service.createNode({ parentId: workspace.rootNodeId, title: "Gamma" });

    service.moveNode(gamma.id, workspace.rootNodeId, 0);
    service.moveNode(beta.id, alpha.id, 0);

    expect(service.listChildren(workspace.rootNodeId).map(node => node.title)).toEqual(["Gamma", "Alpha"]);
    expect(service.listChildren(alpha.id).map(node => node.title)).toEqual(["Beta"]);
  });

  it("stores and clears an optional node date", () => {
    const workspace = service.createWorkspace("Dates");
    const node = service.createNode({ parentId: workspace.rootNodeId, title: "Review" });

    expect(service.updateNode(node.id, { dueDate: "2026-07-18" }).dueDate).toBe("2026-07-18");
    expect(() => service.updateNode(node.id, { dueDate: "July 18" })).toThrow("YYYY-MM-DD");
    expect(service.updateNode(node.id, { dueDate: null }).dueDate).toBeNull();
  });

  it("attaches tags and field values to tree nodes", () => {
    const workspace = service.createWorkspace("Fields");
    const node = service.createNode({ parentId: workspace.rootNodeId, title: "Project" });
    const tag = service.setNodeTag(node.id, "project");
    const field = service.createFieldDefinition({
      workspaceId: workspace.id,
      tagId: tag.id,
      name: "Status",
      type: "select",
      options: "todo,doing,done"
    });

    service.setFieldValue(node.id, field.id, "doing");
    const tree = service.getTree(workspace.rootNodeId);

    expect(tree.children[0].tags[0].name).toBe("project");
    expect(tree.children[0].fieldValues[0].value).toBe("doing");
  });

  it("builds complete trees with ordered children, tags, and field values", () => {
    const workspace = service.createWorkspace("Batch Tree");
    const alpha = service.createNode({ parentId: workspace.rootNodeId, title: "Alpha" });
    const beta = service.createNode({ parentId: workspace.rootNodeId, title: "Beta" });
    const nested = service.createNode({ parentId: alpha.id, title: "Nested" });
    const tag = service.setNodeTag(nested.id, "deep");
    const field = service.createFieldDefinition({
      workspaceId: workspace.id,
      tagId: tag.id,
      name: "Status",
      type: "text"
    });
    service.setFieldValue(nested.id, field.id, "ready");

    service.moveNode(beta.id, workspace.rootNodeId, 0);
    const tree = service.getTree(workspace.rootNodeId);

    expect(tree.children.map(node => node.title)).toEqual(["Beta", "Alpha"]);
    expect(tree.children[1].children[0].title).toBe("Nested");
    expect(tree.children[1].children[0].tags[0].name).toBe("deep");
    expect(tree.children[1].children[0].fieldValues[0].value).toBe("ready");
  });

  it("restores a deleted node subtree at its original sibling position", () => {
    const workspace = service.createWorkspace("Restore");
    const alpha = service.createNode({ parentId: workspace.rootNodeId, title: "Alpha" });
    const beta = service.createNode({ parentId: workspace.rootNodeId, title: "Beta" });
    const gamma = service.createNode({ parentId: workspace.rootNodeId, title: "Gamma" });
    const child = service.createNode({ parentId: beta.id, title: "Beta child" });

    service.deleteNode(beta.id);
    expect(service.listChildren(workspace.rootNodeId).map(node => node.title)).toEqual(["Alpha", "Gamma"]);

    const restored = service.restoreNode(beta.id);
    const tree = service.getTree(workspace.rootNodeId);

    expect(restored.title).toBe("Beta");
    expect(restored.children.map(node => node.id)).toEqual([child.id]);
    expect(tree.children.map(node => node.title)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(tree.children.map(node => node.position)).toEqual([0, 1, 2]);
    expect(service.getNode(child.id).title).toBe("Beta child");
    expect(service.getNode(gamma.id).position).toBe(2);
    expect(service.getNode(alpha.id).position).toBe(0);
  });

  it("rejects restoring a node that is not deleted", () => {
    const workspace = service.createWorkspace("Restore validation");
    const node = service.createNode({ parentId: workspace.rootNodeId, title: "Active" });

    expect(() => service.restoreNode(node.id)).toThrow("Node is not deleted.");
  });

  it("updates and deletes workspaces", () => {
    const workspace = service.createWorkspace("Draft", "rocket");
    const renamed = service.updateWorkspace(workspace.id, { name: "Personal" });

    expect(workspace.icon).toBe("rocket");
    expect(renamed.name).toBe("Personal");
    expect(renamed.icon).toBe("rocket");
    expect(service.getNode(workspace.rootNodeId).title).toBe("Personal");

    service.deleteWorkspace(workspace.id);

    expect(service.listWorkspaces()).toEqual([]);
  });

  it("groups workspaces in folders and clears folder assignments when folders are deleted", () => {
    const folder = service.createWorkspaceFolder("Clients");
    const workspace = service.createWorkspace("Acme", "briefcase-business", folder.id);

    expect(workspace.folderId).toBe(folder.id);
    expect(service.listWorkspaceFolders().map(item => item.name)).toEqual(["Clients"]);

    const otherFolder = service.createWorkspaceFolder("Archive");
    const moved = service.updateWorkspace(workspace.id, { folderId: otherFolder.id });
    expect(moved.folderId).toBe(otherFolder.id);

    service.deleteWorkspaceFolder(otherFolder.id);
    expect(service.getWorkspace(workspace.id).folderId).toBeNull();
  });

  it("nests workspaces, prevents cycles, and promotes children when deleting a parent", () => {
    const before = service.createWorkspace("Before");
    const parent = service.createWorkspace("Parent");
    const child = service.createWorkspace("Child");
    const after = service.createWorkspace("After");

    const nested = service.updateWorkspace(child.id, { parentWorkspaceId: parent.id } as never);
    expect((nested as typeof nested & { parentWorkspaceId: string | null }).parentWorkspaceId).toBe(parent.id);
    expect(nested.folderId).toBeNull();
    expect(() => service.moveWorkspace(parent.id, null, 0, child.id)).toThrow("cannot be moved into its descendant");

    service.deleteWorkspace(parent.id);

    const workspaces = service.listWorkspaces();
    expect(workspaces.map(workspace => workspace.name)).toEqual([before.name, child.name, after.name]);
    expect(workspaces.map(workspace => workspace.position)).toEqual([0, 1, 2]);
    expect(service.getWorkspace(child.id).parentWorkspaceId).toBeNull();
  });

  it("moves workspaces within the root workspace list", () => {
    const alpha = service.createWorkspace("Alpha");
    const beta = service.createWorkspace("Beta");
    const gamma = service.createWorkspace("Gamma");

    service.moveWorkspace(gamma.id, null, 0);

    const workspaces = service.listWorkspaces();
    expect(workspaces.map(workspace => workspace.name)).toEqual(["Gamma", "Alpha", "Beta"]);
    expect(workspaces.map(workspace => workspace.position)).toEqual([0, 1, 2]);
    expect(service.getWorkspace(alpha.id).position).toBe(1);
    expect(service.getWorkspace(beta.id).position).toBe(2);
  });

  it("moves workspaces inside folders and across folder boundaries", () => {
    const folder = service.createWorkspaceFolder("Projects");
    const alpha = service.createWorkspace("Alpha", undefined, folder.id);
    const beta = service.createWorkspace("Beta", undefined, folder.id);
    const gamma = service.createWorkspace("Gamma", undefined, folder.id);
    const root = service.createWorkspace("Root");

    service.moveWorkspace(gamma.id, folder.id, 0);
    service.moveWorkspace(root.id, folder.id, 1);
    service.moveWorkspace(alpha.id, null, 0);

    const folderWorkspaces = service.listWorkspaces().filter(workspace => workspace.folderId === folder.id);
    const rootWorkspaces = service.listWorkspaces().filter(workspace => workspace.folderId === null);
    expect(folderWorkspaces.map(workspace => workspace.name)).toEqual(["Gamma", "Root", "Beta"]);
    expect(folderWorkspaces.map(workspace => workspace.position)).toEqual([0, 1, 2]);
    expect(rootWorkspaces.map(workspace => workspace.name)).toEqual(["Alpha"]);
    expect(rootWorkspaces.map(workspace => workspace.position)).toEqual([0]);
  });

  it("creates a workspace under a named folder", () => {
    const workspace = service.createWorkspaceInFolder("Launch Plan", "Projects", "rocket");

    const folder = service.listWorkspaceFolders()[0];
    expect(folder.name).toBe("Projects");
    expect(workspace.name).toBe("Launch Plan");
    expect(workspace.icon).toBe("rocket");
    expect(workspace.folderId).toBe(folder.id);
    expect(service.getNode(workspace.rootNodeId).title).toBe("Launch Plan");
  });

  it("reuses an existing folder when creating a workspace under a named folder", () => {
    const folder = service.createWorkspaceFolder("Projects");

    const workspace = service.createWorkspaceInFolder("Roadmap", "Projects");

    expect(service.listWorkspaceFolders()).toHaveLength(1);
    expect(workspace.folderId).toBe(folder.id);
  });

  it("updates and deletes tags", () => {
    const workspace = service.createWorkspace("Tags");
    const node = service.createNode({ parentId: workspace.rootNodeId, title: "Tagged" });
    const tag = service.setNodeTag(node.id, "project");
    const renamed = service.updateTag(tag.id, { name: "area" });

    expect(renamed.name).toBe("area");
    expect(service.getTree(workspace.rootNodeId).children[0].tags[0].name).toBe("area");

    service.deleteTag(tag.id);

    expect(service.getTree(workspace.rootNodeId).children[0].tags).toEqual([]);
  });

  it("lists tagged nodes across workspaces by tag name", () => {
    const firstWorkspace = service.createWorkspace("First");
    const secondWorkspace = service.createWorkspace("Second");
    const firstNode = service.createNode({ parentId: firstWorkspace.rootNodeId, title: "Alpha" });
    const secondNode = service.createNode({ parentId: secondWorkspace.rootNodeId, title: "Beta" });
    const otherNode = service.createNode({ parentId: secondWorkspace.rootNodeId, title: "Gamma" });
    const deletedNode = service.createNode({ parentId: firstWorkspace.rootNodeId, title: "Deleted" });

    service.setNodeTag(firstNode.id, "project");
    service.setNodeTag(firstNode.id, "active");
    service.setNodeTag(secondNode.id, "project");
    service.setNodeTag(otherNode.id, "area");
    service.setNodeTag(deletedNode.id, "project");
    service.deleteNode(deletedNode.id);

    const results = service.listNodesByTagName("project");

    expect(results.map(result => result.node.title).sort()).toEqual(["Alpha", "Beta"]);
    expect(results.map(result => result.workspace.name).sort()).toEqual(["First", "Second"]);
    expect(results.find(result => result.node.id === firstNode.id)?.tags.map(tag => tag.name)).toEqual([
      "active",
      "project"
    ]);
  });

  it("migrates older workspaces with default icons", () => {
    const dbPath = join(tempDir, "old.sqlite");
    const oldDb = new DatabaseSync(dbPath);
    oldDb.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        root_node_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO workspaces (id, name, root_node_id, created_at, updated_at)
      VALUES ('workspace', 'Old', 'root', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    `);
    oldDb.close();

    const migratedDb = openDatabase(dbPath);
    try {
      const migratedService = new OutlinerService(migratedDb);
      expect(migratedService.listWorkspaces()[0].icon).toBe("folder-tree");
    } finally {
      migratedDb.close();
    }
  });
});

describe("tree operations", () => {
  it("ignores Enter shortcuts while an IME composition is active", () => {
    expect(shouldIgnoreTextInputKeyDown({ key: "Enter", isComposing: true })).toBe(true);
    expect(shouldIgnoreTextInputKeyDown({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(true);
    expect(shouldIgnoreTextInputKeyDown({ key: "Enter", nativeEvent: { keyCode: 229 } })).toBe(true);
    expect(shouldIgnoreTextInputKeyDown({ key: "Enter" })).toBe(false);
  });

  it("splits node titles at the selection start", () => {
    expect(splitTitleAtSelection("Alpha Beta", 6)).toEqual({
      currentTitle: "Alpha ",
      nextTitle: "Beta"
    });
    expect(splitTitleAtSelection("Alpha Beta", 0)).toEqual({
      currentTitle: "",
      nextTitle: "Alpha Beta"
    });
    expect(splitTitleAtSelection("Alpha Beta", 99)).toEqual({
      currentTitle: "Alpha Beta",
      nextTitle: ""
    });
  });

  it("inserts and replaces optimistic nodes while preserving sibling positions", () => {
    const tree = testTree();
    const inserted = insertTreeNode(tree, "root", testNode("temp-1", "Temp", "root"), 1);
    const replaced = replaceTreeNode(inserted, "temp-1", testNode("real-1", "Real", "root"));

    expect(inserted.children.map(node => node.id)).toEqual(["a", "temp-1", "b"]);
    expect(inserted.children.map(node => node.position)).toEqual([0, 1, 2]);
    expect(replaced.children.map(node => node.id)).toEqual(["a", "real-1", "b"]);
    expect(replaced.children[1].title).toBe("Real");
  });

  it("preserves a split title patch while inserting the next node", () => {
    const tree = testTree();
    const patched = updateTreeNode(tree, "a", { title: "配置" });
    const inserted = insertTreeNode(patched, "root", testNode("temp-1", "核查", "root"), 1);

    expect(inserted.children.map(node => node.title)).toEqual(["配置", "核查", "Beta"]);
  });

  it("removes a subtree and normalizes remaining siblings", () => {
    const tree = testTree();
    const next = removeTreeNode(tree, "a");

    expect(next.children.map(node => node.id)).toEqual(["b"]);
    expect(next.children[0].position).toBe(0);
  });

  it("moves nodes across parents and preserves the moved subtree", () => {
    const tree = testTree();
    const next = moveTreeNode(tree, "a", "b", 0);

    expect(next.children.map(node => node.id)).toEqual(["b"]);
    expect(next.children[0].children.map(node => node.id)).toEqual(["a"]);
    expect(next.children[0].children[0].children[0].id).toBe("a-child");
    expect(next.children[0].children[0].parentId).toBe("b");
  });

  it("moves flat tree nodes without dropping descendants", () => {
    const { state } = fromNestedTree(testTree());
    const next = moveFlatNode(state, "a", "b", 0);

    expect(next.nodes["a"].parentId).toBe("b");
    expect(next.nodes["a-child"].parentId).toBe("a");
    expect(next.nodes["a"].childIds).toEqual(["a-child"]);
    expect(next.nodes["b"].childIds).toEqual(["a"]);
    expect(computeVisibleIds(next)).toEqual(["b", "a", "a-child"]);
  });

  it("moves flat tree nodes inside a target without dropping existing target content", () => {
    const { state } = fromNestedTree({
      ...testTree(),
      children: [
        testNode("a", "Unsaved local Alpha", "root", 0),
        {
          ...testNode("b", "Beta", "root", 1),
          collapsed: true,
          children: [testNode("b-child", "Existing child", "b", 0)]
        }
      ]
    });

    const next = moveNodeInside(state, "a", "b");

    expect(next.nodes["a"].title).toBe("Unsaved local Alpha");
    expect(next.nodes["a"].parentId).toBe("b");
    expect(next.nodes["b"].collapsed).toBe(false);
    expect(next.nodes["b"].childIds).toEqual(["b-child", "a"]);
    expect(next.nodes["b-child"].title).toBe("Existing child");
    expect(computeVisibleIds(next)).toEqual(["b", "b-child", "a"]);
  });

  it("replaces optimistic flat tree nodes without losing local moves", () => {
    const { state } = fromNestedTree({
      ...testTree(),
      children: [
        testNode("a", "Alpha", "root", 0),
        testNode("temp-new", "Draft", "root", 1)
      ]
    });
    const moved = moveFlatNode(state, "temp-new", "a", 0);

    const next = replaceNode(moved, "temp-new", {
      ...moved.nodes["temp-new"],
      id: "created-new"
    });

    expect(next.nodes["created-new"].parentId).toBe("a");
    expect(next.nodes["created-new"].position).toBe(0);
    expect(next.nodes["a"].childIds).toEqual(["created-new"]);
    expect(next.nodes["temp-new"]).toBeUndefined();
    expect(computeVisibleIds(next)).toEqual(["a", "created-new"]);
  });
});

describe("import/export", () => {
  it("round-trips Markdown hierarchy", () => {
    const workspace = service.createWorkspace("Markdown");

    importMarkdown(service, {
      workspaceId: workspace.id,
      content: ["- Alpha", "  - Beta", "- [x] Gamma"].join("\n")
    });

    const exported = exportMarkdown(service, workspace.id);

    expect(exported).toContain("- Alpha");
    expect(exported).toContain("  - Beta");
    expect(exported).toContain("- [x] Gamma");
  });

  it("round-trips Markdown body, tags, and exported workspace heading", () => {
    const workspace = service.createWorkspace("Markdown Details");
    const alpha = service.createNode({
      parentId: workspace.rootNodeId,
      title: "Alpha",
      body: "First line\nSecond line",
      done: true
    });
    service.setNodeTag(alpha.id, "project");
    service.createNode({ parentId: alpha.id, title: "Beta" });
    const emptyWrapper = service.createNode({ parentId: workspace.rootNodeId, title: "" });
    service.createNode({ parentId: emptyWrapper.id, title: "Promoted" });

    const exported = exportMarkdown(service, workspace.id);
    const importedWorkspace = service.createWorkspace("Markdown Details");
    const result = importMarkdown(service, {
      workspaceId: importedWorkspace.id,
      content: exported
    });
    const tree = service.getTree(importedWorkspace.rootNodeId);

    expect(exported).not.toContain("- \n");
    expect(result.imported).toBe(3);
    expect(tree.children.map(node => node.title)).toEqual(["Alpha", "Promoted"]);
    expect(tree.children[0].done).toBe(true);
    expect(tree.children[0].body).toBe("First line\nSecond line");
    expect(tree.children[0].tags[0].name).toBe("project");
    expect(tree.children[0].children[0].title).toBe("Beta");
  });

  it("exports all workspaces as Markdown and imports by replacing all workspaces", () => {
    const first = service.createWorkspace("First Workspace");
    const firstNode = service.createNode({ parentId: first.rootNodeId, title: "Alpha", done: true });
    service.setNodeTag(firstNode.id, "project");
    service.createNode({ parentId: firstNode.id, title: "Beta" });
    const second = service.createWorkspace("Second Workspace");
    service.createNode({ parentId: second.rootNodeId, title: "Gamma" });

    const exported = exportMarkdown(service);
    service.createWorkspace("Stale Workspace");
    const result = importMarkdown(service, { content: exported });
    const workspaces = service.listWorkspaces();
    const importedFirst = service.getTree(workspaces[0].rootNodeId);

    expect(exported).toContain("# First Workspace");
    expect(exported).toContain("# Second Workspace");
    expect(result.imported).toBe(3);
    expect(result.workspaces).toBe(2);
    expect(workspaces.map(workspace => workspace.name)).toEqual(["First Workspace", "Second Workspace"]);
    expect(importedFirst.children[0].title).toBe("Alpha");
    expect(importedFirst.children[0].done).toBe(true);
    expect(importedFirst.children[0].tags[0].name).toBe("project");
    expect(importedFirst.children[0].children[0].title).toBe("Beta");
  });

  it("imports and exports OPML hierarchy", () => {
    const workspace = service.createWorkspace("OPML");

    importOpml(service, {
      workspaceId: workspace.id,
      content:
        '<opml version="2.0"><body><outline text="Alpha"><outline text="Beta" /></outline></body></opml>'
    });

    const root = service.getTree(workspace.rootNodeId);
    const exported = exportOpml(service, workspace.id);

    expect(root.children[0].children[0].title).toBe("Beta");
    expect(exported).toContain('text="Alpha"');
    expect(exported).toContain('text="Beta"');
  });

  it("exports OPML without empty outline nodes and preserves notes", () => {
    const workspace = service.createWorkspace("OPML Export");
    const emptyWrapper = service.createNode({ parentId: workspace.rootNodeId, title: "" });
    service.createNode({
      parentId: emptyWrapper.id,
      title: "Nested",
      body: "Details",
      done: true
    });
    service.createNode({ parentId: workspace.rootNodeId, title: "" });

    const exported = exportOpml(service, workspace.id);
    const result = importOpml(service, { content: exported });
    const imported = service.getTree(service.getWorkspace(result.workspaceId).rootNodeId);

    expect(exported).not.toContain('text=""');
    expect(exported).toContain('text="Nested"');
    expect(exported).toContain('_note="Details"');
    expect(result.imported).toBe(1);
    expect(imported.children[0].title).toBe("Nested");
    expect(imported.children[0].done).toBe(true);
    expect(imported.children[0].body).toBe("Details");
  });

  it("exports all workspaces as OPML and imports by replacing all workspaces", () => {
    const first = service.createWorkspace("OPML One", "rocket");
    const firstNode = service.createNode({ parentId: first.rootNodeId, title: "Alpha", body: "Details" });
    service.setNodeTag(firstNode.id, "area");
    const second = service.createWorkspace("OPML Two", "sun");
    service.createNode({ parentId: second.rootNodeId, title: "Beta" });

    const exported = exportOpml(service);
    service.createWorkspace("Stale OPML");
    const result = importOpml(service, { content: exported });
    const workspaces = service.listWorkspaces();
    const importedFirst = service.getTree(workspaces[0].rootNodeId);

    expect(exported).toContain('openoutlinerWorkspace="true"');
    expect(result.imported).toBe(2);
    expect(result.workspaces).toBe(2);
    expect(workspaces.map(workspace => workspace.name)).toEqual(["OPML One", "OPML Two"]);
    expect(workspaces.map(workspace => workspace.icon)).toEqual(["rocket", "sun"]);
    expect(importedFirst.children[0].title).toBe("Alpha");
    expect(importedFirst.children[0].body).toBe("Details");
    expect(importedFirst.children[0].tags[0].name).toBe("area");
  });

  it("imports OPML into a new workspace and skips empty wrapper outlines", () => {
    const result = importOpml(service, {
      content: [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<opml version="2.0">',
        "<head><title>Study</title></head>",
        "<body>",
        '<outline text="万卷书" done="false">',
        '<outline text="了凡四训" done="false"/>',
        '<outline text="数学之美" done="false"/>',
        "</outline>",
        '<outline text="O R&apos;eilly" done="false"/>',
        '<outline text="AI" done="false">',
        '<outline text="" done="false">',
        '<outline text="AI变现" done="false">',
        '<outline text="OpenOutliner" done="false"/>',
        "</outline>",
        "</outline>",
        "</outline>",
        '<outline text="" done="false"/>',
        "</body>",
        "</opml>"
      ].join("")
    });

    const workspace = service.getWorkspace(result.workspaceId);
    const tree = service.getTree(workspace.rootNodeId);
    const ai = tree.children.find(node => node.title === "AI");

    expect(workspace.name).toBe("Study");
    expect(result.imported).toBe(7);
    expect(tree.children.map(node => node.title)).toEqual(["万卷书", "O R'eilly", "AI"]);
    expect(ai?.children[0].title).toBe("AI变现");
    expect(ai?.children[0].children[0].title).toBe("OpenOutliner");
  });
});

describe("workspace creation request body", () => {
  it("uses an explicit folder id when creating a workspace for a folder", () => {
    expect(createWorkspaceRequestBody(null, "project-folder")).toMatchObject({
      name: "Untitled Workspace",
      folderId: "project-folder"
    });
  });

  it("creates a child of the selected workspace when no explicit container is provided", () => {
    expect(createWorkspaceRequestBody({ id: "current-workspace", folderId: "current-folder" }, undefined)).toMatchObject({
      name: "Untitled Workspace",
      folderId: null,
      parentWorkspaceId: "current-workspace"
    });
  });
});

describe("workspace folder collapse state", () => {
  it("toggles folder ids in the collapsed set", () => {
    const collapsed = nextCollapsedWorkspaceFolderIds(new Set<string>(), "folder-a");
    expect([...collapsed]).toEqual(["folder-a"]);
    expect([...nextCollapsedWorkspaceFolderIds(collapsed, "folder-a")]).toEqual([]);
  });
});

describe("workspace hierarchy collapse state", () => {
  it("toggles parent workspace ids in the collapsed set", () => {
    const collapsed = nextCollapsedWorkspaceIds(new Set<string>(), "workspace-a");
    expect([...collapsed]).toEqual(["workspace-a"]);
    expect([...nextCollapsedWorkspaceIds(collapsed, "workspace-a")]).toEqual([]);
  });
});

describe("direct child count label", () => {
  it("returns a label only for nodes with direct children", () => {
    expect(getChildCountLabel(3)).toBe("3");
    expect(getChildCountLabel(0)).toBeNull();
  });
});

describe("node date label", () => {
  it("formats stored ISO dates for the compact date chip", () => {
    expect(formatNodeDate("2026-07-18")).toBe("2026/07/18");
  });
});

function testTree(): OutlineTreeNode {
  return {
    ...testNode("root", "Root", null),
    children: [
      {
        ...testNode("a", "Alpha", "root", 0),
        children: [testNode("a-child", "Nested", "a")]
      },
      testNode("b", "Beta", "root", 1)
    ]
  };
}

function testNode(
  id: string,
  title: string,
  parentId: string | null,
  position = 0
): OutlineTreeNode {
  return {
    id,
    workspaceId: "workspace",
    parentId,
    position,
    title,
    body: "",
    done: false,
    collapsed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    tags: [],
    fieldValues: [],
    children: []
  };
}
