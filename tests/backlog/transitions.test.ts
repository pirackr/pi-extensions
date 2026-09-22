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
it('completes result, stage, receipt and release atomically with no terminal reopen',()=>{
 const f=setup();f.service.execute(f.context,'authorization.approve',{itemId:'B-1',expectedRevision:1,rationale:'Reviewed'});f.db.exec("UPDATE items SET stage='ready' WHERE id='B-1'");
 const claim=f.service.execute(f.context,'claim.acquire',{itemId:'B-1',expectedRevision:2,worker:'w'});const proof={leaseId:claim.leaseId,generation:claim.generation,token:claim.token};
 f.service.execute(f.context,'item.transition',{itemId:'B-1',expectedRevision:3,stage:'implementing',proof});f.service.execute(f.context,'item.transition',{itemId:'B-1',expectedRevision:4,stage:'verifying',proof});
 const input={itemId:'B-1',expectedRevision:5,stage:'done',proof,mutationId:'finish',completion:{summary:'Finished',verification:'Tests passed',evidence:[{label:'Log',reference:'log.txt'}]}};
 expect(()=>f.service.execute(f.context,'item.transition',{...input,completion:{...input.completion,evidence:[]}})).toThrow();
 const events=f.db.prepare('SELECT * FROM events').all();
 f.db.exec("CREATE TRIGGER fail_result BEFORE INSERT ON annotations BEGIN SELECT RAISE(ABORT,'disk failure'); END");expect(()=>f.service.execute(f.context,'item.transition',input)).toThrow();
 expect(f.db.prepare('SELECT * FROM events').all()).toEqual(events);expect(f.db.prepare('SELECT * FROM claims').all()).toHaveLength(1);expect(f.service.execute(f.context,'item.show',{itemId:'B-1'}).stage).toBe('verifying');f.db.exec('DROP TRIGGER fail_result');
 expect(f.service.execute(f.context,'item.transition',input)).toMatchObject({stage:'done',revision:6});expect(f.db.prepare('SELECT * FROM claims').all()).toHaveLength(0);expect(f.db.prepare('SELECT * FROM annotations').all()).toHaveLength(1);
 expect(f.service.execute(f.context,'item.transition',input)).toMatchObject({stage:'done',revision:6});expect(()=>f.service.execute(f.context,'item.transition',{itemId:'B-1',expectedRevision:6,stage:'ready'})).toThrow();
});
it('requires separate request acceptance and terminal children',()=>{
 const f=setup();f.service.execute(f.context,'item.add',{kind:'request',title:'Parent',description:'Scope',criteria:['Done']});f.service.execute(f.context,'item.update',{itemId:'B-1',expectedRevision:1,parent:{projectId:f.projectRecord.id,itemId:'B-2'}});
 f.service.execute(f.context,'authorization.approve',{itemId:'B-2',expectedRevision:1,rationale:'Reviewed'});f.db.exec("UPDATE items SET stage='delivering' WHERE id='B-2'");
 const input={itemId:'B-2',expectedRevision:2,stage:'done',completion:{summary:'Accepted',verification:'Reviewed scope',evidence:[{label:'Decision',reference:'decision.md'}]}};
 expect(()=>f.service.execute(f.context,'item.transition',input)).toThrow();f.db.exec("UPDATE items SET stage='canceled' WHERE id='B-1'");expect(f.service.execute(f.context,'item.show',{itemId:'B-2'}).stage).toBe('delivering');expect(f.service.execute(f.context,'item.transition',input).stage).toBe('done');
});
it('prevents incomplete ready scope and request cancellation with unfinished children',()=>{
 const f=setup();f.service.execute(f.context,'item.add',{kind:'task',title:'Incomplete'});expect(()=>f.service.execute(f.context,'item.transition',{itemId:'B-2',expectedRevision:1,stage:'ready'})).toThrow();
 f.service.execute(f.context,'item.add',{kind:'request',title:'Parent'});f.service.execute(f.context,'item.update',{itemId:'B-2',expectedRevision:1,parent:{projectId:f.projectRecord.id,itemId:'B-3'}});
 expect(()=>f.service.execute(f.context,'item.transition',{itemId:'B-3',expectedRevision:1,stage:'canceled',reason:'Stop'})).toThrow();
 f.service.execute(f.context,'item.transition',{itemId:'B-2',expectedRevision:2,stage:'canceled',reason:'Stop'});
 expect(f.service.execute(f.context,'item.transition',{itemId:'B-3',expectedRevision:1,stage:'canceled',reason:'Stop'}).stage).toBe('canceled');
});
