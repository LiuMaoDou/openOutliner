import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {patchWorkspace, parseWorkspacePatch, InvalidWorkspacePatch} from '../../dist/backend/shared/workspacePatch.js';

// Command-boundary integration tests use real SQLite transactions and a small SQL adapter.
// tests/workspacePatch.test.ts also exercises the application's actual service and dispatch.
function setup(t) {
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  db.exec("CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT,folderId TEXT,parentWorkspaceId TEXT,position INTEGER); INSERT INTO workspaces VALUES('a','Alpha',NULL,NULL,0),('b','Beta','folder',NULL,0);");
  const calls=[];
  const service={
    importTransaction(fn){db.exec('SAVEPOINT patch');try{const r=fn();db.exec('RELEASE patch');return r;}catch(e){db.exec('ROLLBACK TO patch; RELEASE patch');throw e;}},
    getWorkspace(id){const w=db.prepare('SELECT * FROM workspaces WHERE id=?').get(id);if(!w)throw new Error('Not found');return {...w};},
    moveWorkspace(id,folderId,position,parentWorkspaceId){calls.push('move');db.prepare('UPDATE workspaces SET position=position+1 WHERE folderId IS ?').run(folderId);db.prepare('UPDATE workspaces SET folderId=?,position=?,parentWorkspaceId=? WHERE id=?').run(folderId,position,parentWorkspaceId,id);return this.getWorkspace(id);},
    updateWorkspace(id,input){calls.push('rename');if(input.name!==undefined)db.prepare('UPDATE workspaces SET name=? WHERE id=?').run(input.name,id);return this.getWorkspace(id);}
  };
  return {db,service,calls,rows:()=>db.prepare('SELECT * FROM workspaces ORDER BY id').all().map(r=>({...r}))};
}
test('invalid rename is rejected before move or sibling changes',t=>{
  const {service,calls,rows}=setup(t), before=rows();
  assert.throws(()=>patchWorkspace(service,'a',{folderId:'folder',name:'  '}),InvalidWorkspacePatch);
  assert.deepEqual(rows(),before);assert.deepEqual(calls,[]);
});
test('rename failure rolls back move and sibling positions together',t=>{
  const {service,calls,rows}=setup(t), before=rows();
  service.updateWorkspace=()=>{throw new Error('injected write failure');};
  assert.throws(()=>patchWorkspace(service,'a',{folderId:'folder',position:0,name:'Renamed'}),/injected/);
  assert.deepEqual(calls,['move']);assert.deepEqual(rows(),before);
});
test('successful move and rename commit as one transaction',t=>{
  const {service,calls}=setup(t);
  const row=patchWorkspace(service,'a',{folderId:'folder',position:1,name:'  New name  '});
  assert.deepEqual(calls,['move','rename']);assert.equal(row.name,'New name');assert.equal(row.folderId,'folder');assert.equal(row.position,1);
});
test('rename-only requests retain folder and position',t=>{
  const {service,calls}=setup(t);
  const row=patchWorkspace(service,'a',{name:'Renamed'});
  assert.deepEqual(calls,['rename']);assert.equal(row.position,0);assert.equal(row.folderId,null);
});
test('explicit null folder and parent are not confused with omitted keys',t=>{
  const {service}=setup(t);
  const row=patchWorkspace(service,'b',{folderId:null,parentWorkspaceId:null,position:0});
  assert.equal(row.folderId,null);assert.equal(row.parentWorkspaceId,null);
});
test('bad request shapes and positions are rejected predictably',()=>{
  for(const value of [null,undefined,[],42,'name',{name:1},{folderId:0},{folderId:''},{parentWorkspaceId:false},{position:-1},{position:1.5},{position:Infinity},{position:'1'}]){
    assert.throws(()=>parseWorkspacePatch(value),InvalidWorkspacePatch);
  }
  assert.deepEqual(parseWorkspacePatch({name:' Okay ',position:0}),{name:'Okay',position:0});
});
