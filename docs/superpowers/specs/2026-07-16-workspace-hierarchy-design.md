# Workspace Hierarchy Design

## Goal

Allow a Workspace to contain child Workspaces while keeping its own outline content. Users can create a child Workspace from a selected parent or drag an existing Workspace onto a target Workspace to nest it.

## Data Model

Add an optional `parent_workspace_id` to `workspaces`.

- A Workspace belongs to exactly one visible container: its parent Workspace, a Workspace folder, or the root list.
- Setting `parent_workspace_id` clears `folder_id`; assigning `folder_id` clears `parent_workspace_id`.
- A Workspace cannot parent itself or be moved beneath one of its descendants.
- Existing Workspace ordering remains per container through the existing `position` field.

## Sidebar Behavior

- Root Workspaces, folders, and parent Workspaces are shown in the sidebar as expandable tree items.
- A Workspace with children has a disclosure control; collapsed parents hide all descendants.
- Creating a Workspace while a parent Workspace is selected creates it as that parent’s last child and focuses it.
- Dragging a Workspace over the middle of another Workspace nests it as that target’s last child. Before/after drops keep it in the target’s container.
- Dragging a child to a folder or root removes its parent Workspace relationship.

## API and Business Rules

- Workspace create and update requests accept `parentWorkspaceId`.
- The Workspace move request accepts a target container expressed as either `parentWorkspaceId`, `folderId`, or root (`null` for both).
- Service-level validation rejects cycles and invalid parent IDs.
- When deleting a Workspace, promote its direct children into the deleted Workspace’s container at its former position, preserving child order. This preserves all child Workspaces and their outline data.

## Migration and Compatibility

Existing databases receive a nullable `parent_workspace_id` column. Existing Workspaces retain their current folder/root placement, so no data migration is required beyond the schema change.

## Testing

- Create child Workspaces and verify their parent and sibling order.
- Move Workspaces between root, folder, and parent-Workspace containers.
- Reject self-parenting and descendant cycles.
- Delete a parent Workspace and verify its children are promoted with stable ordering.
- Cover sidebar tree-state helpers for nested visibility and drag placement.

## Scope

This feature changes Workspace navigation only. It does not change the outline-node tree inside any Workspace, import/export formats, or folder nesting.
