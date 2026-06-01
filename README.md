# OpenOutliner

OpenOutliner is a local-first outline notes app inspired by Tana and Mubu. It combines a keyboard-first outline editor, SQLite storage, Markdown/OPML import-export, a CLI, and an MCP server for LLM clients.

## Features

- Keyboard-first outline editing with nested nodes, collapse/expand, completion state, tags, and typed fields.
- Local SQLite storage by default, with no hosted service required.
- Light/dark/system theme support and a movable outline workspace.
- Markdown and OPML import/export for outline portability.
- CLI and MCP entry points for automation and LLM clients.

## Quick Start

```bash
npm install
npm run dev
```

- Web app: `http://127.0.0.1:5173`
- API server: `http://127.0.0.1:4317`
- Default database: `./data/openoutliner.sqlite`

## Development

```bash
npm run typecheck
npm test
npm run build
```

- `npm run typecheck` validates backend and web TypeScript projects.
- `npm test` runs Vitest service and import/export tests.
- `npm run build` compiles the backend and production web bundle.

## CLI

```bash
npm run cli -- workspace list
npm run cli -- search "project"
npm run cli -- node create --parent <node-id> --title "New idea"
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

The MCP server exposes tools for workspace listing, node search/read/create/edit/move/delete, tags, fields, and Markdown import/export.

## Contributor Guide

See `AGENTS.md` for repository structure, coding conventions, test expectations, and commit/PR guidance.

## Data Model

The first version uses a single-parent tree with lightweight tags and typed fields. Full graph references, cloud sync, and rich attachments are intentionally deferred.
