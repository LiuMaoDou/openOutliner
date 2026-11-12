import type { Workspace } from "../domain/types.js";

export class InvalidWorkspacePatch extends Error {}
interface WorkspacePatch {
  name?: string;
  folderId?: string | null;
  parentWorkspaceId?: string | null;
  position?: number;
}
interface WorkspaceCommands {
  importTransaction<T>(fn: () => T): T;
  getWorkspace(id: string): Workspace;
  moveWorkspace(id: string, folderId: string | null, position: number, parentWorkspaceId?: string | null): Workspace;
  updateWorkspace(id: string, input: { name?: string }): Workspace;
}

export function parseWorkspacePatch(input: unknown): WorkspacePatch {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidWorkspacePatch("Workspace patch must be an object.");
  const value = input as Record<string, unknown>;
  const patch: WorkspacePatch = {};
  if (value.name !== undefined) {
    if (typeof value.name !== "string" || !value.name.trim()) throw new InvalidWorkspacePatch("Workspace name is required.");
    patch.name = value.name.trim();
  }
  for (const key of ["folderId", "parentWorkspaceId"] as const) {
    const id = value[key];
    if (id === undefined) continue;
    if (id !== null && (typeof id !== "string" || !id.trim())) throw new InvalidWorkspacePatch(`${key} must be a non-empty ID or null.`);
    patch[key] = id as string | null;
  }
  if (value.position !== undefined) {
    if (typeof value.position !== "number" || !Number.isSafeInteger(value.position) || value.position < 0) {
      throw new InvalidWorkspacePatch("Workspace position must be a non-negative integer.");
    }
    patch.position = value.position;
  }
  return patch;
}

/** Validation precedes writes; rename failure rolls back the move and sibling reordering too. */
export function patchWorkspace(service: WorkspaceCommands, id: string, input: unknown): Workspace {
  const patch = parseWorkspacePatch(input);
  return service.importTransaction(() => {
    if (patch.folderId !== undefined || patch.parentWorkspaceId !== undefined || patch.position !== undefined) {
      const current = service.getWorkspace(id);
      const moved = service.moveWorkspace(
        id,
        patch.folderId !== undefined ? patch.folderId : current.folderId,
        patch.position ?? Number.MAX_SAFE_INTEGER,
        patch.parentWorkspaceId !== undefined ? patch.parentWorkspaceId : current.parentWorkspaceId
      );
      return patch.name !== undefined ? service.updateWorkspace(moved.id, { name: patch.name }) : moved;
    }
    return service.updateWorkspace(id, patch);
  });
}
