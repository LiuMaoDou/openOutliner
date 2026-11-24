import type { Snapshot } from "./sync.js";
import { TODAY_WORKSPACE_ID } from "./systemWorkspaces.js";

export interface SnapshotBackup {
  date: string;
  data: Snapshot;
  kind?: "sync";
}

export const AUTOMATIC_SYNC_BACKUP_LIMIT = 3;

export function removesToday(before: Snapshot, after: Snapshot): boolean {
  return before.workspaces.some(row => row.id === TODAY_WORKSPACE_ID)
    && !after.workspaces.some(row => row.id === TODAY_WORKSPACE_ID);
}

/** Require review of physical loss of live records before accepting a remote
 * snapshot: it could be a rollback, replacement database, or permanent deletion.
 */
export function incomingRemovalConflicts(before: Snapshot, after: Snapshot): string[] {
  const incomingWorkspaces = new Set(after.workspaces.map(row => row.id));
  const incomingNodes = new Set(after.nodes.map(row => row.id));
  const missingWorkspaces = before.workspaces.filter(row => !incomingWorkspaces.has(row.id));
  const missingLiveNodes = before.nodes.filter(row => row.deleted_at === null && !incomingNodes.has(row.id));
  if (!missingWorkspaces.length && !missingLiveNodes.length) return [];
  const conflicts = [
    `云端快照缺少本机已有的 ${missingWorkspaces.length} 个工作区、${missingLiveNodes.length} 个有效节点（可能是云端回滚或永久删除）；已暂停同步并保留本机数据。`
  ];
  if (removesToday(before, after)) conflicts.push("系统 Today 工作区在云端消失。");
  for (const workspace of missingWorkspaces.slice(0, 3)) conflicts.push(`工作区：${workspace.name}`);
  for (const node of missingLiveNodes.slice(0, 5)) conflicts.push(`节点：${node.title}`);
  return conflicts;
}

/** Explicit recovery/conflict copies are never rotated. Persist the safety
 * copy and replacement bytes atomically so a quota failure retains old data.
 */
export function backupBeforeSync(backups: SnapshotBackup[], current: Snapshot, date = new Date().toISOString()): SnapshotBackup[] {
  const next: SnapshotBackup[] = [...backups, { date, data: current, kind: "sync" }];
  let excess = next.filter(backup => backup.kind === "sync").length - AUTOMATIC_SYNC_BACKUP_LIMIT;
  return next.filter(backup => {
    if (backup.kind === "sync" && excess > 0) { excess--; return false; }
    return true;
  });
}
