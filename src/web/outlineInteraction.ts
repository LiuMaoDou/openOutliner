import { sourceOffsetForText } from "./titleSourceMap";

export function getChildCountLabel(childCount: number): string | null {
  return childCount > 0 ? String(childCount) : null;
}

export function formatNodeDate(value: string): string {
  return value.replaceAll("-", "/");
}

export type NodeSelectionPosition = "single" | "start" | "middle" | "end";

/** Text drags become multi-row selections only after entering another outline row. */
export function getTitleDragSelectionMode(
  mode: "text" | "nodes",
  anchorId: string,
  hoveredId: string | undefined,
  distance: number
): "text" | "nodes" {
  if (mode === "nodes") return "nodes";
  return distance >= 5 && hoveredId && hoveredId !== anchorId ? "nodes" : "text";
}

export function getNodeSelectionPosition(
  visibleIds: string[],
  selectedIds: ReadonlySet<string>,
  index: number
): NodeSelectionPosition | null {
  const nodeId = visibleIds[index];
  if (!nodeId || !selectedIds.has(nodeId)) return null;
  const previousSelected = index > 0 && selectedIds.has(visibleIds[index - 1]);
  const nextSelected = index < visibleIds.length - 1 && selectedIds.has(visibleIds[index + 1]);
  if (previousSelected && nextSelected) return "middle";
  if (previousSelected) return "end";
  if (nextSelected) return "start";
  return "single";
}

export interface TitleSelection {
  start: number;
  end: number;
}

type AfterCompositionEnd = (callback: () => void) => void;

export class NodeCompositionTracker {
  private readonly composingNodeIds = new Set<string>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(private readonly afterCompositionEnd: AfterCompositionEnd) {}

  start(nodeId: string) {
    this.composingNodeIds.add(nodeId);
  }

  finish(nodeId: string) {
    if (!this.composingNodeIds.delete(nodeId)) return;
    const pending = this.waiters.get(nodeId);
    this.waiters.delete(nodeId);
    for (const resolve of pending ?? []) resolve();
  }

  async wait(nodeId: string): Promise<void> {
    if (!this.composingNodeIds.has(nodeId)) return;
    await new Promise<void>(resolve => {
      const pending = this.waiters.get(nodeId) ?? new Set<() => void>();
      pending.add(resolve);
      this.waiters.set(nodeId, pending);
    });
    await new Promise<void>(resolve => this.afterCompositionEnd(resolve));
    await this.wait(nodeId);
  }
}

export function resizeTitleInput(input: HTMLTextAreaElement) {
  const currentHeight = input.style.height;
  input.style.height = "auto";
  const nextHeight = `${input.scrollHeight}px`;
  input.style.height = currentHeight === nextHeight ? currentHeight : nextHeight;
}

export function focusTitleInput(input?: HTMLTextAreaElement | null, selection?: TitleSelection) {
  if (!input) return;
  input.focus({ preventScroll: true });
  if (!selection) return;
  const range = resolveTitleSelection(input.value, selection.start, selection.end);
  input.setSelectionRange(range.start, range.end);
}

export function resolveTitleSelection(value: string, selectionStart: number, selectionEnd: number) {
  const start = Math.max(0, Math.min(selectionStart, value.length));
  const end = Math.max(start, Math.min(selectionEnd, value.length));
  return { start, end };
}

export function splitTitleAtSelection(title: string, selectionStart?: number | null) {
  const splitIndex = Math.max(0, Math.min(selectionStart ?? title.length, title.length));
  return {
    currentTitle: title.slice(0, splitIndex),
    nextTitle: title.slice(splitIndex)
  };
}

export type NodeEnterAction =
  | { type: "insert-before" }
  | { type: "split"; currentTitle: string; nextTitle: string };

export function getNodeEnterAction(
  title: string,
  selectionStart?: number | null,
  selectionEnd?: number | null
): NodeEnterAction {
  if (title.length > 0 && selectionStart === 0 && selectionEnd === 0) return { type: "insert-before" };
  return { type: "split", ...splitTitleAtSelection(title, selectionStart) };
}

export function shouldHandleMultiSelectionTab(
  event: { key: string; shiftKey?: boolean; defaultPrevented?: boolean },
  selectedCount: number,
  keyboardActive: boolean
) {
  return (
    event.key === "Tab" &&
    !event.shiftKey &&
    !event.defaultPrevented &&
    selectedCount > 1 &&
    keyboardActive
  );
}

export function shouldHandleOutlineSelectAll(
  event: {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    shiftKey?: boolean;
    defaultPrevented?: boolean;
    isComposing?: boolean;
    nativeEvent?: { isComposing?: boolean; keyCode?: number };
  },
  editable: boolean,
  outlineTitle: boolean
) {
  return event.key.toLowerCase() === "a" && (event.metaKey || event.ctrlKey)
    && !event.altKey && !event.shiftKey && !event.defaultPrevented
    && !shouldIgnoreTextInputKeyDown(event) && (!editable || outlineTitle);
}

