import { appRecoveryHtml, webBuildInfo } from "./appRecovery.js";
import { staticFile } from "./staticFiles.js";
import { dispatch } from "../shared/dispatch.js";
import { SyncService } from "../services/sync.js";
import { SyncUploadStore } from "./syncUploads.js";
import { DIRECT_SYNC_BYTES, SYNC_CHUNK_BYTES } from "../shared/uploadLimits.js";
import { SyncConflict } from "../shared/sync.js";
import { startWeChatReminders } from "../services/wechatReminders.js";
import { authorized, login } from "./auth.js";
import { readTranslationSettings, translateToEnglish, TranslationError } from "./translation.js";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { openDatabase } from "../db/database.js";
import { NotFoundError, OutlinerService, ValidationError } from "../services/outliner.js";

const port = Number(process.env.OPENOUTLINER_PORT ?? 4317);
const db = openDatabase();
const service = new OutlinerService(db);
const sync = new SyncService(db);
const syncUploads = new SyncUploadStore();
const host = process.env.OPENOUTLINER_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(host) && !process.env.OPENOUTLINER_PASSWORD) throw new Error("Set OPENOUTLINER_PASSWORD before enabling remote access.");
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
      const path = new URL(req.url, "http://localhost").pathname;
      // Public diagnostics contain only build information, never outline data.
      if (req.method === "GET" && path === "/api/app-version") {
        sendJson(res, webBuildInfo(resolve(process.cwd(), "dist", "web"))); return;
      }
      if (req.method === "GET" && path === "/api/app-recovery") {
        res.setHeader("x-frame-options", "DENY");
        sendText(res, appRecoveryHtml, "text/html; charset=utf-8"); return;
      }
      if (req.method !== "GET" && req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) {
        sendJson(res, { error: "Origin not allowed" }, 403); return;
      }
      if (req.url === "/api/login" && req.method === "POST") {
        login(req, res, await readJson(req)); return;
      }
      if (!authorized(req)) { sendJson(res, { error: "请登录后同步" }, 401); return; }
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

server.listen(port, host, () => {
  const address = server.address();
  console.log(`OpenOutliner API listening on http://${host}:${typeof address === "object" && address ? address.port : port}`);
  const stopReminders = startWeChatReminders(db, process.env.XTUIS_TOKEN);
  server.once("close", stopReminders);
  server.once("close", () => syncUploads.dispose());
});

async function routeApi(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const path = url.pathname;
  const method = req.method ?? "GET";

  if (method === "POST" && path === "/api/sync/uploads") {
    sendJson(res, syncUploads.start(await readJson(req)), 201); return;
  }
  const staged = path.match(/^\/api\/sync\/uploads\/([0-9a-f-]{36})\/(\d+|commit|abort)$/);
  if (method === "POST" && staged) {
    const [, id, action] = staged;
    if (action === "abort") { syncUploads.abort(id); sendJson(res, { ok: true }); return; }
    if (action === "commit") {
      const full = sync.push(syncUploads.finish(id));
      sendJson(res, url.searchParams.get("incremental") === "1" ? sync.incremental(full, url.searchParams.get("baseRevision")) : full);
      return;
    }
    sendJson(res, syncUploads.append(id, Number(action), await readBody(req, SYNC_CHUNK_BYTES)));
    return;
  }

  if (path === "/api/sync" && (method === "GET" || method === "POST")) {
    const full = method === "GET" ? sync.pull() : sync.push(await readJson(req));
    const result = url.searchParams.get("incremental") === "1"
      ? sync.incremental(full, url.searchParams.get("baseRevision"))
      : full;
    sendJson(res, result); return;
  }
  if (path === "/api/translation/english" && method === "POST") {
    const translated = await translateToEnglish(await readJson(req), await readTranslationSettings());
    sendJson(res, { text: translated });
    return;
  }
  const result = dispatch(service, method, req.url ?? "/", method === "GET" ? {} : await readJson(req));
  if (path.startsWith("/api/export/")) sendText(res, result, path.endsWith("opml") ? "application/xml; charset=utf-8" : "text/markdown; charset=utf-8");
  else {
    const created = method === "POST" && (/^\/api\/(nodes|workspaces|workspace-folders|tags|fields|field-values)$/.test(path) || /^\/api\/nodes\/[^/]+\/(tags|convert-to-workspace)$/.test(path));
    sendJson(res, result, created ? 201 : 200);
  }
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new ValidationError("Request exceeds byte limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const raw = (await readBody(req, DIRECT_SYNC_BYTES)).toString("utf8");
  try { return (raw ? JSON.parse(raw) : {}) as T; }
  catch { throw new ValidationError("Invalid JSON request"); }
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
  if (error instanceof SyncConflict) { sendJson(res, { error: error.message, current: error.current, conflicts: error.conflicts }, 409); return; }
  const status =
    error instanceof NotFoundError || error instanceof ValidationError || error instanceof TranslationError ? error.statusCode : 500;
  sendJson(
    res,
    {
      error: error instanceof Error ? error.message : "Unknown error"
    },
    status
  );
}

function setBaseHeaders(res: ServerResponse): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("access-control-allow-methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const distDir = resolve(process.cwd(), "dist", "web");
  const requested = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const asset = staticFile(distDir, requested);

  if (!asset) {
    sendJson(res, { error: "Web resource not found. Run npm run build:web if the app has not been built." }, 404);
    return;
  }

  res.writeHead(200, {
    "content-type": contentType(asset.path),
    "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-store"
  });
  createReadStream(asset.path).pipe(res);
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
    case ".wasm":
      return "application/wasm";
    case ".webmanifest":
      return "application/manifest+json";
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
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
