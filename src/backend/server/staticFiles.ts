import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";

export function staticFile(directory: string, pathname: string): { path: string; immutable: boolean } | undefined {
  let requested: string;
  try { requested = decodeURIComponent(pathname); }
  catch { return undefined; }
  const root = resolve(directory);
  const target = join(root, requested === "/" ? "index.html" : requested);
  if (!target.startsWith(`${root}${sep}`)) return undefined;
  const isFile = (path: string) => existsSync(path) && statSync(path).isFile();
  if (isFile(target)) return { path: target, immutable: target.startsWith(`${join(root, "assets")}${sep}`) };
  // Never respond with HTML for a missing JS, image, or font request.
  if (extname(requested) || requested.startsWith("/assets/")) return undefined;
  const index = join(root, "index.html");
  return isFile(index) ? { path: index, immutable: false } : undefined;
}
