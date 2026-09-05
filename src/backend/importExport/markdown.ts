import type { OutlineTreeNode } from "../domain/types.js";
import { type OutlinerService, ValidationError } from "../services/outliner.js";
import { nodeExportMetadata, parseNodeExportMetadata } from "./metadata.js";

interface ParsedLine {
  kind: "bullet" | "heading";
  level: number;
  title: string;
  done: boolean;
  tags: string[];
  body: string[];
  dueDate?: string | null;
  collapsed?: boolean;
}

interface ParsedWorkspace {
  name: string;
  lines: ParsedLine[];
}

export interface MarkdownImportResult {
  imported: number;
  workspaceId?: string;
  workspaceIds?: string[];
  workspaces?: number;
}

export function exportMarkdown(service: OutlinerService, workspaceId?: string): string {
  const workspaces = workspaceId ? [service.getWorkspace(workspaceId)] : service.listWorkspaces();
  const lines: string[] = [];

  for (const workspace of workspaces) {
    if (lines.length > 0) lines.push("");
    const root = service.getTree(workspace.rootNodeId);
    lines.push(`# ${workspace.name}`, "");
    for (const child of root.children) {
      writeNode(lines, child, 0);
    }
  }

  const content = lines.join("\n");
  return content ? `${content}\n` : "";
}

export function importMarkdown(
  service: OutlinerService,
  input: { workspaceId?: string; parentId?: string; content: string }
): MarkdownImportResult {
  if (!input.content.trim() || /^\s*<\?xml\b|^\s*<opml\b/i.test(input.content)) {
    throw new ValidationError("Choose a non-empty Markdown outline, or import this XML file as OPML.");
  }
  return service.importTransaction(() => {
    if (!input.workspaceId && !input.parentId) {
      return importAllMarkdown(service, input.content);
    }

    const target = targetWorkspace(service, input);
    const parsed = parseMarkdownLines(input.content);
    if (parsed[0]?.kind === "heading" && parsed[0].level === 0 && parsed[0].title === target.workspace.name) {
      parsed.shift();
    }
    if (parsed.length === 0) throw new ValidationError("No outline nodes found in Markdown.");
    const imported = service.importOutlineBatch(target.workspace.id, () => importParsedLines(service, target.parentId, parsed));
    return { imported, workspaceId: target.workspace.id };
  });
}

function importAllMarkdown(service: OutlinerService, content: string): MarkdownImportResult {
  const parsedWorkspaces = parseMarkdownWorkspaces(content);
  if (parsedWorkspaces.length === 0) throw new ValidationError("No outline nodes found in Markdown.");
  const workspaceIds: string[] = [];
  let imported = 0;

  for (const parsedWorkspace of parsedWorkspaces) {
    const workspace = service.createWorkspace(parsedWorkspace.name);
    workspaceIds.push(workspace.id);
    imported += service.importOutlineBatch(workspace.id, () => importParsedLines(service, workspace.rootNodeId, parsedWorkspace.lines));
  }

  return {
    imported,
    workspaceId: workspaceIds[0],
    workspaceIds,
    workspaces: workspaceIds.length
  };
}

function importParsedLines(service: OutlinerService, parentId: string, parsed: ParsedLine[]): number {
  const stack: string[] = [parentId];
  let imported = 0;
  for (const line of parsed) {
    const safeLevel = Math.max(0, Math.min(line.level, stack.length - 1));
    const node = service.createNode({
      parentId: stack[safeLevel],
      title: line.title,
      body: line.body.join("\n"),
      done: line.done
    });
    for (const tag of line.tags) {
      service.setNodeTag(node.id, tag);
    }
    if (line.dueDate !== undefined || line.collapsed !== undefined) {
      service.updateNode(node.id, { dueDate: line.dueDate, collapsed: line.collapsed });
    }
    stack[safeLevel + 1] = node.id;
    stack.length = safeLevel + 2;
    imported += 1;
  }

  return imported;
}

function parseMarkdownWorkspaces(content: string): ParsedWorkspace[] {
  const parsed = parseMarkdownLines(content);
  const workspaces: ParsedWorkspace[] = [];
  let current: ParsedWorkspace | undefined;

  for (const line of parsed) {
    if (line.kind === "heading" && line.level === 0) {
      current = { name: line.title || "Imported Markdown", lines: [] };
      workspaces.push(current);
      continue;
    }

    if (!current) {
      current = { name: "Imported Markdown", lines: [] };
      workspaces.push(current);
    }
    current.lines.push(line);
  }

  return workspaces;
}

function targetWorkspace(
  service: OutlinerService,
  input: { workspaceId?: string; parentId?: string }
) {
  if (input.parentId) {
    const parent = service.getNode(input.parentId);
    if (input.workspaceId && input.workspaceId !== parent.workspaceId) {
      throw new ValidationError("Parent node must belong to the selected workspace.");
    }
    const workspace = service.getWorkspace(parent.workspaceId);
    return { workspace, parentId: parent.id };
  }

  if (!input.workspaceId) throw new ValidationError("Workspace ID is required.");
  const workspace = service.getWorkspace(input.workspaceId);
  return { workspace, parentId: workspace.rootNodeId };
}

