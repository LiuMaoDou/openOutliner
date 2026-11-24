import type { KeyboardEvent } from "react";
import { defaultSchema } from "rehype-sanitize";
import type { FlatNodeData } from "./flatTree";
import { focusTitleInput, readClipboardText } from "./outlineInteraction";

export type MarkdownStyle = "bold" | "italic" | "strike" | "code" | "highlight";

export const MARKDOWN_TEXT_COLORS = [
  { id: "red", label: "Red" },
  { id: "orange", label: "Orange" },
  { id: "yellow", label: "Yellow" },
  { id: "green", label: "Green" },
  { id: "blue", label: "Blue" },
  { id: "purple", label: "Purple" },
  { id: "gray", label: "Gray" }
] as const;

export type MarkdownTextColor = (typeof MARKDOWN_TEXT_COLORS)[number]["id"];

const markdownTextColorIds = new Set<string>(MARKDOWN_TEXT_COLORS.map(color => color.id));
const markdownTextColorClassNames = MARKDOWN_TEXT_COLORS.map(color => `markdownTextColor-${color.id}`);
export const markdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "span"],
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ["className", ...markdownTextColorClassNames], ["dataSourceOffsets", /^[0-9,]+$/]]
  }
};

export function handleMarkdownShortcut(
  event: KeyboardEvent<HTMLTextAreaElement>,
  title: string,
  onPatchLocal: (patch: Partial<FlatNodeData>) => void
): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;

  const key = event.key.toLowerCase();
  if (key === "k" && !event.shiftKey) {
    insertMarkdownLinkFromClipboard(event, title, onPatchLocal);
    return true;
  }

  const shortcut =
    key === "b" && !event.shiftKey
      ? { style: "bold" as const, placeholder: "bold" }
      : key === "i" && !event.shiftKey
        ? { style: "italic" as const, placeholder: "italic" }
        : key === "e" && !event.shiftKey
          ? { style: "code" as const, placeholder: "code" }
          : key === "x" && (event.altKey || event.shiftKey)
            ? { style: "strike" as const, placeholder: "strike" }
            : key === "h" && event.shiftKey
              ? { style: "highlight" as const, placeholder: "highlight" }
              : null;

  if (!shortcut) return false;

  event.preventDefault();
  const input = event.currentTarget;
  const start = input.selectionStart ?? title.length;
  const end = input.selectionEnd ?? start;
  const result = applyMarkdownStyle(title, start, end, shortcut.style, shortcut.placeholder);

  onPatchLocal({ title: result.value });
  window.setTimeout(() => {
    input.setSelectionRange(result.selectionStart, result.selectionEnd);
  }, 0);
  return true;
}

const markdownStyleMarkers: Record<MarkdownStyle, { before: string; after: string }> = {
  bold: { before: "**", after: "**" },
  italic: { before: "*", after: "*" },
  strike: { before: "~~", after: "~~" },
  code: { before: "`", after: "`" },
  highlight: { before: "==", after: "==" }
};

export function applyMarkdownStyle(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  style: MarkdownStyle,
  placeholder = "text"
) {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const { before, after } = markdownStyleMarkers[style];
  const selected = value.slice(start, end) || placeholder;

  if (
    start >= before.length &&
    value.slice(start - before.length, start) === before &&
    value.slice(end, end + after.length) === after
  ) {
    return {
      value: `${value.slice(0, start - before.length)}${selected}${value.slice(end + after.length)}`,
      selectionStart: start - before.length,
      selectionEnd: end - before.length
    };
  }

  if (selected.startsWith(before) && selected.endsWith(after) && selected.length >= before.length + after.length) {
    const unwrapped = selected.slice(before.length, selected.length - after.length);
    return {
      value: `${value.slice(0, start)}${unwrapped}${value.slice(end)}`,
      selectionStart: start,
      selectionEnd: start + unwrapped.length
    };
  }

  return {
    value: `${value.slice(0, start)}${before}${selected}${after}${value.slice(end)}`,
    selectionStart: start + before.length,
    selectionEnd: start + before.length + selected.length
  };
}

function parseWholeMarkdownTextColor(value: string): { color: MarkdownTextColor; text: string } | null {
  const match = /^\{\{color:([a-z]+)\}\}([\s\S]*)\{\{\/color\}\}$/.exec(value);
  if (!match || !markdownTextColorIds.has(match[1])) return null;
  return { color: match[1] as MarkdownTextColor, text: match[2] };
}

export function applyMarkdownTextColor(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  color: MarkdownTextColor | null
) {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const selected = value.slice(start, end);
  const endMarker = "{{/color}}";
  const prefixMatch = /\{\{color:([a-z]+)\}\}$/.exec(value.slice(0, start));
  const hasSurroundingColor = Boolean(
    prefixMatch &&
    markdownTextColorIds.has(prefixMatch[1]) &&
    value.slice(end, end + endMarker.length) === endMarker
  );

  if (prefixMatch && hasSurroundingColor) {
    const wrapperStart = start - prefixMatch[0].length;
    const replacement = color ? `{{color:${color}}}${selected}${endMarker}` : selected;
    const contentOffset = color ? `{{color:${color}}}`.length : 0;
    return {
      value: `${value.slice(0, wrapperStart)}${replacement}${value.slice(end + endMarker.length)}`,
      selectionStart: wrapperStart + contentOffset,
      selectionEnd: wrapperStart + contentOffset + selected.length
    };
  }

  const existingColor = parseWholeMarkdownTextColor(selected);
  if (existingColor) {
    const replacement = color ? `{{color:${color}}}${existingColor.text}${endMarker}` : existingColor.text;
    const contentOffset = color ? `{{color:${color}}}`.length : 0;
    return {
      value: `${value.slice(0, start)}${replacement}${value.slice(end)}`,
      selectionStart: start + contentOffset,
      selectionEnd: start + contentOffset + existingColor.text.length
    };
  }

  if (!color || !selected) {
    return { value, selectionStart: start, selectionEnd: end };
  }

  const before = `{{color:${color}}}`;
  return {
    value: `${value.slice(0, start)}${before}${selected}${endMarker}${value.slice(end)}`,
    selectionStart: start + before.length,
    selectionEnd: start + before.length + selected.length
  };
}

