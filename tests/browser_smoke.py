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
                                # Parent workspace names are bold; selecting a leaf alone changes no weight.
                                weights = page.evaluate("""() => {
                                  const source = document.querySelector('.workspaceItem.active > input');
                                  if (!source) return null;
                                  const original = source.parentElement;
                                  const clone = original.cloneNode(true);
                                  clone.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none';
                                  document.body.appendChild(clone);
                                  try {
                                    const weight = (isParent, isActive) => {
                                      clone.classList.toggle('hasChildren', isParent);
                                      clone.classList.toggle('active', isActive);
                                      return getComputedStyle(clone.querySelector('input')).fontWeight;
                                    };
                                    return {
                                      parentActive: weight(true, true),
                                      parentInactive: weight(true, false),
                                      leafActive: weight(false, true),
                                      leafInactive: weight(false, false)
                                    };
                                  } finally { clone.remove(); }
                                }""")
                                assert weights == {
                                    "parentActive": "750", "parentInactive": "750",
                                    "leafActive": "400", "leafInactive": "400"
                                }, f"Workspace parent/leaf weights differ in {theme}: {weights}"
                                # Comments note height persists across selection changes and reloads.
                                notes = page.locator('.notesAlert textarea.nodeNotes')
                                if notes.count() == 0:
                                    row.locator('.nodeTitlePreview').click()
                                notes.wait_for(state="visible")
                                assert notes.evaluate("e=>getComputedStyle(e).resize") == "vertical"
                                height = 312 if theme == "light" else 348
                                notes.evaluate("(e, height) => { e.style.height = height + 'px'; }", height)
                                page.wait_for_function(
                                    "height => localStorage.getItem('openoutliner.comments-notes-height:v1') === String(height)",
                                    arg=height
                                )
                                other_row = page.locator(f'.nodeRow[data-node-id="{nodes[1]["id"]}"]')
                                other_row.locator('.nodeTitlePreview').click()
                                notes.wait_for(state="visible")
                                assert abs(notes.evaluate("e=>e.getBoundingClientRect().height") - height) <= 1, "Comments height lost on node switch"
                                page.reload()
                                row.locator('.nodeTitlePreview').wait_for(state="visible")
                                notes.wait_for(state="visible")
                                assert abs(notes.evaluate("e=>e.getBoundingClientRect().height") - height) <= 1, "Comments height lost on reload"
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
                                # Sidebar workspace-name text selection matches content-title selection.
                                selection_colors = page.evaluate("""() => {
                                  const sidebar = document.querySelector('.workspaceItem.active > input');
                                  const content = document.querySelector('.nodeRow .nodeTitle');
                                  if (!sidebar || !content) return null;
                                  sidebar.focus();
                                  sidebar.select();
                                  return {
                                    selected: sidebar.selectionEnd - sidebar.selectionStart,
                                    length: sidebar.value.length,
                                    sidebar: getComputedStyle(sidebar, '::selection').backgroundColor,
                                    content: getComputedStyle(content, '::selection').backgroundColor
                                  };
                                }""")
                                assert selection_colors, "Active workspace name or outline title missing"
                                assert selection_colors["length"] > 0
                                assert selection_colors["selected"] == selection_colors["length"], "Workspace name was not selected"
                                assert selection_colors["sidebar"] == selection_colors["content"], (
                                    f"Sidebar and content text selection colors differ in {theme}: {selection_colors}")
                                # Hovering the content-area workspace heading must not paint a background.
                                heading = page.locator('.workspaceTitleInput')
                                heading.hover()
                                assert heading.evaluate("e=>getComputedStyle(e).backgroundColor") == 'rgba(0, 0, 0, 0)', (
                                    f"Content heading gained a hover background in {theme}")
                                # Control order: title, count, date, (tags), delete.
                                primary_row = page.locator(f'.nodeRow[data-node-id="{nodes[0]["id"]}"]')
                                sibling_row = page.locator(f'.nodeRow[data-node-id="{nodes[1]["id"]}"]')
                                controls = primary_row.evaluate("""row => [...row.children]
                                  .map(element => {
                                    if (element.matches('.nodeTitleCell')) return 'title';
                                    if (element.matches('.nodeChildCount')) return 'count';
                                    if (element.matches('.nodeDateControl')) return 'date';
                                    if (element.matches('.iconButton.danger')) return 'delete';
                                    return null;
                                  }).filter(Boolean)""")
                                assert controls == ["title", "count", "date", "delete"], controls
                                preview = primary_row.locator('.nodeTitlePreview')
                                title_editor = primary_row.locator('textarea.nodeTitle')
                                base_color = preview.evaluate("e => getComputedStyle(e).color")
                                calendar_color = {"light": "rgb(87, 116, 103)", "dark": "rgb(169, 199, 185)"}[theme]
                                delete_color = {"light": "rgb(149, 94, 107)", "dark": "rgb(224, 173, 184)"}[theme]
                                primary_row.locator('.nodeDateAddButton').hover()
                                page.wait_for_function(
                                    """({id, color}) => getComputedStyle(
                                      document.querySelector(`.nodeRow[data-node-id="${id}"] .nodeTitlePreview`)
                                    ).color === color""",
                                    arg={"id": nodes[0]["id"], "color": calendar_color})
                                assert preview.evaluate("e => getComputedStyle(e).color") == calendar_color
                                assert title_editor.evaluate("e => getComputedStyle(e).color") == calendar_color
                                assert sibling_row.locator('.nodeTitlePreview').evaluate(
                                    "e => getComputedStyle(e).color") == base_color, "Another row's title changed"
                                primary_row.locator('.iconButton.danger').hover()
                                page.wait_for_function(
                                    """({id, color}) => getComputedStyle(
                                      document.querySelector(`.nodeRow[data-node-id="${id}"] .nodeTitlePreview`)
                                    ).color === color""",
                                    arg={"id": nodes[0]["id"], "color": delete_color})
                                assert preview.evaluate("e => getComputedStyle(e).color") == delete_color
                                assert title_editor.evaluate("e => getComputedStyle(e).color") == delete_color
                                page.mouse.move(1350, 900)
                                page.wait_for_function(
                                    """({id, color}) => getComputedStyle(
                                      document.querySelector(`.nodeRow[data-node-id="${id}"] .nodeTitlePreview`)
                                    ).color === color""",
                                    arg={"id": nodes[0]["id"], "color": base_color})
                                assert preview.evaluate("e => getComputedStyle(e).color") == base_color

                                # The Markdown toolbar must survive its own controls and close
                                # on the initial outside pointerdown, even on a title preview
                                # whose React handler stops event propagation.
                                title_editor.focus()
                                title_editor.press("Home")
                                title_editor.press("Shift+ArrowRight")
                                format_menu = page.get_by_role("dialog", name="Format selected text")
                                format_menu.wait_for(state="visible")
                                format_menu.get_by_role("button", name="Text color").click()
                                format_menu.get_by_role("group", name="Text colors").wait_for(state="visible")
                                format_menu.get_by_role("button", name="Text color").click()
                                target_box = sibling_row.locator('.nodeTitlePreview').bounding_box()
                                assert target_box
                                page.mouse.move(target_box["x"] + 14, target_box["y"] + target_box["height"] / 2)
                                page.mouse.down()
                                assert page.locator('.markdownContextMenu').count() == 0, (
                                    "Markdown toolbar did not dismiss on outside pointerdown")
                                page.mouse.up()
                                title_editor.focus()
                                title_editor.press("Home")
                                title_editor.press("Shift+ArrowRight")
                                format_menu.wait_for(state="visible")
                                page.evaluate("window.dispatchEvent(new Event('blur'))")
                                format_menu.wait_for(state="detached")

                                # Adding a child to a collapsed Workspace must reveal the new child.
                                parent = page.locator(f'.workspaceItem[data-workspace-drop-id="{workspace["id"]}"]')
                                children = page.locator(f'.workspaceItem[data-workspace-parent-id="{workspace["id"]}"]')
                                add_child = parent.locator('button.workspaceAddChildButton')
                                toggle = parent.locator('button.workspaceIcon')
                                if children.count() == 0:
                                    add_child.click()
                                    page.wait_for_function(
                                        """id => [...document.querySelectorAll('.workspaceItem')]
                                          .some(item => item.dataset.workspaceParentId === id)""",
                                        arg=workspace["id"])
                                # Parent title is bold whether expanded or collapsed; a leaf stays regular.
                                assert "hasChildren" in (parent.get_attribute("class") or "")
                                assert parent.locator("input").evaluate(
                                    "e => Number(getComputedStyle(e).fontWeight)") >= 600, "Parent workspace title is not bold"
                                leaf_inputs = page.locator(
                                    f'.workspaceItem[data-workspace-parent-id="{workspace["id"]}"]:not(.hasChildren) > input')
                                assert leaf_inputs.count() > 0, "Missing leaf workspace for font-weight regression"
                                assert leaf_inputs.first.evaluate(
                                    "e => Number(getComputedStyle(e).fontWeight)") == 400, "Leaf workspace title should stay regular"
                                if toggle.get_attribute("aria-expanded") == "false":
                                    toggle.click()
                                previous_child_count = children.count()
                                toggle.click()
                                page.wait_for_function(
                                    """id => {
                                      const item = [...document.querySelectorAll('.workspaceItem')]
                                        .find(item => item.dataset.workspaceDropId === id);
                                      return item?.querySelector('button.workspaceIcon')?.getAttribute('aria-expanded') === 'false';
                                    }""",
                                    arg=workspace["id"])
                                assert children.count() == 0, "Collapsed workspace still shows children"
                                add_child.click()
                                page.wait_for_function(
                                    """({id, count}) => {
                                      const items = [...document.querySelectorAll('.workspaceItem')];
                                      const parent = items.find(item => item.dataset.workspaceDropId === id);
                                      return parent?.querySelector('button.workspaceIcon')?.getAttribute('aria-expanded') === 'true'
                                        && items.filter(item => item.dataset.workspaceParentId === id).length === count;
                                    }""",
                                    arg={"id": workspace["id"], "count": previous_child_count + 1})
                                parent.locator('input').click()
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
