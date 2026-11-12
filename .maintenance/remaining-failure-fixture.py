from pathlib import Path
path = Path('tests/browser_remaining.py')
content = path.read_text()
start = content.index('def arm_failure(page):')
end = content.index('\n\ndef editor_checks(', start)
new = '''def arm_failure(page):
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
path.write_text(content)
print('Inject real persistence failures instead of accidentally holding unrelated read requests.')
