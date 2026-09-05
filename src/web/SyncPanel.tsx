import { useEffect, useState, useSyncExternalStore } from "react";
import { downloadRecovery, downloadBackup, recoveryVersions, getSyncStatus, resolveConflict, restoreRecovery, signIn, subscribeSync, synchronize } from "./offline";
export function SyncPanel() {
  const status = useSyncExternalStore(subscribeSync, getSyncStatus);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [versions, setVersions] = useState<string[]>([]);
  const [version, setVersion] = useState("0");
  useEffect(() => { if (open) void recoveryVersions().then(setVersions).catch(() => {}); }, [open, status.conflict]);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(""); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : "操作失败"); } finally { setBusy(false); } };
  return <div className="syncPanel">
    <button className="syncIndicator" onClick={() => setOpen(!open)} aria-expanded={open} aria-label="同步状态">{status.text}</button>
    {(open || status.needsLogin || !status.ready) && <section className="syncDetails" aria-label="离线与同步">
      <strong>离线与同步</strong>
      <p role="status">{status.text}</p>
      {(error || status.error) && <p role="alert">{error || status.error}</p>}
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
      <small>修改先保存到此浏览器，再同步至云端。清除网站数据会移除未同步内容。离线仅包含笔记数据及应用资源，外部链接和远程图片需要网络。</small>
    </section>}
  </div>;
}
