"""Full-app smoke tests against a disposable local server/database, never a live deployment.

Run after `npm run build` with Python Playwright 1.57.0 and Chromium installed.
No production notes, passwords or hosted URLs are used.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = Path(os.environ.get("OO_BROWSER_ARTIFACTS", tempfile.mkdtemp(prefix="oo-browser-results-"))).resolve()
ARTIFACTS.mkdir(parents=True, exist_ok=True)


def request(base: str, path: str, data=None):
    req = urllib.request.Request(base + path, data=json.dumps(data).encode() if data is not None else None,
                                 headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as response:
        return json.load(response)


READ_STATE = """() => new Promise((resolve,reject) => {
 const open=indexedDB.open('openoutliner-offline-v1',1);
 open.onerror=()=>reject(open.error);
 open.onsuccess=()=>{
  const db=open.result,tx=db.transaction('state'),get=tx.objectStore('state').get('current');
  get.onsuccess=()=>resolve(get.result);get.onerror=()=>reject(get.error);
  tx.oncomplete=()=>db.close();
 };
})"""


def run():
    if not (ROOT / "dist/backend/server/index.js").exists():
        raise RuntimeError("Run npm run build before the browser tests.")
    with tempfile.TemporaryDirectory(prefix="oo-smoke-db-") as tmp, socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
        probe.close()
        base = f"http://127.0.0.1:{port}"
        env = dict(os.environ, OPENOUTLINER_HOST="127.0.0.1", OPENOUTLINER_PORT=str(port),
                   OPENOUTLINER_DB=str(Path(tmp) / "isolated.sqlite"), NODE_ENV="test")
        env.pop("OPENOUTLINER_PASSWORD", None)
        with (ARTIFACTS / "server.log").open("w") as log:
            server = subprocess.Popen(["node", "dist/backend/server/index.js"], cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    if server.poll() is not None:
                        raise RuntimeError("Disposable server exited; see server.log")
                    try:
                        request(base, "/api/health")
                        break
                    except (OSError, urllib.error.URLError):
                        time.sleep(.1)
                else:
                    raise RuntimeError("Disposable server did not become healthy")
                workspace = request(base, "/api/workspaces")[0]
                nodes = [request(base, "/api/nodes", {"parentId": workspace["rootNodeId"], "title": title}) for title in
                         ["Reliability first title for selection", "Reliability second title", "Reliability third title"]]
                with sync_playwright() as p:
                    browser = p.chromium.launch()
                    try:
                        for theme in ["light", "dark"]:
                            context = browser.new_context(viewport={"width": 1440, "height": 1000})
                            context.add_init_script(f"localStorage.setItem('openoutliner-theme', {json.dumps(theme)});")
                            context.tracing.start(screenshots=True, snapshots=True, sources=True)
                            page = context.new_page()
                            errors = []
                            page.on("pageerror", lambda error: errors.append(str(error)))
                            try:
                                page.goto(base)
                                row = page.locator(f'.nodeRow[data-node-id="{nodes[0]["id"]}"]')
                                row.locator('.nodeTitlePreview').wait_for(state="visible")
                                page.evaluate("document.fonts.ready")
                                assert page.title(), "Missing page title"
                                assert page.locator("vite-error-overlay").count() == 0
                                preview = row.locator('.nodeTitlePreview')
                                bounds = preview.bounding_box()
                                assert bounds
                                x, y = bounds["x"] + 13, bounds["y"] + bounds["height"] / 2
                                page.mouse.move(x, y); page.mouse.down()
                                page.mouse.move(x + 80, y, steps=12); page.mouse.up()
                                editor = row.locator('textarea.nodeTitle')
                                selected = editor.evaluate("e=>[e.selectionStart,e.selectionEnd]")
                                assert selected[1] > selected[0], "Single-title drag did not select characters"
                                page.mouse.move(1350, 900)
                                assert editor.evaluate("e=>[e.selectionStart,e.selectionEnd]") == selected, "Mouse exit collapsed selection"
                                # Native focused-editor selection remains available.
                                editor.press("Home"); editor.press("Shift+ArrowRight")
                                assert editor.evaluate("e=>e.selectionEnd>e.selectionStart")
                                page.locator('.workspaceTitleInput').click()
                                for start, end in [(0, 2), (2, 0)]:
                                    source = page.locator(f'.nodeRow[data-node-id="{nodes[start]["id"]}"] .nodeTitlePreview')
                                    target = page.locator(f'.nodeRow[data-node-id="{nodes[end]["id"]}"] .nodeTitlePreview')
                                    a, b = source.bounding_box(), target.bounding_box()
                                    assert a and b
                                    page.mouse.move(a["x"] + 15, a["y"] + a["height"]/2); page.mouse.down()
                                    page.mouse.move(b["x"] + 80, b["y"] + b["height"]/2, steps=18); page.mouse.up()
                                    page.mouse.move(1350, 900)
                                    page.wait_for_function("ids=>ids.every(id=>document.querySelector(`[data-node-id=\"${id}\"]`)?.dataset.selected==='true')", arg=[n["id"] for n in nodes])
                                    for node in nodes:
                                        selected_row=page.locator(f'.nodeRow[data-node-id="{node["id"]}"]')
                                        assert selected_row.evaluate("e=>getComputedStyle(e).backgroundColor") == 'rgba(0, 0, 0, 0)'
                                page.screenshot(path=str(ARTIFACTS / f"selection-{theme}.png"))
                                assert not errors, errors
                                # Force an old envelope, then verify actual app startup upgrades it atomically.
                                page.route("**/api/sync", lambda route: route.abort())
                                page.evaluate("""() => new Promise((resolve,reject)=>{
                                  const open=indexedDB.open('openoutliner-offline-v1',1);
                                  open.onerror=()=>reject(open.error);
                                  open.onsuccess=()=>{
                                    const db=open.result,tx=db.transaction('state','readwrite'),store=tx.objectStore('state'),get=store.get('current');
                                    get.onsuccess=()=>{const state=get.result; delete state.schemaVersion; for(const n of state.base.nodes) delete n.due_date; store.put(state,'current');};
                                    tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);
                                  };
                                })""")
                                page.reload()
                                row.locator('.nodeTitlePreview').wait_for(state="visible")
                                page.wait_for_function("""async () => {
                                  return await new Promise(resolve=>{
                                    const o=indexedDB.open('openoutliner-offline-v1',1);o.onsuccess=()=>{
                                      const db=o.result,tx=db.transaction('state'),s=tx.objectStore('state');
                                      let upgraded=false,backup=false;
                                      s.get('current').onsuccess=e=>{upgraded=e.target.result?.schemaVersion===1};
                                      s.get('before-schema-0').onsuccess=e=>{backup=Boolean(e.target.result?.bytes)};
                                      tx.oncomplete=()=>{db.close();resolve(upgraded&&backup)};
                                    };
                                  });
                                }""")
                                assert not errors, errors
                                print(f"PASS full app / {theme}: load, character selection, native selection, forward/reverse multi-row, transparent rows, persisted schema envelope upgrade")
                            finally:
                                context.tracing.stop(path=str(ARTIFACTS / f"trace-{theme}.zip"))
                                context.close()
                    finally:
                        browser.close()
            finally:
                server.terminate()
                try:
                    server.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    server.kill(); server.wait()
    print(f"Artifacts: {ARTIFACTS}")


if __name__ == '__main__':
    run()
