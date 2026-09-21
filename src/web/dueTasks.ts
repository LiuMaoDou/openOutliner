import type { FlatTreeState } from "./flatTree";

export function getDueReminderCutoff(now = new Date()): string {
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return [
    tomorrow.getFullYear(),
    String(tomorrow.getMonth() + 1).padStart(2, "0"),
    String(tomorrow.getDate()).padStart(2, "0")
  ].join("-");
}

export function getDueReminderNodes(state: FlatTreeState | null, cutoff: string) {
  if (!state) return [];
  return Object.values(state.nodes)
    .filter(node => node.id !== state.rootId && !node.done && node.dueDate !== null && node.dueDate <= cutoff)
    .sort((left, right) => (left.dueDate ?? "").localeCompare(right.dueDate ?? "")
      || left.position - right.position
      || left.title.localeCompare(right.title));
}
