import type { OutlineTreeNode } from "../domain/types.js";
import type { OutlinerService } from "../services/outliner.js";

interface ParsedLine {
  level: number;
  title: string;
  done: boolean;
}

export function exportMarkdown(service: OutlinerService, workspaceId: string): string {
  const workspace = service.getWorkspace(workspaceId);
  const root = service.getTree(workspace.rootNodeId);
  const lines: string[] = [`# ${workspace.name}`, ""];

  for (const child of root.children) {
    writeNode(lines, child, 0);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function importMarkdown(
  service: OutlinerService,
  input: { workspaceId: string; parentId?: string; content: string }
): { imported: number } {
  const workspace = service.getWorkspace(input.workspaceId);
  const parentId = input.parentId ?? workspace.rootNodeId;
  const parsed = parseMarkdownLines(input.content);
  const stack: string[] = [parentId];
  let imported = 0;

  for (const line of parsed) {
    const safeLevel = Math.max(0, Math.min(line.level, stack.length - 1));
    const node = service.createNode({
      parentId: stack[safeLevel],
      title: line.title,
      done: line.done
    });
    stack[safeLevel + 1] = node.id;
    stack.length = safeLevel + 2;
    imported += 1;
  }

  return { imported };
}

function writeNode(lines: string[], node: OutlineTreeNode, depth: number): void {
  const indent = "  ".repeat(depth);
  const checkbox = node.done ? "[x] " : "";
  const tags = node.tags.length > 0 ? ` ${node.tags.map(tag => `#${tag.name}`).join(" ")}` : "";
  lines.push(`${indent}- ${checkbox}${node.title}${tags}`);
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
  for (const rawLine of content.split(/\r?\n/)) {
    const bullet = rawLine.match(/^(\s*)[-*]\s+(?:(\[[ xX]\])\s+)?(.+?)\s*$/);
    if (bullet) {
      parsed.push({
        level: Math.floor(bullet[1].replace(/\t/g, "  ").length / 2),
        done: Boolean(bullet[2]?.toLowerCase() === "[x]"),
        title: bullet[3].trim()
      });
      continue;
    }

    const heading = rawLine.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      parsed.push({
        level: heading[1].length - 1,
        done: false,
        title: heading[2].trim()
      });
    }
  }

  return parsed;
}
