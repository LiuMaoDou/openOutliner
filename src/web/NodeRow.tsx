import { Bold, CircleCheck, Copy, CalendarPlus, CalendarX2, Code2, FolderTree, Highlighter, Italic, Languages,
  ListPlus, Ellipsis, Minus, Palette, Strikethrough, Trash2, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { createPortal } from "react-dom";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from "react";
import type { Tag } from "./api";
import type { FlatNodeData } from "./flatTree";
import { clearTitleNativeSelection } from "./selectionOwnership";
import { rehypeTitleFormatting } from "./titleSourceMap";
import { canAddOutlineDivider, formatOutlineTitle, splitOutlineLines, splitOutlineTitle } from "../backend/shared/outlineTitle";
import { useInlineTagInput } from "./InlineTagInput";
import { beginNodeEdit, endNodeEdit, flushNodeDraft, readNodeDraft, stageNodeDraft } from "./offline";
import { getChildCountLabel, formatNodeDate, getTitleDragSelectionMode, resizeTitleInput, focusTitleInput,
  getNodeEnterAction, shouldIgnoreTextInputKeyDown, isTitleCaretAtEdge, getPreviewSelectionStart,
  type NodeSelectionPosition, type DropPlacement, type OutlineSelectionActions } from "./outlineInteraction";
import { MARKDOWN_TEXT_COLORS, markdownSanitizeSchema, handleMarkdownShortcut, applyMarkdownStyle,
  applyMarkdownTextColor, normalizeLinkHref, applyPastedMarkdownLink, remarkLiteralHtml,
  isMarkdownThematicBreak, type MarkdownStyle, type MarkdownTextColor } from "./markdownEditing";

interface MarkdownContextMenuState {
  x: number;
  y: number;
  selectionStart: number;
  selectionEnd: number;
  colorPaletteOpen: boolean;
}

interface NodeContextMenuState {
  x: number;
  y: number;
}

export function NodeRow({
  node,
  depth,
  selected,
  selectionPosition,
  active,
  canDrag,
  dragging,
  dropPlacement,
  registerInput,
  onMouseSelect,
  onFocusSelect,
  onContextSelect,
  onBlurFocus,
  onCompositionChange,
  onSelectionStart,
  onTitleRangeSelect,
  onPatchLocal,
  onCacheTitle,
  onCommit,
  onToggle,
  onCreateAfter,
  onCreateBefore,
  onIndent,
  onOutdent,
  onFocusPrevious,
  onFocusNext,
  onMoveStart,
  onTagClick,
  onTagRemove,
  tagCatalog,
  onTagAdd,
  onTagError,
  onConvertToWorkspace,
  onSplitLines,
  onSetDivider,
  onTranslate,
  selectionActions,
  isTranslating,
  onCopy,
  onComplete,
  onDelete
}: {
  node: FlatNodeData;
  depth: number;
  selected: boolean;
  selectionPosition: NodeSelectionPosition | null;
  active: boolean;
  canDrag: boolean;
  dragging: boolean;
  dropPlacement: DropPlacement | null;
  registerInput: (element: HTMLTextAreaElement | null) => void;
  onMouseSelect: (event: MouseEvent<HTMLElement>) => boolean;
  onFocusSelect: () => void;
  onContextSelect: () => void;
  onBlurFocus: () => void;
  onCompositionChange: (isComposing: boolean) => void;
  onSelectionStart: (event: PointerEvent<HTMLDivElement>) => void;
  onTitleRangeSelect: (targetId: string) => void;
  onPatchLocal: (patch: Partial<FlatNodeData>) => void;
  onCacheTitle: (title: string) => void;
  onCommit: (patch: Partial<FlatNodeData>) => void;
  onToggle: (patch: Partial<FlatNodeData>) => void;
  onCreateAfter: (title?: string, currentTitle?: string) => void;
  onCreateBefore: (currentTitle?: string) => void;
  onIndent: () => void;
  onOutdent: () => void;
  onFocusPrevious: () => void;
  onFocusNext: () => void;
  onMoveStart: (event: PointerEvent<HTMLButtonElement>) => void;
  onTagClick: (tag: Tag) => void;
  onTagRemove: (tag: Tag) => void;
  tagCatalog: Tag[];
  onTagAdd: (name: string) => Promise<void>;
  onTagError: (error: unknown) => void;
  onConvertToWorkspace: (title: string) => void;
  onSplitLines: () => Promise<void>;
  onSetDivider: (enabled: boolean) => Promise<void>;
  onTranslate: (title: string) => Promise<void>;
  selectionActions?: OutlineSelectionActions;
  isTranslating: boolean;
  onCopy: () => Promise<void>;
  onComplete: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const inlineTagSelectionRef = useRef<{ value: string; start: number } | null>(null);
  const titleMeasureRef = useRef<HTMLDivElement | null>(null);
  const dateInputRef = useRef<HTMLInputElement | null>(null);
  const markdownMenuRef = useRef<HTMLDivElement | null>(null);
  const nodeContextMenuRef = useRef<HTMLDivElement | null>(null);
  const onCompositionChangeRef = useRef(onCompositionChange);
  onCompositionChangeRef.current = onCompositionChange;
  const [storedTitle, setStoredTitle] = useState(() => readNodeDraft(node.id, "title") ?? node.title);
  const { text: localTitle, hasDivider } = splitOutlineTitle(storedTitle);
  const { text: previewTitle } = splitOutlineTitle(node.title);
  const hasOutlineContent = Boolean(node.body.trim() || node.childIds.length);
  const showDivider = hasDivider && !previewTitle.trim() && !hasOutlineContent;
  const dividerAction = selectionActions ? selectionActions.dividerAction : hasDivider ? "remove"
    : canAddOutlineDivider(storedTitle, node.body, !!node.childIds.length) ? "add" : null;
  const setLocalTitle = (text: string) => setStoredTitle(formatOutlineTitle(text, hasDivider));
  const lastStagedTitleRef = useRef(storedTitle);
  const [markdownMenu, setMarkdownMenu] = useState<MarkdownContextMenuState | null>(null);
  const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenuState | null>(null);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const resolved = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId: string; field: string; value?: string }>).detail;
      if (detail.nodeId !== node.id || detail.field !== "title" || detail.value === undefined) return;
      if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = null; }
      lastStagedTitleRef.current = detail.value;
      setStoredTitle(detail.value);
    };
    window.addEventListener("outliner-draft-resolved", resolved);
    return () => window.removeEventListener("outliner-draft-resolved", resolved);
  }, [node.id]);
  const previewSelectionCleanupRef = useRef<(() => void) | null>(null);
  const suppressTitleClickRef = useRef(false);

  // Sync external title changes (drag, undo, etc.) into local state
  useEffect(() => {
    if (document.activeElement === titleInputRef.current) return;
    const next = readNodeDraft(node.id, "title") ?? node.title;
    lastStagedTitleRef.current = next;
    setStoredTitle(next);
  }, [node.title]);

  const stageTitle = useCallback((title: string) => {
    onCacheTitle(title);
    if (title === lastStagedTitleRef.current) return;
    lastStagedTitleRef.current = title;
    if (!node.id.startsWith("temp-")) stageNodeDraft(node.id, "title", title, node.title);
  }, [node.id, node.title, onCacheTitle]);

  // Flush local title to global state
  const flushTitle = useCallback((title: string, divider = hasDivider) => {
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    const next = formatOutlineTitle(title, divider);
    stageTitle(next);
    onPatchLocal({ title: next });
  }, [hasDivider, stageTitle, onPatchLocal]);

  // Debounced sync during typing
  const syncTitleDebounced = useCallback((title: string) => {
    const next = formatOutlineTitle(title, hasDivider);
    stageTitle(next);
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      onPatchLocal({ title: next });
      syncTimerRef.current = null;
    }, 300);
  }, [hasDivider, stageTitle, onPatchLocal]);

  const inlineTags = useInlineTagInput({
    nodeId: node.id, value: localTitle, inputRef: titleInputRef, tags: tagCatalog,
    onAdd: onTagAdd, onError: onTagError,
    onApply: (title, selectionStart) => {
      inlineTagSelectionRef.current = { value: title, start: selectionStart };
      setLocalTitle(title);
      flushTitle(title);
    }
  });

  useLayoutEffect(() => {
    const selection = inlineTagSelectionRef.current;
    const input = titleInputRef.current;
    if (selection && input && document.activeElement === input && input.value === selection.value) {
      input.setSelectionRange(selection.start, selection.start);
      resizeTitleInput(input);
    }
    inlineTagSelectionRef.current = null;
  }, [localTitle]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
      previewSelectionCleanupRef.current?.();
      onCompositionChangeRef.current(false);
    };
  }, []);

  useEffect(() => {
    if (!markdownMenu && !nodeContextMenu) return;
    const closeOnPointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node;
      if (markdownMenu && !markdownMenuRef.current?.contains(target)) setMarkdownMenu(null);
      if (nodeContextMenu && !nodeContextMenuRef.current?.contains(target)) setNodeContextMenu(null);
    };
    const closeMenus = () => {
      setMarkdownMenu(null);
      setNodeContextMenu(null);
    };
    const closeOnWindowBlur = () => closeMenus();
    const closeOnScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && (markdownMenuRef.current?.contains(target) || nodeContextMenuRef.current?.contains(target))) return;
      closeMenus();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeMenus();
    };
    document.addEventListener("pointerdown", closeOnPointerDown, true);
    window.addEventListener("blur", closeOnWindowBlur);
    window.addEventListener("resize", closeMenus);
    window.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown, true);
      window.removeEventListener("blur", closeOnWindowBlur);
      window.removeEventListener("resize", closeMenus);
      window.removeEventListener("scroll", closeOnScroll, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [markdownMenu, nodeContextMenu]);

  const commitMarkdownEdit = (
    nextTitle: string,
    selectionStart: number,
    selectionEnd: number,
    restoreFocus = true
  ) => {
    setLocalTitle(nextTitle);
    flushTitle(nextTitle);
    if (!node.id.startsWith("temp-")) void flushNodeDraft(node.id, "title").catch(() => {});
    setMarkdownMenu(null);
    if (!restoreFocus) return;
    window.setTimeout(() => {
      const input = titleInputRef.current;
      if (!input) return;
      focusTitleInput(input);
      input.setSelectionRange(selectionStart, selectionEnd);
    }, 0);
  };

  const applyMarkdownStyleFromMenu = (style: MarkdownStyle) => {
    if (!markdownMenu) return;
    const result = applyMarkdownStyle(
      localTitle,
      markdownMenu.selectionStart,
      markdownMenu.selectionEnd,
      style
    );
    commitMarkdownEdit(result.value, result.selectionStart, result.selectionEnd);
  };

  const applyMarkdownTextColorFromMenu = (color: MarkdownTextColor | null) => {
    if (!markdownMenu) return;
    const result = applyMarkdownTextColor(
      localTitle,
      markdownMenu.selectionStart,
      markdownMenu.selectionEnd,
      color
    );
    commitMarkdownEdit(result.value, result.selectionStart, result.selectionEnd);
  };

  const toggleMarkdownColorPalette = () => {
    setMarkdownMenu(current => {
      if (!current) return current;
      const colorPaletteOpen = !current.colorPaletteOpen;
      return {
        ...current,
        colorPaletteOpen,
        y: colorPaletteOpen
          ? Math.min(current.y, window.innerHeight - 92 - 12)
          : current.y
      };
    });
  };

  const openMarkdownContextMenu = (
    input: HTMLTextAreaElement,
    clientX: number,
    clientY: number,
    placement: "pointer" | "selection" = "pointer"
  ) => {
    const selectionStart = input.selectionStart ?? 0;
    const selectionEnd = input.selectionEnd ?? selectionStart;
    if (selectionStart === selectionEnd) return false;
    const menuWidth = 224;
    const menuHeight = 46;
    const requestedX = placement === "selection" ? clientX - menuWidth / 2 : clientX;
    const requestedY = placement === "selection" ? clientY - menuHeight - 10 : clientY;
    setMarkdownMenu({
      x: Math.max(12, Math.min(requestedX, window.innerWidth - menuWidth - 12)),
      y: Math.max(12, Math.min(requestedY, window.innerHeight - menuHeight - 12)),
      selectionStart,
      selectionEnd,
      colorPaletteOpen: false
    });
    return true;
  };

  const openNodeContextMenu = (clientX: number, clientY: number) => {
    const menuWidth = 220;
    const menuHeight = 242;
    setMarkdownMenu(null);
    setNodeContextMenu({
      x: Math.max(12, Math.min(clientX, window.innerWidth - menuWidth - 12)),
      y: Math.max(12, Math.min(clientY, window.innerHeight - menuHeight - 12))
    });
  };

  const rowClassName = [
    "nodeRow",
    selected ? "selected" : "",
    selectionPosition ? `selection-${selectionPosition}` : "",
    active ? "active" : "",
    node.done ? "completed" : "",
    node.collapsed && node.childIds.length > 0 ? "collapsedChildren" : "",
    dragging ? "dragging" : "",
    dropPlacement ? `drop-${dropPlacement}` : ""
  ]
    .filter(Boolean)
    .join(" ");
  const childCountLabel = getChildCountLabel(node.childIds.length);
  const hasComments = node.body.trim().length > 0;
  const renderTitleLiterally = isMarkdownThematicBreak(previewTitle);
  const openDatePicker = () => {
    const input = dateInputRef.current;
    if (!input) return;
    try {
      input.showPicker();
    } catch {
      input.focus();
    }
  };
  const commitDueDate = (dueDate: string | null) => {
    onPatchLocal({ dueDate });
    onCommit({ dueDate });
  };
  useEffect(() => {
    const input = titleInputRef.current;
    if (!input) return;
    resizeTitleInput(input);
  }, [localTitle]);

  const beginTitlePointerSelection = (
    event: PointerEvent<HTMLDivElement | HTMLTextAreaElement>,
    fromPreview: boolean
  ) => {
    if (
      event.button !== 0 ||
      event.shiftKey ||
      event.metaKey ||
      event.ctrlKey ||
      (event.target as HTMLElement).closest(".nodeTitleLink")
    ) return;
    if (!fromPreview && event.pointerType !== "mouse") return;

    const input = titleInputRef.current;
    if (!input) return;
    if (fromPreview) {
      event.preventDefault();
      event.stopPropagation();
    }
    previewSelectionCleanupRef.current?.();
    suppressTitleClickRef.current = false;

    const pointerId = event.pointerId;
    const isMouse = event.pointerType === "mouse";
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffset = fromPreview
      ? getPreviewSelectionStart(event.currentTarget, startX, startY, previewTitle)
      : input.selectionStart;
    let mode: "text" | "nodes" = "text";

    if (fromPreview) {
      onFocusSelect();
      input.focus({ preventScroll: true });
      input.setSelectionRange(startOffset, startOffset);
    }

    const updatePointer = (clientX: number, clientY: number) => {
      const distance = Math.hypot(clientX - startX, clientY - startY);
      const hoveredId = document
        .elementFromPoint(clientX, clientY)
        ?.closest<HTMLElement>("[data-node-id]")?.dataset.nodeId;
      const nextMode = isMouse
        ? getTitleDragSelectionMode(mode, node.id, hoveredId, distance)
        : "text";

      if (nextMode !== mode) {
        mode = "nodes";
        suppressTitleClickRef.current = true;
        setMarkdownMenu(null);
        clearTitleNativeSelection(input);
        if (document.activeElement === input) input.blur();
      }
      if (mode === "nodes") {
        if (hoveredId) onTitleRangeSelect(hoveredId);
        return;
      }
      if (!fromPreview || distance < 4) return;
      const measure = titleMeasureRef.current;
      if (!measure) return;
      const endOffset = getPreviewSelectionStart(measure, clientX, clientY, localTitle);
      input.setSelectionRange(
        Math.min(startOffset, endOffset),
        Math.max(startOffset, endOffset),
        endOffset < startOffset ? "backward" : "forward"
      );
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish, true);
      window.removeEventListener("pointercancel", cancel, true);
      previewSelectionCleanupRef.current = null;
    };
    const move = (pointerEvent: globalThis.PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      if (!(pointerEvent.buttons & 1)) {
        cleanup();
        return;
      }
      updatePointer(pointerEvent.clientX, pointerEvent.clientY);
    };
    const finish = (pointerEvent: globalThis.PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      updatePointer(pointerEvent.clientX, pointerEvent.clientY);
      cleanup();
      if (mode === "nodes") {
        window.setTimeout(() => { suppressTitleClickRef.current = false; }, 0);
      } else if (fromPreview && document.activeElement === input && input.selectionStart !== input.selectionEnd) {
        openMarkdownContextMenu(input, pointerEvent.clientX, pointerEvent.clientY, "selection");
      }
    };
    const cancel = (pointerEvent: globalThis.PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      cleanup();
      suppressTitleClickRef.current = false;
    };

    previewSelectionCleanupRef.current = cleanup;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, true);
    window.addEventListener("pointercancel", cancel, true);
    if (fromPreview) {
      window.requestAnimationFrame(() => {
        if (document.activeElement !== input || input.selectionStart !== input.selectionEnd) return;
        input.setSelectionRange(startOffset, startOffset);
      });
    }
  };

  return (
    <div
      className={rowClassName}
      data-node-id={node.id}
      data-selected={selected ? "true" : "false"}
      data-active={active ? "true" : "false"}
      style={{ "--depth": depth } as CSSProperties}
      onPointerDown={onSelectionStart}
      onContextMenu={event => {
        if (node.id.startsWith("temp-")) return;
        event.preventDefault();
        event.stopPropagation();
        onContextSelect();
        openNodeContextMenu(event.clientX, event.clientY);
      }}
      onClick={event => {
        const target = event.target as HTMLElement;
        if (
          target.closest(".nodeTitleCell") ||
          target.closest(".nodeMenuButton") ||
          target.closest(".disclosureButton") ||
          target.closest(".dragHandle") ||
          target.closest(".iconButton.danger") ||
          target.closest(".nodeDateControl") ||
          target.closest(".nodeTags")
        ) return;
        const input = titleInputRef.current;
        if (input && onMouseSelect(event)) {
          input.focus({ preventScroll: true });
        }
      }}
    >
      {depth > 0 && (
        <span className="nodeTreeGuides" aria-hidden="true">
          {Array.from({ length: depth }, (_, index) => {
            const guideDepth = index + 1;
            return <i key={guideDepth} style={{ "--guide-depth": guideDepth } as CSSProperties} />;
          })}
        </span>
      )}
      <button
        className="iconButton nodeMenuButton"
        type="button"
        title="More outline actions"
        aria-label={`More actions for ${previewTitle || "Untitled"}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(nodeContextMenu)}
        disabled={node.id.startsWith("temp-")}
        onPointerDown={event => event.stopPropagation()}
        onClick={event => {
          event.preventDefault();
          event.stopPropagation();
          onContextSelect();
          const bounds = event.currentTarget.getBoundingClientRect();
          openNodeContextMenu(bounds.left, bounds.bottom + 4);
        }}
      >
        <Ellipsis size={16} />
      </button>
      <button
        className="iconButton disclosureButton"
        type="button"
        title={node.collapsed ? "Expand" : "Collapse"}
        disabled={node.childIds.length === 0}
        onClick={() => onToggle({ collapsed: !node.collapsed })}
      >
        {node.childIds.length > 0 ? (
          <span className={node.collapsed ? "disclosureTriangle right" : "disclosureTriangle down"} />
        ) : null}
      </button>
      <button
        className={[
          "dragHandle",
          node.done && "done",
          node.collapsed && node.childIds.length > 0 && "collapsed",
          hasComments && "hasComments"
        ].filter(Boolean).join(" ")}
        type="button"
        title={canDrag ? "Drag to move an outline or drop onto a workspace" : "Move unavailable"}
        aria-label={hasComments ? "Move node; has comments" : "Move node"}
        disabled={!canDrag}
        onPointerDown={onMoveStart}
      >
        <span className="nodeDot" />
      </button>
      <div className="nodeTitleCell">
        <textarea
          ref={element => {
            titleInputRef.current = element;
            registerInput(element);
          }}
          className="nodeTitle"
          onDragStart={event => {
            // A title gesture selects characters or rows. Native dragging of an
            // existing text selection would cancel the pointer controller.
            event.preventDefault();
          }}
          {...inlineTags.inputProps}
          value={localTitle}
          placeholder="Untitled"
          rows={1}
          onFocus={event => {
            inlineTags.refresh(event.currentTarget);
            if (!node.id.startsWith("temp-")) beginNodeEdit(node.id, "title", node.title);
            onFocusSelect();
          }}
          onClick={event => {
            if (suppressTitleClickRef.current) {
              event.preventDefault();
              return;
            }
            const input = event.currentTarget;
            if (input.selectionStart !== input.selectionEnd) return;
            const measure = titleMeasureRef.current;
            if (!measure) return;
            const selectionStart = getPreviewSelectionStart(
              measure,
              event.clientX,
              event.clientY,
              localTitle
            );
            input.setSelectionRange(selectionStart, selectionStart);
          }}
          onChange={event => {
            const value = event.target.value;
            setLocalTitle(value);
            resizeTitleInput(event.currentTarget);
            syncTitleDebounced(value);
            inlineTags.refresh(event.currentTarget);
          }}
          onSelect={event => inlineTags.refresh(event.currentTarget)}
          onCompositionStart={() => {
            inlineTags.composing.current = true;
            inlineTags.close();
            onCompositionChange(true);
          }}
          onCompositionEnd={event => {
            const value = event.currentTarget.value;
            setLocalTitle(value);
            syncTitleDebounced(value);
            onCompositionChange(false);
            inlineTags.composing.current = false;
            inlineTags.refresh(event.currentTarget);
          }}
          onPaste={event => {
            const input = event.currentTarget;
            const result = applyPastedMarkdownLink(
              localTitle,
              input.selectionStart ?? localTitle.length,
              input.selectionEnd ?? input.selectionStart ?? localTitle.length,
              event.clipboardData.getData("text/plain")
            );
            if (!result) {
              setMarkdownMenu(null);
              return;
            }
            event.preventDefault();
            commitMarkdownEdit(result.value, result.selectionStart, result.selectionEnd);
          }}
          onBlur={event => {
            inlineTags.close();
            inlineTags.composing.current = false;
            onCompositionChange(false);
            if (syncTimerRef.current) { clearTimeout(syncTimerRef.current); syncTimerRef.current = null; }
            // A stale editor that was only focused must never write its old value.
            if (node.id.startsWith("temp-")) flushTitle(event.target.value);
            else void endNodeEdit(node.id, "title").catch(() => {});
            onBlurFocus();
          }}
          onPointerDown={event => {
            if (event.button === 0) beginTitlePointerSelection(event, false);
            if (event.button === 2 && openMarkdownContextMenu(event.currentTarget, event.clientX, event.clientY)) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onPointerUp={event => {
            if (event.button !== 0 || suppressTitleClickRef.current) return;
            // Do not override a native textarea text selection on mouse release.
            const input = event.currentTarget;
            if (input.selectionStart === input.selectionEnd) return;
            event.stopPropagation();
            openMarkdownContextMenu(input, event.clientX, event.clientY, "selection");
          }}
          onContextMenu={event => {
            if (!openMarkdownContextMenu(event.currentTarget, event.clientX, event.clientY)) return;
            event.preventDefault();
            event.stopPropagation();
          }}
          onKeyUp={event => {
            const input = event.currentTarget;
            if (input.selectionStart === input.selectionEnd) return;
            const key = event.key.toLowerCase();
            if (!event.shiftKey && !((event.metaKey || event.ctrlKey) && key === "a")) return;
            const bounds = input.getBoundingClientRect();
            openMarkdownContextMenu(input, bounds.left + bounds.width / 2, bounds.top, "selection");
          }}
          onKeyDown={event => {
            if (shouldIgnoreTextInputKeyDown(event)) return;
            if (inlineTags.onKeyDown(event)) return;
            if (handleMarkdownShortcut(event, localTitle, patch => {
              if (patch.title !== undefined) {
                setLocalTitle(patch.title);
                flushTitle(patch.title);
              }
            })) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              const input = event.currentTarget;
              const action = getNodeEnterAction(localTitle, input.selectionStart, input.selectionEnd);
              if (action.type === "insert-before") {
                flushTitle(localTitle);
                onCreateBefore(formatOutlineTitle(localTitle, hasDivider));
                return;
              }
              const { currentTitle, nextTitle } = action;
              // Batch all state updates: flush current title + create new node
              setLocalTitle(currentTitle);
              flushTitle(currentTitle);
              onCreateAfter(nextTitle, formatOutlineTitle(currentTitle, hasDivider));
            } else if (event.key === "Tab") {
              event.preventDefault();
              if (event.shiftKey) onOutdent();
              else onIndent();
            } else if (event.key === "ArrowUp") {
              if (!event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && isTitleCaretAtEdge(event.currentTarget, titleMeasureRef.current, "start")) {
                event.preventDefault();
                onFocusPrevious();
              }
            } else if (event.key === "ArrowDown") {
              if (!event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && isTitleCaretAtEdge(event.currentTarget, titleMeasureRef.current, "end")) {
                event.preventDefault();
                onFocusNext();
              }
            } else if (event.key === "Backspace" && !localTitle) {
              event.preventDefault();
              onDelete();
            }
          }}
        />
        <div
          className="nodeTitlePreview"
          onPointerDown={event => beginTitlePointerSelection(event, true)}
          onClick={event => {
            event.stopPropagation();
            if (suppressTitleClickRef.current) {
              event.preventDefault();
              return;
            }
            if ((event.target as HTMLElement).closest(".nodeTitleLink")) return
            if (!event.shiftKey && !event.metaKey && !event.ctrlKey) return;
            if (!onMouseSelect(event)) return;
          }}
        >
          {previewTitle.trim() ? (
            renderTitleLiterally ? (
              <span><span className="nodeTitleInlineText">{previewTitle}</span></span>
            ) : (
              <ReactMarkdown
                allowedElements={["p", "strong", "em", "del", "code", "a", "br", "mark", "span"]}
                rehypePlugins={[rehypeTitleFormatting, [rehypeSanitize, markdownSanitizeSchema]]}
                remarkPlugins={[remarkGfm, remarkLiteralHtml]}
                unwrapDisallowed
                components={{
                  a: ({ children, href }) => {
                    const normalizedHref = href ? normalizeLinkHref(href) : undefined
                    return (
                      <a
                        className="nodeTitleLink"
                        href={normalizedHref}
                        onPointerDown={event => event.stopPropagation()}
                        onClick={event => {
                          event.preventDefault()
                          event.stopPropagation()
                          if (normalizedHref) window.open(normalizedHref, "_blank", "noopener,noreferrer")
                        }}
                      >
                        {children}
                      </a>
                    )
                  },
                  p: ({ children }) => <span><span className="nodeTitleInlineText">{children}</span></span>
                }}
              >
                {previewTitle}
              </ReactMarkdown>
            )
          ) : showDivider ? (
            <hr className="nodeDivider" aria-label="Dividing line" />
          ) : (
            <span className="nodeTitlePlaceholder">Untitled</span>
          )}
        </div>
        <div ref={titleMeasureRef} className="nodeTitleMeasure" aria-hidden="true">
          {localTitle}
        </div>
        {inlineTags.menu}
      </div>
      {childCountLabel ? (
        <span className="nodeChildCount">{childCountLabel}</span>
      ) : (
        <span className="nodeChildCount nodeChildCountPlaceholder" aria-hidden="true">0</span>
      )}
      <div className="nodeDateControl">
        <input
          ref={dateInputRef}
          className="nodeDatePicker"
          type="date"
          value={node.dueDate ?? ""}
          aria-label={`Date for ${previewTitle || "Untitled"}`}
          onChange={event => commitDueDate(event.target.value || null)}
        />
        {node.dueDate ? (
          <>
            <button
              className="nodeDateChip"
              type="button"
              title="Change date"
              onClick={event => {
                event.stopPropagation();
                openDatePicker();
              }}
            >
              {formatNodeDate(node.dueDate)}
            </button>
            <button
              className="nodeDateClearButton"
              type="button"
              title="Remove date"
              aria-label="Remove date"
              onClick={event => {
                event.stopPropagation();
                commitDueDate(null);
              }}
            >
              <CalendarX2 size={14} />
            </button>
          </>
        ) : (
          <button
            className="nodeDateAddButton"
            type="button"
            title="Add date"
            aria-label="Add date"
            onClick={event => {
              event.stopPropagation();
              openDatePicker();
            }}
          >
            <CalendarPlus size={17} />
          </button>
        )}
      </div>
      <div className="nodeTags">
        {(node.tags || []).map(tag => (
          <span className="nodeTagChip" key={tag.id}>
            <button type="button" onClick={() => onTagClick(tag)}>{tag.name}</button>
            <button
              className="nodeTagRemove"
              type="button"
              aria-label={`移除当前节点的标签 ${tag.name}`}
              title="解除当前节点关联，保留标签"
              disabled={tag.id.startsWith("temp-")}
              onClick={event => {
                event.stopPropagation();
                onTagRemove(tag);
              }}
            >
              <X size={12} />
            </button>
          </span>
        ))}
      </div>
      <button className="iconButton danger" type="button" title="Delete" onClick={() => onDelete()}>
        <Trash2 size={15} />
      </button>
      {markdownMenu && createPortal(
        <div
          ref={markdownMenuRef}
          className="markdownContextMenu"
          role="dialog"
          aria-label="Format selected text"
          style={{ left: markdownMenu.x, top: markdownMenu.y }}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onContextMenu={event => {
            event.preventDefault()
            event.stopPropagation()
          }}
        >
          <div className="markdownContextMenuHeader">
            <span>Format selection</span>
            <small>Markdown</small>
          </div>
          <div className="markdownFormatButtons">
            <button type="button" aria-label="Bold" onPointerDown={event => event.preventDefault()} onClick={() => applyMarkdownStyleFromMenu("bold")}>
              <Bold size={16} />
              <span>Bold</span>
            </button>
            <button type="button" aria-label="Italic" onPointerDown={event => event.preventDefault()} onClick={() => applyMarkdownStyleFromMenu("italic")}>
              <Italic size={16} />
              <span>Italic</span>
            </button>
            <button type="button" aria-label="Strike" onPointerDown={event => event.preventDefault()} onClick={() => applyMarkdownStyleFromMenu("strike")}>
              <Strikethrough size={16} />
              <span>Strike</span>
            </button>
            <button type="button" aria-label="Inline code" onPointerDown={event => event.preventDefault()} onClick={() => applyMarkdownStyleFromMenu("code")}>
              <Code2 size={16} />
              <span>Code</span>
            </button>
            <button className="markdownHighlightButton" type="button" aria-label="Highlight" onPointerDown={event => event.preventDefault()} onClick={() => applyMarkdownStyleFromMenu("highlight")}>
              <Highlighter size={16} />
              <span>Highlight</span>
            </button>
            <button
              className="markdownColorButton"
              type="button"
              aria-label="Text color"
              aria-expanded={markdownMenu.colorPaletteOpen}
              onPointerDown={event => event.preventDefault()}
              onClick={toggleMarkdownColorPalette}
            >
              <Palette size={16} />
              <span>Text color</span>
            </button>
          </div>
          {markdownMenu.colorPaletteOpen && (
            <div className="markdownColorPalette" role="group" aria-label="Text colors">
              <button
                className="markdownColorSwatch markdownColorSwatch-default"
                type="button"
                aria-label="Default color"
                onPointerDown={event => event.preventDefault()}
                onClick={() => applyMarkdownTextColorFromMenu(null)}
              >
                <i>A</i>
                <span>Default</span>
              </button>
              {MARKDOWN_TEXT_COLORS.map(color => (
                <button
                  className={`markdownColorSwatch markdownColorSwatch-${color.id}`}
                  type="button"
                  aria-label={`${color.label} text`}
                  key={color.id}
                  onPointerDown={event => event.preventDefault()}
                  onClick={() => applyMarkdownTextColorFromMenu(color.id)}
                >
                  <i />
                  <span>{color.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>,
        document.body
      )}
      {nodeContextMenu && createPortal(
        <div
          ref={nodeContextMenuRef}
          className="nodeContextMenu"
          role="menu"
          aria-label="Outline actions"
          style={{ left: nodeContextMenu.x, top: nodeContextMenu.y }}
          onPointerDown={event => event.stopPropagation()}
          onClick={event => event.stopPropagation()}
          onContextMenu={event => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setNodeContextMenu(null);
              void onCopy().catch(onTagError);
            }}
          >
            <Copy size={16} />
            <span>Copy</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={isTranslating || !(selectionActions?.canTranslate ?? localTitle.trim())}
            onClick={() => {
              flushTitle(localTitle);
              titleInputRef.current?.blur();
              setNodeContextMenu(null);
              void onTranslate(formatOutlineTitle(localTitle, hasDivider)).catch(onTagError);
            }}
          >
            <Languages size={16} />
            <span>Translation2Eng</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const complete = async () => {
                flushTitle(localTitle);
                if (!node.id.startsWith("temp-")) await flushNodeDraft(node.id, "title");
                setNodeContextMenu(null);
                await onComplete();
              };
              void complete().catch(onTagError);
            }}
          >
            <CircleCheck size={16} />
            <span>Complete</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={dividerAction === null}
            onClick={() => {
              flushTitle(localTitle);
              setNodeContextMenu(null);
              void onSetDivider(dividerAction === "add").catch(onTagError);
            }}
          >
            <Minus size={16} />
            <span>{dividerAction === "remove" ? "Remove dividing line" : "Dividing line"}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!(selectionActions?.canSplit ?? splitOutlineLines(localTitle).length >= 2)}
            onClick={() => {
              flushTitle(localTitle);
              setNodeContextMenu(null);
              void onSplitLines().catch(onTagError);
            }}
          >
            <ListPlus size={16} />
            <span>Split by line breaks</span>
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={Boolean(selectionActions)}
            onClick={() => {
              flushTitle(localTitle);
              if (!node.id.startsWith("temp-")) void flushNodeDraft(node.id, "title").catch(() => {});
              setNodeContextMenu(null);
              onConvertToWorkspace(localTitle);
            }}
          >
            <FolderTree size={16} />
            <span>Convert to workspace</span>
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

