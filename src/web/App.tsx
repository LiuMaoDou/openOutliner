import { registerUpdateBarrier } from "./appUpdates";
import { version as appVersion } from "../../package.json";
import { Check, CircleHelp, CircleCheck, CalendarDays, ChevronLeft, ChevronRight, FolderTree, Languages,
  EyeOff, Monitor, Moon, PanelLeft, PanelRight, Plus, Search, Sun, Tags as TagsIcon, Trash2, Undo2, X } from "lucide-react";
import { WorkspaceTreeIcon } from "./workspaceIcons";
import { useVirtualizer } from "@tanstack/react-virtual";
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
  requestEnglishTranslation,
  type OutlineHistoryResult,
  type OutlineHistoryState,
  type OutlineNode,
  type OutlineTreeNode,
  type RecycleBinEntry,
  type Tag,
  type TaggedNodeGroup,
  type TaggedNodeResult,
  type Workspace,
  type WorkspaceFolder
} from "./api";
import { useTheme, type Theme } from "./theme";
import { rollbackTreeMutation } from "./optimisticRollback";
import { clearTitleNativeSelection, shouldCopyNodes } from "./selectionOwnership";
import { getDueReminderCutoff, getDueReminderNodes } from "./dueTasks";
import { Calendar } from "./Calendar";
import { TODAY_WORKSPACE_ID } from "../backend/shared/systemWorkspaces";
import { canAddOutlineDivider, formatOutlineTitle, outlineTitleLabel, splitOutlineLines, splitOutlineTitle } from "../backend/shared/outlineTitle";
import { SyncPanel } from "./SyncPanel";
import { activatePrivacyScreen } from "./PrivacyScreen";
import { beginNodeEdit, endNodeEdit, flushNodeDraft, readNodeDraft, stageNodeDraft, beginCreation, stageCreation, pendingCreation, endCreation } from "./offline";
import {
  type FlatTreeState,
  type FlatNodeData,
  fromNestedTree,
  computeVisibleIds,
  selectedNodeText,
  searchNodeIds,
  updateNode,
  insertNode,
  removeNode,
  removeNodes,
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

import { NodeRow } from "./NodeRow";
import { OverdueTasks, NodeNotes, TagResultRow, RecycleBinRow, SystemTagGroupRow, SystemTaggedNodeRow,
  buildSystemTagRows, systemTagRowKey } from "./OutlinePanels";
import { NodeCompositionTracker, getNodeSelectionPosition, focusTitleInput, shouldHandleMultiSelectionTab,
  shouldHandleOutlineSelectAll, shouldHandleMultiSelectionDelete, shouldIgnoreTextInputKeyDown,
  type TitleSelection, type DropPlacement, type OutlineSelectionActions } from "./outlineInteraction";

// Retain the existing public helper imports for consumers and regression tests.
export * from "./outlineInteraction";
export * from "./markdownEditing";
export { buildSystemTagRows, type SystemTagRow } from "./OutlinePanels";

/** Compute depth in O(depth) by walking the parent chain. */
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
    if (parent.collapsed) {
      if (next === state) next = { ...state, nodes: { ...state.nodes } };
      next.nodes[parentId] = { ...parent, collapsed: false };
    }
    parentId = parent.parentId;
  }

  const visibleIds = computeVisibleIds(next);
  return { state: next, visibleIds, index: visibleIds.indexOf(nodeId) };
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

interface LoadTreeOptions {
  preserveSelection?: boolean;
}

type WorkspaceDropPlacement = "before" | "inside" | "after";
interface WorkspaceDragTarget {
  parentWorkspaceId: string | null;
  position: number;
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
  overWorkspaceId?: string;
}

type NodeDragTarget =
  | { kind: "node"; overId: string; placement: DropPlacement }
  | { kind: "workspace"; workspaceId: string };

interface NodeSelectionDrag {
  pointerId: number;
  anchorId: string;
  startX: number;
  startY: number;
  additive: boolean;
  baseSelection: Set<string>;
  moved: boolean;
}

interface PendingDelete {
  selectedIds: string[];
  primaryId: string;
  anchorId: string;
  nodeCount: number;
  workspaceId: string;
  focusAfterDeleteId: string;
  createdAt: number;
  action: "delete" | "complete";
}

