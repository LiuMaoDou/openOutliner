/**
 * Flat tree data structure with O(1) node lookup.
 *
 * Instead of a deeply nested OutlineTreeNode tree, we maintain:
 * - nodes: Record<string, FlatNode>  — O(1) lookup by id
 * - rootId: string                   — the root node id
 * Visible IDs are computed separately for virtual scrolling.
 */

import type { OutlineTreeNode, Tag, FieldValue } from "./api";

export interface FlatNodeData {
  id: string;
  workspaceId: string;
  parentId: string | null;
  position: number;
  title: string;
  body: string;
  dueDate: string | null;
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

// ─── Conversion ───────────────────────────────────────────────────

/** Convert a nested OutlineTreeNode (from API) into FlatTreeState + visible IDs */
export function fromNestedTree(root: OutlineTreeNode): {
  state: FlatTreeState;
  visibleIds: string[];
} {
  const nodes: Record<string, FlatNodeData> = {};
  const visibleIds: string[] = [];

  const stack = [{ node: root, parentId: null as string | null, visible: true }];
  while (stack.length) {
    const { node, parentId, visible } = stack.pop()!;
    const { children, ...rest } = node;
    const childIds = children.map(c => c.id);
    nodes[node.id] = { ...rest, parentId, childIds };
    if (parentId !== null && visible) visibleIds.push(node.id);
    const childVisible = visible && !node.collapsed;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ node: children[index], parentId: node.id, visible: childVisible });
    }
  }

  return { state: { nodes, rootId: root.id }, visibleIds };
}

// ─── Visible ID Computation ───────────────────────────────────────

/** Compute visible IDs from flat state. Only called on structural changes. */
export function computeVisibleIds(state: FlatTreeState): string[] {
  const ids: string[] = [];
  const root = state.nodes[state.rootId];
  if (!root) return ids;

  const stack = [...root.childIds].reverse();
  while (stack.length) {
    const id = stack.pop()!;
    ids.push(id);
    const node = state.nodes[id];
    if (node && !node.collapsed) {
      for (let index = node.childIds.length - 1; index >= 0; index -= 1) stack.push(node.childIds[index]);
    }
  }
  return ids;
}

/** Search the entire outline in document order, including collapsed branches. */
export function searchNodeIds(state: FlatTreeState, query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return computeVisibleIds(state);
  const ids: string[] = [];
  const stack = [state.rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const node = state.nodes[id];
    if (!node) continue;
    if (id !== state.rootId && `${node.title}\n${node.body}`.toLowerCase().includes(normalized)) ids.push(id);
    for (let index = node.childIds.length - 1; index >= 0; index -= 1) stack.push(node.childIds[index]);
  }
  return ids;
}

// ─── Immutable mutations (copy the node map once per operation) ────────

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
    if (state.nodes[cid].position !== i) state.nodes[cid] = { ...state.nodes[cid], position: i };
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
  return removeNodes(state, [id]);
}

/** Delete a selection and its subtrees with one immutable map copy. */
export function removeNodes(state: FlatTreeState, ids: Iterable<string>): FlatTreeState {
  const deletingIds = getTopLevelNodeIds(state, ids).filter(id => state.nodes[id].parentId);
  if (!deletingIds.length) return state;
  const next = cloneState(state);
  const parentIds = new Set(deletingIds.map(id => state.nodes[id].parentId!));
  const stack = [...deletingIds];
  while (stack.length) {
    const id = stack.pop()!;
    const node = next.nodes[id];
    if (!node) continue;
    for (const childId of node.childIds) stack.push(childId);
    delete next.nodes[id];
  }
  for (const parentId of parentIds) {
    cloneNode(next, parentId);
    next.nodes[parentId].childIds = next.nodes[parentId].childIds.filter(id => next.nodes[id]);
    normalizePositions(next, parentId);
  }
  return next;
}

export function replaceNode(
  state: FlatTreeState,
  id: string,
  replacement: FlatNodeData
): FlatTreeState {
  const current = state.nodes[id];
  if (!current) return state;
  if (id !== replacement.id && state.nodes[replacement.id]) return state;

  const next = cloneState(state);
  const replacementParentId = replacement.parentId ?? current.parentId;
  const replacementNode = {
    ...replacement,
    parentId: replacementParentId,
    childIds: [...replacement.childIds]
  };

  delete next.nodes[id];
  next.nodes[replacement.id] = replacementNode;

  if (replacementParentId && next.nodes[replacementParentId]) {
    cloneNode(next, replacementParentId);
    next.nodes[replacementParentId].childIds = next.nodes[replacementParentId].childIds.map(childId =>
      childId === id ? replacement.id : childId
    );
    normalizePositions(next, replacementParentId);
  }

  for (const childId of replacementNode.childIds) {
    const child = next.nodes[childId];
    if (child?.parentId === id) {
      next.nodes[childId] = { ...child, parentId: replacement.id };
    }
  }

  return {
    nodes: next.nodes,
    rootId: state.rootId === id ? replacement.id : state.rootId
  };
}

