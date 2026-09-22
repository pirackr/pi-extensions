import { afterEach, expect, it } from 'vitest';
import { serviceFixture } from './helpers.ts';
const fixtures:ReturnType<typeof serviceFixture>[]=[];afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
function setup(){const f=serviceFixture();fixtures.push(f);for(const kind of ['request','task','task','task'] as const)f.service.execute(f.context,'item.add',{kind,title:kind});return {...f,ref:(itemId:string)=>({projectId:f.projectRecord.id,itemId})};}
it('attaches only draft tasks to same-project nonterminal requests without revising the request',()=>{
 const f=setup();const child=f.service.execute(f.context,'item.update',{itemId:'B-2',expectedRevision:1,parent:f.ref('B-1')});
 expect(child).toMatchObject({parentId:'B-1',revision:2,scopeRevision:2});expect(f.service.execute(f.context,'item.show',{itemId:'B-1'}).scopeRevision).toBe(1);
 expect(()=>f.service.execute(f.context,'item.update',{itemId:'B-1',expectedRevision:1,parent:f.ref('B-1')})).toThrow();
 expect(()=>f.service.execute(f.context,'item.update',{itemId:'B-3',expectedRevision:1,parent:f.ref('B-2')})).toThrow();
 expect(()=>f.service.execute(f.context,'item.update',{itemId:'B-3',expectedRevision:1,parent:{projectId:'00000000-0000-4000-8000-999999999999',itemId:'B-1'}})).toThrow();
 f.db.exec("UPDATE items SET stage='done' WHERE id='B-1'");expect(()=>f.service.execute(f.context,'item.update',{itemId:'B-3',expectedRevision:1,parent:f.ref('B-1')})).toThrow();
});
it('rejects self dependencies and multi-edge cycles atomically',()=>{
 const f=setup();
 for(const [id,dep] of [['B-2','B-3'],['B-3','B-4']])expect(f.service.execute(f.context,'dependency.add',{itemId:id,prerequisite:f.ref(dep),expectedRevision:1}).scopeRevision).toBe(2);
 expect(()=>f.service.execute(f.context,'dependency.add',{itemId:'B-4',prerequisite:f.ref('B-2'),expectedRevision:1})).toThrow();
 expect(()=>f.service.execute(f.context,'dependency.add',{itemId:'B-4',prerequisite:f.ref('B-4'),expectedRevision:1})).toThrow();
 expect(()=>f.service.execute(f.context,'dependency.add',{itemId:'B-4',prerequisite:f.ref('B-1'),expectedRevision:1})).toThrow();
 expect(f.service.execute(f.context,'dependency.remove',{itemId:'B-2',prerequisite:f.ref('B-3'),expectedRevision:2})).toMatchObject({revision:3,scopeRevision:3});
});
it('rejects reparenting policy overrides and frozen relationships',()=>{
 const f=setup();f.db.exec("UPDATE items SET policy_override='autonomous' WHERE id='B-2'");
 expect(()=>f.service.execute(f.context,'item.update',{itemId:'B-2',expectedRevision:1,parent:f.ref('B-1')})).toThrow();
 f.db.exec("INSERT INTO claims VALUES ('B-3','lease',1,'token','worker',0,300,1,NULL)");
 expect(()=>f.service.execute(f.context,'dependency.add',{itemId:'B-3',prerequisite:f.ref('B-4'),expectedRevision:1})).toThrow();
});
