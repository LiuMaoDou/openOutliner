import type { OutlineTreeNode } from "../domain/types.js";
import { ValidationError } from "../services/outliner.js";

export interface NodeExportMetadata {
  version: 1;
  title: string;
  body: string;
  tags: string[];
  dueDate: string | null;
  collapsed: boolean;
  done: boolean;
}

export function nodeExportMetadata(node: OutlineTreeNode): NodeExportMetadata {
  return {
    version: 1, title: node.title, body: node.body,
    tags: node.tags.map(tag => tag.name), dueDate: node.dueDate,
    collapsed: node.collapsed, done: node.done
  };
}

export function parseNodeExportMetadata(value: string): NodeExportMetadata {
  let parsed: NodeExportMetadata;
  try {
    parsed = JSON.parse(value) as NodeExportMetadata;
  } catch {
    throw new ValidationError("Invalid OpenOutliner export metadata.");
  }
  if (!parsed || parsed.version !== 1 || typeof parsed.title !== "string" || typeof parsed.body !== "string" ||
    !Array.isArray(parsed.tags) || parsed.tags.some(tag => typeof tag !== "string" || !tag.trim()) ||
    (parsed.dueDate !== null && typeof parsed.dueDate !== "string") ||
    typeof parsed.collapsed !== "boolean" || typeof parsed.done !== "boolean") {
    throw new ValidationError("Invalid OpenOutliner export metadata.");
  }
  return parsed;
}
