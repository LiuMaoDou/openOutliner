# OpenOutliner

OpenOutliner is a local-first outline notes app inspired by Tana and Mubu. It combines a keyboard-first outline editor, SQLite storage, Markdown/OPML import-export, a CLI, and an MCP server for LLM clients.

## Features

- Keyboard-first outline editing with nested nodes, collapse/expand, completion state, due dates, tags, and typed fields.
- Range, additive, and drag selection for working with multiple outline nodes as one group.
- Batch indentation, dragging, deletion, and one-step undo for selected nodes while preserving their subtrees and order.
- Workspace-scoped undo/redo for outline creation, editing, movement, indentation, and deletion.
- Inline Markdown rendering in outline titles for bold, italic, strike, inline code, highlight, and links.
- A compact formatting toolbar appears when title text is selected; pasting a URL over selected text creates a Markdown link automatically.
- Markdown keyboard shortcuts for bold, italic, strike, inline code, highlight, and clipboard links.
- Dot-based node dragging with before/inside/after drop targets and a live multi-node drag preview.
- Per-node actions for moving an outline subtree to another workspace or converting it into a workspace.
- Nested workspaces and workspace folders with drag reordering and persistent collapse/expand state.
- Cross-workspace tag results, including opening matching nodes in their source workspace.
- Responsive web UI with resizable desktop panels, a mobile workspace switcher, and a collapsible comments panel.
- Virtualized outline rendering for large node lists.
- Local SQLite storage by default, with no hosted service required.
- Light/dark/system theme support and workspace icon customization.
- Markdown and OPML import/export for outline portability through the API, CLI, and MCP server. The web toolbar imports Markdown/OPML and exports OPML.
- CLI and MCP entry points for automation and LLM clients.

## Quick Start

```bash
npm install
npm run dev
```

- Web app: `http://127.0.0.1:5173`
- API server: `http://127.0.0.1:4317`
- Default database: `./data/openoutliner.sqlite`
- Required Node version: `>=25.0.0`

## Web Usage

- Use `Enter` on an empty row to create and focus the next row.
- Use `Enter` inside a title to split it at the caret. At the beginning of a non-empty title, it inserts a new row before the complete outline and keeps its subtree together.
- Use `Tab` and `Shift+Tab` to indent and outdent a single node.
- Use `ArrowUp` and `ArrowDown` to move focus through the outline.
- Use the dot next to a node title to drag it before, inside, or after another node.
- Use the row's `…` menu to move an outline subtree to another workspace or convert it into a workspace. The menu appears when the row is hovered.
- Use the toolbar undo/redo buttons or `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` (`Ctrl+Y` is also supported for redo).
- Click a tag pill to view matching nodes across all workspaces.

### Multi-Selection

- `Shift+click` selects a continuous range.
- `Ctrl/Cmd+click` adds or removes individual nodes from the selection.
- Drag across the empty area of outline rows to select a range with the mouse.
- Press `Tab` to indent the selected group together under the nearest valid previous outline.
- Drag the dot on any selected row to move the selected group while preserving order and nested content.
- Click the delete button on any selected row, or press `Delete`, to remove the group in one batch.
- Use `Undo` to restore the entire deleted group, including subtrees, original order, and the multi-selection.

### Markdown In Titles

- Select title text to open the compact Markdown toolbar for bold, italic, strike, inline code, and highlight.
- Copy a URL, select existing title text, and paste. OpenOutliner converts it to `[selected text](URL)`; ordinary text still pastes normally.
- `Ctrl/Cmd+B`: bold.
- `Ctrl/Cmd+I`: italic.
- `Ctrl/Cmd+Alt+X`: strike (`Ctrl/Cmd+Shift+X` is also supported).
- `Ctrl/Cmd+E`: inline code.
- `Ctrl/Cmd+Shift+H`: highlight.
- `Ctrl/Cmd+K`: create a Markdown link from the current clipboard value.
- `Ctrl/Cmd+click` a rendered title link to open it.
- Click `?` in the toolbar to view the shortcut reference.

### Workspaces

- Create folders and nested workspaces from the sidebar.
- Drag workspaces before, inside, or after another workspace or folder to reorganize them.
- Workspace and folder collapse states persist after reload.
- Moving an outline to another workspace preserves its subtree and opens the destination workspace with the moved outline selected.

## Development

```bash
npm run typecheck
npm test
npm run build
```

- `npm run typecheck` validates backend and web TypeScript projects.
- `npm test` runs Vitest service and import/export tests.
- `npm run build` compiles the backend and production web bundle.
- `npm run server` runs only the backend API.
- `npm run mcp` starts the MCP server.

## CLI

```bash
npm run cli -- workspace list
npm run cli -- search "project"
npm run cli -- node create --parent <node-id> --title "New idea"
npm run cli -- export markdown --out outline.md
npm run cli -- import opml outline.opml
```

After `npm run build`, the package exposes:

```bash
openoutliner --help
openoutliner-mcp
```

## MCP

Run the MCP server locally:

```bash
npm run mcp
```

The MCP server exposes tools for workspace listing, node search/read/create/edit/move/delete, tags, fields, and Markdown/OPML import-export.

## Import And Export

- Markdown export supports one workspace or all workspaces.
- Markdown import can target a workspace/parent node, or replace all workspaces when no target is supplied.
- OPML export supports one workspace or all workspaces.
- OPML import preserves workspace outlines and OpenOutliner workspace icons when present.
- Empty wrapper outline nodes are skipped during OPML export/import round trips.

## Contributor Guide

See `AGENTS.md` for repository structure, coding conventions, test expectations, and commit/PR guidance.

## Data Model

OpenOutliner uses a single-parent tree with lightweight tags and typed fields. Full graph references, cloud sync, and rich attachments are intentionally deferred.
