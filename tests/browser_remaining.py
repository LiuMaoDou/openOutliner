"""Production React regression coverage for the remaining audit findings.
Only disposable loopback servers and generated notes are used.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
from uuid import uuid4
from playwright.sync_api import expect, sync_playwright
from browser_smoke import ROOT, ARTIFACTS, request


def row(page, node):
    return page.locator(f'.nodeRow[data-node-id="{node["id"]}"]')


def switch(page, workspace, first):
    page.locator(f'.workspaceItem[data-workspace-drop-id="{workspace["id"]}"] input').click()
    row(page, first).locator('.nodeTitlePreview').wait_for(state='visible')


def point(page, node, text):
    return row(page, node).locator('.nodeTitlePreview').evaluate("""(root, text) => {
      const walk=document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let node;
      while(node=walk.nextNode()) {
        const at=node.textContent.indexOf(text); if(at<0) continue;
        const range=document.createRange(); range.setStart(node,at);range.setEnd(node,at+1);
        const r=range.getBoundingClientRect();return {x:r.left+r.width*.15,y:r.top+r.height/2};
      }
      throw Error('Visible test word missing: '+text);
    }""", text)


def arm_failure(page):
    # Finish blur-triggered workspace/draft saves before arming the next write.
    page.evaluate("""async () => {
      document.activeElement?.blur();
      await new Promise(resolve=>setTimeout(resolve,0));
      await navigator.locks.request('openoutliner-data',()=>{});
      await new Promise(resolve=>setTimeout(resolve,0));
    }""")
    # Abort a real IndexedDB write before commit, release the data lock, then
    # delay only that mutation's rejection while another workspace loads.
    page.evaluate("""() => {
      if (!window.__originalLocks) {
        window.__originalLocks=navigator.locks.request.bind(navigator.locks);
        const put=IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put=function(value,key) {
          if(window.__holdMutation && this.name==='state' && key==='current' &&
             this.transaction.db.name==='openoutliner-offline-v1' && this.transaction.mode==='readwrite') {
            window.__holdMutation=false;
            const failure=window.__injectedFailure=new Error('Injected delayed mutation failure');
            this.transaction.abort();
            throw failure;
          }
          return put.apply(this,arguments);
        };
        navigator.locks.request=(...args)=>window.__originalLocks(...args).catch(error=>{
          if(error===window.__injectedFailure) {
            window.__held=true;
            return new Promise((resolve,reject)=>{window.__rejectMutation=()=>reject(error);});
          }
          throw error;
        });
      }
      window.__held=false;window.__injectedFailure=null;window.__holdMutation=true;
    }""")


def editor_checks(page, a, b, nodes, other, mapped):
    page.route('**/api/sync*', lambda route: route.abort())
    for node, word, expected in mapped:
        pt=point(page,node,word)
        page.mouse.click(pt['x'],pt['y'])
        editor=row(page,node).locator('textarea.nodeTitle')
        assert editor.evaluate('e=>e.selectionStart') == expected, (node['title'],word,editor.evaluate('e=>e.selectionStart'),expected)
        page.locator('.workspaceTitleInput').click()
    print('PASS real Markdown source caret cases',flush=True)
    # Focused native selection -> node mode -> real keyboard Copy.
    first=row(page,nodes[0]).locator('.nodeTitlePreview').bounding_box()
    last=row(page,nodes[2]).locator('.nodeTitlePreview').bounding_box()
    assert first and last
    page.mouse.click(first['x']+15,first['y']+first['height']/2)
    editor=row(page,nodes[0]).locator('textarea.nodeTitle')
    editor.press('Home');editor.press('Shift+ArrowRight');editor.press('Shift+ArrowRight')
    native=editor.evaluate('e=>e.value.slice(e.selectionStart,e.selectionEnd)')
    page.keyboard.press('ControlOrMeta+c')
    assert page.evaluate('navigator.clipboard.readText()') == native
    page.evaluate("""() => {
      window.__pointerLog=[];
      for(const type of ['pointerdown','pointermove','pointercancel','pointerup','dragstart','focusout']) {
        window.addEventListener(type,e=>window.__pointerLog.push({type,target:e.target?.className,buttons:e.buttons,
          active:document.activeElement?.className, x:e.clientX,y:e.clientY,
          selected:[...document.querySelectorAll('.nodeRow[data-selected="true"]')].map(n=>n.dataset.nodeId)}),true);
      }
    }""")
    page.mouse.move(first['x']+15,first['y']+first['height']/2);page.mouse.down()
    page.mouse.move(last['x']+70,last['y']+last['height']/2,steps=15);page.mouse.up()
    page.mouse.move(1300,950)
    page.wait_for_function('ids=>ids.every(id=>document.querySelector(`[data-node-id="${id}"]`)?.dataset.selected==="true")',arg=[n['id'] for n in nodes])
    page.keyboard.press('ControlOrMeta+c')
    assert page.evaluate('navigator.clipboard.readText()') == '\n'.join(row(page,n).locator('textarea.nodeTitle').input_value() for n in nodes)
    print('PASS real native and multi-row keyboard copy',flush=True)
    # Keep a failed operation in flight while switching to another real workspace.
    page.locator('.workspaceTitleInput').click();page.locator('.workspaceTitleInput').evaluate('e=>e.blur()')
    arm_failure(page)
    row(page,nodes[0]).locator('button.danger').click()
    page.wait_for_function('window.__held === true')
    switch(page,b,other)
    page.evaluate('window.__rejectMutation()')
    page.locator('.errorBar').filter(has_text='Injected delayed mutation failure').wait_for()
    assert row(page,other).count()==1
    assert row(page,nodes[0]).count()==0
    switch(page,a,nodes[0])
    print('PASS failed delete cannot overwrite another workspace',flush=True)
    # Reverting a deletion must preserve a later title edit in this workspace.
    page.locator('.workspaceTitleInput').evaluate('e=>e.blur()')
    arm_failure(page);row(page,nodes[0]).locator('button.danger').click()
    page.wait_for_function('window.__held === true')
    row(page,nodes[2]).locator('.nodeTitlePreview').click()
    later=row(page,nodes[2]).locator('textarea.nodeTitle')
    later.fill('Later title must survive')
    page.wait_for_timeout(450)
    page.evaluate('window.__rejectMutation()')
    page.wait_for_timeout(200)
    assert later.input_value()=='Later title must survive'
    page.locator('.workspaceTitleInput').click()
    page.locator('.workspaceTitleInput').evaluate('e=>e.blur()')
    row(page,nodes[0]).locator('.nodeTitlePreview').wait_for(state='visible')
    assert row(page,nodes[2]).locator('textarea.nodeTitle').input_value()=='Later title must survive'
    # A failed move returning after a workspace switch must not restore A over B either.
    row(page,nodes[1]).locator('.nodeTitlePreview').click()
    arm_failure(page)
    row(page,nodes[1]).locator('textarea.nodeTitle').press('Tab')
    page.wait_for_function('window.__held === true')
    switch(page,b,other);page.evaluate('window.__rejectMutation()')
    page.wait_for_timeout(300)
    assert row(page,other).count()==1 and row(page,nodes[0]).count()==0
    switch(page,a,nodes[0])


def recovery_check(page, directory):
    page.route('**/api/sync*',lambda route:route.abort())
    page.locator('.syncIndicator').click()
    with page.expect_download() as info:
        page.get_by_role('button',name='下载备份').click()
    small=Path(directory)/'initial.json';info.value.save_as(small)
    data=json.loads(small.read_text())
    target=next(n for n in data['local']['nodes'] if n['parent_id'] is not None)
    target['body']='R'*(33*1024*1024)
    large=Path(directory)/'large.json';large.write_text(json.dumps(data,ensure_ascii=False))
    assert large.stat().st_size>32*1024*1024
    page.locator('.syncIndicator').click()
    page.once('dialog', lambda dialog: dialog.accept())
    page.locator('input[aria-label="恢复备份文件"]').set_input_files(large)
    page.get_by_role('button',name='下载备份').wait_for()
    page.wait_for_function("!document.querySelector('.syncActionRow')?.disabled",timeout=60000)
    assert page.locator('.syncDetails [role="alert"]').filter(has_text='恢复文件超过').count()==0
    with page.expect_download(timeout=60000) as info:
        page.get_by_role('button',name='下载备份').click()
    exported=Path(directory)/'roundtrip.json';info.value.save_as(exported)
    restored=json.loads(exported.read_text())
    assert next(n for n in restored['local']['nodes'] if n['id']==target['id'])['body']==target['body']


def update_check(browser, base, original_worker):
    context=browser.new_context(viewport={'width':1440,'height':1000})
    try:
        page=context.new_page();page.goto(base)
        page.locator('.nodeRow').first.wait_for()
        page.evaluate('navigator.serviceWorker.ready')
        page.reload();page.wait_for_function('navigator.serviceWorker.controller !== null')
        second=context.new_page();second.goto(base);second.locator('.nodeRow').first.wait_for()
        worker=ROOT/'dist/web/sw.js'
        worker.write_text(original_worker+'\n// Explicit update regression '+str(time.time())+'\n')
        page.bring_to_front()
        page.evaluate('async()=>{const r=await navigator.serviceWorker.ready;await r.update()}')
        page.wait_for_function('async()=>(await navigator.serviceWorker.ready).waiting!==null')
        page.locator('.syncIndicator').click()
        page.get_by_role('button',name='保存并更新应用').click()
        page.get_by_role('alert').filter(has_text='其他标签页').wait_for()
        assert page.evaluate('!document.getElementById("root").inert')
        assert page.evaluate('async()=>(await navigator.serviceWorker.ready).waiting!==null')
        second.close()
        with page.expect_navigation(wait_until='domcontentloaded'):
            page.get_by_role('button',name='保存并更新应用').click()
        page.locator('.nodeRow').first.wait_for()
        assert page.evaluate('async()=>(await navigator.serviceWorker.ready).waiting===null')
    finally:
        (ROOT/'dist/web/sw.js').write_text(original_worker)
        context.close()


def sync_with_offline_browser_flag(browser, base, node):
    context = browser.new_context()
    context.add_init_script("Object.defineProperty(Navigator.prototype, 'onLine', {get: () => false})")
    try:
        page = context.new_page()
        page.goto(base)
        preview = row(page, node).locator('.nodeTitlePreview')
        preview.wait_for(state='visible', timeout=10000)
        assert page.evaluate('navigator.onLine') is False

        title = 'Synced while the browser reports offline'
        with page.expect_response(lambda response: '/api/sync?' in response.url and
                                   response.request.method == 'POST' and response.ok, timeout=10000):
            preview.click()
            row(page, node).locator('textarea.nodeTitle').fill(title)
            page.locator('.workspaceTitleInput').click()

        assert request(base, f'/api/nodes/{node["id"]}')['title'] == title
        page.locator('.syncIndicator').click()
        expect(page.locator('.syncStatusRow [role="status"]')).to_have_text('已同步')
        with page.expect_response(lambda response: '/api/sync?' in response.url and response.ok, timeout=5000):
            page.evaluate("window.dispatchEvent(new Event('offline'))")
        expect(page.locator('.syncStatusRow [role="status"]')).to_have_text('已同步')
    finally:
        context.close()


def retry_local_startup(browser, base, node):
    context = browser.new_context(service_workers='block')
    context.add_init_script("""(() => {
      const open = IDBFactory.prototype.open;
      let failNext = true;
      IDBFactory.prototype.open = function(name, ...args) {
        if (name !== 'openoutliner-offline-v1' || !failNext) return open.call(this, name, ...args);
        failNext = false;
        const request = {};
        setTimeout(() => request.onerror(), 0);
        return request;
      };
    })()""")
    try:
        page = context.new_page()
        requests = []

        def load_wasm(route):
            requests.append(route.request.url)
            if len(requests) == 1:
                route.fulfill(status=503)
            else:
                route.continue_()

        page.route('**/*.wasm', load_wasm)
        page.goto(base)
        expect(page.get_by_role('alert')).to_contain_text('无法加载本机数据库模块 (503)')
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        row(page, node).locator('.nodeTitlePreview').wait_for(state='visible')
        assert len(requests) == 2
    finally:
        context.close()


def sync_committed_edit_despite_draft_failure(browser, base, first, second):
    context = browser.new_context()
    try:
        page = context.new_page()
        page.goto(base)
        row(page, first).locator('.nodeTitlePreview').wait_for(state='visible')
        pattern = '**/api/sync*'
        page.route(pattern, lambda route: route.abort())

        def edit(node, title):
            row(page, node).locator('.nodeTitlePreview').click()
            row(page, node).locator('textarea.nodeTitle').fill(title)
            page.locator('.workspaceTitleInput').click()

        title = 'Committed independently of the broken draft'
        edit(first, title)
        page.locator('.syncIndicator').click()
        expect(page.get_by_role('status')).to_contain_text('待同步')
        page.get_by_role('button', name='关闭备份与恢复').click()
        page.evaluate("""() => {
          const put = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function(value, key) {
            if (this.name === 'state' && key === 'current' &&
                new TextDecoder().decode(value.bytes).includes('Draft blocked by quota')) {
              this.transaction.abort();
              throw new DOMException('Draft save rejected', 'QuotaExceededError');
            }
            return put.apply(this, arguments);
          };
        }""")
        edit(second, 'Draft blocked by quota')
        page.locator('.syncIndicator').click()
        expect(page.get_by_role('alert')).to_contain_text('Draft save rejected')
        with page.expect_response(lambda response: '/api/sync?' in response.url and
                                   response.request.method == 'POST' and response.ok, timeout=5000):
            page.unroute(pattern)
            page.evaluate("window.dispatchEvent(new Event('focus'))")
        assert request(base, f'/api/nodes/{first["id"]}')['title'] == title
        assert request(base, f'/api/nodes/{second["id"]}')['title'] == second['title']
    finally:
        context.close()


def failed_attachment_cannot_replace_archive(browser, base, first, second):
    context = browser.new_context()
    try:
        page = context.new_page()
        page.goto(base)
        row(page, first).locator('.nodeTitlePreview').wait_for(state='visible')
        before = request(base, '/api/sync')
        changed = before['data']
        changed['nodes'] = [node for node in changed['nodes'] if node['id'] != second['id']]
        archive = {
            'format': 'openoutliner-recovery-v1', 'local': changed,
            'editorDrafts': [{'nodeId': first['id'], 'field': 'title', 'expected': first['title'],
                              'value': 'Attachment', 'updatedAt': '2026-01-01T00:00:00.000Z'}],
            'pendingCreations': [{'id': str(uuid4()), 'owner': 'imported', 'parentId': second['parentId'],
                                  'position': 0, 'initialTitle': 'Creation', 'title': 'Creation',
                                  'body': '', 'version': 'imported', 'updatedAt': '2026-01-01T00:00:00.000Z'}]
        }
        page.evaluate("""() => {
          const write = Storage.prototype.setItem;
          Storage.prototype.setItem = function(key, value) {
            if (key.startsWith('openoutliner-recovery-create-v1:')) {
              throw new DOMException('Recovery attachment rejected', 'QuotaExceededError');
            }
            return write.call(this, key, value);
          };
        }""")
        page.locator('.syncIndicator').click()
        page.once('dialog', lambda dialog: dialog.accept())
        page.locator('input[aria-label="恢复备份文件"]').set_input_files({
            'name': 'restore.json', 'mimeType': 'application/json', 'buffer': json.dumps(archive).encode()
        })
        expect(page.get_by_role('alert')).to_contain_text('Recovery attachment rejected')
        assert page.evaluate("!Object.keys(localStorage).some(key => key.startsWith('openoutliner-recovery-'))")
        with page.expect_response(lambda response: '/api/sync?' in response.url and response.ok, timeout=5000):
            page.evaluate("window.dispatchEvent(new Event('focus'))")
        assert request(base, '/api/sync')['revision'] == before['revision']
        row(page, second).locator('.nodeTitlePreview').wait_for(state='visible')
    finally:
        context.close()


def run():
    with tempfile.TemporaryDirectory(prefix='oo-remaining-') as directory, socket.socket() as probe:
        probe.bind(('127.0.0.1',0));port=probe.getsockname()[1];probe.close()
        base=f'http://127.0.0.1:{port}'
        env=dict(os.environ,OPENOUTLINER_HOST='127.0.0.1',OPENOUTLINER_PORT=str(port),OPENOUTLINER_DB=str(Path(directory)/'test.sqlite'),NODE_ENV='test')
        env.pop('OPENOUTLINER_PASSWORD',None)
        with (ARTIFACTS/'remaining-server.log').open('w') as log:
            server=subprocess.Popen(['node','dist/backend/server/index.js'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    try:request(base,'/api/health');break
                    except OSError:time.sleep(.1)
                a=request(base,'/api/workspaces')[0]
                b=request(base,'/api/workspaces',{'name':'Other regression workspace'})
                other=request(base,'/api/nodes',{'parentId':b['rootNodeId'],'title':'Workspace B must remain visible'})
                nodes=[request(base,'/api/nodes',{'parentId':a['rootNodeId'],'title':title}) for title in ['First copy line','Second copy line','Third copy line']]
                cases=[('**Hello** world','world',10),('See [docs](https://example.com) next','next',32),('{{color:red}}Title{{/color}} tail','tail',29),('**😀中文** tail','中文',4)]
                mapped=[(request(base,'/api/nodes',{'parentId':a['rootNodeId'],'title':title}),word,offset) for title,word,offset in cases]
                with sync_playwright() as p:
                    options={'executable_path':os.environ['OO_CHROMIUM_PATH']} if os.environ.get('OO_CHROMIUM_PATH') else {}
                    browser=p.chromium.launch(**options)
                    try:
                        for theme in ['light','dark']:
                            context=browser.new_context(viewport={'width':1440,'height':1000},permissions=['clipboard-read','clipboard-write'])
                            context.add_init_script(f"try {{ localStorage.setItem('openoutliner-theme',{json.dumps(theme)}) }} catch {{}}")
                            context.tracing.start(screenshots=True,snapshots=True,sources=True)
                            page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
                            try:
                                page.goto(base);row(page,nodes[0]).locator('.nodeTitlePreview').wait_for(state='visible')
                                page.evaluate('document.fonts.ready')
                                editor_checks(page,a,b,nodes,other,mapped)
                                assert not errors,errors
                                page.screenshot(path=str(ARTIFACTS/f'remaining-{theme}.png'))
                                print(f'PASS {theme}: real Markdown caret mapping, keyboard copy, delayed deletion/move failure after workspace switch, preservation of later title edits',flush=True)
                                if theme=='light':
                                    recovery_check(page,directory)
                                    print('PASS actual browser recovery: import and re-export above 32 MiB',flush=True)
                            except Exception:
                                page.screenshot(path=str(ARTIFACTS/f'remaining-{theme}-failure.png'))
                                (ARTIFACTS/f'remaining-{theme}-debug.json').write_text(json.dumps(page.evaluate("""() => ({
                                  events:window.__pointerLog, active:document.activeElement?.outerHTML,
                                  selected:[...document.querySelectorAll('.nodeRow[data-selected="true"]')].map(n=>n.dataset.nodeId),
                                  errorBar:document.querySelector('.errorBar')?.textContent,
                                  held:window.__held, injected:window.__injectedFailure?.message,
                                  alerts:[...document.querySelectorAll('[role="alert"]')].map(n=>n.textContent)
                                })"""),ensure_ascii=False))
                                raise
                            finally:
                                context.tracing.stop(path=str(ARTIFACTS/f'remaining-{theme}-trace.zip'));context.close()
                        original=(ROOT/'dist/web/sw.js').read_text()
                        update_check(browser,base,original)
                        print('PASS actual service worker: multi-client activation refused; single-client explicit update reloads safely',flush=True)
                        sync_with_offline_browser_flag(browser, base, nodes[0])
                        print('PASS automatic sync with a reachable server and a false browser online flag', flush=True)
                        retry_local_startup(browser, base, nodes[0])
                        sync_committed_edit_despite_draft_failure(browser, base, nodes[0], nodes[1])
                        failed_attachment_cannot_replace_archive(browser, base, nodes[0], nodes[2])
                        print('PASS transient storage startup, draft failure isolation, and atomic recovery', flush=True)
                    finally:browser.close()
            finally:
                server.terminate()
                try:server.wait(timeout=5)
                except subprocess.TimeoutExpired:server.kill();server.wait()

if __name__=='__main__':run()
