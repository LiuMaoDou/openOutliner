# Repository Guidelines

## Project Structure & Module Organization

OpenOutliner is a local-first outline notes app with a React web UI, Node backend, CLI, and MCP server. Source lives in `src/`: `src/web/` contains the Vite/React app, `src/backend/server/` exposes the local API, `src/backend/services/` holds outline business logic, `src/backend/db/` owns SQLite setup, `src/backend/importExport/` handles Markdown/OPML, and `src/backend/cli/` plus `src/backend/mcp/` expose automation entry points. Tests live in `tests/`. Local runtime data defaults to `data/openoutliner.sqlite`.

## Build, Test, and Development Commands

- `npm install`: install dependencies; Node `>=25.0.0` is required.
- `npm run dev`: run API and web dev servers together. Web defaults to `http://127.0.0.1:5173`, API to `http://127.0.0.1:4317`.
- `npm run server`: run only the backend API with `tsx`.
- `npm run cli -- workspace list`: run CLI commands locally.
- `npm run mcp`: start the MCP server.
- `npm run typecheck`: type-check backend and web projects.
- `npm test`: run Vitest tests.
- `npm run build`: build server output and production web assets.

## Coding Style & Naming Conventions

Use TypeScript and ES modules. Keep two-space indentation, double quotes, semicolons omitted, and concise named exports consistent with existing files. React components use `PascalCase`; functions, variables, and service methods use `camelCase`; test files use `*.test.ts`. Prefer existing service APIs and structured parsers over ad hoc string handling.

## Testing Guidelines

Vitest is the test runner. Add or update tests in `tests/` for service behavior, migrations, and import/export changes. Keep tests isolated with temporary SQLite databases, following `tests/outliner.test.ts`. Run `npm test` before committing; run `npm run typecheck` when TypeScript or API contracts change.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit style, for example `feat: add dark theme and node dragging` and `fix: make node moving reliable`. Keep commits focused and in English. Pull requests should include a short summary, validation commands run, linked issues when applicable, and screenshots or short recordings for UI changes.

## Security & Configuration Tips

Do not commit local databases, secrets, or generated runtime data from `data/`. Treat SQLite files as local state. Keep MCP and API changes local-first unless a change explicitly introduces remote access.
