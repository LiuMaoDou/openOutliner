import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrate, SCHEMA_VERSION } from '../../dist/backend/shared/schema.js';
import { needsStoredUpgrade, upgradeSnapshot, upgradeStoredState } from '../../dist/backend/shared/storedState.js';

const tables = ['workspace_folders', 'workspaces', 'nodes', 'tags', 'node_tags', 'field_definitions', 'field_values'];
const snap = db => Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all().map(r => ({...r}))]));
const schema = db => db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map(r => ({...r}));
function fresh(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys=ON');
  migrate(db);
  return db;
}
function seed(db) {
  db.exec(`INSERT INTO workspaces (id,name,root_node_id,position,created_at,updated_at) VALUES
    ('b','Workspace B','root-b',8,'2026-01-01','2026-01-01'),
    ('a','Workspace A','root-a',3,'2026-01-01','2026-01-01');
    INSERT INTO nodes (id,workspace_id,parent_id,title,body,created_at,updated_at) VALUES
    ('root-a','a',NULL,'Workspace A','','2026-01-01','2026-01-01'),
    ('root-b','b',NULL,'Workspace B','','2026-01-01','2026-01-01'),
    ('note','a','root-a','Original title','原始笔记','2026-01-01','2026-01-01');
    INSERT INTO outline_history (id,workspace_id,label,before_snapshot,after_snapshot,created_at,updated_at)
    VALUES ('hist','a','Edit','{}','{}','2026-01-01','2026-01-01');
    INSERT INTO tags VALUES ('tag','a','important','#abcdef','2026-01-01');
    INSERT INTO node_tags VALUES ('note','tag');
    INSERT INTO field_definitions VALUES ('field','a','tag','priority','text',NULL,'2026-01-01');
    INSERT INTO field_values VALUES ('note','field','high','2026-01-01');`);
}
function legacy(db, all=true) {
  db.exec('PRAGMA user_version=0; ALTER TABLE nodes DROP COLUMN due_date;');
  if (all) db.exec(`ALTER TABLE workspaces DROP COLUMN icon;
    ALTER TABLE workspaces DROP COLUMN folder_id;
    ALTER TABLE workspaces DROP COLUMN parent_workspace_id;
    ALTER TABLE workspaces DROP COLUMN position;
    ALTER TABLE nodes DROP COLUMN deleted_at;`);
  return snap(db);
}

test('fresh migration creates the current schema and version', t => {
  const db = fresh(t);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
  for (const table of tables) assert.ok(db.prepare(`PRAGMA table_info(${table})`).all().length);
  assert.equal(migrate(db), false);
});

test('current unversioned database retains rows, metadata, history and custom ordering', t => {
  const db = fresh(t); seed(db); db.exec('PRAGMA user_version=0');
  const before = snap(db);
  assert.equal(migrate(db), true);
  assert.deepEqual(snap(db), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outline_history').get().n, 1);
  assert.equal(migrate(db), false);
  assert.deepEqual(snap(db), before);
});

test('legacy schema with no workspace positions migrates deterministically', t => {
  const db = fresh(t); seed(db); const before = legacy(db);
  assert.equal(migrate(db), true);
  const after = snap(db);
  assert.equal(after.workspaces.find(w => w.id==='a').position, 0);
  assert.equal(after.workspaces.find(w => w.id==='b').position, 1);
  assert.equal(after.nodes.find(n=>n.id==='note').body, '原始笔记');
  assert.deepEqual(upgradeSnapshot(before, db), after);
  assert.deepEqual(after.node_tags, before.node_tags);
});

test('later legacy schema adds due_date without reordering existing workspaces', t => {
  const db = fresh(t); seed(db); const before = legacy(db, false);
  migrate(db);
  assert.deepEqual(upgradeSnapshot(before, db), snap(db));
  assert.equal(db.prepare("SELECT position FROM workspaces WHERE id='b'").get().position, 8);
});

test('migration rollback retains the old schema and rows after an injected SQLite failure', t => {
  const db = fresh(t); seed(db); const before = legacy(db), beforeSchema=schema(db);
  const adapter = {
    prepare: text => db.prepare(text),
    exec: text => {
      if (text.startsWith('PRAGMA user_version = ')) throw new Error('injected version-write failure');
      return db.exec(text);
    }
  };
  assert.throws(()=>migrate(adapter), /injected/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 0);
  assert.deepEqual(schema(db), beforeSchema);
  assert.deepEqual(snap(db), before);
});

test('a future database version is rejected without downgrading or writing', t => {
  const db=fresh(t); seed(db); db.exec('PRAGMA user_version=99');
  const before=snap(db);
  assert.throws(()=>migrate(db), /newer/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,99);
  assert.deepEqual(snap(db),before);
});

test('foreign-key violations abort and roll back an upgrade', t => {
  const db=fresh(t); seed(db);
  db.exec("PRAGMA foreign_keys=OFF; UPDATE nodes SET parent_id='missing' WHERE id='note'; PRAGMA user_version=0; PRAGMA foreign_keys=ON;");
  const before=snap(db);
  assert.throws(()=>migrate(db),/inconsistent references/);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,0);
  assert.deepEqual(snap(db),before);
});

