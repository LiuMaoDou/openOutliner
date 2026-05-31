import {
  Check,
  ChevronDown,
  ChevronRight,
  FileDown,
  FolderTree,
  PanelRight,
  Plus,
  Search,
  Tag as TagIcon,
  Trash2,
  Upload
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiText,
  type OutlineTreeNode,
  type Workspace
} from "./api";

interface FlatNode {
  node: OutlineTreeNode;
  depth: number;
}

export function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>("");
  const [tree, setTree] = useState<OutlineTreeNode | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [tagName, setTagName] = useState("");
  const [isInspectorOpen, setIsInspectorOpen] = useState(true);
  const inputRefs = useRef(new Map<string, HTMLInputElement>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const loadWorkspaces = useCallback(async () => {
    const next = await apiGet<Workspace[]>("/api/workspaces");
    setWorkspaces(next);
    setWorkspaceId(current => current || next[0]?.id || "");
  }, []);

  const loadTree = useCallback(async (id: string) => {
    if (!id) return;
    const next = await apiGet<OutlineTreeNode>(`/api/workspaces/${id}/tree`);
    setTree(next);
    setSelectedId(current => current || next.children[0]?.id || next.id);
  }, []);

  useEffect(() => {
    loadWorkspaces().catch(toError(setError));
  }, [loadWorkspaces]);

  useEffect(() => {
    loadTree(workspaceId).catch(toError(setError));
  }, [loadTree, workspaceId]);

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
  const filteredNodes = search.trim()
    ? flatNodes.filter(({ node }) => `${node.title}\n${node.body}`.toLowerCase().includes(search.toLowerCase()))
    : flatNodes;

  const refresh = useCallback(
    async (focusId?: string) => {
      await loadTree(workspaceId);
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

  const createWorkspace = async () => {
    const created = await apiPost<Workspace>("/api/workspaces", { name: "Untitled Workspace" });
    await loadWorkspaces();
    setWorkspaceId(created.id);
    setSelectedId("");
  };

  const addTag = async () => {
    if (!selectedNode || !tagName.trim()) return;
    await apiPost(`/api/nodes/${selectedNode.id}/tags`, { name: tagName.trim() });
    setTagName("");
    await refresh(selectedNode.id);
  };

  const saveSelectedNodeNotes = async () => {
    if (!selectedNode) return;
    await patchNode(selectedNode.id, { body: selectedNode.body });
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
    await apiPost(`/api/import/${format}`, { workspaceId, content });
    await refresh();
  };

  return (
    <div className="appShell">
      <aside className="sidebar">
        <div className="sidebarHeader">
          <div className="brand">
            <span className="brandMark">
              <FolderTree size={18} />
            </span>
            <span>OpenOutliner</span>
          </div>
          <button className="commandButton" type="button" onClick={createWorkspace}>
            <Plus size={15} />
            <span>Workspace</span>
          </button>
        </div>

        <div className="workspaceGroup">
          <div className="sidebarLabel">Workspaces</div>
          {workspaces.map(workspace => (
            <button
              className={workspace.id === workspaceId ? "workspaceItem active" : "workspaceItem"}
              key={workspace.id}
              type="button"
              onClick={() => {
                setWorkspaceId(workspace.id);
                setSelectedId("");
              }}
            >
              <span>{workspace.name}</span>
            </button>
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
            <button title="Inspector" type="button" onClick={() => setIsInspectorOpen(open => !open)}>
              <PanelRight size={17} />
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

        <section className="contentGrid">
          <div className="outlineSurface">
            <div className="outlineHeader">
              <h1>{tree?.title ?? "OpenOutliner"}</h1>
              <div className="outlineMeta">
                <span>{filteredNodes.length} visible</span>
                <span>{selectedNode ? "1 selected" : "No selection"}</span>
              </div>
            </div>
            <div className="outlineList">
              {filteredNodes.map(({ node, depth }) => (
                <NodeRow
                  key={node.id}
                  node={node}
                  depth={depth}
                  selected={selectedId === node.id}
                  registerInput={element => {
                    if (element) inputRefs.current.set(node.id, element);
                    else inputRefs.current.delete(node.id);
                  }}
                  onSelect={() => setSelectedId(node.id)}
                  onPatchLocal={patch => {
                    setTree(current => (current ? updateTreeNode(current, node.id, patch) : current));
                  }}
                  onCommit={patch => patchNode(node.id, patch).catch(toError(setError))}
                  onToggle={async patch => {
                    await patchNode(node.id, patch);
                    await refresh(node.id);
                  }}
                  onCreateAfter={() => createAfter(node).catch(toError(setError))}
                  onIndent={() => indent(node).catch(toError(setError))}
                  onOutdent={() => outdent(node).catch(toError(setError))}
                  onFocusPrevious={() => focusRelative(node, -1)}
                  onFocusNext={() => focusRelative(node, 1)}
                  onDelete={async () => {
                    await apiDelete(`/api/nodes/${node.id}`);
                    await refresh(flatNodes[flatNodes.findIndex(item => item.node.id === node.id) - 1]?.node.id);
                  }}
                />
              ))}
            </div>
          </div>

          {isInspectorOpen && (
            <aside className="inspector">
              <div className="inspectorHeader">
                <div>
                  <span>Inspector</span>
                  <small>{selectedNode?.title || "No node selected"}</small>
                </div>
                <PanelRight size={17} />
              </div>
              {selectedNode ? (
                <>
                  <div className="inspectorSection">
                    <div className="sectionHeader">
                      <label>Notes</label>
                      <button
                        className="sectionButton"
                        type="button"
                        onClick={() => saveSelectedNodeNotes().catch(toError(setError))}
                      >
                        <Check size={14} />
                        <span>Save</span>
                      </button>
                    </div>
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
                  <div className="inspectorSection">
                    <label>Tags</label>
                    <div className="tagList">
                      {selectedNode.tags.map(tag => (
                        <span className="tagPill" key={tag.id} style={{ "--tag-color": tag.color } as React.CSSProperties}>
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
            </aside>
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
  onDelete
}: {
  node: OutlineTreeNode;
  depth: number;
  selected: boolean;
  registerInput: (element: HTMLInputElement | null) => void;
  onSelect: () => void;
  onPatchLocal: (patch: Partial<OutlineTreeNode>) => void;
  onCommit: (patch: Partial<OutlineTreeNode>) => void;
  onToggle: (patch: Partial<OutlineTreeNode>) => Promise<void>;
  onCreateAfter: () => void;
  onIndent: () => void;
  onOutdent: () => void;
  onFocusPrevious: () => void;
  onFocusNext: () => void;
  onDelete: () => Promise<void>;
}) {
  const rowClassName = ["nodeRow", selected ? "selected" : "", node.done ? "completed" : ""]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={rowClassName} style={{ "--depth": depth } as React.CSSProperties}>
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
        {node.done && <Check size={13} strokeWidth={3} />}
      </button>
      <input
        ref={registerInput}
        className="nodeTitle"
        value={node.title}
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
          <span key={tag.id} style={{ "--tag-color": tag.color } as React.CSSProperties}>
            #{tag.name}
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

function toError(setError: (message: string) => void) {
  return (error: unknown) => {
    setError(error instanceof Error ? error.message : "Unexpected error");
  };
}
