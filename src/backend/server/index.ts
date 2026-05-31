import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { openDatabase } from "../db/database.js";
import { exportMarkdown, importMarkdown } from "../importExport/markdown.js";
import { exportOpml, importOpml } from "../importExport/opml.js";
import { NotFoundError, OutlinerService, ValidationError } from "../services/outliner.js";

const port = Number(process.env.OPENOUTLINER_PORT ?? 4317);
const db = openDatabase();
const service = new OutlinerService(db);
service.ensureSeedData();

const server = createServer(async (req, res) => {
  setBaseHeaders(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (req.url?.startsWith("/api/")) {
      await routeApi(req, res);
      return;
    }
    if (servePersonAsset(req, res)) {
      return;
    }
    serveStatic(req, res);
  } catch (error) {
    sendError(res, error);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`OpenOutliner API listening on http://127.0.0.1:${port}`);
});

async function routeApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && path === "/api/health") {
    sendJson(res, { ok: true });
    return;
  }

  if (method === "GET" && path === "/api/workspaces") {
    sendJson(res, service.listWorkspaces());
    return;
  }

  if (method === "POST" && path === "/api/workspaces") {
    const body = await readJson<{ name?: string; icon?: string }>(req);
    sendJson(res, service.createWorkspace(body.name?.trim() || "Untitled Workspace", body.icon), 201);
    return;
  }

  const workspaceTreeMatch = path.match(/^\/api\/workspaces\/([^/]+)\/tree$/);
  if (method === "GET" && workspaceTreeMatch) {
    const workspace = service.getWorkspace(workspaceTreeMatch[1]);
    sendJson(res, service.getTree(workspace.rootNodeId));
    return;
  }

  const workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)$/);
  if (method === "PATCH" && workspaceMatch) {
    sendJson(res, service.updateWorkspace(workspaceMatch[1], await readJson(req)));
    return;
  }
  if (method === "DELETE" && workspaceMatch) {
    sendJson(res, service.deleteWorkspace(workspaceMatch[1]));
    return;
  }

  const nodeChildrenMatch = path.match(/^\/api\/nodes\/([^/]+)\/children$/);
  if (method === "GET" && nodeChildrenMatch) {
    sendJson(res, service.listChildren(nodeChildrenMatch[1]));
    return;
  }

  const nodeMatch = path.match(/^\/api\/nodes\/([^/]+)$/);
  if (method === "GET" && nodeMatch) {
    sendJson(res, service.getNode(nodeMatch[1]));
    return;
  }
  if (method === "PATCH" && nodeMatch) {
    sendJson(res, service.updateNode(nodeMatch[1], await readJson(req)));
    return;
  }
  if (method === "DELETE" && nodeMatch) {
    sendJson(res, service.deleteNode(nodeMatch[1]));
    return;
  }

  if (method === "POST" && path === "/api/nodes") {
    sendJson(res, service.createNode(await readJson(req)), 201);
    return;
  }

  const moveMatch = path.match(/^\/api\/nodes\/([^/]+)\/move$/);
  if (method === "POST" && moveMatch) {
    const body = await readJson<{ parentId: string; position?: number }>(req);
    sendJson(res, service.moveNode(moveMatch[1], body.parentId, body.position));
    return;
  }

  if (method === "GET" && path === "/api/search") {
    sendJson(
      res,
      service.searchNodes(url.searchParams.get("q") ?? "", url.searchParams.get("workspaceId") ?? undefined)
    );
    return;
  }

  if (method === "GET" && path === "/api/tags") {
    const workspaceId = requiredParam(url, "workspaceId");
    sendJson(res, service.listTags(workspaceId));
    return;
  }

  if (method === "POST" && path === "/api/tags") {
    const body = await readJson<{ workspaceId: string; name: string; color?: string }>(req);
    sendJson(res, service.createTag(body.workspaceId, body.name, body.color), 201);
    return;
  }

  const tagMatch = path.match(/^\/api\/tags\/([^/]+)$/);
  if (method === "PATCH" && tagMatch) {
    sendJson(res, service.updateTag(tagMatch[1], await readJson(req)));
    return;
  }
  if (method === "DELETE" && tagMatch) {
    sendJson(res, service.deleteTag(tagMatch[1]));
    return;
  }

  const nodeTagsMatch = path.match(/^\/api\/nodes\/([^/]+)\/tags$/);
  if (method === "POST" && nodeTagsMatch) {
    const body = await readJson<{ name: string }>(req);
    sendJson(res, service.setNodeTag(nodeTagsMatch[1], body.name), 201);
    return;
  }

  if (method === "GET" && path === "/api/fields") {
    sendJson(res, service.listFieldDefinitions(requiredParam(url, "workspaceId")));
    return;
  }

  if (method === "POST" && path === "/api/fields") {
    sendJson(res, service.createFieldDefinition(await readJson(req)), 201);
    return;
  }

  if (method === "POST" && path === "/api/field-values") {
    const body = await readJson<{ nodeId: string; fieldId: string; value: string }>(req);
    sendJson(res, service.setFieldValue(body.nodeId, body.fieldId, body.value), 201);
    return;
  }

  if (method === "POST" && path === "/api/import/markdown") {
    sendJson(res, importMarkdown(service, await readJson(req)));
    return;
  }

  if (method === "GET" && path === "/api/export/markdown") {
    sendText(res, exportMarkdown(service, requiredParam(url, "workspaceId")), "text/markdown; charset=utf-8");
    return;
  }

  if (method === "POST" && path === "/api/import/opml") {
    sendJson(res, importOpml(service, await readJson(req)));
    return;
  }

  if (method === "GET" && path === "/api/export/opml") {
    sendText(res, exportOpml(service, requiredParam(url, "workspaceId")), "application/xml; charset=utf-8");
    return;
  }

  throw new NotFoundError(`Route not found: ${method} ${path}`);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return (raw ? JSON.parse(raw) : {}) as T;
}

