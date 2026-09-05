import { openLocal } from "./localDatabase";
import { migrate } from "../backend/shared/schema.js";
import { OutlinerService } from "../backend/services/outliner.js";
import { dispatch } from "../backend/shared/dispatch.js";
import { changesBetween, mergeChanges, replaceSnapshot, snapshot, type Snapshot } from "../backend/shared/sync.js";

interface Conflict { current: Snapshot; conflicts: string[] }
interface Backup { date: string; data: Snapshot }
interface Saved { bytes: Uint8Array; base: Snapshot; revision: string; conflict?: Conflict; backups: Backup[] }
interface Envelope { version: number; revision: string; data: Snapshot }
export interface SyncStatus { text: string; pending: number; needsLogin?: boolean; conflict?: string[]; error?: string; ready: boolean }
let status: SyncStatus = { text: "正在读取本机数据…", pending: 0, ready: false };
const listeners = new Set<() => void>();
export const subscribeSync = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getSyncStatus = () => status;
function report(next: Partial<SyncStatus>) { status = { ...status, ...next }; listeners.forEach(listener => listener()); }
let storage: Promise<IDBDatabase> | undefined;
function store() {
  return storage ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("openoutliner-offline-v1", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("无法打开本机数据库，请检查浏览器存储权限。"));
  });
}
async function read(): Promise<Saved | undefined> {
  const db = await store();
  return new Promise((resolve, reject) => {
    const request = db.transaction("state").objectStore("state").get("current");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function save(value: Saved): Promise<void> {
  const db = await store();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("state", "readwrite");
    tx.objectStore("state").put(value, "current");
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(new Error("保存到本机失败，请检查剩余空间；本次修改尚未保存。"));
  });
}
const locked = <T>(fn: () => Promise<T>) => {
  if (!navigator.locks) return Promise.reject(new Error("此浏览器不支持安全的离线存储，请使用新版浏览器并通过 HTTPS 访问。"));
  return navigator.locks.request("openoutliner-data", fn);
};
const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel("openoutliner-data") : null;
function changed() { channel?.postMessage("changed"); }
channel?.addEventListener("message", () => { window.dispatchEvent(new Event("outliner-sync")); void refreshStatus(); });
async function refreshStatus() {
  await locked(async () => {
    const state = await read();
    if (!state) return;
    const { db, sql } = await openLocal(state.bytes);
    try {
      const count = changesBetween(state.base, snapshot(sql)).length;
      report({ ready: true, pending: count, conflict: state.conflict?.conflicts, text: state.conflict ? "同步冲突 · 本机修改已保留" : count ? `已保存到本机 · ${count} 条待同步` : navigator.onLine ? "已同步" : "离线 · 数据已保存在本机" });
    } finally { db.close(); }
  });
}
async function network(method: string, body?: unknown): Promise<Response> {
  return fetch("/api/sync", { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal: AbortSignal.timeout(12000) });
}
export async function localRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const result = await locked(async () => {
    const state = await read();
    if (!state) throw new Error("首次使用需要联网并登录，完成数据下载后即可离线编辑。");
    const { db, sql } = await openLocal(state.bytes);
    try {
      const result = dispatch(new OutlinerService(sql), method, path, body);
      if (method !== "GET") {
        state.bytes = db.export();
        await save(state); // Resolve only after the IndexedDB transaction commits.
        changed();
      }
      return result as T;
    } finally { db.close(); }
  });
  if (method !== "GET") { await refreshStatus(); schedule(); }
  return result;
}
let timer: ReturnType<typeof setTimeout> | undefined;
function schedule() { clearTimeout(timer); timer = setTimeout(() => void synchronize(), 700); }
export async function synchronize(): Promise<void> {
  if (!navigator.locks) { report({ error: "请使用支持 Web Locks 的浏览器，并通过 HTTPS 访问。", text: "无法启用离线保存" }); return; }
  await navigator.locks.request("openoutliner-sync", { ifAvailable: true }, async lock => {
    if (!lock) return;
    try {
      const sent = await locked(async () => {
        const state = await read();
        if (!state) return undefined;
        const { db, sql } = await openLocal(state.bytes);
        try { return { state, data: snapshot(sql) }; } finally { db.close(); }
      });
      if (sent?.state.conflict) { await refreshStatus(); return; }
      if (!navigator.onLine) { await refreshStatus(); return; }
      const changes = sent ? changesBetween(sent.state.base, sent.data) : [];
      report({ text: "正在同步…", error: undefined });
      const response = await network(changes.length ? "POST" : "GET", changes.length ? { changes } : undefined);
      if (response.status === 401) { report({ needsLogin: true, text: "请登录以同步 · 本机数据保留" }); return; }
      if (response.status === 409) {
        const conflict = await response.json() as Conflict;
        await locked(async () => { const state = await read(); if (state) { state.conflict = conflict; await save(state); } });
        await refreshStatus(); changed(); return;
      }
      if (!response.ok) throw new Error(`云端暂不可用 (${response.status})，修改仍保存在本机。`);
      const remote = await response.json() as Envelope;
      if (remote.version !== 1) throw new Error("同步协议已更新，请联网刷新应用。");
      let remoteChanged = false;
      let deferred = false;
      await locked(async () => {
        const state = await read();
        const { db, sql } = await openLocal(state?.bytes);
        try {
          if (!state) migrate(sql);
          const current = state ? snapshot(sql) : undefined;
          let merged = remote.data;
          // Edits made while the network request was in flight remain pending.
          if (state && sent && current) {
            try { merged = mergeChanges(remote.data, changesBetween(sent.data, current)); }
            catch {
              state.conflict = { current: remote.data, conflicts: ["同步期间发生了并发修改，本机版本已保留。"] };
              await save(state); return;
            }
          }
          remoteChanged = !current || changesBetween(current, merged).length > 0;
          const active = document.activeElement;
          if (remoteChanged && current && active instanceof HTMLElement && (active.isContentEditable || active.matches("input, textarea"))) {
            // Keep the old base until the editor flushes; otherwise a stale draft
            // could overwrite a remote change without triggering a conflict.
            deferred = true;
            return;
          }
          if (remoteChanged) replaceSnapshot(sql, merged);
          await save({ bytes: db.export(), base: remote.data, revision: remote.revision, backups: state?.backups ?? [] });
          report({ ready: true, needsLogin: false, error: undefined });
        } finally { db.close(); }
      });
      await refreshStatus();
      if (deferred) { report({ text: "云端有更新 · 编辑结束后载入" }); return; }
      changed();
      if (remoteChanged) window.dispatchEvent(new Event("outliner-sync"));
    } catch (error) {
      await refreshStatus().catch(() => {});
      report({ text: status.ready ? "暂未连接云端 · 本机保存可用" : "尚未完成首次同步", error: error instanceof TypeError ? "连接云端失败，将自动重试。" : error instanceof Error ? error.message : "连接失败，请重试" });
    }
  });
}
export async function initializeOffline() {
  await refreshStatus().catch(error => report({ text: "无法读取本机存储", error: error instanceof Error ? error.message : "存储不可用" }));
  void synchronize();
  window.addEventListener("online", () => void synchronize());
  window.addEventListener("offline", () => void refreshStatus());
  window.addEventListener("focus", () => void synchronize());
  window.addEventListener("focusout", schedule);
  setInterval(() => { if (document.visibilityState === "visible") void synchronize(); }, 15000);
  // Persistence is best effort; only a completed transaction is called saved.
  void navigator.storage?.persist?.().catch(() => {});
}
export async function signIn(password: string) {
  const response = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }) });
  if (!response.ok) throw new Error((await response.json()).error ?? "登录失败");
  report({ needsLogin: false });
  await synchronize();
}
export async function resolveConflict(choice: "cloud" | "local") {
  await locked(async () => {
    const state = await read();
    if (!state?.conflict) return;
    const { db, sql } = await openLocal(state.bytes);
    try {
      const local = snapshot(sql), cloud = state.conflict.current;
      state.backups.push({ date: new Date().toISOString(), data: choice === "cloud" ? local : cloud });
      if (choice === "cloud") { replaceSnapshot(sql, cloud); state.bytes = db.export(); }
      state.base = cloud;
      state.conflict = undefined;
      await save(state);
    } finally { db.close(); }
  });
  await refreshStatus(); changed(); window.dispatchEvent(new Event("outliner-sync"));
  void synchronize();
}
export async function downloadRecovery() {
  const state = await locked(read);
  if (!state) return;
  const { db, sql } = await openLocal(state.bytes);
  try {
    const blob = new Blob([JSON.stringify({ format: "openoutliner-recovery-v1", local: snapshot(sql), base: state.base, conflict: state.conflict, backups: state.backups }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = `openoutliner-recovery-${Date.now()}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } finally { db.close(); }
}

export async function restoreRecovery(file: File) {
  if (file.size > 32 * 1024 * 1024) throw new Error("恢复文件超过 32 MB。");
  const recovery = JSON.parse(await file.text()) as { format?: string; local?: Snapshot };
  if (recovery.format !== "openoutliner-recovery-v1" || !recovery.local) throw new Error("请选择 OpenOutliner 恢复备份文件。");
  await locked(async () => {
    const state = await read();
    if (!state) throw new Error("请先完成首次同步，再导入恢复备份。");
    const { db, sql } = await openLocal(state.bytes);
    try {
      const previous = snapshot(sql);
      replaceSnapshot(sql, recovery.local!);
      state.backups.push({ date: new Date().toISOString(), data: previous });
      state.bytes = db.export();
      // Recovery is treated as pending local edits, with normal conflict checks.
      await save(state);
    } finally { db.close(); }
  });
  await refreshStatus(); changed(); window.dispatchEvent(new Event("outliner-sync")); schedule();
}

export async function recoveryVersions(): Promise<string[]> {
  return (await locked(read))?.backups.map(backup => backup.date) ?? [];
}
export async function downloadBackup(index: number) {
  const state = await locked(read), backup = state?.backups[index];
  if (!backup) throw new Error("备份不存在");
  const url = URL.createObjectURL(new Blob([JSON.stringify({ format: "openoutliner-recovery-v1", local: backup.data }, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `openoutliner-backup-${index + 1}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
