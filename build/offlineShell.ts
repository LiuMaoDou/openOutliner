import { createHash } from "node:crypto";
import type { OutputBundle } from "rollup";
import type { Plugin } from "vite";

export function offlineAssets(bundle: OutputBundle): { shell: string[]; assets: string[] } {
  const shell = new Set(["/", "/manifest.webmanifest", "/person/飞机.png"]);
  const visit = (name: string) => {
    if (shell.has(`/${name}`)) return;
    const entry = bundle[name];
    if (!entry) return;
    shell.add(`/${name}`);
    if (entry.type === "chunk") entry.imports.forEach(visit);
  };
  for (const [name, entry] of Object.entries(bundle)) {
    if ((entry.type === "chunk" && entry.isEntry) || /\.(css|wasm)$/.test(name)) visit(name);
  }
  return {
    shell: [...shell],
    assets: [...new Set([...shell, ...Object.keys(bundle).filter(name => !name.endsWith(".map")).map(name => `/${name}`)])]
  };
}

export function serviceWorkerSource(version: string, shell: string[], assets: string[]): string {
  return `
const CACHE = "openoutliner-shell-${version}";
const SHELL = ${JSON.stringify(shell)};
const ASSETS = new Set(${JSON.stringify(assets)}.map(path => new URL(path, self.location.origin).href));
const assetKey = request => {
  const url = new URL(typeof request === "string" ? request : request.url, self.location.origin);
  url.search = "";
  return url.href;
};
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)));
  // Keep the default waiting phase: open tabs retain their worker and cache.
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    // Activation happens after the previous worker has no remaining clients.
    for (const name of await caches.keys()) {
      if (name.startsWith("openoutliner-") && name !== CACHE) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener("message", event => {
  if (event.data?.type !== "CACHE_VISITED_ASSETS" || !Array.isArray(event.data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = [...new Set(event.data.urls.filter(url => typeof url === "string").map(assetKey))].filter(url => ASSETS.has(url));
    // Cache fonts and icons loaded before the first worker took control.
    await Promise.all(urls.map(async url => {
      try {
        if (await cache.match(url)) return;
        const response = await fetch(url);
        if (response.ok) await cache.put(url, response);
      } catch { /* Optional assets must not prevent offline startup. */ }
    }));
  })());
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  const navigation = event.request.mode === "navigate";
  const key = navigation ? "/" : assetKey(event.request);
  if (!navigation && !ASSETS.has(key)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(key);
    if (cached) return cached;
    const response = await fetch(event.request);
    if (response.ok) {
      event.waitUntil(cache.put(key, response.clone()).catch(() => {}));
    }
    return response;
  })());
});
`;
}

export function offlineShell(): Plugin {
  return {
    name: "offline-shell",
    generateBundle(_options, bundle) {
      const { shell, assets } = offlineAssets(bundle);
      const hash = createHash("sha256");
      for (const [name, entry] of Object.entries(bundle).sort(([left], [right]) => left.localeCompare(right))) {
        hash.update(name).update("\0").update(entry.type === "chunk" ? entry.code : entry.source).update("\0");
      }
      const version = hash.digest("hex").slice(0, 16);
      this.emitFile({ type: "asset", fileName: "sw.js", source: serviceWorkerSource(version, shell, assets) });
    }
  };
}
