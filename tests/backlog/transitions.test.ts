import { afterEach, expect, it } from 'vitest';
import { serviceFixture } from './helpers.ts';
const fs:ReturnType<typeof serviceFixture>[]=[];afterEach(()=>fs.splice(0).forEach(f=>f.close()));
function setup(){const f=serviceFixture();fs.push(f);f.service.execute(f.context,'item.add',{kind:'task',title:'Task',description:'Scope',criteria:['Done']});return f;}
it('guards edges, readiness, activation, reasons, and ownership on every claimed transition',()=>{
 const f=setup();const change=(stage:string,revision:number,extra={})=>f.service.execute(f.context,'item.transition',{itemId:'B-1',expectedRevision:revision,stage,...extra});
 expect(()=>change('implementing',1)).toThrow();expect(change('ready',1)).toMatchObject({stage:'ready',revision:2});expect(()=>change('implementing',2)).toThrow();
 f.service.execute(f.context,'authorization.approve',{itemId:'B-1',expectedRevision:2,rationale:'Reviewed'});const claim=f.service.execute(f.context,'claim.acquire',{itemId:'B-1',expectedRevision:3,worker:'w'});const proof={leaseId:claim.leaseId,generation:claim.generation,token:claim.token};
 expect(()=>change('draft',4)).toThrow();expect(change('implementing',4,{proof}).revision).toBe(5);
 expect(()=>change('blocked',5,{proof})).toThrow();expect(change('blocked',5,{proof,reason:'Wait'}).stage).toBe('blocked');expect(f.db.prepare('SELECT * FROM claims').all()).toHaveLength(0);
});
it('prevents incomplete ready scope and request cancellation with unfinished children',()=>{
 const f=setup();f.service.execute(f.context,'item.add',{kind:'task',title:'Incomplete'});expect(()=>f.service.execute(f.context,'item.transition',{itemId:'B-2',expectedRevision:1,stage:'ready'})).toThrow();
 f.service.execute(f.context,'item.add',{kind:'request',title:'Parent'});f.service.execute(f.context,'item.update',{itemId:'B-2',expectedRevision:1,parent:{projectId:f.projectRecord.id,itemId:'B-3'}});
 expect(()=>f.service.execute(f.context,'item.transition',{itemId:'B-3',expectedRevision:1,stage:'canceled',reason:'Stop'})).toThrow();
 f.service.execute(f.context,'item.transition',{itemId:'B-2',expectedRevision:2,stage:'canceled',reason:'Stop'});
 expect(f.service.execute(f.context,'item.transition',{itemId:'B-3',expectedRevision:1,stage:'canceled',reason:'Stop'}).stage).toBe('canceled');
});
