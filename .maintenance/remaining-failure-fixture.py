from pathlib import Path
path = Path('tests/browser_remaining.py')
content = path.read_text()
start = content.index('def arm_failure(page):')
end = content.index('\n\ndef editor_checks(', start)
new = '''def arm_failure(page):
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
'''
content = content[:start] + new + content[end:]
old = 'context.add_init_script(f"localStorage.setItem(\'openoutliner-theme\',{json.dumps(theme)})")'
new = 'context.add_init_script(f"try {{ localStorage.setItem(\'openoutliner-theme\',{json.dumps(theme)}) }} catch {{}}")'
assert content.count(old)==1
content = content.replace(old,new,1)
old = 'def editor_checks(page, a, b, nodes, other, mapped):\n'
assert content.count(old)==1
content = content.replace(old, old + "    page.route('**/api/sync', lambda route: route.abort())\n",1)
content = content.replace('    # Focused native selection -> node mode -> real keyboard Copy.', "    print('PASS real Markdown source caret cases',flush=True)\n    # Focused native selection -> node mode -> real keyboard Copy.",1)
content = content.replace('    # Keep a failed operation in flight while switching to another real workspace.', "    print('PASS real native and multi-row keyboard copy',flush=True)\n    # Keep a failed operation in flight while switching to another real workspace.",1)
content = content.replace('    # Reverting a deletion must preserve a later title edit in this workspace.', "    print('PASS failed delete cannot overwrite another workspace',flush=True)\n    # Reverting a deletion must preserve a later title edit in this workspace.",1)
path.write_text(content)
print('Inject real persistence failures after preceding blur saves, without competing background sync.')
