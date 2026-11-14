"""Ruled-outline geometry in a real production app, using generated notes and a disposable DB.
Run with the same Python Playwright environment as browser_smoke.py. Never uses a live site.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request
from playwright.sync_api import sync_playwright
from browser_smoke import ROOT, ARTIFACTS, request

SNAPSHOT = """() => {
 const list=document.querySelector('.outlineList--ruled');
 const virtual=list?.querySelector('.virtualOutlineList');
 if(!list||!virtual) return null;
 const g=parseFloat(getComputedStyle(list).getPropertyValue('--outline-grid-step'));
 const origin=virtual.getBoundingClientRect().top;
 const pseudo=getComputedStyle(list,'::before');
 const rows=[...virtual.querySelectorAll('.nodeRow')].map(row=>{
   const r=row.getBoundingClientRect(), cs=getComputedStyle(row);
   const input=row.querySelector('.nodeTitle');
   const active=input===document.activeElement;
   const text=active?input:row.querySelector('.nodeTitlePreview');
   const textRects=[];
   if(!active) {
     const walk=document.createTreeWalker(text,NodeFilter.SHOW_TEXT);let node;
     while(node=walk.nextNode()) {
       if(!node.textContent.trim()) continue;
       const range=document.createRange();range.selectNodeContents(node);
       for(const rect of range.getClientRects()) textRects.push({top:rect.top-r.top,height:rect.height});
     }
   }
   const tags=[...row.querySelectorAll('.nodeTagSlot')].map(e=>({top:e.getBoundingClientRect().top-r.top,height:e.getBoundingClientRect().height}));
   return {textRects,tags,id:row.dataset.nodeId,index:Number(row.parentElement.dataset.index),
     offset:r.top-origin,height:r.height,bg:cs.backgroundColor,
     lineHeight:parseFloat(getComputedStyle(text).lineHeight),
     textHeight:text.getBoundingClientRect().height,
     width:r.width, active};
 });
 return {g,origin,pseudoTop:parseFloat(pseudo.top),inset:parseFloat(getComputedStyle(list).paddingTop),
   gridSize:pseudo.backgroundSize, listWidth:list.getBoundingClientRect().width,
   oldGrid:getComputedStyle(document.querySelector('.outlineArtwork')).backgroundImage,rows};
}"""


def validate(page, label):
    page.wait_for_timeout(180)
    data=page.evaluate(SNAPSHOT)
    assert data and data['rows'], (label,'No ruled rows')
    g=data['g']
    assert g == (42 if page.viewport_size['width'] <= 640 else 32), (label,data)
    assert data['pseudoTop'] == data['inset'], (label,'Grid origin differs from first row')
    assert data['oldGrid']=='none', (label,'Duplicate fixed grid remains')
    for row in data['rows']:
        assert abs(row['height']/g-round(row['height']/g)) < .02, (label,'Non-integer row height',row,g)
        assert abs(row['offset']/g-round(row['offset']/g)) < .02, (label,'Row phase drift',row,g)
        assert row['lineHeight']==g, (label,'Text line does not match grid',row,g)
        assert row['bg']=='rgba(0, 0, 0, 0)', (label,'Whole-row selection fill returned',row)
        assert row['textHeight'] <= row['height']+.5, (label,'Title clipping',row)
        for rect in row['textRects']:
            band=int((rect['top']+.1)//g)
            assert rect['top']>=band*g-.5 and rect['top']+rect['height']<=(band+1)*g+.5, (label,'Text crosses grid boundary',row,rect)
        for tag in row['tags']:
            assert abs(tag['top']/g-round(tag['top']/g))<.02, (label,'Metadata begins between grid rows',row,tag)
            assert abs(tag['height']/g-round(tag['height']/g))<.02, (label,'Metadata height is off grid',row,tag)
    for a,b in zip(data['rows'],data['rows'][1:]):
        if b['index']==a['index']+1:
            assert abs(b['offset']-a['offset']-a['height']) < .5, (label,'Overlap/gap',a,b)
    return {'label':label,'step':g,'mountedRows':len(data['rows']),'first':data['rows'][0]['index']}


def run():
    with tempfile.TemporaryDirectory(prefix='oo-grid-db-') as tmp, socket.socket() as probe:
        probe.bind(('127.0.0.1',0));port=probe.getsockname()[1];probe.close()
        base=f'http://127.0.0.1:{port}'
        env=dict(os.environ,OPENOUTLINER_HOST='127.0.0.1',OPENOUTLINER_PORT=str(port),
                 OPENOUTLINER_DB=str(Path(tmp)/'grid.sqlite'),NODE_ENV='test')
        env.pop('OPENOUTLINER_PASSWORD',None)
        with (ARTIFACTS/'grid-server.log').open('w') as log:
            server=subprocess.Popen(['node','dist/backend/server/index.js'],cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
            try:
                for _ in range(100):
                    try:
                        request(base,'/api/health');break
                    except OSError: time.sleep(.1)
                else: raise RuntimeError('Grid test server did not start')
                workspace=request(base,'/api/workspaces')[0]
                titles=[
                    '每一行文字，对齐一行网格',
                    '这是一个用于验证自动换行的较长标题，调整窗口宽度后，每个可见文字行仍应落在完整网格内，不出现半行错位。'*2,
                    '**Markdown**、*斜体*、`code` 与 {{color:blue}}蓝色文字{{/color}}',
                    '含标签与日期的节点',
                    '[很短的链接](https://example.com/'+('long-segment/'*18)+')',
                    '父节点，展开后子节点仍然对齐',
                ]
                nodes=[request(base,'/api/nodes',{'parentId':workspace['rootNodeId'],'title':title}) for title in titles]
                children=[request(base,'/api/nodes',{'parentId':nodes[5]['id'],'title':title}) for title in ['子节点一：保持原有缩进','子节点二：测试折叠和展开']]
                date_request=urllib.request.Request(base+f'/api/nodes/{nodes[3]["id"]}',data=json.dumps({'dueDate':'2030-01-15'}).encode(),headers={'content-type':'application/json'},method='PATCH')
                with urllib.request.urlopen(date_request,timeout=5) as response: assert response.status==200
                for name in ['界面设计','网格对齐','文字选择','回归测试','多行标题','滚动验证']:
                    request(base,f'/api/nodes/{nodes[3]["id"]}/tags',{'name':name})
                for index in range(110):
                    request(base,'/api/nodes',{'parentId':workspace['rootNodeId'],'title':f'第 {index:03d} 条大纲：连续滚动后仍保持网格对齐'})
                report=[]
                with sync_playwright() as p:
                    browser=p.chromium.launch()
                    try:
                        for theme in ['light','dark']:
                            for viewport in [{'width':1440,'height':1000},{'width':390,'height':844}]:
                                name=f'{theme}-{viewport["width"]}'
                                context=browser.new_context(viewport=viewport)
                                context.add_init_script(f"localStorage.setItem('openoutliner-theme',{json.dumps(theme)});")
                                context.tracing.start(screenshots=True,snapshots=True,sources=True)
                                page=context.new_page();errors=[]
                                page.on('pageerror',lambda e:errors.append(str(e)))
                                try:
                                    page.goto(base)
                                    first=page.locator(f'.nodeRow[data-node-id="{nodes[0]["id"]}"]')
                                    first.locator('.nodeTitlePreview').wait_for()
                                    page.evaluate('document.fonts.ready')
                                    assert page.title()=='OpenOutliner'
                                    assert page.url.startswith(base)
                                    assert not page.locator('vite-error-overlay').count()
                                    report.append(validate(page,name+' initial'))
                                    step=32 if viewport['width']>640 else 42
                                    assert first.evaluate('e=>e.getBoundingClientRect().height')==step
                                    first.locator('.nodeTitlePreview').click()
                                    editor=first.locator('textarea')
                                    editor.fill('第一行\n第二行\n第三行')
                                    page.wait_for_function('(x)=>document.querySelector(`[data-node-id="${x.id}"]`).getBoundingClientRect().height===x.height',arg={'id':nodes[0]['id'],'height':step*3})
                                    report.append(validate(page,name+' three lines'))
                                    editor.fill(titles[0])
                                    page.wait_for_function('(x)=>document.querySelector(`[data-node-id="${x.id}"]`).getBoundingClientRect().height===x.height',arg={'id':nodes[0]['id'],'height':step})
                                    page.locator('.workspaceTitleInput').click()
                                    report.append(validate(page,name+' shrink'))
                                    page.locator('.workspaceTitleInput').evaluate('e=>e.blur()')
                                    page.locator('.workspaceTitleInput').hover()
                                    assert page.locator('.workspaceTitleInput').evaluate('e=>getComputedStyle(e).backgroundColor')=='rgba(0, 0, 0, 0)'
                                    page.screenshot(path=str(ARTIFACTS/f'grid-{name}.png'))
                                    # The scroll distances deliberately are not multiples of the grid.
                                    for distance in [17,137,611,2801,0]:
                                        page.evaluate('(y)=>{const s=document.querySelector(innerWidth<=760?".contentGrid":".outlineSurface");s.scrollTop=y}',distance)
                                        report.append(validate(page,f'{name} scroll {distance}'))
                                    # Changing between desktop and touch units must invalidate cached row sizes.
                                    if viewport['width']==1440:
                                        for width in [1100,600,900,1440]:
                                            page.set_viewport_size({'width':width,'height':1000})
                                            report.append(validate(page,f'{name} resize {width}'))
                                        link=page.locator(f'.nodeRow[data-node-id="{nodes[4]["id"]}"]')
                                        link.locator('textarea').focus()
                                        report.append(validate(page,name+' long Markdown source'))
                                        source_height=link.evaluate('e=>e.getBoundingClientRect().height')
                                        page.locator('.workspaceTitleInput').click()
                                        report.append(validate(page,name+' Markdown preview'))
                                        assert link.evaluate('e=>e.getBoundingClientRect().height')<=source_height
                                        parent=page.locator(f'.nodeRow[data-node-id="{nodes[5]["id"]}"]')
                                        parent.locator('.disclosureButton').click()
                                        report.append(validate(page,name+' collapse'))
                                        assert not page.locator(f'[data-node-id="{children[0]["id"]}"]').count()
                                        parent.locator('.disclosureButton').click()
                                        report.append(validate(page,name+' expand'))
                                        page.locator('.sidebarSearch input').fill('第 00')
                                        report.append(validate(page,name+' filtered outline'))
                                        page.locator('.sidebarSearch input').fill('')
                                        report.append(validate(page,name+' clear search'))
                                        page.locator('.systemWorkspaceItem').filter(has_text='Tags').click()
                                        page.wait_for_timeout(200)
                                        assert not page.locator('.outlineList--ruled').count()
                                        page.locator('.systemWorkspaceItem').filter(has_text='Recycle Bin').click()
                                        page.wait_for_timeout(200)
                                        assert not page.locator('.outlineList--ruled').count()
                                        page.locator('.systemWorkspaceItem[title="Calendar"]').click()
                                        page.wait_for_timeout(200)
                                        assert not page.locator('.outlineList--ruled').count()
                                    assert not errors,errors
                                    print('PASS grid',name,flush=True)
                                except Exception:
                                    page.screenshot(path=str(ARTIFACTS/f'grid-failure-{name}.png'))
                                    (ARTIFACTS/f'grid-failure-{name}.json').write_text(json.dumps({'geometry':page.evaluate(SNAPSHOT),'errors':errors},ensure_ascii=False,indent=2))
                                    raise
                                finally:
                                    context.tracing.stop(path=str(ARTIFACTS/f'grid-trace-{name}.zip'))
                                    context.close()
                    finally: browser.close()
                (ARTIFACTS/'grid-results.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
                print(f'PASS {len(report)} grid scenarios; artifacts: {ARTIFACTS}',flush=True)
            finally:
                server.terminate()
                try: server.wait(timeout=5)
                except subprocess.TimeoutExpired: server.kill();server.wait()

if __name__=='__main__': run()
