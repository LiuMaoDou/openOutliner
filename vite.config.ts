import { createHash } from "node:crypto";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), {
    name: "offline-shell",
    generateBundle(_options, bundle) {
      const assets = Object.keys(bundle).filter(name => !name.endsWith(".map")).map(name => `/${name}`);
      const version = createHash("sha256").update(JSON.stringify(Object.values(bundle).map(entry => entry.type === "chunk" ? entry.code : entry.source))).digest("hex").slice(0, 16);
      this.emitFile({ type: "asset", fileName: "sw.js", source: `
const CACHE = "openoutliner-${version}";
const ASSETS = ${JSON.stringify(["/", "/manifest.webmanifest", "/person/飞机.png", ...assets])};
self.addEventListener("install", event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS))));
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  event.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(event.request.mode === "navigate" ? "/" : event.request);
    if (cached) return cached;
    return fetch(event.request);
  }));
});
` });
    }
  }],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:4317"
    }
  },
  build: {
    outDir: "dist/web",
    emptyOutDir: false,
    sourcemap: true
  }
});
