/**
 * Flat tree data structure for O(1) node operations.
 *
 * Instead of a deeply nested OutlineTreeNode tree, we maintain:
 * - nodes: Record<string, FlatNode>  — O(1) lookup by id
 * - rootId: string                   — the root node id
 * - visibleIds: string[]             — linear array for virtual scrolling
 */

import type { OutlineTreeNode, Tag, FieldValue } from "./api";

export interface FlatNodeData {
  id: string;
  workspaceId: string;
  parentId: string | null;
  position: number;
  title: string;
  body: string;
  done: boolean;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
  tags: Tag[];
  fieldValues: FieldValue[];
  childIds: string[];
}

export interface FlatTreeState {
  nodes: Record<string, FlatNodeData>;
  rootId: string;
}

export interface FlatViewItem {
  id: string;
  depth: number;
}

// ─── Conversion ───────────────────────────────────────────────────

/** Convert a nested OutlineTreeNode (from API) into FlatTreeState + visible IDs */
export function fromNestedTree(root: OutlineTreeNode): {
  state: FlatTreeState;
  visibleIds: string[];
} {
  const nodes: Record<string, FlatNodeData> = {};
  const visibleIds: string[] = [];

  const visit = (node: OutlineTreeNode, parentId: string | null, depth: number): void => {
    const { children, ...rest } = node;
    const childIds = children.map(c => c.id);
    nodes[node.id] = { ...rest, parentId, childIds };
    if (depth > 0) visibleIds.push(node.id);
    children.forEach(child => {
      visit(child, node.id, depth + 1);
    });
  };

  const { children, ...rootRest } = root;
  const rootChildIds = children.map(c => c.id);
  nodes[root.id] = { ...rootRest, parentId: null, childIds: rootChildIds };
  children.forEach(child => visit(child, root.id, 1));

  return { state: { nodes, rootId: root.id }, visibleIds };
}

/** Convert FlatTreeState back to nested OutlineTreeNode (for API) */
export function toNestedTree(state: FlatTreeState): OutlineTreeNode {
  function buildNode(id: string): OutlineTreeNode {
    const n = state.nodes[id];
    return {
      ...n,
      children: n.childIds.map(cid => buildNode(cid)),
    };
  }
  return buildNode(state.rootId);
}

// ─── Visible ID Computation ───────────────────────────────────────

/** Compute visible IDs from flat state. Only called on structural changes. */
export function computeVisibleIds(state: FlatTreeState): string[] {
  const ids: string[] = [];
  const root = state.nodes[state.rootId];
  if (!root) return ids;

  const visit = (nodeId: string, depth: number): void => {
    const node = state.nodes[nodeId];
    if (!node) return;
    for (const childId of node.childIds) {
      ids.push(childId);
      const child = state.nodes[childId];
      if (child && !child.collapsed) visit(childId, depth + 1);
    }
  };

  visit(state.rootId, 0);
  return ids;
}

// ─── Mutations (all return new state, O(1) per operation) ────────

function cloneState(state: FlatTreeState): FlatTreeState {
  return { nodes: { ...state.nodes }, rootId: state.rootId };
}

function cloneNode(state: FlatTreeState, id: string): void {
  const n = state.nodes[id];
  state.nodes[id] = { ...n, childIds: [...n.childIds] };
}

function normalizePositions(state: FlatTreeState, parentId: string): void {
  const parent = state.nodes[parentId];
  if (!parent) return;
  parent.childIds.forEach((cid, i) => {
    state.nodes[cid] = { ...state.nodes[cid], position: i };
  });
}

export function updateNode(
  state: FlatTreeState,
  id: string,
  patch: Partial<FlatNodeData>
): FlatTreeState {
  const node = state.nodes[id];
  if (!node) return state;
  return {
    ...state,
    nodes: {
      ...state.nodes,
      [id]: { ...node, ...patch },
    },
  };
}

export function insertNode(
  state: FlatTreeState,
  parentId: string,
  node: FlatNodeData,
  position: number
): FlatTreeState {
  if (!state.nodes[parentId]) return state;
  const next = cloneState(state);
  cloneNode(next, parentId);
  const parent = next.nodes[parentId];
  const pos = Math.max(0, Math.min(position, parent.childIds.length));
  parent.childIds.splice(pos, 0, node.id);
  next.nodes[node.id] = { ...node, parentId, position: pos };
  normalizePositions(next, parentId);
  return next;
}

export function removeNode(
  state: FlatTreeState,
  id: string
): FlatTreeState {
  const node = state.nodes[id];
  if (!node || id === state.rootId) return state;
  if (!node.parentId) return state;

  const next = cloneState(state);
  cloneNode(next, node.parentId);
  next.nodes[node.parentId].childIds = next.nodes[node.parentId].childIds.filter(cid => cid !== id);
  normalizePositions(next, node.parentId);
  // Also remove node and all descendants from the map
  const removeDescendants = (nid: string) => {
    const n = next.nodes[nid];
    if (!n) return;
    n.childIds.forEach(removeDescendants);
    delete next.nodes[nid];
  };
  removeDescendants(id);
  return next;
}

export function moveNode(
  state: FlatTreeState,
  id: string,
  newParentId: string,
  position: number
): FlatTreeState {
  const node = state.nodes[id];
  if (!node || id === state.rootId || id === newParentId) return state;

  // Check if newParent is a descendant of node (circular move)
  if (isDescendant(state, id, newParentId)) return state;

  const next = removeNode(state, id);
  return insertNode(next, newParentId, { ...node, parentId: newParentId }, position);
}

// ─── Queries ──────────────────────────────────────────────────────

export function getNode(state: FlatTreeState, id: string): FlatNodeData | undefined {
  return state.nodes[id];
}

export function getParentId(state: FlatTreeState, id: string): string | null {
  return state.nodes[id]?.parentId ?? null;
}

export function isDescendant(state: FlatTreeState, ancestorId: string, id: string): boolean {
  const node = state.nodes[ancestorId];
  if (!node) return false;
  return node.childIds.some(cid => cid === id || isDescendant(state, cid, id));
}

export function hasNode(state: FlatTreeState, id: string): boolean {
  return id in state.nodes;
}

/** Find the nearest visible previous sibling's id */
export function getPreviousVisibleId(
  state: FlatTreeState,
  visibleIds: string[],
  currentId: string
): string | undefined {
  const idx = visibleIds.indexOf(currentId);
  if (idx <= 0) return undefined;
  return visibleIds[idx - 1];
}

/** Find the nearest visible next sibling's id */
export function getNextVisibleId(
  state: FlatTreeState,
  visibleIds: string[],
  currentId: string,
  offset: number
): string | undefined {
  const idx = visibleIds.indexOf(currentId);
  const nextIdx = idx + offset;
  if (nextIdx < 0 || nextIdx >= visibleIds.length) return undefined;
  return visibleIds[nextIdx];
}
