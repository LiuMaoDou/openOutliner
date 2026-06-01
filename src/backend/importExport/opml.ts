import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type { OutlineTreeNode } from "../domain/types.js";
import { type OutlinerService, ValidationError } from "../services/outliner.js";

interface OpmlOutline {
  "@_text"?: string;
  "@_title"?: string;
  "@_done"?: string;
  "@_note"?: string;
  "@__note"?: string;
  "@_description"?: string;
  "@__description"?: string;
  outline?: OpmlOutline | OpmlOutline[];
}

interface ParsedOpml {
  opml?: {
    head?: { title?: string };
    body?: { outline?: OpmlOutline | OpmlOutline[] };
  };
}

export function exportOpml(service: OutlinerService, workspaceId: string): string {
  const workspace = service.getWorkspace(workspaceId);
  const root = service.getTree(workspace.rootNodeId);
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
    suppressBooleanAttributes: false,
    suppressEmptyNode: true
  });

  return builder.build({
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    opml: {
      "@_version": "2.0",
      head: { title: workspace.name },
      body: {
        outline: nodesToOpml(root.children)
      }
    }
  });
}

export function importOpml(
  service: OutlinerService,
  input: { workspaceId?: string; parentId?: string; content: string }
): { imported: number; workspaceId: string } {
  const parser = new XMLParser({ ignoreAttributes: false });
  const parsed = parser.parse(input.content) as ParsedOpml;
  const workspace = targetWorkspace(service, input, parsed);
  const parentId = input.parentId ?? workspace.rootNodeId;
  const outlines = asArray(parsed.opml?.body?.outline);
  let imported = 0;

  const importOutline = (outline: OpmlOutline, targetParentId: string): void => {
    const title = (outline["@_text"] ?? outline["@_title"] ?? "").trim();
    if (!title) {
      for (const child of asArray(outline.outline)) {
        importOutline(child, targetParentId);
      }
      return;
    }

    const node = service.createNode({
      parentId: targetParentId,
      title,
      body: outlineBody(outline),
      done: String(outline["@_done"]).toLowerCase() === "true"
    });
    imported += 1;
    for (const child of asArray(outline.outline)) {
      importOutline(child, node.id);
    }
  };

  for (const outline of outlines) {
    importOutline(outline, parentId);
  }

  return { imported, workspaceId: workspace.id };
}

function nodesToOpml(nodes: OutlineTreeNode[]): OpmlOutline[] {
  return nodes.flatMap(nodeToOpml);
}

function nodeToOpml(node: OutlineTreeNode): OpmlOutline[] {
  const title = node.title.trim();
  const children = nodesToOpml(node.children);
  if (!title) return children;

  const outline: OpmlOutline = {
    "@_text": title,
    "@_done": node.done ? "true" : "false"
  };
  if (node.body.trim()) outline["@__note"] = node.body.trim();
  if (children.length > 0) outline.outline = children;
  return [outline];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function opmlTitle(parsed: ParsedOpml): string {
  const title = parsed.opml?.head?.title?.trim();
  return title || "Imported OPML";
}

function targetWorkspace(
  service: OutlinerService,
  input: { workspaceId?: string; parentId?: string },
  parsed: ParsedOpml
) {
  if (input.parentId) {
    const parent = service.getNode(input.parentId);
    if (input.workspaceId && input.workspaceId !== parent.workspaceId) {
      throw new ValidationError("Parent node must belong to the selected workspace.");
    }
    return service.getWorkspace(parent.workspaceId);
  }
  if (input.workspaceId) return service.getWorkspace(input.workspaceId);
  return service.createWorkspace(opmlTitle(parsed));
}

function outlineBody(outline: OpmlOutline): string {
  return (
    outline["@__note"] ??
    outline["@_note"] ??
    outline["@__description"] ??
    outline["@_description"] ??
    ""
  ).trim();
}
