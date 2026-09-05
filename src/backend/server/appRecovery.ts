import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Inspect the deployed web bundle, rather than reporting the Node process's version.
export function webBuildInfo(directory: string) {
  const index = join(directory, "index.html");
  if (!existsSync(index)) return { ready: false, build: null, parentValidationFixed: false };
  const html = readFileSync(index, "utf8");
  const script = html.match(/<script[^>]+src="(\/assets\/[\w-]+\.js)"/)?.[1];
  if (!script || !existsSync(join(directory, script))) return { ready: false, build: null, parentValidationFixed: false };
  const source = readFileSync(join(directory, script), "utf8");
  return { ready: true, build: script.split("/").pop(), parentValidationFixed: source.includes("父级属于其他工作区") };
}

// /api/ is deliberately used: even the first released service worker bypasses it.
export const appRecoveryHtml = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenOutliner 应用更新</title>
<style>body{margin:0;background:#101114;color:#eee;font:15px/1.7 system-ui,sans-serif}main{max-width:560px;margin:8vh auto;padding:24px}h1{font-size:24px}section{padding:24px;border:1px solid #41454e;background:#24272d;border-radius:14px}button{font:inherit;padding:10px 16px;border:0;border-radius:8px;background:#dbe8ff;color:#17243a;cursor:pointer}button:disabled{opacity:.5;cursor:wait}a{color:#a9caff}code{overflow-wrap:anywhere}#status{white-space:pre-wrap}</style></head>
<body><main><h1>OpenOutliner 应用更新</h1><section>
<p>此页面直接连接服务器，用于解决更新后仍运行旧版应用的问题。</p>
<p id="version">正在检查服务器版本…</p><p id="status" role="status"></p>
<p>先关闭此网站的其他标签页或独立应用窗口，再点击下方按钮。只更新网页程序缓存；本机笔记、未同步修改和登录状态均保留。</p>
<button id="repair" disabled>更新应用缓存并重新打开</button><p><a href="/">返回应用</a></p>
</section></main><script>
const button = document.getElementById("repair"), status = document.getElementById("status");
async function check() {
  const response = await fetch("/api/app-version?t=" + Date.now(), { cache: "no-store" });
  if (!response.ok) throw new Error("无法检查服务器版本，请确认 Node 服务已更新并重启。");
  const info = await response.json();
  document.getElementById("version").textContent = "服务器前端构建：" + (info.build || "未找到生产构建");
  if (!info.ready || !info.parentValidationFixed) throw new Error("服务器前端尚未包含父级校验修复。请执行 npm run build，并确认网站指向本次构建的 dist/web 目录。");
  return info;
}
check().then(() => { status.textContent = "服务器已包含父级校验修复。"; button.disabled = false; }).catch(error => { status.textContent = error.message; });
button.addEventListener("click", async () => {
  button.disabled = true; status.textContent = "正在更新应用缓存…";
  try {
    await check();
    if ("serviceWorker" in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        const workers = [registration.active, registration.waiting, registration.installing].filter(Boolean);
        if (workers.some(worker => { const url = new URL(worker.scriptURL); return url.origin === location.origin && url.pathname === "/sw.js"; })) await registration.unregister();
      }
    }
    if ("caches" in window) {
      for (const name of await caches.keys()) if (name.startsWith("openoutliner-")) await caches.delete(name);
    }
    location.replace("/?app-reload=" + Date.now());
  } catch (error) { status.textContent = error.message || "更新失败，请确认网络连接后重试。"; button.disabled = false; }
});
</script></body></html>`;
