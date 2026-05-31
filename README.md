# OpenOutliner

OpenOutliner is a local-first outline notes app inspired by Tana and Mubu. It combines a keyboard-first outline editor, SQLite storage, Markdown/OPML import-export, a CLI, and an MCP server for LLM clients.

## Quick Start

```bash
npm install
npm run dev
```

- Web app: `http://127.0.0.1:5173`
- API server: `http://127.0.0.1:4317`
- Default database: `./data/openoutliner.sqlite`

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

## Data Model

The first version uses a single-parent tree with lightweight tags and typed fields. Full graph references, cloud sync, and rich attachments are intentionally deferred.
