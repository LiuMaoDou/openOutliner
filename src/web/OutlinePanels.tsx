import { Check, CalendarX2, ChevronDown, ChevronRight, Pencil, Trash2, Undo2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { OutlineNode, RecycleBinEntry, Tag, TaggedNodeGroup, TaggedNodeResult, Workspace } from "./api";
import type { FlatNodeData } from "./flatTree";
import { outlineTitleLabel } from "../backend/shared/outlineTitle";
import { beginNodeEdit, endNodeEdit, readNodeDraft, stageNodeDraft } from "./offline";
import { shouldIgnoreTextInputKeyDown } from "./outlineInteraction";

export type SystemTagRow =
  | { kind: "tag"; group: TaggedNodeGroup }
  | { kind: "node"; groupName: string; color: string; result: TaggedNodeResult };

const NOTES_HEIGHT_STORAGE_KEY = "openoutliner.comments-notes-height:v1";
const MIN_NOTES_HEIGHT = 128;
const MAX_NOTES_HEIGHT = 2400;
export function OverdueTasks({ nodes, workspaces, onOpen }: {
  nodes: OutlineNode[];
  workspaces: Workspace[];
  onOpen: (node: OutlineNode) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  return (
    <section className="overduePanel" aria-labelledby="overdue-panel-title">
      <button
        className="overdueHeader"
        type="button"
        title="Unfinished tasks across all pages due by tomorrow, including overdue tasks"
        aria-expanded={!collapsed}
        onClick={() => setCollapsed(current => !current)}
      >
        <span>
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          <CalendarX2 size={16} />
          <strong id="overdue-panel-title">Overdue</strong>
        </span>
        <small>{nodes.length}</small>
      </button>
      {!collapsed && nodes.length > 0 ? (
        <div className="overdueList">
          {nodes.map(node => (
            <button type="button" key={node.id} onClick={() => onOpen(node)}
              title={`${workspaces.find(workspace => workspace.id === node.workspaceId)?.name ?? ""} / ${outlineTitleLabel(node.title)}`}>
              <span>{outlineTitleLabel(node.title)}</span>
              <time dateTime={node.dueDate ?? undefined}>
                {node.dueDate ? new Date(`${node.dueDate}T00:00:00`).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric"
                }) : ""}
              </time>
            </button>
          ))}
        </div>
      ) : !collapsed ? (
        <p className="overdueEmpty">No tasks due by tomorrow</p>
      ) : null}
    </section>
  );
}

export function NodeNotes({ node, onError, onTemporaryChange }: { node: FlatNodeData; onError: (error: unknown) => void; onTemporaryChange: (body: string) => void }) {
  const [value, setValue] = useState(() => readNodeDraft(node.id, "body") ?? node.body);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    // The textarea is remounted when the selected node changes. Its height is
    // a device-level Comments preference, not a property of the note itself.
    try {
      const stored = window.localStorage.getItem(NOTES_HEIGHT_STORAGE_KEY);
      if (stored !== null) {
        const height = Number(stored);
        if (Number.isFinite(height) && height >= MIN_NOTES_HEIGHT && height <= MAX_NOTES_HEIGHT) {
          input.style.height = `${Math.round(height)}px`;
        }
      }
    } catch {
      // Storage can be blocked; leave the native resize control usable.
    }

    if (typeof ResizeObserver === "undefined") return;
    let previousHeight = Math.round(input.getBoundingClientRect().height);
    const observer = new ResizeObserver(() => {
      const height = Math.round(input.getBoundingClientRect().height);
      if (height === previousHeight) return;
      previousHeight = height;
      if (height < MIN_NOTES_HEIGHT || height > MAX_NOTES_HEIGHT) return;
      try {
        window.localStorage.setItem(NOTES_HEIGHT_STORAGE_KEY, String(height));
      } catch {
        // Keep resizing usable even when preferences cannot be persisted.
      }
    });
    observer.observe(input);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const resolved = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId: string; field: string; value?: string }>).detail;
      if (detail.nodeId === node.id && detail.field === "body" && detail.value !== undefined) setValue(detail.value);
    };
    window.addEventListener("outliner-draft-resolved", resolved);
    return () => window.removeEventListener("outliner-draft-resolved", resolved);
  }, [node.id]);
  useEffect(() => {
    if (document.activeElement !== inputRef.current) setValue(readNodeDraft(node.id, "body") ?? node.body);
  }, [node.id, node.body]);
  return <textarea
    ref={inputRef}
    className="nodeNotes"
    value={value}
    onFocus={() => { if (!node.id.startsWith("temp-")) beginNodeEdit(node.id, "body", node.body); }}
    onChange={event => {
      setValue(event.target.value);
      if (node.id.startsWith("temp-")) onTemporaryChange(event.target.value);
      else stageNodeDraft(node.id, "body", event.target.value, node.body);
    }}
    onBlur={() => { if (!node.id.startsWith("temp-")) void endNodeEdit(node.id, "body").catch(onError); }}
    placeholder="Add node details"
  />;
}

