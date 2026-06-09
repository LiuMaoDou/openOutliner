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
  TaggedNodeResult,
  UpdateNodeInput,
  Workspace
} from "../domain/types.js";

type Row = Record<string, unknown>;
type SqlValue = string | number | bigint | Buffer | null;

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

  constructor(private readonly db: OpenOutlinerDb) {}

  ensureSeedData(): Workspace {
    const existing = this.listWorkspaces()[0];
    if (existing) return existing;

    const workspace = this.createWorkspace("OpenOutliner Demo");
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
    return workspace;
  }

  listWorkspaces(): Workspace[] {
    return this.db
      .prepare("SELECT * FROM workspaces ORDER BY created_at ASC")
      .all()
      .map(rowToWorkspace);
  }

  createWorkspace(name: string, icon?: string): Workspace {
    const now = timestamp();
    const workspaceId = randomUUID();
    const rootNodeId = randomUUID();
    const workspaceIcon = normalizeWorkspaceIcon(icon);

    this.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO workspaces (id, name, icon, root_node_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .run(workspaceId, name, workspaceIcon, rootNodeId, now, now);
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

  getWorkspace(id: string): Workspace {
    const row = this.db.prepare("SELECT * FROM workspaces WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new NotFoundError(`Workspace not found: ${id}`);
    return rowToWorkspace(row);
  }

  updateWorkspace(id: string, input: { name?: string }): Workspace {
    const workspace = this.getWorkspace(id);
    const name = input.name?.trim();
    if (!name) throw new ValidationError("Workspace name is required.");
    const now = timestamp();

    this.transaction(() => {
      this.db
        .prepare("UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?")
        .run(name, now, id);
      this.db
        .prepare("UPDATE nodes SET title = ?, updated_at = ? WHERE id = ?")
        .run(name, now, workspace.rootNodeId);
    });

    return this.getWorkspace(id);
  }

  deleteWorkspace(id: string): { deleted: string } {
    this.getWorkspace(id);
    this.db.prepare("DELETE FROM workspaces WHERE id = ?").run(id);
    return { deleted: id };
  }

  replaceAllWorkspaces<T>(build: () => T): T {
    return this.transaction(() => {
      this.db.prepare("DELETE FROM workspaces").run();
      return build();
    });
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
  }

  updateNode(id: string, input: UpdateNodeInput): OutlineNode {
    this.getNode(id);
    const sets: string[] = [];
    const values: SqlValue[] = [];

    if (input.title !== undefined) {
      sets.push("title = ?");
      values.push(input.title);
    }
    if (input.body !== undefined) {
      sets.push("body = ?");
      values.push(input.body);
    }
    if (input.done !== undefined) {
      sets.push("done = ?");
      values.push(input.done ? 1 : 0);
    }
    if (input.collapsed !== undefined) {
      sets.push("collapsed = ?");
      values.push(input.collapsed ? 1 : 0);
    }

    if (sets.length === 0) return this.getNode(id);
    sets.push("updated_at = ?");
    values.push(timestamp(), id);
    this.db.prepare(`UPDATE nodes SET ${sets.join(", ")} WHERE id = ?`).run(...values);
    return this.getNode(id);
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
  }

  deleteNode(id: string): { deleted: string[] } {
    const node = this.getNode(id);
    const workspace = this.getWorkspace(node.workspaceId);
    if (workspace.rootNodeId === id) throw new ValidationError("Workspace root nodes cannot be deleted.");
    const now = timestamp();
    const rows = this.db
      .prepare(
        `WITH RECURSIVE subtree(id) AS (
          SELECT id FROM nodes WHERE id = ?
          UNION ALL
          SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id = subtree.id
          WHERE nodes.deleted_at IS NULL
        )
        SELECT id FROM subtree`
      )
      .all(id) as Row[];

    this.transaction(() => {
      this.db
        .prepare(
          `WITH RECURSIVE subtree(id) AS (
            SELECT id FROM nodes WHERE id = ?
            UNION ALL
            SELECT nodes.id FROM nodes JOIN subtree ON nodes.parent_id = subtree.id
            WHERE nodes.deleted_at IS NULL
          )
          UPDATE nodes SET deleted_at = ?, updated_at = ? WHERE id IN (SELECT id FROM subtree)`
        )
        .run(id, now, now);
      this.db
        .prepare(
          `UPDATE nodes
           SET position = position - 1, updated_at = ?
           WHERE workspace_id = ? AND parent_id IS ? AND deleted_at IS NULL AND position > ?`
        )
        .run(now, node.workspaceId, node.parentId, node.position);
    });

    return { deleted: rows.map(row => text(row.id)) };
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

    const tagsByNode = new Map<string, Tag[]>();
    const nodeIds = rows.map(row => text(row.id));
    if (nodeIds.length > 0) {
      const placeholders = nodeIds.map(() => "?").join(", ");
      for (const row of this.db
        .prepare(
          `SELECT node_tags.node_id, tags.* FROM node_tags
           JOIN tags ON node_tags.tag_id = tags.id
           WHERE node_tags.node_id IN (${placeholders})
           ORDER BY tags.name ASC`
        )
        .all(...nodeIds) as Row[]) {
        const nodeId = text(row.node_id);
        const tags = tagsByNode.get(nodeId) ?? [];
        tags.push(rowToTag(row));
        tagsByNode.set(nodeId, tags);
      }
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

  private isDescendant(candidateId: string, ancestorId: string): boolean {
    let current: OutlineNode | null = this.getNode(candidateId);
    while (current.parentId) {
      if (current.parentId === ancestorId) return true;
      current = this.getNode(current.parentId);
    }
    return false;
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
    rootNodeId: text(row.root_node_id),
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
    done: Boolean(number(row.done)),
    collapsed: Boolean(number(row.collapsed)),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at)
  };
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
