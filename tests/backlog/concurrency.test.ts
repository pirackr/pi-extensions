import { afterEach, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { serviceFixture } from './helpers.ts';
const fixtures:ReturnType<typeof serviceFixture>[]=[];const children:ChildProcess[]=[];afterEach(()=>{children.splice(0).forEach(c=>c.kill('SIGKILL'));fixtures.splice(0).forEach(f=>f.close());});
function setup(){const f=serviceFixture();fixtures.push(f);return f;}
export async function startWorker(spec:Record<string,unknown>){const child=fork(resolve('tests/backlog/process-worker.mjs'),[],{stdio:['pipe','pipe','pipe','ipc']});children.push(child);child.send(spec);const [ready]=await once(child,'message');expect(ready).toEqual({ready:true});return child;}
async function race(f:ReturnType<typeof setup>,operation:string,input:unknown,second=input,publicationBarrier=false){const specs=[input,second].map(value=>({dataRoot:f.dataRoot,context:f.context,now:f.now(),operation,input:value,publicationBarrier}));const pair=await Promise.all(specs.map(startWorker));const results=pair.map(c=>once(c,'message'));for(const c of pair)publicationBarrier?c.stdin!.write('\n'):c.send('go');return (await Promise.all(results)).map(([r])=>r);}
it('serializes registration publication in separate processes',async()=>{
 const f=setup(),directory=join(f.directory,'other');mkdirSync(directory);const results=await race(f,'project.register',{directory,name:'Other'},undefined,true);expect(results.every(r=>r.ok)).toBe(true);expect(results[0].data.id).toBe(results[1].data.id);expect(f.service.execute(f.context,'project.list',{}).items).toHaveLength(2);
});
it('serializes same-revision edits and same-mutation retries to one event',async()=>{
 const f=setup();f.service.execute(f.context,'item.add',{kind:'task',title:'Task'});const edits=await race(f,'item.update',{itemId:'B-1',expectedRevision:1,title:'First'},{itemId:'B-1',expectedRevision:1,title:'Second'});expect(edits.filter(r=>r.ok)).toHaveLength(1);expect(edits.find(r=>!r.ok).code).toBe('REVISION_CONFLICT');
 const before=f.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n;const retries=await race(f,'note.append',{itemId:'B-1',expectedRevision:2,text:'One',mutationId:'same'});expect(retries[0]).toEqual(retries[1]);expect(retries[0].ok).toBe(true);expect(f.db.prepare('SELECT COUNT(*) AS n FROM events').get()!.n).toBe(Number(before)+1);
});
it('gives one process the claim and orders revocation against renewal',async()=>{
 const f=setup();f.service.execute(f.context,'item.add',{kind:'task',title:'Task',description:'Scope',criteria:['Done']});f.service.execute(f.context,'authorization.approve',{itemId:'B-1',expectedRevision:1,rationale:'Reviewed'});f.service.execute(f.context,'item.transition',{itemId:'B-1',expectedRevision:2,stage:'ready'});
 const claims=await race(f,'claim.acquire',{itemId:'B-1',expectedRevision:3,worker:'w'});expect(claims.filter(r=>r.ok)).toHaveLength(1);const claim=claims.find(r=>r.ok).data;
 const specs=[{operation:'claim.renew',input:{itemId:'B-1',proof:{leaseId:claim.leaseId,generation:claim.generation,token:claim.token}}},{operation:'authorization.revoke',input:{itemId:'B-1',expectedRevision:4,rationale:'Stop'}}];
 const pair=await Promise.all(specs.map(s=>startWorker({...s,dataRoot:f.dataRoot,context:f.context,now:f.now()})));const waits=pair.map(c=>once(c,'message'));pair.forEach(c=>c.send('go'));const results=(await Promise.all(waits)).map(([r])=>r);expect(results[1].ok).toBe(true);expect(results[0].ok||results[0].code==='AUTHORIZATION_REQUIRED').toBe(true);
 expect(()=>f.service.execute(f.context,'claim.renew',specs[0].input as never)).toThrow();
});
it('reports a bounded STORE_BUSY when another process holds the writer lock',async()=>{
 const f=setup();const holder=await startWorker({mode:'hold',path:join(f.dataRoot,'projects',f.projectRecord.id,'backlog.sqlite')});const start=Date.now();expect(()=>f.service.execute(f.context,'item.add',{kind:'task',title:'Busy'})).toThrowError(expect.objectContaining({code:'STORE_BUSY'}));expect(Date.now()-start).toBeLessThan(4000);holder.send('release');await once(holder,'exit');
});
