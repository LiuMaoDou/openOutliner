import { Database, CircleAlert, FileDown, Upload } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { downloadRecovery, downloadBackup, downloadEditorDrafts, pendingEditorDrafts, archivedEditorDrafts, recoverArchivedEditorDraft, resolveEditorDraft, recoveryVersions, getSyncStatus, resolveConflict, restoreRecovery, signIn, subscribeSync, synchronize } from "./offline";
export function SyncPanel({ embedded = false, compact = false, onImport, onExport }: {
  embedded?: boolean;
  compact?: boolean;
  onImport?: () => void;
  onExport?: (format: "markdown" | "opml") => Promise<void>;
}) {
  const status = useSyncExternalStore(subscribeSync, getSyncStatus);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<string[]>([]);
  const [version, setVersion] = useState("0");
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { if (open) void recoveryVersions().then(setVersions).catch(() => {}); }, [open, status.conflict]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panelRef.current?.contains(event.target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); } finally { setBusy(false); } };
  const attention = status.localSaveError ? "保存失败" : status.draftConflicts?.length ? "编辑冲突" : status.conflict ? "同步冲突" : status.needsLogin ? "需要登录" : !status.ready && status.error ? "尚未就绪" : "";
  const detailsVisible = open || status.needsLogin || !status.ready;
  return <div ref={panelRef} className={`syncPanel${embedded ? " syncPanelEmbedded" : ""}`}>
    <button
      className={`syncIndicator${attention ? " syncIndicatorAttention" : ""}`}
      onClick={() => setOpen(!open)}
      aria-expanded={Boolean(detailsVisible)}
      aria-label={attention ? `导入、导出与备份：${attention}` : "导入、导出与备份"}
      title={attention ? `导入、导出与备份 · ${attention}` : "导入、导出与备份"}
    >
      {attention ? <CircleAlert size={15} aria-hidden="true" /> : <Database size={15} aria-hidden="true" />}
      {attention && !compact && <span>{attention}</span>}
    </button>
    {detailsVisible && <section className="syncDetails" aria-label="导入、导出与备份">
      {(onImport || onExport) && <div className="syncFileSection">
        <strong>导入与导出</strong>
        <div className="syncFileActions">
          {onImport && <button type="button" onClick={onImport}><Upload size={15} />Import Markdown / OPML</button>}
          {onExport && <>
            <button type="button" disabled={busy} onClick={() => void act(() => onExport("opml"))}><FileDown size={15} />Export OPML</button>
            <button type="button" disabled={busy} onClick={() => void act(() => onExport("markdown"))}><FileDown size={15} />Export Markdown</button>
          </>}
        </div>
      </div>}
      <strong>备份与同步</strong>
      <p role="status">{status.text}</p>
      {(error || status.localSaveError || status.error) && <p role="alert">{error || status.localSaveError || status.error}</p>}
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
        <p>原页面的草稿会继续保存；从备份恢复的草稿请在这里选择采用。发生冲突时，请比较后选择；另一份仍保留在恢复备份中。</p>
        {pendingEditorDrafts().map(draft => <details key={draft.id}>
          <summary>{draft.field === "title" ? "标题" : "备注"} · {draft.conflict ? "需要选择版本" : "等待保存"} · {new Date(draft.updatedAt).toLocaleTimeString()}</summary>
          <p>编辑草稿</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 160, overflow: "auto" }}>{draft.value || "（空内容）"}</pre>
          {draft.conflict && <><p>当前内容</p><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 160, overflow: "auto" }}>{draft.conflict.current === null ? "节点已删除，可下载草稿后恢复内容" : draft.conflict.current || "（空内容）"}</pre></>}
          {draft.conflict?.current !== null && <button disabled={busy} onClick={() => void act(() => resolveEditorDraft(draft.id, "draft"))}>采用此草稿</button>}
          <button disabled={busy} onClick={() => void act(() => resolveEditorDraft(draft.id, "current"))}>保留当前，归档草稿</button>
        </details>)}
        <button onClick={downloadEditorDrafts}>下载全部编辑草稿</button>
      </div>}
      {Boolean(status.archivedDrafts) && <details>
        <summary>已归档的编辑草稿（{status.archivedDrafts}）</summary>
        {archivedEditorDrafts().map(draft => <details key={draft.id}>
          <summary>{draft.field === "title" ? "标题" : "备注"} · {new Date(draft.updatedAt).toLocaleString()}</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 160, overflow: "auto" }}>{draft.value || "（空内容）"}</pre>
          <button disabled={busy} onClick={() => void act(async () => recoverArchivedEditorDraft(draft.id))}>恢复为待处理草稿</button>
        </details>)}
        <button onClick={downloadEditorDrafts}>下载全部编辑草稿</button>
      </details>}
      {versions.length > 0 && <div><label>保留的版本<select aria-label="保留的版本" value={version} onChange={event => setVersion(event.target.value)}>{versions.map((date, index) => <option key={index} value={index}>{new Date(date).toLocaleString()}</option>)}</select></label><button onClick={() => void act(() => downloadBackup(Number(version)))}>下载此版本</button></div>}
      <div className="syncActions">
        <button disabled={busy} onClick={() => void act(synchronize)}>立即同步</button>
        {status.ready && <button disabled={busy} onClick={() => void act(downloadRecovery)}>下载恢复备份</button>}
        {status.ready && <label className="recoveryImport">恢复备份<input type="file" accept="application/json,.json" aria-label="恢复备份" onChange={event => {
          const file = event.target.files?.[0]; event.target.value = "";
          if (file) void act(() => restoreRecovery(file));
        }} /></label>}
        {status.ready && <button onClick={() => setOpen(false)}>收起</button>}
      </div>
      <p><a href="/api/app-recovery">检查应用版本 / 修复缓存</a></p>
      <small>修改先保存到此浏览器，再同步至云端。清除网站数据会移除未同步内容。离线仅包含笔记数据及应用资源，外部链接和远程图片需要网络。</small>
    </section>}
  </div>;
}
