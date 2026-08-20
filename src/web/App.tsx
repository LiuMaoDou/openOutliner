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
  Link2,
  Monitor,
  Moon,
  PanelRight,
  Plus,
  Search,
  Strikethrough,
  Sun,
  Tag as TagIcon,
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
  type OutlineTreeNode,
  type Tag,
  type TaggedNodeResult,
  type Workspace,
  type WorkspaceFolder
} from "./api";
import { useTheme, type Theme } from "./theme";
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

interface MarkdownContextMenuState {
  x: number;
  y: number;
  selectionStart: number;
  selectionEnd: number;
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

interface PendingDelete {
  nodeId: string;
  workspaceId: string;
  snapshot: FlatTreeState;
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
const SIDEBAR_WIDTH_STORAGE_KEY = "openoutliner.sidebar-width";
const INSPECTOR_WIDTH_STORAGE_KEY = "openoutliner.inspector-width";

const iconNameSet = new Set<string>(iconNames);
const markdownSanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), "mark"]
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
  const [managedTagName, setManagedTagName] = useState("");
  const [tags, setTags] = useState<Tag[]>([]);
  const [activeTagFilter, setActiveTagFilter] = useState("");
  const [tagResults, setTagResults] = useState<TaggedNodeResult[]>([]);
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
  const dragTargetRef = useRef<{ overId?: string; placement?: DropPlacement } | null>(null);
  const workspaceDragTargetRef = useRef<WorkspaceDragTarget | null>(null);
  const selectedIdRef = useRef("");
  const selectedNodeIdsRef = useRef(new Set<string>());
  const selectionAnchorIdRef = useRef("");
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
    setSelectedNodeIds(next);
    setSelectedId(primaryId);
  }, []);

  const setSingleSelectedId = useCallback((id: string) => {
    setNodeSelection(id ? [id] : [], id);
  }, [setNodeSelection]);

  const loadWorkspaces = useCallback(async () => {
    const next = await apiGet<Workspace[]>("/api/workspaces");
    const currentId = workspaceIdRef.current;
    const nextId = currentId && next.some(workspace => workspace.id === currentId) ? currentId : next[0]?.id || "";
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
    if (!id) {
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
    const { state, visibleIds: vids } = fromNestedTree(next);
    setFlatState(state);
    setVisibleIds(vids);
    flatStateRef.current = state;
    const pendingFocusId = pendingWorkspaceFocusIdRef.current;
    const current = selectedIdRef.current;
    const nextSelectedId = pendingFocusId && hasNode(state, pendingFocusId)
      ? pendingFocusId
      : options.preserveSelection && current && hasNode(state, current)
        ? current
        : state.rootId;
    if (pendingFocusId === nextSelectedId) pendingWorkspaceFocusIdRef.current = "";
    setSingleSelectedId(nextSelectedId);
  }, [setSingleSelectedId]);

  const loadTags = useCallback(async (id: string) => {
    const requestId = ++tagsRequestRef.current;
    if (!id) {
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

  useEffect(() => {
    loadWorkspaces().catch(toError(setError));
  }, [loadWorkspaces]);

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
  const visibleItemCount = isTagFiltering ? filteredTagResults.length : filteredNodes.length;
  const selectedIndex = selectedId
    ? isTagFiltering
      ? filteredTagResults.findIndex(result => result.node.id === selectedId)
      : filteredNodes.findIndex(id => id === selectedId)
    : -1;
  selectedIndexRef.current = selectedIndex;
  const rowVirtualizer = useVirtualizer({
    count: visibleItemCount,
    getScrollElement: () => outlineSurfaceRef.current,
    getItemKey: index =>
      isTagFiltering
        ? filteredTagResults[index]?.node.id ?? `tag-result-${index}`
        : filteredNodes[index] ?? index,
    measureElement: element => Math.ceil(element.getBoundingClientRect().height),
    estimateSize: () => 38,
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

  const focusWhenReady = useCallback((nodeId: string, attempts = 0) => {
    const input = inputRefs.current.get(nodeId);
    if (input) {
      input.focus({ preventScroll: true });
      return;
    }
    if (attempts < 10) {
      window.requestAnimationFrame(() => focusWhenReady(nodeId, attempts + 1));
    }
  }, []);

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
      .then(() => undefined);
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
    workspaceIdRef.current = result.workspace.id;
    treeRequestRef.current += 1;
    tagsRequestRef.current += 1;
    setWorkspaceId(result.workspace.id);
    setFlatState(null);
    setSingleSelectedId("");
    setTags([]);
    setTagName("");
    setManagedTagName("");
    await loadTree(result.workspace.id);
    await loadTags(result.workspace.id);
    setSingleSelectedId(result.node.id);
    window.setTimeout(() => focusTitleInput(inputRefs.current.get(result.node.id)), 30);
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
      if (cancelledTempIdsRef.current.has(tempId)) {
        cancelledTempIdsRef.current.delete(tempId);
        localNodeTitlesRef.current.delete(tempId);
        apiDelete(`/api/nodes/${created.id}`).catch(toError(setError));
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
        if (tempWasPrimary || tempWasEditing) focusWhenReady(created.id);
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
        }).catch(toError(setError));
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
    if (!flatState || node.id === flatState.rootId) return;
    const before = flatState;
    const currentWorkspaceId = workspaceId;
    const prevIdx = visibleIds.indexOf(node.id);
    const previousId = prevIdx > 0 ? visibleIds[prevIdx - 1] : flatState.rootId;
    const newState = removeNode(before, node.id);
    localNodeTitlesRef.current.delete(node.id);
    reconcilingNodeIdsRef.current.delete(node.id);
    setFlatState(newState);
    setVisibleIds(computeVisibleIds(newState));
    flatStateRef.current = newState;
    focusNode(previousId);
    if (node.id.startsWith("temp-")) {
      cancelledTempIdsRef.current.add(node.id);
      return;
    }

    try {
      await apiDelete(`/api/nodes/${node.id}`);
      setPendingDelete({
        nodeId: node.id,
        workspaceId: currentWorkspaceId,
        snapshot: before,
        focusAfterDeleteId: previousId,
        createdAt: Date.now()
      });
    } catch (error) {
      setFlatState(before);
      setVisibleIds(computeVisibleIds(before));
      flatStateRef.current = before;
      focusNode(node.id);
      throw error;
    }
  };

  const undoPendingDelete = async () => {
    const pending = pendingDelete;
    if (!pending || pending.workspaceId !== workspaceIdRef.current) return;
    setPendingDelete(null);
    try {
      await apiPost<OutlineTreeNode>(`/api/nodes/${pending.nodeId}/restore`, {});
      setFlatState(pending.snapshot);
      setVisibleIds(computeVisibleIds(pending.snapshot));
      flatStateRef.current = pending.snapshot;
      setSingleSelectedId(pending.nodeId);
      focusWhenReady(pending.nodeId);
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

  const createFirstNode = async () => {
    if (!flatState) return;
    await createOptimisticNode(flatState.rootId, 0);
  };

  const indent = async (current: FlatNodeData) => {
    if (!flatState) return;
    const index = visibleIds.indexOf(current.id);
    const prevId = index > 0 ? visibleIds[index - 1] : undefined;
    if (!prevId || prevId === current.parentId) return;
    const previous = getNode(flatState, prevId);
    if (!previous) return;
    await moveNodeOptimistically(current, prevId, previous.childIds.length);
  };

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
    workspaceIdRef.current = id;
    treeRequestRef.current += 1;
    tagsRequestRef.current += 1;
    tagResultsRequestRef.current += 1;
    setWorkspaceId(id);
    setFlatState(null);
    setVisibleIds([]);
    setSingleSelectedId("");
    setTags([]);
    setActiveTagFilter("");
    setTagResults([]);
    setTagName("");
    setManagedTagName("");
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

  const addTag = async () => {
    if (!selectedNode || !tagName.trim()) return;
    await apiPost(`/api/nodes/${selectedNode.id}/tags`, { name: tagName.trim() });
    setTagName("");
    await loadTags(workspaceId);
    await refresh(selectedNode.id);
  };

  const createManagedTag = async () => {
    if (!workspaceId || !managedTagName.trim()) return;
    await apiPost<Tag>("/api/tags", { workspaceId, name: managedTagName.trim() });
    setManagedTagName("");
    await loadTags(workspaceId);
  };

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
            <DynamicIcon
              name={workspaceIconName(selectedWorkspace?.icon ?? "")}
              fallback={() => <FolderTree size={16} />}
              size={16}
              strokeWidth={2.2}
            />
          </span>
          <select
            aria-label="Workspace"
            value={workspaceId}
            onChange={event => selectWorkspace(event.target.value)}
          >
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

        {pendingDelete && pendingDelete.workspaceId === workspaceId && (
          <div className="undoBar" role="status" aria-live="polite">
            <span>Deleted node</span>
            <button type="button" onClick={() => undoPendingDelete().catch(toError(setError))}>
              <Undo2 size={15} />
              <span>Undo</span>
            </button>
          </div>
        )}

        <section
          className={isInspectorOpen ? "contentGrid" : "contentGrid commentsClosed"}
          ref={contentGridRef}
          style={{ "--inspector-width": `${inspectorWidth}px` } as CSSProperties}
        >
          <div className="outlineSurface" ref={outlineSurfaceRef}>
            <div className="outlineHeader">
              {isTagFiltering ? (
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
                          onIndent={() => indent(node).catch(toError(setError))}
                          onOutdent={() => outdent(node).catch(toError(setError))}
                          onFocusPrevious={() => focusRelative(node, -1)}
                          onFocusNext={() => focusRelative(node, 1)}
                          onMoveStart={event => startNodeDrag(node, event)}
                          onTagClick={tag => loadTagResults(tag.name).catch(toError(setError))}
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

          {isInspectorOpen && (
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
                    <div className="tagList">
                      {selectedNode.tags.map(tag => (
                        <button
                          className="tagPill"
                          type="button"
                          key={tag.id}
                          onClick={() => loadTagResults(tag.name).catch(toError(setError))}
                        >
                          #{tag.name}
                        </button>
                      ))}
                    </div>
                    <div className="tagInput">
                      <TagIcon size={15} />
                      <input
                        value={tagName}
                        onChange={event => setTagName(event.target.value)}
                        onKeyDown={event => {
                          if (shouldIgnoreTextInputKeyDown(event)) return;
                          if (event.key === "Enter") addTag().catch(toError(setError));
                        }}
                        placeholder="Tag"
                      />
                      <button type="button" onClick={() => addTag().catch(toError(setError))}>
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
                          <span>#</span>
                          <input
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
                    <div className="tagInput">
                      <TagIcon size={15} />
                      <input
                        value={managedTagName}
                        onChange={event => setManagedTagName(event.target.value)}
                        onKeyDown={event => {
                          if (shouldIgnoreTextInputKeyDown(event)) return;
                          if (event.key === "Enter") createManagedTag().catch(toError(setError));
                        }}
                        placeholder="New tag"
                      />
                      <button type="button" onClick={() => createManagedTag().catch(toError(setError))}>
                        <Plus size={15} />
                        <span>Add</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </aside>
          )}
          {!isInspectorOpen && (
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
  onSelectionStart,
  onPatchLocal,
  onCacheTitle,
  onCommit,
  onToggle,
  onCreateAfter,
  onIndent,
  onOutdent,
  onFocusPrevious,
  onFocusNext,
  onMoveStart,
  onTagClick,
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
  onSelectionStart: (event: PointerEvent<HTMLDivElement>) => void;
  onPatchLocal: (patch: Partial<FlatNodeData>) => void;
  onCacheTitle: (title: string) => void;
  onCommit: (patch: Partial<FlatNodeData>) => void;
  onToggle: (patch: Partial<FlatNodeData>) => void;
  onCreateAfter: (title?: string, currentTitle?: string) => void;
  onIndent: () => void;
  onOutdent: () => void;
  onFocusPrevious: () => void;
  onFocusNext: () => void;
  onMoveStart: (event: PointerEvent<HTMLButtonElement>) => void;
  onTagClick: (tag: Tag) => void;
  onConvertToWorkspace: (title: string) => void;
  onMoveToWorkspace: (title: string) => void;
  onDelete: () => Promise<void>;
}) {
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const dateInputRef = useRef<HTMLInputElement | null>(null);
  const markdownMenuRef = useRef<HTMLDivElement | null>(null);
  const nodeContextMenuRef = useRef<HTMLDivElement | null>(null);
  const [localTitle, setLocalTitle] = useState(node.title);
  const [markdownMenu, setMarkdownMenu] = useState<MarkdownContextMenuState | null>(null);
  const [nodeContextMenu, setNodeContextMenu] = useState<NodeContextMenuState | null>(null);
  const [linkHref, setLinkHref] = useState("");
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const applyMarkdownLinkFromMenu = () => {
    if (!markdownMenu || !linkHref.trim()) return;
    const result = applyMarkdownLink(
      localTitle,
      markdownMenu.selectionStart,
      markdownMenu.selectionEnd,
      linkHref.trim()
    );
    commitMarkdownEdit(result.value, result.selectionStart, result.selectionEnd, false);
  };

  const openMarkdownContextMenu = (input: HTMLTextAreaElement, clientX: number, clientY: number) => {
    const selectionStart = input.selectionStart ?? 0;
    const selectionEnd = input.selectionEnd ?? selectionStart;
    if (selectionStart === selectionEnd) return false;
    const menuWidth = 328;
    const menuHeight = 176;
    setLinkHref("");
    setMarkdownMenu({
      x: Math.max(12, Math.min(clientX, window.innerWidth - menuWidth - 12)),
      y: Math.max(12, Math.min(clientY, window.innerHeight - menuHeight - 12)),
      selectionStart,
      selectionEnd
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
        className="iconButton disclosureButton"
        type="button"
        title={node.collapsed ? "Expand" : "Collapse"}
        disabled={node.childIds.length === 0}
        onClick={() => onToggle({ collapsed: !node.collapsed })}
      >
        {node.childIds.length > 0 ? node.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} /> : null}
      </button>
      <button
        className={["dragHandle", node.done && "done", node.collapsed && node.childIds.length > 0 && "collapsed"].filter(Boolean).join(" ")}
        type="button"
        title={canDrag ? "Move node" : "Move disabled while searching"}
        aria-label="Move node"
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
          onChange={event => {
            const value = event.target.value;
            setLocalTitle(value);
            resizeTitleInput(event.currentTarget);
            syncTitleDebounced(value);
          }}
          onBlur={event => {
            flushTitle(event.target.value);
            onCommit({ title: event.target.value });
            onBlurFocus();
          }}
          onPointerDown={event => {
            if (event.button !== 2 || !openMarkdownContextMenu(event.currentTarget, event.clientX, event.clientY)) return;
            event.preventDefault();
            event.stopPropagation();
          }}
          onContextMenu={event => {
            if (!openMarkdownContextMenu(event.currentTarget, event.clientX, event.clientY)) return;
            event.preventDefault();
            event.stopPropagation();
          }}
          onKeyDown={event => {
            if (shouldIgnoreTextInputKeyDown(event)) return;
            if (handleMarkdownShortcut(event, localTitle, onPatchLocal)) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              const input = event.currentTarget;
              const { currentTitle, nextTitle } = splitTitleAtSelection(localTitle, input.selectionStart);
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
          onClick={event => {
            event.stopPropagation();
            if ((event.target as HTMLElement).closest(".nodeTitleLink")) return
            if (!onMouseSelect(event)) return;
            const input = titleInputRef.current;
            if (input) {
              const selectionStart = getPreviewSelectionStart(
                event.currentTarget,
                event.clientX,
                event.clientY,
                node.title
              );
              input.focus({ preventScroll: true });
              input.setSelectionRange(selectionStart, selectionStart);
            }
          }}
        >
          {node.title.trim() ? (
            <ReactMarkdown
              allowedElements={["p", "strong", "em", "del", "code", "a", "br", "mark"]}
              rehypePlugins={[rehypeHighlight, [rehypeSanitize, markdownSanitizeSchema]]}
              remarkPlugins={[remarkGfm]}
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
          ) : (
            <span className="nodeTitlePlaceholder">Untitled</span>
          )}
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
          <button type="button" key={tag.id} onClick={() => onTagClick(tag)}>
            {tag.name}
          </button>
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
            <button type="button" title="Bold · **text**" aria-label="Bold" onPointerDown={event => event.preventDefault()} onClick={() => applyMarkdownStyleFromMenu("bold")}>
              <Bold size={16} />
              <span>Bold</span>
            </button>
            <button type="button" title="Italic · *text*" aria-label="Italic" onPointerDown={event => event.preventDefault()} onClick={() => applyMarkdownStyleFromMenu("italic")}>
              <Italic size={16} />
              <span>Italic</span>
            </button>
            <button type="button" title="Strike · ~~text~~" aria-label="Strike" onPointerDown={event => event.preventDefault()} onClick={() => applyMarkdownStyleFromMenu("strike")}>
              <Strikethrough size={16} />
              <span>Strike</span>
            </button>
            <button type="button" title="Inline code · `text`" aria-label="Inline code" onPointerDown={event => event.preventDefault()} onClick={() => applyMarkdownStyleFromMenu("code")}>
              <Code2 size={16} />
              <span>Code</span>
            </button>
            <button type="button" title="Highlight · ==text==" aria-label="Highlight" onPointerDown={event => event.preventDefault()} onClick={() => applyMarkdownStyleFromMenu("highlight")}>
              <Highlighter size={16} />
              <span>Highlight</span>
            </button>
          </div>
          <form
            className="markdownLinkForm"
            onSubmit={event => {
              event.preventDefault();
              applyMarkdownLinkFromMenu();
            }}
          >
            <Link2 size={15} />
            <input
              aria-label="Link URL"
              value={linkHref}
              placeholder="https://example.com"
              onChange={event => setLinkHref(event.target.value)}
              onContextMenu={event => event.stopPropagation()}
            />
            <button type="submit" disabled={!linkHref.trim()}>Link</button>
          </form>
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

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function rehypeHighlight() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      if (!node.children || node.tagName === "code" || node.tagName === "pre") return;
      const children: HastNode[] = [];
      for (const child of node.children) {
        if (child.type === "text" && child.value?.includes("==")) {
          children.push(...splitMarkdownHighlights(child.value).map(part => part.highlighted
            ? { type: "element", tagName: "mark", properties: {}, children: [{ type: "text", value: part.value }] }
            : { type: "text", value: part.value }
          ));
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

function focusTitleInput(input?: HTMLTextAreaElement | null) {
  input?.focus({ preventScroll: true });
}

export function splitTitleAtSelection(title: string, selectionStart?: number | null) {
  const splitIndex = Math.max(0, Math.min(selectionStart ?? title.length, title.length));
  return {
    currentTitle: title.slice(0, splitIndex),
    nextTitle: title.slice(splitIndex)
  };
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

function toError(setError: (message: string) => void) {
  return (error: unknown) => {
    setError(error instanceof Error ? error.message : "Unexpected error");
  };
}
