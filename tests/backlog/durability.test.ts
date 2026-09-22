import { afterEach, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { fixture } from './helpers.ts';
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
it.each(['registry','project'] as const)('rejects corrupt and newer %s stores without replacing bytes',kind=>{
 const f=setup();const path=kind==='registry'?join(f.dataRoot,'registry.sqlite'):join(f.dataRoot,'projects',f.projectRecord.id,'backlog.sqlite');
 const db=openStore(path,kind,'open-existing');db.exec('PRAGMA user_version=2');db.close();let before=readFileSync(path);expect(()=>openStore(path,kind,'open-existing')).toThrowError(expect.objectContaining({code:'SCHEMA_UNSUPPORTED'}));expect(readFileSync(path)).toEqual(before);
 writeFileSync(path,'corrupt SQLite');before=readFileSync(path);expect(()=>openStore(path,kind,'open-existing')).toThrowError(expect.objectContaining({code:'STORE_CORRUPT'}));expect(readFileSync(path)).toEqual(before);
});
