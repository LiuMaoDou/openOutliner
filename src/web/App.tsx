import {
  Bold,
  Check,
  CircleHelp,
  CircleCheck,
  CalendarPlus,
  CalendarX2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Code2,
  FileDown,
  FolderClosed,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Highlighter,
  Italic,
  Ellipsis,
  Monitor,
  Moon,
  Palette,
  PanelRight,
  Plus,
  Redo2,
  Search,
  Strikethrough,
  Sun,
  Tag as TagIcon,
  Tags as TagsIcon,
  Trash2,
  Undo2,
  Upload,
  X
} from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import { useVirtualizer } from "@tanstack/react-virtual";
import ReactMarkdown from "react-markdown";
import { createPortal } from "react-dom";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent
} from "react";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiText,
  type OutlineHistoryResult,
  type OutlineHistoryState,
  type OutlineTreeNode,
  type Tag,
  type TaggedNodeGroup,
  type TaggedNodeResult,
  type Workspace,
  type WorkspaceFolder
} from "./api";
import { useTheme, type Theme } from "./theme";
import { resolveTagColor } from "../backend/shared/tagColors";
import {
  type FlatTreeState,
  type FlatNodeData,
  fromNestedTree,
  computeVisibleIds,
  updateNode,
  insertNode,
  removeNode,
  replaceNode,
  moveNode,
  moveNodes,
  getTopLevelNodeIds,
  getIndentTargetId,
  getNode,
  getParentId,
  isDescendant,
  hasNode
} from "./flatTree";

/** Dynamic depth computation: O(1) per node by walking parentId chain */
function getNodeDepth(state: FlatTreeState, id: string): number {
  let depth = 0;
  let current = state.nodes[id];
  while (current?.parentId && current.parentId !== state.rootId) {
    depth++;
    current = state.nodes[current.parentId];
  }
  return depth;
}

export function revealNodeInFlatTree(
  state: FlatTreeState,
  nodeId: string
): { state: FlatTreeState; visibleIds: string[]; index: number } {
  if (!hasNode(state, nodeId)) return { state, visibleIds: computeVisibleIds(state), index: -1 };

  let next = state;
  let parentId = getParentId(next, nodeId);
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = getNode(next, parentId);
    if (!parent) break;
    if (parent.collapsed) next = updateNode(next, parentId, { collapsed: false });
    parentId = parent.parentId;
  }

  const visibleIds = computeVisibleIds(next);
  return { state: next, visibleIds, index: visibleIds.indexOf(nodeId) };
}

export function getChildCountLabel(childCount: number): string | null {
  return childCount > 0 ? String(childCount) : null;
}

export function formatNodeDate(value: string): string {
  return value.replaceAll("-", "/");
}

export function getNodeSelectionRange(visibleIds: string[], anchorId: string, targetId: string): string[] {
  const targetIndex = visibleIds.indexOf(targetId);
  if (targetIndex < 0) return [];
  const anchorIndex = visibleIds.indexOf(anchorId);
  if (anchorIndex < 0) return [targetId];
  const start = Math.min(anchorIndex, targetIndex);
  const end = Math.max(anchorIndex, targetIndex);
  return visibleIds.slice(start, end + 1);
}

export type NodeSelectionPosition = "single" | "start" | "middle" | "end";

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

interface LoadTreeOptions {
  preserveSelection?: boolean;
}

type DropPlacement = "before" | "inside" | "after";
type WorkspaceDropPlacement = "before" | "inside" | "after";
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

interface WorkspaceDragTarget {
  folderId: string | null;
  parentWorkspaceId: string | null;
  position: number;
  markerId: string;
  overWorkspaceId?: string;
  placement?: WorkspaceDropPlacement;
}

interface DragState {
  draggingIds: string[];
  movingIds: string[];
  title: string;
  x: number;
  y: number;
  overId?: string;
  placement?: DropPlacement;
}

interface NodeSelectionDrag {
  pointerId: number;
  anchorId: string;
  startX: number;
  startY: number;
  additive: boolean;
  baseSelection: Set<string>;
  moved: boolean;
}

export type SystemTagRow =
  | { kind: "tag"; group: TaggedNodeGroup }
  | { kind: "node"; groupName: string; color: string; result: TaggedNodeResult };

interface TitleSelection {
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

interface PendingDelete {
  selectedIds: string[];
  primaryId: string;
  anchorId: string;
  nodeCount: number;
  workspaceId: string;
  focusAfterDeleteId: string;
  createdAt: number;
}

interface ConvertWorkspaceCandidate {
  id: string;
  title: string;
}

interface MoveWorkspaceCandidate {
  id: string;
  title: string;
  sourceWorkspaceId: string;
}

type ResizablePanel = "sidebar" | "inspector";

const DEFAULT_SIDEBAR_WIDTH = 264;
const MIN_SIDEBAR_WIDTH = 200;
const MAX_SIDEBAR_WIDTH = 420;
const DEFAULT_INSPECTOR_WIDTH = 264;
const MIN_INSPECTOR_WIDTH = 220;
const MAX_INSPECTOR_WIDTH = 480;
const PANEL_RESIZE_STEP = 16;
const SIDEBAR_COLLAPSED_STORAGE_KEY = "openoutliner.sidebar-collapsed:v1";
const COLLAPSED_WORKSPACE_FOLDERS_STORAGE_KEY = "openoutliner.collapsed-workspace-folders:v1";
const COLLAPSED_WORKSPACES_STORAGE_KEY = "openoutliner.collapsed-workspaces:v1";
const COLLAPSED_SYSTEM_TAGS_STORAGE_KEY = "openoutliner.collapsed-system-tags:v1";
const SIDEBAR_WIDTH_STORAGE_KEY = "openoutliner.sidebar-width";
const INSPECTOR_WIDTH_STORAGE_KEY = "openoutliner.inspector-width";
export const SYSTEM_TAGS_WORKSPACE_ID = "system:tags";
const EMPTY_OUTLINE_HISTORY: OutlineHistoryState = {
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null
};

const iconNameSet = new Set<string>(iconNames);
const markdownTextColorIds = new Set<string>(MARKDOWN_TEXT_COLORS.map(color => color.id));
const markdownTextColorClassNames = MARKDOWN_TEXT_COLORS.map(color => `markdownTextColor-${color.id}`);
const markdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark", "span"],
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ["className", ...markdownTextColorClassNames]]
  }
};

