# Workspace Drag Sort Design

## Goal

Workspace rows can be dragged up and down to persist their order within the root workspace list or inside a workspace folder.

## Architecture

Reuse the existing workspace drag entry point in `src/web/App.tsx` and extend it from folder-only drops to workspace-row before/after drops. Persist order with a `position` column on `workspaces`, using the same sibling-position model already used by outline nodes.

## Data Flow

`workspaces` gains `position INTEGER NOT NULL DEFAULT 0`. `OutlinerService.listWorkspaces()` orders by `folder_id`, `position`, and `created_at`. `OutlinerService.moveWorkspace(id, folderId, position)` removes the workspace from its old sibling group, closes the old gap, opens the target gap, and updates `folder_id` plus `position`.

The web app sends `PATCH /api/workspaces/:id` with `folderId` and `position`. The UI updates optimistically, then replaces the moved workspace with the server response and reloads workspace ordering.

## Testing

Add service tests for root reordering, folder reordering, and moving across folder boundaries with continuous positions.
