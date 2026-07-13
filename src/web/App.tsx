import {
  Check,
  CircleHelp,
  CircleCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileDown,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Monitor,
  Moon,
  PanelRight,
  Plus,
  Search,
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
import rehypeSanitize from "rehype-sanitize";
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
  moveNodeInside,
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
  return childCount > 0 ? `${childCount} 个子项` : null;
}

interface LoadTreeOptions {
  preserveSelection?: boolean;
}

type DropPlacement = "before" | "inside" | "after";
type WorkspaceDropPlacement = "before" | "after";

interface WorkspaceDragTarget {
  folderId: string | null;
  position: number;
  markerId: string;
  overWorkspaceId?: string;
  placement?: WorkspaceDropPlacement;
}

interface DragState {
  draggingId: string;
  title: string;
  x: number;
  y: number;
  overId?: string;
  placement?: DropPlacement;
}

interface PendingDelete {
  nodeId: string;
  workspaceId: string;
  snapshot: FlatTreeState;
  focusAfterDeleteId: string;
  createdAt: number;
}

const iconNameSet = new Set<string>(iconNames);

export function App() {
  const { theme, setTheme } = useTheme();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [flatState, setFlatState] = useState<FlatTreeState | null>(null);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [tagName, setTagName] = useState("");
  const [managedTagName, setManagedTagName] = useState("");
  const [tags, setTags] = useState<Tag[]>([]);
  const [activeTagFilter, setActiveTagFilter] = useState("");
  const [tagResults, setTagResults] = useState<TaggedNodeResult[]>([]);
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isTagManagerOpen, setIsTagManagerOpen] = useState(false);
  const [isMarkdownHelpOpen, setIsMarkdownHelpOpen] = useState(false);
  const [workspaceDragTarget, setWorkspaceDragTarget] = useState<WorkspaceDragTarget | null>(null);
  const [collapsedWorkspaceFolderIds, setCollapsedWorkspaceFolderIds] = useState<Set<string>>(() => new Set());
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);
  const workspaceIdRef = useRef("");
  const treeRequestRef = useRef(0);
  const tagsRequestRef = useRef(0);
  const tagResultsRequestRef = useRef(0);
  const draggingIdRef = useRef("");
  const dragTargetRef = useRef<{ overId?: string; placement?: DropPlacement } | null>(null);
  const workspaceDragTargetRef = useRef<WorkspaceDragTarget | null>(null);
  const inputRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const outlineSurfaceRef = useRef<HTMLDivElement | null>(null);
  const flatStateRef = useRef<FlatTreeState | null>(null);
  const rowResizeObserversRef = useRef(new Map<string, ResizeObserver>());
  const selectedIndexRef = useRef(-1);
  const cancelledTempIdsRef = useRef(new Set<string>());

  const loadWorkspaces = useCallback(async () => {
    const next = await apiGet<Workspace[]>("/api/workspaces");
    setWorkspaces(next);
    setWorkspaceId(current => {
      const nextId = current && next.some(workspace => workspace.id === current) ? current : next[0]?.id || "";
      workspaceIdRef.current = nextId;
      return nextId;
    });
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
      setSelectedId("");
      return;
    }
    const next = await apiGet<OutlineTreeNode>(`/api/workspaces/${id}/tree`);
    if (requestId !== treeRequestRef.current || id !== workspaceIdRef.current) return;
    const { state, visibleIds: vids } = fromNestedTree(next);
    setFlatState(state);
    setVisibleIds(vids);
    flatStateRef.current = state;
    setSelectedId(current =>
      options.preserveSelection && current && hasNode(state, current) ? current : state.rootId
    );
  }, []);

  const loadTags = useCallback(async (id: string) => {
    const requestId = ++tagsRequestRef.current;
    if (!id) {
      setTags([]);
      return;
    }
    const next = await apiGet<Tag[]>(`/api/tags?workspaceId=${id}`);
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
  const rootWorkspaces = useMemo(() => workspaces.filter(workspace => !workspace.folderId), [workspaces]);
  const workspacesByFolder = useMemo(() => {
    const map = new Map<string, Workspace[]>();
    for (const folder of workspaceFolders) map.set(folder.id, []);
    for (const workspace of workspaces) {
      if (!workspace.folderId) continue;
      const folderWorkspaces = map.get(workspace.folderId);
      if (folderWorkspaces) folderWorkspaces.push(workspace);
    }
    return map;
  }, [workspaceFolders, workspaces]);
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
        setSelectedId(focusId);
        window.setTimeout(() => focusTitleInput(inputRefs.current.get(focusId)), 30);
      }
    },
    [loadTree, workspaceId]
  );

  const patchNode = async (id: string, patch: Partial<OutlineTreeNode>) => {
    if (id.startsWith("temp-")) return;
    await apiPatch(`/api/nodes/${id}`, patch);
  };

  const focusNode = (id: string) => {
    setSelectedId(id);
    window.setTimeout(() => focusTitleInput(inputRefs.current.get(id)), 30);
  };

  const selectNode = (id: string) => {
    setSelectedId(id);
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
    setSelectedId("");
    setTags([]);
    setTagName("");
    setManagedTagName("");
    await loadTree(result.workspace.id);
    await loadTags(result.workspace.id);
    setSelectedId(result.node.id);
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
    const originalState = currentFlatState;
    const preppedState =
      current && currentTitle !== undefined ? updateNode(currentFlatState, current.id, { title: currentTitle }) : currentFlatState;
    const tempNode: FlatNodeData = {
      id: tempId,
      workspaceId: currentFlatState.nodes[currentFlatState.rootId].workspaceId,
      parentId,
      position,
      title,
      body: "",
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
    setSelectedId(tempId);
    focusWhenReady(tempId);

    try {
      const created = await apiPost<OutlineTreeNode>("/api/nodes", {
        parentId,
        title,
        position
      });
      if (cancelledTempIdsRef.current.has(tempId)) {
        cancelledTempIdsRef.current.delete(tempId);
        apiDelete(`/api/nodes/${created.id}`).catch(toError(setError));
        return;
      }
      const draft = flatStateRef.current ? getNode(flatStateRef.current, tempId) : undefined;
      const draftParentId = draft?.parentId ?? parentId;
      const createdPosition = created.position ?? position;
      const draftPosition = draft?.position ?? createdPosition;
      const replacement: FlatNodeData = {
        id: created.id,
        workspaceId: created.workspaceId,
        parentId: draftParentId,
        position: draftPosition,
        title: draft?.title ?? created.title ?? "",
        body: draft?.body ?? created.body ?? "",
        done: draft?.done ?? created.done ?? false,
        collapsed: draft?.collapsed ?? created.collapsed ?? false,
        createdAt: created.createdAt ?? new Date().toISOString(),
        updatedAt: created.updatedAt ?? new Date().toISOString(),
        tags: draft?.tags ?? created.tags ?? [],
        fieldValues: draft?.fieldValues ?? created.fieldValues ?? [],
        childIds: draft?.childIds ?? [],
      };
      const currentRef = flatStateRef.current ?? newState;
      const withCreated = draft
        ? replaceNode(currentRef, tempId, replacement)
        : insertNode(removeNode(currentRef, tempId), parentId, replacement, position);
      // Batch: state + visible + selected in one shot
      setFlatState(withCreated);
      setVisibleIds(computeVisibleIds(withCreated));
      flatStateRef.current = withCreated;
      setSelectedId(created.id);
      focusWhenReady(created.id);
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
      if (draft && (draft.title || draft.body || draft.done || draft.collapsed)) {
        patchNode(created.id, {
          title: draft.title,
          body: draft.body,
          done: draft.done,
          collapsed: draft.collapsed
        }).catch(toError(setError));
      }
    } catch (error) {
      if (cancelledTempIdsRef.current.has(tempId)) {
        cancelledTempIdsRef.current.delete(tempId);
        return;
      }
      setFlatState(originalState);
      setVisibleIds(computeVisibleIds(originalState));
      flatStateRef.current = originalState;
      focusNode(current?.id ?? parentId);
      throw error;
    }
  };

  const deleteNodeOptimistically = async (node: FlatNodeData) => {
    if (!flatState || node.id === flatState.rootId) return;
    const before = flatState;
    const currentWorkspaceId = workspaceId;
    const prevIdx = visibleIds.indexOf(node.id);
    const previousId = prevIdx > 0 ? visibleIds[prevIdx - 1] : flatState.rootId;
    const newState = removeNode(before, node.id);
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
      setSelectedId(pending.nodeId);
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
      setSelectedId(nextId);
      focusTitleInput(inputRefs.current.get(nextId));
    }
  };

  const cycleTheme = () => setTheme(nextTheme(theme));

  const startNodeDrag = (node: FlatNodeData, event: PointerEvent<HTMLButtonElement>) => {
    if (isSearching || isTagFiltering) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    draggingIdRef.current = node.id;
    dragTargetRef.current = null;
    setSelectedId(node.id);
    setDragState({ draggingId: node.id, title: node.title, x: event.clientX, y: event.clientY });
    document.body.classList.add("isDraggingNode");

    const move = (pointerEvent: globalThis.PointerEvent) => {
      const nextDragState = {
        draggingId: node.id,
        title: node.title,
        x: pointerEvent.clientX,
        y: pointerEvent.clientY
      };
      const targetElement = document
        .elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
        ?.closest<HTMLElement>("[data-node-id]");
      const targetId = targetElement?.dataset.nodeId;
      const target = targetId && flatState ? getNode(flatState, targetId) : undefined;

      if (!flatState || !targetElement || !target || target.id === node.id || isDescendant(flatState, node.id, target.id)) {
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
      const target = dragTargetRef.current?.overId && flatState ? getNode(flatState, dragTargetRef.current.overId) : undefined;
      const placement = dragTargetRef.current?.placement;
      finishNodeDrag();
      if (target && placement) {
        moveNodeToTarget(node, target, placement).catch(toError(setError));
      }
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  const finishNodeDrag = () => {
    draggingIdRef.current = "";
    dragTargetRef.current = null;
    document.body.classList.remove("isDraggingNode");
    setDragState(null);
  };

  const moveNodeToTarget = async (source: FlatNodeData, target: FlatNodeData, placement: DropPlacement) => {
    if (!flatState || source.id === target.id || isDescendant(flatState, source.id, target.id)) return;
    if (placement === "inside") {
      const before = flatStateRef.current;
      if (!before) return;
      const currentSource = getNode(before, source.id);
      const currentTarget = getNode(before, target.id);
      if (!currentSource || !currentTarget || isDescendant(before, currentSource.id, currentTarget.id)) return;
      const restoreScroll = preserveOutlineScroll();
      const newState = moveNodeInside(before, currentSource.id, currentTarget.id);
      if (newState === before) return;
      setFlatState(newState);
      setVisibleIds(computeVisibleIds(newState));
      flatStateRef.current = newState;
      selectNode(currentSource.id);
      restoreScroll();
      const moveIncludesTempNode = currentSource.id.startsWith("temp-") || currentTarget.id.startsWith("temp-");

      try {
        if (currentTarget.collapsed) await patchNode(currentTarget.id, { collapsed: false });
        if (moveIncludesTempNode) return;
        await apiPost(`/api/nodes/${currentSource.id}/move`, {
          parentId: currentTarget.id,
          position: currentTarget.childIds.length
        });
        restoreScroll();
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
      return;
    }

    const parentId = target.parentId ?? flatState.rootId;
    const position = target.position + (placement === "after" ? 1 : 0);
    await moveNodeOptimistically(source, parentId, position);
  };

  const selectWorkspace = useCallback((id: string) => {
    if (id === workspaceIdRef.current) return;
    workspaceIdRef.current = id;
    treeRequestRef.current += 1;
    tagsRequestRef.current += 1;
    tagResultsRequestRef.current += 1;
    setWorkspaceId(id);
    setFlatState(null);
    setSelectedId("");
    setTags([]);
    setActiveTagFilter("");
    setTagResults([]);
    setTagName("");
    setManagedTagName("");
  }, []);

  const createWorkspace = async (folderId?: string | null) => {
    const created = await apiPost<Workspace>(
      "/api/workspaces",
      createWorkspaceRequestBody(selectedWorkspace, folderId)
    );
    await loadWorkspaces();
    selectWorkspace(created.id);
  };

  const createWorkspaceFolder = async () => {
    const created = await apiPost<WorkspaceFolder>("/api/workspace-folders", { name: "New Folder" });
    setWorkspaceFolders(current => [...current, created]);
  };

  const updateWorkspaceName = async (workspace: Workspace, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const updated = await apiPatch<Workspace>(`/api/workspaces/${workspace.id}`, { name: trimmed });
    setWorkspaces(current => current.map(item => (item.id === updated.id ? updated : item)));
    if (updated.id === workspaceIdRef.current) await loadTree(updated.id, { preserveSelection: true });
  };

  const updateWorkspaceDraft = (id: string, name: string) => {
    setWorkspaces(current => current.map(workspace => (workspace.id === id ? { ...workspace, name } : workspace)));
  };

  const moveWorkspaceOptimistically = async (workspace: Workspace, nextFolderId: string | null, position: number) => {
    const nextPosition =
      workspace.folderId === nextFolderId && workspace.position < position ? position - 1 : position;
    if (workspace.folderId === nextFolderId && workspace.position === nextPosition) return;
    const before = workspaces;
    setWorkspaces(current => reorderWorkspaces(current, workspace.id, nextFolderId, nextPosition));
    try {
      await apiPatch<Workspace>(`/api/workspaces/${workspace.id}`, {
        folderId: nextFolderId,
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
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    workspaceDragTargetRef.current = {
      folderId: workspace.folderId,
      markerId: workspace.folderId ?? "root",
      position: Number.MAX_SAFE_INTEGER
    };
    setWorkspaceDragTarget(workspaceDragTargetRef.current);
    document.body.classList.add("isDraggingWorkspace");

    const move = (pointerEvent: globalThis.PointerEvent) => {
      const workspaceElement = document
        .elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
        ?.closest<HTMLElement>("[data-workspace-drop-id]");
      if (workspaceElement && workspaceElement.dataset.workspaceDropId !== workspace.id) {
        const placement = getWorkspaceDropPlacement(workspaceElement, pointerEvent.clientY);
        const position = Number(workspaceElement.dataset.workspacePosition ?? "0") + (placement === "after" ? 1 : 0);
        workspaceDragTargetRef.current = {
          folderId: workspaceElement.dataset.workspaceFolderId || null,
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
      if (target) moveWorkspaceOptimistically(workspace, target.folderId, target.position).catch(toError(setError));
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
    await apiDelete(`/api/workspaces/${workspace.id}`);
    await loadWorkspaces();
    if (workspace.id === workspaceId) {
      treeRequestRef.current += 1;
      tagsRequestRef.current += 1;
      tagResultsRequestRef.current += 1;
      setFlatState(null);
      setSelectedId("");
      setTags([]);
      setActiveTagFilter("");
      setTagResults([]);
    }
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

  const renderWorkspaceItem = (workspace: Workspace) => (
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
      key={workspace.id}
      title={sidebarCollapsed ? workspace.name : undefined}
      data-workspace-drop-id={workspace.id}
      data-workspace-folder-id={workspace.folderId ?? ""}
      data-workspace-position={workspace.position}
      onClick={() => selectWorkspace(workspace.id)}
    >
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
  );

  return (
    <div className={`appShell${sidebarCollapsed ? " sidebarCollapsed" : ""}`}>
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
                {rootWorkspaces.map(renderWorkspaceItem)}
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
                    {!isCollapsed && folderWorkspaces.map(renderWorkspaceItem)}
                    {!isCollapsed && folderWorkspaces.length === 0 && (
                      <div className="workspaceFolderEmpty">Empty folder</div>
                    )}
                  </div>
                );
              })}
            </>
          ) : (
            workspaces.map(renderWorkspaceItem)
          )}
        </div>
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
          <div className="topbarTitle">
            <span>{isTagFiltering ? `#${activeTagFilter}` : selectedWorkspace?.name ?? "Workspace"}</span>
            <small>{isTagFiltering ? `${tagResults.length} results` : `${visibleIds.length} nodes`}</small>
          </div>
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

        <section className={isInspectorOpen ? "contentGrid" : "contentGrid commentsClosed"}>
          <div className="outlineSurface" ref={outlineSurfaceRef}>
            <div className="outlineHeader">
              <h1>{isTagFiltering ? `#${activeTagFilter}` : flatState ? getNode(flatState, flatState.rootId)?.title ?? "OpenOutliner" : "OpenOutliner"}</h1>
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
                          selected={selectedId === node.id}
                          canDrag={!isSearching && !isTagFiltering}
                          dragging={dragState?.draggingId === node.id}
                          dropPlacement={dragState?.overId === node.id ? dragState.placement ?? null : null}
                          registerInput={element => {
                            if (element) inputRefs.current.set(node.id, element);
                            else inputRefs.current.delete(node.id);
                          }}
                          onSelect={() => setSelectedId(node.id)}
                          onPatchLocal={patch => {
                            setFlatState(s => {
                              if (!s) return s;
                              const next = updateNode(s, node.id, patch);
                              flatStateRef.current = next;
                              return next;
                            });
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
  canDrag,
  dragging,
  dropPlacement,
  registerInput,
  onSelect,
  onPatchLocal,
  onCommit,
  onToggle,
  onCreateAfter,
  onIndent,
  onOutdent,
  onFocusPrevious,
  onFocusNext,
  onMoveStart,
  onTagClick,
  onDelete
}: {
  node: FlatNodeData;
  depth: number;
  selected: boolean;
  canDrag: boolean;
  dragging: boolean;
  dropPlacement: DropPlacement | null;
  registerInput: (element: HTMLTextAreaElement | null) => void;
  onSelect: () => void;
  onPatchLocal: (patch: Partial<FlatNodeData>) => void;
  onCommit: (patch: Partial<FlatNodeData>) => void;
  onToggle: (patch: Partial<FlatNodeData>) => void;
  onCreateAfter: (title?: string, currentTitle?: string) => void;
  onIndent: () => void;
  onOutdent: () => void;
  onFocusPrevious: () => void;
  onFocusNext: () => void;
  onMoveStart: (event: PointerEvent<HTMLButtonElement>) => void;
  onTagClick: (tag: Tag) => void;
  onDelete: () => Promise<void>;
}) {
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const [localTitle, setLocalTitle] = useState(node.title);
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
    onPatchLocal({ title });
  }, [onPatchLocal]);

  // Debounced sync during typing
  const syncTitleDebounced = useCallback((title: string) => {
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      onPatchLocal({ title });
      syncTimerRef.current = null;
    }, 300);
  }, [onPatchLocal]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    };
  }, []);

  const rowClassName = [
    "nodeRow",
    selected ? "selected" : "",
    node.done ? "completed" : "",
    node.collapsed && node.childIds.length > 0 ? "collapsedChildren" : "",
    dragging ? "dragging" : "",
    dropPlacement ? `drop-${dropPlacement}` : ""
  ]
    .filter(Boolean)
    .join(" ");
  const childCountLabel = getChildCountLabel(node.childIds.length);
  useEffect(() => {
    const input = titleInputRef.current;
    if (!input) return;
    resizeTitleInput(input);
  }, [localTitle]);

  return (
    <div
      className={rowClassName}
      data-node-id={node.id}
      style={{ "--depth": depth } as CSSProperties}
      onClick={event => {
        const target = event.target as HTMLElement;
        if (target.closest(".disclosureButton") || target.closest(".dragHandle") || target.closest(".iconButton.danger")) return;
        const input = titleInputRef.current;
        if (input) {
          onSelect();
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
            onSelect();
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
        <button
          className="nodeTitlePreview"
          type="button"
          tabIndex={-1}
          onClick={event => {
            event.stopPropagation();
            if (openMarkdownLink(event)) return;
            onSelect();
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
              allowedElements={["p", "strong", "em", "del", "code", "a", "br"]}
              rehypePlugins={[rehypeSanitize]}
              remarkPlugins={[remarkGfm]}
              unwrapDisallowed
              components={{
                a: ({ children, href }) => (
                  <span className="nodeTitleLink" data-href={href}>
                    {children}
                  </span>
                ),
                p: ({ children }) => <span>{children}</span>
              }}
            >
              {node.title}
            </ReactMarkdown>
          ) : (
            <span className="nodeTitlePlaceholder">Untitled</span>
          )}
        </button>
      </div>
      {childCountLabel ? <span className="nodeChildCount">{childCountLabel}</span> : null}
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
  return clientY - bounds.top < bounds.height / 2 ? "before" : "after";
}

function reorderWorkspaces(
  workspaces: Workspace[],
  workspaceId: string,
  folderId: string | null,
  position: number
): Workspace[] {
  const moving = workspaces.find(workspace => workspace.id === workspaceId);
  if (!moving) return workspaces;

  const withoutMoving = workspaces.filter(workspace => workspace.id !== workspaceId);
  const siblings = withoutMoving.filter(workspace => workspace.folderId === folderId);
  const nextPosition = Math.max(0, Math.min(position, siblings.length));
  const normalized = withoutMoving.map(workspace => {
    if (workspace.folderId === moving.folderId && workspace.position > moving.position) {
      return { ...workspace, position: workspace.position - 1 };
    }
    if (workspace.folderId === folderId && workspace.position >= nextPosition) {
      return { ...workspace, position: workspace.position + 1 };
    }
    return workspace;
  });

  normalized.push({ ...moving, folderId, position: nextPosition });
  return normalized.sort((a, b) => {
    const folderCompare = (a.folderId ?? "").localeCompare(b.folderId ?? "");
    if (folderCompare !== 0) return folderCompare;
    if (a.position !== b.position) return a.position - b.position;
    return a.createdAt.localeCompare(b.createdAt);
  });
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
      ? { before: "**", after: "**", placeholder: "bold" }
      : key === "i" && !event.shiftKey
        ? { before: "*", after: "*", placeholder: "italic" }
        : key === "e" && !event.shiftKey
          ? { before: "`", after: "`", placeholder: "code" }
          : key === "x" && (event.altKey || event.shiftKey)
            ? { before: "~~", after: "~~", placeholder: "strike" }
            : null;

  if (!shortcut) return false;

  event.preventDefault();
  const input = event.currentTarget;
  const start = input.selectionStart ?? title.length;
  const end = input.selectionEnd ?? start;
  const selected = title.slice(start, end) || shortcut.placeholder;
  const nextTitle = `${title.slice(0, start)}${shortcut.before}${selected}${shortcut.after}${title.slice(end)}`;

  onPatchLocal({ title: nextTitle });
  window.setTimeout(() => {
    const selectionStart = start + shortcut.before.length;
    const selectionEnd = selectionStart + selected.length;
    input.setSelectionRange(selectionStart, selectionEnd);
  }, 0);
  return true;
}

function openMarkdownLink(event: MouseEvent<HTMLButtonElement>): boolean {
  if (!event.ctrlKey && !event.metaKey) return false;

  const target = event.target instanceof HTMLElement ? event.target : null;
  const link = target?.closest<HTMLElement>(".nodeTitleLink");
  const href = link?.dataset.href?.trim();
  if (!href) return false;

  event.preventDefault();
  event.stopPropagation();
  window.open(normalizeLinkHref(href), "_blank", "noopener,noreferrer");
  return true;
}

function normalizeLinkHref(href: string): string {
  if (/^(?:[a-z][a-z\d+.-]*:|#)/i.test(href)) return href;
  return `https://${href}`;
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
  const selected = title.slice(start, end) || "link";
  const clipboardText = await readClipboardText();
  const href = clipboardText || "url";
  const before = "[";
  const after = `](${href})`;
  const nextTitle = `${title.slice(0, start)}${before}${selected}${after}${title.slice(end)}`;

  onPatchLocal({ title: nextTitle });
  window.setTimeout(() => {
    const selectionStart = start + before.length;
    const selectionEnd = selectionStart + selected.length;
    focusTitleInput(input);
    input.setSelectionRange(selectionStart, selectionEnd);
  }, 0);
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
  selectedWorkspace: Pick<Workspace, "folderId"> | null | undefined,
  folderId?: string | null
) {
  return {
    name: "Untitled Workspace",
    icon: randomWorkspaceIcon(),
    folderId: folderId !== undefined ? folderId : selectedWorkspace?.folderId ?? null
  };
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

function workspaceIconName(icon: string): IconName {
  return iconNameSet.has(icon) ? (icon as IconName) : "folder-tree";
}

function toError(setError: (message: string) => void) {
  return (error: unknown) => {
    setError(error instanceof Error ? error.message : "Unexpected error");
  };
}
