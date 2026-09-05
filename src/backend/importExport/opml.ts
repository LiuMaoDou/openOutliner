import { XMLBuilder, XMLParser, XMLValidator } from "fast-xml-parser";
import type { OutlineTreeNode, Workspace } from "../domain/types.js";
import { type OutlinerService, ValidationError } from "../services/outliner.js";
import { nodeExportMetadata, parseNodeExportMetadata } from "./metadata.js";

interface OpmlOutline {
  "@_text"?: string;
  "@_title"?: string;
  "@_done"?: string;
  "@_tags"?: string;
  "@_note"?: string;
  "@__note"?: string;
  "@_description"?: string;
  "@__description"?: string;
  "@_openoutlinerWorkspace"?: string;
  "@_openoutlinerIcon"?: string;
  "@_openoutlinerMetadata"?: string;
  "@_dueDate"?: string;
  "@_collapsed"?: string;
  outline?: OpmlOutline | OpmlOutline[];
}

interface ParsedOpml {
  opml?: {
    head?: { title?: string };
    body?: { outline?: OpmlOutline | OpmlOutline[] };
  };
}

interface ParsedWorkspace {
  name: string;
  icon?: string;
  outlines: OpmlOutline[];
}

export interface OpmlImportResult {
  imported: number;
  workspaceId: string;
  workspaceIds?: string[];
  workspaces?: number;
}

export function exportOpml(service: OutlinerService, workspaceId?: string): string {
  const workspace = workspaceId ? service.getWorkspace(workspaceId) : undefined;
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    format: true,
    suppressBooleanAttributes: false,
    suppressEmptyNode: true
  });
  const outline = workspace
    ? nodesToOpml(service.getTree(workspace.rootNodeId).children)
    : service.listWorkspaces().map(item => workspaceToOpml(service, item));

  return builder.build({
    "?xml": { "@_version": "1.0", "@_encoding": "UTF-8" },
    opml: {
      "@_version": "2.0",
      head: { title: workspace?.name ?? "OpenOutliner" },
      body: {
        outline
      }
    }
  });
}

export function importOpml(
  service: OutlinerService,
  input: { workspaceId?: string; parentId?: string; content: string }
): OpmlImportResult {
  if (!input.content.trim() || /<!DOCTYPE\b/i.test(input.content) || XMLValidator.validate(input.content) !== true) {
    throw new ValidationError("Choose a valid, non-empty OPML file.");
  }
  const parser = new XMLParser({ ignoreAttributes: false, trimValues: false, parseTagValue: false });
  const parsed = parser.parse(input.content) as ParsedOpml;
  if (!parsed.opml || !parsed.opml.body || asArray(parsed.opml.body.outline).length === 0) {
    throw new ValidationError("No outline nodes found in OPML.");
  }
  return service.importTransaction(() => {
    if (!input.workspaceId && !input.parentId) {
      return importAllOpml(service, parsed);
    }

    const workspace = targetWorkspace(service, input, parsed);
    const parentId = input.parentId ?? workspace.rootNodeId;
    const outlines = asArray(parsed.opml?.body?.outline);
    const imported = service.importOutlineBatch(workspace.id, () => importOutlines(service, outlines, parentId));
    if (imported === 0) throw new ValidationError("No outline nodes found in OPML.");

    return { imported, workspaceId: workspace.id };
  });
}

function importAllOpml(service: OutlinerService, parsed: ParsedOpml): OpmlImportResult {
  const parsedWorkspaces = parseOpmlWorkspaces(parsed);
  const workspaceIds: string[] = [];
  let imported = 0;

  for (const parsedWorkspace of parsedWorkspaces) {
    const workspace = service.createWorkspace(parsedWorkspace.name, parsedWorkspace.icon);
    workspaceIds.push(workspace.id);
    imported += service.importOutlineBatch(workspace.id, () => importOutlines(service, parsedWorkspace.outlines, workspace.rootNodeId));
  }
  if (imported === 0 && !asArray(parsed.opml?.body?.outline).some(isWorkspaceOutline)) {
    throw new ValidationError("No outline nodes found in OPML.");
  }

  return {
    imported,
    workspaceId: workspaceIds[0] ?? "",
    workspaceIds,
    workspaces: workspaceIds.length
  };
}

function nodesToOpml(nodes: OutlineTreeNode[]): OpmlOutline[] {
  return nodes.flatMap(nodeToOpml);
}

function workspaceToOpml(service: OutlinerService, workspace: Workspace): OpmlOutline {
  const children = nodesToOpml(service.getTree(workspace.rootNodeId).children);
  const outline: OpmlOutline = {
    "@_text": workspace.name,
    "@_openoutlinerWorkspace": "true",
    "@_openoutlinerIcon": workspace.icon
  };
  if (children.length > 0) outline.outline = children;
  return outline;
}

