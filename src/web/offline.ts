import { openLocal } from "./localDatabase";
import { migrate } from "../backend/shared/schema.js";
import { OutlinerService } from "../backend/services/outliner.js";
import { dispatch } from "../backend/shared/dispatch.js";
import { changesBetween, mergeChanges, replaceSnapshot, snapshot, type Snapshot } from "../backend/shared/sync.js";
import { DraftJournal, parseDraftBackup, type DraftField, type EditorDraft } from "./editorDrafts";

interface Conflict { current: Snapshot; conflicts: string[] }
interface Backup { date: string; data: Snapshot }
interface Saved { bytes: Uint8Array; base: Snapshot; revision: string; conflict?: Conflict; backups: Backup[] }
interface Envelope { version: number; revision: string; data: Snapshot }
export interface SyncStatus { text: string; pending: number; needsLogin?: boolean; conflict?: string[]; error?: string; localSaveError?: string; drafts?: number; archivedDrafts?: number; draftConflicts?: EditorDraft[]; ready: boolean }
let status: SyncStatus = { text: "正在读取本机数据…", pending: 0, ready: false };
const listeners = new Set<() => void>();
export const subscribeSync = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getSyncStatus = () => status;
function report(next: Partial<SyncStatus>) { status = { ...status, ...next }; listeners.forEach(listener => listener()); }
let journal: DraftJournal;
let journalError: string | undefined;
const draftTimers = new Map<string, ReturnType<typeof setTimeout>>();
const draftSaveErrors = new Map<string, string>();
async function claimEditorOwner(candidate: string): Promise<string> {
  return new Promise<string>(resolve => {
    void navigator.locks.request(`openoutliner-editor-${candidate}`, { ifAvailable: true }, async lock => {
      if (!lock) { resolve(await claimEditorOwner(crypto.randomUUID())); return; }
      resolve(candidate);
      await new Promise<void>(() => {});
    }).catch(() => resolve(crypto.randomUUID()));
  });
}
async function initializeJournal() {
  let owner: string = crypto.randomUUID();
  try { owner = sessionStorage.getItem("openoutliner-editor-owner") || owner; } catch { /* Use a new owner when session storage is unavailable. */ }
  // Duplicating a browser tab copies sessionStorage. Claim the owner so the two
  // live tabs still get independent journal keys; reloads retain their old keys.
  if (navigator.locks) owner = await claimEditorOwner(owner);
  try { sessionStorage.setItem("openoutliner-editor-owner", owner); } catch { /* Drafts remain discoverable in the recovery panel. */ }
  let draftStorage: Storage;
  try { draftStorage = localStorage; } catch {
    draftStorage = { length: 0, key: () => null, getItem: () => null, removeItem: () => {}, clear: () => {}, setItem: () => { throw new Error("浏览器不允许保存编辑草稿，请保持页面打开并检查存储权限。"); } };
  }
  journal = new DraftJournal(draftStorage, owner);
}
function updateDraftStatus() {
  if (!journal) return;
  try {
    const entries = journal.list(), drafts = entries.filter(draft => !draft.archived);
    const draftError = journalError || [...draftSaveErrors.values()][0];
    report({ drafts: drafts.length, archivedDrafts: entries.length - drafts.length, draftConflicts: drafts.filter(draft => draft.conflict), ...(draftError ? { localSaveError: draftError } : {}) });
  } catch (error) { report({ localSaveError: error instanceof Error ? error.message : "无法读取编辑草稿。" }); }
}
export function beginNodeEdit(nodeId: string, field: DraftField, expectedValue: string) { journal.begin(nodeId, field, expectedValue); }
export function readNodeDraft(nodeId: string, field: DraftField) { return journal?.get(nodeId, field)?.value; }
export function stageNodeDraft(nodeId: string, field: DraftField, value: string, expectedValue: string) {
  try {
    journal.stage(nodeId, field, value, expectedValue);
    if (journalError && !journal.hasVolatileDrafts()) { journalError = undefined; report({ localSaveError: [...draftSaveErrors.values()][0] }); }
  } catch (error) { journalError = error instanceof Error ? error.message : "编辑草稿尚未保存，请勿关闭页面。"; report({ localSaveError: journalError }); }
  updateDraftStatus();
  const key = `${nodeId}:${field}`;
  clearTimeout(draftTimers.get(key));
  draftTimers.set(key, setTimeout(() => { draftTimers.delete(key); void flushNodeDraft(nodeId, field).catch(() => {}); }, 300));
}
export async function endNodeEdit(nodeId: string, field: DraftField) {
  const session = journal.session(nodeId, field);
  try { await flushNodeDraft(nodeId, field); } finally { if (session) journal.end(nodeId, field, session); }
}
export async function flushNodeDraft(nodeId: string, field: DraftField): Promise<void> {
  const key = `${nodeId}:${field}`;
  clearTimeout(draftTimers.get(key)); draftTimers.delete(key);
  let didSave = false;
  await locked(async () => {
    // Read after acquiring the data lock, so two flush requests cannot commit
    // the same outdated journal version while a newer edit is being staged.
    const draft = journal.get(nodeId, field);
    if (!draft) return;
    if (draft.conflict) throw new Error(draft.conflict.message);
    const state = await read();
    if (!state) throw new Error("请先完成首次同步，编辑草稿已保留。");
    const { db, sql } = await openLocal(state.bytes);
    try {
      const service = new OutlinerService(sql);
      let current: string | null = null;
      try { current = service.getNode(nodeId)[field]; } catch { /* A remote deletion is a recoverable draft conflict. */ }
      if (current === null || (current !== draft.expected && current !== draft.value)) {
        const message = current === null ? "编辑的节点已被删除，草稿已保留。" : "另一个页面或设备修改了同一字段，草稿与当前内容均已保留。";
        journal.conflict(draft, current, message);
        updateDraftStatus();
        throw new Error(message);
      }
      if (current !== draft.value) {
        dispatch(service, "PATCH", `/api/nodes/${nodeId}`, { [field]: draft.value });
        state.bytes = db.export();
        await save(state);
        didSave = true;
      }
      journal.acknowledge(draft);
      draftSaveErrors.delete(key);
      if (!draftSaveErrors.size && !journal.hasVolatileDrafts()) { journalError = undefined; report({ localSaveError: undefined }); }
      window.dispatchEvent(new CustomEvent("outliner-draft-saved", { detail: { nodeId, field, value: draft.value } }));
    } finally { db.close(); }
  }).catch(error => {
    if (!journal.get(nodeId, field)?.conflict) {
      const message = error instanceof Error ? error.message : "草稿尚未保存到本机数据库。";
      draftSaveErrors.set(key, message);
      report({ localSaveError: message });
    }
    throw error;
  });
  updateDraftStatus();
  if (didSave) { changed(); await refreshStatus(); schedule(); }
}
export async function flushAllNodeDrafts() {
  if (!journal) return;
  // A conflict for another node should be resolved explicitly, but must not
  // prevent saving unrelated work or silently discard the conflict draft.
  for (const draft of journal.list()) if (draft.owner === journal.owner && !draft.archived && !draft.conflict) {
    try { await flushNodeDraft(draft.nodeId, draft.field); }
    catch (error) { if (!journal.get(draft.nodeId, draft.field)?.conflict) throw error; }
  }
}
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
  try {
    const db = await store();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("state", "readwrite");
      tx.objectStore("state").put(value, "current");
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error("保存到本机失败，请检查剩余空间；本次修改尚未保存。"));
    });
    if (status.localSaveError && !journalError && !draftSaveErrors.size && !journal?.hasVolatileDrafts()) report({ localSaveError: undefined });
  } catch (error) {
    report({ localSaveError: error instanceof Error ? error.message : "保存到本机失败，本次修改尚未保存。" });
    throw error;
  }
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
      updateDraftStatus();
      report({ ready: true, pending: count, conflict: state.conflict?.conflicts, text: state.conflict ? "同步冲突 · 本机修改已保留" : status.draftConflicts?.length ? "编辑冲突 · 两份内容已保留" : status.drafts ? "编辑草稿已保留 · 等待写入本机数据库" : count ? `已保存到本机 · ${count} 条待同步` : !navigator.onLine ? "离线 · 数据已保存在本机" : status.error ? "已保存到本机 · 等待连接云端" : "已同步" });
    } finally { db.close(); }
  });
}
async function network(method: string, body?: unknown): Promise<Response> {
  return fetch("/api/sync", { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, cache: "no-store", signal: AbortSignal.timeout(12000) });
}
export async function localRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  if (method !== "GET") await flushAllNodeDrafts();
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
      await flushAllNodeDrafts();
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
          if (remoteChanged) replaceSnapshot(sql, merged);
          if (!state || remoteChanged || changes.length || state.revision !== remote.revision) {
            await save({ bytes: db.export(), base: remote.data, revision: remote.revision, backups: state?.backups ?? [] });
          }
          report({ ready: true, needsLogin: false, error: undefined });
        } finally { db.close(); }
      });
      await refreshStatus();
      if (remoteChanged) changed();
      if (remoteChanged) window.dispatchEvent(new Event("outliner-sync"));
    } catch (error) {
      await refreshStatus().catch(() => {});
      report({ text: status.ready ? "暂未连接云端 · 本机保存可用" : "尚未完成首次同步", error: error instanceof TypeError ? "连接云端失败，将自动重试。" : error instanceof Error ? error.message : "连接失败，请重试" });
    }
  });
}
export async function initializeOffline() {
  await initializeJournal();
  await refreshStatus().catch(error => report({ text: "无法读取本机存储", error: error instanceof Error ? error.message : "存储不可用" }));
  await flushAllNodeDrafts().catch(() => {});
  void synchronize();
  window.addEventListener("online", () => void synchronize());
  window.addEventListener("offline", () => void refreshStatus());
  window.addEventListener("focus", () => void synchronize());
  window.addEventListener("focusout", schedule);
  window.addEventListener("storage", () => updateDraftStatus());
  window.addEventListener("beforeunload", event => {
    // Durable drafts are replayed on reload. Only an actual failed journal
    // write needs the browser's leave-page warning.
    if (journal.hasVolatileDrafts()) { event.preventDefault(); event.returnValue = ""; }
  });
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
    const blob = new Blob([JSON.stringify({ format: "openoutliner-recovery-v1", local: snapshot(sql), base: state.base, conflict: state.conflict, backups: state.backups, editorDrafts: journal.list() }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), anchor = document.createElement("a");
    anchor.href = url; anchor.download = `openoutliner-recovery-${Date.now()}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } finally { db.close(); }
}

export function pendingEditorDrafts() { return journal?.list().filter(draft => !draft.archived) ?? []; }
export function archivedEditorDrafts() { return journal?.list().filter(draft => draft.archived) ?? []; }
export function recoverArchivedEditorDraft(id: string) { journal.recoverArchive(id); updateDraftStatus(); }
export async function resolveEditorDraft(id: string, choice: "draft" | "current") {
  let resolved: { nodeId: string; field: DraftField; value?: string } | undefined;
  await locked(async () => {
    const draft = journal.list().find(item => item.id === id && !item.archived);
    if (!draft) return;
    resolved = { nodeId: draft.nodeId, field: draft.field };
    if (choice === "draft") {
      const state = await read();
      if (!state) throw new Error("请先完成首次同步。");
      const { db, sql } = await openLocal(state.bytes);
      try {
        const service = new OutlinerService(sql);
        const current = service.getNode(draft.nodeId)[draft.field];
        const reviewed = draft.conflict ? draft.conflict.current : draft.expected;
        if (current !== reviewed && current !== draft.value) {
          journal.conflict(draft, current, "当前内容已更改，请查看两份内容后再选择。");
          updateDraftStatus();
          throw new Error("当前内容已更改，请查看两份内容后再选择。");
        }
        // Explicitly adopting a conflicting draft still retains the replaced
        // database version and both field values in the downloadable recovery.
        state.backups.push({ date: new Date().toISOString(), data: snapshot(sql) });
        dispatch(service, "PATCH", `/api/nodes/${draft.nodeId}`, { [draft.field]: draft.value });
        state.bytes = db.export();
        await save(state);
        resolved.value = service.getNode(draft.nodeId)[draft.field];
      } finally { db.close(); }
    } else {
      const state = await read();
      if (state) {
        const { db, sql } = await openLocal(state.bytes);
        try { resolved.value = new OutlinerService(sql).getNode(draft.nodeId)[draft.field]; }
        catch { /* The node was deleted; retain its draft in the archive. */ }
        finally { db.close(); }
      }
    }
    journal.archive(id, draft.version);
    journal.end(draft.nodeId, draft.field);
    draftSaveErrors.delete(`${draft.nodeId}:${draft.field}`);
    if (!journal.hasVolatileDrafts()) journalError = undefined;
    report({ localSaveError: journalError || [...draftSaveErrors.values()][0] });
  });
  if (resolved) window.dispatchEvent(new CustomEvent("outliner-draft-resolved", { detail: resolved }));
  updateDraftStatus(); await refreshStatus(); changed(); window.dispatchEvent(new Event("outliner-sync")); schedule();
}

export function downloadEditorDrafts() {
  const url = URL.createObjectURL(new Blob([JSON.stringify({ format: "openoutliner-editor-drafts-v1", drafts: journal.list() }, null, 2)], { type: "application/json" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = `openoutliner-editor-drafts-${Date.now()}.json`; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function restoreRecovery(file: File) {
  if (file.size > 32 * 1024 * 1024) throw new Error("恢复文件超过 32 MB。");
  const recovery = JSON.parse(await file.text()) as { format?: string; local?: Snapshot; editorDrafts?: unknown };
  if (recovery.format !== "openoutliner-recovery-v1" || !recovery.local) throw new Error("请选择 OpenOutliner 恢复备份文件。");
  const drafts = parseDraftBackup(recovery.editorDrafts);
  await flushAllNodeDrafts();
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
      journal.restore(drafts);
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
