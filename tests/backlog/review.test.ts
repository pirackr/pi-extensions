import { afterEach, expect, it, vi } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fixture, serviceFixture } from './helpers.ts';
import { createBacklogService } from '../../modules/backlog/service.ts';
import type { StoreConnection } from '../../modules/backlog/store.ts';
const cleanup:(()=>void)[]=[];afterEach(()=>{vi.restoreAllMocks();cleanup.splice(0).reverse().forEach(fn=>fn());});
async function start(f:ReturnType<typeof fixture>,extra:Record<string,unknown>={}){const c=fork(resolve('tests/backlog/process-worker.mjs'),[],{stdio:['pipe','pipe','pipe','ipc']});cleanup.push(()=>c.kill('SIGKILL'));c.send({dataRoot:f.dataRoot,context:f.context,operation:'project.register',input:{directory:f.project,name:'Cold'},...extra});expect((await once(c,'message'))[0]).toEqual({ready:true});return c;}
async function go(c:ChildProcess){const message=once(c,'message');c.send('go');return (await message)[0];}
it('lets another cold registrant publish while the first is initializing, returning one UUID',async()=>{
 const f=fixture();cleanup.push(f.close);const first=await start(f,{pauseCommit:'before'});expect(await go(first)).toEqual({paused:true});const second=await start(f);const winner=await go(second);expect(winner.ok).toBe(true);const result=once(first,'message');first.stdin!.write('\n');expect((await result)[0]).toMatchObject({ok:true,data:{id:winner.data.id}});await once(first,'exit');
});
it('survives death before initial registry publication without stranding the root',async()=>{
 const f=fixture();cleanup.push(f.close);const first=await start(f,{pauseCommit:'before'});expect(await go(first)).toEqual({paused:true});const exited=once(first,'exit');first.kill('SIGKILL');await exited;const next=await start(f);expect(await go(next)).toMatchObject({ok:true});await once(next,'exit');
});
it('shows current token-free policy, eligibility, authorization and recoverable claim metadata',()=>{
 const f=serviceFixture();cleanup.push(f.close);f.service.execute(f.context,'item.add',{kind:'task',title:'Work',description:'Scope',criteria:['Done']});
 expect(f.service.execute(f.context,'item.show',{itemId:'B-1'})).toMatchObject({status:{authorized:false,reasons:expect.arrayContaining(['authorization_required']),policy:{policy:'approval_required'}}});
 expect(f.service.execute(f.context,'project.show',{})).toMatchObject({policy:'approval_required',policyVersion:1});
 f.service.execute(f.context,'authorization.approve',{itemId:'B-1',expectedRevision:1,rationale:'Reviewed'});f.service.execute(f.context,'item.transition',{itemId:'B-1',expectedRevision:2,stage:'ready'});const claim=f.service.execute(f.context,'claim.acquire',{itemId:'B-1',expectedRevision:3,worker:'Lost worker'});f.advance(60000);const renewed=f.service.execute(f.context,'claim.renew',{itemId:'B-1',proof:{leaseId:claim.leaseId,generation:claim.generation,token:claim.token}});
 let shown=f.service.execute(f.context,'item.show',{itemId:'B-1'});expect(shown).toMatchObject({claim:{leaseId:claim.leaseId,generation:claim.generation,worker:'Lost worker',expiresAt:renewed.expiresAt,expired:false}});expect(JSON.stringify(shown)).not.toContain(claim.token);
 f.service.execute(f.context,'authorization.revoke',{itemId:'B-1',expectedRevision:4,rationale:'Stop'});f.advance(3600000);shown=f.service.execute(f.context,'item.show',{itemId:'B-1'});expect(shown).toMatchObject({status:{authorized:false,reasons:expect.arrayContaining(['recovery_required'])},claim:{expired:true}});expect(f.service.execute(f.context,'item.list',{}).items[0]).toMatchObject({claim:{leaseId:claim.leaseId}});
});
it('fails closed before writable setup when a valid project database has the wrong UUID',()=>{
 const f=fixture();cleanup.push(f.close);const service=createBacklogService(f);const a=service.execute(f.context,'project.register',{directory:f.project,name:'A'});mkdirSync(join(f.directory,'other'));const b=service.execute(f.context,'project.register',{directory:join(f.directory,'other'),name:'B'});service.close();const path=join(f.dataRoot,'projects',a.id,'backlog.sqlite');cpSync(join(f.dataRoot,'projects',b.id,'backlog.sqlite'),path);const before=readFileSync(path);const reopened=createBacklogService(f);cleanup.push(()=>reopened.close());expect(()=>reopened.execute(f.context,'item.add',{kind:'task',title:'Wrong database'})).toThrowError(expect.objectContaining({code:'STORE_CORRUPT'}));expect(readFileSync(path)).toEqual(before);
});
it('returns one snapshot when a dependency changes between item and section reads',()=>{
 const f=serviceFixture();cleanup.push(f.close);for(const title of ['One','Two'])f.service.execute(f.context,'item.add',{kind:'task',title});const prerequisite={projectId:f.projectRecord.id,itemId:'B-2'};f.service.execute(f.context,'dependency.add',{itemId:'B-1',expectedRevision:1,prerequisite});const writer=createBacklogService(f);cleanup.push(()=>writer.close());const prototype=Object.getPrototypeOf(f.db),original=prototype.prepare;let onceOnly=false;
 vi.spyOn(prototype,'prepare').mockImplementation(function(this:StoreConnection,sql:unknown){if(sql==='SELECT prerequisite_id FROM dependencies WHERE task_id=? ORDER BY prerequisite_id'&&!onceOnly){onceOnly=true;writer.execute(f.context,'dependency.remove',{itemId:'B-1',expectedRevision:2,prerequisite});}return original.call(this,sql);});
 const shown=f.service.execute(f.context,'item.show',{itemId:'B-1',section:'dependencies'});expect(shown.revision).toBe(2);expect(shown.section!.items).toHaveLength(1);expect(writer.execute(f.context,'item.show',{itemId:'B-1'}).revision).toBe(3);
});