export function TagResultRow({
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
        <span className="tagResultTitle">{outlineTitleLabel(result.node.title)}</span>
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

export function RecycleBinRow({
  entry,
  restoring,
  disabled,
  onRestore
}: {
  entry: RecycleBinEntry;
  restoring: boolean;
  disabled: boolean;
  onRestore: () => void;
}) {
  const nodesById = new Map([entry.node, ...entry.descendants].map(node => [node.id, node]));
  const depthFor = (node: RecycleBinEntry["node"]) => {
    let depth = 0;
    let parentId = node.parentId;
    while (parentId && parentId !== entry.node.id) {
      const parent = nodesById.get(parentId);
      if (!parent) break;
      depth += 1;
      parentId = parent.parentId;
    }
    return depth;
  };

  return (
    <article className="recycleBinRow">
      <div className="recycleBinMain">
        <div className="recycleBinHeading">
          <span className="recycleBinTitle">{outlineTitleLabel(entry.node.title)}</span>
          <span className="recycleBinWorkspace">{entry.workspace.name}</span>
        </div>
        {entry.node.body && <p className="recycleBinBody">{entry.node.body}</p>}
        <div className="recycleBinMeta">
          <span>{new Date(entry.completedAt).toLocaleString()}</span>
          <span>{entry.descendants.length === 0 ? "No nested outlines" : `${entry.descendants.length} nested outlines`}</span>
        </div>
        {entry.descendants.length > 0 && (
          <details className="recycleBinChildren">
            <summary>Show nested outlines</summary>
            <div>
              {entry.descendants.map(node => (
                <div className="recycleBinChild" key={node.id} style={{ "--recycle-depth": depthFor(node) } as CSSProperties}>
                  <span>{outlineTitleLabel(node.title)}</span>
                  {node.body && <small>{node.body}</small>}
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
      <button className="recycleBinRestore" type="button" disabled={disabled || restoring} onClick={onRestore}>
        <Undo2 size={15} />
        <span>{restoring ? "Restoring…" : "Restore"}</span>
      </button>
    </article>
  );
}

export function SystemTagGroupRow({ group, collapsed, onToggle, onRename, onDelete }: {
  group: TaggedNodeGroup;
  collapsed: boolean;
  onToggle: () => void;
  onRename: (name: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const act = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try { await action(); setEditing(false); }
    catch (error) { setError(error instanceof Error ? error.message : "Unable to update tag."); }
    finally { busyRef.current = false; setBusy(false); }
  };
  const cancel = () => { setEditing(false); setName(group.name); setError(""); };
  return (
    <div className="systemTagGroupRow" style={{ "--system-tag-color": group.color } as CSSProperties}>
      {editing ? <>
        <input className="systemTagRenameInput" autoFocus value={name} disabled={busy}
          aria-label={`Rename tag ${group.name}`}
          onChange={event => setName(event.target.value)}
          onKeyDown={event => {
            if (shouldIgnoreTextInputKeyDown(event)) return;
            if (event.key === "Enter") { event.preventDefault(); void act(() => onRename(name)); }
            if (event.key === "Escape") { event.preventDefault(); cancel(); }
          }} />
        <button className="systemTagAction" type="button" title="Save tag name" aria-label="Save tag name" disabled={busy || !name.trim()}
          onClick={() => void act(() => onRename(name))}><Check size={15} /></button>
        <button className="systemTagAction" type="button" title="Cancel rename" aria-label="Cancel rename" disabled={busy} onClick={cancel}><X size={15} /></button>
      </> : <>
        <button className="systemTagGroupToggle" type="button" aria-expanded={!collapsed} onClick={onToggle}>
          <span className="systemTagDisclosure" aria-hidden="true">{collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</span>
          <span className="systemTagColor" aria-hidden="true" />
          <strong>#{group.name}</strong>
          <span className="systemTagCount">{group.results.length}</span>
        </button>
        <button className="systemTagAction" type="button" title="Rename tag" aria-label={`Rename tag ${group.name}`} disabled={busy}
          onClick={() => { setName(group.name); setEditing(true); setError(""); }}><Pencil size={14} /></button>
        <button className="systemTagAction systemTagDelete" type="button" title="Delete tag" aria-label={`Delete tag ${group.name}`} disabled={busy}
          onClick={() => void act(onDelete)}><Trash2 size={14} /></button>
      </>}
      {error && <span className="systemTagError" role="alert">{error}</span>}
    </div>
  );
}

export function SystemTaggedNodeRow({
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
  const ancestorTitles = path.slice(0, -1).map(segment => outlineTitleLabel(segment.title));
  const targetTitle = outlineTitleLabel(target.title);
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

export function systemTagRowKey(row: SystemTagRow | undefined, index: number): string {
  if (!row) return `system-tag-row-${index}`;
  return row.kind === "tag" ? `system-tag:${row.group.name}` : `system-node:${row.groupName}:${row.result.node.id}`;
}