function sendJson(res: ServerResponse, payload: unknown, status = 200): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload, null, 2));
}

function sendText(res: ServerResponse, payload: string, contentType: string, status = 200): void {
  res.writeHead(status, { "content-type": contentType });
  res.end(payload);
}

function sendError(res: ServerResponse, error: unknown): void {
  const status =
    error instanceof NotFoundError || error instanceof ValidationError ? error.statusCode : 500;
  sendJson(
    res,
    {
      error: error instanceof Error ? error.message : "Unknown error"
    },
    status
  );
}

function setBaseHeaders(res: ServerResponse): void {
  res.setHeader("access-control-allow-origin", "http://127.0.0.1:5173");
  res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function requiredParam(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new ValidationError(`Missing required query param: ${name}`);
  return value;
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const distDir = resolve(process.cwd(), "dist", "web");
  const requested = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const target = requested === "/" ? join(distDir, "index.html") : join(distDir, requested);
  const safeTarget = target.startsWith(distDir) && existsSync(target) ? target : join(distDir, "index.html");

  if (!existsSync(safeTarget) || !statSync(safeTarget).isFile()) {
    sendJson(res, { error: "Web build not found. Run npm run build:web or npm run web:dev." }, 404);
    return;
  }

  res.writeHead(200, { "content-type": contentType(safeTarget) });
  createReadStream(safeTarget).pipe(res);
}

function servePersonAsset(req: IncomingMessage, res: ServerResponse): boolean {
  const requested = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (!requested.startsWith("/person/")) return false;

  const assetDir = resolve(process.cwd(), "person");
  const relativePath = decodeURIComponent(requested.slice("/person/".length));
  const target = resolve(assetDir, relativePath);

  const insideAssetDir = target === assetDir || target.startsWith(`${assetDir}${sep}`);
  if (!insideAssetDir || !existsSync(target) || !statSync(target).isFile()) {
    sendJson(res, { error: "Asset not found." }, 404);
    return true;
  }

  res.writeHead(200, {
    "content-type": contentType(target),
    "cache-control": "public, max-age=31536000, immutable"
  });
  createReadStream(target).pipe(res);
  return true;
}

function contentType(filePath: string): string {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".otf":
      return "font/otf";
    case ".ttf":
      return "font/ttf";
    default:
      return "application/octet-stream";
  }
}
