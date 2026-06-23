# Delete Node Undo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a transient web Undo action that restores the most recently deleted node subtree.

**Architecture:** The backend gets a restore API that clears `deleted_at` for a deleted subtree and shifts active siblings to preserve the restored root position. The web app keeps one pending delete snapshot and shows a compact Undo snackbar after a successful delete.

**Tech Stack:** TypeScript, React, Vite, Node `>=25.0.0`, `node:sqlite`, Vitest.

## Global Constraints

- Use TypeScript and ES modules.
- Keep two-space indentation, double quotes, and no semicolons.
- Run `npm test` and `npm run typecheck` before committing implementation.
- Stage and commit only files related to this feature.
- Do not add a trash view, cross-session undo, or a general undo stack.

---

### Task 1: Backend Restore API

**Files:**
- Modify: `src/backend/services/outliner.ts`
- Modify: `src/backend/server/index.ts`
- Test: `tests/outliner.test.ts`

**Interfaces:**
- Produces: `OutlinerService.restoreNode(id: string): OutlineTreeNode`
- Produces: `POST /api/nodes/:id/restore` returning the restored subtree.

- [ ] **Step 1: Write failing restore service tests**

Add tests that create sibling nodes and a child subtree, delete a node, restore it, and assert restored ordering and descendants. Add a rejection test for restoring a non-deleted node.

- [ ] **Step 2: Run focused tests to verify failure**

Run: `rtk npm test -- tests/outliner.test.ts`

Expected: FAIL because `restoreNode` does not exist.

- [ ] **Step 3: Implement restore service**

Implement `restoreNode(id)` by reading a deleted node row, validating active parent, shifting active siblings at `position >= restored.position`, clearing `deleted_at` on the recursive subtree, and returning `getTree(id)`.

- [ ] **Step 4: Wire HTTP route**

Add `POST /api/nodes/:id/restore` before generic node routes conflict, returning `service.restoreNode(id)`.

- [ ] **Step 5: Run focused tests**

Run: `rtk npm test -- tests/outliner.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit backend restore**

Commit message: `feat: restore deleted node subtrees`

### Task 2: Web Undo Snackbar

**Files:**
- Modify: `src/web/App.tsx`
- Modify: `src/web/styles.css`

**Interfaces:**
- Consumes: `POST /api/nodes/:id/restore`
- Produces: a transient Undo control for the most recent completed node deletion.

- [ ] **Step 1: Add pending delete state**

Track `{ nodeId: string; snapshot: FlatTreeState; focusAfterDeleteId: string } | null` and clear it after a short timeout.

- [ ] **Step 2: Update delete flow**

After `DELETE /api/nodes/:id` succeeds, record the pending delete. Keep temp-node deletes excluded from undo.

- [ ] **Step 3: Add undo handler**

Call `POST /api/nodes/:id/restore`, restore the saved snapshot into `flatState`, recompute visible IDs, update `flatStateRef`, clear pending state, and focus the restored node.

- [ ] **Step 4: Render snackbar and styles**

Render an app-level snackbar with `Deleted node` and an `Undo` button. Style it compactly and accessibly without blocking editing.

- [ ] **Step 5: Run verification**

Run: `rtk npm run typecheck`

Expected: PASS.

- [ ] **Step 6: Commit web undo**

Commit message: `feat: add delete undo snackbar`

### Task 3: Full Verification

**Files:**
- No new files.

**Interfaces:**
- Consumes: completed backend and frontend changes.
- Produces: verified feature branch state.

- [ ] **Step 1: Run tests**

Run: `rtk npm test`

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `rtk npm run typecheck`

Expected: PASS.

- [ ] **Step 3: Review final diff**

Run: `rtk git diff HEAD`

Expected: only intended feature files differ after the latest commit if additional edits remain.
