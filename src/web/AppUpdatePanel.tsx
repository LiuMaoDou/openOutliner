import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { applyAppUpdate, checkAppUpdate, getAppUpdateStatus, subscribeAppUpdates } from "./appUpdates";
import { prepareForAppUpdate } from "./offline";

export function AppUpdatePanel({ busy = false }: { busy?: boolean }) {
  const update = useSyncExternalStore(subscribeAppUpdates, getAppUpdateStatus);
  return <section className="appUpdateDetails" aria-label="应用版本与更新">
    <strong>应用版本</strong>
    <small>当前：{update.current}</small>
    <small>服务器：{update.server ?? "尚未检查"}</small>
    {update.available && <p role="status">有新版本可用。先保存本机数据，再切换版本；不会清除笔记。</p>}
    {update.error && <p role="alert">{update.error}</p>}
    <button type="button" disabled={busy || update.checking || update.applying} onClick={() => void checkAppUpdate()}>{update.checking ? "正在检查…" : "检查更新"}</button>
    {update.waiting && <button type="button" disabled={busy || update.applying} onClick={() => void applyAppUpdate(prepareForAppUpdate)}>保存并更新应用</button>}
  </section>;
}

export function AppUpdateProgress() {
  const update = useSyncExternalStore(subscribeAppUpdates, getAppUpdateStatus);
  return update.applying ? createPortal(<div className="appUpdateOverlay" role="alertdialog" aria-modal="true" aria-label="正在安全更新应用">
    <p>正在保存本机数据并切换应用版本，请勿关闭页面。</p>
  </div>, document.body) : null;
}
