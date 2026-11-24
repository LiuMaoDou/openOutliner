import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "oo-auth-"));
const servers: ChildProcess[] = [];
let url: string;

async function startServer(name: string, password: string, environment = "test"): Promise<string> {
  const server = spawn(process.execPath, ["--import", "tsx", "src/backend/server/index.ts"], {
    env: { ...process.env, OPENOUTLINER_HOST: "127.0.0.1", OPENOUTLINER_PORT: "0", OPENOUTLINER_DB: join(directory, `${name}.sqlite`), OPENOUTLINER_PASSWORD: password, NODE_ENV: environment }, stdio: ["ignore", "pipe", "pipe"]
  });
  servers.push(server);
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server startup timed out")), 10000);
    server.once("exit", code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
    server.stdout!.on("data", chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve(match[0]); } });
  });
}

beforeAll(async () => {
  url = await startServer("with-password", "test-password-only");
});
afterAll(async () => {
  await Promise.all(servers.map(async server => {
    if (server.exitCode !== null) return;
    const ended = new Promise(resolve => server.once("exit", resolve));
    server.kill();
    await ended;
  }));
  rmSync(directory, { recursive: true, force: true });
});
it("requires login, sets an HttpOnly session, and rejects cross-origin writes", async () => {
  expect((await fetch(`${url}/api/sync`)).status).toBe(401);
  expect((await fetch(`${url}/api/login`, { method: "POST", body: JSON.stringify({ password: "wrong" }) })).status).toBe(401);
  const login = await fetch(`${url}/api/login`, { method: "POST", body: JSON.stringify({ password: "test-password-only" }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly"); expect(cookie).toContain("SameSite=Strict");
  const headers = { cookie: cookie.split(";")[0] };
  const response = await fetch(`${url}/api/sync`, { headers });
  expect(response.status).toBe(200); expect((await response.json()).version).toBe(1);
  expect((await fetch(`${url}/api/sync`, { method: "POST", headers: { ...headers, origin: "https://other.example" }, body: '{"changes":[]}' })).status).toBe(403);
  expect((await fetch(`${url}/api/sync`, { method: "POST", headers: { ...headers, origin: url }, body: '{"changes":[]}' })).status).toBe(200);
});

it("serves cache recovery outside the offline shell without exposing private data", async () => {
  const response = await fetch(`${url}/api/app-recovery?t=1`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(response.headers.get("cache-control")).toBe("no-store");
  const html = await response.text();
  expect(html).toContain("更新应用缓存并重新打开");
  expect(html).not.toContain("indexedDB.deleteDatabase");
  const info = await fetch(`${url}/api/app-version?t=1`);
  expect(info.status).toBe(200);
  expect(Object.keys(await info.json()).sort()).toEqual(["build", "parentValidationFixed", "ready"]);
  expect((await fetch(`${url}/api/sync`)).status).toBe(401);
});

it("limits passwordless API access to direct loopback development requests", async () => {
  const local = await startServer("without-password", "");
  expect((await fetch(`${local}/api/sync`)).status).toBe(200);
  expect((await fetch(`${local}/api/sync`, { headers: { "x-forwarded-proto": "https" } })).status).toBe(401);
  const proxyStatus = await new Promise<number | undefined>((resolve, reject) => {
    request(`${local}/api/sync`, { headers: { host: "hosted.example" } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject).end();
  });
  expect(proxyStatus).toBe(401);
  const login = await fetch(`${local}/api/login`, { method: "POST", headers: { "x-forwarded-proto": "https" }, body: "{}" });
  expect(login.status).toBe(503);
  expect(login.headers.get("set-cookie")).toBeNull();

  const production = await startServer("production-without-password", "", "production");
  expect((await fetch(`${production}/api/sync`)).status).toBe(401);
  expect((await fetch(`${production}/api/app-version`)).status).toBe(200);
});
