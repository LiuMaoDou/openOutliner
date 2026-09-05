import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type ViteDevServer } from "vite";
import viteConfig from "../vite.config";

const directory = mkdtempSync(join(tmpdir(), "oo-proxy-"));
let api: ChildProcess;
let web: ViteDevServer;
let url: string;

beforeAll(async () => {
  api = spawn(process.execPath, ["--import", "tsx", "src/backend/server/index.ts"], {
    env: { ...process.env, OPENOUTLINER_PORT: "0", OPENOUTLINER_DB: join(directory, "test.sqlite"), OPENOUTLINER_PASSWORD: "proxy-test-password", NODE_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const target = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("API startup timed out")), 10000);
    api.once("exit", code => { clearTimeout(timer); reject(new Error(`API exited ${code}`)); });
    api.stdout!.on("data", chunk => {
      const match = String(chunk).match(/http:\/\/127\.0\.0\.1:\d+/);
      if (match) { clearTimeout(timer); resolve(match[0]); }
    });
  });
  const proxy = viteConfig.server!.proxy!["/api"];
  web = await createServer({
    configFile: false,
    server: { port: 0, host: "127.0.0.1", proxy: { "/api": { ...(typeof proxy === "string" ? { target: proxy, changeOrigin: true } : proxy), target } } }
  });
  await web.listen();
  const address = web.httpServer!.address();
  if (!address || typeof address === "string") throw new Error("Missing Vite server address");
  url = `http://127.0.0.1:${address.port}`;
}, 20000);

afterAll(async () => {
  await web?.close();
  if (api && api.exitCode === null) {
    const ended = new Promise(resolve => api.once("exit", resolve));
    api.kill();
    await ended;
  }
  rmSync(directory, { recursive: true, force: true });
});

it("logs in and uploads through the dev proxy while rejecting foreign origins", async () => {
  const login = await fetch(`${url}/api/login`, {
    method: "POST", headers: { origin: url, "content-type": "application/json" }, body: JSON.stringify({ password: "proxy-test-password" })
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const push = await fetch(`${url}/api/sync`, { method: "POST", headers: { origin: url, cookie, "content-type": "application/json" }, body: '{"changes":[]}' });
  expect(push.status).toBe(200);
  expect((await push.json()).version).toBe(1);
  const foreign = await fetch(`${url}/api/sync`, { method: "POST", headers: { origin: "https://foreign.example", cookie }, body: '{"changes":[]}' });
  expect(foreign.status).toBe(403);
});
