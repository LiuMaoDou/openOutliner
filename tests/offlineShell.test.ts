import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";
import type { OutputBundle } from "rollup";
import { offlineAssets, serviceWorkerSource } from "../build/offlineShell";

it("precaches the entry dependency graph and SQL runtime without every lazy icon or font", () => {
  const bundle = {
    "assets/main.js": { type: "chunk", isEntry: true, imports: ["assets/shared.js"], dynamicImports: ["assets/icon.js"] },
    "assets/shared.js": { type: "chunk", isEntry: false, imports: [] },
    "assets/icon.js": { type: "chunk", isEntry: false, imports: [] },
    "assets/main.css": { type: "asset" },
    "assets/sql.wasm": { type: "asset" },
    "assets/cjk.woff2": { type: "asset" },
    "assets/main.js.map": { type: "asset" }
  } as unknown as OutputBundle;
  const { shell, assets } = offlineAssets(bundle);
  expect(shell).toEqual(expect.arrayContaining(["/", "/assets/main.js", "/assets/shared.js", "/assets/main.css", "/assets/sql.wasm"]));
  expect(shell).not.toContain("/assets/icon.js");
  expect(shell).not.toContain("/assets/cjk.woff2");
  expect(assets).toContain("/assets/icon.js");
  expect(assets).toContain("/assets/cjk.woff2");
  expect(assets).not.toContain("/assets/main.js.map");
});

function workerHarness() {
  const handlers = new Map<string, (event: any) => void>();
  const entries = new Map<string, string>();
  const cachesByName = new Map<string, unknown>([["openoutliner-old-version", {}], ["unrelated-cache", {}]]);
  const requestKey = (request: string | Request) => new URL(typeof request === "string" ? request : request.url, "https://outline.test").href;
  const cache = {
    addAll: vi.fn(async (urls: string[]) => { urls.forEach(url => entries.set(requestKey(url), "shell")); }),
    match: vi.fn(async (request: string | Request) => entries.has(requestKey(request)) ? new Response(entries.get(requestKey(request))) : undefined),
    put: vi.fn(async (request: string | Request, response: Response) => { entries.set(requestKey(request), await response.text()); })
  };
  const fetch = vi.fn(async () => new Response("downloaded"));
  const skipWaiting = vi.fn();
  runInContext(serviceWorkerSource("new-version", ["/", "/assets/main.js"], ["/", "/assets/main.js", "/assets/icon.js", "/assets/cjk.woff2"]), createContext({
    URL, Set, Promise, fetch,
    self: { location: { origin: "https://outline.test" }, addEventListener: (name: string, handler: any) => handlers.set(name, handler), clients: { claim: vi.fn() }, skipWaiting },
    caches: {
      open: async (name: string) => { cachesByName.set(name, cache); return cache; },
      keys: async () => [...cachesByName.keys()],
      delete: async (name: string) => cachesByName.delete(name)
    }
  }));
  async function dispatch(name: string, data: Record<string, unknown> = {}) {
    const pending: Promise<unknown>[] = [];
    let response: Promise<Response> | undefined;
    handlers.get(name)!({ ...data, waitUntil: (promise: Promise<unknown>) => pending.push(promise), respondWith: (promise: Promise<Response>) => { response = promise; } });
    const result = await response;
    await Promise.all(pending);
    return result;
  }
  return { dispatch, cache, cachesByName, fetch, skipWaiting, entries };
}

it("keeps the old cache throughout installation and cleans it only on normal activation", async () => {
  const worker = workerHarness();
  await worker.dispatch("install");
  expect(worker.skipWaiting).not.toHaveBeenCalled();
  expect(worker.cachesByName.has("openoutliner-old-version")).toBe(true);
  await worker.dispatch("activate");
  expect([...worker.cachesByName.keys()]).toEqual(["unrelated-cache", "openoutliner-shell-new-version"]);
});

it("keeps visited lazy assets available offline and never handles API traffic", async () => {
  const worker = workerHarness();
  await worker.dispatch("install");
  await worker.dispatch("message", { data: { type: "CACHE_VISITED_ASSETS", urls: ["https://outline.test/assets/cjk.woff2", "https://outline.test/api/sync", "https://other.test/assets/icon.js"] } });
  expect(worker.fetch).toHaveBeenCalledTimes(1);
  expect(await (await worker.dispatch("fetch", { request: new Request("https://outline.test/assets/icon.js") }))!.text()).toBe("downloaded");
  worker.fetch.mockRejectedValue(new Error("offline"));
  expect(await (await worker.dispatch("fetch", { request: new Request("https://outline.test/assets/icon.js") }))!.text()).toBe("downloaded");
  expect(await (await worker.dispatch("fetch", { request: new Request("https://outline.test/assets/cjk.woff2") }))!.text()).toBe("downloaded");
  expect(await worker.dispatch("fetch", { request: new Request("https://outline.test/api/sync") })).toBeUndefined();
});
