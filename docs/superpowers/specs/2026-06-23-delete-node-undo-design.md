# Delete Node Undo Design

## Scope

Support undo for the most recent node deletion in the web UI. This is not a general undo stack and it does not add a trash view. The undo affordance is transient: after a node is deleted, the UI shows a short-lived message with an Undo action. If another node is deleted before undoing, the latest deletion replaces the previous pending undo.

## Current Behavior

The backend already soft-deletes nodes by setting `nodes.deleted_at` on the deleted node and its subtree. Active queries ignore deleted nodes. The web UI optimistically removes the deleted subtree from `FlatTreeState`, focuses the previous visible node, and rolls back only if the DELETE request fails.

## Architecture

Add a backend restore operation and a small front-end pending delete state.

Backend:

- Add `OutlinerService.restoreNode(id)`.
- Add `POST /api/nodes/:id/restore`.
- Restore the deleted node and its deleted descendants by clearing `deleted_at`.
- Restore the subtree under its existing `parent_id`.
- Reinsert the restored root at its stored `position` by shifting active siblings at or after that position.

Frontend:

- Add a `pendingDelete` state for the last completed delete.
- Store the deleted node id, the pre-delete flat tree state, and the focus target chosen after deletion.
- Show a transient undo message with an Undo button after a delete succeeds.
- On Undo, call the restore endpoint. If it succeeds, restore the pre-delete flat tree state and focus the restored node.
- Clear `pendingDelete` when it expires, when undo succeeds, or when a later deletion replaces it.

## Data Flow

Delete:

1. User deletes a node.
2. Frontend snapshots the current `FlatTreeState`.
3. Frontend removes the subtree optimistically and moves focus to the previous visible node.
4. Frontend calls `DELETE /api/nodes/:id`.
5. On success, frontend records `pendingDelete` and shows Undo.
6. On failure, frontend restores the snapshot and focuses the deleted node.

Undo:

1. User clicks Undo while `pendingDelete` is active.
2. Frontend calls `POST /api/nodes/:id/restore`.
3. Backend validates the node is deleted, is not a workspace root, and its parent exists and is active.
4. Backend shifts active siblings in the parent to make room at the restored root position.
5. Backend clears `deleted_at` on the root and descendants.
6. Frontend restores the saved flat tree snapshot and focuses the restored node.

## Error Handling

- If the restore target is not deleted, return a validation error.
- If the restore target is a workspace root, return a validation error.
- If the original parent is missing or deleted, return a validation error.
- If restore fails on the frontend, keep the current visible tree, clear the undo action, and show the existing error message path.
- Temporary optimistic nodes keep their current behavior: deleting them only cancels creation and does not create an undo action.

## Position Semantics

The restored root uses its stored `parent_id` and `position`. If active siblings already occupy that position because the delete operation normalized sibling positions, the backend shifts active siblings with `position >= restored.position` by one. Descendants retain their stored positions relative to their deleted parents.

## UI Behavior

Use a compact app-level snackbar or toast with text such as `Deleted node` and an `Undo` button. The control should not block editing. It should be keyboard and screen-reader accessible. It should disappear after a short timeout or after a newer delete replaces it.

## Tests

Backend tests:

- Restores a deleted node and its child subtree.
- Restores the root of a deleted subtree to its original parent and position.
- Shifts active siblings correctly when restoring.
- Rejects restore when the parent is deleted or missing.
- Rejects restore for non-deleted nodes.

Frontend tests are optional if the project lacks browser test infrastructure. Typechecking must pass, and manual verification should cover deleting a node, undoing it, deleting a temp node, and attempting a normal delete failure path if practical.

## Non-Goals

- No general `Cmd+Z` undo stack.
- No trash list or permanent deleted-node browser.
- No cross-session undo guarantee.
- No restore support from CLI or MCP unless their API surface is explicitly expanded later.
