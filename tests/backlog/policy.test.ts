import { afterEach, expect, it } from 'vitest';
import { resolvePolicy } from '../../modules/backlog/policy.ts';
import { getItem } from '../../modules/backlog/items.ts';
import { serviceFixture } from './helpers.ts';
const fs:ReturnType<typeof serviceFixture>[]=[];afterEach(()=>fs.splice(0).forEach(f=>f.close()));
function setup(){const f=serviceFixture();fs.push(f);for(const kind of ['request','task','task'] as const)f.service.execute(f.context,'item.add',{kind,title:kind});f.service.execute(f.context,'item.update',{itemId:'B-2',expectedRevision:1,parent:{projectId:f.projectRecord.id,itemId:'B-1'}});return f;}
it('resolves inherited policy and dedicated operator overrides with versions',()=>{
 const f=setup();expect(resolvePolicy(f.db,getItem(f.db,'B-2'))).toMatchObject({policy:'approval_required',source:'project',version:'project:1'});
 const changed=f.service.execute(f.context,'project.policy',{itemId:'B-1',expectedRevision:1,expectedPolicyVersion:1,policy:'autonomous'});
 expect(changed.item).toMatchObject({revision:2,scopeRevision:2});expect(resolvePolicy(f.db,getItem(f.db,'B-2'))).toMatchObject({policy:'autonomous',source:'B-1'});
 expect(()=>f.service.execute(f.context,'project.policy',{itemId:'B-2',expectedRevision:2,expectedPolicyVersion:1,policy:'autonomous'})).toThrow();
 expect(()=>f.service.execute({...f.context,actor:{...f.context.actor,role:'automation'}},'project.policy',{expectedPolicyVersion:1,policy:'autonomous'})).toThrow();
 expect(f.service.execute(f.context,'project.policy',{expectedPolicyVersion:1,policy:'approval_required'}).policyVersion).toBe(1);
});
it('claim freezes include expired claims and terminal overrides remain immutable',()=>{
 const f=setup();f.db.exec("INSERT INTO claims VALUES ('B-2','lease',1,'token','worker',0,300,2,1)");
 expect(()=>f.service.execute(f.context,'project.policy',{expectedPolicyVersion:1,policy:'autonomous'})).toThrow();
 expect(()=>f.service.execute(f.context,'project.policy',{itemId:'B-1',expectedRevision:1,expectedPolicyVersion:1,policy:'autonomous'})).toThrow();
 f.db.exec("UPDATE items SET stage='done' WHERE id='B-3'");expect(()=>f.service.execute(f.context,'project.policy',{itemId:'B-3',expectedRevision:1,expectedPolicyVersion:1,policy:'autonomous'})).toThrow();
});
