# OpenOutliner

OpenOutliner is a local-first outliner for notes, tasks, and schedules, inspired by Tana and Mubu. Organize nested outlines, work offline, and optionally sync your notes across devices through a self-hosted server. It includes a calendar with Chinese holidays and lunar dates, Markdown/OPML import-export, an Android client, a CLI, and an MCP server for LLM clients.

## Features

- Calendar month and schedule views for dated outlines across workspaces, with workspace filtering, search, and links back to the original nodes.
- Chinese lunar dates, public holidays, and adjusted working days from cached calendar feeds.
- Global in-app reminders for unfinished items due tomorrow or earlier, including overdue tasks across workspaces.
- Optional daily WeChat notifications through Xtuis at 09:00 Beijing time, starting two days before a task is due and continuing until completion.
- Browser-local SQLite persisted in IndexedDB, offline editing, and optional authenticated self-hosted synchronization across devices.
- Conflict handling, preserved editing drafts, and downloadable/restorable JSON recovery backups.
- Android WebView client with theme-aware indent/outdent controls and system file import.
- Keyboard-first outline editing with nested nodes, collapse/expand, completion state, due dates, tags, and typed fields.
- Select-all and copy actions for outline rows, with clipboard confirmation.
- Range, additive, and drag selection for working with multiple outline nodes as one group.
- Batch indentation, dragging, deletion, and one-step undo for selected nodes while preserving their subtrees and order.
- Workspace-scoped undo/redo for outline creation, editing, movement, indentation, and deletion.
- Inline Markdown rendering in outline titles for bold, italic, strike, inline code, highlight, and links.
- A compact formatting toolbar appears when title text is selected; pasting a URL over selected text creates a Markdown link automatically.
- Markdown keyboard shortcuts for bold, italic, strike, inline code, highlight, and clipboard links.
- Dot-based node dragging with before/inside/after drop targets and a live multi-node drag preview.
- Drag outline subtrees directly onto a workspace in the sidebar, or use the node action to convert an outline into a workspace.
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
- Required Node version: `>=26.0.0`; use Node 26 LTS (`nvm use`).

Development mode does not register the offline Service Worker. To test offline reopening, use a production build:

```bash
npm run build
npm start
```

Open `http://127.0.0.1:4317` while online first and let the app finish caching. For access from other devices, use HTTPS and follow the [deployment guide](deploy/README.md).

## Web Usage

- Use `Enter` on an empty row to create and focus the next row.
- Use `Enter` inside a title to split it at the caret. At the beginning of a non-empty title, it inserts a new row before the complete outline and keeps its subtree together.
- Use `Tab` and `Shift+Tab` to indent and outdent a single node.
- Use `ArrowUp` and `ArrowDown` to move focus through the outline.
- Use the dot next to a node title to drag it before, inside, or after another node.
- Drag a node's dot onto a workspace in the left sidebar to move its complete subtree there. Selected nodes move together, and the destination is highlighted before dropping.
- Use the row's `…` menu to convert an outline into a workspace. The menu appears when the row is hovered.
- Use the toolbar undo/redo buttons or `Ctrl/Cmd+Z` and `Ctrl/Cmd+Shift+Z` (`Ctrl+Y` is also supported for redo).
- Click a tag pill to view matching nodes across all workspaces.

### Multi-Selection

- Use `Ctrl/Cmd+A` to select outline rows, including when an outline title is focused.
- Use the row menu's **Copy** action, or `Ctrl/Cmd+C` when outline rows rather than title text are selected, to copy the selection as text.
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
- Deleting a workspace permanently deletes all nested sub-workspaces and their outlines.
- Moving an outline to another workspace preserves its subtree and opens the destination workspace with the moved outline selected.
- On mobile, drag an outline to the left edge to reveal the workspace sidebar, then drop it onto the destination workspace.

## Calendar And Reminders

- Assign a due date to an outline to include it in the calendar.
- Switch between **Month** and **Schedule**, filter by workspace, or search scheduled titles, notes, and workspace names.
- Click a scheduled item to open its source outline. Completed items remain visible with a completed style.
- The global reminders list gathers unfinished items due tomorrow or earlier across workspaces. These are in-app reminders, not guaranteed background push notifications.
- Optional WeChat reminders run on the backend independently of the browser. Set `XTUIS_TOKEN` on the server to enable one daily digest at 09:00 in `Asia/Shanghai`, including unfinished tasks due within two days and overdue tasks across all workspaces. Completed/deleted tasks and tasks without a due date are excluded. See [WeChat reminder configuration](deploy/README.md#微信到期提醒虾推啥).
- Lunar dates, holidays, and make-up working days come from [ChinaCalendar](https://github.com/yangh9/ChinaCalendar) feeds. Existing cached data remains available if a feed cannot refresh; initial retrieval requires a network connection.

## Offline, Sync, And Backups

The web app runs outline operations against a local SQLite database saved in IndexedDB. After the first successful load and production app-cache setup, supported browsers can reopen and edit offline.

Optional self-hosting adds password-protected access and synchronization between your devices. Independent record/field changes merge automatically; conflicting edits pause synchronization for review. The **备份与恢复** (Backup and recovery) panel lets you download all workspaces as a JSON recovery backup, restore a backup, review retained editing drafts, and choose between local and server versions when conflicts occur.

- This is a personal, single-dataset service, not a multi-user workspace with isolated accounts.
- Sync is not guaranteed while the page is closed or the device is asleep.
- Undo history is local to each device and is reset when remote changes are applied.
- Clearing browser/app data can remove unsynced notes. Download a recovery backup before clearing data, and back up the server database separately.
- External links and remote images are not downloaded for offline use.

See the [deployment, synchronization, and recovery guide](deploy/README.md) for Docker Compose, HTTPS, storage requirements, and troubleshooting.

## Android Client

The repository includes an Android 8.0+ WebView client with keyboard-friendly indent/outdent controls, theme-aware system bars, persistent login, system file import, and external-browser links. The current release build targets the project's configured personal deployment, rather than an arbitrary server picker.

It shares the web app's local storage and sync behavior. First use needs a network connection; offline startup depends on the website cache and WebView support. Blob-based export downloads are not currently supported in the Android shell, so export synced content from a desktop browser.

See [Android setup, build instructions, and limitations](android/README.md).

## Development

```bash
npm run typecheck
npm test
npm run test:reliability
npm run build
```

- `npm run typecheck` validates backend and web TypeScript projects.
- `npm test` runs the Vitest suite, including outline services, import/export, sync, authentication, offline caching, calendar behavior, and frontend regressions.
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
- Markdown and OPML imports can target a workspace/parent node, or create new workspaces when no target is supplied. Existing workspaces and undo history are preserved; invalid or empty imports make no changes.
- OPML export supports one workspace or all workspaces.
- OPML import preserves workspace outlines and OpenOutliner workspace icons when present.
- Empty wrapper outline nodes are skipped during OPML export/import round trips.

## Contributor Guide

See `AGENTS.md` for repository structure, coding conventions, test expectations, and commit/PR guidance.

## Data Model

OpenOutliner uses a single-parent tree with lightweight tags and typed fields. Optional self-hosted sync is implemented; full graph references and rich attachments remain outside the current scope.
