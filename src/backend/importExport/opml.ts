import { XMLBuilder, XMLParser } from "fast-xml-parser";
import type { OutlineTreeNode } from "../domain/types.js";
import type { OutlinerService } from "../services/outliner.js";

interface OpmlOutline {
  "@_text"?: string;
  "@_title"?: string;
  "@_done"?: string;
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
    suppressEmptyNode: true
  });

  return builder.build({
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    opml: {
      "@_version": "2.0",
      head: { title: workspace.name },
      body: {
        outline: root.children.map(nodeToOpml)
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

function nodeToOpml(node: OutlineTreeNode): OpmlOutline {
  return {
    "@_text": node.title,
    "@_done": node.done ? "true" : "false",
    outline: node.children.map(nodeToOpml)
  };
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
  if (input.workspaceId) return service.getWorkspace(input.workspaceId);
  if (input.parentId) return service.getWorkspace(service.getNode(input.parentId).workspaceId);
  return service.createWorkspace(opmlTitle(parsed));
}
