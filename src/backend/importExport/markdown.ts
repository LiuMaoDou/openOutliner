import type { OutlineTreeNode } from "../domain/types.js";
import { type OutlinerService, ValidationError } from "../services/outliner.js";

interface ParsedLine {
  kind: "bullet" | "heading";
  level: number;
  title: string;
  done: boolean;
  tags: string[];
  body: string[];
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

  const content = lines.join("\n").trimEnd();
  return content ? `${content}\n` : "";
}

export function importMarkdown(
  service: OutlinerService,
  input: { workspaceId?: string; parentId?: string; content: string }
): MarkdownImportResult {
  if (!input.workspaceId && !input.parentId) {
    return importAllMarkdown(service, input.content);
  }

  const target = targetWorkspace(service, input);
  const parsed = parseMarkdownLines(input.content);
  if (parsed[0]?.kind === "heading" && parsed[0].level === 0 && parsed[0].title === target.workspace.name) {
    parsed.shift();
  }
  const imported = importParsedLines(service, target.parentId, parsed);
  return { imported, workspaceId: target.workspace.id };
}

function importAllMarkdown(service: OutlinerService, content: string): MarkdownImportResult {
  const parsedWorkspaces = parseMarkdownWorkspaces(content);
  const workspaceIds: string[] = [];
  let imported = 0;

  service.replaceAllWorkspaces(() => {
    for (const parsedWorkspace of parsedWorkspaces) {
      const workspace = service.createWorkspace(parsedWorkspace.name);
      workspaceIds.push(workspace.id);
      imported += importParsedLines(service, workspace.rootNodeId, parsedWorkspace.lines);
    }
  });

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
  if (!title) {
    for (const child of node.children) {
      writeNode(lines, child, depth);
    }
    return;
  }

  const indent = "  ".repeat(depth);
  const checkbox = node.done ? "[x] " : "";
  const tags = node.tags.length > 0 ? ` ${node.tags.map(tag => `#${tag.name}`).join(" ")}` : "";
  lines.push(`${indent}- ${checkbox}${title}${tags}`);
  if (node.body.trim()) {
    for (const bodyLine of node.body.trim().split(/\r?\n/)) {
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
  for (const rawLine of content.split(/\r?\n/)) {
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
