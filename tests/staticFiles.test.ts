import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { staticFile } from "../src/backend/server/staticFiles.js";

it("serves encoded Chinese font paths and keeps missing assets out of the HTML cache", () => {
  const directory = mkdtempSync(join(tmpdir(), "oo-static-"));
  try {
    const web = join(directory, "web");
    mkdirSync(join(web, "assets"), { recursive: true });
    mkdirSync(join(directory, "web-outside"));
    writeFileSync(join(web, "index.html"), "app shell");
    writeFileSync(join(web, "assets", "中文字体-hash.woff2"), "font");
    writeFileSync(join(directory, "web-outside", "private.txt"), "private");
    expect(staticFile(web, `/assets/${encodeURIComponent("中文字体-hash.woff2")}`)).toEqual({ path: join(web, "assets", "中文字体-hash.woff2"), immutable: true });
    expect(staticFile(web, "/assets/missing.js")).toBeUndefined();
    expect(staticFile(web, "/missing.woff2")).toBeUndefined();
    expect(staticFile(web, "/%2e%2e/web-outside/private.txt")).toBeUndefined();
    expect(staticFile(web, "/%E0%A4%A")).toBeUndefined();
    expect(staticFile(web, "/")).toEqual({ path: join(web, "index.html"), immutable: false });
    expect(staticFile(web, "/assets/%2e%2e%2findex.html")).toEqual({ path: join(web, "index.html"), immutable: false });
    expect(staticFile(web, "/outline/deep-link")).toEqual({ path: join(web, "index.html"), immutable: false });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
