import { CircleAlert, Database, FileDown, Upload, X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { downloadRecovery, pendingEditorDrafts, resolveEditorDraft, getSyncStatus, resolveConflict, restoreRecovery, signIn, subscribeSync } from "./offline";

export function SyncPanel({ embedded = false, compact = false }: {
  embedded?: boolean;
  compact?: boolean;
}) {
  const status = useSyncExternalStore(subscribeSync, getSyncStatus);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({});
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const detailsRef = useRef<HTMLElement | null>(null);
  const recoveryInputRef = useRef<HTMLInputElement | null>(null);
  const attention = status.localSaveError ? "保存失败" : status.draftConflicts?.length ? "编辑冲突" : status.conflict ? "同步冲突" : status.needsLogin ? "需要登录" : !status.ready && status.error ? "尚未就绪" : "";
  const forcedOpen = Boolean(status.needsLogin || !status.ready);
  const detailsVisible = open || forcedOpen;
  const closePanel = () => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); };

  useLayoutEffect(() => {
    if (!detailsVisible) return;
    const placePanel = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportHeight = viewport?.height ?? window.innerHeight;
      const width = Math.min(240, viewportWidth - 24);
      const bottomEdge = Math.min(Math.max(rect.top - 8, viewportTop + 80), viewportTop + viewportHeight - 12);
      setPosition({
        left: Math.max(viewportLeft + 12, Math.min(rect.left, viewportLeft + viewportWidth - width - 12)),
        bottom: window.innerHeight - bottomEdge,
        width,
        maxHeight: Math.min(560, bottomEdge - viewportTop - 12)
      });
    };
    placePanel();
    if (open) detailsRef.current?.focus({ preventScroll: true });
    window.addEventListener("resize", placePanel);
    window.visualViewport?.addEventListener("resize", placePanel);
    window.visualViewport?.addEventListener("scroll", placePanel);
    return () => {
      window.removeEventListener("resize", placePanel);
      window.visualViewport?.removeEventListener("resize", placePanel);
      window.visualViewport?.removeEventListener("scroll", placePanel);
    };
  }, [detailsVisible, open, compact]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target) && !detailsRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); }
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const act = async (fn: () => Promise<unknown>, closeAfter = false) => {
    setBusy(true); setError("");
    try { await fn(); if (closeAfter) closePanel(); }
    catch (e) { setError(e instanceof Error ? e.message : "操作失败"); }
    finally { setBusy(false); }
  };

  return <div ref={panelRef} className={`syncPanel${embedded ? " syncPanelEmbedded" : ""}`}>
    <button
      ref={triggerRef}
      type="button"
      className={`syncIndicator${attention ? " syncIndicatorAttention" : ""}`}
      onClick={() => { setError(""); setOpen(current => !current); }}
      aria-expanded={detailsVisible}
      aria-controls={panelId}
      aria-haspopup="dialog"
      aria-label={attention ? `备份与恢复：${attention}` : "备份与恢复"}
      title={attention ? `备份与恢复 · ${attention}` : "备份与恢复"}
    >
      {attention ? <CircleAlert size={15} aria-hidden="true" /> : <Database size={15} aria-hidden="true" />}
      {attention && !compact && <span>{attention}</span>}
    </button>
    <input
      ref={recoveryInputRef}
      type="file"
      accept="application/json,.json"
      aria-label="恢复备份文件"
      hidden
      onChange={event => {
        const file = event.target.files?.[0]; event.target.value = "";
        if (file) void act(() => restoreRecovery(file));
      }}
    />
    {detailsVisible && createPortal(<section
      ref={detailsRef}
      id={panelId}
      className="syncDetails"
      role="dialog"
      aria-label="备份与恢复"
      tabIndex={-1}
      style={position}
      onKeyDown={event => {
        if (event.key === "Escape") closePanel();
        event.stopPropagation();
      }}
    >
      <header className="syncDetailsHeader">
        <strong>备份与恢复</strong>
        {!forcedOpen && <button className="syncIconButton syncClose" type="button" aria-label="关闭备份与恢复" onClick={closePanel}><X size={16} /></button>}
      </header>
      {(error || status.localSaveError || status.error) && <p role="alert">{error || status.localSaveError || status.error}</p>}
      {status.ready && <div>
        <button className="syncActionRow" type="button" disabled={busy} onClick={() => void act(downloadRecovery, true)}><FileDown size={16} /><span>下载备份</span><small>全部工作区</small></button>
        <button className="syncActionRow" type="button" disabled={busy} onClick={() => recoveryInputRef.current?.click()}><Upload size={16} /><span>恢复备份</span><small>JSON</small></button>
      </div>}
      <div className="syncAttentionDetails">
        {status.needsLogin && <form onSubmit={event => { event.preventDefault(); void act(async () => { await signIn(password); setPassword(""); }); }}>
          <label>访问密码<input aria-label="访问密码" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>
          <button disabled={busy || !password}>登录并同步</button>
        </form>}
        {status.conflict && <div>
          <p>其他设备也修改了数据。选择后，另一版本会保留在本机恢复备份中。选择“本机”将以当前整套本机数据替换此次云端版本。</p>
          <ul>{status.conflict.slice(0,10).map((text, i) => <li key={i}>{text}</li>)}</ul>
          <button disabled={busy} onClick={() => void act(() => resolveConflict("cloud"))}>采用云端，备份本机</button>
          <button disabled={busy} onClick={() => void act(() => resolveConflict("local"))}>采用本机，备份云端</button>
        </div>}
        {Boolean(status.drafts) && <div>
          <strong>保留的编辑草稿</strong>
          <p>草稿与当前内容均会保留，请选择要采用的版本。</p>
          {pendingEditorDrafts().map(draft => <details key={draft.id}>
            <summary>{draft.field === "title" ? "标题" : "备注"} · {draft.conflict ? "需要选择版本" : "等待保存"} · {new Date(draft.updatedAt).toLocaleTimeString()}</summary>
            <p>编辑草稿</p><pre>{draft.value || "（空内容）"}</pre>
            {draft.conflict && <><p>当前内容</p><pre>{draft.conflict.current === null ? "节点已删除，可下载备份保留草稿内容" : draft.conflict.current || "（空内容）"}</pre></>}
            {draft.conflict?.current !== null && <button disabled={busy} onClick={() => void act(() => resolveEditorDraft(draft.id, "draft"))}>采用此草稿</button>}
            <button disabled={busy} onClick={() => void act(() => resolveEditorDraft(draft.id, "current"))}>保留当前，归档草稿</button>
          </details>)}
        </div>}
      </div>
      <footer className="syncStatusRow">
        <span role="status" title={status.text}>{status.text}</span>
      </footer>
    </section>, document.body)}
  </div>;
}
