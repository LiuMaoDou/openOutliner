import { encodeRecovery, decodeRecovery } from "./recoveryFile";
import { saveLocalFile } from "./saveFile";
import { exportNativeArchive, parseNativeArchive, restoreNativeArchive } from "../backend/importExport/nativeArchive.js";
import { openLocal } from "./localDatabase";
import { migrate, SCHEMA_VERSION } from "../backend/shared/schema.js";
import { needsStoredUpgrade, upgradeStoredState } from "../backend/shared/storedState.js";
import { OutlinerService, NotFoundError } from "../backend/services/outliner.js";
import { CreationJournal, parseCreationBackup, replayCreation, type CreationIntent } from "./creationJournal";
import { dispatch } from "../backend/shared/dispatch.js";
import { changesBetween, mergeChanges, replaceSnapshot, applySnapshotChanges, snapshot, type Snapshot } from "../backend/shared/sync.js";
import { DraftJournal, parseDraftBackup, type DraftField, type EditorDraft } from "./editorDrafts";
import { backupBeforeSync, incomingRemovalConflicts, removesToday, type SnapshotBackup } from "../backend/shared/syncSafety.js";

interface Conflict { current: Snapshot; conflicts: string[] }
interface Saved { bytes: Uint8Array; base: Snapshot; revision: string; conflict?: Conflict; backups: SnapshotBackup[]; schemaVersion?: number }
import { decodeEnvelope, type SyncEnvelope } from "../backend/shared/syncProtocol.js";
async function digestSnapshot(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
export interface SyncStatus { text: string; pending: number; needsLogin?: boolean; conflict?: string[]; error?: string; localSaveError?: string; drafts?: number; archivedDrafts?: number; pendingCreations?: number; draftConflicts?: EditorDraft[]; ready: boolean }
let status: SyncStatus = { text: "正在读取本机数据…", pending: 0, ready: false };
const listeners = new Set<() => void>();
export const subscribeSync = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const getSyncStatus = () => status;
function report(next: Partial<SyncStatus>) { status = { ...status, ...next }; listeners.forEach(listener => listener()); }
let journal: DraftJournal;
let creations: CreationJournal;
const activeCreations = new Set<string>();
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
  creations = new CreationJournal(draftStorage, owner);
}
function updateDraftStatus() {
  if (!journal) return;
  try {
    const entries = journal.list(), drafts = entries.filter(draft => !draft.archived);
    const draftError = journalError || [...draftSaveErrors.values()][0];
    report({ drafts: drafts.length, pendingCreations: creations?.list().length ?? 0, archivedDrafts: entries.length - drafts.length, draftConflicts: drafts.filter(draft => draft.conflict), ...(draftError ? { localSaveError: draftError } : {}) });
  } catch (error) { report({ localSaveError: error instanceof Error ? error.message : "无法读取编辑草稿。" }); }
}
export function beginCreation(tempId: string, parentId: string, position: number, title: string) {
  const id = tempId.slice(5);
  try {
    creations.begin(id, parentId.startsWith("temp-") ? parentId.slice(5) : parentId, position, title);
    activeCreations.add(id);
    updateDraftStatus();
  } catch (error) {
    journalError = error instanceof Error ? error.message : "无法保存新建大纲，请检查本机存储。";
    report({ localSaveError: journalError });
    throw error;
  }
}
export function stageCreation(tempId: string, patch: Partial<Pick<CreationIntent, "title" | "body" | "cancelled">>) {
  if (!tempId.startsWith("temp-")) return;
  try { creations.stage(tempId.slice(5), patch); }
  catch (error) {
    journalError = error instanceof Error ? error.message : "新建大纲草稿尚未持久保存。";
    report({ localSaveError: journalError });
  }
  updateDraftStatus();
}
export function pendingCreation(tempId: string) { return creations?.get(tempId.slice(5)); }
export function pendingCreationList() { return creations?.list() ?? []; }
export function endCreation(tempId: string, saved: boolean) {
  const id = tempId.slice(5), intent = creations?.get(id);
  activeCreations.delete(id);
  if (saved && intent) {
    try { creations.acknowledge(intent); } catch (error) { report({ localSaveError: String(error) }); }
  }
  updateDraftStatus();
}