interface ConvertWorkspaceCandidate {
  id: string;
  title: string;
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
export const SYSTEM_CALENDAR_WORKSPACE_ID = "system:calendar";
export const SYSTEM_TAGS_WORKSPACE_ID = "system:tags";
export const SYSTEM_RECYCLE_BIN_WORKSPACE_ID = "system:recycle-bin";
const EMPTY_OUTLINE_HISTORY: OutlineHistoryState = {
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null
};

export function App() {
  const { theme, setTheme } = useTheme();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [flatState, setFlatState] = useState<FlatTreeState | null>(null);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [tags, setTags] = useState<Tag[]>([]);
  const [activeTagFilter, setActiveTagFilter] = useState("");
  const [tagResults, setTagResults] = useState<TaggedNodeResult[]>([]);
  const [systemTagGroups, setSystemTagGroups] = useState<TaggedNodeGroup[]>([]);
  const [recycleBinEntries, setRecycleBinEntries] = useState<RecycleBinEntry[]>([]);
  const [restoringRecycleBinIds, setRestoringRecycleBinIds] = useState<Set<string>>(() => new Set());
  const [emptyingRecycleBin, setEmptyingRecycleBin] = useState(false);
  const [collapsedSystemTags, setCollapsedSystemTags] = useState<Set<string>>(() =>
    readStoredIdSet(COLLAPSED_SYSTEM_TAGS_STORAGE_KEY)
  );
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readStoredBoolean(SIDEBAR_COLLAPSED_STORAGE_KEY, false)
  );
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const sidebarCompact = sidebarCollapsed && !mobileSidebarOpen;
  const sidebarSearchRef = useRef<HTMLInputElement | null>(null);
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
  const [isMarkdownHelpOpen, setIsMarkdownHelpOpen] = useState(false);
  const [workspaceDragTarget, setWorkspaceDragTarget] = useState<WorkspaceDragTarget | null>(null);
  const [collapsedWorkspaceIds, setCollapsedWorkspaceIds] = useState<Set<string>>(() =>
    new Set([
      ...readStoredIdSet(COLLAPSED_WORKSPACES_STORAGE_KEY),
      ...readStoredIdSet(COLLAPSED_WORKSPACE_FOLDERS_STORAGE_KEY)
    ])
  );
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const [copyNotice, setCopyNotice] = useState(false);
  const copyNoticeTimerRef = useRef<number | undefined>(undefined);
  const [translationProgress, setTranslationProgress] = useState("");
  const translatingRef = useRef(false);
  const [outlineHistory, setOutlineHistory] = useState<OutlineHistoryState>(EMPTY_OUTLINE_HISTORY);
  const [convertWorkspaceCandidate, setConvertWorkspaceCandidate] = useState<ConvertWorkspaceCandidate | null>(null);
  const [isConvertingWorkspace, setIsConvertingWorkspace] = useState(false);
  const [isMovingToWorkspace, setIsMovingToWorkspace] = useState(false);
  const workspaceIdRef = useRef("");
  const pendingWorkspaceFocusIdRef = useRef("");
  const treeRequestRef = useRef(0);
  const pendingTreeMutationsRef = useRef(0);
  const selectionRevisionRef = useRef(0);
  const tagsRequestRef = useRef(0);
  const tagResultsRequestRef = useRef(0);
  const systemTagGroupsRequestRef = useRef(0);
  const recycleBinRequestRef = useRef(0);
  const outlineHistoryRequestRef = useRef(0);
  const dragTargetRef = useRef<NodeDragTarget | null>(null);
  const workspaceDragTargetRef = useRef<WorkspaceDragTarget | null>(null);
  const suppressWorkspaceIconClickRef = useRef(false);
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
  const resolvedTempNodeIdsRef = useRef(new Map<string, string>());
  const outlineSurfaceRef = useRef<HTMLDivElement | null>(null);
  const virtualListRef = useRef<HTMLDivElement | null>(null);
  const [compactLayout, setCompactLayout] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const [listScrollMargin, setListScrollMargin] = useState(0);
  const contentGridRef = useRef<HTMLElement | null>(null);
  const panelResizeCleanupRef = useRef<(() => void) | null>(null);
  const flatStateRef = useRef<FlatTreeState | null>(null);
  const selectedIndexRef = useRef(-1);
  const cancelledTempIdsRef = useRef(new Set<string>());
  const localNodeTitlesRef = useRef(new Map<string, string>());
  const reconcilingNodeIdsRef = useRef(new Set<string>());
  const pendingNodeCreateCountRef = useRef(0);
  const nodeCreateWaitersRef = useRef(new Set<() => void>());
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
    if (!mobileSidebarOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMobileSidebarOpen(false);
    };
    const media = window.matchMedia("(max-width: 980px)");
    const closeOnDesktop = () => {
      if (!media.matches) setMobileSidebarOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    media.addEventListener("change", closeOnDesktop);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      media.removeEventListener("change", closeOnDesktop);
    };
  }, [mobileSidebarOpen]);

  useEffect(() => {
    storeIdSet(COLLAPSED_WORKSPACES_STORAGE_KEY, collapsedWorkspaceIds, COLLAPSED_WORKSPACE_FOLDERS_STORAGE_KEY);
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

  useEffect(() => registerUpdateBarrier(async () => {
    const started = Date.now();
    do {
      await Promise.resolve();
      if (!pendingTreeMutationsRef.current && !pendingNodeCreateCountRef.current && !nodePatchQueuesRef.current.size) return;
      if (Date.now() - started > 10000) throw new Error("仍有大纲操作正在保存，请操作完成后重试更新。");
      await new Promise(resolve => window.setTimeout(resolve, 50));
    } while (true);
  }), []);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setCompactLayout(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

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
    selectionRevisionRef.current += 1;
    const next = new Set(ids);
    if (primaryId) next.add(primaryId);
    selectedNodeIdsRef.current = next;
    selectedIdRef.current = primaryId;
    selectionAnchorIdRef.current = anchorId;
    multiSelectionKeyboardActiveRef.current = next.size > 1;
    const editor = document.activeElement;
    if (next.size > 1 && editor instanceof HTMLTextAreaElement && editor.matches(".nodeTitle")) {
      clearTitleNativeSelection(editor);
      editor.blur();
    }
    setSelectedNodeIds(next);
    setSelectedId(primaryId);
  }, []);

  const setSingleSelectedId = useCallback((id: string) => {
    setNodeSelection(id ? [id] : [], id);
  }, [setNodeSelection]);

  const loadWorkspaces = useCallback(async () => {
    const folders = await apiGet<WorkspaceFolder[]>("/api/workspace-folders");
    const next = folders.length
      ? await apiPost<Workspace[]>("/api/workspaces/merge-folders", {})
      : await apiGet<Workspace[]>("/api/workspaces");
    const currentId = workspaceIdRef.current;
    const nextId = currentId === SYSTEM_CALENDAR_WORKSPACE_ID
      || currentId === SYSTEM_TAGS_WORKSPACE_ID
      || currentId === SYSTEM_RECYCLE_BIN_WORKSPACE_ID
      || next.some(workspace => workspace.id === currentId)
      ? currentId
      : (next.find(workspace => workspace.id !== TODAY_WORKSPACE_ID) ?? next[0])?.id || "";
    workspaceIdRef.current = nextId;
    setWorkspaces(next);
    setWorkspaceId(nextId);
    return next;
  }, []);

  const loadTree = useCallback(async (id: string, options: LoadTreeOptions = {}) => {
    const requestId = ++treeRequestRef.current;
    const initialState = flatStateRef.current;
    if (!id || id === SYSTEM_CALENDAR_WORKSPACE_ID || id === SYSTEM_TAGS_WORKSPACE_ID || id === SYSTEM_RECYCLE_BIN_WORKSPACE_ID) {
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
    if (options.preserveSelection && (initialState !== flatStateRef.current ||
      pendingTreeMutationsRef.current > 0 || pendingNodeCreateCountRef.current > 0)) {
      window.setTimeout(() => window.dispatchEvent(new Event("outliner-sync")), 100);
      return;
    }
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
    const preservedIds = options.preserveSelection && !pendingRevealId && !pendingFocusId
      ? [...selectedNodeIdsRef.current].filter(nodeId => hasNode(state, nodeId))
      : [];
    if (preservedIds.length > 1) {
      const primaryId = preservedIds.includes(nextSelectedId) ? nextSelectedId : preservedIds[0];
      const anchorId = preservedIds.includes(selectionAnchorIdRef.current) ? selectionAnchorIdRef.current : primaryId;
      setNodeSelection(preservedIds, primaryId, anchorId);
    } else {
      setSingleSelectedId(nextSelectedId);
    }
  }, [setNodeSelection, setSingleSelectedId]);

  const loadOutlineHistory = useCallback(async (id: string) => {
    const requestId = ++outlineHistoryRequestRef.current;
    if (!id || id === SYSTEM_CALENDAR_WORKSPACE_ID || id === SYSTEM_TAGS_WORKSPACE_ID || id === SYSTEM_RECYCLE_BIN_WORKSPACE_ID) {
      setOutlineHistory(EMPTY_OUTLINE_HISTORY);
      return;
    }
    const next = await apiGet<OutlineHistoryState>(`/api/workspaces/${id}/history`);
    if (requestId !== outlineHistoryRequestRef.current || id !== workspaceIdRef.current) return;
    setOutlineHistory(next);
    if (next.undoLabel !== "Delete outline") setPendingDelete(null);
  }, []);

  useEffect(() => {
    const saved = (event: Event) => {
      const { nodeId, field, value } = (event as CustomEvent<{ nodeId: string; field: "title" | "body"; value: string }>).detail;
      if (value === undefined) return;
      const current = flatStateRef.current;
      if (!current || !hasNode(current, nodeId)) return;
      const next = updateNode(current, nodeId, { [field]: readNodeDraft(nodeId, field) ?? value });
      flatStateRef.current = next;
      setFlatState(next);
      void loadOutlineHistory(workspaceIdRef.current).catch(toError(setError));
    };
    window.addEventListener("outliner-draft-saved", saved);
    window.addEventListener("outliner-draft-resolved", saved);
    return () => {
      window.removeEventListener("outliner-draft-saved", saved);
      window.removeEventListener("outliner-draft-resolved", saved);
    };
  }, [loadOutlineHistory]);

  const loadTags = useCallback(async (id: string) => {
    const requestId = ++tagsRequestRef.current;
    if (!id) {
      setTags([]);
      return;
    }
    let next: Tag[];
    try {
      next = await apiGet<Tag[]>("/api/system/tags");
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
      next = await apiGet<TaggedNodeGroup[]>("/api/system/tag-tree?includeUnused=1");
    } catch (error) {
      if (requestId !== systemTagGroupsRequestRef.current || workspaceIdRef.current !== SYSTEM_TAGS_WORKSPACE_ID) {
        return;
      }
      throw error;
    }
    if (requestId !== systemTagGroupsRequestRef.current || workspaceIdRef.current !== SYSTEM_TAGS_WORKSPACE_ID) return;
    setSystemTagGroups(next);
  }, []);

  const loadRecycleBin = useCallback(async () => {
    const requestId = ++recycleBinRequestRef.current;
    const next = await apiGet<RecycleBinEntry[]>("/api/recycle-bin");
    if (requestId !== recycleBinRequestRef.current || workspaceIdRef.current !== SYSTEM_RECYCLE_BIN_WORKSPACE_ID) return;
    setRecycleBinEntries(next);
  }, []);

  useEffect(() => {
    loadWorkspaces().catch(toError(setError));
  }, [loadWorkspaces]);

  useEffect(() => {
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      if (!pending) return;
      if (pendingTreeMutationsRef.current > 0 || pendingNodeCreateCountRef.current > 0 || nodePatchQueuesRef.current.size > 0) {
        clearTimeout(timer); timer = setTimeout(refresh, 100);
        return;
      }
      const active = document.activeElement;
      if (active instanceof HTMLElement && (active.isContentEditable || active.matches("input, textarea"))) return;
      pending = false;
      void loadWorkspaces().then(() => Promise.all([
        loadTree(workspaceIdRef.current, { preserveSelection: true }),
        loadTags(workspaceIdRef.current), loadOutlineHistory(workspaceIdRef.current),
        workspaceIdRef.current === SYSTEM_RECYCLE_BIN_WORKSPACE_ID ? loadRecycleBin() : Promise.resolve()
      ])).catch(toError(setError));
    };
    const onSync = () => { pending = true; refresh(); };
    const onBlur = () => { clearTimeout(timer); timer = setTimeout(refresh, 100); };
    window.addEventListener("outliner-sync", onSync);
    window.addEventListener("focusout", onBlur);
    return () => { clearTimeout(timer); window.removeEventListener("outliner-sync", onSync); window.removeEventListener("focusout", onBlur); };
  }, [loadWorkspaces, loadTree, loadTags, loadOutlineHistory, loadRecycleBin]);

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
    if (workspaceId !== SYSTEM_RECYCLE_BIN_WORKSPACE_ID) return;
    const refresh = () => {
      if (document.visibilityState === "visible") loadRecycleBin().catch(toError(setError));
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadRecycleBin, workspaceId]);

  useEffect(() => {
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
  const isTodayWorkspace = workspaceId === TODAY_WORKSPACE_ID;
  const isCalendarWorkspace = workspaceId === SYSTEM_CALENDAR_WORKSPACE_ID;
  const isSystemTagsWorkspace = workspaceId === SYSTEM_TAGS_WORKSPACE_ID;
  const isRecycleBinWorkspace = workspaceId === SYSTEM_RECYCLE_BIN_WORKSPACE_ID;
  const [dueReminderCutoff, setDueReminderCutoff] = useState(() => getDueReminderCutoff());
  const [allDueReminderNodes, setAllDueReminderNodes] = useState<OutlineNode[]>([]);
  useEffect(() => {
    let requestId = 0;
    const refresh = async () => {
      const currentRequest = ++requestId;
      try {
        const nodes = await apiGet<OutlineNode[]>(`/api/due-reminders?cutoff=${dueReminderCutoff}`);
        if (currentRequest === requestId) setAllDueReminderNodes(nodes);
      } catch (error) {
        if (currentRequest === requestId) toError(setError)(error);
      }
    };
    void refresh();
    window.addEventListener("outliner-data-changed", refresh);
    window.addEventListener("outliner-sync", refresh);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      requestId += 1;
      window.removeEventListener("outliner-data-changed", refresh);
      window.removeEventListener("outliner-sync", refresh);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [dueReminderCutoff]);
  useEffect(() => {
    const refresh = () => setDueReminderCutoff(getDueReminderCutoff());
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  const overdueNodes = useMemo(
    () => getDueReminderNodes(flatState, dueReminderCutoff, allDueReminderNodes),
    [flatState, dueReminderCutoff, allDueReminderNodes]
  );
  const draggingNodeIds = useMemo(() => new Set(dragState?.draggingIds ?? []), [dragState?.draggingIds]);
  const outlineDropWorkspace = workspaces.find(workspace => workspace.id === dragState?.overWorkspaceId);
  const workspacesByParent = useMemo(() => {
    const map = new Map<string | null, Workspace[]>();
    for (const workspace of workspaces) {
      if (workspace.id === TODAY_WORKSPACE_ID) continue;
      const children = map.get(workspace.parentWorkspaceId) ?? [];
      children.push(workspace);
      map.set(workspace.parentWorkspaceId, children);
    }
    return map;
  }, [workspaces]);
  const isSearching = search.trim().length > 0;
  const isTagFiltering = activeTagFilter.length > 0;
  const filteredNodes = useMemo(() => isSearching && flatState
    ? searchNodeIds(flatState, search)
    : visibleIds, [isSearching, flatState, search, visibleIds]);
  const selectedOutlines = selectedNodeIds.size > 1 && flatState
    ? filteredNodes.flatMap(id => selectedNodeIds.has(id) && flatState.nodes[id] ? [flatState.nodes[id]] : [])
    : [];
  const selectionActions: OutlineSelectionActions | undefined = selectedNodeIds.size > 1 ? {
    canTranslate: selectedOutlines.some(node => splitOutlineTitle(node.title).text.trim()),
    canSplit: selectedOutlines.some(node => splitOutlineLines(node.title).length >= 2),
    dividerAction: selectedOutlines.some(node => canAddOutlineDivider(node.title, node.body, node.childIds.length > 0))
      ? "add"
      : selectedOutlines.some(node => splitOutlineTitle(node.title).hasDivider) ? "remove" : null
  } : undefined;
  const getSelectedOutlineIds = (clickedId: string) => {
    const selected = selectedNodeIdsRef.current;
    return selected.has(clickedId) && selected.size > 1 ? filteredNodes.filter(id => selected.has(id)) : [clickedId];
  };
  const filteredTagResults = isSearching
    ? tagResults.filter(result =>
        `${result.node.title}\n${result.node.body}\n${result.workspace.name}`.toLowerCase().includes(search.toLowerCase())
      )
    : tagResults;
  const systemTagRows = useMemo(
    () => buildSystemTagRows(systemTagGroups, collapsedSystemTags, search),
    [collapsedSystemTags, search, systemTagGroups]
  );
  const filteredRecycleBinEntries = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return recycleBinEntries;
    return recycleBinEntries.filter(entry =>
      entry.workspace.name.toLowerCase().includes(query)
      || entry.node.title.toLowerCase().includes(query)
      || entry.node.body.toLowerCase().includes(query)
      || entry.descendants.some(node => `${node.title}\n${node.body}`.toLowerCase().includes(query))
    );
  }, [recycleBinEntries, search]);
  const visibleItemCount = isRecycleBinWorkspace
    ? filteredRecycleBinEntries.length
    : isSystemTagsWorkspace
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
  const getOutlineScrollElement = () => compactLayout ? contentGridRef.current : outlineSurfaceRef.current;
  const rowVirtualizer = useVirtualizer({
    count: visibleItemCount,
    getScrollElement: getOutlineScrollElement,
    scrollMargin: listScrollMargin,
    gap: isRecycleBinWorkspace ? 12 : 0,
    getItemKey: index =>
      isRecycleBinWorkspace
        ? filteredRecycleBinEntries[index]?.node.id ?? `recycle-bin-${index}`
        : isSystemTagsWorkspace
        ? systemTagRowKey(systemTagRows[index], index)
        : isTagFiltering
        ? filteredTagResults[index]?.node.id ?? `tag-result-${index}`
        : filteredNodes[index] ?? index,
    measureElement: element => Math.ceil(element.getBoundingClientRect().height),
    estimateSize: index => isRecycleBinWorkspace
      ? 92
      : isSystemTagsWorkspace && systemTagRows[index]?.kind === "node" ? 46 : 38,
    overscan: 16,
    useAnimationFrameWithResizeObserver: true
  });
  const virtualItems = rowVirtualizer.getVirtualItems();

  useLayoutEffect(() => {
    const surface = getOutlineScrollElement();
    const list = virtualListRef.current;
    if (!surface || !list) return;
    const measure = () => setListScrollMargin(list.getBoundingClientRect().top - surface.getBoundingClientRect().top + surface.scrollTop);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(surface);
    const header = outlineSurfaceRef.current?.querySelector(".outlineHeader");
    if (header) observer.observe(header);
    return () => observer.disconnect();
  }, [compactLayout, workspaceId, visibleItemCount > 0]);

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
    const workspace = workspaceIdRef.current, request = treeRequestRef.current;
    window.setTimeout(() => {
      if (workspace === workspaceIdRef.current && request === treeRequestRef.current && selectedIdRef.current === id) {
        focusTitleInput(inputRefs.current.get(id));
      }
    }, 30);
  };

  const selectNode = (id: string) => {
    setSingleSelectedId(id);
  };

  const preserveOutlineScroll = () => {
    const element = getOutlineScrollElement();
    const scrollTop = element?.scrollTop;
    if (!element || scrollTop === undefined) return () => {};

    const workspace = workspaceIdRef.current, request = treeRequestRef.current;
    const restore = () => {
      if (workspace === workspaceIdRef.current && request === treeRequestRef.current) element.scrollTop = scrollTop;
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
    beginCreation(tempId, parentId, position, title);
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

    const currentTitleSave = current && !current.id.startsWith("temp-") ? flushNodeDraft(current.id, "title") : Promise.resolve();
    const newState = insertNode(preppedState, parentId, tempNode, position);
    setFlatState(newState);
    setVisibleIds(computeVisibleIds(newState));
    flatStateRef.current = newState;
    setSingleSelectedId(tempId);
    editingNodeIdRef.current = tempId;
    focusWhenReady(tempId);
    pendingNodeCreateCountRef.current += 1;

    try {
      const createRequest = nodeCreateQueueRef.current.then(() => currentTitleSave).then(() =>
        apiPost<OutlineTreeNode>("/api/nodes", {
          id: tempId.slice(5),
          parentId: parentId.startsWith("temp-") ? parentId.slice(5) : parentId,
          title,
          position
        })
      );
      nodeCreateQueueRef.current = createRequest.then(() => undefined, () => undefined);
      const created = await createRequest;
      resolvedTempNodeIdsRef.current.set(tempId, created.id);
      loadOutlineHistory(workspaceIdRef.current).catch(toError(setError));
      if (cancelledTempIdsRef.current.has(tempId)) {
        cancelledTempIdsRef.current.delete(tempId);
        localNodeTitlesRef.current.delete(tempId);
        await apiDelete(`/api/nodes/${created.id}`);
        endCreation(tempId, true);
        loadOutlineHistory(workspaceIdRef.current).catch(toError(setError));
        return;
      }
      await nodeCompositionTracker.wait(tempId);
      if (cancelledTempIdsRef.current.has(tempId)) {
        cancelledTempIdsRef.current.delete(tempId);
        localNodeTitlesRef.current.delete(tempId);
        await apiDelete(`/api/nodes/${created.id}`);
        endCreation(tempId, true);
        loadOutlineHistory(workspaceIdRef.current).catch(toError(setError));
        return;
      }
      const draft = flatStateRef.current ? getNode(flatStateRef.current, tempId) : undefined;
      const durable = pendingCreation(tempId);
      const pendingTitle = localNodeTitlesRef.current.get(tempId) ?? durable?.title;
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
        body: durable?.body ?? draft?.body ?? created.body ?? "",
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
        await patchNode(created.id, {
          title: latestTitle,
          body: replacement.body,
          dueDate: replacement.dueDate,
          done: replacement.done,
          collapsed: replacement.collapsed
        });
      }
      endCreation(tempId, true);
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
      endCreation(tempId, false); // Leave an unacknowledged durable intent for recovery.
      pendingNodeCreateCountRef.current = Math.max(0, pendingNodeCreateCountRef.current - 1);
      if (pendingNodeCreateCountRef.current === 0) {
        for (const id of reconcilingNodeIdsRef.current) localNodeTitlesRef.current.delete(id);
        reconcilingNodeIdsRef.current.clear();
        for (const resolve of nodeCreateWaitersRef.current) resolve();
        nodeCreateWaitersRef.current.clear();
      }
    }
  };

  const recoverTreeMutation = (before: FlatTreeState, optimistic: FlatTreeState, workspace: string, request: number) => {
    const sameView = workspace === workspaceIdRef.current && request === treeRequestRef.current;
    const restored = sameView ? rollbackTreeMutation(before, optimistic, flatStateRef.current) : null;
    if (restored) {
      flatStateRef.current = restored;
      setFlatState(restored);
      setVisibleIds(computeVisibleIds(restored));
    }
    // The sync refresh waits for other writes and active editors, preserving their drafts.
    window.dispatchEvent(new Event("outliner-sync"));
    return Boolean(restored);
  };

  const deleteNodeOptimistically = async (node: FlatNodeData, action: PendingDelete["action"] = "delete") => {
    const before = flatStateRef.current;
    if (!before || node.id === before.rootId) return;
    const visibleBefore = computeVisibleIds(before);
    const selectedIds = getSelectedOutlineIds(node.id);
    const deletingIds = getTopLevelNodeIds(before, selectedIds);
    if (deletingIds.length === 0) return;
    if (deletingIds.some(id => id.startsWith("temp-")) && deletingIds.length > 1) {
      setError("Wait for new nodes to finish saving before deleting the selection.");
      return;
    }

    const currentWorkspaceId = workspaceIdRef.current;
    const request = treeRequestRef.current;
    const selectionBefore = new Set(selectedNodeIdsRef.current);
    const primaryBefore = selectedIdRef.current;
    const anchorBefore = selectionAnchorIdRef.current;
    const deletingIdSet = new Set(deletingIds);
    const firstDeleteIndex = visibleBefore.findIndex(id => deletingIdSet.has(id));
    const newState = removeNodes(before, deletingIds);
    const removedIds = Object.keys(before.nodes).filter(id => !newState.nodes[id]);
    const previousId = visibleBefore
      .slice(0, Math.max(0, firstDeleteIndex))
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
      stageCreation(deletingIds[0], { cancelled: true });
      cancelledTempIdsRef.current.add(deletingIds[0]);
      return;
    }

    const selectionAfter = selectionRevisionRef.current;
    pendingTreeMutationsRef.current += 1;
    try {
      await apiPost("/api/nodes/delete-batch", { ids: deletingIds });
      if (workspaceIdRef.current !== currentWorkspaceId || treeRequestRef.current !== request) return;
      loadOutlineHistory(currentWorkspaceId).catch(toError(setError));
      setPendingDelete({
        selectedIds,
        primaryId: selectedIds.includes(primaryBefore) ? primaryBefore : selectedIds[0],
        anchorId: selectedIds.includes(anchorBefore) ? anchorBefore : selectedIds[0],
        nodeCount: selectedIds.length,
        workspaceId: currentWorkspaceId,
        focusAfterDeleteId: previousId,
        createdAt: Date.now(),
        action
      });
    } catch (error) {
      const restored = recoverTreeMutation(before, newState, currentWorkspaceId, request);
      if (restored && selectionAfter === selectionRevisionRef.current) setNodeSelection(selectionBefore, primaryBefore, anchorBefore);
      throw error;
    } finally {
      pendingTreeMutationsRef.current -= 1;
    }
  };
  deleteSelectionRef.current = deleteNodeOptimistically;

  const showCopyNotice = useCallback(() => {
    window.clearTimeout(copyNoticeTimerRef.current);
    setCopyNotice(true);
    copyNoticeTimerRef.current = window.setTimeout(() => setCopyNotice(false), 2200);
  }, []);

  useEffect(() => () => window.clearTimeout(copyNoticeTimerRef.current), []);

  useEffect(() => {
    const handleCopy = (event: ClipboardEvent) => {
      const state = flatStateRef.current;
      const target = event.target;
      if (!state || !event.clipboardData || !shouldCopyNodes(
        selectedNodeIdsRef.current.size, multiSelectionKeyboardActiveRef.current,
        isEditableElement(document.activeElement) || (isEditableElement(target) && !isOutlineEditableElement(target)),
        event.defaultPrevented
      )) return;
      event.clipboardData.setData("text/plain", selectedNodeText(state, selectedNodeIdsRef.current));
      event.preventDefault();
      showCopyNotice();
    };
    window.addEventListener("copy", handleCopy);
    return () => window.removeEventListener("copy", handleCopy);
  }, [showCopyNotice]);

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
      if (pending.workspaceId === workspaceIdRef.current) focusNode(pending.focusAfterDeleteId);
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
    const currentWorkspaceId = workspaceIdRef.current, request = treeRequestRef.current;
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

    pendingTreeMutationsRef.current += 1;
    try {
      await apiPost(`/api/nodes/${currentSource.id}/move`, { parentId, position: nextPosition });
      if (currentWorkspaceId === workspaceIdRef.current && request === treeRequestRef.current) {
        loadOutlineHistory(currentWorkspaceId).catch(toError(setError));
      }
    } catch (error) {
      recoverTreeMutation(before, newState, currentWorkspaceId, request);
      throw error;
    } finally {
      pendingTreeMutationsRef.current -= 1;
      window.setTimeout(restoreScroll, 80);
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
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement && active.matches(".nodeTitle")) active.blur();
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
      if (next.size > 1) {
        const active = document.activeElement;
        if (active instanceof HTMLTextAreaElement && active.matches(".nodeTitle")) active.blur();
      }
      return false;
    }

    setSingleSelectedId(nodeId);
    return true;
  };

  const startNodeSelection = (node: FlatNodeData, event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.pointerType !== "mouse" || isTagFiltering) return;
    const target = event.target as HTMLElement;
    if (
      // Text editing and outline-row range selection are separate gestures.
      target.closest(".nodeTitleCell") ||
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
      if (pointerEvent.pointerType === "mouse" && !(pointerEvent.buttons & 1)) {
        end(pointerEvent);
        return;
      }
      const distance = Math.hypot(pointerEvent.clientX - current.startX, pointerEvent.clientY - current.startY);
      if (!current.moved && distance < 5) return;

      const targetElement = document
        .elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
        ?.closest<HTMLElement>("[data-node-id]");
      const targetId = targetElement?.dataset.nodeId;
      current.moved = true;
      pointerEvent.preventDefault();
      document.body.classList.add("isSelectingNodes");
      window.getSelection()?.removeAllRanges();
      if (!targetId || !filteredNodes.includes(targetId)) return;

      const range = getNodeSelectionRange(filteredNodes, current.anchorId, targetId);
      const next = current.additive ? new Set([...current.baseSelection, ...range]) : new Set(range);
      if (next.size > 1) {
        const active = document.activeElement;
        if (active instanceof HTMLTextAreaElement && active.matches(".nodeTitle")) active.blur();
      }
      setNodeSelection(next, targetId, current.anchorId);

      const surface = getOutlineScrollElement();
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
    if (isTagFiltering || isMovingToWorkspace || event.button !== 0) return;
    const currentState = flatStateRef.current;
    if (!currentState) return;
    const draggingIds = selectedNodeIdsRef.current.has(node.id)
      ? filteredNodes.filter(id => selectedNodeIdsRef.current.has(id))
      : [node.id];
    const movingIds = getTopLevelNodeIds(currentState, draggingIds);
    if (movingIds.length === 0) return;

    event.preventDefault();
    const dragHandle = event.currentTarget;
    const pointerId = event.pointerId;
    dragHandle.setPointerCapture(pointerId);
    let openedMobileSidebar = false;
    dragTargetRef.current = null;
    if (draggingIds.length > 1) {
      setNodeSelection(draggingIds, node.id, selectionAnchorIdRef.current || node.id);
    } else {
      setSingleSelectedId(node.id);
    }
    const title = draggingIds.length > 1
      ? `${draggingIds.length} nodes`
      : outlineTitleLabel(readNodeDraft(node.id, "title") ?? localNodeTitlesRef.current.get(node.id) ?? node.title);
    setDragState({ draggingIds, movingIds, title, x: event.clientX, y: event.clientY });
    document.body.classList.add("isDraggingNode");

    const move = (pointerEvent: globalThis.PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      if (compactLayout && !mobileSidebarOpen && pointerEvent.clientX <= 32) {
        openedMobileSidebar = true;
        setMobileSidebarOpen(true);
      }
      const nextDragState = {
        draggingIds,
        movingIds,
        title,
        x: pointerEvent.clientX,
        y: pointerEvent.clientY
      };
      const element = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY);
      const workspaceElement = element?.closest<HTMLElement>("[data-workspace-drop-id]");
      const targetWorkspaceId = workspaceElement?.dataset.workspaceDropId;
      if (targetWorkspaceId && targetWorkspaceId !== node.workspaceId
        && workspaces.some(workspace => workspace.id === targetWorkspaceId)) {
        dragTargetRef.current = { kind: "workspace", workspaceId: targetWorkspaceId };
        setDragState({ ...nextDragState, overWorkspaceId: targetWorkspaceId });
        return;
      }
      if (isSearching) {
        dragTargetRef.current = null;
        setDragState(nextDragState);
        return;
      }
      const targetElement = element?.closest<HTMLElement>("[data-node-id]");
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
      dragTargetRef.current = { kind: "node", overId: target.id, placement };
      setDragState({ ...nextDragState, overId: target.id, placement });
    };

    const cleanup = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", keydown);
      if (dragHandle.hasPointerCapture(pointerId)) dragHandle.releasePointerCapture(pointerId);
      if (openedMobileSidebar) setMobileSidebarOpen(false);
      finishNodeDrag();
    };
    const end = (pointerEvent: globalThis.PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      move(pointerEvent);
      const dropTarget = dragTargetRef.current;
      cleanup();
      if (dropTarget?.kind === "workspace") {
        moveOutlinesToWorkspace(movingIds, dropTarget.workspaceId, node.workspaceId).catch(toError(setError));
      } else if (dropTarget?.kind === "node") {
        const latestState = flatStateRef.current;
        const target = latestState ? getNode(latestState, dropTarget.overId) : undefined;
        if (target) moveNodesToTarget(movingIds, target, dropTarget.placement).catch(toError(setError));
      }
    };
    const cancel = (pointerEvent: globalThis.PointerEvent) => {
      if (pointerEvent.pointerId === pointerId) cleanup();
    };
    const keydown = (keyboardEvent: globalThis.KeyboardEvent) => {
      if (keyboardEvent.key !== "Escape") return;
      keyboardEvent.preventDefault();
      cleanup();
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", keydown);
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

    const currentWorkspaceId = workspaceIdRef.current, request = treeRequestRef.current;
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
    const selectionAfter = selectionRevisionRef.current;
    pendingTreeMutationsRef.current += 1;
    try {
      await apiPost("/api/nodes/move-batch", {
        ids: movingIds,
        parentId,
        position,
        expandParent: placement === "inside" && currentTarget.collapsed
      });
      if (currentWorkspaceId === workspaceIdRef.current && request === treeRequestRef.current) {
        loadOutlineHistory(currentWorkspaceId).catch(toError(setError));
        restoreScroll();
      }
    } catch (error) {
      const restored = recoverTreeMutation(before, newState, currentWorkspaceId, request);
      if (restored && selectionAfter === selectionRevisionRef.current) setNodeSelection(selectionBefore, primaryBefore, anchorBefore);
      throw error;
    } finally {
      pendingTreeMutationsRef.current -= 1;
      window.setTimeout(restoreScroll, 80);
    }
  };

  const selectWorkspace = useCallback((id: string) => {
    setMobileSidebarOpen(false);
    if (id === workspaceIdRef.current) return;
    setSearch("");
    pendingNodeRevealRef.current = null;
    workspaceIdRef.current = id;
    treeRequestRef.current += 1;
    tagsRequestRef.current += 1;
    tagResultsRequestRef.current += 1;
    systemTagGroupsRequestRef.current += 1;
    recycleBinRequestRef.current += 1;
    setWorkspaceId(id);
    setFlatState(null);
    setVisibleIds([]);
    setSingleSelectedId("");
    setTags([]);
    setActiveTagFilter("");
    setTagResults([]);
  }, [setSingleSelectedId]);

  const openOverdueNode = (node: OutlineNode) => {
    const nodeId = node.id;
    setSearch("");
    clearTagFilter();
    if (node.workspaceId !== workspaceIdRef.current) {
      selectWorkspace(node.workspaceId);
      pendingNodeRevealRef.current = { workspaceId: node.workspaceId, nodeId };
      return;
    }
    const current = flatStateRef.current;
    if (!current || !hasNode(current, nodeId)) return;
    const revealed = revealNodeInFlatTree(current, nodeId);
    setFlatState(revealed.state);
    setVisibleIds(revealed.visibleIds);
    flatStateRef.current = revealed.state;
    setSingleSelectedId(nodeId);
    window.setTimeout(() => {
      if (revealed.index >= 0) rowVirtualizer.scrollToIndex(revealed.index, { align: "center" });
      window.setTimeout(() => focusTitleInput(inputRefs.current.get(nodeId)), 30);
    }, 0);
  };

  const restoreRecycleBinEntry = async (entry: RecycleBinEntry) => {
    if (emptyingRecycleBin) return;
    setRestoringRecycleBinIds(current => new Set(current).add(entry.node.id));
    try {
      await apiPost<OutlineTreeNode>(`/api/nodes/${entry.node.id}/restore`, {});
      setRecycleBinEntries(current => current.filter(item => item.node.id !== entry.node.id));
    } finally {
      setRestoringRecycleBinIds(current => {
        const next = new Set(current);
        next.delete(entry.node.id);
        return next;
      });
    }
  };

  const emptyRecycleBin = async () => {
    if (emptyingRecycleBin || restoringRecycleBinIds.size || !recycleBinEntries.length) return;
    if (!window.confirm("Permanently delete all outlines in Recycle Bin, including their children, across all workspaces? This includes items hidden by search. This cannot be undone; undo history in affected workspaces will also be cleared.")) return;
    setEmptyingRecycleBin(true);
    recycleBinRequestRef.current += 1;
    try {
      await apiDelete<{ deletedCount: number }>("/api/recycle-bin");
      recycleBinRequestRef.current += 1;
      setRecycleBinEntries([]);
      setPendingDelete(null);
      await loadRecycleBin();
    } finally {
      setEmptyingRecycleBin(false);
    }
  };

  const runOutlineSelectionAction = async (clickedId: string, path: string, options = {}) => {
    const ids = getSelectedOutlineIds(clickedId);
    const currentWorkspaceId = workspaceIdRef.current;
    if (pendingNodeCreateCountRef.current > 0 && ids.some(id => id.startsWith("temp-"))) {
      await new Promise<void>(resolve => nodeCreateWaitersRef.current.add(resolve));
    }
    if (workspaceIdRef.current !== currentWorkspaceId) return;
    const persistedIds = ids.map(id => resolvedTempNodeIdsRef.current.get(id) ?? id);
    if (persistedIds.some(id => id.startsWith("temp-"))) throw new Error("An outline could not be saved. Select it again to retry.");
    pendingTreeMutationsRef.current += 1;
    try {
      await apiPost(path, { ...options, ids: persistedIds });
      if (workspaceIdRef.current !== currentWorkspaceId) return;
      await Promise.all([
        loadTree(currentWorkspaceId, { preserveSelection: true }),
        loadOutlineHistory(currentWorkspaceId)
      ]);
    } finally {
      pendingTreeMutationsRef.current -= 1;
    }
  };

  const translateOutline = async (id: string, source: string) => {
    const assertTitleUnchanged = () => {
      const current = flatStateRef.current?.nodes[id];
      if (!current || editingNodeIdRef.current === id || (readNodeDraft(id, "title") ?? current.title) !== source) {
        throw new Error("An outline changed during translation. Select it again to retry.");
      }
    };

    await flushNodeDraft(id, "title");
    assertTitleUnchanged();
    const { text, hasDivider } = splitOutlineTitle(source);
    const next = formatOutlineTitle(await requestEnglishTranslation(text), hasDivider);
    if (next === source) return;

    assertTitleUnchanged();
    beginNodeEdit(id, "title", source);
    stageNodeDraft(id, "title", next, source);
    await endNodeEdit(id, "title");
  };

  const translateSelectedOutlines = async (clickedId: string, clickedTitle: string) => {
    const state = flatStateRef.current;
    if (translatingRef.current || !state) return;
    const ids = getSelectedOutlineIds(clickedId);
    const titles = ids.flatMap(id => {
      const source = id === clickedId ? clickedTitle : readNodeDraft(id, "title") ?? state.nodes[id]?.title ?? "";
      return splitOutlineTitle(source).text.trim() ? [{ id, source }] : [];
    });
    if (!titles.length) return;

    translatingRef.current = true;
    setTranslationProgress("Translating into English…");
    try {
      if (pendingNodeCreateCountRef.current > 0 && titles.some(({ id }) => id.startsWith("temp-"))) {
        await new Promise<void>(resolve => nodeCreateWaitersRef.current.add(resolve));
      }
      const errors: unknown[] = [];
      for (const [index, { id, source }] of titles.entries()) {
        if (titles.length > 1) setTranslationProgress(`Translating outline ${index + 1} of ${titles.length} into English…`);
        try {
          await translateOutline(resolvedTempNodeIdsRef.current.get(id) ?? id, source);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        if (titles.length === 1) throw errors[0];
        const firstError = errors[0] instanceof Error ? errors[0].message : String(errors[0]);
        throw new Error(`Translation failed for ${errors.length} of ${titles.length} selected titles. ${firstError}`);
      }
    } finally {
      translatingRef.current = false;
      setTranslationProgress("");
    }
  };

  const expandWorkspace = (id: string) => {
    setCollapsedWorkspaceIds(current => {
      if (!current.has(id)) return current;
      const next = new Set(current);
      next.delete(id);
      return next;
    });
  };

  const createWorkspace = async (parentWorkspaceId: string | null) => {
    const created = await apiPost<Workspace>("/api/workspaces", {
      name: "Untitled Workspace",
      parentWorkspaceId
    });
    if (parentWorkspaceId !== null) expandWorkspace(parentWorkspaceId);
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
      if (created.parentWorkspaceId) expandWorkspace(created.parentWorkspaceId);
      await loadWorkspaces();
      selectWorkspace(created.id);
    } finally {
      setIsConvertingWorkspace(false);
    }
  };

  const moveOutlinesToWorkspace = async (ids: string[], targetWorkspaceId: string, sourceWorkspaceId: string) => {
    if (!ids.length || sourceWorkspaceId === targetWorkspaceId || isMovingToWorkspace) return;
    setIsMovingToWorkspace(true);
    try {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
      if (pendingNodeCreateCountRef.current > 0) {
        await new Promise<void>(resolve => nodeCreateWaitersRef.current.add(resolve));
      }
      await Promise.all([...nodePatchQueuesRef.current.values()]);
      const persistedIds = ids.map(id => resolvedTempNodeIdsRef.current.get(id) ?? id);
      if (persistedIds.some(id => id.startsWith("temp-"))) {
        throw new Error("The outline could not be saved. Please try moving it again.");
      }
      await apiPost("/api/nodes/move-to-workspace", {
        ids: persistedIds,
        workspaceId: targetWorkspaceId
      });
      if (workspaceIdRef.current === sourceWorkspaceId) {
        setSearch("");
        selectWorkspace(targetWorkspaceId);
        pendingNodeRevealRef.current = { workspaceId: targetWorkspaceId, nodeId: persistedIds[0] };
      }
    } finally {
      setIsMovingToWorkspace(false);
    }
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

  const moveWorkspace = async (workspace: Workspace, target: WorkspaceDragTarget) => {
    const { parentWorkspaceId, position } = target;
    await apiPatch<Workspace>(`/api/workspaces/${workspace.id}`, { parentWorkspaceId, position });
    if (target.placement === "inside" && parentWorkspaceId) expandWorkspace(parentWorkspaceId);
    await loadWorkspaces();
  };

  const startWorkspaceDrag = (workspace: Workspace, event: PointerEvent<HTMLButtonElement>) => {
    suppressWorkspaceIconClickRef.current = false;
    if (sidebarCompact || event.button !== 0) return;
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const { pointerId } = event;
    const startX = event.clientX;
    const startY = event.clientY;
    let isDragging = false;

    const move = (pointerEvent: globalThis.PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      if (!isDragging) {
        if (Math.hypot(pointerEvent.clientX - startX, pointerEvent.clientY - startY) < 5) return;
        isDragging = true;
        document.body.classList.add("isDraggingWorkspace");
      }
      const element = document.elementFromPoint(pointerEvent.clientX, pointerEvent.clientY);
      const workspaceElement = element?.closest<HTMLElement>("[data-workspace-drop-id]");
      const hovered = workspaces.find(item => item.id === workspaceElement?.dataset.workspaceDropId);
      let target: WorkspaceDragTarget | null = null;
      if (hovered && workspaceElement && hovered.id !== workspace.id) {
        const placement = getWorkspaceDropPlacement(workspaceElement, pointerEvent.clientY);
        const parentWorkspaceId = placement === "inside" ? hovered.id : hovered.parentWorkspaceId;
        if (parentWorkspaceId !== workspace.id &&
          !(parentWorkspaceId && isWorkspaceDescendant(workspaces, parentWorkspaceId, workspace.id))) {
          let position = Number.MAX_SAFE_INTEGER;
          if (placement !== "inside") {
            const siblings = workspacesByParent.get(parentWorkspaceId) ?? [];
            const index = siblings.filter(sibling => sibling.id !== workspace.id).indexOf(hovered);
            position = index + (placement === "after" ? 1 : 0);
          }
          target = { parentWorkspaceId, position, overWorkspaceId: hovered.id, placement };
        }
      } else if (!workspaceElement && element?.closest("[data-workspace-root-drop]")) {
        target = { parentWorkspaceId: null, position: Number.MAX_SAFE_INTEGER };
      }
      workspaceDragTargetRef.current = target;
      setWorkspaceDragTarget(target);
    };

    const end = (pointerEvent: globalThis.PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      const target = workspaceDragTargetRef.current;
      workspaceDragTargetRef.current = null;
      setWorkspaceDragTarget(null);
      document.body.classList.remove("isDraggingWorkspace");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (isDragging) {
        suppressWorkspaceIconClickRef.current = true;
        window.setTimeout(() => { suppressWorkspaceIconClickRef.current = false; }, 0);
      }
      if (isDragging && target && pointerEvent.type !== "pointercancel") {
        moveWorkspace(workspace, target).catch(toError(setError));
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const deleteWorkspace = async (workspace: Workspace) => {
    if (!window.confirm(`Delete workspace "${workspace.name}" and all its sub-workspaces? All outlines in these workspaces will be permanently deleted. This cannot be undone.`)) return;
    const selectedWorkspaceId = workspaceIdRef.current;
    const wasSelected = workspace.id === selectedWorkspaceId
      || isWorkspaceDescendant(workspaces, selectedWorkspaceId, workspace.id);
    if (wasSelected) {
      treeRequestRef.current += 1;
      tagsRequestRef.current += 1;
      tagResultsRequestRef.current += 1;
    }
    await apiDelete(`/api/workspaces/${workspace.id}`);
    if (wasSelected && workspaceIdRef.current === selectedWorkspaceId) {
      selectWorkspace(nextWorkspaceIdAfterDelete(workspaces, workspace.id));
      setError("");
    }
    await loadWorkspaces();
  };

  const addTag = async (nodeId: string, nextName: string) => {
    const name = nextName.trim().replace(/^#/, "");
    const node = flatStateRef.current ? getNode(flatStateRef.current, nodeId) : undefined;
    if (!node || !name) throw new Error("The outline is no longer available.");
    if (node.tags.some(tag => tag.name === name)) return;
    const startedWorkspaceId = node.workspaceId;
    const existingTag = tags.find(tag => tag.name === name && tag.workspaceId === startedWorkspaceId);
    const optimisticTag: Tag = existingTag ?? {
      id: `temp-tag-${crypto.randomUUID()}`, workspaceId: startedWorkspaceId,
      name, color: "#9ca3af", createdAt: new Date().toISOString()
    };
    let persistedNodeId = nodeId;
    setFlatState(current => {
      if (!current) return current;
      const next = addOptimisticNodeTag(current, nodeId, optimisticTag);
      flatStateRef.current = next;
      return next;
    });
    try {
      if (nodeId.startsWith("temp-")) {
        await nodeCreateQueueRef.current;
        persistedNodeId = resolvedTempNodeIdsRef.current.get(nodeId) ?? "";
        if (!persistedNodeId) throw new Error("The new outline could not be saved. Please try adding the tag again.");
      }
      const savedTag = await apiPost<Tag>(`/api/nodes/${persistedNodeId}/tags`, { name });
      if (workspaceIdRef.current !== startedWorkspaceId) return;
      setTags(current => [...current.filter(tag => tag.id !== savedTag.id), savedTag]);
      setFlatState(current => {
        if (!current) return current;
        const localId = hasNode(current, persistedNodeId) ? persistedNodeId : nodeId;
        const next = reconcileOptimisticNodeTag(current, localId, optimisticTag.id, savedTag);
        flatStateRef.current = next;
        return next;
      });
    } catch (error) {
      if (workspaceIdRef.current === startedWorkspaceId) {
        setFlatState(current => {
          if (!current) return current;
          const localId = hasNode(current, persistedNodeId) ? persistedNodeId : nodeId;
          const next = removeOptimisticNodeTag(current, localId, optimisticTag.id);
          flatStateRef.current = next;
          return next;
        });
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

  const renameSystemTag = async (previous: string, name: string) => {
    await apiPatch(`/api/system/tags/${encodeURIComponent(previous)}`, { name });
    setCollapsedSystemTags(current => {
      const next = new Set(current);
      if (next.delete(previous)) next.add(name.trim().replace(/^#/, ""));
      return next;
    });
    await Promise.all([loadTags(workspaceIdRef.current), loadSystemTagGroups()]);
  };

  const deleteSystemTag = async (name: string) => {
    if (!window.confirm(`Delete #${name} from all workspaces? Outline text will be kept.`)) return;
    await apiDelete(`/api/system/tags/${encodeURIComponent(name)}`);
    await Promise.all([loadTags(workspaceIdRef.current), loadSystemTagGroups()]);
  };

  const renderWorkspaceItem = (workspace: Workspace, depth = 0): React.ReactNode => {
    const children = workspacesByParent.get(workspace.id) ?? [];
    const isCollapsed = collapsedWorkspaceIds.has(workspace.id);

    return (
      <React.Fragment key={workspace.id}>
        <div
          className={[
            "workspaceItem",
            children.length > 0 && "hasChildren",
            workspace.id === workspaceId && "active",
            dragState?.overWorkspaceId === workspace.id && "outlineDropTarget",
            workspaceDragTarget?.overWorkspaceId === workspace.id &&
              workspaceDragTarget.placement &&
              `drop-${workspaceDragTarget.placement}`
          ]
            .filter(Boolean)
            .join(" ")}
          title={sidebarCompact ? workspace.name : undefined}
          data-workspace-drop-id={workspace.id}
          data-workspace-parent-id={workspace.parentWorkspaceId ?? ""}
          style={{ "--workspace-depth": depth } as CSSProperties}
          onClick={() => selectWorkspace(workspace.id)}
        >
          <button
            className="workspaceIcon workspaceDragHandle"
            type="button"
            title={children.length > 0
              ? `${isCollapsed ? "Expand" : "Collapse"} ${workspace.name}; drag to move`
              : `${workspace.name}; drag to move`}
            aria-label={children.length > 0
              ? `${isCollapsed ? "Expand" : "Collapse"} ${workspace.name}`
              : `Open ${workspace.name}`}
            aria-expanded={children.length > 0 ? !isCollapsed : undefined}
            onPointerDown={event => startWorkspaceDrag(workspace, event)}
            onClick={event => {
              event.stopPropagation();
              if (suppressWorkspaceIconClickRef.current) return;
              if (children.length > 0) {
                setCollapsedWorkspaceIds(current => nextCollapsedWorkspaceIds(current, workspace.id));
                if (sidebarCompact) selectWorkspace(workspace.id);
              } else {
                selectWorkspace(workspace.id);
              }
            }}
          >
            <WorkspaceTreeIcon hasChildren={children.length > 0} collapsed={isCollapsed} />
          </button>
          {!sidebarCompact && (
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
          {!sidebarCompact && (
            <button
              className="workspaceAddChildButton"
              type="button"
              title="New child workspace"
              onClick={event => {
                event.stopPropagation();
                createWorkspace(workspace.id).catch(toError(setError));
              }}
            >
              <Plus size={13} />
            </button>
          )}
          {!sidebarCompact && (
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
      className={`appShell${sidebarCompact ? " sidebarCollapsed" : ""}${mobileSidebarOpen ? " mobileSidebarOpen" : ""}`}
      style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}
      onPointerDownCapture={event => {
        if (!(event.target as HTMLElement).closest(".outlineList")) {
          multiSelectionKeyboardActiveRef.current = false;
        }
      }}
    >
      {mobileSidebarOpen && (
        <button className="sidebarBackdrop" type="button" aria-label="Close sidebar" onClick={() => setMobileSidebarOpen(false)} />
      )}
      <aside className="sidebar" id="workspace-sidebar" aria-label="Workspace navigation">
        <div className="sidebarHeader">
          <div className="brand">
            <span className="brandMark">
              <FolderTree size={18} />
            </span>
            {!sidebarCompact && <span>OpenOutliner</span>}
            <button
              className="collapseButton"
              type="button"
              onClick={() => mobileSidebarOpen ? setMobileSidebarOpen(false) : setSidebarCollapsed(collapsed => !collapsed)}
              title={mobileSidebarOpen ? "Close sidebar" : sidebarCompact ? "Expand sidebar" : "Collapse sidebar"}
            >
              {sidebarCompact ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
            </button>
          </div>
          {sidebarCompact && (
            <button
              className="sidebarCollapsedAdd"
              type="button"
              onClick={() => createWorkspace(null).catch(toError(setError))}
              title="New Workspace"
            >
              <Plus size={15} />
            </button>
          )}
        </div>

        {sidebarCompact ? (
          <button
            className="sidebarIconButton sidebarSearchToggle"
            type="button"
            title="Search"
            aria-label="Search"
            onClick={() => {
              setSidebarCollapsed(false);
              window.requestAnimationFrame(() => sidebarSearchRef.current?.focus());
            }}
          >
            <Search size={17} />
          </button>
        ) : (
          <div className="searchBox sidebarSearch">
            <Search size={16} aria-hidden="true" />
            <input
              ref={sidebarSearchRef}
              value={search}
              onChange={event => setSearch(event.target.value)}
              placeholder="Search"
              aria-label="Search"
            />
            {search && (
              <button className="searchClearButton" type="button" title="Clear search" aria-label="Clear search" onClick={() => setSearch("")}>
                <X size={14} />
              </button>
            )}
          </div>
        )}

        <div className="workspaceGroup">
          <button
            className={isTodayWorkspace ? "systemWorkspaceItem active" : "systemWorkspaceItem"}
            type="button"
            title="Today"
            aria-label="Today"
            onClick={() => {
              if (workspaces.some(workspace => workspace.id === TODAY_WORKSPACE_ID)) {
                selectWorkspace(TODAY_WORKSPACE_ID);
              } else {
                void apiPost<Workspace>("/api/system/today", {}).then(async () => {
                  await loadWorkspaces();
                  selectWorkspace(TODAY_WORKSPACE_ID);
                }).catch(toError(setError));
              }
            }}
          >
            <span className="workspaceIcon" aria-hidden="true"><Sun size={15} strokeWidth={2.2} /></span>
            {!sidebarCompact && <span className="systemWorkspaceLabel"><span>Today</span><small className="systemWorkspaceBadge">System</small></span>}
          </button>
          {(workspacesByParent.get(TODAY_WORKSPACE_ID) ?? []).map(workspace => renderWorkspaceItem(workspace, 1))}
          <button
            className={isCalendarWorkspace ? "systemWorkspaceItem active" : "systemWorkspaceItem"}
            type="button"
            title="Calendar"
            aria-label="Calendar"
            onClick={() => selectWorkspace(SYSTEM_CALENDAR_WORKSPACE_ID)}
          >
            <span className="workspaceIcon" aria-hidden="true"><CalendarDays size={15} strokeWidth={2.2} /></span>
            {!sidebarCompact && <span className="systemWorkspaceLabel"><span>Calendar</span><small className="systemWorkspaceBadge">System</small></span>}
          </button>
          <button
            className={isSystemTagsWorkspace ? "systemWorkspaceItem active" : "systemWorkspaceItem"}
            type="button"
            title={sidebarCompact ? "Tags" : "System workspace"}
            onClick={() => selectWorkspace(SYSTEM_TAGS_WORKSPACE_ID)}
          >
            <span className="workspaceIcon" aria-hidden="true">
              <TagsIcon size={15} strokeWidth={2.2} />
            </span>
            {!sidebarCompact && (
              <span className="systemWorkspaceLabel">
                <span>Tags</span>
                <small className="systemWorkspaceBadge">System</small>
              </span>
            )}
          </button>
          <button
            className={isRecycleBinWorkspace ? "systemWorkspaceItem active" : "systemWorkspaceItem"}
            type="button"
            title={sidebarCompact ? "Recycle Bin" : "Completed and deleted outlines"}
            onClick={() => selectWorkspace(SYSTEM_RECYCLE_BIN_WORKSPACE_ID)}
          >
            <span className="workspaceIcon" aria-hidden="true">
              <Trash2 size={15} strokeWidth={2.2} />
            </span>
            {!sidebarCompact && (
              <span className="systemWorkspaceLabel">
                <span>Recycle Bin</span>
                <small className={recycleBinEntries.length ? undefined : "systemWorkspaceBadge"}>{recycleBinEntries.length || "System"}</small>
              </span>
            )}
          </button>
          {!sidebarCompact && (
            <div className="sidebarLabel workspaceLabel">
              <span>Workspaces</span>
              <button type="button" title="New Workspace" aria-label="New Workspace" onClick={() => createWorkspace(null).catch(toError(setError))}>
                <Plus size={14} />
              </button>
            </div>
          )}
          <div
            className={workspaceDragTarget && !workspaceDragTarget.overWorkspaceId ? "workspaceRootDrop active" : "workspaceRootDrop"}
            data-workspace-root-drop
          >
            {(workspacesByParent.get(null) ?? []).map(workspace => renderWorkspaceItem(workspace))}
          </div>
        </div>
        <div className="sidebarFooter">
          <SyncPanel embedded compact={sidebarCompact} />
          <button
            className="sidebarIconButton"
            type="button"
            title="防窥：立即虚化"
            aria-label="立即虚化"
            onClick={activatePrivacyScreen}
          >
            <EyeOff size={17} />
          </button>
          <button
            className="sidebarIconButton"
            type="button"
            title="Markdown shortcuts"
            aria-label="Markdown shortcuts"
            onClick={() => {
              setMobileSidebarOpen(false);
              setIsMarkdownHelpOpen(true);
            }}
          >
            <CircleHelp size={17} />
          </button>
          <button
            className="sidebarIconButton themeToggle"
            type="button"
            title={`Theme: ${themeLabel(theme)}`}
            aria-label={`Theme: ${themeLabel(theme)}`}
            onClick={cycleTheme}
          >
            {theme === "light" ? <Sun size={17} /> : theme === "dark" ? <Moon size={17} /> : <Monitor size={17} />}
          </button>
          <span className="sidebarVersion" title={`OpenOutliner version ${appVersion}`}>v{appVersion}</span>
        </div>
        {!sidebarCompact && (
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
        <button
          className="sidebarIconButton mobileSidebarToggle"
          type="button"
          title="Open sidebar"
          aria-label="Open sidebar"
          aria-expanded={mobileSidebarOpen}
          aria-controls="workspace-sidebar"
          onClick={() => setMobileSidebarOpen(true)}
        >
          <PanelLeft size={18} />
        </button>
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

        {error && (
          <div className="errorBar">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")}>
              <Check size={16} />
            </button>
          </div>
        )}

        {(translationProgress || copyNotice) && (
          <div className={translationProgress ? "translationNotice" : "copyNotice"} role="status" aria-live="polite">
            {translationProgress ? <Languages size={16} /> : <Check size={16} />}
            <span>{translationProgress || "Copied to clipboard"}</span>
          </div>
        )}

        {pendingDelete && pendingDelete.workspaceId === workspaceId && outlineHistory.undoLabel === "Delete outline" && (
          <div className="undoBar" role="status" aria-live="polite">
            <span>{pendingDelete.action === "complete"
              ? pendingDelete.nodeCount === 1 ? "Completed outline" : `Completed ${pendingDelete.nodeCount} outlines`
              : pendingDelete.nodeCount === 1 ? "Deleted node" : `Deleted ${pendingDelete.nodeCount} nodes`}</span>
            <button type="button" onClick={() => undoPendingDelete().catch(toError(setError))}>
              <Undo2 size={15} />
              <span>Undo</span>
            </button>
          </div>
        )}

        {isCalendarWorkspace ? <Calendar workspaces={workspaces} search={search} onOpen={openOverdueNode} /> : <section
          className={isInspectorOpen && !isSystemTagsWorkspace && !isRecycleBinWorkspace ? "contentGrid" : "contentGrid commentsClosed"}
          ref={contentGridRef}
          style={{ "--inspector-width": `${inspectorWidth}px` } as CSSProperties}
        >
          <div className="outlineArtwork" aria-hidden="true" />
          <div className="outlineSurface" ref={outlineSurfaceRef} tabIndex={-1}
            onPointerDown={event => {
              if (event.target === event.currentTarget || event.target === virtualListRef.current
                || (event.target as HTMLElement).classList.contains("outlineList")) {
                event.currentTarget.focus({ preventScroll: true });
              }
            }}
            onKeyDownCapture={event => {
              if (isSystemTagsWorkspace || isRecycleBinWorkspace || isTagFiltering || !filteredNodes.length
                || !shouldHandleOutlineSelectAll(event, isEditableElement(event.target),
                  event.target instanceof HTMLElement && event.target.matches(".nodeTitle"))) return;
              event.preventDefault();
              event.stopPropagation();
              event.currentTarget.focus({ preventScroll: true });
              window.getSelection()?.removeAllRanges();
              const primaryId = filteredNodes.includes(selectedIdRef.current) ? selectedIdRef.current : filteredNodes[0];
              setNodeSelection(filteredNodes, primaryId, filteredNodes[0]);
            }}>
            <div className="outlineHeader">
              {isTodayWorkspace ? (
                <div className="systemWorkspaceTitle">
                  <div><Sun size={21} strokeWidth={2.2} /><h1>Today</h1></div>
                </div>
              ) : isRecycleBinWorkspace ? (
                <div className="systemWorkspaceTitle">
                  <div>
                    <Trash2 size={21} strokeWidth={2.2} />
                    <h1>Recycle Bin</h1>
                  </div>
                  <span>Completed and deleted outlines</span>
                </div>
              ) : isSystemTagsWorkspace ? (
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
              {isRecycleBinWorkspace && (
                <button
                  className="recycleBinEmpty"
                  type="button"
                  disabled={emptyingRecycleBin || restoringRecycleBinIds.size > 0 || recycleBinEntries.length === 0}
                  onClick={() => emptyRecycleBin().catch(toError(setError))}
                >
                  <Trash2 size={15} />
                  <span>{emptyingRecycleBin ? "Deleting…" : "Delete all"}</span>
                </button>
              )}
            </div>
            <div className={selectedNodeIds.size > 1 ? "outlineList hasMultiSelection" : "outlineList"}>
              {visibleItemCount > 0 ? (
                <div
                  className="virtualOutlineList"
                  ref={virtualListRef}
                  style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
                >
                  {virtualItems.map(virtualItem => {
                    if (isRecycleBinWorkspace) {
                      const entry = filteredRecycleBinEntries[virtualItem.index];
                      if (!entry) return null;
                      return (
                        <div
                          className="virtualOutlineRow"
                          data-index={virtualItem.index}
                          key={entry.node.id}
                          ref={rowVirtualizer.measureElement}
                          style={{ transform: `translateY(${virtualItem.start - listScrollMargin}px)` }}
                        >
                          <RecycleBinRow
                            entry={entry}
                            restoring={restoringRecycleBinIds.has(entry.node.id)}
                            disabled={emptyingRecycleBin}
                            onRestore={() => restoreRecycleBinEntry(entry).catch(toError(setError))}
                          />
                        </div>
                      );
                    }
                    if (isSystemTagsWorkspace) {
                      const row = systemTagRows[virtualItem.index];
                      if (!row) return null;
                      return (
                        <div
                          className="virtualOutlineRow"
                          data-index={virtualItem.index}
                          key={systemTagRowKey(row, virtualItem.index)}
                          ref={rowVirtualizer.measureElement}
                          style={{ transform: `translateY(${virtualItem.start - listScrollMargin}px)` }}
                        >
                          {row.kind === "tag" ? (
                            <SystemTagGroupRow
                              group={row.group}
                              onRename={name => renameSystemTag(row.group.name, name)}
                              onDelete={() => deleteSystemTag(row.group.name)}
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
                          ref={rowVirtualizer.measureElement}
                          style={{ transform: `translateY(${virtualItem.start - listScrollMargin}px)` }}
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
                        ref={rowVirtualizer.measureElement}
                        style={{ transform: `translateY(${virtualItem.start - listScrollMargin}px)` }}
                      >
                        <NodeRow
                          node={node}
                          depth={depth}
                          selected={selectedNodeIds.has(node.id)}
                          selectionPosition={selectionPosition}
                          active={selectedId === node.id}
                          canDrag={!isTagFiltering && !isMovingToWorkspace}
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
                          onContextSelect={() => {
                            if (!selectedNodeIdsRef.current.has(node.id)) setSingleSelectedId(node.id);
                          }}
                          onBlurFocus={() => {
                            if (editingNodeIdRef.current === node.id) editingNodeIdRef.current = "";
                          }}
                          onCompositionChange={isComposing => {
                            if (isComposing) nodeCompositionTracker.start(node.id);
                            else nodeCompositionTracker.finish(node.id);
                          }}
                          onSelectionStart={event => startNodeSelection(node, event)}
                          onTitleRangeSelect={targetId => {
                            if (!filteredNodes.includes(targetId)) return;
                            setNodeSelection(getNodeSelectionRange(filteredNodes, node.id, targetId), targetId, node.id);
                          }}
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
                              stageCreation(node.id, { title });
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
                          tagCatalog={tags}
                          onTagAdd={name => addTag(node.id, name)}
                          onTagError={toError(setError)}
                          onConvertToWorkspace={title => setConvertWorkspaceCandidate({ id: node.id, title })}
                          onSplitLines={() => runOutlineSelectionAction(node.id, "/api/nodes/split-lines")}
                          onSetDivider={enabled => runOutlineSelectionAction(node.id, "/api/nodes/dividers", { enabled })}
                          onTranslate={title => translateSelectedOutlines(node.id, title)}
                          selectionActions={selectedNodeIds.has(node.id) ? selectionActions : undefined}
                          isTranslating={Boolean(translationProgress)}
                          onCopy={async () => {
                            const state = flatStateRef.current;
                            if (!state) return;
                            const titles = getSelectedOutlineIds(node.id).flatMap(id => {
                              const outline = state.nodes[id];
                              return outline ? [readNodeDraft(id, "title") ?? outline.title] : [];
                            });
                            await navigator.clipboard.writeText(titles.join("\n"));
                            showCopyNotice();
                          }}
                          onComplete={() => deleteNodeOptimistically(node, "complete").catch(toError(setError))}
                          onDelete={() => deleteNodeOptimistically(node).catch(toError(setError))}
                        />
                      </div>
                    );
                  })}
                </div>
              ) : isRecycleBinWorkspace ? (
                <div className="outlineEmptyState">
                  {isSearching ? "No matching completed outlines" : "Recycle Bin is empty"}
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

          {isInspectorOpen && !isSystemTagsWorkspace && !isRecycleBinWorkspace && (
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
                      <NodeNotes key={selectedNode.id} node={selectedNode} onError={toError(setError)} onTemporaryChange={body => {
                        stageCreation(selectedNode.id, { body });
                        const current = flatStateRef.current;
                        if (!current) return;
                        const next = updateNode(current, selectedNode.id, { body });
                        flatStateRef.current = next;
                        setFlatState(next);
                      }} />
                    </div>
                  </div>
                </>
              ) : (
                <div className="emptyInspector">No node selected</div>
              )}
              <OverdueTasks nodes={overdueNodes} workspaces={workspaces} onOpen={openOverdueNode} />
            </aside>
          )}
          {!isInspectorOpen && !isSystemTagsWorkspace && !isRecycleBinWorkspace && (
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
        </section>}
      </main>
      {dragState && (
        <div
          className="dragPreview"
          style={{ transform: `translate3d(${dragState.x + 12}px, ${dragState.y + 12}px, 0)` }}
        >
          <span className="nodeDot" />
          <span>{dragState.title || "Untitled"}{outlineDropWorkspace ? ` → ${outlineDropWorkspace.name}` : ""}</span>
        </div>
      )}
    </div>
  );
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
    const node = next.nodes[id];
    if (!node || node.title === title) continue;
    if (next === state) next = { ...state, nodes: { ...state.nodes } };
    next.nodes[id] = { ...node, title };
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

function storeIdSet(key: string, values: ReadonlySet<string>, previousKey?: string) {
  try {
    window.localStorage.setItem(key, JSON.stringify([...values].sort()));
    if (previousKey) window.localStorage.removeItem(previousKey);
  } catch {
    // State persistence is optional when storage is unavailable.
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

export function nextWorkspaceIdAfterDelete(workspaces: Workspace[], deletedWorkspaceId: string): string {
  return workspaces.find(workspace =>
    workspace.id !== deletedWorkspaceId && !isWorkspaceDescendant(workspaces, workspace.id, deletedWorkspaceId)
  )?.id ?? "";
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
