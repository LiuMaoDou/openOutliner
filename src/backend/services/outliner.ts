import { randomUUID } from "node:crypto";
import type { OpenOutlinerDb } from "../db/database.js";
import type {
  CreateNodeInput,
  FieldDefinition,
  FieldType,
  FieldValue,
  OutlineNode,
  OutlineTreeNode,
  Tag,
  TaggedNodeGroup,
  TaggedNodeResult,
  UpdateNodeInput,
  Workspace,
  WorkspaceFolder
} from "../domain/types.js";

type Row = Record<string, unknown>;
type SqlValue = string | number | bigint | Buffer | null;

interface OutlineNodeSnapshot {
  id: string;
  parentId: string | null;
  position: number;
  title: string;
  body: string;
  dueDate: string | null;
  done: boolean;
  collapsed: boolean;
  deletedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutlineHistoryState {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export interface OutlineHistoryResult {
  tree: OutlineTreeNode;
  history: OutlineHistoryState;
}

const outlineHistoryLimit = 100;
const outlineHistoryCoalesceWindowMs = 1500;

const tagColors = ["#266dd3", "#2a9d8f", "#c2410c", "#7c3aed", "#0f766e", "#be123c"];
const workspaceIcons = [
  "album",
  "archive",
  "badge-check",
  "book-open",
  "briefcase-business",
  "calendar-days",
  "chart-no-axes-combined",
  "circle-dot",
  "clipboard-list",
  "cloud",
  "code-xml",
  "compass",
  "database",
  "folder-tree",
  "gem",
  "goal",
  "grid-3x3",
  "heart",
  "layers",
  "layout-dashboard",
  "lightbulb",
  "map",
  "message-square",
  "notebook-tabs",
  "palette",
  "panel-top",
  "rocket",
  "sparkles",
  "square-pen",
  "star",
  "sun",
  "target",
  "telescope",
  "timer",
  "zap"
];

export class OutlinerService {
  private transactionDepth = 0;
  private outlineHistorySuppressionDepth = 0;

  constructor(private readonly db: OpenOutlinerDb) {}

  ensureSeedData(): Workspace {
    const existing = this.listWorkspaces()[0];
    if (existing) return existing;

    const workspace = this.createWorkspace("OpenOutliner Demo");
    this.withoutOutlineHistory(() => {
      const inbox = this.createNode({
        parentId: workspace.rootNodeId,
        title: "Inbox",
        body: "Capture ideas here before organizing them."
      });
      this.createNode({ parentId: inbox.id, title: "Press Enter to add a sibling" });
      this.createNode({ parentId: inbox.id, title: "Use Tab and Shift+Tab to change depth" });
      const project = this.createNode({
        parentId: workspace.rootNodeId,
        title: "LLM workspace",
        body: "MCP and CLI share the same local SQLite data."
      });
      this.setNodeTag(project.id, "project");
      this.createNode({ parentId: project.id, title: "Expose search_nodes over MCP" });
      this.createNode({ parentId: project.id, title: "Export outline to Markdown and OPML" });
    });
    return workspace;
  }

  listWorkspaces(): Workspace[] {
    return this.db
      .prepare("SELECT * FROM workspaces ORDER BY parent_workspace_id ASC, folder_id ASC, position ASC, created_at ASC")
      .all()
      .map(rowToWorkspace);
  }

  listWorkspaceFolders(): WorkspaceFolder[] {
    return this.db
      .prepare("SELECT * FROM workspace_folders ORDER BY position ASC, created_at ASC")
      .all()
      .map(rowToWorkspaceFolder);
  }

  createWorkspaceFolder(name: string): WorkspaceFolder {
    const trimmed = name.trim();
    if (!trimmed) throw new ValidationError("Folder name is required.");
    const position = number((this.db.prepare("SELECT COUNT(*) AS count FROM workspace_folders").get() as Row).count);
    const id = randomUUID();
    const now = timestamp();

    this.db
      .prepare("INSERT INTO workspace_folders (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, trimmed, position, now, now);
    return this.getWorkspaceFolder(id);
  }

  getWorkspaceFolder(id: string): WorkspaceFolder {
    const row = this.db.prepare("SELECT * FROM workspace_folders WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError(`Workspace folder not found: ${id}`);
    return rowToWorkspaceFolder(row);
  }

  updateWorkspaceFolder(id: string, input: { name?: string }): WorkspaceFolder {
    this.getWorkspaceFolder(id);
    const name = input.name?.trim();
    if (!name) throw new ValidationError("Folder name is required.");
    this.db.prepare("UPDATE workspace_folders SET name = ?, updated_at = ? WHERE id = ?").run(name, timestamp(), id);
    return this.getWorkspaceFolder(id);
  }

  deleteWorkspaceFolder(id: string): { deleted: string } {
    this.getWorkspaceFolder(id);
    this.db.prepare("DELETE FROM workspace_folders WHERE id = ?").run(id);
    return { deleted: id };
  }

  createWorkspaceInFolder(name: string, folderName: string, icon?: string): Workspace {
    const trimmedFolderName = folderName.trim();
    if (!trimmedFolderName) throw new ValidationError("Folder name is required.");

    return this.transaction(() => {
      const folder = this.findWorkspaceFolderByName(trimmedFolderName) ?? this.createWorkspaceFolder(trimmedFolderName);
      return this.createWorkspace(name, icon, folder.id);
    });
  }

  createWorkspace(name: string, icon?: string, folderId?: string | null, parentWorkspaceId?: string | null): Workspace {
    const now = timestamp();
    const workspaceId = randomUUID();
    const rootNodeId = randomUUID();
    const workspaceIcon = normalizeWorkspaceIcon(icon);
    const normalizedParentWorkspaceId = this.normalizeWorkspaceParentId(parentWorkspaceId);
    const normalizedFolderId = normalizedParentWorkspaceId ? null : this.normalizeWorkspaceFolderId(folderId);
    const position = this.countWorkspacesInContainer(normalizedFolderId, normalizedParentWorkspaceId);

    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO workspaces (id, name, icon, folder_id, parent_workspace_id, position, root_node_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(workspaceId, name, workspaceIcon, normalizedFolderId, normalizedParentWorkspaceId, position, rootNodeId, now, now);
      this.db
        .prepare(
          `INSERT INTO nodes
            (id, workspace_id, parent_id, position, title, body, done, collapsed, created_at, updated_at)
           VALUES (?, ?, NULL, 0, ?, '', 0, 0, ?, ?)`
        )
        .run(rootNodeId, workspaceId, name, now, now);
    });

    return this.getWorkspace(workspaceId);
  }

  convertNodeToWorkspace(id: string, name?: string): Workspace {
    const node = this.getNode(id);
    const sourceWorkspace = this.getWorkspace(node.workspaceId);
    if (sourceWorkspace.rootNodeId === id) {
      throw new ValidationError("Workspace root nodes cannot be converted.");
    }

    const workspaceId = randomUUID();
    const workspaceName = name?.trim() || node.title.trim() || "Untitled Workspace";
    const workspaceIcon = normalizeWorkspaceIcon("layers");
    const workspacePosition = this.countWorkspacesInContainer(null, sourceWorkspace.id);
    const now = timestamp();
    const nodeTagRows = this.db
      .prepare(
        `WITH RECURSIVE subtree(id) AS (
          SELECT id FROM nodes WHERE id = ? AND deleted_at IS NULL
          UNION ALL
          SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id = subtree.id
          WHERE nodes.deleted_at IS NULL
        )
        SELECT node_tags.node_id, tags.* FROM node_tags
        JOIN tags ON tags.id = node_tags.tag_id
        WHERE node_tags.node_id IN (SELECT id FROM subtree)`
      )
      .all(id) as Row[];
    const fieldValueRows = this.db
      .prepare(
        `WITH RECURSIVE subtree(id) AS (
          SELECT id FROM nodes WHERE id = ? AND deleted_at IS NULL
          UNION ALL
          SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id = subtree.id
          WHERE nodes.deleted_at IS NULL
        )
        SELECT field_values.* FROM field_values
        WHERE field_values.node_id IN (SELECT id FROM subtree)`
      )
      .all(id) as Row[];

    const tagRowsById = new Map<string, Row>();
    for (const row of nodeTagRows) tagRowsById.set(text(row.id), row);

    const referencedFieldRowsById = new Map<string, Row>();
    for (const valueRow of fieldValueRows) {
      const fieldId = text(valueRow.field_id);
      const fieldRow = this.db.prepare("SELECT * FROM field_definitions WHERE id = ?").get(fieldId) as Row | undefined;
      if (!fieldRow) continue;
      referencedFieldRowsById.set(fieldId, fieldRow);
      const tagId = text(fieldRow.tag_id);
      if (!tagRowsById.has(tagId)) {
        const tagRow = this.db.prepare("SELECT * FROM tags WHERE id = ?").get(tagId) as Row | undefined;
        if (tagRow) tagRowsById.set(tagId, tagRow);
      }
    }

    const fieldRowsById = new Map(referencedFieldRowsById);
    for (const tagId of tagRowsById.keys()) {
      for (const fieldRow of this.db
        .prepare("SELECT * FROM field_definitions WHERE tag_id = ? ORDER BY created_at ASC")
        .all(tagId) as Row[]) {
        fieldRowsById.set(text(fieldRow.id), fieldRow);
      }
    }

    this.transaction(() => {
      this.db.prepare("DELETE FROM outline_history WHERE workspace_id = ?").run(sourceWorkspace.id);
      this.db
        .prepare(
          "INSERT INTO workspaces (id, name, icon, folder_id, parent_workspace_id, position, root_node_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?)"
        )
        .run(workspaceId, workspaceName, workspaceIcon, sourceWorkspace.id, workspacePosition, id, now, now);

      const tagIds = new Map<string, string>();
      for (const [sourceTagId, row] of tagRowsById) {
        const nextTagId = randomUUID();
        tagIds.set(sourceTagId, nextTagId);
        this.db
          .prepare("INSERT INTO tags (id, workspace_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(nextTagId, workspaceId, text(row.name), text(row.color), now);
      }

      const fieldIds = new Map<string, string>();
      for (const [sourceFieldId, row] of fieldRowsById) {
        const nextTagId = tagIds.get(text(row.tag_id));
        if (!nextTagId) continue;
        const nextFieldId = randomUUID();
        fieldIds.set(sourceFieldId, nextFieldId);
        this.db
          .prepare(
            `INSERT INTO field_definitions
              (id, workspace_id, tag_id, name, type, options, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            nextFieldId,
            workspaceId,
            nextTagId,
            text(row.name),
            text(row.type),
            nullableText(row.options),
            now
          );
      }

      for (const row of nodeTagRows) {
        const nextTagId = tagIds.get(text(row.id));
        if (!nextTagId) continue;
        this.db
          .prepare("INSERT INTO node_tags (node_id, tag_id) VALUES (?, ?)")
          .run(text(row.node_id), nextTagId);
        this.db
          .prepare("DELETE FROM node_tags WHERE node_id = ? AND tag_id = ?")
          .run(text(row.node_id), text(row.id));
      }

      for (const row of fieldValueRows) {
        const nextFieldId = fieldIds.get(text(row.field_id));
        if (!nextFieldId) continue;
        this.db
          .prepare("INSERT INTO field_values (node_id, field_id, value, updated_at) VALUES (?, ?, ?, ?)")
          .run(text(row.node_id), nextFieldId, text(row.value), now);
        this.db
          .prepare("DELETE FROM field_values WHERE node_id = ? AND field_id = ?")
          .run(text(row.node_id), text(row.field_id));
      }

      this.db
        .prepare(
          `WITH RECURSIVE subtree(id) AS (
            SELECT id FROM nodes WHERE id = ? AND deleted_at IS NULL
            UNION ALL
            SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id = subtree.id
            WHERE nodes.deleted_at IS NULL
          )
          UPDATE nodes SET workspace_id = ?, updated_at = ? WHERE id IN (SELECT id FROM subtree)`
        )
        .run(id, workspaceId, now);
      this.db
        .prepare("UPDATE nodes SET parent_id = NULL, position = 0, title = ?, updated_at = ? WHERE id = ?")
        .run(workspaceName, now, id);
      this.db
        .prepare(
          `UPDATE nodes
           SET position = position - 1, updated_at = ?
           WHERE workspace_id = ? AND parent_id IS ? AND deleted_at IS NULL AND position > ?`
        )
        .run(now, sourceWorkspace.id, node.parentId, node.position);
      this.db.prepare("UPDATE workspaces SET updated_at = ? WHERE id = ?").run(now, sourceWorkspace.id);
    });

    return this.getWorkspace(workspaceId);
  }

  getWorkspace(id: string): Workspace {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError(`Workspace not found: ${id}`);
    return rowToWorkspace(row);
  }

  updateWorkspace(id: string, input: { name?: string; folderId?: string | null; parentWorkspaceId?: string | null }): Workspace {
    let workspace = this.getWorkspace(id);
    const name = input.name?.trim();
    const hasName = input.name !== undefined;
    if (hasName && !name) throw new ValidationError("Workspace name is required.");
    const hasFolder = input.folderId !== undefined;
    const hasParent = input.parentWorkspaceId !== undefined;
    const parentWorkspaceId = hasParent ? this.normalizeWorkspaceParentId(input.parentWorkspaceId, id) : workspace.parentWorkspaceId;
    const folderId = hasParent
      ? parentWorkspaceId ? null : hasFolder ? this.normalizeWorkspaceFolderId(input.folderId) : null
      : hasFolder ? this.normalizeWorkspaceFolderId(input.folderId) : workspace.folderId;
    const nextName = hasName ? name ?? workspace.name : workspace.name;
    const now = timestamp();

    if (hasFolder || hasParent) {
      workspace = this.moveWorkspace(id, folderId, Number.MAX_SAFE_INTEGER, parentWorkspaceId);
    }

    this.transaction(() => {
      this.db
        .prepare("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?")
        .run(nextName, now, id);
      if (hasName) {
        this.db
          .prepare("UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?")
          .run(nextName, now, workspace.rootNodeId);
      }
    });

    return this.getWorkspace(id);
  }

  moveWorkspace(id: string, folderId: string | null, position: number, parentWorkspaceId: string | null = null): Workspace {
    const workspace = this.getWorkspace(id);
    const nextParentWorkspaceId = this.normalizeWorkspaceParentId(parentWorkspaceId, id);
    const nextFolderId = nextParentWorkspaceId ? null : this.normalizeWorkspaceFolderId(folderId);
    const targetCount = number(
      (this.db
        .prepare("SELECT COUNT(*) AS count FROM workspaces WHERE folder_id IS ? AND parent_workspace_id IS ? AND id != ?")
        .get(nextFolderId, nextParentWorkspaceId, id) as Row).count
    );
    const targetPosition = clamp(position, 0, targetCount);
    const now = timestamp();

    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE workspaces
           SET position = position - 1, updated_at = ?
           WHERE folder_id IS ? AND parent_workspace_id IS ? AND position > ?`
        )
        .run(now, workspace.folderId, workspace.parentWorkspaceId, workspace.position);

      this.db
        .prepare(
          `UPDATE workspaces
           SET position = position + 1, updated_at = ?
           WHERE folder_id IS ? AND parent_workspace_id IS ? AND id != ? AND position >= ?`
        )
        .run(now, nextFolderId, nextParentWorkspaceId, id, targetPosition);

      this.db
        .prepare("UPDATE workspaces SET folder_id = ?, parent_workspace_id = ?, position = ?, updated_at = ? WHERE id = ?")
        .run(nextFolderId, nextParentWorkspaceId, targetPosition, now, id);
    });

    return this.getWorkspace(id);
  }

  deleteWorkspace(id: string): { deleted: string } {
    const workspace = this.getWorkspace(id);
    const now = timestamp();
    this.transaction(() => {
      const children = this.db
        .prepare("SELECT id FROM workspaces WHERE parent_workspace_id = ? ORDER BY position ASC, created_at ASC")
        .all(id) as Array<{ id: string }>;
      const childParentWorkspaceId = workspace.parentWorkspaceId;
      const childFolderId = childParentWorkspaceId ? null : workspace.folderId;
      this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
      this.db
        .prepare(
          `UPDATE workspaces
           SET position = position - 1, updated_at = ?
           WHERE folder_id IS ? AND parent_workspace_id IS ? AND position > ?`
        )
        .run(now, workspace.folderId, workspace.parentWorkspaceId, workspace.position);
      if (children.length > 0) {
        this.db
          .prepare(
            `UPDATE workspaces
             SET position = position + ?, updated_at = ?
             WHERE folder_id IS ? AND parent_workspace_id IS ? AND position >= ?`
          )
          .run(children.length, now, childFolderId, childParentWorkspaceId, workspace.position);
        const promote = this.db.prepare(
          "UPDATE workspaces SET folder_id = ?, parent_workspace_id = ?, position = ?, updated_at = ? WHERE id = ?"
        );
        children.forEach((child, index) =>
          promote.run(childFolderId, childParentWorkspaceId, workspace.position + index, now, child.id)
        );
      }
    });
    return { deleted: id };
  }

  replaceAllWorkspaces<T>(build: () => T): T {
    return this.withoutOutlineHistory(() =>
      this.transaction(() => {
        this.db.prepare("DELETE FROM workspaces").run();
        return build();
      })
    );
  }

  getNode(id: string): OutlineNode {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE id = ? AND deleted_at IS NULL")
      .get(id) as Row | undefined;
    if (!row) throw new NotFoundError(`Node not found: ${id}`);
    return rowToNode(row);
  }

  listChildren(parentId: string): OutlineNode[] {
    return this.db
      .prepare(
        `SELECT * FROM nodes
         WHERE parent_id IS ? AND deleted_at IS NULL
         ORDER BY position ASC, created_at ASC`
      )
      .all(parentId)
      .map(rowToNode);
  }

  createNode(input: CreateNodeInput): OutlineNode {
    const parent = this.getNode(input.parentId);
    return this.recordOutlineMutation(parent.workspaceId, "Create outline", null, () => {
      const siblingCount = number(
        (this.db
          .prepare("SELECT COUNT(*) AS count FROM nodes WHERE parent_id IS ? AND deleted_at IS NULL")
          .get(input.parentId) as Row).count
      );
      const position = clamp(input.position ?? siblingCount, 0, siblingCount);
      const id = randomUUID();
      const now = timestamp();

      this.transaction(() => {
        this.db
          .prepare(
            `UPDATE nodes
             SET position = position + 1, updated_at = ?
             WHERE workspace_id = ? AND parent_id IS ? AND deleted_at IS NULL AND position >= ?`
          )
          .run(now, parent.workspaceId, input.parentId, position);

        this.db
          .prepare(
            `INSERT INTO nodes
              (id, workspace_id, parent_id, position, title, body, done, collapsed, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
          )
          .run(
            id,
            parent.workspaceId,
            input.parentId,
            position,
            input.title ?? "",
            input.body ?? "",
            input.done ? 1 : 0,
            now,
            now
          );
      });

      return this.getNode(id);
    });
  }

  updateNode(id: string, input: UpdateNodeInput): OutlineNode {
    const node = this.getNode(id);
    const sets: string[] = [];
    const values: SqlValue[] = [];
    const fields: string[] = [];

    if (input.title !== undefined && input.title !== node.title) {
      sets.push("title = ?");
      values.push(input.title);
      fields.push("title");
    }
    if (input.body !== undefined && input.body !== node.body) {
      sets.push("body = ?");
      values.push(input.body);
      fields.push("body");
    }
    if (input.dueDate !== undefined) {
      const dueDate = normalizeDueDate(input.dueDate);
      if (dueDate !== node.dueDate) {
        sets.push("due_date = ?");
        values.push(dueDate);
        fields.push("dueDate");
      }
    }
    if (input.done !== undefined && input.done !== node.done) {
      sets.push("done = ?");
      values.push(input.done ? 1 : 0);
      fields.push("done");
    }
    if (input.collapsed !== undefined && input.collapsed !== node.collapsed) {
      sets.push("collapsed = ?");
      values.push(input.collapsed ? 1 : 0);
      fields.push("collapsed");
    }

    if (sets.length === 0) return node;
    fields.sort();
    return this.recordOutlineMutation(
      node.workspaceId,
      outlineUpdateLabel(fields),
      `update:${id}:${fields.join(",")}`,
      () => {
        sets.push("updated_at = ?");
        values.push(timestamp(), id);
        this.db.prepare(`UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`).run(...values);
        return this.getNode(id);
      }
    );
  }

  moveNode(id: string, parentId: string, position?: number): OutlineNode {
    const node = this.getNode(id);
    const nextParent = this.getNode(parentId);
    if (node.id === nextParent.id) throw new ValidationError("A node cannot be moved under itself.");
    if (node.workspaceId !== nextParent.workspaceId) {
      throw new ValidationError("Nodes can only move inside the same workspace.");
    }
    if (this.isDescendant(nextParent.id, node.id)) {
      throw new ValidationError("A node cannot be moved under one of its descendants.");
    }

    const targetCount = number(
      (this.db
        .prepare("SELECT COUNT(*) AS count FROM nodes WHERE parent_id IS ? AND id != ? AND deleted_at IS NULL")
        .get(parentId, id) as Row).count
    );
    const targetPosition = clamp(position ?? targetCount, 0, targetCount);
    const now = timestamp();

    return this.recordOutlineMutation(node.workspaceId, "Move outline", null, () => {
      this.transaction(() => {
        this.db
          .prepare(
            `UPDATE nodes
             SET position = position - 1, updated_at = ?
             WHERE workspace_id = ? AND parent_id IS ? AND deleted_at IS NULL AND position > ?`
          )
          .run(now, node.workspaceId, node.parentId, node.position);

        this.db
          .prepare(
            `UPDATE nodes
             SET position = position + 1, updated_at = ?
             WHERE workspace_id = ? AND parent_id IS ? AND deleted_at IS NULL AND position >= ?`
          )
          .run(now, node.workspaceId, parentId, targetPosition);

        this.db
          .prepare("UPDATE nodes SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?")
          .run(parentId, targetPosition, now, id);
      });

      return this.getNode(id);
    });
  }

  moveNodes(ids: string[], parentId: string, position?: number, expandParent = false): OutlineNode[] {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) throw new ValidationError("At least one node is required.");

    const selectedIds = new Set(uniqueIds);
    const requestedNodes = uniqueIds.map(id => this.getNode(id));
    const movingNodes = requestedNodes.filter(node => {
      let ancestorId = node.parentId;
      while (ancestorId) {
        if (selectedIds.has(ancestorId)) return false;
        ancestorId = this.getNode(ancestorId).parentId;
      }
      return true;
    });
    const nextParent = this.getNode(parentId);
    if (movingNodes.some(node => !node.parentId)) {
      throw new ValidationError("Workspace root nodes cannot be moved.");
    }
    if (movingNodes.some(node => node.workspaceId !== nextParent.workspaceId)) {
      throw new ValidationError("Nodes can only move inside the same workspace.");
    }
    if (movingNodes.some(node => node.id === nextParent.id || this.isDescendant(nextParent.id, node.id))) {
      throw new ValidationError("Nodes cannot be moved under themselves or their descendants.");
    }

    const movingIds = movingNodes.map(node => node.id);
    const movingIdSet = new Set(movingIds);
    const affectedParentIds = new Set<string>([parentId]);
    for (const node of movingNodes) affectedParentIds.add(node.parentId as string);
    const childrenByParent = new Map<string, string[]>();
    for (const affectedParentId of affectedParentIds) {
      childrenByParent.set(
        affectedParentId,
        this.listChildren(affectedParentId).map(node => node.id).filter(id => !movingIdSet.has(id))
      );
    }

    const targetChildren = childrenByParent.get(parentId) ?? [];
    const targetPosition = clamp(position ?? targetChildren.length, 0, targetChildren.length);
    targetChildren.splice(targetPosition, 0, ...movingIds);
    childrenByParent.set(parentId, targetChildren);
    const now = timestamp();

    return this.recordOutlineMutation(
      nextParent.workspaceId,
      movingIds.length === 1 ? "Move outline" : `Move ${movingIds.length} outlines`,
      null,
      () => {
        this.transaction(() => {
          const update = this.db.prepare(
            "UPDATE nodes SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?"
          );
          for (const [affectedParentId, childIds] of childrenByParent) {
            childIds.forEach((childId, index) => update.run(affectedParentId, index, now, childId));
          }
          if (expandParent) {
            this.db.prepare("UPDATE nodes SET collapsed = 0, updated_at = ? WHERE id = ?").run(now, parentId);
          }
        });

        return movingIds.map(id => this.getNode(id));
      }
    );
  }

  moveNodesToWorkspace(ids: string[], targetWorkspaceId: string): OutlineNode[] {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) throw new ValidationError("At least one node is required.");

    const selectedIds = new Set(uniqueIds);
    const requestedNodes = uniqueIds.map(id => this.getNode(id));
    const movingNodes = requestedNodes.filter(node => {
      let ancestorId = node.parentId;
      while (ancestorId) {
        if (selectedIds.has(ancestorId)) return false;
        ancestorId = this.getNode(ancestorId).parentId;
      }
      return true;
    });
    if (movingNodes.some(node => !node.parentId)) {
      throw new ValidationError("Workspace root nodes cannot be moved.");
    }

    const sourceWorkspaceId = movingNodes[0]?.workspaceId;
    if (!sourceWorkspaceId || movingNodes.some(node => node.workspaceId !== sourceWorkspaceId)) {
      throw new ValidationError("Nodes must come from the same workspace.");
    }
    if (sourceWorkspaceId === targetWorkspaceId) {
      throw new ValidationError("Choose a different workspace.");
    }

    const sourceWorkspace = this.getWorkspace(sourceWorkspaceId);
    const targetWorkspace = this.getWorkspace(targetWorkspaceId);
    const movingIds = movingNodes.map(node => node.id);
    const placeholders = movingIds.map(() => "?").join(", ");
    const subtreeRows = this.db
      .prepare(
        `WITH RECURSIVE subtree(id) AS (
          SELECT id FROM nodes WHERE id IN (${placeholders}) AND deleted_at IS NULL
          UNION
          SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id = subtree.id
          WHERE nodes.deleted_at IS NULL
        )
        SELECT id FROM subtree`
      )
      .all(...movingIds) as Row[];
    const subtreeIds = subtreeRows.map(row => text(row.id));
    const sourceParentIds = [...new Set(movingNodes.map(node => node.parentId as string))];
    const movingIdSet = new Set(movingIds);
    const sourceChildrenByParent = new Map(
      sourceParentIds.map(parentId => [
        parentId,
        this.listChildren(parentId).map(node => node.id).filter(id => !movingIdSet.has(id))
      ])
    );
    const targetPosition = this.listChildren(targetWorkspace.rootNodeId).length;
    const now = timestamp();

    this.transaction(() => {
      this.db.prepare("DELETE FROM outline_history WHERE workspace_id IN (?, ?)").run(sourceWorkspace.id, targetWorkspace.id);
      this.migrateNodeMetadata(subtreeIds, sourceWorkspace, targetWorkspace, now);

      const updatePosition = this.db.prepare(
        "UPDATE nodes SET parent_id = ?, position = ?, updated_at = ? WHERE id = ?"
      );
      for (const [parentId, childIds] of sourceChildrenByParent) {
        childIds.forEach((childId, index) => updatePosition.run(parentId, index, now, childId));
      }

      this.db
        .prepare(`UPDATE nodes SET workspace_id = ?, updated_at = ? WHERE id IN (${subtreeIds.map(() => "?").join(", ")})`)
        .run(targetWorkspace.id, now, ...subtreeIds);
      movingIds.forEach((id, index) => {
        updatePosition.run(targetWorkspace.rootNodeId, targetPosition + index, now, id);
      });
      this.db
        .prepare("UPDATE workspaces SET updated_at = ? WHERE id IN (?, ?)")
        .run(now, sourceWorkspace.id, targetWorkspace.id);
    });

    return movingIds.map(id => this.getNode(id));
  }

  deleteNode(id: string): { deleted: string[] } {
    return this.deleteNodes([id]);
  }

  deleteNodes(ids: string[]): { deleted: string[] } {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) throw new ValidationError("At least one node is required.");

    const selectedIds = new Set(uniqueIds);
    const requestedNodes = uniqueIds.map(id => this.getNode(id));
    const workspaceId = requestedNodes[0]?.workspaceId;
    if (!workspaceId || requestedNodes.some(node => node.workspaceId !== workspaceId)) {
      throw new ValidationError("Nodes must come from the same workspace.");
    }
    const workspace = this.getWorkspace(workspaceId);
    if (requestedNodes.some(node => workspace.rootNodeId === node.id)) {
      throw new ValidationError("Workspace root nodes cannot be deleted.");
    }

    const deletingNodes = requestedNodes.filter(node => {
      let ancestorId = node.parentId;
      while (ancestorId) {
        if (selectedIds.has(ancestorId)) return false;
        ancestorId = this.getNode(ancestorId).parentId;
      }
      return true;
    });
    const deletingIds = deletingNodes.map(node => node.id);
    const placeholders = deletingIds.map(() => "?").join(", ");
    const now = timestamp();
    const rows = this.db
      .prepare(
        `WITH RECURSIVE subtree(id) AS (
          SELECT id FROM nodes WHERE id IN (${placeholders}) AND deleted_at IS NULL
          UNION
          SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id = subtree.id
          WHERE nodes.deleted_at IS NULL
        )
        SELECT id FROM subtree`
      )
      .all(...deletingIds) as Row[];

    return this.recordOutlineMutation(workspaceId, "Delete outline", null, () => {
      this.transaction(() => {
        this.db
          .prepare(
            `WITH RECURSIVE subtree(id) AS (
              SELECT id FROM nodes WHERE id IN (${placeholders}) AND deleted_at IS NULL
              UNION
              SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id = subtree.id
              WHERE nodes.deleted_at IS NULL
            )
            UPDATE nodes SET deleted_at = ?, updated_at = ? WHERE id IN (SELECT id FROM subtree)`
          )
          .run(...deletingIds, now, now);

        const updatePosition = this.db.prepare("UPDATE nodes SET position = ?, updated_at = ? WHERE id = ?");
        for (const parentId of new Set(deletingNodes.map(node => node.parentId as string))) {
          this.listChildren(parentId).forEach((child, position) => updatePosition.run(position, now, child.id));
        }
      });

      return { deleted: rows.map(row => text(row.id)) };
    });
  }

  restoreNode(id: string): OutlineTreeNode {
    const row = this.db
      .prepare("SELECT * FROM nodes WHERE id = ? AND deleted_at IS NOT NULL")
      .get(id) as Row | undefined;
    if (!row) throw new ValidationError("Node is not deleted.");

    const node = rowToNode(row);
    const workspace = this.getWorkspace(node.workspaceId);
    if (workspace.rootNodeId === id) throw new ValidationError("Workspace root nodes cannot be restored.");
    if (!node.parentId) throw new ValidationError("Deleted node parent is missing.");

    const parent = this.db
      .prepare("SELECT * FROM nodes WHERE id = ? AND deleted_at IS NULL")
      .get(node.parentId) as Row | undefined;
    if (!parent) throw new ValidationError("Deleted node parent is not active.");

    const now = timestamp();
    this.transaction(() => {
      this.db
        .prepare(
          `UPDATE nodes
           SET position = position + 1, updated_at = ?
           WHERE workspace_id = ? AND parent_id IS ? AND deleted_at IS NULL AND position >= ?`
        )
        .run(now, node.workspaceId, node.parentId, node.position);

      this.db
        .prepare(
          `WITH RECURSIVE subtree(id) AS (
            SELECT id FROM nodes WHERE id = ?
            UNION ALL
            SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id = subtree.id
            WHERE nodes.deleted_at IS NOT NULL
          )
          UPDATE nodes SET deleted_at = NULL, updated_at = ? WHERE id IN (SELECT id FROM subtree)`
        )
        .run(id, now);
    });

    return this.getTree(id);
  }

  searchNodes(query: string, workspaceId?: string, limit = 25): OutlineNode[] {
    const like = `%${query.trim()}%`;
    if (!query.trim()) return [];

    const params: SqlValue[] = [like, like];
    let workspaceClause = "";
    if (workspaceId) {
      workspaceClause = "AND workspace_id = ?";
      params.push(workspaceId);
    }
    params.push(limit);

    return this.db
      .prepare(
        `SELECT * FROM nodes
         WHERE deleted_at IS NULL
           AND parent_id IS NOT NULL
           AND (title LIKE ? OR body LIKE ?)
           ${workspaceClause}
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(...params)
      .map(rowToNode);
  }

  getTree(rootId: string): OutlineTreeNode {
    const root = this.getNode(rootId);
    const nodes = (this.db
      .prepare(
        `SELECT * FROM nodes
         WHERE workspace_id = ? AND deleted_at IS NULL
         ORDER BY parent_id ASC, position ASC, created_at ASC`
      )
      .all(root.workspaceId) as Row[]).map(rowToNode);
    const nodeIds = new Set(nodes.map(node => node.id));
    const tagsByNode = new Map<string, Tag[]>();
    const fieldValuesByNode = new Map<string, FieldValue[]>();

    for (const row of this.db
      .prepare(
        `SELECT node_tags.node_id, tags.* FROM node_tags
         JOIN tags ON node_tags.tag_id = tags.id
         WHERE tags.workspace_id = ?
         ORDER BY tags.name ASC`
      )
      .all(root.workspaceId) as Row[]) {
      const nodeId = text(row.node_id);
      if (!nodeIds.has(nodeId)) continue;
      const tags = tagsByNode.get(nodeId) ?? [];
      tags.push(rowToTag(row));
      tagsByNode.set(nodeId, tags);
    }

    for (const row of this.db
      .prepare(
        `SELECT field_values.* FROM field_values
         JOIN field_definitions ON field_values.field_id = field_definitions.id
         WHERE field_definitions.workspace_id = ?
         ORDER BY field_values.field_id ASC`
      )
      .all(root.workspaceId) as Row[]) {
      const nodeId = text(row.node_id);
      if (!nodeIds.has(nodeId)) continue;
      const fieldValues = fieldValuesByNode.get(nodeId) ?? [];
      fieldValues.push(rowToFieldValue(row));
      fieldValuesByNode.set(nodeId, fieldValues);
    }

    const treeNodes = new Map<string, OutlineTreeNode>();
    for (const node of nodes) {
      treeNodes.set(node.id, {
        ...node,
        tags: tagsByNode.get(node.id) ?? [],
        fieldValues: fieldValuesByNode.get(node.id) ?? [],
        children: []
      });
    }

    for (const node of nodes) {
      if (!node.parentId) continue;
      const parent = treeNodes.get(node.parentId);
      const child = treeNodes.get(node.id);
      if (parent && child) parent.children.push(child);
    }

    const tree = treeNodes.get(rootId);
    if (!tree) throw new NotFoundError(`Node not found: ${rootId}`);
    return tree;
  }

  getOutlineHistoryState(workspaceId: string): OutlineHistoryState {
    this.getWorkspace(workspaceId);
    const undo = this.db
      .prepare(
        "SELECT label FROM outline_history WHERE workspace_id = ? AND undone = 0 ORDER BY seq DESC LIMIT 1"
      )
      .get(workspaceId) as Row | undefined;
    const redo = this.db
      .prepare(
        "SELECT label FROM outline_history WHERE workspace_id = ? AND undone = 1 ORDER BY seq ASC LIMIT 1"
      )
      .get(workspaceId) as Row | undefined;
    return {
      canUndo: Boolean(undo),
      canRedo: Boolean(redo),
      undoLabel: undo ? text(undo.label) : null,
      redoLabel: redo ? text(redo.label) : null
    };
  }

  undoOutline(workspaceId: string): OutlineHistoryResult {
    return this.replayOutlineHistory(workspaceId, "undo");
  }

  redoOutline(workspaceId: string): OutlineHistoryResult {
    return this.replayOutlineHistory(workspaceId, "redo");
  }

  listTags(workspaceId: string): Tag[] {
    return this.db
      .prepare("SELECT * FROM tags WHERE workspace_id = ? ORDER BY name ASC")
      .all(workspaceId)
      .map(rowToTag);
  }

  listNodesByTagName(tagName: string): TaggedNodeResult[] {
    const normalized = tagName.trim().replace(/^#/, "");
    if (!normalized) throw new ValidationError("Tag name is required.");

    const rows = this.db
      .prepare(
        `SELECT
           nodes.*,
           tags.id AS matched_tag_id,
           tags.workspace_id AS matched_tag_workspace_id,
           tags.name AS matched_tag_name,
           tags.color AS matched_tag_color,
           tags.created_at AS matched_tag_created_at,
           workspaces.id AS result_workspace_id,
           workspaces.name AS result_workspace_name,
           workspaces.icon AS result_workspace_icon,
           workspaces.folder_id AS result_workspace_folder_id,
           workspaces.parent_workspace_id AS result_workspace_parent_workspace_id,
           workspaces.position AS result_workspace_position,
           workspaces.root_node_id AS result_workspace_root_node_id,
           workspaces.created_at AS result_workspace_created_at,
           workspaces.updated_at AS result_workspace_updated_at
         FROM tags
         JOIN node_tags ON node_tags.tag_id = tags.id
         JOIN nodes ON nodes.id = node_tags.node_id
         JOIN workspaces ON workspaces.id = nodes.workspace_id
         WHERE tags.name = ?
           AND nodes.deleted_at IS NULL
           AND nodes.parent_id IS NOT NULL
         ORDER BY workspaces.created_at ASC, nodes.updated_at DESC`
      )
      .all(normalized) as Row[];

    return this.mapTaggedNodeRows(rows, normalized);
  }

  listTaggedNodeGroups(): TaggedNodeGroup[] {
    const rows = this.db
      .prepare(
        `SELECT
           nodes.*,
           tags.id AS matched_tag_id,
           tags.workspace_id AS matched_tag_workspace_id,
           tags.name AS matched_tag_name,
           tags.color AS matched_tag_color,
           tags.created_at AS matched_tag_created_at,
           workspaces.id AS result_workspace_id,
           workspaces.name AS result_workspace_name,
           workspaces.icon AS result_workspace_icon,
           workspaces.folder_id AS result_workspace_folder_id,
           workspaces.parent_workspace_id AS result_workspace_parent_workspace_id,
           workspaces.position AS result_workspace_position,
           workspaces.root_node_id AS result_workspace_root_node_id,
           workspaces.created_at AS result_workspace_created_at,
           workspaces.updated_at AS result_workspace_updated_at
         FROM tags
         JOIN node_tags ON node_tags.tag_id = tags.id
         JOIN nodes ON nodes.id = node_tags.node_id
         JOIN workspaces ON workspaces.id = nodes.workspace_id
         WHERE nodes.deleted_at IS NULL
           AND nodes.parent_id IS NOT NULL
         ORDER BY tags.name COLLATE NOCASE ASC, tags.name ASC, nodes.updated_at DESC, nodes.created_at ASC`
      )
      .all() as Row[];
    const results = this.mapTaggedNodeRows(rows);
    const groupsByName = new Map<string, TaggedNodeGroup>();

    rows.forEach((row, index) => {
      const matchedTag = rowToMatchedTag(row);
      const existing = groupsByName.get(matchedTag.name);
      if (existing) {
        existing.results.push(results[index]);
        return;
      }
      groupsByName.set(matchedTag.name, {
        name: matchedTag.name,
        color: matchedTag.color,
        results: [results[index]]
      });
    });

    return [...groupsByName.values()];
  }

  private mapTaggedNodeRows(rows: Row[], matchedName?: string): TaggedNodeResult[] {
    if (rows.length === 0) return [];

    const tagsByNode = new Map<string, Tag[]>();
    for (const row of this.db
      .prepare(
        `SELECT node_tags.node_id, tags.* FROM node_tags
         JOIN tags ON node_tags.tag_id = tags.id
         JOIN nodes ON nodes.id = node_tags.node_id
         WHERE nodes.deleted_at IS NULL
           AND nodes.parent_id IS NOT NULL
           AND (
             ? IS NULL OR EXISTS (
               SELECT 1 FROM node_tags AS matching_node_tags
               JOIN tags AS matching_tags ON matching_tags.id = matching_node_tags.tag_id
               WHERE matching_node_tags.node_id = nodes.id AND matching_tags.name = ?
             )
           )
         ORDER BY tags.name ASC`
      )
      .all(matchedName ?? null, matchedName ?? null) as Row[]) {
      const nodeId = text(row.node_id);
      const tags = tagsByNode.get(nodeId) ?? [];
      tags.push(rowToTag(row));
      tagsByNode.set(nodeId, tags);
    }

    return rows.map(row => {
      const node = rowToNode(row);
      return {
        node,
        tags: tagsByNode.get(node.id) ?? [rowToMatchedTag(row)],
        workspace: rowToResultWorkspace(row)
      };
    });
  }

  createTag(workspaceId: string, name: string, color?: string): Tag {
    this.getWorkspace(workspaceId);
    const normalized = name.trim().replace(/^#/, "");
    if (!normalized) throw new ValidationError("Tag name is required.");
    const existing = this.db
      .prepare("SELECT * FROM tags WHERE workspace_id = ? AND name = ?")
      .get(workspaceId, normalized) as Row | undefined;
    if (existing) return rowToTag(existing);

    const id = randomUUID();
    const now = timestamp();
    const tagColor = color ?? tagColors[Math.abs(hash(normalized)) % tagColors.length];
    this.db
      .prepare("INSERT INTO tags (id, workspace_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, workspaceId, normalized, tagColor, now);
    return rowToTag(this.db.prepare("SELECT * FROM tags WHERE id = ?").get(id) as Row);
  }

  getTag(id: string): Tag {
    const row = this.db.prepare("SELECT * FROM tags WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError(`Tag not found: ${id}`);
    return rowToTag(row);
  }

  updateTag(id: string, input: { name?: string; color?: string }): Tag {
    const tag = this.getTag(id);
    const name = input.name?.trim().replace(/^#/, "");
    if (!name) throw new ValidationError("Tag name is required.");
    const duplicate = this.db
      .prepare("SELECT id FROM tags WHERE workspace_id = ? AND name = ? AND id != ?")
      .get(tag.workspaceId, name, id) as Row | undefined;
    if (duplicate) throw new ValidationError(`Tag already exists: ${name}`);

    this.db
      .prepare("UPDATE tags SET name = ?, color = ? WHERE id = ?")
      .run(name, input.color ?? tag.color, id);
    return this.getTag(id);
  }

  deleteTag(id: string): { deleted: string } {
    this.getTag(id);
    this.db.prepare("DELETE FROM tags WHERE id = ?").run(id);
    return { deleted: id };
  }

  setNodeTag(nodeId: string, tagName: string): Tag {
    const node = this.getNode(nodeId);
    const tag = this.createTag(node.workspaceId, tagName);
    this.db.prepare("INSERT OR IGNORE INTO node_tags (node_id, tag_id) VALUES (?, ?)").run(nodeId, tag.id);
    return tag;
  }

  removeNodeTag(nodeId: string, tagId: string): void {
    this.db.prepare("DELETE FROM node_tags WHERE node_id = ? AND tag_id = ?").run(nodeId, tagId);
  }

  listNodeTags(nodeId: string): Tag[] {
    return this.db
      .prepare(
        `SELECT tags.* FROM tags
         JOIN node_tags ON node_tags.tag_id = tags.id
         WHERE node_tags.node_id = ?
         ORDER BY tags.name ASC`
      )
      .all(nodeId)
      .map(rowToTag);
  }

  listFieldDefinitions(workspaceId: string): FieldDefinition[] {
    return this.db
      .prepare("SELECT * FROM field_definitions WHERE workspace_id = ? ORDER BY name ASC")
      .all(workspaceId)
      .map(rowToFieldDefinition);
  }

  createFieldDefinition(input: {
    workspaceId: string;
    tagId: string;
    name: string;
    type: FieldType;
    options?: string | null;
  }): FieldDefinition {
    this.getWorkspace(input.workspaceId);
    const id = randomUUID();
    const now = timestamp();
    this.db
      .prepare(
        `INSERT INTO field_definitions
          (id, workspace_id, tag_id, name, type, options, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(id, input.workspaceId, input.tagId, input.name, input.type, input.options ?? null, now);
    return rowToFieldDefinition(this.db.prepare("SELECT * FROM field_definitions WHERE id = ?").get(id) as Row);
  }

  setFieldValue(nodeId: string, fieldId: string, value: string): FieldValue {
    this.getNode(nodeId);
    const now = timestamp();
    this.db
      .prepare(
        `INSERT INTO field_values (node_id, field_id, value, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(node_id, field_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(nodeId, fieldId, value, now);
    return rowToFieldValue(
      this.db
        .prepare("SELECT * FROM field_values WHERE node_id = ? AND field_id = ?")
        .get(nodeId, fieldId) as Row
    );
  }

  listFieldValues(nodeId: string): FieldValue[] {
    return this.db
      .prepare("SELECT * FROM field_values WHERE node_id = ? ORDER BY field_id ASC")
      .all(nodeId)
      .map(rowToFieldValue);
  }

  private migrateNodeMetadata(
    nodeIds: string[],
    sourceWorkspace: Workspace,
    targetWorkspace: Workspace,
    now: string
  ): void {
    if (nodeIds.length === 0) return;

    const placeholders = nodeIds.map(() => "?").join(", ");
    const nodeTagRows = this.db
      .prepare(
        `SELECT node_tags.node_id, tags.* FROM node_tags
         JOIN tags ON tags.id = node_tags.tag_id
         WHERE node_tags.node_id IN (${placeholders})`
      )
      .all(...nodeIds) as Row[];
    const fieldValueRows = this.db
      .prepare(
        `SELECT field_values.*, field_definitions.tag_id AS source_tag_id
         FROM field_values
         JOIN field_definitions ON field_definitions.id = field_values.field_id
         WHERE field_values.node_id IN (${placeholders})`
      )
      .all(...nodeIds) as Row[];

    const sourceTagRows = new Map<string, Row>();
    for (const row of nodeTagRows) sourceTagRows.set(text(row.id), row);
    for (const row of fieldValueRows) {
      const tagId = text(row.source_tag_id);
      if (sourceTagRows.has(tagId)) continue;
      const tagRow = this.db.prepare("SELECT * FROM tags WHERE id = ?").get(tagId) as Row | undefined;
      if (tagRow) sourceTagRows.set(tagId, tagRow);
    }

    const targetTagIds = new Map<string, string>();
    for (const [sourceTagId, row] of sourceTagRows) {
      const name = text(row.name);
      const existing = this.db
        .prepare("SELECT id FROM tags WHERE workspace_id = ? AND name = ?")
        .get(targetWorkspace.id, name) as Row | undefined;
      const targetTagId = existing ? text(existing.id) : randomUUID();
      if (!existing) {
        this.db
          .prepare("INSERT INTO tags (id, workspace_id, name, color, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(targetTagId, targetWorkspace.id, name, text(row.color), now);
      }
      targetTagIds.set(sourceTagId, targetTagId);
    }

    const sourceTagIds = [...sourceTagRows.keys()];
    const fieldRows = sourceTagIds.length === 0
      ? []
      : this.db
          .prepare(`SELECT * FROM field_definitions WHERE tag_id IN (${sourceTagIds.map(() => "?").join(", ")})`)
          .all(...sourceTagIds) as Row[];
    const targetFieldIds = new Map<string, string>();
    for (const row of fieldRows) {
      const targetTagId = targetTagIds.get(text(row.tag_id));
      if (!targetTagId) continue;

      const type = text(row.type);
      const options = nullableText(row.options);
      const originalName = text(row.name);
      let targetName = originalName;
      let suffix = 2;
      let existing = this.db
        .prepare("SELECT * FROM field_definitions WHERE tag_id = ? AND name = ?")
        .get(targetTagId, targetName) as Row | undefined;
      while (existing && (text(existing.type) !== type || nullableText(existing.options) !== options)) {
        targetName = `${originalName} (${sourceWorkspace.name}${suffix === 2 ? "" : ` ${suffix}`})`;
        suffix += 1;
        existing = this.db
          .prepare("SELECT * FROM field_definitions WHERE tag_id = ? AND name = ?")
          .get(targetTagId, targetName) as Row | undefined;
      }

      const targetFieldId = existing ? text(existing.id) : randomUUID();
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO field_definitions
              (id, workspace_id, tag_id, name, type, options, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(targetFieldId, targetWorkspace.id, targetTagId, targetName, type, options, now);
      }
      targetFieldIds.set(text(row.id), targetFieldId);
    }

    for (const row of nodeTagRows) {
      const targetTagId = targetTagIds.get(text(row.id));
      if (!targetTagId) continue;
      this.db
        .prepare("INSERT OR IGNORE INTO node_tags (node_id, tag_id) VALUES (?, ?)")
        .run(text(row.node_id), targetTagId);
      this.db
        .prepare("DELETE FROM node_tags WHERE node_id = ? AND tag_id = ?")
        .run(text(row.node_id), text(row.id));
    }

    for (const row of fieldValueRows) {
      const targetFieldId = targetFieldIds.get(text(row.field_id));
      if (!targetFieldId) continue;
      this.db
        .prepare("INSERT INTO field_values (node_id, field_id, value, updated_at) VALUES (?, ?, ?, ?)")
        .run(text(row.node_id), targetFieldId, text(row.value), now);
      this.db
        .prepare("DELETE FROM field_values WHERE node_id = ? AND field_id = ?")
        .run(text(row.node_id), text(row.field_id));
    }
  }

  private recordOutlineMutation<T>(
    workspaceId: string,
    label: string,
    coalesceKey: string | null,
    mutation: () => T
  ): T {
    if (this.outlineHistorySuppressionDepth > 0) return mutation();

    return this.transaction(() => {
      const beforeSnapshot = JSON.stringify(this.captureOutlineSnapshot(workspaceId));
      const result = mutation();
      const afterSnapshot = JSON.stringify(this.captureOutlineSnapshot(workspaceId));
      if (beforeSnapshot === afterSnapshot) return result;

      const now = timestamp();
      this.db.prepare("DELETE FROM outline_history WHERE workspace_id = ? AND undone = 1").run(workspaceId);
      const previous = coalesceKey
        ? this.db
            .prepare(
              `SELECT seq, updated_at FROM outline_history
               WHERE workspace_id = ? AND undone = 0 AND coalesce_key = ?
               ORDER BY seq DESC LIMIT 1`
            )
            .get(workspaceId, coalesceKey) as Row | undefined
        : undefined;
      const latest = this.db
        .prepare("SELECT seq FROM outline_history WHERE workspace_id = ? AND undone = 0 ORDER BY seq DESC LIMIT 1")
        .get(workspaceId) as Row | undefined;
      const canCoalesce = previous && latest && number(previous.seq) === number(latest.seq) &&
        Date.now() - Date.parse(text(previous.updated_at)) <= outlineHistoryCoalesceWindowMs;

      if (canCoalesce) {
        this.db
          .prepare("UPDATE outline_history SET label = ?, after_snapshot = ?, updated_at = ? WHERE seq = ?")
          .run(label, afterSnapshot, now, number(previous.seq));
      } else {
        this.db
          .prepare(
            `INSERT INTO outline_history
              (id, workspace_id, label, before_snapshot, after_snapshot, coalesce_key, undone, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
          )
          .run(randomUUID(), workspaceId, label, beforeSnapshot, afterSnapshot, coalesceKey, now, now);
      }

      this.db
        .prepare(
          `DELETE FROM outline_history
           WHERE workspace_id = ? AND seq IN (
             SELECT seq FROM outline_history WHERE workspace_id = ? ORDER BY seq DESC LIMIT -1 OFFSET ?
           )`
        )
        .run(workspaceId, workspaceId, outlineHistoryLimit);
      return result;
    });
  }

  private replayOutlineHistory(workspaceId: string, direction: "undo" | "redo"): OutlineHistoryResult {
    const workspace = this.getWorkspace(workspaceId);
    return this.transaction(() => {
      const entry = this.db
        .prepare(
          direction === "undo"
            ? "SELECT * FROM outline_history WHERE workspace_id = ? AND undone = 0 ORDER BY seq DESC LIMIT 1"
            : "SELECT * FROM outline_history WHERE workspace_id = ? AND undone = 1 ORDER BY seq ASC LIMIT 1"
        )
        .get(workspaceId) as Row | undefined;
      if (!entry) {
        return {
          tree: this.getTree(workspace.rootNodeId),
          history: this.getOutlineHistoryState(workspaceId)
        };
      }

      const snapshot = JSON.parse(
        text(direction === "undo" ? entry.before_snapshot : entry.after_snapshot)
      ) as OutlineNodeSnapshot[];
      this.withoutOutlineHistory(() => this.applyOutlineSnapshot(workspaceId, snapshot));
      this.db
        .prepare("UPDATE outline_history SET undone = ?, updated_at = ? WHERE seq = ?")
        .run(direction === "undo" ? 1 : 0, timestamp(), number(entry.seq));
      return {
        tree: this.getTree(workspace.rootNodeId),
        history: this.getOutlineHistoryState(workspaceId)
      };
    });
  }

  private captureOutlineSnapshot(workspaceId: string): OutlineNodeSnapshot[] {
    return (this.db
      .prepare("SELECT * FROM nodes WHERE workspace_id = ? ORDER BY created_at ASC, id ASC")
      .all(workspaceId) as Row[]).map(row => ({
      id: text(row.id),
      parentId: nullableText(row.parent_id),
      position: number(row.position),
      title: text(row.title),
      body: text(row.body),
      dueDate: nullableText(row.due_date),
      done: Boolean(number(row.done)),
      collapsed: Boolean(number(row.collapsed)),
      deletedAt: nullableText(row.deleted_at),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at)
    }));
  }

  private applyOutlineSnapshot(workspaceId: string, snapshot: OutlineNodeSnapshot[]): void {
    const snapshotIds = new Set(snapshot.map(node => node.id));
    const currentIds = (this.db
      .prepare("SELECT id FROM nodes WHERE workspace_id = ?")
      .all(workspaceId) as Row[]).map(row => text(row.id));
    const update = this.db.prepare(
      `UPDATE nodes SET
        parent_id = ?, position = ?, title = ?, body = ?, due_date = ?, done = ?, collapsed = ?,
        deleted_at = ?, created_at = ?, updated_at = ?
       WHERE id = ? AND workspace_id = ?`
    );

    for (const node of snapshot) {
      update.run(
        node.parentId,
        node.position,
        node.title,
        node.body,
        node.dueDate,
        node.done ? 1 : 0,
        node.collapsed ? 1 : 0,
        node.deletedAt,
        node.createdAt,
        node.updatedAt,
        node.id,
        workspaceId
      );
    }

    const markDeleted = this.db.prepare(
      "UPDATE nodes SET deleted_at = COALESCE(deleted_at, ?), updated_at = ? WHERE id = ? AND workspace_id = ?"
    );
    const now = timestamp();
    for (const id of currentIds) {
      if (!snapshotIds.has(id)) markDeleted.run(now, now, id, workspaceId);
    }
  }

  private withoutOutlineHistory<T>(fn: () => T): T {
    this.outlineHistorySuppressionDepth += 1;
    try {
      return fn();
    } finally {
      this.outlineHistorySuppressionDepth -= 1;
    }
  }

  private isDescendant(candidateId: string, ancestorId: string): boolean {
    let current: OutlineNode | null = this.getNode(candidateId);
    while (current.parentId) {
      if (current.parentId === ancestorId) return true;
      current = this.getNode(current.parentId);
    }
    return false;
  }

  private normalizeWorkspaceFolderId(folderId?: string | null): string | null {
    if (!folderId) return null;
    return this.getWorkspaceFolder(folderId).id;
  }

  private normalizeWorkspaceParentId(parentWorkspaceId?: string | null, workspaceId?: string): string | null {
    if (!parentWorkspaceId) return null;
    const parent = this.getWorkspace(parentWorkspaceId);
    if (parent.id === workspaceId) throw new ValidationError("Workspace cannot be its own parent.");
    if (workspaceId && this.isWorkspaceDescendant(parent.id, workspaceId)) {
      throw new ValidationError("Workspace cannot be moved into its descendant.");
    }
    return parent.id;
  }

  private isWorkspaceDescendant(candidateId: string, ancestorId: string): boolean {
    let current = this.getWorkspace(candidateId);
    while (current.parentWorkspaceId) {
      if (current.parentWorkspaceId === ancestorId) return true;
      current = this.getWorkspace(current.parentWorkspaceId);
    }
    return false;
  }

  private countWorkspacesInContainer(folderId: string | null, parentWorkspaceId: string | null): number {
    return number(
      (this.db
        .prepare("SELECT COUNT(*) AS count FROM workspaces WHERE folder_id IS ? AND parent_workspace_id IS ?")
        .get(folderId, parentWorkspaceId) as Row).count
    );
  }

  private findWorkspaceFolderByName(name: string): WorkspaceFolder | null {
    const row = this.db
      .prepare("SELECT * FROM workspace_folders WHERE name = ? ORDER BY position ASC, created_at ASC LIMIT 1")
      .get(name) as Row | undefined;
    return row ? rowToWorkspaceFolder(row) : null;
  }

  private transaction<T>(fn: () => T): T {
    if (this.transactionDepth > 0) return fn();

    this.transactionDepth = 1;
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    } finally {
      this.transactionDepth = 0;
    }
  }
}

export class NotFoundError extends Error {
  statusCode = 404;
}

export class ValidationError extends Error {
  statusCode = 400;
}

function rowToWorkspace(row: Row): Workspace {
  return {
    id: text(row.id),
    name: text(row.name),
    icon: text(row.icon) || "folder-tree",
    folderId: nullableText(row.folder_id),
    parentWorkspaceId: nullableText(row.parent_workspace_id),
    position: number(row.position),
    rootNodeId: text(row.root_node_id),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at)
  };
}

function rowToWorkspaceFolder(row: Row): WorkspaceFolder {
  return {
    id: text(row.id),
    name: text(row.name),
    position: number(row.position),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at)
  };
}

function rowToNode(row: Row): OutlineNode {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    parentId: nullableText(row.parent_id),
    position: number(row.position),
    title: text(row.title),
    body: text(row.body),
    dueDate: nullableText(row.due_date),
    done: Boolean(number(row.done)),
    collapsed: Boolean(number(row.collapsed)),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at)
  };
}

function normalizeDueDate(value: string | null): string | null {
  if (value === null) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ValidationError("Date must use the YYYY-MM-DD format.");
  }
  return value;
}

function outlineUpdateLabel(fields: string[]): string {
  if (fields.length !== 1) return "Edit outline";
  if (fields[0] === "title") return "Edit title";
  if (fields[0] === "body") return "Edit notes";
  if (fields[0] === "dueDate") return "Change date";
  if (fields[0] === "done") return "Toggle completion";
  if (fields[0] === "collapsed") return "Toggle outline";
  return "Edit outline";
}

function rowToTag(row: Row): Tag {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    name: text(row.name),
    color: text(row.color),
    createdAt: text(row.created_at)
  };
}

function rowToMatchedTag(row: Row): Tag {
  return {
    id: text(row.matched_tag_id),
    workspaceId: text(row.matched_tag_workspace_id),
    name: text(row.matched_tag_name),
    color: text(row.matched_tag_color),
    createdAt: text(row.matched_tag_created_at)
  };
}

function rowToResultWorkspace(row: Row): Workspace {
  return {
    id: text(row.result_workspace_id),
    name: text(row.result_workspace_name),
    icon: text(row.result_workspace_icon),
    folderId: nullableText(row.result_workspace_folder_id),
    parentWorkspaceId: nullableText(row.result_workspace_parent_workspace_id),
    position: number(row.result_workspace_position),
    rootNodeId: text(row.result_workspace_root_node_id),
    createdAt: text(row.result_workspace_created_at),
    updatedAt: text(row.result_workspace_updated_at)
  };
}

function rowToFieldDefinition(row: Row): FieldDefinition {
  return {
    id: text(row.id),
    workspaceId: text(row.workspace_id),
    tagId: text(row.tag_id),
    name: text(row.name),
    type: text(row.type) as FieldType,
    options: nullableText(row.options),
    createdAt: text(row.created_at)
  };
}

function rowToFieldValue(row: Row): FieldValue {
  return {
    nodeId: text(row.node_id),
    fieldId: text(row.field_id),
    value: text(row.value),
    updatedAt: text(row.updated_at)
  };
}

function timestamp(): string {
  return new Date().toISOString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function text(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function nullableText(value: unknown): string | null {
  return value === null || value === undefined ? null : text(value);
}

function number(value: unknown): number {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result << 5) - result + value.charCodeAt(index);
    result |= 0;
  }
  return result;
}

function normalizeWorkspaceIcon(icon?: string): string {
  const value = icon?.trim();
  if (value && /^[a-z0-9][a-z0-9-]*$/.test(value)) return value;
  return workspaceIcons[Math.floor(Math.random() * workspaceIcons.length)] ?? "folder-tree";
}