function writeNode(lines: string[], node: OutlineTreeNode, depth: number): void {
  const title = node.title.trim();
  const indent = "  ".repeat(depth);
  const checkbox = node.done ? "[x] " : "";
  const tags = node.tags.length > 0 ? ` ${node.tags.map(tag => `#${singleLineText(tag.name)}`).join(" ")}` : "";
  lines.push(`${indent}- ${checkbox}${singleLineText(title) || "(Untitled)"}${tags}`);
  // The visible list stays readable in other Markdown tools. Metadata lets an
  // import distinguish note lists/code from outline children without losing text.
  lines.push(`${indent}  <!-- openoutliner-node:v1 ${encodeURIComponent(JSON.stringify(nodeExportMetadata(node)))} -->`);
  if (node.body) {
    for (const bodyLine of node.body.split(/\r\n|\r|\n/)) {
      lines.push(`${indent}  ${bodyLine}`);
    }
  }
  for (const child of node.children) {
    writeNode(lines, child, depth + 1);
  }
}

function parseMarkdownLines(content: string): ParsedLine[] {
  const parsed: ParsedLine[] = [];
  const stack: ParsedLine[] = [];
  const rawLines = content.split(/\r\n|\r|\n/);
  for (let index = 0; index < rawLines.length; index += 1) {
    const rawLine = rawLines[index];
    const metadata = rawLine.match(/^\s*<!-- openoutliner-node:v1 (.*?) -->\s*$/);
    if (metadata) {
      const target = parsed.at(-1);
      if (!target || target.kind !== "bullet") throw new ValidationError("Export metadata must follow an outline node.");
      let decoded: string;
      try { decoded = decodeURIComponent(metadata[1]); }
      catch { throw new ValidationError("Invalid OpenOutliner export metadata."); }
      const node = parseNodeExportMetadata(decoded);
      const indent = rawLine.match(/^\s*/)?.[0] ?? "";
      const checkbox = node.done ? "[x] " : "";
      const tags = node.tags.length > 0 ? ` ${node.tags.map(tag => `#${singleLineText(tag)}`).join(" ")}` : "";
      const visibleTitle = singleLineText(node.title.trim()) || "(Untitled)";
      if (rawLines[index - 1] !== `${indent.slice(0, -2)}- ${checkbox}${visibleTitle}${tags}`) {
        throw new ValidationError("The Markdown outline text or tags differ from their export metadata. Remove the metadata comment to import external edits as plain Markdown.");
      }
      Object.assign(target, node, { body: node.body.split("\n") });
      const bodyLines = node.body ? node.body.split(/\r\n|\r|\n/) : [];
      if (bodyLines.some((line, offset) => rawLines[index + offset + 1] !== `${indent}${line}`)) {
        throw new ValidationError("The Markdown export notes are truncated or differ from their metadata. Remove the metadata comment to import external edits as plain Markdown.");
      }
      index += bodyLines.length;
      continue;
    }
    const bullet = rawLine.match(/^(\s*)[-*]\s+(?:(\[[ xX]\])\s+)?(.+?)\s*$/);
    if (bullet) {
      const title = parseTitleTags(bullet[3].trim());
      const line = {
        kind: "bullet" as const,
        level: Math.floor(bullet[1].replace(/\t/g, "  ").length / 2),
        done: Boolean(bullet[2]?.toLowerCase() === "[x]"),
        title: title.title,
        tags: title.tags,
        body: []
      };
      parsed.push(line);
      stack[line.level] = line;
      stack.length = line.level + 1;
      continue;
    }

    const heading = rawLine.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      const title = parseTitleTags(heading[2].trim());
      const line = {
        kind: "heading" as const,
        level: heading[1].length - 1,
        done: false,
        title: title.title,
        tags: title.tags,
        body: []
      };
      parsed.push(line);
      stack[line.level] = line;
      stack.length = line.level + 1;
      continue;
    }

    const bodyLine = rawLine.trim();
    if (bodyLine) {
      const level = Math.max(0, Math.floor(rawLine.replace(/\t/g, "  ").search(/\S/) / 2) - 1);
      const target = stack[level] ?? parsed.at(-1);
      target?.body.push(bodyLine);
    }
  }

  return parsed;
}

function parseTitleTags(rawTitle: string): { title: string; tags: string[] } {
  const parts = rawTitle.trim().split(/\s+/);
  const tags: string[] = [];
  while (parts.length > 0) {
    const part = parts.at(-1);
    if (!part?.startsWith("#") || part.length === 1) break;
    tags.unshift(part.slice(1));
    parts.pop();
  }
  return { title: parts.join(" ").trim(), tags };
}

function singleLineText(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ");
}