function nodeToOpml(node: OutlineTreeNode): OpmlOutline[] {
  const title = node.title.trim();
  const children = nodesToOpml(node.children);

  const outline: OpmlOutline = {
    "@_text": title || "(Untitled)",
    "@_done": node.done ? "true" : "false",
    "@_openoutlinerMetadata": JSON.stringify(nodeExportMetadata(node))
  };
  if (node.tags.length > 0) outline["@_tags"] = node.tags.map(tag => tag.name).join(" ");
  if (node.body) outline["@__note"] = node.body;
  if (node.dueDate) outline["@_dueDate"] = node.dueDate;
  if (node.collapsed) outline["@_collapsed"] = "true";
  if (children.length > 0) outline.outline = children;
  return [outline];
}

function importOutlines(service: OutlinerService, outlines: OpmlOutline[], parentId: string): number {
  let imported = 0;

  const importOutline = (outline: OpmlOutline, targetParentId: string): void => {
    if (!outline || typeof outline !== "object") throw new ValidationError("Invalid OPML outline.");
    const metadata = outline["@_openoutlinerMetadata"] === undefined ? undefined : parseNodeExportMetadata(outline["@_openoutlinerMetadata"]);
    if (metadata && (
      normalizeXmlLineEndings(outline["@_text"] ?? "") !== normalizeXmlLineEndings(metadata.title.trim() || "(Untitled)") ||
      normalizeXmlLineEndings(outlineBody(outline)) !== normalizeXmlLineEndings(metadata.body) ||
      (String(outline["@_done"]).toLowerCase() === "true") !== metadata.done ||
      normalizeXmlLineEndings(String(outline["@_tags"] ?? "")) !== normalizeXmlLineEndings(metadata.tags.join(" ")) ||
      (outline["@_dueDate"] ?? null) !== metadata.dueDate ||
      (String(outline["@_collapsed"]).toLowerCase() === "true") !== metadata.collapsed
    )) {
      throw new ValidationError("The OPML outline fields differ from their export metadata. Remove the openoutlinerMetadata attribute to import external edits as standard OPML.");
    }
    const title = metadata?.title ?? outlineTitle(outline);
    if (!title && !metadata) {
      for (const child of asArray(outline.outline)) {
        importOutline(child, targetParentId);
      }
      return;
    }

    const node = service.createNode({
      parentId: targetParentId,
      title,
      body: metadata?.body ?? outlineBody(outline),
      done: metadata?.done ?? String(outline["@_done"]).toLowerCase() === "true"
    });
    service.updateNode(node.id, {
      dueDate: metadata?.dueDate ?? outline["@_dueDate"] ?? null,
      collapsed: metadata?.collapsed ?? String(outline["@_collapsed"]).toLowerCase() === "true"
    });
    imported += 1;
    for (const tag of metadata?.tags ?? outlineTags(outline)) {
      service.setNodeTag(node.id, tag);
    }
    for (const child of asArray(outline.outline)) {
      importOutline(child, node.id);
    }
  };

  for (const outline of outlines) {
    importOutline(outline, parentId);
  }

  return imported;
}

function parseOpmlWorkspaces(parsed: ParsedOpml): ParsedWorkspace[] {
  const outlines = asArray(parsed.opml?.body?.outline);
  const workspaceOutlines = outlines.filter(isWorkspaceOutline);
  if (workspaceOutlines.length > 0) {
    const workspaces = workspaceOutlines.map(outline => ({
      name: outlineTitle(outline) || "Imported OPML",
      icon: outline["@_openoutlinerIcon"]?.trim() || undefined,
      outlines: asArray(outline.outline)
    }));
    const remaining = outlines.filter(outline => !isWorkspaceOutline(outline));
    if (remaining.length > 0) workspaces.push({ name: opmlTitle(parsed), icon: undefined, outlines: remaining });
    return workspaces;
  }

  if (outlines.length === 0) return [];
  return [{ name: opmlTitle(parsed), outlines }];
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function isWorkspaceOutline(outline: OpmlOutline): boolean {
  return String(outline["@_openoutlinerWorkspace"]).toLowerCase() === "true";
}

function outlineTitle(outline: OpmlOutline): string {
  return (outline["@_text"] ?? outline["@_title"] ?? "").trim();
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
  );
}

function outlineTags(outline: OpmlOutline): string[] {
  return String(outline["@_tags"] ?? "")
    .split(/\s+/)
    .map(tag => tag.trim().replace(/^#/, ""))
    .filter(Boolean);
}

function normalizeXmlLineEndings(value: string): string {
  // XML normalizes CR and CRLF before parsing. Compare that representation while
  // retaining the exact original line endings in the versioned metadata.
  return value.replace(/\r\n?/g, "\n");
}