export function shouldHandleMultiSelectionDelete(
  event: {
    key: string;
    metaKey?: boolean;
    ctrlKey?: boolean;
    altKey?: boolean;
    defaultPrevented?: boolean;
    isComposing?: boolean;
  },
  selectedCount: number,
  keyboardActive: boolean,
  editable: boolean,
  outlineEditable: boolean
) {
  return (
    event.key === "Delete" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.defaultPrevented &&
    !event.isComposing &&
    selectedCount > 1 &&
    keyboardActive &&
    (!editable || outlineEditable)
  );
}

export function shouldIgnoreTextInputKeyDown(event: {
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
}) {
  return Boolean(event.isComposing || event.nativeEvent?.isComposing || event.nativeEvent?.keyCode === 229);
}

export function isTitleCaretAtEdge(input: HTMLTextAreaElement, measure: HTMLElement | null, edge: "start" | "end"): boolean {
  if (input.selectionStart !== input.selectionEnd) return false;
  const cursor = input.selectionStart;
  if (!measure) return edge === "start" ? cursor === 0 : cursor === input.value.length;
  // Measure the actual visual line, including soft wrapping and trailing newlines.
  const mirror = measure.cloneNode(false) as HTMLElement;
  const first = document.createElement("span");
  const caret = document.createElement("span");
  const last = document.createElement("span");
  for (const marker of [first, caret, last]) marker.textContent = "\u200b";
  mirror.append(first, input.value.slice(0, cursor), caret, input.value.slice(cursor), last);
  measure.parentElement?.append(mirror);
  try {
    const caretTop = caret.getBoundingClientRect().top;
    const edgeTop = (edge === "start" ? first : last).getBoundingClientRect().top;
    return Math.abs(caretTop - edgeTop) < 1;
  } finally {
    mirror.remove();
  }
}

export function getPreviewSelectionStart(container: HTMLElement, clientX: number, clientY: number, title: string) {
  const native = getCaretFromPoint(container.ownerDocument, clientX, clientY);
  const caret = native && container.contains(native.node) && native.node.nodeType === Node.TEXT_NODE
    ? native : getMeasuredTextCaret(container, clientX, clientY);
  if (!caret) return title.length;
  const source = sourceOffsetForText(caret.node, caret.offset);
  const offset = source ?? getTextOffset(container, caret.node, caret.offset) ?? title.length;
  return Math.max(0, Math.min(offset, title.length));
}

function getMeasuredTextCaret(root: Node, clientX: number, clientY: number) {
  const document = root.ownerDocument;
  if (!document) return null;
  let best: { node: Node; offset: number } | null = null;
  let bestDistance = Infinity;
  const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  const range = document.createRange();
  while ((node = walk.nextNode())) {
    const value = node.textContent ?? "";
    for (let index = 0; index < value.length;) {
      const length = (value.codePointAt(index) ?? 0) > 0xffff ? 2 : 1;
      range.setStart(node, index); range.setEnd(node, index + length);
      const rect = range.getBoundingClientRect();
      if (rect.width || rect.height) {
        const vertical = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
        const horizontal = clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
        const distance = vertical * 1000 + horizontal;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { node, offset: clientX <= rect.left + rect.width / 2 ? index : index + length };
        }
      }
      index += length;
    }
  }
  return best;
}

function getCaretFromPoint(document: Document, clientX: number, clientY: number) {
  const documentWithCaret = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = documentWithCaret.caretPositionFromPoint?.(clientX, clientY);
  if (position) return { node: position.offsetNode, offset: position.offset };

  const range = documentWithCaret.caretRangeFromPoint?.(clientX, clientY);
  if (!range) return null;
  return { node: range.startContainer, offset: range.startOffset };
}

function getTextOffset(root: Node, target: Node, targetOffset: number) {
  let offset = 0;
  const visit = (node: Node): number | null => {
    if (node === target) {
      if (node.nodeType === Node.TEXT_NODE) {
        return offset + Math.min(targetOffset, node.textContent?.length ?? 0);
      }
      return offset + Array.from(node.childNodes)
        .slice(0, targetOffset)
        .reduce((length, child) => length + (child.textContent?.length ?? 0), 0);
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0;
      return null;
    }
    for (const child of Array.from(node.childNodes)) {
      const result = visit(child);
      if (result !== null) return result;
    }
    return null;
  };
  return visit(root);
}

export async function readClipboardText() {
  try {
    const text = await navigator.clipboard?.readText();
    return text?.trim().replace(/\s+/g, " ") ?? "";
  } catch {
    return "";
  }
}

export interface OutlineSelectionActions {
  canTranslate: boolean;
  canSplit: boolean;
  dividerAction: "add" | "remove" | null;
}

export type DropPlacement = "before" | "inside" | "after";
