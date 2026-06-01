import {
  Check,
  CircleCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileDown,
  FolderTree,
  GripVertical,
  Monitor,
  Moon,
  PanelRight,
  Plus,
  Search,
  Sun,
  Tag as TagIcon,
  Trash2,
  Upload
} from "lucide-react";
import { DynamicIcon, iconNames, type IconName } from "lucide-react/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiText,
  type OutlineTreeNode,
  type Tag,
  type Workspace
} from "./api";
import { useTheme, type Theme } from "./theme";

interface FlatNode {
  node: OutlineTreeNode;
  depth: number;
}

interface LoadTreeOptions {
  preserveSelection?: boolean;
}

type DropPlacement = "before" | "after";

interface DragState {
  draggingId: string;
  overId?: string;
  placement?: DropPlacement;
}

const iconNameSet = new Set<string>(iconNames);

export function App() {
  const { theme, setTheme } = useTheme();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [tree, setTree] = useState<OutlineTreeNode | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [tagName, setTagName] = useState("");
  const [managedTagName, setManagedTagName] = useState("");
  const [tags, setTags] = useState<Tag[]>([]);
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [isTagManagerOpen, setIsTagManagerOpen] = useState(false);
  const [dragState, setDragState] = useState<DragState | null>(null);
  const workspaceIdRef = useRef("");
  const treeRequestRef = useRef(0);
  const tagsRequestRef = useRef(0);
  const draggingIdRef = useRef("");
  const dragTargetRef = useRef<{ overId?: string; placement?: DropPlacement } | null>(null);
  const inputRefs = useRef(new Map<string, HTMLInputElement>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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

  useEffect(() => {
    loadWorkspaces().catch(toError(setError));
  }, [loadWorkspaces]);

  useEffect(() => {
    loadTree(workspaceId).catch(toError(setError));
  }, [loadTree, workspaceId]);

  useEffect(() => {
    loadTags(workspaceId).catch(toError(setError));
  }, [loadTags, workspaceId]);

  useEffect(() => {
    setIsTagManagerOpen(false);
  }, [workspaceId]);

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
  const isSearching = search.trim().length > 0;
  const filteredNodes = isSearching
    ? flatNodes.filter(({ node }) => `${node.title}\n${node.body}`.toLowerCase().includes(search.toLowerCase()))
    : flatNodes;

  const refresh = useCallback(
    async (focusId?: string) => {
      await loadTree(workspaceId, { preserveSelection: true });
      if (focusId) {
        setSelectedId(focusId);
        window.setTimeout(() => inputRefs.current.get(focusId)?.focus(), 30);
      }
    },
    [loadTree, workspaceId]
  );

  const patchNode = async (id: string, patch: Partial<OutlineTreeNode>) => {
    await apiPatch(`/api/nodes/${id}`, patch);
  };

  const createAfter = async (current: OutlineTreeNode) => {
    await patchNode(current.id, { title: current.title });
    const created = await apiPost<OutlineTreeNode>("/api/nodes", {
      parentId: current.parentId ?? tree?.id,
      title: "",
      position: current.position + 1
    });
    await refresh(created.id);
  };

  const createFirstNode = async () => {
    if (!tree) return;
    const created = await apiPost<OutlineTreeNode>("/api/nodes", {
      parentId: tree.id,
      title: "",
      position: 0
    });
    await refresh(created.id);
  };

  const indent = async (current: OutlineTreeNode) => {
    const index = flatNodes.findIndex(item => item.node.id === current.id);
    const previous = flatNodes[index - 1]?.node;
    if (!previous || previous.id === current.parentId) return;
    await apiPost(`/api/nodes/${current.id}/move`, {
      parentId: previous.id,
      position: previous.children.length
    });
    await refresh(current.id);
  };

  const outdent = async (current: OutlineTreeNode) => {
    if (!tree || !current.parentId || current.parentId === tree.id) return;
    const parent = nodeMap.get(current.parentId);
    if (!parent?.parentId) return;
    await apiPost(`/api/nodes/${current.id}/move`, {
      parentId: parent.parentId,
      position: parent.position + 1
    });
    await refresh(current.id);
  };

  const focusRelative = (current: OutlineTreeNode, offset: number) => {
    const index = flatNodes.findIndex(item => item.node.id === current.id);
    const next = flatNodes[index + offset]?.node;
    if (next) {
      setSelectedId(next.id);
      inputRefs.current.get(next.id)?.focus();
    }
  };

  const cycleTheme = () => setTheme(nextTheme(theme));

  const startNodeDrag = (node: OutlineTreeNode, event: PointerEvent<HTMLButtonElement>) => {
    if (isSearching) return;
    event.preventDefault();
    draggingIdRef.current = node.id;
    dragTargetRef.current = null;
    setSelectedId(node.id);
    setDragState({ draggingId: node.id });
    document.body.classList.add("isDraggingNode");

    const move = (pointerEvent: globalThis.PointerEvent) => {
      const targetElement = document
        .elementFromPoint(pointerEvent.clientX, pointerEvent.clientY)
        ?.closest<HTMLElement>("[data-node-id]");
      const targetId = targetElement?.dataset.nodeId;
      const target = targetId ? nodeMap.get(targetId) : undefined;

      if (!targetElement || !target || target.id === node.id || isDescendantNode(node, target.id)) {
        dragTargetRef.current = null;
        setDragState({ draggingId: node.id });
        return;
      }

      const placement = getDropPlacement(targetElement, pointerEvent.clientY);
      dragTargetRef.current = { overId: target.id, placement };
      setDragState(current =>
        current?.draggingId === node.id && current.overId === target.id && current.placement === placement
          ? current
          : { draggingId: node.id, overId: target.id, placement }
      );
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
    const parentId = target.parentId ?? tree.id;
    let position = target.position + (placement === "after" ? 1 : 0);
    if (source.parentId === parentId && source.position < position) position -= 1;
    if (source.parentId === parentId && source.position === position) return;
    await apiPost(`/api/nodes/${source.id}/move`, { parentId, position });
    await refresh(source.id);
  };

  const selectWorkspace = useCallback((id: string) => {
    if (id === workspaceIdRef.current) return;
    workspaceIdRef.current = id;
    treeRequestRef.current += 1;
    tagsRequestRef.current += 1;
    setWorkspaceId(id);
    setTree(null);
    setSelectedId("");
    setTags([]);
    setTagName("");
    setManagedTagName("");
  }, []);

  const createWorkspace = async () => {
    const created = await apiPost<Workspace>("/api/workspaces", {
      name: "Untitled Workspace",
      icon: randomWorkspaceIcon()
    });
    await loadWorkspaces();
    selectWorkspace(created.id);
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

  const deleteWorkspace = async (workspace: Workspace) => {
    if (!window.confirm(`Delete workspace "${workspace.name}"?`)) return;
    await apiDelete(`/api/workspaces/${workspace.id}`);
    await loadWorkspaces();
    if (workspace.id === workspaceId) {
      treeRequestRef.current += 1;
      tagsRequestRef.current += 1;
      setTree(null);
      setSelectedId("");
      setTags([]);
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
    if (!workspaceId) return;
    const extension = format === "markdown" ? "md" : "opml";
    const content = await apiText(`/api/export/${format}?workspaceId=${workspaceId}`);
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
    const result = await apiPost<{ workspaceId?: string }>(`/api/import/${format}`, {
      ...(workspaceId ? { workspaceId } : {}),
      content
    });
    if (result.workspaceId && result.workspaceId !== workspaceIdRef.current) {
      await loadWorkspaces();
      selectWorkspace(result.workspaceId);
      await loadTree(result.workspaceId);
      await loadTags(result.workspaceId);
      return;
    }
    await refresh();
  };

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
          <div className="sidebarLabel">{sidebarCollapsed ? "" : "Workspaces"}</div>
          {workspaces.map(workspace => (
            <div
              className={workspace.id === workspaceId ? "workspaceItem active" : "workspaceItem"}
              key={workspace.id}
              title={sidebarCollapsed ? workspace.name : undefined}
              onClick={() => selectWorkspace(workspace.id)}
            >
              <span className="workspaceIcon">
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
          ))}
        </div>
      </aside>

      <main className="mainPane">
        <header className="topbar">
          <div className="topbarTitle">
            <span>{selectedWorkspace?.name ?? "Workspace"}</span>
            <small>{flatNodes.length} nodes</small>
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
            <button title="Export Markdown" type="button" onClick={() => exportFile("markdown").catch(toError(setError))}>
              <FileDown size={17} />
              <span>MD</span>
            </button>
            <button title="Export OPML" type="button" onClick={() => exportFile("opml").catch(toError(setError))}>
              <FileDown size={17} />
              <span>OPML</span>
            </button>
          </div>
        </header>

        {error && (
          <div className="errorBar">
            <span>{error}</span>
            <button type="button" onClick={() => setError("")}>
              <Check size={16} />
            </button>
          </div>
        )}

        <section className={isInspectorOpen ? "contentGrid" : "contentGrid commentsClosed"}>
          <div className="outlineSurface">
            <div className="outlineHeader">
              <h1>{tree?.title ?? "OpenOutliner"}</h1>
            </div>
            <div className="outlineList">
              {filteredNodes.length > 0 ? (
                filteredNodes.map(({ node, depth }) => (
                  <NodeRow
                    key={node.id}
                    node={node}
                    depth={depth}
                    selected={selectedId === node.id}
                    canDrag={!isSearching}
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
                    onCreateAfter={() => createAfter(node).catch(toError(setError))}
                    onIndent={() => indent(node).catch(toError(setError))}
                    onOutdent={() => outdent(node).catch(toError(setError))}
                    onFocusPrevious={() => focusRelative(node, -1)}
                    onFocusNext={() => focusRelative(node, 1)}
                    onMoveStart={event => startNodeDrag(node, event)}
                    onDelete={async () => {
                      await apiDelete(`/api/nodes/${node.id}`);
                      await refresh(flatNodes[flatNodes.findIndex(item => item.node.id === node.id) - 1]?.node.id);
                    }}
                  />
                ))
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
                <div className="outlineEmptyState">No matching nodes</div>
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
                        <span className="tagPill" key={tag.id}>
                          #{tag.name}
                        </span>
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
  onDelete
}: {
  node: OutlineTreeNode;
  depth: number;
  selected: boolean;
  canDrag: boolean;
  dragging: boolean;
  dropPlacement: DropPlacement | null;
  registerInput: (element: HTMLInputElement | null) => void;
  onSelect: () => void;
  onPatchLocal: (patch: Partial<OutlineTreeNode>) => void;
  onCommit: (patch: Partial<OutlineTreeNode>) => void;
  onToggle: (patch: Partial<OutlineTreeNode>) => void;
  onCreateAfter: () => void;
  onIndent: () => void;
  onOutdent: () => void;
  onFocusPrevious: () => void;
  onFocusNext: () => void;
  onMoveStart: (event: PointerEvent<HTMLButtonElement>) => void;
  onDelete: () => Promise<void>;
}) {
  const rowClassName = [
    "nodeRow",
    selected ? "selected" : "",
    node.done ? "completed" : "",
    dragging ? "dragging" : "",
    dropPlacement ? `drop-${dropPlacement}` : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={rowClassName}
      data-node-id={node.id}
      style={{ "--depth": depth } as CSSProperties}
    >
      <button
        className="dragHandle"
        type="button"
        title={canDrag ? "Move node" : "Move disabled while searching"}
        aria-label="Move node"
        disabled={!canDrag}
        onPointerDown={onMoveStart}
      >
        <GripVertical size={15} />
      </button>
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
        className={node.done ? "checkButton done" : "checkButton"}
        type="button"
        title={node.done ? "Mark open" : "Mark done"}
        aria-pressed={node.done}
        onClick={() => onToggle({ done: !node.done })}
      >
        {node.done && <Check size={15} strokeWidth={3} />}
      </button>
      <input
        ref={registerInput}
        className="nodeTitle"
        value={node.title}
        placeholder="Untitled"
        onFocus={onSelect}
        onChange={event => onPatchLocal({ title: event.target.value })}
        onBlur={event => onCommit({ title: event.target.value })}
        onKeyDown={event => {
          if (event.key === "Enter") {
            event.preventDefault();
            onCreateAfter();
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
      <div className="nodeTags">
        {node.tags.map(tag => (
          <span key={tag.id}>
            {tag.name}
          </span>
        ))}
      </div>
      <button className="iconButton danger" type="button" title="Delete" onClick={() => onDelete()}>
        <Trash2 size={15} />
      </button>
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

function updateTreeNode(
  root: OutlineTreeNode,
  id: string,
  patch: Partial<OutlineTreeNode>
): OutlineTreeNode {
  if (root.id === id) return { ...root, ...patch };
  return {
    ...root,
    children: root.children.map(child => updateTreeNode(child, id, patch))
  };
}

function hasNode(root: OutlineTreeNode, id: string): boolean {
  return root.id === id || root.children.some(child => hasNode(child, id));
}

function isDescendantNode(node: OutlineTreeNode, id: string): boolean {
  return node.children.some(child => child.id === id || isDescendantNode(child, id));
}

function getDropPlacement(element: HTMLElement, clientY: number): DropPlacement {
  const bounds = element.getBoundingClientRect();
  return clientY < bounds.top + bounds.height / 2 ? "before" : "after";
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
