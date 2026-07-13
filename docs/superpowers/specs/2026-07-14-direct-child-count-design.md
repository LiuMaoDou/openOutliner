# Direct Child Count Display Design

## Goal

Show a muted direct-child count beside each outline item that has one or more direct children. Leaf items do not show a count.

## UI Behavior

- Render the label as `N 个子项` beside the item title and before any tags.
- Use a muted text color and no interactive control semantics.
- The count reflects direct children only; descendants are excluded.
- Collapsing an item does not change its count.
- Existing optimistic tree-state updates make the displayed count update after creating, deleting, or moving direct children.

## Architecture

The web app's normalized tree state already exposes each node's direct child IDs. The outline-row rendering will derive the label from `node.childIds.length`, without API, persistence, or state-shape changes. Styling remains in the existing web stylesheet.

## Error Handling

No new failure modes are introduced. A missing or empty `childIds` collection is treated as no direct children and therefore renders no count.

## Testing

Add a focused UI-state test that verifies a node with direct children exposes the expected count input, while a leaf node does not. Run the relevant test suite and TypeScript type check.

## Scope

This change affects only the outline item display. It does not add descendant counts, count-based filtering, or new API fields.
