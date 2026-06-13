# OpenOutliner

OpenOutliner is a local-first outline notes app inspired by Tana and Mubu. It combines a keyboard-first outline editor, SQLite storage, Markdown/OPML import-export, a CLI, and an MCP server for LLM clients.

## Features

- Keyboard-first outline editing with nested nodes, collapse/expand, completion state, tags, and typed fields.
- Inline Markdown rendering in outline titles for bold, italic, strike, inline code, and links.
- Markdown shortcuts in node titles: `Ctrl+B`, `Ctrl+I`, `Ctrl+Alt+X`, `Ctrl+E`, and `Ctrl+K`.
- `Ctrl+K` creates Markdown links from the clipboard; `Ctrl+click` opens rendered title links.
- Dot-based node dragging with before/inside/after drop targets and a live drag preview.
- Cross-workspace tag results, including opening matching nodes in their source workspace.
- Responsive web UI with a mobile workspace switcher and collapsible comments panel.
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

- Use `Enter` to create a sibling node.
- Use `Tab` and `Shift+Tab` to indent and outdent nodes.
- Use `ArrowUp` and `ArrowDown` to move focus through the outline.
- Use the dot next to a node title to drag it before, inside, or after another node.
- Click `?` in the toolbar to view Markdown shortcuts.
- Use `Ctrl+K` after selecting title text to wrap it as a link using the current clipboard value.
- Use `Ctrl+click` on a rendered title link to open it.
- Click a tag pill to view matching nodes across all workspaces.

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