export function moveNode(
  state: FlatTreeState,
  id: string,
  newParentId: string,
  position: number
): FlatTreeState {
  const node = state.nodes[id];
  if (!node || id === state.rootId || id === newParentId) return state;
  if (!node.parentId || !state.nodes[newParentId]) return state;

  // Check if newParent is a descendant of node (circular move)
  if (isDescendant(state, id, newParentId)) return state;

  const next = cloneState(state);
  cloneNode(next, node.parentId);
  if (node.parentId !== newParentId) cloneNode(next, newParentId);

  const oldParent = next.nodes[node.parentId];
  const newParent = next.nodes[newParentId];
  oldParent.childIds = oldParent.childIds.filter(cid => cid !== id);
  const nextPosition = Math.max(0, Math.min(position, newParent.childIds.length));
  newParent.childIds.splice(nextPosition, 0, id);
  next.nodes[id] = { ...node, parentId: newParentId, position: nextPosition };

  normalizePositions(next, node.parentId);
  if (node.parentId !== newParentId) normalizePositions(next, newParentId);
  return next;
}

export function getTopLevelNodeIds(state: FlatTreeState, ids: Iterable<string>): string[] {
  const uniqueIds = [...new Set(ids)].filter(id => id !== state.rootId && !!state.nodes[id]);
  const selectedIds = new Set(uniqueIds);
  return uniqueIds.filter(id => {
    let parentId = state.nodes[id]?.parentId;
    while (parentId) {
      if (selectedIds.has(parentId)) return false;
      parentId = state.nodes[parentId]?.parentId ?? null;
    }
    return true;
  });
}

export function moveNodes(
  state: FlatTreeState,
  ids: Iterable<string>,
  newParentId: string,
  position: number
): FlatTreeState {
  const movingIds = getTopLevelNodeIds(state, ids);
  const newParent = state.nodes[newParentId];
  if (movingIds.length === 0 || !newParent) return state;
  if (movingIds.some(id => id === newParentId || isDescendant(state, id, newParentId))) return state;

  const movingIdSet = new Set(movingIds);
  const affectedParentIds = new Set<string>([newParentId]);
  for (const id of movingIds) {
    const parentId = state.nodes[id]?.parentId;
    if (!parentId) return state;
    affectedParentIds.add(parentId);
  }

  const next = cloneState(state);
  for (const parentId of affectedParentIds) cloneNode(next, parentId);

  for (const parentId of affectedParentIds) {
    next.nodes[parentId].childIds = next.nodes[parentId].childIds.filter(id => !movingIdSet.has(id));
  }

  const targetChildren = next.nodes[newParentId].childIds;
  const targetPosition = Math.max(0, Math.min(position, targetChildren.length));
  targetChildren.splice(targetPosition, 0, ...movingIds);
  for (const id of movingIds) {
    next.nodes[id] = { ...next.nodes[id], parentId: newParentId };
  }
  for (const parentId of affectedParentIds) normalizePositions(next, parentId);
  return next;
}

function getFlatNodeDepth(state: FlatTreeState, id: string): number {
  let depth = 0;
  let current = state.nodes[id];
  while (current?.parentId && current.parentId !== state.rootId) {
    depth += 1;
    current = state.nodes[current.parentId];
  }
  return depth;
}

/** Find the previous node that can receive exactly one level of indentation. */
export function getIndentTargetId(
  state: FlatTreeState,
  visibleIds: string[],
  currentId: string
): string | undefined {
  const currentIndex = visibleIds.indexOf(currentId);
  const current = state.nodes[currentId];
  if (!current || currentIndex <= 0 || currentId === state.rootId) return undefined;

  const currentDepth = getFlatNodeDepth(state, currentId);
  let candidate = state.nodes[visibleIds[currentIndex - 1]];
  if (!candidate) return undefined;

  let candidateDepth = getFlatNodeDepth(state, candidate.id);
  if (candidateDepth < currentDepth) return undefined;
  while (candidate.parentId && candidateDepth > currentDepth) {
    candidate = state.nodes[candidate.parentId];
    if (!candidate) return undefined;
    candidateDepth -= 1;
  }

  return candidateDepth === currentDepth ? candidate.id : undefined;
}

export function moveNodeInside(
  state: FlatTreeState,
  id: string,
  newParentId: string
): FlatTreeState {
  const parent = state.nodes[newParentId];
  if (!parent) return state;
  const expanded = parent.collapsed ? updateNode(state, newParentId, { collapsed: false }) : state;
  const currentParent = expanded.nodes[newParentId];
  return moveNode(expanded, id, newParentId, currentParent.childIds.length);
}

// ─── Queries ──────────────────────────────────────────────────────

export function getNode(state: FlatTreeState, id: string): FlatNodeData | undefined {
  return state.nodes[id];
}

export function getParentId(state: FlatTreeState, id: string): string | null {
  return state.nodes[id]?.parentId ?? null;
}

export function isDescendant(state: FlatTreeState, ancestorId: string, id: string): boolean {
  if (!state.nodes[ancestorId]) return false;
  let parentId = state.nodes[id]?.parentId;
  while (parentId) {
    if (parentId === ancestorId) return true;
    parentId = state.nodes[parentId]?.parentId;
  }
  return false;
}

export function hasNode(state: FlatTreeState, id: string): boolean {
  return id in state.nodes;
}