export function applyMarkdownLink(value: string, selectionStart: number, selectionEnd: number, href: string) {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  const selected = value.slice(start, end) || "link";
  const existingLink = parseWholeMarkdownLink(selected);
  const label = existingLink?.label ?? selected;
  const normalizedHref = parseWholeMarkdownLink(href.trim())?.href.trim() || href.trim();
  const before = "[";
  const after = `](${normalizedHref})`;
  return {
    value: `${value.slice(0, start)}${before}${label}${after}${value.slice(end)}`,
    selectionStart: start + before.length,
    selectionEnd: start + before.length + label.length
  };
}

function parseWholeMarkdownLink(value: string): { label: string; href: string } | null {
  if (!value.startsWith("[") || !value.endsWith(")")) return null;

  let bracketDepth = 1;
  let closingBracket = -1;
  for (let index = 1; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === "[") bracketDepth += 1;
    else if (value[index] === "]") {
      bracketDepth -= 1;
      if (bracketDepth === 0) {
        closingBracket = index;
        break;
      }
    }
  }

  if (closingBracket < 0 || value[closingBracket + 1] !== "(") return null;

  let parenthesisDepth = 1;
  for (let index = closingBracket + 2; index < value.length; index += 1) {
    if (value[index] === "\\") {
      index += 1;
      continue;
    }
    if (value[index] === "(") parenthesisDepth += 1;
    else if (value[index] === ")") {
      parenthesisDepth -= 1;
      if (parenthesisDepth === 0) {
        if (index !== value.length - 1) return null;
        const href = value.slice(closingBracket + 2, index);
        return href ? { label: value.slice(1, closingBracket), href } : null;
      }
    }
  }

  return null;
}

export function normalizeLinkHref(href: string): string {
  const trimmed = href.trim();
  if (/^(?:https?:|mailto:|tel:|#)/i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/\//, "")}`;
}

export function isPastedMarkdownLink(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return false;
  if (/^(?:https?:\/\/|mailto:|tel:|\/\/)/i.test(trimmed)) return true;
  return /^(?:www\.)?[a-z0-9](?:[a-z0-9-]*\.)+[a-z]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(trimmed);
}

export function applyPastedMarkdownLink(
  value: string,
  selectionStart: number,
  selectionEnd: number,
  clipboardText: string
) {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  if (start === end || !isPastedMarkdownLink(clipboardText)) return null;
  return applyMarkdownLink(value, start, end, normalizeLinkHref(clipboardText));
}

async function insertMarkdownLinkFromClipboard(
  event: KeyboardEvent<HTMLTextAreaElement>,
  title: string,
  onPatchLocal: (patch: Partial<FlatNodeData>) => void
) {
  event.preventDefault();
  const input = event.currentTarget;
  const start = input.selectionStart ?? title.length;
  const end = input.selectionEnd ?? start;
  const clipboardText = await readClipboardText();
  const href = clipboardText || "url";
  const result = applyMarkdownLink(title, start, end, href);

  onPatchLocal({ title: result.value });
  window.setTimeout(() => {
    focusTitleInput(input);
    input.setSelectionRange(result.selectionStart, result.selectionEnd);
  }, 0);
}

export function splitMarkdownHighlights(value: string) {
  const parts: Array<{ value: string; highlighted: boolean }> = [];
  const pattern = /==([^=\n]+)==/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ value: value.slice(cursor, index), highlighted: false });
    parts.push({ value: match[1], highlighted: true });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) parts.push({ value: value.slice(cursor), highlighted: false });
  return parts.length > 0 ? parts : [{ value, highlighted: false }];
}

export function splitMarkdownTextColors(value: string) {
  const parts: Array<{ value: string; color: MarkdownTextColor | null }> = [];
  const pattern = /\{\{color:(red|orange|yellow|green|blue|purple|gray)\}\}([\s\S]*?)\{\{\/color\}\}/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ value: value.slice(cursor, index), color: null });
    parts.push({ value: match[2], color: match[1] as MarkdownTextColor });
    cursor = index + match[0].length;
  }
  if (cursor < value.length) parts.push({ value: value.slice(cursor), color: null });
  return parts.length > 0 ? parts : [{ value, color: null }];
}

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

export function remarkLiteralHtml() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      if (node.type === "html") node.type = "text";
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}

export function isMarkdownThematicBreak(value: string) {
  return /^[ ]{0,3}(?:(?:\*[\t ]*){3,}|(?:-[\t ]*){3,}|(?:_[\t ]*){3,})$/.test(value);
}

