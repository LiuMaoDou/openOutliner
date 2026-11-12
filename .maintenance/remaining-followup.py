from pathlib import Path

def replace(path, old, new):
    file = Path(path)
    content = file.read_text()
    if content.count(old) != 1:
        raise ValueError(f'Expected one exact source anchor in {path}')
    file.write_text(content.replace(old, new, 1))

replace('src/web/App.tsx', '''          className="nodeTitle"
          {...inlineTags.inputProps}''', '''          className="nodeTitle"
          onDragStart={event => {
            // A title gesture selects characters or rows. Native dragging of an
            // existing text selection would cancel the pointer controller.
            event.preventDefault();
          }}
          {...inlineTags.inputProps}''')
replace('tests/browser_remaining.py', '''    page.mouse.move(first['x']+15,first['y']+first['height']/2);page.mouse.down()
''', '''    page.evaluate("""() => {
      window.__pointerLog=[];
      for(const type of ['pointerdown','pointermove','pointercancel','pointerup','dragstart','focusout']) {
        window.addEventListener(type,e=>window.__pointerLog.push({type,target:e.target?.className,buttons:e.buttons,
          active:document.activeElement?.className, x:e.clientX,y:e.clientY,
          selected:[...document.querySelectorAll('.nodeRow[data-selected="true"]')].map(n=>n.dataset.nodeId)}),true);
      }
    }""")
    page.mouse.move(first['x']+15,first['y']+first['height']/2);page.mouse.down()
''')
replace('tests/browser_remaining.py', '''                            finally:
                                context.tracing.stop(path=str(ARTIFACTS/f'remaining-{theme}-trace.zip'));context.close()
''', '''                            except Exception:
                                page.screenshot(path=str(ARTIFACTS/f'remaining-{theme}-failure.png'))
                                (ARTIFACTS/f'remaining-{theme}-debug.json').write_text(json.dumps(page.evaluate("""() => ({
                                  events:window.__pointerLog, active:document.activeElement?.outerHTML,
                                  selected:[...document.querySelectorAll('.nodeRow[data-selected="true"]')].map(n=>n.dataset.nodeId),
                                  alerts:[...document.querySelectorAll('[role="alert"]')].map(n=>n.textContent)
                                })"""),ensure_ascii=False))
                                raise
                            finally:
                                context.tracing.stop(path=str(ARTIFACTS/f'remaining-{theme}-trace.zip'));context.close()
''')
print('Applied reviewed follow-up: prevent native text drag takeover; retain failure diagnostics.')