test('baseline migration preserves unsynced edits, conflict data and historical snapshots', t => {
  const db=fresh(t); seed(db); const base=legacy(db);
  db.exec("UPDATE nodes SET title='Unsynced edit' WHERE id='note'");
  const originalBytes=new Uint8Array([1,2,3]);
  const old={bytes:originalBytes,base,revision:'remote-rev',conflict:{current:structuredClone(base),conflicts:['keep both']},backups:[{date:'original-date',data:structuredClone(base)}]};
  const oldCopy=structuredClone(old);
  migrate(db);
  const bytes=new Uint8Array([4,5,6]);
  const next=upgradeStoredState(old,db,bytes);
  assert.equal(next.schemaVersion,SCHEMA_VERSION);
  assert.equal(next.bytes,bytes);
  assert.deepEqual(old,oldCopy);
  assert.equal(next.revision,'remote-rev');
  assert.equal(next.base.nodes.find(n=>n.id==='note').title,'Original title');
  assert.equal(snap(db).nodes.find(n=>n.id==='note').title,'Unsynced edit');
  assert.equal(next.backups[0].date,'original-date');
  assert.deepEqual(next.conflict.conflicts,['keep both']);
  assert.deepEqual(next.conflict.current,next.base);
  assert.deepEqual(next.backups[0].data,next.base);
});

test('current stored state is not rewritten and future metadata is rejected', t => {
  const db=fresh(t);
  const state={schemaVersion:SCHEMA_VERSION,bytes:new Uint8Array(),base:snap(db),revision:'r',backups:[]};
  assert.equal(needsStoredUpgrade(state),false);
  assert.equal(upgradeStoredState(state,db,new Uint8Array([9])),state);
  for (const schemaVersion of [99,-1,1.5,'1',NaN]) assert.throws(()=>needsStoredUpgrade({schemaVersion}));
  assert.equal(needsStoredUpgrade({}),true);
});

test('missing required rows or unknown columns fail closed instead of discarding data', t => {
  const db=fresh(t); seed(db);
  const a=snap(db); delete a.nodes;
  assert.throws(()=>upgradeSnapshot(a,db),/missing nodes/);
  const b=snap(db); b.nodes[0].unknown_field='retain me';
  assert.throws(()=>upgradeSnapshot(b,db),/Unrecognized/);
  const c=snap(db); delete c.nodes[0].title;
  assert.throws(()=>upgradeSnapshot(c,db),/Missing nodes.title/);
  const d=snap(db); delete d.nodes[0].id;
  assert.throws(()=>upgradeSnapshot(d,db),/Missing nodes.id/);
});

test('absent legacy folders are initialized; input snapshots are not mutated', t => {
  const db=fresh(t); seed(db); const original=snap(db); delete original.workspace_folders;
  const copy=structuredClone(original);
  const next=upgradeSnapshot(original,db);
  assert.deepEqual(next.workspace_folders,[]);
  assert.deepEqual(original,copy);
});

test('no-op migrations do not execute schema DDL or normalize positions repeatedly', t => {
  const db=fresh(t); seed(db); let execCount=0;
  assert.equal(migrate({prepare:s=>db.prepare(s),exec:s=>{execCount++;db.exec(s);}}),false);
  assert.equal(execCount,0);
});
