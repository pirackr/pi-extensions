import { afterEach, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { openStore, withWriteTransaction } from '../../modules/backlog/store.ts';
import { fixture } from './helpers.ts';
const fixtures: ReturnType<typeof fixture>[]=[];
afterEach(() => fixtures.splice(0).forEach(f=>f.close()));
function setup(){const f=fixture();fixtures.push(f);return {...f,path:f.dataRoot+'/registry.sqlite'};}
it('uses required durability pragmas, private modes, and rollback',()=>{
 const f=setup(); const db=openStore(f.path,'registry','create-new');
 try {
  expect(db.prepare('PRAGMA journal_mode').get()).toMatchObject({journal_mode:'wal'});
  expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({foreign_keys:1});
  expect(db.prepare('PRAGMA synchronous').get()).toMatchObject({synchronous:2});
  expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({timeout:1000});
  expect(()=>withWriteTransaction(db,()=>{db.exec("INSERT INTO metadata(key,value) VALUES ('temporary','x')");throw Error('rollback');})).toThrow('rollback');
  expect(db.prepare("SELECT value FROM metadata WHERE key='temporary'").get()).toBeUndefined();
  for(const suffix of ['','-wal','-shm']) if(existsSync(f.path+suffix)) expect(statSync(f.path+suffix).mode & 0o777).toBe(0o600);
 }finally{db.close();}
});
it('never creates a missing registered database',()=>{const f=setup();expect(()=>openStore(f.path,'project','open-existing')).toThrow();expect(existsSync(f.path)).toBe(false);});
it('refuses corrupt, newer, wrong-kind and empty stores without replacing bytes',()=>{
 const f=setup();
 for(const mode of ['corrupt','newer','empty','wrong-kind']) {
  const path=f.directory+'/'+mode+'.sqlite';
  if(mode==='corrupt')writeFileSync(path,'not a database');
  else if(mode==='empty')writeFileSync(path,'');
  else {const db=openStore(path,'registry','create-new');if(mode==='newer')db.exec('PRAGMA user_version=999');db.close();}
  const before=readFileSync(path);
  expect(()=>openStore(path,'project','open-existing')).toThrow();expect(readFileSync(path)).toEqual(before);
 }
});
it('refuses database and sidecar symlinks',()=>{
 const f=setup(); const db=openStore(f.path,'registry','create-new');db.close();
 const outside=f.directory+'/outside';writeFileSync(outside,'untouched');
 symlinkSync(outside,f.path+'-wal');
 expect(()=>openStore(f.path,'registry','open-existing')).toThrow();expect(readFileSync(outside,'utf8')).toBe('untouched');
});
it('enforces foreign keys and exclusive creation',()=>{
 const f=setup();const db=openStore(f.path,'project','create-new');
 try{expect(()=>db.exec("INSERT INTO dependencies(task_id,prerequisite_id) VALUES ('B-1','B-2')")).toThrow();expect(()=>openStore(f.path,'project','create-new')).toThrow();}finally{db.close();}
});
