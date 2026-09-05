import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const directory = mkdtempSync(join(tmpdir(), "oo-auth-"));
let server: ChildProcess;
let url: string;
beforeAll(async () => {
  server = spawn(process.execPath, ["--import", "tsx", "src/backend/server/index.ts"], {
    env: { ...process.env, OPENOUTLINER_PORT: "0", OPENOUTLINER_DB: join(directory, "test.sqlite"), OPENOUTLINER_PASSWORD: "test-password-only", NODE_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"]
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server startup timed out")), 10000);
    server.once("exit", code => { clearTimeout(timer); reject(new Error(`server exited ${code}`)); });
    server.stdout!.on("data", chunk => { const match = String(chunk).match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match) { url = match[0]; clearTimeout(timer); resolve(); } });
  });
});
afterAll(async () => {
  if (server && server.exitCode === null) { const ended = new Promise(resolve => server.once("exit", resolve)); server.kill(); await ended; }
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
