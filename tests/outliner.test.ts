import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type OpenOutlinerDb } from "../src/backend/db/database.js";
import { exportMarkdown, importMarkdown } from "../src/backend/importExport/markdown.js";
import { exportOpml, importOpml } from "../src/backend/importExport/opml.js";
import {
  morandiTagColors,
  OutlinerService,
  tagColorForName
} from "../src/backend/services/outliner.js";
import type { OutlineTreeNode, Tag, TaggedNodeGroup, TaggedNodeResult } from "../src/web/api.js";
import {
  addOptimisticNodeTag,
  applyCachedNodeTitles,
  applyMarkdownLink,
  applyPastedMarkdownLink,
  applyMarkdownStyle,
  applyMarkdownTextColor,
  buildSystemTagRows,
  clampPanelWidth,
  createWorkspaceRequestBody,
  formatNodeDate,
  getChildCountLabel,
  getNodeEnterAction,
  getOutlineHistoryShortcut,
  getNodeSelectionPosition,
  getNodeSelectionRange,
  isPastedMarkdownLink,
  normalizeLinkHref,
  nextWorkspaceIdAfterDelete,
  nextCollapsedWorkspaceIds,
  resolvePendingNodeTitle,
  resolveStoredBoolean,
  resolveStoredIdSet,
  resolveTitleSelection,
  reconcileOptimisticNodeTag,
  revealNodeInFlatTree,
  removeOptimisticNodeTag,
  NodeCompositionTracker,
  isMarkdownThematicBreak,
  remarkLiteralHtml,
  shouldIgnoreTextInputKeyDown,
  shouldHandleMultiSelectionDelete,
  shouldHandleMultiSelectionTab,
  nextCollapsedWorkspaceFolderIds,
  splitMarkdownHighlights,
  splitMarkdownTextColors,
  splitTitleAtSelection,
  upsertWorkspaceTag
} from "../src/web/App.js";
import {
  fromNestedTree,
  getIndentTargetId,
  getTopLevelNodeIds,
  insertNode,
  moveNode as moveFlatNode,
  moveNodes as moveFlatNodes,
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
  it("persists create undo and redo across a service restart", () => {
    const dbPath = join(tempDir, "test.sqlite");
    const workspace = service.createWorkspace("Persistent History");
    const alpha = service.createNode({ parentId: workspace.rootNodeId, title: "Alpha" });

    expect(service.getOutlineHistoryState(workspace.id)).toMatchObject({
      canUndo: true,
      canRedo: false,
      undoLabel: "Create outline"
    });

    db.close();
    db = openDatabase(dbPath);
    service = new OutlinerService(db);

    const undone = service.undoOutline(workspace.id);
    expect(undone.tree.children).toEqual([]);
    expect(undone.history).toMatchObject({ canUndo: false, canRedo: true });
    expect(() => service.getNode(alpha.id)).toThrow("Node not found");

    const redone = service.redoOutline(workspace.id);
    expect(redone.tree.children.map(node => node.title)).toEqual(["Alpha"]);
    expect(redone.history).toMatchObject({ canUndo: true, canRedo: false });
    expect(service.getNode(alpha.id).id).toBe(alpha.id);
  });

  it("coalesces consecutive text edits and clears redo after a new edit", () => {
    const workspace = service.createWorkspace("Text History");
    const node = service.createNode({ parentId: workspace.rootNodeId, title: "Original" });

    service.updateNode(node.id, { title: "Original" });
    expect(service.getOutlineHistoryState(workspace.id).undoLabel).toBe("Create outline");

    service.updateNode(node.id, { title: "Draft" });
    service.updateNode(node.id, { title: "Final" });
    expect(service.getOutlineHistoryState(workspace.id).undoLabel).toBe("Edit title");

    service.undoOutline(workspace.id);
    expect(service.getNode(node.id).title).toBe("Original");
    expect(service.getOutlineHistoryState(workspace.id).canRedo).toBe(true);

    service.updateNode(node.id, { body: "New notes" });
    expect(service.getOutlineHistoryState(workspace.id).canRedo).toBe(false);
    service.undoOutline(workspace.id);
    expect(service.getNode(node.id).body).toBe("");
  });

  it("undoes and redoes subtree deletion and ordered multi-node moves", () => {
    const workspace = service.createWorkspace("Structural History");
    const alpha = service.createNode({ parentId: workspace.rootNodeId, title: "Alpha" });
    const child = service.createNode({ parentId: alpha.id, title: "Child" });
    const beta = service.createNode({ parentId: workspace.rootNodeId, title: "Beta" });
    const target = service.createNode({ parentId: workspace.rootNodeId, title: "Target" });

    service.moveNodes([alpha.id, beta.id], target.id, 0, true);
    expect(service.listChildren(target.id).map(node => node.title)).toEqual(["Alpha", "Beta"]);
    service.undoOutline(workspace.id);
    expect(service.listChildren(workspace.rootNodeId).map(node => node.title)).toEqual(["Alpha", "Beta", "Target"]);
    expect(service.listChildren(target.id)).toEqual([]);
    service.redoOutline(workspace.id);
    expect(service.listChildren(target.id).map(node => node.title)).toEqual(["Alpha", "Beta"]);

    service.deleteNode(alpha.id);
    expect(() => service.getNode(child.id)).toThrow("Node not found");
    service.undoOutline(workspace.id);
    expect(service.getNode(alpha.id).title).toBe("Alpha");
    expect(service.getNode(child.id).title).toBe("Child");
    service.redoOutline(workspace.id);
    expect(() => service.getNode(alpha.id)).toThrow("Node not found");
    expect(() => service.getNode(child.id)).toThrow("Node not found");
  });

  it("deletes a selected group in one undoable history entry", () => {
    const workspace = service.createWorkspace("Batch Delete");
    const alpha = service.createNode({ parentId: workspace.rootNodeId, title: "Alpha" });
    const child = service.createNode({ parentId: alpha.id, title: "Alpha child" });
    const beta = service.createNode({ parentId: workspace.rootNodeId, title: "Beta" });
    const gamma = service.createNode({ parentId: workspace.rootNodeId, title: "Gamma" });

    const result = service.deleteNodes([alpha.id, child.id, gamma.id]);

    expect(new Set(result.deleted)).toEqual(new Set([alpha.id, child.id, gamma.id]));
    expect(service.listChildren(workspace.rootNodeId).map(node => node.title)).toEqual(["Beta"]);
    expect(service.getOutlineHistoryState(workspace.id).undoLabel).toBe("Delete outline");

    service.undoOutline(workspace.id);
    expect(service.listChildren(workspace.rootNodeId).map(node => node.title)).toEqual(["Alpha", "Beta", "Gamma"]);
    expect(service.getNode(child.id).parentId).toBe(alpha.id);
  });

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

  it("moves multiple nodes together in one ordered batch", () => {
    const workspace = service.createWorkspace("Batch Move");
    const alpha = service.createNode({ parentId: workspace.rootNodeId, title: "Alpha" });
    const beta = service.createNode({ parentId: workspace.rootNodeId, title: "Beta" });
    const gamma = service.createNode({ parentId: workspace.rootNodeId, title: "Gamma" });
    const delta = service.createNode({ parentId: workspace.rootNodeId, title: "Delta" });
    service.updateNode(delta.id, { collapsed: true });

    service.moveNodes([beta.id, gamma.id], workspace.rootNodeId, 0);
    expect(service.listChildren(workspace.rootNodeId).map(node => node.title)).toEqual([
      "Beta",
      "Gamma",
      "Alpha",
      "Delta"
    ]);

    service.moveNodes([beta.id, gamma.id], delta.id, 0, true);
    expect(service.listChildren(workspace.rootNodeId).map(node => node.title)).toEqual(["Alpha", "Delta"]);
    expect(service.listChildren(delta.id).map(node => node.title)).toEqual(["Beta", "Gamma"]);
    expect(service.getNode(delta.id).collapsed).toBe(false);
  });

  it("moves only the selected top-level ancestor when its descendant is also selected", () => {
    const workspace = service.createWorkspace("Ancestor Batch Move");
    const parent = service.createNode({ parentId: workspace.rootNodeId, title: "Parent" });
    const child = service.createNode({ parentId: parent.id, title: "Child" });
    const sibling = service.createNode({ parentId: workspace.rootNodeId, title: "Sibling" });

    service.moveNodes([parent.id, child.id], workspace.rootNodeId, 1);

    expect(service.listChildren(workspace.rootNodeId).map(node => node.title)).toEqual(["Sibling", "Parent"]);
    expect(service.listChildren(parent.id).map(node => node.title)).toEqual(["Child"]);
    expect(service.getNode(child.id).parentId).toBe(parent.id);
  });

  it("rolls back a batch when its destination is inside a selected subtree", () => {
    const workspace = service.createWorkspace("Invalid Batch Move");
    const parent = service.createNode({ parentId: workspace.rootNodeId, title: "Parent" });
    const child = service.createNode({ parentId: parent.id, title: "Child" });
    const sibling = service.createNode({ parentId: workspace.rootNodeId, title: "Sibling" });

    expect(() => service.moveNodes([parent.id, sibling.id], child.id, 0)).toThrow("descendants");
    expect(service.listChildren(workspace.rootNodeId).map(node => node.title)).toEqual(["Parent", "Sibling"]);
    expect(service.listChildren(parent.id).map(node => node.title)).toEqual(["Child"]);
  });

  it("moves a complete subtree to another workspace without losing metadata", () => {
    const source = service.createWorkspace("Source");
    const target = service.createWorkspace("Target");
    const before = service.createNode({ parentId: source.rootNodeId, title: "Before" });
    const project = service.createNode({
      parentId: source.rootNodeId,
      title: "Project",
      body: "Project notes",
      done: true
    });
    const after = service.createNode({ parentId: source.rootNodeId, title: "After" });
    const child = service.createNode({ parentId: project.id, title: "Child" });
    const existing = service.createNode({ parentId: target.rootNodeId, title: "Existing" });
    service.updateNode(project.id, { dueDate: "2026-08-15", collapsed: true });

    const sourceTag = service.setNodeTag(child.id, "project");
    const sourceField = service.createFieldDefinition({
      workspaceId: source.id,
      tagId: sourceTag.id,
      name: "Status",
      type: "select",
      options: "todo,done"
    });
    service.setFieldValue(child.id, sourceField.id, "done");

    const targetTag = service.createTag(target.id, "project", "#123456");
    service.createFieldDefinition({
      workspaceId: target.id,
      tagId: targetTag.id,
      name: "Status",
      type: "text"
    });

    service.moveNodesToWorkspace([project.id], target.id);

    expect(service.listChildren(source.rootNodeId).map(node => ({ id: node.id, position: node.position }))).toEqual([
      { id: before.id, position: 0 },
      { id: after.id, position: 1 }
    ]);
    expect(service.listChildren(target.rootNodeId).map(node => ({ id: node.id, position: node.position }))).toEqual([
      { id: existing.id, position: 0 },
      { id: project.id, position: 1 }
    ]);

    const targetTree = service.getTree(target.rootNodeId);
    const movedProject = targetTree.children[1];
    expect(movedProject).toMatchObject({
      id: project.id,
      workspaceId: target.id,
      parentId: target.rootNodeId,
      body: "Project notes",
      dueDate: "2026-08-15",
      done: true,
      collapsed: true
    });
    expect(movedProject.children[0]).toMatchObject({ id: child.id, workspaceId: target.id });
    expect(movedProject.children[0].tags).toEqual([
      expect.objectContaining({ id: targetTag.id, workspaceId: target.id, name: "project" })
    ]);

    const targetFields = service.listFieldDefinitions(target.id);
    expect(targetFields.map(field => ({ name: field.name, type: field.type, options: field.options }))).toEqual([
      { name: "Status", type: "text", options: null },
      { name: "Status (Source)", type: "select", options: "todo,done" }
    ]);
    const migratedField = targetFields.find(field => field.name === "Status (Source)");
    expect(service.listFieldValues(child.id)).toEqual([
      expect.objectContaining({ fieldId: migratedField?.id, value: "done" })
    ]);
  });

  it("moves selected ancestors once and preserves their requested order across workspaces", () => {
    const source = service.createWorkspace("Source batch");
    const target = service.createWorkspace("Target batch");
    const parent = service.createNode({ parentId: source.rootNodeId, title: "Parent" });
    const child = service.createNode({ parentId: parent.id, title: "Child" });
    const sibling = service.createNode({ parentId: source.rootNodeId, title: "Sibling" });

    service.moveNodesToWorkspace([sibling.id, parent.id, child.id], target.id);

    expect(service.listChildren(source.rootNodeId)).toEqual([]);
    expect(service.listChildren(target.rootNodeId).map(node => node.title)).toEqual(["Sibling", "Parent"]);
    expect(service.listChildren(parent.id).map(node => node.title)).toEqual(["Child"]);
    expect(service.getNode(child.id).workspaceId).toBe(target.id);
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

  it("converts a node subtree into a child workspace without losing metadata", () => {
    const source = service.createWorkspace("Source", "rocket");
    const before = service.createNode({ parentId: source.rootNodeId, title: "Before" });
    const project = service.createNode({
      parentId: source.rootNodeId,
      title: "Project",
      body: "Project notes",
      done: true
    });
    const after = service.createNode({ parentId: source.rootNodeId, title: "After" });
    const child = service.createNode({ parentId: project.id, title: "Child" });
    const grandchild = service.createNode({ parentId: child.id, title: "Grandchild" });
    service.updateNode(project.id, { dueDate: "2026-08-02", collapsed: true });
    const tag = service.setNodeTag(child.id, "project");
    const field = service.createFieldDefinition({
      workspaceId: source.id,
      tagId: tag.id,
      name: "Status",
      type: "select",
      options: "todo,done"
    });
    service.setFieldValue(grandchild.id, field.id, "done");

    const converted = service.convertNodeToWorkspace(project.id);
    const convertedTree = service.getTree(converted.rootNodeId);

    expect(converted.name).toBe("Project");
    expect(converted.icon).toBe("layers");
    expect(converted.parentWorkspaceId).toBe(source.id);
    expect(converted.folderId).toBeNull();
    expect(converted.rootNodeId).toBe(project.id);
    expect(convertedTree).toMatchObject({
      id: project.id,
      workspaceId: converted.id,
      parentId: null,
      position: 0,
      body: "Project notes",
      dueDate: "2026-08-02",
      done: true,
      collapsed: true
    });
    expect(convertedTree.children[0].id).toBe(child.id);
    expect(convertedTree.children[0].workspaceId).toBe(converted.id);
    expect(convertedTree.children[0].tags[0]).toMatchObject({ name: "project", workspaceId: converted.id });
    expect(convertedTree.children[0].children[0]).toMatchObject({
      id: grandchild.id,
      workspaceId: converted.id
    });
    expect(convertedTree.children[0].children[0].fieldValues[0]).toMatchObject({ value: "done" });
    expect(convertedTree.children[0].children[0].fieldValues[0].fieldId).not.toBe(field.id);
    expect(service.listFieldDefinitions(converted.id)).toEqual([
      expect.objectContaining({ workspaceId: converted.id, name: "Status", type: "select", options: "todo,done" })
    ]);
    expect(service.listChildren(source.rootNodeId).map(node => ({ id: node.id, position: node.position }))).toEqual([
      { id: before.id, position: 0 },
      { id: after.id, position: 1 }
    ]);
  });

  it("rejects converting a workspace root node", () => {
    const workspace = service.createWorkspace("Root guard");
    expect(() => service.convertNodeToWorkspace(workspace.rootNodeId)).toThrow(
      "Workspace root nodes cannot be converted."
    );
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

  it("builds live tag groups across workspaces without empty or deleted results", () => {
    const firstWorkspace = service.createWorkspace("First");
    const secondWorkspace = service.createWorkspace("Second");
    const firstNode = service.createNode({ parentId: firstWorkspace.rootNodeId, title: "Alpha" });
    const secondNode = service.createNode({ parentId: secondWorkspace.rootNodeId, title: "Beta" });
    const deletedNode = service.createNode({ parentId: firstWorkspace.rootNodeId, title: "Deleted" });

    const firstProject = service.setNodeTag(firstNode.id, "project");
    service.setNodeTag(firstNode.id, "active");
    service.setNodeTag(secondNode.id, "project");
    service.setNodeTag(deletedNode.id, "project");
    service.createTag(secondWorkspace.id, "unused");
    service.deleteNode(deletedNode.id);

    const groups = service.listTaggedNodeGroups();

    expect(groups.map(group => group.name)).toEqual(["active", "project"]);
    expect(groups.find(group => group.name === "project")?.results.map(result => result.node.title).sort())
      .toEqual(["Alpha", "Beta"]);
    expect(groups.find(group => group.name === "project")?.results.find(result => result.node.id === firstNode.id)?.tags
      .map(tag => tag.name))
      .toEqual(["active", "project"]);

    service.updateTag(firstProject.id, { name: "initiative" });

    const refreshed = service.listTaggedNodeGroups();
    expect(refreshed.map(group => group.name)).toEqual(["active", "initiative", "project"]);
    expect(refreshed.find(group => group.name === "initiative")?.results[0].node.id).toBe(firstNode.id);
    expect(refreshed.find(group => group.name === "project")?.results[0].node.id).toBe(secondNode.id);
  });

  it("assigns stable Morandi colors while preserving custom colors", () => {
    expect(morandiTagColors).toHaveLength(12);
    expect(new Set(morandiTagColors)).toHaveLength(12);
    expect(tagColorForName("#project")).toBe(tagColorForName("project"));

    const workspace = service.createWorkspace("Colors");
    const legacyNode = service.createNode({ parentId: workspace.rootNodeId, title: "Legacy" });
    const customNode = service.createNode({ parentId: workspace.rootNodeId, title: "Custom" });
    service.createTag(workspace.id, "legacy", "#266dd3");
    service.createTag(workspace.id, "custom", "#123456");
    service.setNodeTag(legacyNode.id, "legacy");
    service.setNodeTag(customNode.id, "custom");

    const groups = service.listTaggedNodeGroups();
    expect(groups.find(group => group.name === "legacy")?.color).toBe(tagColorForName("legacy"));
    expect(groups.find(group => group.name === "custom")?.color).toBe("#123456");
  });

  it("returns live breadcrumb paths in original outline order", () => {
    const workspace = service.createWorkspace("Paths");
    const a = service.createNode({ parentId: workspace.rootNodeId, title: "A" });
    const a1 = service.createNode({ parentId: a.id, title: "A1" });
    const a2 = service.createNode({ parentId: a1.id, title: "A2" });
    const b = service.createNode({ parentId: workspace.rootNodeId, title: "B" });

    service.setNodeTag(b.id, "project");
    service.setNodeTag(a2.id, "project");

    const project = service.listTaggedNodeGroups().find(group => group.name === "project");
    expect(project?.results.map(result => result.node.title)).toEqual(["A2", "B"]);
    expect(project?.results[0].path.map(segment => segment.title)).toEqual(["A", "A1", "A2"]);

    service.updateNode(a1.id, { title: "Renamed A1" });
    const refreshed = service.listTaggedNodeGroups().find(group => group.name === "project");
    expect(refreshed?.results[0].path.map(segment => segment.title)).toEqual(["A", "Renamed A1", "A2"]);
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
  it("selects a contiguous visible node range in either direction", () => {
    const visibleIds = ["a", "b", "c", "d"];

    expect(getNodeSelectionRange(visibleIds, "b", "d")).toEqual(["b", "c", "d"]);
    expect(getNodeSelectionRange(visibleIds, "d", "b")).toEqual(["b", "c", "d"]);
  });

  it("falls back to the target when the selection anchor is no longer visible", () => {
    expect(getNodeSelectionRange(["a", "b"], "hidden", "b")).toEqual(["b"]);
    expect(getNodeSelectionRange(["a", "b"], "a", "hidden")).toEqual([]);
  });

  it("groups adjacent selected rows into visual selection blocks", () => {
    const visibleIds = ["a", "b", "c", "d", "e"];
    const selectedIds = new Set(["a", "b", "c", "e"]);

    expect(getNodeSelectionPosition(visibleIds, selectedIds, 0)).toBe("start");
    expect(getNodeSelectionPosition(visibleIds, selectedIds, 1)).toBe("middle");
    expect(getNodeSelectionPosition(visibleIds, selectedIds, 2)).toBe("end");
    expect(getNodeSelectionPosition(visibleIds, selectedIds, 3)).toBeNull();
    expect(getNodeSelectionPosition(visibleIds, selectedIds, 4)).toBe("single");
  });

  it("applies and removes inline Markdown styles around a selection", () => {
    const highlighted = applyMarkdownStyle("Alpha Beta", 6, 10, "highlight");
    expect(highlighted).toEqual({
      value: "Alpha ==Beta==",
      selectionStart: 8,
      selectionEnd: 12
    });

    expect(applyMarkdownStyle(highlighted.value, 8, 12, "highlight")).toEqual({
      value: "Alpha Beta",
      selectionStart: 6,
      selectionEnd: 10
    });
    expect(applyMarkdownStyle("Alpha", 0, 5, "bold").value).toBe("**Alpha**");
    expect(applyMarkdownStyle("`Alpha`", 0, 7, "code").value).toBe("Alpha");
  });

  it("applies, changes, and removes a safe Markdown text color", () => {
    const colored = applyMarkdownTextColor("Alpha Beta", 6, 10, "red");
    expect(colored).toEqual({
      value: "Alpha {{color:red}}Beta{{/color}}",
      selectionStart: 19,
      selectionEnd: 23
    });

    expect(applyMarkdownTextColor(colored.value, 19, 23, "blue")).toEqual({
      value: "Alpha {{color:blue}}Beta{{/color}}",
      selectionStart: 20,
      selectionEnd: 24
    });
    expect(applyMarkdownTextColor("{{color:red}}Beta{{/color}}", 13, 17, null)).toEqual({
      value: "Beta",
      selectionStart: 0,
      selectionEnd: 4
    });
    expect(applyMarkdownTextColor("Alpha", 0, 5, null).value).toBe("Alpha");
  });

  it("creates Markdown links and normalizes safe link destinations", () => {
    expect(applyMarkdownLink("Open docs", 5, 9, "example.com")).toEqual({
      value: "Open [docs](example.com)",
      selectionStart: 6,
      selectionEnd: 10
    });
    expect(normalizeLinkHref("example.com")).toBe("https://example.com");
    expect(normalizeLinkHref("https://example.com/path")).toBe("https://example.com/path");
    expect(normalizeLinkHref("javascript:alert(1)")).toBe("https://javascript:alert(1)");
  });

  it("renders HTML-like node titles as literal text without enabling raw HTML", () => {
    const renderTitle = (value: string) => renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, remarkLiteralHtml] }, value)
    );

    expect(renderTitle("<xx>")).toBe("&lt;xx&gt;");
    expect(renderTitle("before <xx> after")).toBe("<p>before &lt;xx&gt; after</p>");
    expect(renderTitle("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(renderTitle("<https://example.com>")).toBe("<p><a href=\"https://example.com\">https://example.com</a></p>");
  });

  it("keeps Markdown thematic-break-only titles visible as literal text", () => {
    expect(isMarkdownThematicBreak("---")).toBe(true);
    expect(isMarkdownThematicBreak("***")).toBe(true);
    expect(isMarkdownThematicBreak("_ _ _")).toBe(true);
    expect(isMarkdownThematicBreak("  - - -  ")).toBe(true);
    expect(isMarkdownThematicBreak("--")).toBe(false);
    expect(isMarkdownThematicBreak("--- title")).toBe(false);
    expect(isMarkdownThematicBreak("\\---")).toBe(false);
  });

  it("updates existing Markdown links without nesting or duplicating long URLs", () => {
    const href = "https://help.aliyun.com/zh/cloud-network-well-architected-design/alibaba-cloud-ai-network-white-paper";
    const markdownLink = `[${href}](${href})`;

    expect(applyMarkdownLink(markdownLink, 0, markdownLink.length, href)).toEqual({
      value: markdownLink,
      selectionStart: 1,
      selectionEnd: href.length + 1
    });
    expect(applyMarkdownLink("AI white paper", 0, 14, markdownLink)).toEqual({
      value: `[AI white paper](${href})`,
      selectionStart: 1,
      selectionEnd: 15
    });
    expect(applyMarkdownLink("[docs](https://old.example/a_(b))", 0, 34, "https://new.example").value)
      .toBe("[docs](https://new.example)");
  });

  it("turns a pasted URL into a Markdown link when text is selected", () => {
    expect(applyPastedMarkdownLink("Open docs now", 5, 9, "https://example.com/guide")).toEqual({
      value: "Open [docs](https://example.com/guide) now",
      selectionStart: 6,
      selectionEnd: 10
    });
    expect(applyPastedMarkdownLink("Open docs", 5, 9, "docs.example.com/guide")).toEqual({
      value: "Open [docs](https://docs.example.com/guide)",
      selectionStart: 6,
      selectionEnd: 10
    });
  });

  it("keeps ordinary paste behavior for plain text or an empty selection", () => {
    expect(isPastedMarkdownLink("https://example.com/docs")).toBe(true);
    expect(isPastedMarkdownLink("example.com/docs")).toBe(true);
    expect(isPastedMarkdownLink("plain replacement")).toBe(false);
    expect(applyPastedMarkdownLink("Open docs", 5, 9, "plain replacement")).toBeNull();
    expect(applyPastedMarkdownLink("Open docs", 5, 5, "https://example.com/docs")).toBeNull();
  });

  it("splits highlight Markdown without crossing plain text", () => {
    expect(splitMarkdownHighlights("One ==two== three ==four==")).toEqual([
      { value: "One ", highlighted: false },
      { value: "two", highlighted: true },
      { value: " three ", highlighted: false },
      { value: "four", highlighted: true }
    ]);
    expect(splitMarkdownHighlights("plain")).toEqual([{ value: "plain", highlighted: false }]);
  });

  it("splits only supported Markdown text colors", () => {
    expect(splitMarkdownTextColors("One {{color:red}}two{{/color}} three")).toEqual([
      { value: "One ", color: null },
      { value: "two", color: "red" },
      { value: " three", color: null }
    ]);
    expect(splitMarkdownTextColors("{{color:pink}}unsafe{{/color}}")).toEqual([
      { value: "{{color:pink}}unsafe{{/color}}", color: null }
    ]);
  });

  it("ignores Enter shortcuts while an IME composition is active", () => {
    expect(shouldIgnoreTextInputKeyDown({ key: "Enter", isComposing: true })).toBe(true);
    expect(shouldIgnoreTextInputKeyDown({ key: "Enter", nativeEvent: { isComposing: true } })).toBe(true);
    expect(shouldIgnoreTextInputKeyDown({ key: "Enter", nativeEvent: { keyCode: 229 } })).toBe(true);
    expect(shouldIgnoreTextInputKeyDown({ key: "Enter" })).toBe(false);
  });

  it("routes Tab to a completed multi-selection without double handling", () => {
    expect(shouldHandleMultiSelectionTab({ key: "Tab" }, 2, true)).toBe(true);
    expect(shouldHandleMultiSelectionTab({ key: "Tab", defaultPrevented: true }, 2, true)).toBe(false);
    expect(shouldHandleMultiSelectionTab({ key: "Tab", shiftKey: true }, 2, true)).toBe(false);
    expect(shouldHandleMultiSelectionTab({ key: "Tab" }, 1, true)).toBe(false);
    expect(shouldHandleMultiSelectionTab({ key: "Tab" }, 2, false)).toBe(false);
  });

  it("routes Delete to an active outline multi-selection only", () => {
    expect(shouldHandleMultiSelectionDelete({ key: "Delete" }, 2, true, false, false)).toBe(true);
    expect(shouldHandleMultiSelectionDelete({ key: "Delete" }, 2, true, true, true)).toBe(true);
    expect(shouldHandleMultiSelectionDelete({ key: "Delete" }, 2, true, true, false)).toBe(false);
    expect(shouldHandleMultiSelectionDelete({ key: "Delete", defaultPrevented: true }, 2, true, false, false)).toBe(false);
    expect(shouldHandleMultiSelectionDelete({ key: "Backspace" }, 2, true, false, false)).toBe(false);
    expect(shouldHandleMultiSelectionDelete({ key: "Delete" }, 1, true, false, false)).toBe(false);
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

  it("inserts before the whole node when Enter is pressed at the title start", () => {
    expect(getNodeEnterAction("Parent", 0, 0)).toEqual({ type: "insert-before" });
    expect(getNodeEnterAction("Parent", 3, 3)).toEqual({
      type: "split",
      currentTitle: "Par",
      nextTitle: "ent"
    });
  });

  it("creates and focuses the following row when Enter is pressed on an empty node", () => {
    expect(getNodeEnterAction("", 0, 0)).toEqual({
      type: "split",
      currentTitle: "",
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

  it("moves flat tree selections as an ordered group", () => {
    const { state } = fromNestedTree({
      ...testTree(),
      children: [
        testNode("a", "Alpha", "root", 0),
        testNode("b", "Beta", "root", 1),
        testNode("c", "Gamma", "root", 2),
        testNode("d", "Delta", "root", 3)
      ]
    });

    const next = moveFlatNodes(state, ["b", "c"], "root", 0);

    expect(next.nodes.root.childIds).toEqual(["b", "c", "a", "d"]);
    expect(next.nodes.b.position).toBe(0);
    expect(next.nodes.c.position).toBe(1);
  });

  it("indents a selected group under the previous same-level node", () => {
    const { state, visibleIds } = fromNestedTree({
      ...testTree(),
      children: [
        testNode("a", "Alpha", "root", 0),
        testNode("b", "Beta", "root", 1),
        testNode("c", "Gamma", "root", 2)
      ]
    });

    const targetId = getIndentTargetId(state, visibleIds, "b");
    const next = moveFlatNodes(state, ["b", "c"], targetId as string, 0);

    expect(targetId).toBe("a");
    expect(next.nodes.root.childIds).toEqual(["a"]);
    expect(next.nodes.a.childIds).toEqual(["b", "c"]);
    expect(next.nodes.b.parentId).toBe("a");
    expect(next.nodes.c.parentId).toBe("a");
  });

  it("indents only one level when the immediately previous node is deeper", () => {
    const { state, visibleIds } = fromNestedTree(testTree());

    expect(visibleIds).toEqual(["a", "a-child", "b"]);
    expect(getIndentTargetId(state, visibleIds, "b")).toBe("a");
    expect(getIndentTargetId(state, visibleIds, "a-child")).toBeUndefined();

    const next = moveFlatNode(state, "b", "a", state.nodes.a.childIds.length);
    expect(next.nodes.a.childIds).toEqual(["a-child", "b"]);
    expect(next.nodes.b.parentId).toBe("a");
  });

  it("keeps a node subtree together when inserting an empty sibling before it", () => {
    const { state } = fromNestedTree(testTree());
    const next = insertNode(state, "root", {
      ...state.nodes.a,
      id: "temp-before",
      title: "",
      childIds: []
    }, state.nodes.a.position);

    expect(next.nodes.root.childIds).toEqual(["temp-before", "a", "b"]);
    expect(next.nodes.a.childIds).toEqual(["a-child"]);
    expect(next.nodes["a-child"].parentId).toBe("a");
  });

  it("removes selected descendants from a group move without dropping their subtree", () => {
    const { state } = fromNestedTree(testTree());

    expect(getTopLevelNodeIds(state, ["a", "a-child", "b"])).toEqual(["a", "b"]);
    const next = moveFlatNodes(state, ["a", "a-child"], "root", 1);

    expect(next.nodes.root.childIds).toEqual(["b", "a"]);
    expect(next.nodes.a.childIds).toEqual(["a-child"]);
    expect(next.nodes["a-child"].parentId).toBe("a");
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

  it("creates a sibling of the selected workspace when no explicit container is provided", () => {
    expect(createWorkspaceRequestBody({ folderId: "current-folder", parentWorkspaceId: "parent-workspace" }, undefined)).toMatchObject({
      name: "Untitled Workspace",
      folderId: null,
      parentWorkspaceId: "parent-workspace"
    });
  });

  it("preserves the selected workspace folder when creating a sibling", () => {
    expect(createWorkspaceRequestBody({ folderId: "current-folder", parentWorkspaceId: null }, undefined)).toMatchObject({
      folderId: "current-folder",
      parentWorkspaceId: null
    });
  });
});

describe("workspace selection after deletion", () => {
  it("selects a remaining workspace when the current workspace is deleted", () => {
    expect(nextWorkspaceIdAfterDelete([
      { id: "deleted" },
      { id: "next" }
    ] as never, "deleted")).toBe("next");
  });

  it("clears the selection when the final workspace is deleted", () => {
    expect(nextWorkspaceIdAfterDelete([{ id: "deleted" }] as never, "deleted")).toBe("");
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

describe("workspace hierarchy collapse persistence", () => {
  it("restores stored ids and removes duplicates", () => {
    expect([...resolveStoredIdSet('["workspace-b","workspace-a","workspace-a"]')]).toEqual([
      "workspace-b",
      "workspace-a"
    ]);
  });

  it("ignores malformed values and non-string entries", () => {
    expect([...resolveStoredIdSet('["workspace-a",42,null]')]).toEqual(["workspace-a"]);
    expect([...resolveStoredIdSet("not-json")]).toEqual([]);
    expect([...resolveStoredIdSet('{"id":"workspace-a"}')]).toEqual([]);
  });
});

describe("direct child count label", () => {
  it("returns a label only for nodes with direct children", () => {
    expect(getChildCountLabel(3)).toBe("3");
    expect(getChildCountLabel(0)).toBeNull();
  });
});

describe("outline history shortcut", () => {
  const commandZ = { key: "z", metaKey: true, ctrlKey: false, shiftKey: false };

  it("uses outline undo inside an outline editor before history state refreshes", () => {
    expect(getOutlineHistoryShortcut(commandZ, false, false, true, true)).toBe("undo");
  });

  it("leaves unrelated inputs and unavailable global history alone", () => {
    expect(getOutlineHistoryShortcut(commandZ, true, false, true, false)).toBeNull();
    expect(getOutlineHistoryShortcut(commandZ, false, false, false, false)).toBeNull();
  });

  it("supports both redo shortcuts when redo history exists", () => {
    expect(getOutlineHistoryShortcut(
      { key: "z", metaKey: true, ctrlKey: false, shiftKey: true },
      true,
      true,
      true,
      true
    )).toBe("redo");
    expect(getOutlineHistoryShortcut(
      { key: "y", metaKey: false, ctrlKey: true, shiftKey: false },
      true,
      true,
      false,
      false
    )).toBe("redo");
  });
});

describe("panel width bounds", () => {
  it("rounds widths and keeps them inside the available range", () => {
    expect(clampPanelWidth(263.6, 200, 420)).toBe(264);
    expect(clampPanelWidth(160, 200, 420)).toBe(200);
    expect(clampPanelWidth(520, 200, 420)).toBe(420);
  });
});

describe("workspace sidebar collapse persistence", () => {
  it("restores valid stored values and ignores invalid data", () => {
    expect(resolveStoredBoolean("true", false)).toBe(true);
    expect(resolveStoredBoolean("false", true)).toBe(false);
    expect(resolveStoredBoolean("invalid", false)).toBe(false);
  });
});

describe("optimistic node title cache", () => {
  it("prefers the latest local title while a temporary node is being created", () => {
    expect(resolvePendingNodeTitle("快速输入", "older draft", "server title")).toBe("快速输入");
    expect(resolvePendingNodeTitle("", "older draft", "server title")).toBe("");
    expect(resolvePendingNodeTitle(undefined, "draft", "server title")).toBe("draft");
  });

  it("reapplies cached titles when a later response carries stale tree state", () => {
    const { state } = fromNestedTree(testTree());
    const next = applyCachedNodeTitles(state, new Map([["a", "最新本地标题"]]));

    expect(next.nodes.a.title).toBe("最新本地标题");
    expect(next.nodes.b.title).toBe("Beta");
  });

  it("preserves and safely clamps the caret while replacing a temporary node", () => {
    expect(resolveTitleSelection("快速输入", 4, 4)).toEqual({ start: 4, end: 4 });
    expect(resolveTitleSelection("short", 12, 12)).toEqual({ start: 5, end: 5 });
    expect(resolveTitleSelection("selection", 3, 7)).toEqual({ start: 3, end: 7 });
  });

  it("waits to replace a temporary node until IME composition finishes", async () => {
    const scheduled: Array<() => void> = [];
    const tracker = new NodeCompositionTracker(callback => scheduled.push(callback));
    tracker.start("temp-node");

    let replacementReady = false;
    const waiting = tracker.wait("temp-node").then(() => {
      replacementReady = true;
    });
    await Promise.resolve();
    expect(replacementReady).toBe(false);

    tracker.finish("temp-node");
    await Promise.resolve();
    expect(replacementReady).toBe(false);
    expect(scheduled).toHaveLength(1);

    scheduled[0]();
    await waiting;
    expect(replacementReady).toBe(true);
  });
});

describe("optimistic node tags", () => {
  const tag = (id: string, name: string): Tag => ({
    id,
    workspaceId: "workspace",
    name,
    color: "#123456",
    createdAt: "2026-08-31T00:00:00.000Z"
  });

  it("shows a tag immediately and reconciles its temporary id", () => {
    const { state } = fromNestedTree(testTree());
    const optimistic = addOptimisticNodeTag(state, "a", tag("temp-tag-1", "slow"));
    expect(optimistic.nodes.a.tags).toEqual([tag("temp-tag-1", "slow")]);

    const saved = reconcileOptimisticNodeTag(optimistic, "a", "temp-tag-1", tag("tag-1", "slow"));
    expect(saved.nodes.a.tags).toEqual([tag("tag-1", "slow")]);
    expect(upsertWorkspaceTag([tag("tag-2", "zeta")], tag("tag-1", "alpha")))
      .toEqual([tag("tag-1", "alpha"), tag("tag-2", "zeta")]);
  });

  it("rolls back only the optimistic tag when saving fails", () => {
    const { state } = fromNestedTree(testTree());
    const withExisting = addOptimisticNodeTag(state, "a", tag("tag-1", "existing"));
    const optimistic = addOptimisticNodeTag(withExisting, "a", tag("temp-tag-1", "pending"));
    const rolledBack = removeOptimisticNodeTag(optimistic, "a", "temp-tag-1");

    expect(rolledBack.nodes.a.tags).toEqual([tag("tag-1", "existing")]);
  });
});

describe("system Tags workspace", () => {
  const taggedResult = (id: string, title: string, body: string, workspaceName: string): TaggedNodeResult => {
    const { tags: _tags, fieldValues: _fieldValues, children: _children, ...node } = testNode(id, title, "root");
    return {
      node: { ...node, body },
      tags: [],
      path: [{ id, title, position: node.position }],
      workspace: {
        id: `workspace-${workspaceName}`,
        name: workspaceName,
        icon: "folder-tree",
        folderId: null,
        parentWorkspaceId: null,
        position: 0,
        rootNodeId: `root-${workspaceName}`,
        createdAt: "2026-08-31T00:00:00.000Z",
        updatedAt: "2026-08-31T00:00:00.000Z"
      }
    };
  };

  const groups: TaggedNodeGroup[] = [
    {
      name: "project",
      color: "#123456",
      results: [
        taggedResult("alpha", "Alpha", "Roadmap", "First"),
        taggedResult("beta", "Beta", "Release", "Second")
      ]
    },
    {
      name: "reading",
      color: "#654321",
      results: [taggedResult("book", "React book", "Chapter one", "Library")]
    }
  ];

  it("creates a tag row followed by linked outline rows", () => {
    expect(buildSystemTagRows(groups, new Set(), "").map(row =>
      row.kind === "tag" ? `tag:${row.group.name}` : `node:${row.result.node.title}`
    )).toEqual(["tag:project", "node:Alpha", "node:Beta", "tag:reading", "node:React book"]);
  });

  it("respects collapsed tags and expands matching search results", () => {
    expect(buildSystemTagRows(groups, new Set(["project"]), "").map(row => row.kind))
      .toEqual(["tag", "tag", "node"]);
    expect(buildSystemTagRows(groups, new Set(["project"]), "Second").map(row =>
      row.kind === "tag" ? row.group.name : row.result.node.title
    )).toEqual(["project", "Beta"]);
  });

  it("matches ancestor titles in a tag breadcrumb", () => {
    const nested = taggedResult("leaf", "A2", "", "First");
    nested.path = [
      { id: "a", title: "A", position: 0 },
      { id: "a1", title: "A1", position: 0 },
      { id: "leaf", title: "A2", position: 0 }
    ];
    const nestedGroups = [{ name: "project", color: "#123456", results: [nested] }];

    expect(buildSystemTagRows(nestedGroups, new Set(), "A1").map(row => row.kind))
      .toEqual(["tag", "node"]);
  });

  it("expands every collapsed ancestor so a linked outline becomes visible", () => {
    const { state } = fromNestedTree(testTree());
    const collapsed = {
      ...state,
      nodes: {
        ...state.nodes,
        a: { ...state.nodes.a, collapsed: true }
      }
    };

    expect(computeVisibleIds(collapsed)).not.toContain("a-child");

    const revealed = revealNodeInFlatTree(collapsed, "a-child");
    expect(revealed.state.nodes.a.collapsed).toBe(false);
    expect(revealed.visibleIds).toContain("a-child");
    expect(revealed.index).toBe(revealed.visibleIds.indexOf("a-child"));
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
