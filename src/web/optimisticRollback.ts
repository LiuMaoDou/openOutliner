import type { FlatNodeData, FlatTreeState } from "./flatTree";

const equal = (left: unknown, right: unknown) => left === right ||
  (typeof left === "object" && typeof right === "object" && JSON.stringify(left) === JSON.stringify(right));
const structural = new Set<keyof FlatNodeData>(["parentId", "workspaceId", "childIds", "position"]);

/** Undo only this operation's unchanged fields, never a later edit or a different tree.
 * A conflicting structural edit needs an authoritative reread after pending writes settle.
 */
export function rollbackTreeMutation(
  before: FlatTreeState,
  optimistic: FlatTreeState,
  current: FlatTreeState | null
): FlatTreeState | null {
  if (!current || current.rootId !== before.rootId || optimistic.rootId !== before.rootId) return null;
  const nodes = { ...current.nodes };
  for (const id of new Set([...Object.keys(before.nodes), ...Object.keys(optimistic.nodes)])) {
    const previous = before.nodes[id], applied = optimistic.nodes[id], latest = current.nodes[id];
    if (previous === applied) continue;
    if (!applied) {
      if (latest) return null;
      nodes[id] = previous;
      continue;
    }
    if (!previous) {
      if (!equal(latest, applied)) return null;
      delete nodes[id];
      continue;
    }
    if (!latest) return null;
    const restored = { ...latest };
    for (const key of Object.keys(previous) as Array<keyof FlatNodeData>) {
      if (equal(previous[key], applied[key])) continue;
      if (equal(latest[key], applied[key])) Object.assign(restored, { [key]: previous[key] });
      else if (structural.has(key)) return null;
    }
    nodes[id] = restored;
  }
  // Reject an inverse that would orphan a later node or restore a deleted parent.
  const seen = new Set<string>(), stack = [before.rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !nodes[id]) return null;
    seen.add(id);
    for (const child of nodes[id].childIds) {
      if (nodes[child]?.parentId !== id || nodes[child].workspaceId !== nodes[id].workspaceId) return null;
      stack.push(child);
    }
  }
  return seen.size === Object.keys(nodes).length ? { ...current, nodes } : null;
}
