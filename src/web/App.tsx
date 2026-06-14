import {
  Check,
  CircleHelp,
  CircleCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileDown,
  Folder,
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
  Upload,
  X
} from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import { useVirtualizer } from "@tanstack/react-virtual";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import {
  useCallback,
  useEffect,
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
  findTreeNode,
  hasNode,
  insertTreeNode,
  isDescendantNode,
  moveTreeNode,
  removeTreeNode,
  replaceTreeNode,
  updateTreeNode
} from "./treeOps";

interface FlatNode {
  node: OutlineTreeNode;
  depth: number;
}

interface LoadTreeOptions {
  preserveSelection?: boolean;
}

type DropPlacement = "before" | "inside" | "after";

interface DragState {
  draggingId: string;
  title: string;
  x: number;
  y: number;
  overId?: string;
  placement?: DropPlacement;
}

const iconNameSet = new Set<string>(iconNames);

export function App() {
  const { theme, setTheme } = useTheme();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [tree, setTree] = useState<OutlineTreeNode | null>(null);
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
  const [workspaceDragTargetId, setWorkspaceDragTargetId] = useState<string | null>(null);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const workspaceIdRef = useRef("");
  const treeRequestRef = useRef(0);
  const tagsRequestRef = useRef(0);
  const tagResultsRequestRef = useRef(0);
  const draggingIdRef = useRef("");
  const dragTargetRef = useRef<{ overId?: string; placement?: DropPlacement } | null>(null);
  const workspaceDragTargetRef = useRef<string | null>(null);
  const inputRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const outlineSurfaceRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<OutlineTreeNode | null>(null);
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
      setTree(null);
      setSelectedId("");
      return;
    }
    const next = await apiGet<OutlineTreeNode>(`/api/workspaces/${id}/tree`);
    if (requestId !== treeRequestRef.current || id !== workspaceIdRef.current) return;
    setTree(next);
    setSelectedId(current =>
      options.preserveSelection && current && hasNode(next, current) ? current : next.children[0]?.id || next.id
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
  }, [workspaceId]);

  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const closeInspectorForMobile = () => {
      if (media.matches) setIsInspectorOpen(false);
    };
    closeInspectorForMobile();
    media.addEventListener("change", closeInspectorForMobile);
    return () => media.removeEventListener("change", closeInspectorForMobile);
  }, []);

  const flatNodes = useMemo(() => (tree ? flatten(tree) : []), [tree]);
  const nodeMap = useMemo(() => {
    const map = new Map<string, OutlineTreeNode>();
    const visit = (node: OutlineTreeNode) => {
      map.set(node.id, node);
      node.children.forEach(visit);
    };
    if (tree) visit(tree);
    return map;
  }, [tree]);
  const selectedNode = selectedId ? nodeMap.get(selectedId) : undefined;
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
  const filteredNodes = isSearching
    ? flatNodes.filter(({ node }) => `${node.title}\n${node.body}`.toLowerCase().includes(search.toLowerCase()))
    : flatNodes;
  const filteredTagResults = isSearching
    ? tagResults.filter(result =>
        `${result.node.title}\n${result.node.body}\n${result.workspace.name}`.toLowerCase().includes(search.toLowerCase())
      )
    : tagResults;
  const visibleItemCount = isTagFiltering ? filteredTagResults.length : filteredNodes.length;
  const selectedIndex = selectedId
    ? isTagFiltering
      ? filteredTagResults.findIndex(result => result.node.id === selectedId)
      : filteredNodes.findIndex(({ node }) => node.id === selectedId)
    : -1;
  selectedIndexRef.current = selectedIndex;
  const rowVirtualizer = useVirtualizer({
    count: visibleItemCount,
    getScrollElement: () => outlineSurfaceRef.current,
    getItemKey: index =>
      isTagFiltering
        ? filteredTagResults[index]?.node.id ?? `tag-result-${index}`
        : filteredNodes[index]?.node.id ?? index,
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
    setTree(null);
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
    current?: OutlineTreeNode,
    title = "",
    currentTitle = current?.title
  ) => {
    if (!tree) return;
    const tempId = `temp-${crypto.randomUUID()}`;
    const before = tree;
    const tempNode: OutlineTreeNode = {
      id: tempId,
      workspaceId: tree.workspaceId,
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
      children: []
    };

    if (current && currentTitle !== undefined) patchNode(current.id, { title: currentTitle }).catch(toError(setError));
    setTree(insertTreeNode(before, parentId, tempNode, position));
    focusNode(tempId);

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
      const draft = treeRef.current ? findTreeNode(treeRef.current, tempId) : undefined;
      const replacement = draft
        ? {
            ...created,
            title: draft.title,
            body: draft.body,
            done: draft.done,
            collapsed: draft.collapsed,
            tags: draft.tags,
            fieldValues: draft.fieldValues
          }
        : created;
      setTree(currentTree => (currentTree ? replaceTreeNode(currentTree, tempId, replacement) : currentTree));
      focusNode(created.id);
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
      setTree(before);
      focusNode(current?.id ?? parentId);
      throw error;
    }
  };

  const deleteNodeOptimistically = async (node: OutlineTreeNode) => {
    if (!tree || node.id === tree.id) return;
    const before = tree;
    const previousId = flatNodes[flatNodes.findIndex(item => item.node.id === node.id) - 1]?.node.id ?? tree.id;
    setTree(removeTreeNode(before, node.id));
    focusNode(previousId);
    if (node.id.startsWith("temp-")) {
      cancelledTempIdsRef.current.add(node.id);
      return;
    }

    try {
      await apiDelete(`/api/nodes/${node.id}`);
    } catch (error) {
      setTree(before);
      focusNode(node.id);
      throw error;
    }
  };

  const moveNodeOptimistically = async (
    source: OutlineTreeNode,
    parentId: string,
    position: number
  ) => {
    if (!tree || source.id === parentId) return;
    const nextPosition = source.parentId === parentId && source.position < position ? position - 1 : position;
    if (source.parentId === parentId && source.position === nextPosition) return;
    const before = tree;
    const restoreScroll = preserveOutlineScroll();
    setTree(moveTreeNode(before, source.id, parentId, nextPosition));
    selectNode(source.id);
    restoreScroll();

    try {
      await apiPost(`/api/nodes/${source.id}/move`, { parentId, position: nextPosition });
    } catch (error) {
      setTree(before);
      focusNode(source.id);
      throw error;
    } finally {
      window.setTimeout(() => {
        restoreScroll();
      }, 80);
    }
  };

  const createAfter = async (current: OutlineTreeNode, title = "", currentTitle = current.title) => {
    if (!tree) return;
    const parentId = current.parentId ?? tree.id;
    await createOptimisticNode(parentId, current.position + 1, current, title, currentTitle);
  };

  const createFirstNode = async () => {
    if (!tree) return;
    await createOptimisticNode(tree.id, 0);
  };

  const indent = async (current: OutlineTreeNode) => {
    if (!tree) return;
    const index = flatNodes.findIndex(item => item.node.id === current.id);
    const previous = flatNodes[index - 1]?.node;
    if (!previous || previous.id === current.parentId) return;
    await moveNodeOptimistically(current, previous.id, previous.children.length);
  };

  const outdent = async (current: OutlineTreeNode) => {
    if (!tree || !current.parentId || current.parentId === tree.id) return;
    const parent = nodeMap.get(current.parentId);
    if (!parent?.parentId) return;
    await moveNodeOptimistically(current, parent.parentId, parent.position + 1);
  };

  const focusRelative = (current: OutlineTreeNode, offset: number) => {
    const index = flatNodes.findIndex(item => item.node.id === current.id);
    const next = flatNodes[index + offset]?.node;
    if (next) {
      setSelectedId(next.id);
      focusTitleInput(inputRefs.current.get(next.id));
    }
  };

  const cycleTheme = () => setTheme(nextTheme(theme));

  const startNodeDrag = (node: OutlineTreeNode, event: PointerEvent<HTMLButtonElement>) => {
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
      const target = targetId ? nodeMap.get(targetId) : undefined;

      if (!targetElement || !target || target.id === node.id || isDescendantNode(node, target.id)) {
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
      const target = dragTargetRef.current?.overId ? nodeMap.get(dragTargetRef.current.overId) : undefined;
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

  const moveNodeToTarget = async (source: OutlineTreeNode, target: OutlineTreeNode, placement: DropPlacement) => {
    if (!tree || source.id === target.id || isDescendantNode(source, target.id)) return;
    if (placement === "inside") {
      const restoreScroll = preserveOutlineScroll();
      try {
        if (target.collapsed) await patchNode(target.id, { collapsed: false });
        if (source.parentId === target.id && source.position === target.children.length - 1) return;
        await apiPost(`/api/nodes/${source.id}/move`, { parentId: target.id, position: target.children.length });
        await loadTree(workspaceId, { preserveSelection: true });
        selectNode(source.id);
        restoreScroll();
      } finally {
        window.setTimeout(() => {
          restoreScroll();
        }, 80);
      }
      return;
    }

    const parentId = target.parentId ?? tree.id;
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
    setTree(null);
    setSelectedId("");
    setTags([]);
    setActiveTagFilter("");
    setTagResults([]);
    setTagName("");
    setManagedTagName("");
  }, []);

  const createWorkspace = async () => {
    const created = await apiPost<Workspace>("/api/workspaces", {
      name: "Untitled Workspace",
      icon: randomWorkspaceIcon(),
      folderId: selectedWorkspace?.folderId ?? null
    });
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

  const moveWorkspaceToFolder = async (workspaceId: string, nextFolderId: string | null) => {
    const workspace = workspaces.find(item => item.id === workspaceId);
    if (!workspace || workspace.folderId === nextFolderId) return;
    setWorkspaces(current =>
      current.map(item => (item.id === workspace.id ? { ...item, folderId: nextFolderId } : item))
    );
    const updated = await apiPatch<Workspace>(`/api/workspaces/${workspace.id}`, { folderId: nextFolderId });
    setWorkspaces(current => current.map(item => (item.id === updated.id ? updated : item)));
  };

  const startWorkspaceDrag = (workspace: Workspace, event: PointerEvent<HTMLSpanElement>) => {
    if (sidebarCollapsed) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    workspaceDragTargetRef.current = workspace.folderId ?? "root";
    setWorkspaceDragTargetId(workspace.folderId ?? "root");
    document.body.classList.add("isDraggingWorkspace");

    const move = (pointerEvent: globalThis.PointerEvent) => {
      const targetElement = document
        .elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
        ?.closest<HTMLElement>("[data-workspace-folder-drop-id]");
      const targetId = targetElement?.dataset.workspaceFolderDropId ?? null;
      workspaceDragTargetRef.current = targetId;
      setWorkspaceDragTargetId(targetId);
    };

    const end = () => {
      const targetId = workspaceDragTargetRef.current;
      const nextFolderId = targetId === "root" ? null : targetId;
      workspaceDragTargetRef.current = null;
      setWorkspaceDragTargetId(null);
      document.body.classList.remove("isDraggingWorkspace");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      if (targetId !== null) moveWorkspaceToFolder(workspace.id, nextFolderId).catch(toError(setError));
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

  const deleteWorkspaceFolder = async (folder: WorkspaceFolder) => {
    if (!window.confirm(`Delete folder "${folder.name}"? Workspaces inside it will move to root.`)) return;
    await apiDelete(`/api/workspace-folders/${folder.id}`);
    setWorkspaceFolders(current => current.filter(item => item.id !== folder.id));
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
      setTree(null);
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
    link.download = `openoutliner.${extension}`;
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
      className={workspace.id === workspaceId ? "workspaceItem active" : "workspaceItem"}
      key={workspace.id}
      title={sidebarCollapsed ? workspace.name : undefined}
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
            <button className="commandButton" type="button" onClick={createWorkspace}>
              <Plus size={15} />
              <span>Workspace</span>
            </button>
          ) : (
            <button className="sidebarCollapsedAdd" type="button" onClick={createWorkspace} title="New Workspace">
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
                className={workspaceDragTargetId === "root" ? "workspaceRootDrop active" : "workspaceRootDrop"}
                data-workspace-folder-drop-id="root"
              >
                {rootWorkspaces.map(renderWorkspaceItem)}
              </div>
              {workspaceFolders.map(folder => (
                <div
                  className={workspaceDragTargetId === folder.id ? "workspaceFolder dropActive" : "workspaceFolder"}
                  key={folder.id}
                  data-workspace-folder-drop-id={folder.id}
                >
                  <div className="workspaceFolderHeader">
                    <Folder size={14} />
                    <input
                      value={folder.name}
                      onChange={event => updateWorkspaceFolderDraft(folder.id, event.target.value)}
                      onBlur={event => updateWorkspaceFolderName(folder, event.target.value).catch(toError(setError))}
                      onKeyDown={event => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                    <button
                      type="button"
                      title="Delete folder"
                      onClick={() => deleteWorkspaceFolder(folder).catch(toError(setError))}
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                  {(workspacesByFolder.get(folder.id) ?? []).map(renderWorkspaceItem)}
                  {(workspacesByFolder.get(folder.id) ?? []).length === 0 && (
                    <div className="workspaceFolderEmpty">Empty folder</div>
                  )}
                </div>
              ))}
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
          <button type="button" onClick={createWorkspace} title="New Workspace">
            <Plus size={16} />
          </button>
        </div>
        <header className="topbar">
          <div className="topbarTitle">
            <span>{isTagFiltering ? `#${activeTagFilter}` : selectedWorkspace?.name ?? "Workspace"}</span>
            <small>{isTagFiltering ? `${tagResults.length} results` : `${flatNodes.length} nodes`}</small>
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

        <section className={isInspectorOpen ? "contentGrid" : "contentGrid commentsClosed"}>
          <div className="outlineSurface" ref={outlineSurfaceRef}>
            <div className="outlineHeader">
              <h1>{isTagFiltering ? `#${activeTagFilter}` : tree?.title ?? "OpenOutliner"}</h1>
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

                    const item = filteredNodes[virtualItem.index];
                    if (!item) return null;
                    const { node, depth } = item;
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
                            setTree(current => (current ? updateTreeNode(current, node.id, patch) : current));
                          }}
                          onCommit={patch => patchNode(node.id, patch).catch(toError(setError))}
                          onToggle={patch => {
                            setTree(current => (current ? updateTreeNode(current, node.id, patch) : current));
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
              ) : flatNodes.length === 0 && tree ? (
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
                          setTree(current =>
                            current ? updateTreeNode(current, selectedNode.id, { body: event.target.value }) : current
                          )
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
  node: OutlineTreeNode;
  depth: number;
  selected: boolean;
  canDrag: boolean;
  dragging: boolean;
  dropPlacement: DropPlacement | null;
  registerInput: (element: HTMLTextAreaElement | null) => void;
  onSelect: () => void;
  onPatchLocal: (patch: Partial<OutlineTreeNode>) => void;
  onCommit: (patch: Partial<OutlineTreeNode>) => void;
  onToggle: (patch: Partial<OutlineTreeNode>) => void;
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
  const rowClassName = [
    "nodeRow",
    selected ? "selected" : "",
    node.done ? "completed" : "",
    dragging ? "dragging" : "",
    dropPlacement ? `drop-${dropPlacement}` : ""
  ]
    .filter(Boolean)
    .join(" ");
  useEffect(() => {
    const input = titleInputRef.current;
    if (!input) return;
    resizeTitleInput(input);
  }, [node.title]);

  return (
    <div
      className={rowClassName}
      data-node-id={node.id}
      style={{ "--depth": depth } as CSSProperties}
    >
      <button
        className="iconButton disclosureButton"
        type="button"
        title={node.collapsed ? "Expand" : "Collapse"}
        disabled={node.children.length === 0}
        onClick={() => onToggle({ collapsed: !node.collapsed })}
      >
        {node.children.length > 0 ? node.collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} /> : null}
      </button>
      <button
        className={node.done ? "dragHandle done" : "dragHandle"}
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
          value={node.title}
          placeholder="Untitled"
          rows={1}
          onFocus={() => {
            onSelect();
          }}
          onChange={event => {
            resizeTitleInput(event.currentTarget);
            onPatchLocal({ title: event.target.value });
          }}
          onBlur={event => onCommit({ title: event.target.value })}
          onKeyDown={event => {
            if (handleMarkdownShortcut(event, node.title, onPatchLocal)) return;
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              const input = event.currentTarget;
              const { currentTitle, nextTitle } = splitTitleAtSelection(input.value, input.selectionStart);
              input.value = currentTitle;
              onPatchLocal({ title: currentTitle });
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
            } else if (event.key === "Backspace" && !node.title) {
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
            if (openMarkdownLink(event)) return;
            onSelect();
            window.setTimeout(() => focusTitleInput(titleInputRef.current), 0);
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
      <div className="nodeTags">
        {node.tags.map(tag => (
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
        {result.tags.map(tag => (
          <button type="button" key={tag.id} onClick={() => onTagClick(tag)}>
            {tag.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function flatten(root: OutlineTreeNode): FlatNode[] {
  const output: FlatNode[] = [];
  const visit = (node: OutlineTreeNode, depth: number) => {
    for (const child of node.children) {
      output.push({ node: child, depth });
      if (!child.collapsed) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return output;
}

function getDropPlacement(element: HTMLElement, clientY: number): DropPlacement {
  const bounds = element.getBoundingClientRect();
  const offset = clientY - bounds.top;
  if (offset < bounds.height * 0.28) return "before";
  if (offset > bounds.height * 0.72) return "after";
  return "inside";
}

function handleMarkdownShortcut(
  event: KeyboardEvent<HTMLTextAreaElement>,
  title: string,
  onPatchLocal: (patch: Partial<OutlineTreeNode>) => void
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
  onPatchLocal: (patch: Partial<OutlineTreeNode>) => void
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

function workspaceIconName(icon: string): IconName {
  return iconNameSet.has(icon) ? (icon as IconName) : "folder-tree";
}

function toError(setError: (message: string) => void) {
  return (error: unknown) => {
    setError(error instanceof Error ? error.message : "Unexpected error");
  };
}
