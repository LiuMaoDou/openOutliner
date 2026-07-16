# Workspace Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Workspaces contain child Workspaces, with creation, sidebar expansion, and drag-to-nest support.

**Architecture:** Store an optional `parent_workspace_id` alongside `folder_id`, with exactly one container relationship at a time. Extend the service and API to move workspaces among root, folders, and parent Workspaces; build a derived sidebar tree from the flat API response.

**Tech Stack:** TypeScript, React 19, SQLite, Node HTTP server, Vitest.

## Global Constraints

- A Workspace belongs to a parent Workspace, a folder, or root; never more than one.
- Reject self-parenting and descendant cycles.
- Deleting a parent Workspace promotes its direct children into the deleted Workspace’s previous container and position.
- Preserve existing root and folder behavior.

---

## File Structure

- Modify: `src/backend/db/database.ts` — migrate and normalize `parent_workspace_id`.
- Modify: `src/backend/domain/types.ts`, `src/web/api.ts` — expose `parentWorkspaceId`.
- Modify: `src/backend/services/outliner.ts` — create, update, move, delete, and validate workspace hierarchy.
- Modify: `src/backend/server/index.ts` — accept hierarchy fields in workspace endpoints.
- Modify: `src/web/App.tsx` — derive/render nested workspaces and extend drag/create behavior.
- Modify: `src/web/styles.css` — tree indentation and disclosure affordances.
- Modify: `tests/outliner.test.ts` — migration, service, and UI-state coverage.

### Task 1: Persist and Validate Workspace Parentage

**Files:**
- Modify: `src/backend/db/database.ts`
- Modify: `src/backend/domain/types.ts`
- Modify: `src/backend/services/outliner.ts`
- Test: `tests/outliner.test.ts`

**Interfaces:**
- Produces: `Workspace.parentWorkspaceId: string | null`.
- Produces: `createWorkspace(name, icon?, folderId?, parentWorkspaceId?)` and `moveWorkspace(id, container, position)` with cycle validation.

- [ ] Write failing service tests for creating children, rejecting self/descendant parentage, preserving per-parent order, and promoting children when deleting a parent.
- [ ] Run `npm test -- tests/outliner.test.ts` and verify the hierarchy assertions fail before the schema/service exists.
- [ ] Add `parent_workspace_id` migration and normalize positions by parent/folder/root container.
- [ ] Update row mapping and service mutations so setting a parent clears folder membership; moving to a folder/root clears parent membership; delete promotes direct children.
- [ ] Re-run `npm test -- tests/outliner.test.ts` and verify the new hierarchy cases pass.
- [ ] Commit the backend and tests with `feat: add workspace hierarchy service`.

### Task 2: Expose Workspace Hierarchy Through the API

**Files:**
- Modify: `src/backend/server/index.ts`
- Modify: `src/web/api.ts`
- Test: `tests/outliner.test.ts`

**Interfaces:**
- Consumes: `parentWorkspaceId?: string | null` in workspace create/patch JSON.
- Produces: workspace API responses with `parentWorkspaceId`.

- [ ] Add a failing helper/API-contract test that expects the new parent field in the web Workspace type and request body.
- [ ] Run the focused test and verify it fails because the parent field is unavailable.
- [ ] Accept `parentWorkspaceId` in create and PATCH routes and pass it to service create/move/update operations.
- [ ] Re-run the focused test and typecheck to verify contracts match.
- [ ] Commit with `feat: expose workspace hierarchy API`.

### Task 3: Render and Create Nested Workspaces in the Sidebar

**Files:**
- Modify: `src/web/App.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/outliner.test.ts`

**Interfaces:**
- Consumes: flat `Workspace[]` with `parentWorkspaceId`.
- Produces: a derived ordered workspace tree and visible sidebar rows.

- [ ] Write failing unit tests for the workspace-tree helper: roots/folder roots are grouped correctly, descendants are nested, and collapsed parent IDs hide descendants.
- [ ] Run the focused test and verify it fails before the helper exists.
- [ ] Derive child Workspaces by parent ID, render disclosure controls and indentation, and keep folder behavior unchanged.
- [ ] Add a per-Workspace “New child Workspace” action that creates the child as the parent’s last item and selects it.
- [ ] Re-run focused tests and typecheck.
- [ ] Commit with `feat: render nested workspaces`.

### Task 4: Support Dragging Workspaces Into Parent Workspaces

**Files:**
- Modify: `src/web/App.tsx`
- Modify: `src/web/styles.css`
- Test: `tests/outliner.test.ts`

**Interfaces:**
- Consumes: existing before/after workspace drag placement plus a new `inside` placement.
- Produces: PATCH requests containing `parentWorkspaceId` when dropped on a target Workspace.

- [ ] Write failing tests for drag-target calculation and request-body construction for an inside Workspace drop.
- [ ] Run the focused test and verify it fails before the inside placement is supported.
- [ ] Extend drag targeting with an inside zone, disallow descendant cycles in the UI, and show the existing inside-drop visual treatment.
- [ ] Update optimistic sidebar state after nesting and expand the target parent.
- [ ] Run `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] Review `git diff --check` and the focused diff, then commit with `feat: support nested workspace dragging`.