export function App() {
  const { theme, setTheme } = useTheme();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [flatState, setFlatState] = useState<FlatTreeState | null>(null);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [tagName, setTagName] = useState("");
  const [isTagSuggestionOpen, setIsTagSuggestionOpen] = useState(false);
  const [tags, setTags] = useState<Tag[]>([]);
  const tagSuggestionRef = useRef<HTMLDivElement | null>(null);
  const tagSuggestionListRef = useRef<HTMLDivElement | null>(null);
  const [tagSuggestionPosition, setTagSuggestionPosition] = useState<CSSProperties>({});
  const [activeTagFilter, setActiveTagFilter] = useState("");
  const [tagResults, setTagResults] = useState<TaggedNodeResult[]>([]);
  const [systemTagGroups, setSystemTagGroups] = useState<TaggedNodeGroup[]>([]);
  const [collapsedSystemTags, setCollapsedSystemTags] = useState<Set<string>>(() =>
    readStoredIdSet(COLLAPSED_SYSTEM_TAGS_STORAGE_KEY)
  );
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readStoredBoolean(SIDEBAR_COLLAPSED_STORAGE_KEY, false)
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredPanelWidth(SIDEBAR_WIDTH_STORAGE_KEY, DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH)
  );
  const [inspectorWidth, setInspectorWidth] = useState(() =>
    readStoredPanelWidth(
      INSPECTOR_WIDTH_STORAGE_KEY,
      DEFAULT_INSPECTOR_WIDTH,
      MIN_INSPECTOR_WIDTH,
      MAX_INSPECTOR_WIDTH
    )
  );
  const [isTagManagerOpen, setIsTagManagerOpen] = useState(false);
  const [isMarkdownHelpOpen, setIsMarkdownHelpOpen] = useState(false);
  const [workspaceDragTarget, setWorkspaceDragTarget] = useState<WorkspaceDragTarget | null>(null);
  const [collapsedWorkspaceFolderIds, setCollapsedWorkspaceFolderIds] = useState<Set<string>>(() =>
    readStoredIdSet(COLLAPSED_WORKSPACE_FOLDERS_STORAGE_KEY)
  );
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(() =>
    readStoredIdSet(COLLAPSED_WORKSPACES_STORAGE_KEY)
  );
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [outlineHistory, setOutlineHistory] = useState<OutlineHistoryState>(EMPTY_OUTLINE_HISTORY);
  const [convertWorkspaceCandidate, setConvertWorkspaceCandidate] = useState<ConvertWorkspaceCandidate | null>(null);
  const [isConvertingWorkspace, setIsConvertingWorkspace] = useState(false);
  const [moveWorkspaceCandidate, setMoveWorkspaceCandidate] = useState<MoveWorkspaceCandidate | null>(null);
  const [moveWorkspaceTargetId, setMoveWorkspaceTargetId] = useState("");
  const [isMovingToWorkspace, setIsMovingToWorkspace] = useState(false);
  const workspaceIdRef = useRef("");
  const pendingWorkspaceFocusIdRef = useRef("");
  const treeRequestRef = useRef(0);
  const tagsRequestRef = useRef(0);
  const tagResultsRequestRef = useRef(0);
  const systemTagGroupsRequestRef = useRef(0);
  const outlineHistoryRequestRef = useRef(0);
  const dragTargetRef = useRef<{ overId?: string; placement?: DropPlacement } | null>(null);
  const workspaceDragTargetRef = useRef<WorkspaceDragTarget | null>(null);
  const selectedIdRef = useRef("");
  const selectedNodeIdsRef = useRef(new Set<string>());
  const selectionAnchorIdRef = useRef("");
  const multiSelectionKeyboardActiveRef = useRef(false);
  const indentSelectionRef = useRef<((current: FlatNodeData) => Promise<void>) | null>(null);
  const deleteSelectionRef = useRef<((current: FlatNodeData) => Promise<void>) | null>(null);
  const editingNodeIdRef = useRef("");
  const nodeSelectionDragRef = useRef<NodeSelectionDrag | null>(null);
  const suppressSelectionClickRef = useRef(false);
  const inputRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const outlineSurfaceRef = useRef<HTMLDivElement | null>(null);
  const contentGridRef = useRef<HTMLElement | null>(null);
  const panelResizeCleanupRef = useRef<(() => void) | null>(null);
  const flatStateRef = useRef<FlatTreeState | null>(null);
  const rowResizeObserversRef = useRef(new Map<string, ResizeObserver>());
  const selectedIndexRef = useRef(-1);
  const cancelledTempIdsRef = useRef(new Set<string>());
  const localNodeTitlesRef = useRef(new Map<string, string>());
  const reconcilingNodeIdsRef = useRef(new Set<string>());
  const pendingNodeCreateCountRef = useRef(0);
  const nodeCreateQueueRef = useRef<Promise<void>>(Promise.resolve());
  const nodePatchQueuesRef = useRef(new Map<string, Promise<void>>());
  const nodeCompositionTrackerRef = useRef<NodeCompositionTracker | null>(null);
  const pendingNodeRevealRef = useRef<{ workspaceId: string; nodeId: string } | null>(null);
  if (!nodeCompositionTrackerRef.current) {
    nodeCompositionTrackerRef.current = new NodeCompositionTracker(callback => {
      window.requestAnimationFrame(callback);
    });
  }
  const nodeCompositionTracker = nodeCompositionTrackerRef.current;

  useEffect(() => {
    storeBoolean(SIDEBAR_COLLAPSED_STORAGE_KEY, sidebarCollapsed);
  }, [sidebarCollapsed]);

  useEffect(() => {
    storeIdSet(COLLAPSED_WORKSPACE_FOLDERS_STORAGE_KEY, collapsedWorkspaceFolderIds);
  }, [collapsedWorkspaceFolderIds]);

  useEffect(() => {
    storeIdSet(COLLAPSED_WORKSPACES_STORAGE_KEY, collapsedWorkspaceIds);
  }, [collapsedWorkspaceIds]);

  useEffect(() => {
    storeIdSet(COLLAPSED_SYSTEM_TAGS_STORAGE_KEY, collapsedSystemTags);
  }, [collapsedSystemTags]);

  useEffect(() => {
    storePanelWidth(SIDEBAR_WIDTH_STORAGE_KEY, sidebarWidth);
  }, [sidebarWidth]);

  useEffect(() => {
    storePanelWidth(INSPECTOR_WIDTH_STORAGE_KEY, inspectorWidth);
  }, [inspectorWidth]);

  useEffect(() => () => panelResizeCleanupRef.current?.(), []);

  const panelWidthBounds = (panel: ResizablePanel) => {
    if (panel === "sidebar") {
      const inspectorSpace = isInspectorOpen ? inspectorWidth : 0;
      const responsiveMax = window.innerWidth - inspectorSpace - 360;
      return {
        min: MIN_SIDEBAR_WIDTH,
        max: Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, responsiveMax))
      };
    }

    const contentWidth = contentGridRef.current?.getBoundingClientRect().width ?? window.innerWidth - sidebarWidth;
    return {
      min: MIN_INSPECTOR_WIDTH,
      max: Math.max(MIN_INSPECTOR_WIDTH, Math.min(MAX_INSPECTOR_WIDTH, contentWidth - 360))
    };
  };

  const updatePanelWidth = (panel: ResizablePanel, width: number) => {
    const bounds = panelWidthBounds(panel);
    const nextWidth = clampPanelWidth(width, bounds.min, bounds.max);
    if (panel === "sidebar") setSidebarWidth(nextWidth);
    else setInspectorWidth(nextWidth);
  };

  const startPanelResize = (panel: ResizablePanel, event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    panelResizeCleanupRef.current?.();

    const startX = event.clientX;
    const startWidth = panel === "sidebar" ? sidebarWidth : inspectorWidth;
    const move = (pointerEvent: globalThis.PointerEvent) => {
      const delta = pointerEvent.clientX - startX;
      updatePanelWidth(panel, startWidth + (panel === "sidebar" ? delta : -delta));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      document.body.classList.remove("isResizingPanel");
      panelResizeCleanupRef.current = null;
    };

    panelResizeCleanupRef.current = finish;
    document.body.classList.add("isResizingPanel");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };

  const resizePanelWithKeyboard = (panel: ResizablePanel, event: KeyboardEvent<HTMLDivElement>) => {
    const direction = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
    if (!direction) return;
    event.preventDefault();
    const currentWidth = panel === "sidebar" ? sidebarWidth : inspectorWidth;
    const panelDirection = panel === "sidebar" ? direction : -direction;
    updatePanelWidth(panel, currentWidth + panelDirection * PANEL_RESIZE_STEP);
  };

  const setNodeSelection = useCallback((ids: Iterable<string>, primaryId: string, anchorId = primaryId) => {
    const next = new Set(ids);
    if (primaryId) next.add(primaryId);
    selectedNodeIdsRef.current = next;
    selectedIdRef.current = primaryId;
    selectionAnchorIdRef.current = anchorId;
    multiSelectionKeyboardActiveRef.current = next.size > 1;
    setSelectedNodeIds(next);
    setSelectedId(primaryId);
  }, []);

  const setSingleSelectedId = useCallback((id: string) => {
    setNodeSelection(id ? [id] : [], id);
  }, [setNodeSelection]);

  const loadWorkspaces = useCallback(async () => {
    const next = await apiGet<Workspace[]>("/api/workspaces");
    const currentId = workspaceIdRef.current;
    const nextId = currentId === SYSTEM_TAGS_WORKSPACE_ID || next.some(workspace => workspace.id === currentId)
      ? currentId
      : next[0]?.id || "";
    workspaceIdRef.current = nextId;
    setWorkspaces(next);
    setWorkspaceId(nextId);
    return next;
  }, []);

  const loadWorkspaceFolders = useCallback(async () => {
    const next = await apiGet<WorkspaceFolder[]>("/api/workspace-folders");
    setWorkspaceFolders(next);
    return next;
  }, []);

  const loadTree = useCallback(async (id: string, options: LoadTreeOptions = {}) => {
    const requestId = ++treeRequestRef.current;
    if (!id || id === SYSTEM_TAGS_WORKSPACE_ID) {
      setFlatState(null);
      setVisibleIds([]);
      setSingleSelectedId("");
      return;
    }
    let next: OutlineTreeNode;
    try {
      next = await apiGet<OutlineTreeNode>(`/api/workspaces/${id}/tree`);
    } catch (error) {
      if (requestId !== treeRequestRef.current || id !== workspaceIdRef.current) return;
      throw error;
    }
    if (requestId !== treeRequestRef.current || id !== workspaceIdRef.current) return;
    const loaded = fromNestedTree(next);
    const pendingReveal = pendingNodeRevealRef.current;
    const revealed = pendingReveal?.workspaceId === id
      ? revealNodeInFlatTree(loaded.state, pendingReveal.nodeId)
      : { state: loaded.state, visibleIds: loaded.visibleIds, index: -1 };
    const state = revealed.state;
    setFlatState(state);
    setVisibleIds(revealed.visibleIds);
    flatStateRef.current = state;
    const pendingFocusId = pendingWorkspaceFocusIdRef.current;
    const pendingRevealId = pendingReveal?.workspaceId === id && hasNode(state, pendingReveal.nodeId)
      ? pendingReveal.nodeId
      : "";
    const current = selectedIdRef.current;
    const nextSelectedId = pendingRevealId
      || (pendingFocusId && hasNode(state, pendingFocusId)
      ? pendingFocusId
      : options.preserveSelection && current && hasNode(state, current)
        ? current
        : state.rootId);
    if (pendingFocusId === nextSelectedId) pendingWorkspaceFocusIdRef.current = "";
    setSingleSelectedId(nextSelectedId);
  }, [setSingleSelectedId]);

  const loadOutlineHistory = useCallback(async (id: string) => {
    const requestId = ++outlineHistoryRequestRef.current;
    if (!id || id === SYSTEM_TAGS_WORKSPACE_ID) {
      setOutlineHistory(EMPTY_OUTLINE_HISTORY);
      return;
    }
    const next = await apiGet<OutlineHistoryState>(`/api/workspaces/${id}/history`);
    if (requestId !== outlineHistoryRequestRef.current || id !== workspaceIdRef.current) return;
    setOutlineHistory(next);
    if (next.undoLabel !== "Delete outline") setPendingDelete(null);
  }, []);

  const loadTags = useCallback(async (id: string) => {
    const requestId = ++tagsRequestRef.current;
    if (!id || id === SYSTEM_TAGS_WORKSPACE_ID) {
      setTags([]);
      return;
    }
    let next: Tag[];
    try {
      next = await apiGet<Tag[]>(`/api/tags?workspaceId=${id}`);
    } catch (error) {
      if (requestId !== tagsRequestRef.current || id !== workspaceIdRef.current) return;
      throw error;
    }
    if (requestId !== tagsRequestRef.current || id !== workspaceIdRef.current) return;
    setTags(next);
  }, []);

  const loadTagResults = useCallback(async (name: string) => {
    const requestId = ++tagResultsRequestRef.current;
    const normalized = name.trim().replace(/^#/, "");
    if (!normalized) {
      setActiveTagFilter("");
      setTagResults([]);
      return;
    }
    setActiveTagFilter(normalized);
    const next = await apiGet<TaggedNodeResult[]>(`/api/tag-results?name=${encodeURIComponent(normalized)}`);
    if (requestId !== tagResultsRequestRef.current) return;
    setTagResults(next);
  }, []);

  const loadSystemTagGroups = useCallback(async () => {
    const requestId = ++systemTagGroupsRequestRef.current;
    let next: TaggedNodeGroup[];
    try {
      next = await apiGet<TaggedNodeGroup[]>("/api/system/tag-tree");
    } catch (error) {
      if (requestId !== systemTagGroupsRequestRef.current || workspaceIdRef.current !== SYSTEM_TAGS_WORKSPACE_ID) {
        return;
      }
      throw error;
    }
    if (requestId !== systemTagGroupsRequestRef.current || workspaceIdRef.current !== SYSTEM_TAGS_WORKSPACE_ID) return;
    setSystemTagGroups(next);
  }, []);

  useEffect(() => {
    loadWorkspaces().catch(toError(setError));
  }, [loadWorkspaces]);

  useEffect(() => {
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (!pending) return;
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.isContentEditable || active.matches("input, textarea"))) return;
      pending = false;
      void loadWorkspaces().then(() => Promise.all([
        loadWorkspaceFolders(), loadTree(workspaceIdRef.current, { preserveSelection: true }),
        loadTags(workspaceIdRef.current), loadOutlineHistory(workspaceIdRef.current)
      ])).catch(toError(setError));
    };
    const onSync = () => { pending = true; refresh(); };
    const onBlur = () => { clearTimeout(timer); timer = setTimeout(refresh, 100); };
    window.addEventListener("outliner-sync", onSync);
    window.addEventListener("focusout", onBlur);
    return () => { clearTimeout(timer); window.removeEventListener("outliner-sync", onSync); window.removeEventListener("focusout", onBlur); };
  }, [loadWorkspaces, loadWorkspaceFolders, loadTree, loadTags, loadOutlineHistory]);


  useEffect(() => {
    loadWorkspaceFolders().catch(toError(setError));
  }, [loadWorkspaceFolders]);

  useEffect(() => {
    loadTree(workspaceId).catch(toError(setError));
  }, [loadTree, workspaceId]);

  useEffect(() => {
    loadTags(workspaceId).catch(toError(setError));
  }, [loadTags, workspaceId]);

  useEffect(() => {
    loadOutlineHistory(workspaceId).catch(toError(setError));
  }, [loadOutlineHistory, workspaceId]);

  useEffect(() => {
    if (workspaceId !== SYSTEM_TAGS_WORKSPACE_ID) return;
    const refresh = () => {
      if (document.visibilityState === "visible") loadSystemTagGroups().catch(toError(setError));
    };
    refresh();
    const interval = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadSystemTagGroups, workspaceId]);

  useEffect(() => {
    setIsTagManagerOpen(false);
    setPendingDelete(null);
  }, [workspaceId]);

  useEffect(() => {
    if (!convertWorkspaceCandidate || isConvertingWorkspace) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setConvertWorkspaceCandidate(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [convertWorkspaceCandidate, isConvertingWorkspace]);

  useEffect(() => {
    if (!moveWorkspaceCandidate || isMovingToWorkspace) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMoveWorkspaceCandidate(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isMovingToWorkspace, moveWorkspaceCandidate]);

  useEffect(() => {
    if (!pendingDelete) return;
    const timer = window.setTimeout(() => setPendingDelete(current =>
      current?.createdAt === pendingDelete.createdAt ? null : current
    ), 6000);
    return () => window.clearTimeout(timer);
  }, [pendingDelete]);

  useEffect(() => {
    flatStateRef.current = flatState;
  }, [flatState]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const closeInspectorForMobile = () => {
      if (media.matches) setIsInspectorOpen(false);
    };
    closeInspectorForMobile();
    media.addEventListener("change", closeInspectorForMobile);
    return () => media.removeEventListener("change", closeInspectorForMobile);
  }, []);

  const selectedNode = selectedId && flatState ? getNode(flatState, selectedId) : undefined;
  const selectedWorkspace = workspaces.find(workspace => workspace.id === workspaceId);
  const isSystemTagsWorkspace = workspaceId === SYSTEM_TAGS_WORKSPACE_ID;
  const draggingNodeIds = useMemo(() => new Set(dragState?.draggingIds ?? []), [dragState?.draggingIds]);
  const rootWorkspaces = useMemo(
    () => workspaces.filter(workspace => !workspace.folderId && !workspace.parentWorkspaceId),
    [workspaces]
  );
  const workspacesByFolder = useMemo(() => {
    const map = new Map<string, Workspace[]>();
    for (const folder of workspaceFolders) map.set(folder.id, []);
    for (const workspace of workspaces) {
      if (!workspace.folderId || workspace.parentWorkspaceId) continue;
      const folderWorkspaces = map.get(workspace.folderId);
      if (folderWorkspaces) folderWorkspaces.push(workspace);
    }
    return map;
  }, [workspaceFolders, workspaces]);
  const workspacesByParent = useMemo(() => {
    const map = new Map<string, Workspace[]>();
    for (const workspace of workspaces) {
      if (!workspace.parentWorkspaceId) continue;
      const children = map.get(workspace.parentWorkspaceId) ?? [];
      children.push(workspace);
      map.set(workspace.parentWorkspaceId, children);
    }
    return map;
  }, [workspaces]);
  const moveWorkspaceOptions = useMemo(() => {
    const sourceWorkspaceId = moveWorkspaceCandidate?.sourceWorkspaceId ?? workspaceId;
    const workspacesById = new Map(workspaces.map(workspace => [workspace.id, workspace]));
    const foldersById = new Map(workspaceFolders.map(folder => [folder.id, folder]));
    return workspaces
      .filter(workspace => workspace.id !== sourceWorkspaceId)
      .map(workspace => ({
        workspace,
        label: getWorkspacePathLabel(workspace, workspacesById, foldersById)
      }));
  }, [moveWorkspaceCandidate?.sourceWorkspaceId, workspaceFolders, workspaceId, workspaces]);
  const isSearching = search.trim().length > 0;
  const isTagFiltering = activeTagFilter.length > 0;
  const filteredNodes = isSearching && flatState
    ? visibleIds.map(id => getNode(flatState, id)).filter((n): n is FlatNodeData => !!n && `${n.title}\n${n.body}`.toLowerCase().includes(search.toLowerCase())).map(n => n.id)
    : visibleIds;
  const visibleNodes = flatState ? filteredNodes.map(id => typeof id === 'string' ? { id, node: getNode(flatState, id) } : id).filter((item): item is { id: string; node: FlatNodeData } => !!item.node) : [];
  const filteredTagResults = isSearching
    ? tagResults.filter(result =>
        `${result.node.title}\n${result.node.body}\n${result.workspace.name}`.toLowerCase().includes(search.toLowerCase())
      )
    : tagResults;
  const systemTagRows = useMemo(
    () => buildSystemTagRows(systemTagGroups, collapsedSystemTags, search),
    [collapsedSystemTags, search, systemTagGroups]
  );
  const visibleItemCount = isSystemTagsWorkspace
    ? systemTagRows.length
    : isTagFiltering
      ? filteredTagResults.length
      : filteredNodes.length;
  const selectedIndex = selectedId
    ? isSystemTagsWorkspace
      ? -1
      : isTagFiltering
      ? filteredTagResults.findIndex(result => result.node.id === selectedId)
      : filteredNodes.findIndex(id => id === selectedId)
    : -1;
  selectedIndexRef.current = selectedIndex;
  const rowVirtualizer = useVirtualizer({
    count: visibleItemCount,
    getScrollElement: () => outlineSurfaceRef.current,
    getItemKey: index =>
      isSystemTagsWorkspace
        ? systemTagRowKey(systemTagRows[index], index)
        : isTagFiltering
        ? filteredTagResults[index]?.node.id ?? `tag-result-${index}`
        : filteredNodes[index] ?? index,
    measureElement: element => Math.ceil(element.getBoundingClientRect().height),
    estimateSize: index => isSystemTagsWorkspace && systemTagRows[index]?.kind === "node" ? 46 : 38,
    overscan: 16,
    useAnimationFrameWithResizeObserver: true
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  useEffect(() => {
    rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item, delta, instance) => {
      if (item.index === selectedIndexRef.current) return false;
      if (Math.abs(delta) < 1) return false;
      return item.end <= (instance.scrollOffset ?? 0);
    };

    return () => {
      rowVirtualizer.shouldAdjustScrollPositionOnItemSizeChange = undefined;
    };
  }, [rowVirtualizer]);

  useEffect(
    () => () => {
      rowResizeObserversRef.current.forEach(observer => observer.disconnect());
      rowResizeObserversRef.current.clear();
    },
    []
  );
  const registerVirtualRow = useCallback(
    (key: string, element: HTMLDivElement | null) => {
      rowResizeObserversRef.current.get(key)?.disconnect();
      rowResizeObserversRef.current.delete(key);
      if (!element) return;

      rowVirtualizer.measureElement(element);
      const observer = new ResizeObserver(() => {
        rowVirtualizer.measureElement(element);
      });
      observer.observe(element);
      rowResizeObserversRef.current.set(key, observer);
    },
    [rowVirtualizer]
  );

  const focusWhenReady = useCallback((nodeId: string, selection?: TitleSelection, attempts = 0) => {
    const input = inputRefs.current.get(nodeId);
    if (input) {
      focusTitleInput(input, selection);
      return;
    }
    if (attempts < 10) {
      window.requestAnimationFrame(() => focusWhenReady(nodeId, selection, attempts + 1));
    }
  }, []);

  const focusLocatedNodeWhenReady = useCallback((nodeId: string, attempts = 0) => {
    const input = inputRefs.current.get(nodeId);
    if (input) {
      focusTitleInput(input);
      input.scrollIntoView({ block: "center", inline: "nearest" });
      return;
    }
    if (attempts < 20) {
      window.requestAnimationFrame(() => focusLocatedNodeWhenReady(nodeId, attempts + 1));
    }
  }, []);

  useLayoutEffect(() => {
    const pending = pendingNodeRevealRef.current;
    if (!pending || pending.workspaceId !== workspaceId || pending.nodeId !== selectedId) return;
    const index = filteredNodes.indexOf(pending.nodeId);
    if (index < 0) return;

    pendingNodeRevealRef.current = null;
    rowVirtualizer.scrollToIndex(index, { align: "center" });
    window.requestAnimationFrame(() => focusLocatedNodeWhenReady(pending.nodeId));
  }, [filteredNodes, focusLocatedNodeWhenReady, rowVirtualizer, selectedId, workspaceId]);

  const runOutlineHistory = useCallback(async (
    direction: "undo" | "redo",
    preferredFocusId?: string,
    preferredSelection?: { ids: string[]; primaryId: string; anchorId: string }
  ) => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    await Promise.resolve();
    await nodeCreateQueueRef.current.catch(() => undefined);
    await Promise.all([...nodePatchQueuesRef.current.values()].map(request => request.catch(() => undefined)));

    const currentWorkspaceId = workspaceIdRef.current;
    if (!currentWorkspaceId) return;
    outlineHistoryRequestRef.current += 1;
    const result = await apiPost<OutlineHistoryResult>(
      `/api/workspaces/${currentWorkspaceId}/${direction}`,
      {}
    );
    if (currentWorkspaceId !== workspaceIdRef.current) return;

    const { state, visibleIds: nextVisibleIds } = fromNestedTree(result.tree);
    const currentSelectedId = selectedIdRef.current;
    const restoredSelectionIds = preferredSelection?.ids.filter(id => hasNode(state, id)) ?? [];
    const restoredSelection = new Set(restoredSelectionIds);
    const restoredPrimaryId = preferredSelection?.primaryId && restoredSelection.has(preferredSelection.primaryId)
      ? preferredSelection.primaryId
      : restoredSelectionIds[0];
    const nextSelectedId = restoredPrimaryId
      ? restoredPrimaryId
      : preferredFocusId && hasNode(state, preferredFocusId)
      ? preferredFocusId
      : currentSelectedId && hasNode(state, currentSelectedId)
        ? currentSelectedId
        : nextVisibleIds[0] ?? state.rootId;
    localNodeTitlesRef.current.clear();
    reconcilingNodeIdsRef.current.clear();
    setFlatState(state);
    setVisibleIds(nextVisibleIds);
    flatStateRef.current = state;
    setOutlineHistory(result.history);
    setPendingDelete(null);
    if (restoredPrimaryId) {
      const restoredAnchorId = preferredSelection?.anchorId && restoredSelection.has(preferredSelection.anchorId)
        ? preferredSelection.anchorId
        : restoredPrimaryId;
      setNodeSelection(restoredSelectionIds, restoredPrimaryId, restoredAnchorId);
    } else {
      setSingleSelectedId(nextSelectedId);
    }
    if (nextSelectedId !== state.rootId && restoredSelectionIds.length <= 1) {
      window.setTimeout(() => focusWhenReady(nextSelectedId), 30);
    }
  }, [focusWhenReady, setNodeSelection, setSingleSelectedId]);

  useEffect(() => {
    const handleOutlineHistoryShortcut = (event: globalThis.KeyboardEvent) => {
      const direction = getOutlineHistoryShortcut(
        event,
        outlineHistory.canUndo,
        outlineHistory.canRedo,
        isEditableElement(event.target),
        isOutlineEditableElement(event.target)
      );
      if (!direction) return;
      event.preventDefault();
      runOutlineHistory(direction).catch(toError(setError));
    };

    window.addEventListener("keydown", handleOutlineHistoryShortcut);
    return () => window.removeEventListener("keydown", handleOutlineHistoryShortcut);
  }, [outlineHistory.canRedo, outlineHistory.canUndo, runOutlineHistory]);

  const refresh = useCallback(
    async (focusId?: string) => {
      await loadTree(workspaceId, { preserveSelection: true });
      if (focusId) {
        setSingleSelectedId(focusId);
        window.setTimeout(() => focusTitleInput(inputRefs.current.get(focusId)), 30);
      }
    },
    [loadTree, setSingleSelectedId, workspaceId]
  );

  const patchNode = (id: string, patch: Partial<OutlineTreeNode>): Promise<void> => {
    if (id.startsWith("temp-")) return Promise.resolve();
    const previous = nodePatchQueuesRef.current.get(id) ?? Promise.resolve();
    const request = previous
      .catch(() => undefined)
      .then(() => apiPatch(`/api/nodes/${id}`, patch))
      .then(() => {
        loadOutlineHistory(workspaceIdRef.current).catch(toError(setError));
      });
    nodePatchQueuesRef.current.set(id, request);
    return request.finally(() => {
      if (nodePatchQueuesRef.current.get(id) === request) nodePatchQueuesRef.current.delete(id);
    });
  };

  const focusNode = (id: string) => {
    setSingleSelectedId(id);
    window.setTimeout(() => focusTitleInput(inputRefs.current.get(id)), 30);
  };

  const selectNode = (id: string) => {
    setSingleSelectedId(id);
  };

  const preserveOutlineScroll = () => {
    const element = outlineSurfaceRef.current;
    const scrollTop = element?.scrollTop;
    if (!element || scrollTop === undefined) return () => {};

    const restore = () => {
      element.scrollTop = scrollTop;
    };
    window.requestAnimationFrame(restore);
    window.setTimeout(restore, 0);
    window.setTimeout(restore, 50);
    return restore;
  };

  const clearTagFilter = () => {
    tagResultsRequestRef.current += 1;
    setActiveTagFilter("");
    setTagResults([]);
  };

  const openTagResult = async (result: TaggedNodeResult) => {
    clearTagFilter();
    setSearch("");
    systemTagGroupsRequestRef.current += 1;
    const isCurrentWorkspace = workspaceIdRef.current === result.workspace.id;
    pendingNodeRevealRef.current = { workspaceId: result.workspace.id, nodeId: result.node.id };
    workspaceIdRef.current = result.workspace.id;
    treeRequestRef.current += 1;
    tagsRequestRef.current += 1;
    setWorkspaceId(result.workspace.id);
    setFlatState(null);
    setSingleSelectedId("");
    setTags([]);
    setTagName("");
    if (!isCurrentWorkspace) return;
    try {
      await Promise.all([loadTree(result.workspace.id), loadTags(result.workspace.id)]);
    } catch (error) {
      pendingNodeRevealRef.current = null;
      throw error;
    }
  };

  const createOptimisticNode = async (
    parentId: string,
    position: number,
    current?: FlatNodeData,
    title = "",
    currentTitle = current?.title
  ) => {
    // Use flatStateRef to avoid stale closure when called together with onPatchLocal
    const currentFlatState = flatStateRef.current;
    if (!currentFlatState) return;
    const tempId = `temp-${crypto.randomUUID()}`;
    const preppedState =
      current && currentTitle !== undefined ? updateNode(currentFlatState, current.id, { title: currentTitle }) : currentFlatState;
    const tempNode: FlatNodeData = {
      id: tempId,
      workspaceId: currentFlatState.nodes[currentFlatState.rootId].workspaceId,
      parentId,
      position,
      title,
      body: "",
      dueDate: null,
      done: false,
      collapsed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      tags: [],
      fieldValues: [],
      childIds: []
    };

    if (current && currentTitle !== undefined) patchNode(current.id, { title: currentTitle }).catch(toError(setError));
    const newState = insertNode(preppedState, parentId, tempNode, position);
    setFlatState(newState);
    setVisibleIds(computeVisibleIds(newState));
    flatStateRef.current = newState;
    setSingleSelectedId(tempId);
    editingNodeIdRef.current = tempId;
    focusWhenReady(tempId);
    pendingNodeCreateCountRef.current += 1;

    try {
      const createRequest = nodeCreateQueueRef.current.then(() =>
        apiPost<OutlineTreeNode>("/api/nodes", {
          parentId,
          title,
          position
        })
      );
      nodeCreateQueueRef.current = createRequest.then(() => undefined, () => undefined);
      const created = await createRequest;
      loadOutlineHistory(workspaceIdRef.current).catch(toError(setError));
      if (cancelledTempIdsRef.current.has(tempId)) {
        cancelledTempIdsRef.current.delete(tempId);
        localNodeTitlesRef.current.delete(tempId);
        apiDelete(`/api/nodes/${created.id}`)
          .then(() => loadOutlineHistory(workspaceIdRef.current))
          .catch(toError(setError));
        return;
      }
      await nodeCompositionTracker.wait(tempId);
      if (cancelledTempIdsRef.current.has(tempId)) {
        cancelledTempIdsRef.current.delete(tempId);
        localNodeTitlesRef.current.delete(tempId);
        apiDelete(`/api/nodes/${created.id}`)
          .then(() => loadOutlineHistory(workspaceIdRef.current))
          .catch(toError(setError));
        return;
      }
      const draft = flatStateRef.current ? getNode(flatStateRef.current, tempId) : undefined;
      const pendingTitle = localNodeTitlesRef.current.get(tempId);
      const draftParentId = draft?.parentId ?? parentId;
      const createdPosition = created.position ?? position;
      const draftPosition = draft?.position ?? createdPosition;
      const latestTitle = resolvePendingNodeTitle(pendingTitle, draft?.title, created.title);
      const replacement: FlatNodeData = {
        id: created.id,
        workspaceId: created.workspaceId,
        parentId: draftParentId,
        position: draftPosition,
        title: latestTitle,
        body: draft?.body ?? created.body ?? "",
        dueDate: draft?.dueDate ?? created.dueDate ?? null,
        done: draft?.done ?? created.done ?? false,
        collapsed: draft?.collapsed ?? created.collapsed ?? false,
        createdAt: created.createdAt ?? new Date().toISOString(),
        updatedAt: created.updatedAt ?? new Date().toISOString(),
        tags: draft?.tags ?? created.tags ?? [],
        fieldValues: draft?.fieldValues ?? created.fieldValues ?? [],
        childIds: draft?.childIds ?? [],
      };
      const currentRef = applyCachedNodeTitles(flatStateRef.current ?? newState, localNodeTitlesRef.current);
      const withCreated = draft
        ? replaceNode(currentRef, tempId, replacement)
        : insertNode(removeNode(currentRef, tempId), parentId, replacement, position);
      const tempWasSelected = selectedNodeIdsRef.current.has(tempId);
      const tempWasPrimary = selectedIdRef.current === tempId;
      const tempWasAnchor = selectionAnchorIdRef.current === tempId;
      const tempWasEditing = editingNodeIdRef.current === tempId;
      const tempInput = inputRefs.current.get(tempId);
      const tempSelection = tempWasEditing && tempInput
        ? {
            start: tempInput.selectionStart ?? tempInput.value.length,
            end: tempInput.selectionEnd ?? tempInput.selectionStart ?? tempInput.value.length
          }
        : undefined;
      if (tempWasEditing) editingNodeIdRef.current = created.id;
      setFlatState(withCreated);
      setVisibleIds(computeVisibleIds(withCreated));
      flatStateRef.current = withCreated;
      localNodeTitlesRef.current.delete(tempId);
      localNodeTitlesRef.current.set(created.id, latestTitle);
      reconcilingNodeIdsRef.current.add(created.id);
      if (tempWasSelected || tempWasPrimary || tempWasAnchor || tempWasEditing) {
        const nextSelectedIds = new Set(selectedNodeIdsRef.current);
        nextSelectedIds.delete(tempId);
        nextSelectedIds.add(created.id);
        setNodeSelection(
          nextSelectedIds,
          tempWasPrimary || tempWasEditing ? created.id : selectedIdRef.current,
          tempWasAnchor ? created.id : selectionAnchorIdRef.current
        );
        if (tempWasPrimary || tempWasEditing) focusWhenReady(created.id, tempSelection);
      }
      if (
        draft &&
        draftParentId &&
        !draftParentId.startsWith("temp-") &&
        (draftParentId !== parentId || draftPosition !== createdPosition)
      ) {
        apiPost(`/api/nodes/${created.id}/move`, {
          parentId: draftParentId,
          position: draftPosition
        })
          .then(() => loadOutlineHistory(workspaceIdRef.current))
          .catch(toError(setError));
      }
      if (pendingTitle !== undefined || (draft && (draft.title || draft.body || draft.dueDate || draft.done || draft.collapsed))) {
        patchNode(created.id, {
          title: latestTitle,
          body: replacement.body,
          dueDate: replacement.dueDate,
          done: replacement.done,
          collapsed: replacement.collapsed
        }).catch(toError(setError));
      }
    } catch (error) {
      if (cancelledTempIdsRef.current.has(tempId)) {
        cancelledTempIdsRef.current.delete(tempId);
        localNodeTitlesRef.current.delete(tempId);
        return;
      }
      const latestState = flatStateRef.current;
      const withoutFailed = latestState && getNode(latestState, tempId)
        ? removeNode(latestState, tempId)
        : latestState;
      localNodeTitlesRef.current.delete(tempId);
      if (withoutFailed) {
        setFlatState(withoutFailed);
        setVisibleIds(computeVisibleIds(withoutFailed));
        flatStateRef.current = withoutFailed;
      }
      if (selectedIdRef.current === tempId || editingNodeIdRef.current === tempId) {
        editingNodeIdRef.current = current?.id ?? "";
        focusNode(current?.id ?? parentId);
      }
      throw error;
    } finally {
      pendingNodeCreateCountRef.current = Math.max(0, pendingNodeCreateCountRef.current - 1);
      if (pendingNodeCreateCountRef.current === 0) {
        for (const id of reconcilingNodeIdsRef.current) localNodeTitlesRef.current.delete(id);
        reconcilingNodeIdsRef.current.clear();
      }
    }
  };

  const deleteNodeOptimistically = async (node: FlatNodeData) => {
    const before = flatStateRef.current;
    if (!before || node.id === before.rootId) return;
    const visibleBefore = computeVisibleIds(before);
    const selectedIds = selectedNodeIdsRef.current.has(node.id) && selectedNodeIdsRef.current.size > 1
      ? visibleBefore.filter(id => selectedNodeIdsRef.current.has(id))
      : [node.id];
    const deletingIds = getTopLevelNodeIds(before, selectedIds);
    if (deletingIds.length === 0) return;
    if (deletingIds.some(id => id.startsWith("temp-")) && deletingIds.length > 1) {
      setError("Wait for new nodes to finish saving before deleting the selection.");
      return;
    }

    const currentWorkspaceId = workspaceId;
    const selectionBefore = new Set(selectedNodeIdsRef.current);
    const primaryBefore = selectedIdRef.current;
    const anchorBefore = selectionAnchorIdRef.current;
    const firstDeleteIndex = Math.min(...deletingIds.map(id => visibleBefore.indexOf(id)).filter(index => index >= 0));
    const newState = deletingIds.reduce((state, id) => removeNode(state, id), before);
    const removedIds = Object.keys(before.nodes).filter(id => !newState.nodes[id]);
    const previousId = visibleBefore
      .slice(0, Number.isFinite(firstDeleteIndex) ? firstDeleteIndex : 0)
      .reverse()
      .find(id => Boolean(newState.nodes[id])) ?? before.rootId;
    for (const id of removedIds) {
      localNodeTitlesRef.current.delete(id);
      reconcilingNodeIdsRef.current.delete(id);
    }
    setFlatState(newState);
    setVisibleIds(computeVisibleIds(newState));
    flatStateRef.current = newState;
    focusNode(previousId);
    if (deletingIds[0]?.startsWith("temp-")) {
      cancelledTempIdsRef.current.add(deletingIds[0]);
      return;
    }

    try {
      await apiPost("/api/nodes/delete-batch", { ids: deletingIds });
      loadOutlineHistory(currentWorkspaceId).catch(toError(setError));
      setPendingDelete({
        selectedIds,
        primaryId: selectedIds.includes(primaryBefore) ? primaryBefore : selectedIds[0],
        anchorId: selectedIds.includes(anchorBefore) ? anchorBefore : selectedIds[0],
        nodeCount: selectedIds.length,
        workspaceId: currentWorkspaceId,
        focusAfterDeleteId: previousId,
        createdAt: Date.now()
      });
    } catch (error) {
      setFlatState(before);
      setVisibleIds(computeVisibleIds(before));
      flatStateRef.current = before;
      setNodeSelection(selectionBefore, primaryBefore, anchorBefore);
      window.setTimeout(() => focusTitleInput(inputRefs.current.get(primaryBefore)), 30);
      throw error;
    }
  };
  deleteSelectionRef.current = deleteNodeOptimistically;

  useEffect(() => {
    const handleMultiSelectionDelete = (event: globalThis.KeyboardEvent) => {
      if (!shouldHandleMultiSelectionDelete(
        event,
        selectedNodeIdsRef.current.size,
        multiSelectionKeyboardActiveRef.current,
        isEditableElement(event.target),
        isOutlineEditableElement(event.target)
      )) return;

      const currentState = flatStateRef.current;
      if (!currentState) return;
      const primaryId = selectedNodeIdsRef.current.has(selectedIdRef.current)
        ? selectedIdRef.current
        : computeVisibleIds(currentState).find(id => selectedNodeIdsRef.current.has(id));
      const current = primaryId ? getNode(currentState, primaryId) : undefined;
      if (!current) return;

      event.preventDefault();
      deleteSelectionRef.current?.(current).catch(toError(setError));
    };

    window.addEventListener("keydown", handleMultiSelectionDelete);
    return () => window.removeEventListener("keydown", handleMultiSelectionDelete);
  }, []);

  const undoPendingDelete = async () => {
    const pending = pendingDelete;
    if (!pending || pending.workspaceId !== workspaceIdRef.current) return;
    try {
      await runOutlineHistory("undo", pending.primaryId, {
        ids: pending.selectedIds,
        primaryId: pending.primaryId,
        anchorId: pending.anchorId
      });
      const restoredState = flatStateRef.current;
      if (restoredState && pending.workspaceId === workspaceIdRef.current) {
        const restoredIds = pending.selectedIds.filter(id => hasNode(restoredState, id));
        const restoredIdSet = new Set(restoredIds);
        const restoredPrimaryId = restoredIdSet.has(pending.primaryId) ? pending.primaryId : restoredIds[0];
        if (restoredPrimaryId) {
          const restoredAnchorId = restoredIdSet.has(pending.anchorId) ? pending.anchorId : restoredPrimaryId;
          setNodeSelection(restoredIds, restoredPrimaryId, restoredAnchorId);
        }
      }
    } catch (error) {
      focusNode(pending.focusAfterDeleteId);
      throw error;
    }
  };

  const moveNodeOptimistically = async (
    source: FlatNodeData,
    parentId: string,
    position: number
  ) => {
    const before = flatStateRef.current;
    if (!before || source.id === parentId) return;
    const currentSource = getNode(before, source.id);
    if (!currentSource) return;
    const nextPosition =
      currentSource.parentId === parentId && currentSource.position < position ? position - 1 : position;
    if (currentSource.parentId === parentId && currentSource.position === nextPosition) return;
    const restoreScroll = preserveOutlineScroll();
    const newState = moveNode(before, currentSource.id, parentId, nextPosition);
    setFlatState(newState);
    setVisibleIds(computeVisibleIds(newState));
    flatStateRef.current = newState;
    selectNode(currentSource.id);
    restoreScroll();
    if (currentSource.id.startsWith("temp-") || parentId.startsWith("temp-")) return;

    try {
      await apiPost(`/api/nodes/${currentSource.id}/move`, { parentId, position: nextPosition });
      loadOutlineHistory(workspaceIdRef.current).catch(toError(setError));
    } catch (error) {
      setFlatState(before);
      setVisibleIds(computeVisibleIds(before));
      flatStateRef.current = before;
      focusNode(currentSource.id);
      throw error;
    } finally {
      window.setTimeout(() => {
        restoreScroll();
      }, 80);
    }
  };

  const createAfter = async (current: FlatNodeData, title = "", currentTitle = current.title) => {
    const currentFlatState = flatStateRef.current;
    if (!currentFlatState) return;
    const parentId = current.parentId ?? currentFlatState.rootId;
    await createOptimisticNode(parentId, current.position + 1, current, title, currentTitle);
  };

  const createBefore = async (current: FlatNodeData, currentTitle = current.title) => {
    const currentFlatState = flatStateRef.current;
    if (!currentFlatState) return;
    const parentId = current.parentId ?? currentFlatState.rootId;
    await createOptimisticNode(parentId, current.position, current, "", currentTitle);
  };

  const createFirstNode = async () => {
    if (!flatState) return;
    await createOptimisticNode(flatState.rootId, 0);
  };

  const indent = async (current: FlatNodeData) => {
    const currentState = flatStateRef.current;
    if (!currentState) return;
    const selectedIds = selectedNodeIdsRef.current.has(current.id)
      ? visibleIds.filter(id => selectedNodeIdsRef.current.has(id))
      : [current.id];
    const movingIds = getTopLevelNodeIds(currentState, selectedIds);
    const movingIdSet = new Set(movingIds);
    const firstMovingId = visibleIds.find(id => movingIdSet.has(id));
    if (!firstMovingId) return;
    const targetId = getIndentTargetId(currentState, visibleIds, firstMovingId);
    const target = targetId ? getNode(currentState, targetId) : undefined;
    if (!target) return;
    await moveNodesToTarget(movingIds, target, "inside");
  };
  indentSelectionRef.current = indent;

  useEffect(() => {
    const handleMultiSelectionTab = (event: globalThis.KeyboardEvent) => {
      if (!shouldHandleMultiSelectionTab(
        event,
        selectedNodeIdsRef.current.size,
        multiSelectionKeyboardActiveRef.current
      )) return;

      const currentState = flatStateRef.current;
      if (!currentState) return;
      const primaryId = selectedNodeIdsRef.current.has(selectedIdRef.current)
        ? selectedIdRef.current
        : computeVisibleIds(currentState).find(id => selectedNodeIdsRef.current.has(id));
      const current = primaryId ? getNode(currentState, primaryId) : undefined;
      if (!current) return;

      event.preventDefault();
      indentSelectionRef.current?.(current).catch(toError(setError));
    };

    window.addEventListener("keydown", handleMultiSelectionTab);
    return () => window.removeEventListener("keydown", handleMultiSelectionTab);
  }, []);

  const outdent = async (current: FlatNodeData) => {
    if (!flatState || !current.parentId || current.parentId === flatState.rootId) return;
    const parent = getNode(flatState, current.parentId);
    if (!parent?.parentId) return;
    await moveNodeOptimistically(current, parent.parentId, parent.position + 1);
  };

  const focusRelative = (current: FlatNodeData, offset: number) => {
    const index = visibleIds.indexOf(current.id);
    const nextId = visibleIds[index + offset];
    if (nextId) {
      setSingleSelectedId(nextId);
      focusTitleInput(inputRefs.current.get(nextId));
    }
  };

  const selectNodeWithMouse = (nodeId: string, event: MouseEvent<HTMLElement>) => {
    if (suppressSelectionClickRef.current) {
      suppressSelectionClickRef.current = false;
      event.preventDefault();
      return false;
    }

    const anchorId = selectionAnchorIdRef.current || selectedIdRef.current || nodeId;
    if (event.shiftKey) {
      setNodeSelection(getNodeSelectionRange(filteredNodes, anchorId, nodeId), nodeId, anchorId);
      return false;
    }

    if (event.metaKey || event.ctrlKey) {
      const next = new Set([...selectedNodeIdsRef.current].filter(id => filteredNodes.includes(id)));
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      const primaryId = next.has(nodeId)
        ? nodeId
        : next.has(selectedIdRef.current)
          ? selectedIdRef.current
          : filteredNodes.find(id => next.has(id)) ?? "";
      setNodeSelection(next, primaryId, nodeId);
      return false;
    }

    setSingleSelectedId(nodeId);
    return true;
  };

  const startNodeSelection = (node: FlatNodeData, event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType !== "mouse" || isTagFiltering) return;
    const target = event.target as HTMLElement;
    if (
      target.closest(".nodeTitle") ||
      target.closest(".nodeTitleLink") ||
      target.closest(".nodeMenuButton") ||
      target.closest(".disclosureButton") ||
      target.closest(".dragHandle") ||
      target.closest(".iconButton.danger") ||
      target.closest(".nodeDateControl") ||
      target.closest(".nodeTags")
    ) return;

    const anchorId = event.shiftKey
      ? selectionAnchorIdRef.current || selectedIdRef.current || node.id
      : node.id;
    const drag: NodeSelectionDrag = {
      pointerId: event.pointerId,
      anchorId,
      startX: event.clientX,
      startY: event.clientY,
      additive: event.metaKey || event.ctrlKey,
      baseSelection: event.metaKey || event.ctrlKey
        ? new Set([...selectedNodeIdsRef.current].filter(id => filteredNodes.includes(id)))
        : new Set(),
      moved: false
    };
    nodeSelectionDragRef.current = drag;
    event.currentTarget.setPointerCapture(event.pointerId);

    const move = (pointerEvent: globalThis.PointerEvent) => {
      const current = nodeSelectionDragRef.current;
      if (!current || current.pointerId !== pointerEvent.pointerId) return;
      const distance = Math.hypot(pointerEvent.clientX - current.startX, pointerEvent.clientY - current.startY);
      if (!current.moved && distance < 5) return;

      current.moved = true;
      pointerEvent.preventDefault();
      document.body.classList.add("isSelectingNodes");
      window.getSelection()?.removeAllRanges();

      const targetElement = document
        .elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
        ?.closest<HTMLElement>("[data-node-id]");
      const targetId = targetElement?.dataset.nodeId;
      if (!targetId || !filteredNodes.includes(targetId)) return;

      const range = getNodeSelectionRange(filteredNodes, current.anchorId, targetId);
      const next = current.additive ? new Set([...current.baseSelection, ...range]) : new Set(range);
      setNodeSelection(next, targetId, current.anchorId);

      const surface = outlineSurfaceRef.current;
      if (!surface) return;
      const bounds = surface.getBoundingClientRect();
      if (pointerEvent.clientY < bounds.top + 28) surface.scrollTop -= 18;
      else if (pointerEvent.clientY > bounds.bottom - 28) surface.scrollTop += 18;
    };

    const end = (pointerEvent: globalThis.PointerEvent) => {
      const current = nodeSelectionDragRef.current;
      if (!current || current.pointerId !== pointerEvent.pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      document.body.classList.remove("isSelectingNodes");
      nodeSelectionDragRef.current = null;
      if (current.moved) {
        suppressSelectionClickRef.current = true;
        window.setTimeout(() => {
          suppressSelectionClickRef.current = false;
        }, 0);
      }
    };

    window.addEventListener("pointermove", move, { passive: false });
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const cycleTheme = () => setTheme(nextTheme(theme));

  const startNodeDrag = (node: FlatNodeData, event: PointerEvent<HTMLButtonElement>) => {
    if (isSearching || isTagFiltering) return;
    const currentState = flatStateRef.current;
    if (!currentState) return;
    const draggingIds = selectedNodeIdsRef.current.has(node.id)
      ? filteredNodes.filter(id => selectedNodeIdsRef.current.has(id))
      : [node.id];
    const movingIds = getTopLevelNodeIds(currentState, draggingIds);
    if (movingIds.length === 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragTargetRef.current = null;
    if (draggingIds.length > 1) {
      setNodeSelection(draggingIds, node.id, selectionAnchorIdRef.current || node.id);
    } else {
      setSingleSelectedId(node.id);
    }
    const title = draggingIds.length > 1 ? `${draggingIds.length} nodes` : node.title;
    setDragState({ draggingIds, movingIds, title, x: event.clientX, y: event.clientY });
    document.body.classList.add("isDraggingNode");

    const move = (pointerEvent: globalThis.PointerEvent) => {
      const nextDragState = {
        draggingIds,
        movingIds,
        title,
        x: pointerEvent.clientX,
        y: pointerEvent.clientY
      };
      const targetElement = document
        .elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
        ?.closest<HTMLElement>("[data-node-id]");
      const targetId = targetElement?.dataset.nodeId;
      const target = targetId ? getNode(currentState, targetId) : undefined;

      if (
        !targetElement ||
        !target ||
        movingIds.some(id => id === target.id || isDescendant(currentState, id, target.id))
      ) {
        dragTargetRef.current = null;
        setDragState(nextDragState);
        return;
      }

      const placement = getDropPlacement(targetElement, pointerEvent.clientY);
      dragTargetRef.current = { overId: target.id, placement };
      setDragState({ ...nextDragState, overId: target.id, placement });
    };

    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      const latestState = flatStateRef.current;
      const target = dragTargetRef.current?.overId && latestState
        ? getNode(latestState, dragTargetRef.current.overId)
        : undefined;
      const placement = dragTargetRef.current?.placement;
      finishNodeDrag();
      if (target && placement) {
        moveNodesToTarget(movingIds, target, placement).catch(toError(setError));
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const finishNodeDrag = () => {
    dragTargetRef.current = null;
    document.body.classList.remove("isDraggingNode");
    setDragState(null);
  };

  const moveNodesToTarget = async (ids: string[], target: FlatNodeData, placement: DropPlacement) => {
    const before = flatStateRef.current;
    if (!before) return;
    const movingIds = getTopLevelNodeIds(before, ids);
    const currentTarget = getNode(before, target.id);
    if (
      movingIds.length === 0 ||
      !currentTarget ||
      movingIds.some(id => id === currentTarget.id || isDescendant(before, id, currentTarget.id))
    ) return;

    const containsTempNode = movingIds.some(id => id.startsWith("temp-"));
    let parentId: string;
    let position: number;
    let workingState = before;
    const movingIdSet = new Set(movingIds);
    if (placement === "inside") {
      parentId = currentTarget.id;
      position = currentTarget.childIds.filter(id => !movingIdSet.has(id)).length;
      if (currentTarget.collapsed) workingState = updateNode(workingState, currentTarget.id, { collapsed: false });
    } else {
      parentId = currentTarget.parentId ?? before.rootId;
      const remainingSiblings = before.nodes[parentId].childIds.filter(id => !movingIdSet.has(id));
      const targetIndex = remainingSiblings.indexOf(currentTarget.id);
      if (targetIndex < 0) return;
      position = targetIndex + (placement === "after" ? 1 : 0);
    }
    if (movingIds.length > 1 && (containsTempNode || parentId.startsWith("temp-"))) {
      throw new Error("Wait for new nodes to finish saving before moving the selection.");
    }

    const restoreScroll = preserveOutlineScroll();
    const newState = moveNodes(workingState, movingIds, parentId, position);
    if (newState === workingState) return;
    const selectionBefore = new Set(selectedNodeIdsRef.current);
    const primaryBefore = selectedIdRef.current;
    const anchorBefore = selectionAnchorIdRef.current;
    setFlatState(newState);
    setVisibleIds(computeVisibleIds(newState));
    flatStateRef.current = newState;
    setNodeSelection(selectionBefore, primaryBefore, anchorBefore);
    restoreScroll();

    if (containsTempNode || parentId.startsWith("temp-")) return;
    try {
      await apiPost("/api/nodes/move-batch", {
        ids: movingIds,
        parentId,
        position,
        expandParent: placement === "inside" && currentTarget.collapsed
      });
      loadOutlineHistory(workspaceIdRef.current).catch(toError(setError));
      restoreScroll();
    } catch (error) {
      setFlatState(before);
      setVisibleIds(computeVisibleIds(before));
      flatStateRef.current = before;
      setNodeSelection(selectionBefore, primaryBefore, anchorBefore);
      throw error;
    } finally {
      window.setTimeout(restoreScroll, 80);
    }
  };

  const selectWorkspace = useCallback((id: string) => {
    if (id === workspaceIdRef.current) return;
    pendingNodeRevealRef.current = null;
    workspaceIdRef.current = id;
    treeRequestRef.current += 1;
    tagsRequestRef.current += 1;
    tagResultsRequestRef.current += 1;
    systemTagGroupsRequestRef.current += 1;
    setWorkspaceId(id);
    setFlatState(null);
    setVisibleIds([]);
    setSingleSelectedId("");
    setTags([]);
    setActiveTagFilter("");
    setTagResults([]);
    setTagName("");
  }, [setSingleSelectedId]);

  const createWorkspace = async (folderId?: string | null, parentWorkspaceId?: string | null) => {
    const created = await apiPost<Workspace>(
      "/api/workspaces",
      createWorkspaceRequestBody(selectedWorkspace, folderId, parentWorkspaceId)
    );
    await loadWorkspaces();
    selectWorkspace(created.id);
  };

  const convertNodeToWorkspace = async () => {
    const candidate = convertWorkspaceCandidate;
    if (!candidate || isConvertingWorkspace) return;
    setIsConvertingWorkspace(true);
    try {
      const created = await apiPost<Workspace>(`/api/nodes/${candidate.id}/convert-to-workspace`, {
        name: candidate.title
      });
      setConvertWorkspaceCandidate(null);
      setCollapsedWorkspaceIds(current => {
        const next = new Set(current);
        next.delete(workspaceIdRef.current);
        return next;
      });
      await loadWorkspaces();
      selectWorkspace(created.id);
    } finally {
      setIsConvertingWorkspace(false);
    }
  };

  const moveNodeToWorkspace = async () => {
    const candidate = moveWorkspaceCandidate;
    const targetWorkspaceId = moveWorkspaceTargetId;
    if (!candidate || !targetWorkspaceId || isMovingToWorkspace) return;

    setIsMovingToWorkspace(true);
    try {
      await apiPost("/api/nodes/move-to-workspace", {
        ids: [candidate.id],
        workspaceId: targetWorkspaceId
      });
      pendingWorkspaceFocusIdRef.current = candidate.id;
      setMoveWorkspaceCandidate(null);
      selectWorkspace(targetWorkspaceId);
    } finally {
      setIsMovingToWorkspace(false);
    }
  };

  const createWorkspaceFolder = async () => {
    const created = await apiPost<WorkspaceFolder>("/api/workspace-folders", { name: "New Folder" });
    setWorkspaceFolders(current => [...current, created]);
  };

  const updateWorkspaceName = async (workspace: Workspace, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) {
      await loadWorkspaces();
      return;
    }
    const updated = await apiPatch<Workspace>(`/api/workspaces/${workspace.id}`, { name: trimmed });
    setWorkspaces(current => current.map(item => (item.id === updated.id ? updated : item)));
    if (updated.id === workspaceIdRef.current) await loadTree(updated.id, { preserveSelection: true });
  };

  const updateWorkspaceDraft = (id: string, name: string) => {
    setWorkspaces(current => current.map(workspace => (workspace.id === id ? { ...workspace, name } : workspace)));
  };

  const moveWorkspaceOptimistically = async (
    workspace: Workspace,
    nextFolderId: string | null,
    nextParentWorkspaceId: string | null,
    position: number
  ) => {
    const nextPosition =
      workspace.folderId === nextFolderId && workspace.parentWorkspaceId === nextParentWorkspaceId && workspace.position < position
        ? position - 1
        : position;
    if (
      workspace.folderId === nextFolderId &&
      workspace.parentWorkspaceId === nextParentWorkspaceId &&
      workspace.position === nextPosition
    ) return;
    const before = workspaces;
    setWorkspaces(current => reorderWorkspaces(current, workspace.id, nextFolderId, nextParentWorkspaceId, nextPosition));
    try {
      await apiPatch<Workspace>(`/api/workspaces/${workspace.id}`, {
        folderId: nextFolderId,
        parentWorkspaceId: nextParentWorkspaceId,
        position: nextPosition
      });
      await loadWorkspaces();
    } catch (error) {
      setWorkspaces(before);
      throw error;
    }
  };

  const startWorkspaceDrag = (workspace: Workspace, event: PointerEvent<HTMLSpanElement>) => {
    if (sidebarCollapsed) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    workspaceDragTargetRef.current = null;
    setWorkspaceDragTarget(null);
    const startX = event.clientX;
    const startY = event.clientY;
    let isDragging = false;

    const move = (pointerEvent: globalThis.PointerEvent) => {
      if (!isDragging) {
        if (Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 5) return;
        isDragging = true;
        workspaceDragTargetRef.current = {
          folderId: workspace.folderId,
          parentWorkspaceId: workspace.parentWorkspaceId,
          markerId: workspace.parentWorkspaceId ?? workspace.folderId ?? "root",
          position: Number.MAX_SAFE_INTEGER
        };
        setWorkspaceDragTarget(workspaceDragTargetRef.current);
        document.body.classList.add("isDraggingWorkspace");
      }
      const workspaceElement = document
        .elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
        ?.closest<HTMLElement>("[data-workspace-drop-id]");
      if (workspaceElement && workspaceElement.dataset.workspaceDropId !== workspace.id) {
        const placement = getWorkspaceDropPlacement(workspaceElement, pointerEvent.clientY);
        const parentWorkspaceId = placement === "inside"
          ? workspaceElement.dataset.workspaceDropId ?? null
          : workspaceElement.dataset.workspaceParentId || null;
        if (
          parentWorkspaceId &&
          (parentWorkspaceId === workspace.id || isWorkspaceDescendant(workspaces, parentWorkspaceId, workspace.id))
        ) {
          workspaceDragTargetRef.current = null;
          setWorkspaceDragTarget(null);
          return;
        }
        const position = Number(workspaceElement.dataset.workspacePosition ?? "0") + (placement === "after" ? 1 : 0);
        workspaceDragTargetRef.current = {
          folderId: parentWorkspaceId ? null : workspaceElement.dataset.workspaceFolderId || null,
          parentWorkspaceId,
          markerId: workspaceElement.dataset.workspaceDropId ?? "",
          overWorkspaceId: workspaceElement.dataset.workspaceDropId,
          placement,
          position
        };
        setWorkspaceDragTarget(workspaceDragTargetRef.current);
        return;
      }

      const targetElement = document
        .elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
        ?.closest<HTMLElement>("[data-workspace-folder-drop-id]");
      const targetId = targetElement?.dataset.workspaceFolderDropId ?? null;
      workspaceDragTargetRef.current =
        targetId === null
          ? null
          : {
              folderId: targetId === "root" ? null : targetId,
              parentWorkspaceId: null,
              markerId: targetId,
              position: Number.MAX_SAFE_INTEGER
            };
      setWorkspaceDragTarget(workspaceDragTargetRef.current);
    };

    const end = () => {
      const target = workspaceDragTargetRef.current;
      workspaceDragTargetRef.current = null;
      setWorkspaceDragTarget(null);
      document.body.classList.remove("isDraggingWorkspace");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (isDragging && target) {
        moveWorkspaceOptimistically(workspace, target.folderId, target.parentWorkspaceId, target.position).catch(toError(setError));
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const updateWorkspaceFolderName = async (folder: WorkspaceFolder, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const updated = await apiPatch<WorkspaceFolder>(`/api/workspace-folders/${folder.id}`, { name: trimmed });
    setWorkspaceFolders(current => current.map(item => (item.id === updated.id ? updated : item)));
  };

  const updateWorkspaceFolderDraft = (id: string, name: string) => {
    setWorkspaceFolders(current => current.map(folder => (folder.id === id ? { ...folder, name } : folder)));
  };

  const toggleWorkspaceFolder = (id: string) => {
    setCollapsedWorkspaceFolderIds(current => nextCollapsedWorkspaceFolderIds(current, id));
  };

  const deleteWorkspaceFolder = async (folder: WorkspaceFolder) => {
    if (!window.confirm(`Delete folder "${folder.name}"? Workspaces inside it will move to root.`)) return;
    await apiDelete(`/api/workspace-folders/${folder.id}`);
    setWorkspaceFolders(current => current.filter(item => item.id !== folder.id));
    setCollapsedWorkspaceFolderIds(current => {
      const next = new Set(current);
      next.delete(folder.id);
      return next;
    });
    setWorkspaces(current =>
      current.map(workspace => (workspace.folderId === folder.id ? { ...workspace, folderId: null } : workspace))
    );
  };

  const deleteWorkspace = async (workspace: Workspace) => {
    if (!window.confirm(`Delete workspace "${workspace.name}"?`)) return;
    const wasSelected = workspace.id === workspaceIdRef.current;
    if (wasSelected) {
      treeRequestRef.current += 1;
      tagsRequestRef.current += 1;
      tagResultsRequestRef.current += 1;
    }
    await apiDelete(`/api/workspaces/${workspace.id}`);
    if (wasSelected) {
      selectWorkspace(nextWorkspaceIdAfterDelete(workspaces, workspace.id));
      setError("");
    }
    await loadWorkspaces();
  };

  const addTag = async (nextName?: string) => {
    const name = (nextName ?? tagName).trim().replace(/^#/, "");
    if (!selectedNode || !name) return;
    if (selectedNode.tags.some(tag => tag.name === name)) {
      setTagName("");
      return;
    }
    const nodeId = selectedNode.id;
    const startedWorkspaceId = workspaceId;
    const existingTag = tags.find(tag => tag.name === name);
    const optimisticTag: Tag = existingTag ?? {
      id: `temp-tag-${crypto.randomUUID()}`,
      workspaceId: startedWorkspaceId,
      name,
      color: "#9ca3af",
      createdAt: new Date().toISOString()
    };
    setTagName("");
    setFlatState(current => {
      if (!current) return current;
      const next = addOptimisticNodeTag(current, nodeId, optimisticTag);
      flatStateRef.current = next;
      return next;
    });

    try {
      const savedTag = await apiPost<Tag>(`/api/nodes/${nodeId}/tags`, { name });
      if (workspaceIdRef.current !== startedWorkspaceId) return;
      setTags(current => upsertWorkspaceTag(current, savedTag));
      setFlatState(current => {
        if (!current) return current;
        const next = reconcileOptimisticNodeTag(current, nodeId, optimisticTag.id, savedTag);
        flatStateRef.current = next;
        return next;
      });
    } catch (error) {
      if (workspaceIdRef.current === startedWorkspaceId) {
        setFlatState(current => {
          if (!current) return current;
          const next = removeOptimisticNodeTag(current, nodeId, optimisticTag.id);
          flatStateRef.current = next;
          return next;
        });
        setTagName(current => current || name);
      }
      throw error;
    }
  };

  const unlinkNodeTag = async (nodeId: string, tag: Tag) => {
    const startedWorkspaceId = workspaceId;
    await apiDelete(`/api/nodes/${nodeId}/tags/${tag.id}`);
    if (workspaceIdRef.current !== startedWorkspaceId) return;
    setFlatState(current => {
      if (!current) return current;
      const next = removeOptimisticNodeTag(current, nodeId, tag.id);
      flatStateRef.current = next;
      return next;
    });
  };

  const tagSuggestions = useMemo(() => {
    const normalized = tagName.trim().replace(/^#/, "").toLowerCase();
    const existingNodeTags = new Set(selectedNode?.tags.map(tag => tag.name) ?? []);
    return tags
      .filter(tag => !existingNodeTags.has(tag.name))
      .filter(tag => !normalized || tag.name.toLowerCase().includes(normalized))
      .sort((left, right) => left.name.localeCompare(right.name));
  }, [selectedNode?.id, selectedNode?.tags.length, tagName, tags]);

  useLayoutEffect(() => {
    if (!isTagSuggestionOpen || !tagSuggestions.length) return;
    const anchor = tagSuggestionRef.current;
    if (!anchor) return;
    const updatePosition = () => {
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const gap = 6;
      const margin = 8;
      const below = viewportTop + viewportHeight - rect.bottom - gap - margin;
      const above = rect.top - viewportTop - gap - margin;
      const desiredHeight = Math.min(248, tagSuggestions.length * 34 + 14);
      const opensAbove = below < desiredHeight && above > below;
      const maxHeight = Math.max(0, Math.min(desiredHeight, opensAbove ? above : below));
      const width = Math.min(rect.width, viewportWidth - margin * 2);
      setTagSuggestionPosition({
        left: Math.max(viewportLeft + margin, Math.min(rect.left, viewportLeft + viewportWidth - width - margin)),
        top: opensAbove ? rect.top - gap : rect.bottom + gap,
        width,
        maxHeight,
        transform: opensAbove ? "translateY(-100%)" : undefined
      });
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(anchor);
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && tagSuggestionListRef.current?.contains(event.target)) return;
      updatePosition();
    };
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", onScroll, true);
    window.visualViewport?.addEventListener("resize", updatePosition);
    window.visualViewport?.addEventListener("scroll", updatePosition);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", onScroll, true);
      window.visualViewport?.removeEventListener("resize", updatePosition);
      window.visualViewport?.removeEventListener("scroll", updatePosition);
    };
  }, [isTagSuggestionOpen, tagSuggestions.length]);

  useEffect(() => {
    if (!isTagSuggestionOpen) return;
    const closeSuggestion = (event: globalThis.MouseEvent) => {
      const root = tagSuggestionRef.current;
      const target = event.target;
      if (target instanceof Node && (root?.contains(target) || tagSuggestionListRef.current?.contains(target))) return;
      setIsTagSuggestionOpen(false);
    };
    window.addEventListener("pointerdown", closeSuggestion);
    return () => window.removeEventListener("pointerdown", closeSuggestion);
  }, [isTagSuggestionOpen]);

  const updateTagDraft = (id: string, name: string) => {
    setTags(current => current.map(tag => (tag.id === id ? { ...tag, name } : tag)));
  };

  const saveTag = async (tag: Tag) => {
    const name = tag.name.trim();
    if (!name) {
      await loadTags(workspaceId);
      return;
    }
    await apiPatch<Tag>(`/api/tags/${tag.id}`, { name });
    await loadTags(workspaceId);
    await refresh();
  };

  const deleteTag = async (tag: Tag) => {
    if (!window.confirm(`Delete tag #${tag.name}?`)) return;
    await apiDelete(`/api/tags/${tag.id}`);
    await loadTags(workspaceId);
    await refresh();
  };

  const exportFile = async (format: "markdown" | "opml") => {
    const extension = format === "markdown" ? "md" : "opml";
    const content = await apiText(`/api/export/${format}`);
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    const date = new Date().toISOString().slice(0, 10);
    link.download = `${date}.${extension}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importFile = async (file: File) => {
    const content = await file.text();
    const format = file.name.toLowerCase().endsWith(".opml") ? "opml" : "markdown";
    const result = await apiPost<{ workspaceId?: string; workspaceIds?: string[] }>(`/api/import/${format}`, { content });
    const nextWorkspaces = await loadWorkspaces();
    const nextId =
      result.workspaceId && nextWorkspaces.some(workspace => workspace.id === result.workspaceId)
        ? result.workspaceId
        : nextWorkspaces[0]?.id || "";
    workspaceIdRef.current = nextId;
    tagResultsRequestRef.current += 1;
    setWorkspaceId(nextId);
    setActiveTagFilter("");
    setTagResults([]);
    await loadTree(nextId);
    await loadTags(nextId);
  };

  const renderWorkspaceItem = (workspace: Workspace, depth = 0): React.ReactNode => {
    const children = workspacesByParent.get(workspace.id) ?? [];
    const isCollapsed = collapsedWorkspaceIds.has(workspace.id);

    return (
      <React.Fragment key={workspace.id}>
        <div
          className={[
            "workspaceItem",
            workspace.id === workspaceId && "active",
            workspaceDragTarget?.overWorkspaceId === workspace.id &&
              workspaceDragTarget.placement &&
              `drop-${workspaceDragTarget.placement}`
          ]
            .filter(Boolean)
            .join(" ")}
          title={sidebarCollapsed ? workspace.name : undefined}
          data-workspace-drop-id={workspace.id}
          data-workspace-folder-id={workspace.folderId ?? ""}
          data-workspace-parent-id={workspace.parentWorkspaceId ?? ""}
          data-workspace-position={workspace.position}
          style={{ "--workspace-depth": depth } as CSSProperties}
          onClick={() => selectWorkspace(workspace.id)}
        >
          {!sidebarCollapsed && (
            <button
              className="workspaceDisclosure"
              type="button"
              disabled={children.length === 0}
              title={isCollapsed ? "Expand workspace" : "Collapse workspace"}
              aria-label={isCollapsed ? "Expand workspace" : "Collapse workspace"}
              aria-expanded={children.length > 0 ? !isCollapsed : undefined}
              onClick={event => {
                event.stopPropagation();
                if (children.length > 0) setCollapsedWorkspaceIds(current => nextCollapsedWorkspaceIds(current, workspace.id));
              }}
            >
              {children.length > 0 && (isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />)}
            </button>
          )}
          <span
            className="workspaceIcon workspaceDragHandle"
            title={sidebarCollapsed ? workspace.name : "Drag workspace"}
            onPointerDown={event => startWorkspaceDrag(workspace, event)}
          >
            <DynamicIcon
              name={workspaceIconName(workspace.icon)}
              fallback={() => <FolderTree size={15} />}
              size={15}
              strokeWidth={2.2}
            />
          </span>
          {!sidebarCollapsed && (
            <input
              value={workspace.name}
              onChange={event => updateWorkspaceDraft(workspace.id, event.target.value)}
              onBlur={event => updateWorkspaceName(workspace, event.target.value).catch(toError(setError))}
              onFocus={() => selectWorkspace(workspace.id)}
              onKeyDown={event => {
                if (shouldIgnoreTextInputKeyDown(event)) return;
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          )}
          {!sidebarCollapsed && (
            <button
              className="workspaceAddChildButton"
              type="button"
              title="New child workspace"
              onClick={event => {
                event.stopPropagation();
                createWorkspace(undefined, workspace.id).catch(toError(setError));
              }}
            >
              <Plus size={13} />
            </button>
          )}
          {!sidebarCollapsed && (
            <button
              className="workspaceDeleteButton"
              type="button"
              title="Delete workspace"
              onClick={event => {
                event.stopPropagation();
                deleteWorkspace(workspace).catch(toError(setError));
              }}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
        {!isCollapsed && children.map(child => renderWorkspaceItem(child, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <div
      className={`appShell${sidebarCollapsed ? " sidebarCollapsed" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      onPointerDownCapture={event => {
        if (!(event.target as HTMLElement).closest(".outlineList")) {
          multiSelectionKeyboardActiveRef.current = false;
        }
      }}
    >
      <aside className="sidebar">
        <div className="sidebarHeader">
          <div className="brand">
            <span className="brandMark">
              <FolderTree size={18} />
            </span>
            {!sidebarCollapsed && <span>OpenOutliner</span>}
            <button
              className="collapseButton"
              type="button"
              onClick={() => setSidebarCollapsed(collapsed => !collapsed)}
              title={sidebarCollapsed ? "Expand" : "Collapse"}
            >
              {sidebarCollapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>
          </div>
          {!sidebarCollapsed ? (
            <button className="commandButton" type="button" onClick={() => createWorkspace().catch(toError(setError))}>
              <Plus size={15} />
              <span>Workspace</span>
            </button>
          ) : (
            <button
              className="sidebarCollapsedAdd"
              type="button"
              onClick={() => createWorkspace().catch(toError(setError))}
              title="New Workspace"
            >
              <Plus size={15} />
            </button>
          )}
        </div>

        <div className="workspaceGroup">
          <button
            className={isSystemTagsWorkspace ? "systemWorkspaceItem active" : "systemWorkspaceItem"}
            type="button"
            title={sidebarCollapsed ? "Tags" : "System workspace"}
            onClick={() => selectWorkspace(SYSTEM_TAGS_WORKSPACE_ID)}
          >
            <span className="workspaceIcon" aria-hidden="true">
              <TagsIcon size={15} strokeWidth={2.2} />
            </span>
            {!sidebarCollapsed && (
              <span className="systemWorkspaceLabel">
                <span>Tags</span>
                <small>System</small>
              </span>
            )}
          </button>
          {!sidebarCollapsed ? (
            <>
              <div className="sidebarLabel workspaceLabel">
                <span>Workspaces</span>
                <button type="button" title="New folder" onClick={() => createWorkspaceFolder().catch(toError(setError))}>
                  <FolderPlus size={14} />
                </button>
              </div>
              <div
                className={workspaceDragTarget?.markerId === "root" ? "workspaceRootDrop active" : "workspaceRootDrop"}
                data-workspace-folder-drop-id="root"
              >
                {rootWorkspaces.map(workspace => renderWorkspaceItem(workspace))}
              </div>
              {workspaceFolders.map(folder => {
                const isCollapsed = collapsedWorkspaceFolderIds.has(folder.id);
                const folderWorkspaces = workspacesByFolder.get(folder.id) ?? [];
                return (
                  <div
                    className={
                      workspaceDragTarget?.markerId === folder.id ? "workspaceFolder dropActive" : "workspaceFolder"
                    }
                    key={folder.id}
                    data-workspace-folder-drop-id={folder.id}
                  >
                    <div className="workspaceFolderHeader">
                      <button
                        type="button"
                        className="workspaceFolderIconButton"
                        title={isCollapsed ? "Expand folder" : "Collapse folder"}
                        aria-expanded={!isCollapsed}
                        onClick={() => toggleWorkspaceFolder(folder.id)}
                      >
                        {isCollapsed ? (
                          <FolderClosed size={18} strokeWidth={2.2} />
                        ) : (
                          <FolderOpen size={18} strokeWidth={2.2} />
                        )}
                      </button>
                      <input
                        value={folder.name}
                        onChange={event => updateWorkspaceFolderDraft(folder.id, event.target.value)}
                        onBlur={event => updateWorkspaceFolderName(folder, event.target.value).catch(toError(setError))}
                        onKeyDown={event => {
                          if (shouldIgnoreTextInputKeyDown(event)) return;
                          if (event.key === "Enter") event.currentTarget.blur();
                        }}
                      />
                      <button
                        type="button"
                        title="New workspace in folder"
                        onClick={() => createWorkspace(folder.id).catch(toError(setError))}
                      >
                        <Plus size={13} />
                      </button>
                      <button
                        type="button"
                        title="Delete folder"
                        onClick={() => deleteWorkspaceFolder(folder).catch(toError(setError))}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                    {!isCollapsed && folderWorkspaces.map(workspace => renderWorkspaceItem(workspace))}
                    {!isCollapsed && folderWorkspaces.length === 0 && (
                      <div className="workspaceFolderEmpty">Empty folder</div>
                    )}
                  </div>
                );
              })}
            </>
          ) : (
            workspaces.filter(workspace => !workspace.parentWorkspaceId).map(workspace => renderWorkspaceItem(workspace))
          )}
        </div>
        {!sidebarCollapsed && (
          <div
            className="panelResizeHandle sidebarResizeHandle"
            role="separator"
            aria-label="Resize workspace sidebar"
            aria-orientation="vertical"
            aria-valuemin={MIN_SIDEBAR_WIDTH}
            aria-valuemax={MAX_SIDEBAR_WIDTH}
            aria-valuenow={sidebarWidth}
            tabIndex={0}
            title="Drag to resize; double-click to reset"
            onPointerDown={event => startPanelResize("sidebar", event)}
            onKeyDown={event => resizePanelWithKeyboard("sidebar", event)}
            onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
          />
        )}
      </aside>

      <main className="mainPane">
        <div className="mobileWorkspaceBar">
          <span className="mobileWorkspaceIcon">
            {isSystemTagsWorkspace ? (
              <TagsIcon size={16} strokeWidth={2.2} />
            ) : (
              <DynamicIcon
                name={workspaceIconName(selectedWorkspace?.icon ?? "")}
                fallback={() => <FolderTree size={16} />}
                size={16}
                strokeWidth={2.2}
              />
            )}
          </span>
          <select
            aria-label="Workspace"
            value={workspaceId}
            onChange={event => selectWorkspace(event.target.value)}
          >
            <option value={SYSTEM_TAGS_WORKSPACE_ID}>Tags · System</option>
            {workspaces.map(workspace => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => createWorkspace().catch(toError(setError))} title="New Workspace">
            <Plus size={16} />
          </button>
        </div>
        <header className="topbar">
          <div className="searchBox">
            <Search size={17} />
            <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search" />
          </div>
          <div className="toolbar">
            <button
              aria-label="Undo outline action"
              disabled={isSystemTagsWorkspace || !outlineHistory.canUndo}
              title={outlineHistory.undoLabel ? `Undo ${outlineHistory.undoLabel}` : "Undo outline action"}
              type="button"
              onClick={() => runOutlineHistory("undo").catch(toError(setError))}
            >
              <Undo2 size={17} />
            </button>
            <button
              aria-label="Redo outline action"
              disabled={isSystemTagsWorkspace || !outlineHistory.canRedo}
              title={outlineHistory.redoLabel ? `Redo ${outlineHistory.redoLabel}` : "Nothing to redo"}
              type="button"
              onClick={() => runOutlineHistory("redo").catch(toError(setError))}
            >
              <Redo2 size={17} />
            </button>
            <button className="themeToggle" title={`Theme: ${theme}`} type="button" onClick={cycleTheme}>
              {theme === "light" ? <Sun size={17} /> : theme === "dark" ? <Moon size={17} /> : <Monitor size={17} />}
              <span>{themeLabel(theme)}</span>
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".md,.markdown,.opml,.xml,text/markdown,text/xml"
              hidden
              onChange={event => {
                const file = event.target.files?.[0];
                if (file) importFile(file).catch(toError(setError));
                event.currentTarget.value = "";
              }}
            />
            <button title="Import" type="button" onClick={() => fileInputRef.current?.click()}>
              <Upload size={17} />
            </button>
            <button
              aria-label="Export OPML"
              title="Export OPML"
              type="button"
              onClick={() => exportFile("opml").catch(toError(setError))}
            >
              <FileDown size={17} />
            </button>
            <button title="Markdown shortcuts" type="button" onClick={() => setIsMarkdownHelpOpen(true)}>
              <CircleHelp size={17} />
            </button>
          </div>
        </header>

        {isMarkdownHelpOpen && (
          <div className="modalBackdrop" role="presentation" onClick={() => setIsMarkdownHelpOpen(false)}>
            <div
              className="markdownHelpDialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="markdown-help-title"
              onClick={event => event.stopPropagation()}
            >
              <div className="markdownHelpHeader">
                <h2 id="markdown-help-title">Markdown shortcuts</h2>
                <button type="button" onClick={() => setIsMarkdownHelpOpen(false)}>
                  <Check size={16} />
                </button>
              </div>
              <div className="markdownHelpList">
                <div>
                  <span>Bold</span>
                  <code>Ctrl+B</code>
                  <small>**text**</small>
                </div>
                <div>
                  <span>Italic</span>
                  <code>Ctrl+I</code>
                  <small>*text*</small>
                </div>
                <div>
                  <span>Strike</span>
                  <code>Ctrl+Alt+X</code>
                  <small>~~text~~</small>
                </div>
                <div>
                  <span>Inline code</span>
                  <code>Ctrl+E</code>
                  <small>`code`</small>
                </div>
                <div>
                  <span>Link text</span>
                  <code>Ctrl+K</code>
                  <small>[text](paste)</small>
                </div>
                <div>
                  <span>Highlight</span>
                  <code>Ctrl+Shift+H</code>
                  <small>==text==</small>
                </div>
                <div>
                  <span>Text color</span>
                  <code>Selection menu</code>
                  <small>{"{{color:red}}text{{/color}}"}</small>
                </div>
              </div>
            </div>
          </div>
        )}

        {convertWorkspaceCandidate && (
          <div
            className="modalBackdrop"
            role="presentation"
            onClick={() => {
              if (!isConvertingWorkspace) setConvertWorkspaceCandidate(null);
            }}
          >
            <div
              className="convertWorkspaceDialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="convert-workspace-title"
              onClick={event => event.stopPropagation()}
            >
              <div className="convertWorkspaceIcon" aria-hidden="true">
                <FolderTree size={20} />
              </div>
              <div className="convertWorkspaceCopy">
                <h2 id="convert-workspace-title">Convert to workspace?</h2>
                <p>
                  <strong>{convertWorkspaceCandidate.title || "Untitled"}</strong> and all nested outlines will move into a new child workspace.
                </p>
                <small>The outline will no longer appear in the current workspace.</small>
              </div>
              <div className="convertWorkspaceActions">
                <button
                  type="button"
                  disabled={isConvertingWorkspace}
                  onClick={() => setConvertWorkspaceCandidate(null)}
                >
                  Cancel
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={isConvertingWorkspace}
                  onClick={() => convertNodeToWorkspace().catch(toError(setError))}
                >
                  {isConvertingWorkspace ? "Converting…" : "Convert"}
                </button>
              </div>
            </div>
          </div>
        )}

        {moveWorkspaceCandidate && (
          <div
            className="modalBackdrop"
            role="presentation"
            onClick={() => {
              if (!isMovingToWorkspace) setMoveWorkspaceCandidate(null);
            }}
          >
            <div
              className="convertWorkspaceDialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="move-workspace-title"
              onClick={event => event.stopPropagation()}
            >
              <div className="convertWorkspaceIcon" aria-hidden="true">
                <FolderInput size={20} />
              </div>
              <div className="convertWorkspaceCopy">
                <h2 id="move-workspace-title">Move to workspace</h2>
                <p>
                  Move <strong>{moveWorkspaceCandidate.title || "Untitled"}</strong> and all nested outlines to another workspace.
                </p>
                <label className="moveWorkspaceField">
                  <span>Destination</span>
                  <select
                    aria-label="Destination workspace"
                    value={moveWorkspaceTargetId}
                    disabled={isMovingToWorkspace || moveWorkspaceOptions.length === 0}
                    onChange={event => setMoveWorkspaceTargetId(event.target.value)}
                  >
                    {moveWorkspaceOptions.length === 0 ? (
                      <option value="">No other workspace</option>
                    ) : (
                      moveWorkspaceOptions.map(option => (
                        <option key={option.workspace.id} value={option.workspace.id}>{option.label}</option>
                      ))
                    )}
                  </select>
                </label>
                <small>Tags, custom fields, notes, dates, and nested outlines will be preserved.</small>
              </div>
              <div className="convertWorkspaceActions">
                <button
                  type="button"
                  disabled={isMovingToWorkspace}
                  onClick={() => setMoveWorkspaceCandidate(null)}
                >
                  Cancel
                </button>
                <button
                  className="primary"
                  type="button"
                  disabled={isMovingToWorkspace || !moveWorkspaceTargetId}
                  onClick={() => moveNodeToWorkspace().catch(toError(setError))}
                >
                  {isMovingToWorkspace ? "Moving…" : "Move"}
                </button>
              </div>
            </div>
          </div>
        )}

        {error && (
          <div className="errorBar">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")}>
              <Check size={16} />
            </button>
          </div>
        )}

        {pendingDelete && pendingDelete.workspaceId === workspaceId && outlineHistory.undoLabel === "Delete outline" && (
          <div className="undoBar" role="status" aria-live="polite">
            <span>{pendingDelete.nodeCount === 1 ? "Deleted node" : `Deleted ${pendingDelete.nodeCount} nodes`}</span>
            <button type="button" onClick={() => undoPendingDelete().catch(toError(setError))}>
              <Undo2 size={15} />
              <span>Undo</span>
            </button>
          </div>
        )}

        <section
          className={isInspectorOpen && !isSystemTagsWorkspace ? "contentGrid" : "contentGrid commentsClosed"}
          ref={contentGridRef}
          style={{ "--inspector-width": `${inspectorWidth}px` } as CSSProperties}
        >
          <div className="outlineSurface" ref={outlineSurfaceRef}>
            <div className="outlineHeader">
              {isSystemTagsWorkspace ? (
                <div className="systemWorkspaceTitle">
                  <div>
                    <TagsIcon size={21} strokeWidth={2.2} />
                    <h1>Tags</h1>
                  </div>
                  <span>System workspace · Auto-generated</span>
                </div>
              ) : isTagFiltering ? (
                <h1>{`#${activeTagFilter}`}</h1>
              ) : selectedWorkspace ? (
                <input
                  className="workspaceTitleInput"
                  aria-label="Workspace title"
                  title="Rename workspace"
                  value={selectedWorkspace.name}
                  onChange={event => updateWorkspaceDraft(selectedWorkspace.id, event.target.value)}
                  onBlur={event => updateWorkspaceName(selectedWorkspace, event.target.value).catch(toError(setError))}
                  onKeyDown={event => {
                    if (shouldIgnoreTextInputKeyDown(event)) return;
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
              ) : (
                <h1>OpenOutliner</h1>
              )}
              {isTagFiltering && (
                <button className="tagFilterClear" type="button" onClick={clearTagFilter}>
                  <X size={15} />
                  <span>Clear</span>
                </button>
              )}
            </div>
            <div className="outlineList">
              {visibleItemCount > 0 ? (
                <div
                  className="virtualOutlineList"
                  style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                >
                  {virtualItems.map(virtualItem => {
                    if (isSystemTagsWorkspace) {
                      const row = systemTagRows[virtualItem.index];
                      if (!row) return null;
                      return (
                        <div
                          className="virtualOutlineRow"
                          data-index={virtualItem.index}
                          key={systemTagRowKey(row, virtualItem.index)}
                          ref={element => registerVirtualRow(systemTagRowKey(row, virtualItem.index), element)}
                          style={{ transform: `translateY(${virtualItem.start}px)` }}
                        >
                          {row.kind === "tag" ? (
                            <SystemTagGroupRow
                              group={row.group}
                              collapsed={collapsedSystemTags.has(row.group.name)}
                              onToggle={() => setCollapsedSystemTags(current =>
                                nextCollapsedWorkspaceIds(current, row.group.name)
                              )}
                            />
                          ) : (
                            <SystemTaggedNodeRow
                              color={row.color}
                              result={row.result}
                              onOpen={() => openTagResult(row.result).catch(toError(setError))}
                            />
                          )}
                        </div>
                      );
                    }
                    if (isTagFiltering) {
                      const result = filteredTagResults[virtualItem.index];
                      if (!result) return null;
                      return (
                        <div
                          className="virtualOutlineRow"
                          data-index={virtualItem.index}
                          key={result.node.id}
                          ref={element => registerVirtualRow(result.node.id, element)}
                          style={{ transform: `translateY(${virtualItem.start}px)` }}
                        >
                          <TagResultRow
                            result={result}
                            selected={selectedId === result.node.id}
                            onOpen={() => openTagResult(result).catch(toError(setError))}
                            onTagClick={tag => loadTagResults(tag.name).catch(toError(setError))}
                          />
                        </div>
                      );
                    }

                    const nodeId = filteredNodes[virtualItem.index];
                    if (!nodeId) return null;
                    const node = flatState ? getNode(flatState, nodeId) : undefined;
                    if (!node) return null;
                    const depth = flatState ? getNodeDepth(flatState, nodeId) : 0;
                    const selectionPosition = getNodeSelectionPosition(
                      filteredNodes,
                      selectedNodeIds,
                      virtualItem.index
                    );
                    return (
                      <div
                        className="virtualOutlineRow"
                        data-index={virtualItem.index}
                        key={node.id}
                        ref={element => registerVirtualRow(node.id, element)}
                        style={{ transform: `translateY(${virtualItem.start}px)` }}
                      >
                        <NodeRow
                          node={node}
                          depth={depth}
                          selected={selectedNodeIds.has(node.id)}
                          selectionPosition={selectionPosition}
                          active={selectedId === node.id}
                          canDrag={!isSearching && !isTagFiltering}
                          dragging={draggingNodeIds.has(node.id)}
                          dropPlacement={dragState?.overId === node.id ? dragState.placement ?? null : null}
                          registerInput={element => {
                            if (element) inputRefs.current.set(node.id, element);
                            else inputRefs.current.delete(node.id);
                          }}
                          onMouseSelect={event => selectNodeWithMouse(node.id, event)}
                          onFocusSelect={() => {
                            editingNodeIdRef.current = node.id;
                            setSingleSelectedId(node.id);
                          }}
                          onBlurFocus={() => {
                            if (editingNodeIdRef.current === node.id) editingNodeIdRef.current = "";
                          }}
                          onCompositionChange={isComposing => {
                            if (isComposing) nodeCompositionTracker.start(node.id);
                            else nodeCompositionTracker.finish(node.id);
                          }}
                          onSelectionStart={event => startNodeSelection(node, event)}
                          onPatchLocal={patch => {
                            const current = flatStateRef.current;
                            if (!current) return;
                            const next = updateNode(current, node.id, patch);
                            flatStateRef.current = next;
                            setFlatState(next);
                          }}
                          onCacheTitle={title => {
                            if (node.id.startsWith("temp-") || reconcilingNodeIdsRef.current.has(node.id)) {
                              localNodeTitlesRef.current.set(node.id, title);
                            }
                          }}
                          onCommit={patch => patchNode(node.id, patch).catch(toError(setError))}
                          onToggle={patch => {
                            setFlatState(s => {
                              if (!s) return s;
                              const next = updateNode(s, node.id, patch);
                              setVisibleIds(computeVisibleIds(next));
                              flatStateRef.current = next;
                              return next;
                            });
                            patchNode(node.id, patch).catch(toError(setError));
                          }}
                          onCreateAfter={(title, currentTitle) =>
                            createAfter(node, title, currentTitle).catch(toError(setError))
                          }
                          onCreateBefore={currentTitle =>
                            createBefore(node, currentTitle).catch(toError(setError))
                          }
                          onIndent={() => indent(node).catch(toError(setError))}
                          onOutdent={() => outdent(node).catch(toError(setError))}
                          onFocusPrevious={() => focusRelative(node, -1)}
                          onFocusNext={() => focusRelative(node, 1)}
                          onMoveStart={event => startNodeDrag(node, event)}
                          onTagClick={tag => loadTagResults(tag.name).catch(toError(setError))}
                          onTagRemove={tag => unlinkNodeTag(node.id, tag).catch(toError(setError))}
                          onConvertToWorkspace={title => setConvertWorkspaceCandidate({ id: node.id, title })}
                          onMoveToWorkspace={title => {
                            const firstTargetId = moveWorkspaceOptions[0]?.workspace.id ?? "";
                            setMoveWorkspaceTargetId(firstTargetId);
                            setMoveWorkspaceCandidate({ id: node.id, title, sourceWorkspaceId: workspaceId });
                          }}
                          onDelete={() => deleteNodeOptimistically(node)}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : isSystemTagsWorkspace ? (
                <div className="outlineEmptyState">
                  {isSearching ? "No matching tags or nodes" : "No tagged nodes yet"}
                </div>
              ) : visibleIds.length === 0 && flatState ? (
                <button
                  className="emptyNodeButton"
                  type="button"
                  onClick={() => createFirstNode().catch(toError(setError))}
                >
                  <Plus size={16} />
                  <span>First node</span>
                </button>
              ) : (
                <div className="outlineEmptyState">{isTagFiltering ? "No tagged nodes" : "No matching nodes"}</div>
              )}
            </div>
          </div>

          {isInspectorOpen && !isSystemTagsWorkspace && (
            <aside className="inspector">
              <div
                className="panelResizeHandle inspectorResizeHandle"
                role="separator"
                aria-label="Resize comments sidebar"
                aria-orientation="vertical"
                aria-valuemin={MIN_INSPECTOR_WIDTH}
                aria-valuemax={MAX_INSPECTOR_WIDTH}
                aria-valuenow={inspectorWidth}
                tabIndex={0}
                title="Drag to resize; double-click to reset"
                onPointerDown={event => startPanelResize("inspector", event)}
                onKeyDown={event => resizePanelWithKeyboard("inspector", event)}
                onDoubleClick={() => setInspectorWidth(DEFAULT_INSPECTOR_WIDTH)}
              />
              <div className="inspectorHeader">
                <div>
                  <span>Comments</span>
                </div>
                <button
                  className="iconButton commentsHideButton"
                  type="button"
                  title="Hide comments"
                  onClick={() => setIsInspectorOpen(false)}
                >
                  <PanelRight size={17} />
                </button>
              </div>
              {selectedNode ? (
                <>
                  <div className="notesAlert">
                    <CircleCheck className="notesAlertIcon" size={18} strokeWidth={2.2} />
                    <div className="notesAlertContent">
                      <div className="notesAlertTitle">Notes</div>
                      <textarea
                        className="nodeNotes"
                        value={selectedNode.body}
                        onChange={event =>
                          setFlatState(s => {
                            if (!s) return s;
                            const next = updateNode(s, selectedNode.id, { body: event.target.value });
                            flatStateRef.current = next;
                            return next;
                          })
                        }
                        onBlur={event =>
                          patchNode(selectedNode.id, { body: event.target.value }).catch(toError(setError))
                        }
                        placeholder="Add node details"
                      />
                    </div>
                  </div>
                  <div className="inspectorSection">
                    <label>Tags</label>
                    <div className="tagInput" ref={tagSuggestionRef}>
                      <TagIcon size={15} />
                      <div className="tagInputWithSuggestions">
                        <input
                          name="openoutliner-tag-input"
                          type="text"
                          autoComplete="off"
                          autoCorrect="off"
                          autoCapitalize="off"
                          spellCheck={false}
                          value={tagName}
                          onFocus={() => setIsTagSuggestionOpen(tagSuggestions.length > 0)}
                          onChange={event => {
                            setTagName(event.target.value);
                            setIsTagSuggestionOpen(true);
                          }}
                          onKeyDown={event => {
                            if (shouldIgnoreTextInputKeyDown(event)) return;
                            if (event.key === "Enter") {
                              setIsTagSuggestionOpen(false);
                              addTag().catch(toError(setError));
                            }
                            if (event.key === "Escape") setIsTagSuggestionOpen(false);
                          }}
                          placeholder="Tag"
                        />
                        {isTagSuggestionOpen && tagSuggestions.length > 0 && createPortal(
                          <div className="tagSuggestionList" ref={tagSuggestionListRef} style={tagSuggestionPosition} role="listbox" aria-label="标签建议">
                            {tagSuggestions.map(tag => (
                              <button
                                key={tag.id}
                                type="button"
                                className="tagSuggestionItem"
                                role="option"
                                onMouseDown={event => event.preventDefault()}
                                onClick={() => {
                                  void addTag(tag.name).catch(toError(setError));
                                  setIsTagSuggestionOpen(false);
                                }}
                              >
                                <span className="tagSuggestionDot" style={{ backgroundColor: resolveTagColor(tag) }} aria-hidden="true" />
                                <span className="tagSuggestionName" title={tag.name}>{tag.name}</span>
                              </button>
                            ))}
                          </div>,
                          document.body
                        )}
                      </div>
                      <button
                        type="button"
                        aria-label="Add tag to node"
                        onClick={() => {
                          setIsTagSuggestionOpen(false);
                          void addTag().catch(toError(setError));
                        }}
                      >
                        <Plus size={15} />
                        <span>Add</span>
                      </button>
                    </div>
                  </div>
                </>
              ) : (
                <div className="emptyInspector">No node selected</div>
              )}
              <div className="inspectorSection tagManagerSection">
                <button
                  className="tagManagerToggle"
                  type="button"
                  aria-expanded={isTagManagerOpen}
                  onClick={() => setIsTagManagerOpen(open => !open)}
                >
                  {isTagManagerOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
                  <span>Manage tags</span>
                  <small>{tags.length}</small>
                </button>
                {isTagManagerOpen && (
                  <>
                    <div className="tagManagerList">
                      {tags.map(tag => (
                        <div className="tagManagerRow" key={tag.id}>
                          <span className="tagManagerDot" style={{ backgroundColor: resolveTagColor(tag) }} aria-hidden="true" />
                          <input
                            aria-label={`Rename tag ${tag.name}`}
                            value={tag.name}
                            onChange={event => updateTagDraft(tag.id, event.target.value)}
                            onBlur={() => saveTag(tag).catch(toError(setError))}
                            onKeyDown={event => {
                              if (shouldIgnoreTextInputKeyDown(event)) return;
                              if (event.key === "Enter") event.currentTarget.blur();
                            }}
                          />
                          <button
                            type="button"
                            title="Delete tag"
                            onClick={() => deleteTag(tag).catch(toError(setError))}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </aside>
          )}
          {!isInspectorOpen && !isSystemTagsWorkspace && (
            <button
              className="commentsRestoreButton"
              type="button"
              title="Show comments"
              onClick={() => setIsInspectorOpen(true)}
            >
              <PanelRight size={15} />
              <span>Comments</span>
            </button>
          )}
        </section>
      </main>
      {dragState && (
        <div
          className="dragPreview"
          style={{ transform: `translate3d(${dragState.x + 12}px, ${dragState.y + 12}px, 0)` }}
        >
          <span className="nodeDot" />
          <span>{dragState.title || "Untitled"}</span>
        </div>
      )}
    </div>
  );
}

function NodeRow({
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
  onBlurFocus,
  onCompositionChange,
  onSelectionStart,
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
  onConvertToWorkspace,
  onMoveToWorkspace,
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
  onBlurFocus: () => void;
  onCompositionChange: (isComposing: boolean) => void;
  onSelectionStart: (event: PointerEvent<HTMLDivElement>) => void;
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
  onConvertToWorkspace: (title: string) => void;
  onMoveToWorkspace: (title: string) => void;
  onDelete: () => Promise<void>;
}) {
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const titleMeasureRef = useRef<HTMLDivElement | null>(null);
  const dateInputRef = useRef<HTMLInputElement | null>(null);
  const markdownMenuRef = useRef<HTMLDivElement | null>(null);
  const nodeContextMenuRef = useRef<HTMLDivElement | null>(null);
  const onCompositionChangeRef = useRef(onCompositionChange);
  onCompositionChangeRef.current = onCompositionChange;
  const [localTitle, setLocalTitle] = useState(node.title);
  const [markdownMenu, setMarkdownMenu] = useState<MarkdownContextMenuState | null>(null);
  const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenuState | null>(null);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textSelectionPointerRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startOffset: number;
  } | null>(null);

  // Sync external title changes (drag, undo, etc.) into local state
  useEffect(() => {
    if (node.title !== localTitle) setLocalTitle(node.title);
  }, [node.title]);

  // Flush local title to global state
  const flushTitle = useCallback((title: string) => {
    if (syncTimerRef.current) {
      clearTimeout(syncTimerRef.current);
      syncTimerRef.current = null;
    }
    onCacheTitle(title);
    onPatchLocal({ title });
  }, [onCacheTitle, onPatchLocal]);

  // Debounced sync during typing
  const syncTitleDebounced = useCallback((title: string) => {
    onCacheTitle(title);
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      onPatchLocal({ title });
      onCommit({ title });
      syncTimerRef.current = null;
    }, 300);
  }, [onCacheTitle, onCommit, onPatchLocal]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
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
    const closeOnWindowBlur = () => {
      if (markdownMenu) return;
      closeMenus();
    };
    const closeOnScroll = (event: Event) => {
      const target = event.target;
      if (markdownMenu && target instanceof Node && markdownMenuRef.current?.contains(target)) return;
      closeMenus();
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeMenus();
    };
    document.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("blur", closeOnWindowBlur);
    window.addEventListener("resize", closeMenus);
    window.addEventListener("scroll", closeOnScroll, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnPointerDown);
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
    onCommit({ title: nextTitle });
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
    const menuHeight = 96;
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
  const renderTitleLiterally = isMarkdownThematicBreak(node.title);
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
        onFocusSelect();
        openNodeContextMenu(event.clientX, event.clientY);
      }}
      onClick={event => {
        const target = event.target as HTMLElement;
        if (
          target.closest(".nodeTitle") ||
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
      <button
        className="iconButton nodeMenuButton"
        type="button"
        title="More outline actions"
        aria-label={`More actions for ${node.title || "Untitled"}`}
        aria-haspopup="menu"
        aria-expanded={Boolean(nodeContextMenu)}
        disabled={node.id.startsWith("temp-")}
        onPointerDown={event => event.stopPropagation()}
        onClick={event => {
          event.preventDefault();
          event.stopPropagation();
          onFocusSelect();
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
        {node.childIds.length > 0 ? node.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} /> : null}
      </button>
      <button
        className={[
          "dragHandle",
          node.done && "done",
          node.collapsed && node.childIds.length > 0 && "collapsed",
          hasComments && "hasComments"
        ].filter(Boolean).join(" ")}
        type="button"
        title={canDrag ? "Move node" : "Move disabled while searching"}
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
          value={localTitle}
          placeholder="Untitled"
          rows={1}
          onFocus={() => {
            onFocusSelect();
          }}
          onClick={event => {
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
          }}
          onCompositionStart={() => onCompositionChange(true)}
          onCompositionEnd={event => {
            const value = event.currentTarget.value;
            setLocalTitle(value);
            syncTitleDebounced(value);
            onCompositionChange(false);
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
            onCompositionChange(false);
            flushTitle(event.target.value);
            onCommit({ title: event.target.value });
            onBlurFocus();
          }}
          onPointerDown={event => {
            if (event.button === 0) {
              const measure = titleMeasureRef.current;
              if (!measure) return;
              textSelectionPointerRef.current = {
                pointerId: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                startOffset: getPreviewSelectionStart(measure, event.clientX, event.clientY, localTitle)
              };
              return;
            }
            if (event.button === 2 && openMarkdownContextMenu(event.currentTarget, event.clientX, event.clientY)) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onPointerUp={event => {
            if (event.button !== 0) return;
            const input = event.currentTarget;
            const pointer = textSelectionPointerRef.current;
            textSelectionPointerRef.current = null;
            const measure = titleMeasureRef.current;
            if (
              pointer?.pointerId === event.pointerId &&
              measure &&
              Math.hypot(event.clientX - pointer.startX, event.clientY - pointer.startY) >= 4
            ) {
              const endOffset = getPreviewSelectionStart(measure, event.clientX, event.clientY, localTitle);
              input.setSelectionRange(
                Math.min(pointer.startOffset, endOffset),
                Math.max(pointer.startOffset, endOffset)
              );
            }
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
            if (handleMarkdownShortcut(event, localTitle, onPatchLocal)) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              const input = event.currentTarget;
              const action = getNodeEnterAction(localTitle, input.selectionStart, input.selectionEnd);
              if (action.type === "insert-before") {
                flushTitle(localTitle);
                onCreateBefore(localTitle);
                return;
              }
              const { currentTitle, nextTitle } = action;
              // Batch all state updates: flush current title + create new node
              setLocalTitle(currentTitle);
              flushTitle(currentTitle);
              onCreateAfter(nextTitle, currentTitle);
            } else if (event.key === "Tab") {
              event.preventDefault();
              if (event.shiftKey) onOutdent();
              else onIndent();
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              onFocusPrevious();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              onFocusNext();
            } else if (event.key === "Backspace" && !localTitle) {
              event.preventDefault();
              onDelete();
            }
          }}
        />
        <div
          className="nodeTitlePreview"
          onPointerDown={event => {
            if (
              event.button !== 0 ||
              event.shiftKey ||
              event.metaKey ||
              event.ctrlKey ||
              (event.target as HTMLElement).closest(".nodeTitleLink")
            ) return;
            event.preventDefault();
            const input = titleInputRef.current;
            if (!input) return;
            const selectionStart = getPreviewSelectionStart(
              event.currentTarget,
              event.clientX,
              event.clientY,
              node.title
            );
            onFocusSelect();
            input.focus({ preventScroll: true });
            input.setSelectionRange(selectionStart, selectionStart);
            window.requestAnimationFrame(() => {
              if (document.activeElement !== input) return;
              input.setSelectionRange(selectionStart, selectionStart);
            });
          }}
          onClick={event => {
            event.stopPropagation();
            if ((event.target as HTMLElement).closest(".nodeTitleLink")) return
            if (!event.shiftKey && !event.metaKey && !event.ctrlKey) return;
            if (!onMouseSelect(event)) return;
          }}
        >
          {node.title.trim() ? (
            renderTitleLiterally ? (
              <span>{node.title}</span>
            ) : (
              <ReactMarkdown
                allowedElements={["p", "strong", "em", "del", "code", "a", "br", "mark", "span"]}
                rehypePlugins={[rehypeInlineFormatting, [rehypeSanitize, markdownSanitizeSchema]]}
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
                  p: ({ children }) => <span>{children}</span>
                }}
              >
                {node.title}
              </ReactMarkdown>
            )
          ) : (
            <span className="nodeTitlePlaceholder">Untitled</span>
          )}
        </div>
        <div ref={titleMeasureRef} className="nodeTitleMeasure" aria-hidden="true">
          {localTitle}
        </div>
      </div>
      <div className="nodeDateControl">
        <input
          ref={dateInputRef}
          className="nodeDatePicker"
          type="date"
          value={node.dueDate ?? ""}
          aria-label={`Date for ${node.title || "Untitled"}`}
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
      {childCountLabel ? (
        <span className="nodeChildCount">{childCountLabel}</span>
      ) : (
        <span className="nodeChildCount nodeChildCountPlaceholder" aria-hidden="true">0</span>
      )}
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
              flushTitle(localTitle);
              onCommit({ title: localTitle });
              setNodeContextMenu(null);
              onMoveToWorkspace(localTitle);
            }}
          >
            <FolderInput size={16} />
            <span>Move to workspace</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              flushTitle(localTitle);
              onCommit({ title: localTitle });
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

function TagResultRow({
  result,
  selected,
  onOpen,
  onTagClick
}: {
  result: TaggedNodeResult;
  selected: boolean;
  onOpen: () => void;
  onTagClick: (tag: Tag) => void;
}) {
  return (
    <div className={selected ? "tagResultRow selected" : "tagResultRow"}>
      <button className="tagResultMain" type="button" onClick={onOpen}>
        <span className="tagResultTitle">{result.node.title || "Untitled"}</span>
        <span className="tagResultWorkspace">{result.workspace.name}</span>
        {result.node.body && <span className="tagResultBody">{result.node.body}</span>}
      </button>
      <div className="nodeTags">
        {(result.tags || []).map(tag => (
          <button type="button" key={tag.id} onClick={() => onTagClick(tag)}>
            {tag.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function SystemTagGroupRow({
  group,
  collapsed,
  onToggle
}: {
  group: TaggedNodeGroup;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="systemTagGroupRow"
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      style={{ "--system-tag-color": group.color } as CSSProperties}
    >
      <span className="systemTagDisclosure" aria-hidden="true">
        {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
      </span>
      <span className="systemTagColor" aria-hidden="true" />
      <strong>#{group.name}</strong>
      <span className="systemTagCount">{group.results.length}</span>
    </button>
  );
}

function SystemTaggedNodeRow({
  color,
  result,
  onOpen
}: {
  color: string;
  result: TaggedNodeResult;
  onOpen: () => void;
}) {
  const path = result.path.length > 0
    ? result.path
    : [{ id: result.node.id, title: result.node.title, position: result.node.position }];
  const target = path[path.length - 1];
  const ancestorTitles = path.slice(0, -1).map(segment => segment.title || "Untitled");
  const targetTitle = target.title || "Untitled";
  const breadcrumbTitle = `${result.workspace.name} · ${[...ancestorTitles, targetTitle].join(" / ")}`;

  return (
    <button
      className={result.node.done ? "systemTaggedNodeRow completed" : "systemTaggedNodeRow"}
      type="button"
      onClick={onOpen}
      style={{ "--system-tag-color": color } as CSSProperties}
      title={breadcrumbTitle}
    >
      <span className="systemTagBranch" aria-hidden="true">
        <span />
      </span>
      <span className="systemTaggedNodeCopy">
        <span className="systemTaggedNodeBreadcrumb" aria-label={breadcrumbTitle}>
          {ancestorTitles.length > 0 && (
            <>
              <span className="systemTaggedNodeAncestors">{ancestorTitles.join(" / ")}</span>
              <span className="systemTaggedNodeSeparator" aria-hidden="true">/</span>
            </>
          )}
          <strong>{targetTitle}</strong>
        </span>
        {result.node.body && <small>{result.node.body}</small>}
      </span>
      <span className="systemTaggedNodeWorkspace">
        {result.workspace.name}
        <ChevronRight size={14} aria-hidden="true" />
      </span>
    </button>
  );
}

export function buildSystemTagRows(
  groups: TaggedNodeGroup[],
  collapsedNames: ReadonlySet<string>,
  query: string
): SystemTagRow[] {
  const normalizedQuery = query.trim().toLowerCase();
  const rows: SystemTagRow[] = [];

  for (const group of groups) {
    const groupMatches = group.name.toLowerCase().includes(normalizedQuery);
    const matchingResults = !normalizedQuery || groupMatches
      ? group.results
      : group.results.filter(result =>
          `${result.node.title}\n${result.node.body}\n${result.workspace.name}\n${result.path.map(segment => segment.title).join("\n")}`
            .toLowerCase()
            .includes(normalizedQuery)
        );
    if (normalizedQuery && !groupMatches && matchingResults.length === 0) continue;

    rows.push({ kind: "tag", group });
    if (!normalizedQuery && collapsedNames.has(group.name)) continue;
    for (const result of matchingResults) {
      rows.push({ kind: "node", groupName: group.name, color: group.color, result });
    }
  }

  return rows;
}

function systemTagRowKey(row: SystemTagRow | undefined, index: number): string {
  if (!row) return `system-tag-row-${index}`;
  return row.kind === "tag" ? `system-tag:${row.group.name}` : `system-node:${row.groupName}:${row.result.node.id}`;
}

function getDropPlacement(element: HTMLElement, clientY: number): DropPlacement {
  const bounds = element.getBoundingClientRect();
  const offset = clientY - bounds.top;
  if (offset < bounds.height * 0.28) return "before";
  if (offset > bounds.height * 0.72) return "after";
  return "inside";
}

function getWorkspaceDropPlacement(element: HTMLElement, clientY: number): WorkspaceDropPlacement {
  const bounds = element.getBoundingClientRect();
  const offset = clientY - bounds.top;
  if (offset < bounds.height * 0.28) return "before";
  if (offset > bounds.height * 0.72) return "after";
  return "inside";
}

function reorderWorkspaces(
  workspaces: Workspace[],
  workspaceId: string,
  folderId: string | null,
  parentWorkspaceId: string | null,
  position: number
): Workspace[] {
  const moving = workspaces.find(workspace => workspace.id === workspaceId);
  if (!moving) return workspaces;

  const withoutMoving = workspaces.filter(workspace => workspace.id !== workspaceId);
  const siblings = withoutMoving.filter(
    workspace => workspace.folderId === folderId && workspace.parentWorkspaceId === parentWorkspaceId
  );
  const nextPosition = Math.max(0, Math.min(position, siblings.length));
  const normalized = withoutMoving.map(workspace => {
    if (
      workspace.folderId === moving.folderId &&
      workspace.parentWorkspaceId === moving.parentWorkspaceId &&
      workspace.position > moving.position
    ) {
      return { ...workspace, position: workspace.position - 1 };
    }
    if (
      workspace.folderId === folderId &&
      workspace.parentWorkspaceId === parentWorkspaceId &&
      workspace.position >= nextPosition
    ) {
      return { ...workspace, position: workspace.position + 1 };
    }
    return workspace;
  });

  normalized.push({ ...moving, folderId, parentWorkspaceId, position: nextPosition });
  return normalized.sort((a, b) => {
    const folderCompare = (a.folderId ?? "").localeCompare(b.folderId ?? "");
    if (folderCompare !== 0) return folderCompare;
    const parentCompare = (a.parentWorkspaceId ?? "").localeCompare(b.parentWorkspaceId ?? "");
    if (parentCompare !== 0) return parentCompare;
    if (a.position !== b.position) return a.position - b.position;
    return a.createdAt.localeCompare(b.createdAt);
  });
}

function isWorkspaceDescendant(workspaces: Workspace[], workspaceId: string, ancestorId: string): boolean {
  let current = workspaces.find(workspace => workspace.id === workspaceId);
  const visited = new Set<string>();
  while (current?.parentWorkspaceId && !visited.has(current.id)) {
    visited.add(current.id);
    if (current.parentWorkspaceId === ancestorId) return true;
    current = workspaces.find(workspace => workspace.id === current?.parentWorkspaceId);
  }
  return false;
}

function getWorkspacePathLabel(
  workspace: Workspace,
  workspacesById: ReadonlyMap<string, Workspace>,
  foldersById: ReadonlyMap<string, WorkspaceFolder>
): string {
  const parts = [workspace.name];
  const visited = new Set([workspace.id]);
  let current = workspace;
  while (current.parentWorkspaceId && !visited.has(current.parentWorkspaceId)) {
    const parent = workspacesById.get(current.parentWorkspaceId);
    if (!parent) break;
    visited.add(parent.id);
    parts.unshift(parent.name);
    current = parent;
  }
  if (current.folderId) {
    const folder = foldersById.get(current.folderId);
    if (folder) parts.unshift(folder.name);
  }
  return parts.join(" / ");
}

function handleMarkdownShortcut(
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

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
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

function toMarkdownInlineNodes(value: string): HastNode[] {
  const nodes: HastNode[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    const colorPattern = /\{\{color:(red|orange|yellow|green|blue|purple|gray)\}\}/g;
    colorPattern.lastIndex = cursor;
    let colorMatch = colorPattern.exec(value);
    while (colorMatch && value.indexOf("{{/color}}", colorMatch.index + colorMatch[0].length) < 0) {
      colorMatch = colorPattern.exec(value);
    }

    const highlightStart = value.indexOf("==", cursor);
    const highlightEnd = highlightStart >= 0 ? value.indexOf("==", highlightStart + 2) : -1;
    const colorStart = colorMatch?.index ?? -1;
    const nextColorStart = colorStart >= 0 ? colorStart : Number.POSITIVE_INFINITY;
    const nextHighlightStart = highlightEnd >= 0 ? highlightStart : Number.POSITIVE_INFINITY;
    const nextStart = Math.min(nextColorStart, nextHighlightStart);

    if (!Number.isFinite(nextStart)) {
      nodes.push({ type: "text", value: value.slice(cursor) });
      break;
    }
    if (nextStart > cursor) nodes.push({ type: "text", value: value.slice(cursor, nextStart) });

    if (nextStart === nextColorStart && colorMatch) {
      const contentStart = colorMatch.index + colorMatch[0].length;
      const contentEnd = value.indexOf("{{/color}}", contentStart);
      nodes.push({
        type: "element",
        tagName: "span",
        properties: { className: [`markdownTextColor-${colorMatch[1]}`] },
        children: toMarkdownInlineNodes(value.slice(contentStart, contentEnd))
      });
      cursor = contentEnd + "{{/color}}".length;
      continue;
    }

    nodes.push({
      type: "element",
      tagName: "mark",
      properties: {},
      children: toMarkdownInlineNodes(value.slice(highlightStart + 2, highlightEnd))
    });
    cursor = highlightEnd + 2;
  }

  return nodes;
}

function rehypeInlineFormatting() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (!node.children || node.tagName === "code" || node.tagName === "pre") return;
      const children: HastNode[] = [];
      for (const child of node.children) {
        if (
          child.type === "text" &&
          (child.value?.includes("==") || child.value?.includes("{{color:"))
        ) {
          children.push(...toMarkdownInlineNodes(child.value));
        } else {
          visit(child);
          children.push(child);
        }
      }
      node.children = children;
    };
    visit(tree);
  };
}

export function clampPanelWidth(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), max));
}

function readStoredPanelWidth(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = Number(window.localStorage.getItem(key));
    return Number.isFinite(stored) && stored > 0 ? clampPanelWidth(stored, min, max) : fallback;
  } catch {
    return fallback;
  }
}

function storePanelWidth(key: string, value: number) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Width persistence is optional when storage is unavailable.
  }
}

export function resolveStoredBoolean(value: string | null, fallback: boolean): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function resolveStoredIdSet(value: string | null): Set<string> {
  if (!value) return new Set();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

export function resolvePendingNodeTitle(
  pendingTitle: string | undefined,
  draftTitle: string | undefined,
  createdTitle: string | undefined
): string {
  return pendingTitle ?? draftTitle ?? createdTitle ?? "";
}

export function applyCachedNodeTitles(
  state: FlatTreeState,
  titles: ReadonlyMap<string, string>
): FlatTreeState {
  let next = state;
  for (const [id, title] of titles) {
    if (next.nodes[id]?.title !== title) next = updateNode(next, id, { title });
  }
  return next;
}

export function addOptimisticNodeTag(state: FlatTreeState, nodeId: string, tag: Tag): FlatTreeState {
  const node = state.nodes[nodeId];
  if (!node || node.tags.some(current => current.id === tag.id || current.name === tag.name)) return state;
  return updateNode(state, nodeId, {
    tags: [...node.tags, tag].sort((left, right) => left.name.localeCompare(right.name))
  });
}

export function reconcileOptimisticNodeTag(
  state: FlatTreeState,
  nodeId: string,
  optimisticTagId: string,
  savedTag: Tag
): FlatTreeState {
  const node = state.nodes[nodeId];
  if (!node) return state;
  const tags = node.tags.filter(tag => tag.id !== optimisticTagId && tag.id !== savedTag.id && tag.name !== savedTag.name);
  return updateNode(state, nodeId, {
    tags: [...tags, savedTag].sort((left, right) => left.name.localeCompare(right.name))
  });
}

export function removeOptimisticNodeTag(state: FlatTreeState, nodeId: string, tagId: string): FlatTreeState {
  const node = state.nodes[nodeId];
  if (!node || !node.tags.some(tag => tag.id === tagId)) return state;
  return updateNode(state, nodeId, { tags: node.tags.filter(tag => tag.id !== tagId) });
}

export function upsertWorkspaceTag(tags: Tag[], savedTag: Tag): Tag[] {
  const next = tags.filter(tag => tag.id !== savedTag.id && tag.name !== savedTag.name);
  return [...next, savedTag].sort((left, right) => left.name.localeCompare(right.name));
}

function readStoredBoolean(key: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  try {
    return resolveStoredBoolean(window.localStorage.getItem(key), fallback);
  } catch {
    return fallback;
  }
}

function storeBoolean(key: string, value: boolean) {
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // State persistence is optional when storage is unavailable.
  }
}

function readStoredIdSet(key: string): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return resolveStoredIdSet(window.localStorage.getItem(key));
  } catch {
    return new Set();
  }
}

function storeIdSet(key: string, values: ReadonlySet<string>) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...values].sort()));
  } catch {
    // State persistence is optional when storage is unavailable.
  }
}

function resizeTitleInput(input: HTMLTextAreaElement) {
  const currentHeight = input.style.height;
  input.style.height = "auto";
  const nextHeight = `${input.scrollHeight}px`;
  input.style.height = currentHeight === nextHeight ? currentHeight : nextHeight;
}

function focusTitleInput(input?: HTMLTextAreaElement | null, selection?: TitleSelection) {
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

function getPreviewSelectionStart(container: HTMLElement, clientX: number, clientY: number, title: string) {
  const measuredOffset = getMeasuredTextOffset(container, clientX, clientY);
  if (measuredOffset !== null) return Math.max(0, Math.min(measuredOffset, title.length));

  const caret = getCaretFromPoint(container.ownerDocument, clientX, clientY);
  if (!caret || !container.contains(caret.node)) return title.length;
  const renderedOffset = getTextOffset(container, caret.node, caret.offset);
  if (renderedOffset === null) return title.length;
  return Math.max(0, Math.min(renderedOffset, title.length));
}

function getMeasuredTextOffset(root: Node, clientX: number, clientY: number) {
  const document = root.ownerDocument;
  if (!document) return null;

  let renderedOffset = 0;
  let bestOffset: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  const measure = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const textLength = node.textContent?.length ?? 0;
      for (let index = 0; index < textLength; index += 1) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const rect = range.getBoundingClientRect();
        range.detach();
        if (rect.width === 0 && rect.height === 0) continue;

        const midpoint = rect.left + rect.width / 2;
        const candidateOffset = clientX <= midpoint ? renderedOffset + index : renderedOffset + index + 1;
        const verticalDistance = clientY < rect.top ? rect.top - clientY : clientY > rect.bottom ? clientY - rect.bottom : 0;
        const horizontalDistance =
          clientX < rect.left ? rect.left - clientX : clientX > rect.right ? clientX - rect.right : 0;
        const distance = verticalDistance * 1000 + horizontalDistance;
        if (distance < bestDistance) {
          bestDistance = distance;
          bestOffset = candidateOffset;
        }
      }
      renderedOffset += textLength;
      return;
    }

    for (const child of Array.from(node.childNodes)) measure(child);
  };

  measure(root);
  return bestOffset;
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

async function readClipboardText() {
  try {
    const text = await navigator.clipboard?.readText();
    return text?.trim().replace(/\s+/g, " ") ?? "";
  } catch {
    return "";
  }
}

function nextTheme(theme: Theme): Theme {
  if (theme === "light") return "dark";
  if (theme === "dark") return "system";
  return "light";
}

function themeLabel(theme: Theme): string {
  if (theme === "light") return "Light";
  if (theme === "dark") return "Dark";
  return "System";
}

function randomWorkspaceIcon(): IconName {
  return iconNames[Math.floor(Math.random() * iconNames.length)] ?? "folder-tree";
}

export function createWorkspaceRequestBody(
  selectedWorkspace: Pick<Workspace, "folderId" | "parentWorkspaceId"> | null | undefined,
  folderId?: string | null,
  parentWorkspaceId?: string | null
) {
  const nextParentWorkspaceId = parentWorkspaceId !== undefined
    ? parentWorkspaceId
    : folderId !== undefined
      ? null
      : selectedWorkspace?.parentWorkspaceId ?? null;
  return {
    name: "Untitled Workspace",
    icon: randomWorkspaceIcon(),
    folderId: nextParentWorkspaceId
      ? null
      : folderId !== undefined
        ? folderId
        : selectedWorkspace?.folderId ?? null,
    parentWorkspaceId: nextParentWorkspaceId
  };
}

export function nextWorkspaceIdAfterDelete(workspaces: Workspace[], deletedWorkspaceId: string): string {
  return workspaces.find(workspace => workspace.id !== deletedWorkspaceId)?.id ?? "";
}

export function nextCollapsedWorkspaceFolderIds(current: Set<string>, folderId: string): Set<string> {
  const next = new Set(current);
  if (next.has(folderId)) {
    next.delete(folderId);
  } else {
    next.add(folderId);
  }
  return next;
}

export function nextCollapsedWorkspaceIds(current: Set<string>, workspaceId: string): Set<string> {
  const next = new Set(current);
  if (next.has(workspaceId)) {
    next.delete(workspaceId);
  } else {
    next.add(workspaceId);
  }
  return next;
}

function workspaceIconName(icon: string): IconName {
  return iconNameSet.has(icon) ? (icon as IconName) : "folder-tree";
}

function isEditableElement(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (
    target.matches("input, textarea, select") || target.isContentEditable
  );
}

function isOutlineEditableElement(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.matches(".nodeTitle, .nodeDatePicker, .nodeNotes");
}

export function getOutlineHistoryShortcut(
  event: Pick<globalThis.KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey">,
  canUndo: boolean,
  canRedo: boolean,
  editable: boolean,
  outlineEditable: boolean
): "undo" | "redo" | null {
  if (editable && !outlineEditable) return null;
  const key = event.key.toLowerCase();
  const modifier = event.metaKey || event.ctrlKey;
  const undo = modifier && key === "z" && !event.shiftKey;
  const redo = modifier && ((key === "z" && event.shiftKey) || (key === "y" && event.ctrlKey));
  if (undo && (canUndo || outlineEditable)) return "undo";
  if (redo && canRedo) return "redo";
  return null;
}

function toError(setError: (message: string) => void) {
  return (error: unknown) => {
    setError(error instanceof Error ? error.message : "Unexpected error");
  };
}