export async function recoverPendingCreations() {
  if (!creations || !navigator.locks) return;
  const replay = async (intent: CreationIntent) => {
    if (activeCreations.has(intent.id)) return;
    try {
      await locked(async () => {
        const current = creations.list().find(item => item.id === intent.id && item.owner === intent.owner);
        if (!current) return;
        const state = await read();
        if (!state) return;
        const { db, sql } = await openLocal(state.bytes);
        try {
          const service = new OutlinerService(sql);
          service.importTransaction(() => replayCreation(current, service, error => error instanceof NotFoundError));
          state.bytes = db.export();
          await save(state);
          creations.acknowledge(current);
        } finally { db.close(); }
      });
    } catch (error) {
      report({ localSaveError: error instanceof Error ? error.message : "待创建大纲恢复失败，草稿已保留。" });
    }
  };
  for (const intent of creations.list().sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))) {
    if (intent.owner === creations.owner) await replay(intent);
    else await navigator.locks.request(`openoutliner-editor-${intent.owner}`, { ifAvailable: true }, async lock => {
      if (lock) await replay(intent);
    });
  }
  updateDraftStatus();
  await refreshStatus();
  changed();
  window.dispatchEvent(new Event("outliner-sync"));
  schedule();
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
  // All callers hold the existing cross-tab openoutliner-data Web Lock.
  const storage = await store();
  const state = await new Promise<Saved | undefined>((resolve, reject) => {
    const request = storage.transaction("state").objectStore("state").get("current");
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  if (!state || !needsStoredUpgrade(state)) return state;
  const { db, sql } = await openLocal(state.bytes);
  try {
    const upgraded = upgradeStoredState(state, sql, db.export());
    await new Promise<void>((resolve, reject) => {
      const tx = storage.transaction("state", "readwrite");
      const records = tx.objectStore("state");
      const backupKey = `before-schema-${state.schemaVersion ?? 0}`;
      const backup = records.get(backupKey);
      backup.onsuccess = () => {
        // Keep the first pre-upgrade envelope, including its exact original bytes.
        if (backup.result === undefined) records.put(state, backupKey);
        records.put(upgraded, "current");
      };
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new Error("本机数据库升级未完成，旧数据未改动；请检查剩余空间后重试。"));
    });
    return upgraded;
  } finally { db.close(); }
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
function changed() {
  channel?.postMessage("changed");
  window.dispatchEvent(new Event("outliner-data-changed"));
}
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
async function network(method: string, body?: unknown, revision?: string, incremental = true): Promise<Response> {
  const payload = body ? JSON.stringify(body) : undefined;
  if (payload && new Blob([payload]).size > 32 * 1024 * 1024) {
    throw new Error("待同步数据超过 32 MiB，本机数据已保留。请先下载恢复备份；当前版本尚不支持分批同步。");
  }
  const query = incremental ? "?" + new URLSearchParams({ incremental: "1", ...(revision ? { baseRevision: revision } : {}) }) : "";
  return fetch("/api/sync" + query, { method, headers: { "content-type": "application/json" }, body: payload, cache: "no-store", signal: AbortSignal.timeout(12000) });
}
let pendingLocalWrites = 0;
export async function localRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const writing = method !== "GET";
  if (writing) pendingLocalWrites += 1;
  try {
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
  } finally {
    if (writing) pendingLocalWrites -= 1;
  }
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
      if (changes.length > 100000) throw new Error("待同步记录超过 100000 条，本机数据已保留。请先下载恢复备份。");
      report({ text: "正在同步…", error: undefined });
      const response = await network(changes.length ? "POST" : "GET", changes.length ? { changes } : undefined, sent?.state.revision);
      if (response.status === 401) { report({ needsLogin: true, text: "请登录以同步 · 本机数据保留" }); return; }
      if (response.status === 409) {
        const conflict = await response.json() as Conflict;
        await locked(async () => { const state = await read(); if (state) { state.conflict = conflict; await save(state); } });
        await refreshStatus(); changed(); return;
      }
      if (!response.ok) throw new Error(`云端暂不可用 (${response.status})，修改仍保存在本机。`);
      const envelope = await response.json() as SyncEnvelope;
      let remote;
      try {
        remote = await decodeEnvelope(envelope, sent?.state.base, sent?.state.revision, digestSnapshot);
      } catch {
        // A failed delta never modifies local data. The upload, if any, was
        // already acknowledged; request an authoritative full snapshot.
        const fallback = await network("GET", undefined, undefined, false);
        if (!fallback.ok) throw new Error("增量同步校验失败，本机数据已保留。");
        const full = await fallback.json() as SyncEnvelope;
        if (full.version !== 1) throw new Error("同步协议不兼容，本机数据已保留。");
        remote = full;
      }
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
          if (state && current) {
            const conflicts = incomingRemovalConflicts(current, merged);
            if (conflicts.length) {
              state.conflict = { current: remote.data, conflicts };
              await save(state);
              return;
            }
          }
          remoteChanged = !current || changesBetween(current, merged).length > 0;
          const backups = remoteChanged && current
            ? backupBeforeSync(state?.backups ?? [], current)
            : state?.backups ?? [];
          if (remoteChanged) {
            if (current) applySnapshotChanges(sql, current, merged);
            else replaceSnapshot(sql, merged);
          }
          if (!state || remoteChanged || changes.length || state.revision !== remote.revision) {
            await save({ bytes: db.export(), base: remote.data, revision: remote.revision, backups, schemaVersion: SCHEMA_VERSION });
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
  await recoverPendingCreations().catch(() => {});
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
    if (journal.hasVolatileDrafts() || creations.hasVolatileEntries()) { event.preventDefault(); event.returnValue = ""; }
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
    const blob = encodeRecovery({ ...exportNativeArchive(sql), base: state.base, conflict: state.conflict, backups: state.backups, editorDrafts: journal.list(), pendingCreations: creations.list() });
    const now = new Date();
    const date = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(value => String(value).padStart(2, "0")).join("-");
    const time = [now.getHours(), now.getMinutes(), now.getSeconds()].map(value => String(value).padStart(2, "0")).join("-");
    await saveLocalFile(blob, `openoutliner-backup-${date}_${time}.json`);
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

export async function downloadEditorDrafts() {
  const blob = encodeRecovery({ format: "openoutliner-editor-drafts-v1", drafts: journal.list(), pendingCreations: creations.list() });
  await saveLocalFile(blob, `openoutliner-editor-drafts-${Date.now()}.json`);
}

export async function restoreRecovery(file: File, confirmRestore: (summary: string) => boolean) {
  const recovery = await decodeRecovery(file) as { format?: string; local?: Snapshot; outlineHistory?: unknown; base?: unknown; conflict?: { current?: unknown }; backups?: unknown; editorDrafts?: unknown; pendingCreations?: unknown } | null;
  if (!recovery || recovery.format !== "openoutliner-recovery-v1" || !recovery.local) throw new Error("请选择 OpenOutliner 恢复备份文件。");
  const drafts = parseDraftBackup(recovery.editorDrafts);
  const intents = parseCreationBackup(recovery.pendingCreations);
  await flushAllNodeDrafts();
  const restored = await locked(async () => {
    const state = await read();
    if (!state) throw new Error("请先完成首次同步，再导入恢复备份。");
    const { db, sql } = await openLocal(state.bytes);
    try {
      const previous = exportNativeArchive(sql), archive = parseNativeArchive(sql, recovery), incoming = archive.local;
      if (removesToday(previous.local, incoming)) throw new Error("此备份缺少系统 Today 工作区。为避免清除现有 Today，请选择包含 Today 的完整恢复备份。");
      const activeCount = (data: Snapshot) => data.nodes.filter(row => row.parent_id !== null && row.deleted_at === null).length;
      const summary = `全量恢复将替换本机全部工作区（${previous.local.workspaces.length} → ${incoming.workspaces.length}）、有效大纲（${activeCount(previous.local)} → ${activeCount(incoming)}）。\n恢复后可能将修改或删除同步到其他设备。当前数据会保留在历史备份中。确认继续？`;
      if (!confirmRestore(summary)) return false;
      // Preserve the imported recovery versions without making an old base
      // the current sync acknowledgement. Invalid attachments fail before writes.
      const imported: SnapshotBackup[] = [];
      const now = new Date().toISOString();
      const addVersion = (data: unknown, date: string, outlineHistory?: unknown) => {
        const parsed = parseNativeArchive(sql, { format: "openoutliner-recovery-v1", local: data, outlineHistory });
        imported.push({ date, data: parsed.local, outlineHistory: parsed.outlineHistory });
      };
      if (recovery.backups !== undefined) {
        if (!Array.isArray(recovery.backups)) throw new Error("备份历史格式无效。");
        for (const entry of recovery.backups) {
          if (!entry || typeof entry.date !== "string") throw new Error("备份历史格式无效。");
          addVersion(entry.data, entry.date, entry.outlineHistory);
        }
      }
      if (recovery.base && changesBetween(incoming, parseNativeArchive(sql, { format: "openoutliner-recovery-v1", local: recovery.base }).local).length) {
        addVersion(recovery.base, now);
      }
      if (recovery.conflict?.current) addVersion(recovery.conflict.current, now);
      restoreNativeArchive(sql, archive);
      state.backups.push(...imported, { date: now, data: previous.local, outlineHistory: previous.outlineHistory });
      state.bytes = db.export();
      // Recovery is treated as pending local edits, with normal conflict checks.
      await save(state);
      journal.restore(drafts);
      creations.restore(intents);
      return true;
    } finally { db.close(); }
  });
  if (restored) { await refreshStatus(); changed(); window.dispatchEvent(new Event("outliner-sync")); schedule(); }
}

export async function recoveryVersions(): Promise<string[]> {
  return (await locked(read))?.backups.map(backup => backup.date) ?? [];
}
export async function downloadBackup(index: number, expectedDate: string) {
  const state = await locked(read), backup = state?.backups[index];
  if (!backup || backup.date !== expectedDate) throw new Error("备份列表已更新，请重新打开备份面板后选择版本。");
  const blob = encodeRecovery({ format: "openoutliner-recovery-v1", local: backup.data, outlineHistory: backup.outlineHistory });
  await saveLocalFile(blob, `openoutliner-backup-${index + 1}.json`);
}


/** Called only after the editor/structural-operation barriers have completed. */
export async function prepareForAppUpdate(): Promise<void> {
  const deadline = Date.now() + 10000;
  // Also cover writes outside the outline editor (calendar, tags and workspaces).
  while (pendingLocalWrites) {
    if (Date.now() > deadline) throw new Error("仍有本机操作未完成，请完成保存后再更新。");
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  await flushAllNodeDrafts();
  await locked(async () => {
    const state = await read();
    if (!state) throw new Error("尚未完成本机保存，请先完成首次同步。");
    if (status.localSaveError || journal.hasVolatileDrafts() || creations.hasVolatileEntries()) throw new Error("本机保存尚未成功，暂不切换版本；请先下载草稿并处理保存错误。");
    if (creations.list().some(intent => intent.owner === creations.owner)) throw new Error("请先保存或恢复待创建大纲，再更新应用。");
    if (journal.list().some(draft => draft.owner === journal.owner && !draft.archived)) throw new Error("请先处理当前页面的编辑草稿，再更新应用。");
  });
}
