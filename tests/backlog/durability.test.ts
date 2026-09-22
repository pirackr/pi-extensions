import { afterEach, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { fixture, snapshotManifest, validateSnapshot } from './helpers.ts';
import { createBacklogService } from '../../modules/backlog/service.ts';
import { openStore } from '../../modules/backlog/store.ts';
const cleanups:(()=>void)[]=[];afterEach(()=>cleanups.splice(0).reverse().forEach(fn=>fn()));
function setup(){const f=fixture();cleanups.push(f.close);const service=createBacklogService(f);const project=service.execute(f.context,'project.register',{directory:f.project,name:'Test'});service.close();return {...f,projectRecord:project};}
async function worker(f:ReturnType<typeof setup>,extra:Record<string,unknown>){const c=fork(resolve('tests/backlog/process-worker.mjs'),[],{stdio:['pipe','pipe','pipe','ipc']});cleanups.push(()=>c.kill('SIGKILL'));c.send({dataRoot:f.dataRoot,context:f.context,...extra});expect((await once(c,'message'))[0]).toEqual({ready:true});return c;}
async function run(f:ReturnType<typeof setup>,operation:string,input:unknown){const c=await worker(f,{operation,input});const response=once(c,'message');c.send('go');const [result]=await response;await once(c,'exit');return result;}
async function kill(c:ChildProcess){const exited=once(c,'exit');c.kill('SIGKILL');await exited;}
it('rolls back rows/events/receipts when killed before commit, but replays a lost committed response',async()=>{
 const f=setup();const input={kind:'task',title:'Durable',mutationId:'once'};
 for(const pauseCommit of ['before','after']){
  const c=await worker(f,{operation:'item.add',input,pauseCommit});const paused=once(c,'message');c.send('go');expect((await paused)[0]).toEqual({paused:true});await kill(c);
  const reopened=await run(f,'item.list',{});expect(reopened.data.items).toHaveLength(pauseCommit==='before'?0:1);
  const db=openStore(join(f.dataRoot,'projects',f.projectRecord.id,'backlog.sqlite'),'project','open-existing');try{expect(db.prepare('SELECT * FROM events').all()).toHaveLength(pauseCommit==='before'?0:1);expect(db.prepare('SELECT * FROM receipts').all()).toHaveLength(pauseCommit==='before'?0:1);}finally{db.close();}
 }
 const retry=await run(f,'item.add',input);expect(retry).toMatchObject({ok:true,data:{id:'B-1',revision:1}});expect((await run(f,'item.list',{})).data.items).toHaveLength(1);
});
it('validates whole-root WAL snapshots and reconciles restored claims before new ownership',async()=>{
 const f=setup();const service=createBacklogService(f);mkdirSync(join(f.directory,'second'));const second=service.execute(f.context,'project.register',{directory:join(f.directory,'second'),name:'Second'});
 service.execute(f.context,'item.add',{kind:'task',title:'Work',description:'Scope',criteria:['Done']});service.execute(f.context,'authorization.approve',{itemId:'B-1',expectedRevision:1,rationale:'Reviewed'});service.execute(f.context,'item.transition',{itemId:'B-1',expectedRevision:2,stage:'ready'});const claimInput={itemId:'B-1',expectedRevision:3,worker:'worker',mutationId:'claim'};const claim=service.execute(f.context,'claim.acquire',claimInput);service.close();
 const child=await worker(f,{operation:'item.add',input:{kind:'task',title:'WAL-only',mutationId:'wal'},pauseCommit:'after'});const paused=once(child,'message');child.send('go');await paused;await kill(child);
 const manifest=snapshotManifest(f.dataRoot);expect(Object.keys(manifest).some(p=>p.endsWith('-wal'))).toBe(true);
 const backup=join(f.directory,'backup');cpSync(f.dataRoot,backup,{recursive:true});validateSnapshot(backup,manifest);
 const broken=join(f.directory,'broken');cpSync(f.dataRoot,broken,{recursive:true});const wal=Object.keys(manifest).find(p=>p.endsWith('-wal'))!;rmSync(join(broken,wal));expect(()=>validateSnapshot(broken,manifest)).toThrow();
 cpSync(f.dataRoot,broken,{recursive:true});rmSync(join(broken,'projects',second.id,'backlog.sqlite'));expect(()=>validateSnapshot(broken,manifest)).toThrow();
 const restored=join(f.directory,'restored');cpSync(f.dataRoot,restored,{recursive:true});validateSnapshot(restored,manifest);f.advance(3600000);const reopened=createBacklogService({...f,dataRoot:restored});try{
  expect(reopened.execute(f.context,'project.list',{}).items).toHaveLength(2);expect(reopened.execute(f.context,'item.list',{}).items).toHaveLength(2);
  expect(reopened.execute(f.context,'claim.acquire',claimInput).token).toBe(claim.token);const proof={leaseId:claim.leaseId,generation:claim.generation,token:claim.token};expect(()=>reopened.execute(f.context,'claim.renew',{itemId:'B-1',proof})).toThrow();
  expect(()=>reopened.execute(f.context,'claim.acquire',{itemId:'B-1',expectedRevision:4,worker:'new'})).toThrow();
  reopened.execute(f.context,'claim.recover',{itemId:'B-1',expectedRevision:4,leaseId:claim.leaseId,generation:claim.generation,reason:'Clients stopped and external effects reconciled'});const fresh=reopened.execute(f.context,'claim.acquire',{itemId:'B-1',expectedRevision:5,worker:'new'});expect(fresh.generation).toBe(2);expect(()=>reopened.execute(f.context,'claim.renew',{itemId:'B-1',proof})).toThrow();
 }finally{reopened.close();}
});
it.each(['registry','project'] as const)('rejects corrupt and newer %s stores without replacing bytes',kind=>{
 const f=setup();const path=kind==='registry'?join(f.dataRoot,'registry.sqlite'):join(f.dataRoot,'projects',f.projectRecord.id,'backlog.sqlite');
 const db=openStore(path,kind,'open-existing');db.exec('PRAGMA user_version=2');db.close();let before=readFileSync(path);expect(()=>openStore(path,kind,'open-existing')).toThrowError(expect.objectContaining({code:'SCHEMA_UNSUPPORTED'}));expect(readFileSync(path)).toEqual(before);
 writeFileSync(path,'corrupt SQLite');before=readFileSync(path);expect(()=>openStore(path,kind,'open-existing')).toThrowError(expect.objectContaining({code:'STORE_CORRUPT'}));expect(readFileSync(path)).toEqual(before);
});
