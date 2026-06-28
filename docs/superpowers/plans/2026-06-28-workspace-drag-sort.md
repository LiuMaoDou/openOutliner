# Workspace Drag Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow workspace rows to be dragged up and down and persist their order.

**Architecture:** Add workspace sibling positions in SQLite and expose a service method that mirrors the existing node move behavior. Extend the current workspace drag UI so the same drag handle can target root, folders, or workspace rows with before/after placement.

**Tech Stack:** TypeScript, React, Vite, Node `DatabaseSync`, Vitest.

## Global Constraints

- Keep changes small and focused.
- Use TypeScript ES modules with existing style.
- Run `npm test`, `npm run typecheck`, and `npm run build` before final commit.
- Do not commit local data or unrelated changes.

---

### Task 1: Persist Workspace Positions

**Files:**
- Modify: `src/backend/db/database.ts`
- Modify: `src/backend/domain/types.ts`
- Modify: `src/web/api.ts`
- Modify: `src/backend/services/outliner.ts`
- Test: `tests/outliner.test.ts`

**Interfaces:**
- Produces: `Workspace.position: number`
- Produces: `OutlinerService.moveWorkspace(id: string, folderId: string | null, position: number): Workspace`

- [ ] **Step 1: Write failing service tests**

Add tests that create workspaces, call `moveWorkspace`, and assert ordered names plus continuous positions in root and folder groups.

- [ ] **Step 2: Run test to verify failure**

Run: `rtk npm test -- tests/outliner.test.ts`

- [ ] **Step 3: Implement migration and service**

Add `position` to `workspaces`, backfill old rows by `created_at`, return `position` in workspace types, and implement sibling gap closing/opening in `moveWorkspace`.

- [ ] **Step 4: Verify tests pass**

Run: `rtk npm test -- tests/outliner.test.ts`

### Task 2: Wire API and Frontend Drag Sort

**Files:**
- Modify: `src/backend/server/index.ts`
- Modify: `src/web/App.tsx`
- Modify: `src/web/styles.css`

**Interfaces:**
- Consumes: `PATCH /api/workspaces/:id` body `{ folderId?: string | null; position?: number }`
- Consumes: `Workspace.position`

- [ ] **Step 1: Extend API update path**

Call `service.moveWorkspace` when `position` or `folderId` is present, otherwise keep rename/icon updates on `updateWorkspace`.

- [ ] **Step 2: Extend drag targets**

Add `data-workspace-drop-id` to workspace rows and compute before/after placement from pointer Y position.

- [ ] **Step 3: Reuse workspace drag end**

On pointer up, call one `moveWorkspace` helper with target folder and target position. Keep root/folder empty drops working.

- [ ] **Step 4: Verify build and rendered behavior**

Run `rtk npm run typecheck`, `rtk npm test`, `rtk npm run build`, then browser-check dragging a workspace above/below another row.
