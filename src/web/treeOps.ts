import type { OutlineTreeNode } from "./api";

export function insertTreeNode(
  root: OutlineTreeNode,
  parentId: string,
  node: OutlineTreeNode,
  position: number
): OutlineTreeNode {
  return mapTree(root, current => {
    if (current.id !== parentId) return current;
    const children = [...current.children];
    const nextPosition = clamp(position, 0, children.length);
    children.splice(nextPosition, 0, { ...node, parentId: current.id, position: nextPosition });
    return { ...current, children: normalizePositions(children) };
  });
}

export function removeTreeNode(root: OutlineTreeNode, id: string): OutlineTreeNode {
  if (root.id === id) return root;
  return {
    ...root,
    children: normalizePositions(
      root.children
        .filter(child => child.id !== id)
        .map(child => removeTreeNode(child, id))
    )
  };
}

export function replaceTreeNode(
  root: OutlineTreeNode,
  id: string,
  replacement: OutlineTreeNode
): OutlineTreeNode {
  if (root.id === id) {
    return {
      ...replacement,
      children: root.children
    };
  }

  return {
    ...root,
    children: root.children.map(child => replaceTreeNode(child, id, replacement))
  };
}

export function moveTreeNode(
  root: OutlineTreeNode,
  id: string,
  parentId: string,
  position: number
): OutlineTreeNode {
  const moving = findTreeNode(root, id);
  if (!moving || moving.id === root.id || moving.id === parentId || isDescendantNode(moving, parentId)) {
    return root;
  }

  const withoutMoving = removeTreeNode(root, id);
  return insertTreeNode(withoutMoving, parentId, { ...moving, parentId, position }, position);
}

export function updateTreeNode(
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

export function findTreeNode(root: OutlineTreeNode, id: string): OutlineTreeNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findTreeNode(child, id);
    if (found) return found;
  }
  return undefined;
}

export function hasNode(root: OutlineTreeNode, id: string): boolean {
  return Boolean(findTreeNode(root, id));
}

export function isDescendantNode(node: OutlineTreeNode, id: string): boolean {
  return node.children.some(child => child.id === id || isDescendantNode(child, id));
}

function mapTree(
  root: OutlineTreeNode,
  mapper: (node: OutlineTreeNode) => OutlineTreeNode
): OutlineTreeNode {
  const mapped = mapper(root);
  const nextChildren = mapped.children.map(child => mapTree(child, mapper));
  return nextChildren === mapped.children ? mapped : { ...mapped, children: nextChildren };
}

function normalizePositions(nodes: OutlineTreeNode[]): OutlineTreeNode[] {
  return nodes.map((node, position) => ({ ...node, position }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
