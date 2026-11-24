export interface AppUpdateStatus {
  current: string;
  server: string | null;
  available: boolean;
  waiting: boolean;
  checking: boolean;
  applying: boolean;
  error?: string;
}
function runningBuild() {
  if (typeof document === "undefined") return "development";
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]');
  return script ? new URL(script.src).pathname.split("/").pop()! : "development";
}
let status: AppUpdateStatus = { current: runningBuild(), server: null, available: false, waiting: false, checking: false, applying: false };
const subscribers = new Set<() => void>();
const barriers = new Set<() => Promise<unknown>>();
let registration: ServiceWorkerRegistration | undefined;
let lastCheck = 0;
export const subscribeAppUpdates = (fn: () => void) => { subscribers.add(fn); return () => { subscribers.delete(fn); }; };
export const getAppUpdateStatus = () => status;
export const registerUpdateBarrier = (fn: () => Promise<unknown>) => { barriers.add(fn); return () => { barriers.delete(fn); }; };
const report = (patch: Partial<AppUpdateStatus>) => { status = { ...status, ...patch }; subscribers.forEach(fn => fn()); };

export function hasAppUpdate(current: string, server: string | null, waiting: boolean): boolean {
  return waiting || Boolean(server && current !== "development" && current !== server);
}
function refreshWaiting() {
  const waiting = Boolean(registration?.waiting);
  report({ waiting, available: hasAppUpdate(status.current, status.server, waiting) });
}

export function observeAppUpdates(next: ServiceWorkerRegistration) {
  if (registration === next) return;
  registration = next;
  const watch = () => {
    refreshWaiting();
    const installing = next.installing;
    if (installing) installing.addEventListener("statechange", refreshWaiting);
  };
  next.addEventListener("updatefound", watch);
  watch();
  const resume = () => {
    if (document.visibilityState === "visible" && Date.now() - lastCheck > 60000) void checkAppUpdate();
  };
  window.addEventListener("online", resume);
  window.addEventListener("focus", resume);
  void checkAppUpdate();
}

export async function checkAppUpdate(): Promise<void> {
  if (status.checking || status.applying) return;
  lastCheck = Date.now();
  report({ checking: true, error: undefined });
  try {
    const response = await fetch("/api/app-version", { cache: "no-store", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("无法检查服务器版本，请检查网络后重试。");
    const info: unknown = await response.json();
    if (!info || typeof info !== "object" || !("build" in info) || typeof info.build !== "string") throw new Error("服务器尚未提供有效构建版本。");
    report({ server: info.build });
    await registration?.update();
    refreshWaiting();
  } catch (error) {
    report({ error: error instanceof Error ? error.message : "检查更新失败。" });
  } finally { report({ checking: false }); }
}

/** Never force other tabs onto a worker/cache incompatible with their running code. */
export function requestUpdateActivation(worker: Pick<ServiceWorker, "postMessage">, timeoutMs = 10000): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const finish = (error?: Error) => {
      clearTimeout(timer); channel.port1.close(); channel.port2.close();
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error("更新确认超时，请关闭其他窗口后重试；本机数据未清除。")), timeoutMs);
    channel.port1.onmessage = event => {
      if (event.data?.ok === true) finish();
      else finish(new Error(event.data?.error || "请关闭此网站的其他标签页或独立窗口后再更新。"));
    };
    try { worker.postMessage({ type: "ACTIVATE_UPDATE" }, [channel.port2]); }
    catch (error) { finish(error instanceof Error ? error : new Error("无法启动更新。")); }
  });
}

export async function applyAppUpdate(prepare: () => Promise<void>): Promise<void> {
  if (status.applying) return;
  const waiting = registration?.waiting;
  if (!waiting) { report({ error: "尚无可切换的新版本，请先检查更新；其他窗口关闭后新版本也可正常激活。" }); return; }
  report({ applying: true, error: undefined });
  const root = document.getElementById("root"), wasInert = root?.inert ?? false;
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  if (root) root.inert = true;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let changed: (() => void) | undefined;
  try {
    await Promise.all([...barriers].map(fn => fn()));
    await prepare(); // Durable drafts and pending local writes must settle before activation.
    const controller = navigator.serviceWorker.controller;
    const activated = new Promise<void>((resolve, reject) => {
      changed = () => { if (navigator.serviceWorker.controller !== controller) resolve(); };
      navigator.serviceWorker.addEventListener("controllerchange", changed);
      timeout = setTimeout(() => reject(new Error("新版本尚未接管页面，请稍后重试；数据保留在本机。")), 10000);
    });
    // Attach a rejection handler immediately, including when activation is refused.
    void activated.catch(() => {});
    await requestUpdateActivation(waiting);
    await activated;
    location.reload();
  } catch (error) {
    report({ error: error instanceof Error ? error.message : "更新失败，本机数据未改动。" });
  } finally {
    clearTimeout(timeout);
    if (changed) navigator.serviceWorker.removeEventListener("controllerchange", changed);
    if (root) root.inert = wasInert;
    report({ applying: false });
    refreshWaiting();
  }
}
