import { afterEach, expect, it } from 'vitest';
import { currentAuthorization } from '../../modules/backlog/authorization.ts';
import { getItem } from '../../modules/backlog/items.ts';
import { serviceFixture } from './helpers.ts';
const fs:ReturnType<typeof serviceFixture>[]=[];afterEach(()=>fs.splice(0).forEach(f=>f.close()));
function setup(){const f=serviceFixture();fs.push(f);f.service.execute(f.context,'item.add',{kind:'request',title:'Request',description:'Scope',criteria:['Done']});f.service.execute(f.context,'item.add',{kind:'task',title:'Child',description:'Scope',criteria:['Done']});f.service.execute(f.context,'item.update',{itemId:'B-2',expectedRevision:1,parent:{projectId:f.projectRecord.id,itemId:'B-1'}});return f;}
it('requires explicit authority and preserves immutable authorization history',()=>{
 const f=setup();expect(currentAuthorization(f.db,getItem(f.db,'B-2'))).toBeUndefined();
 const approved=f.service.execute(f.context,'authorization.approve',{itemId:'B-1',expectedRevision:1,rationale:'Reviewed'});expect(approved).toMatchObject({revision:2,scopeRevision:1});
 expect(currentAuthorization(f.db,getItem(f.db,'B-2'))).toBeDefined();const history=f.db.prepare('SELECT * FROM authorizations').all();
 f.service.execute(f.context,'item.update',{itemId:'B-2',expectedRevision:2,title:'Edited child'});expect(currentAuthorization(f.db,getItem(f.db,'B-2'))).toBeDefined();
 f.db.exec("INSERT INTO claims VALUES ('B-2','lease',1,'token','worker',9999999999999,300,3,1)");
 f.service.execute(f.context,'authorization.revoke',{itemId:'B-1',expectedRevision:2,rationale:'Stop'});
 expect(currentAuthorization(f.db,getItem(f.db,'B-2'))).toBeUndefined();expect(f.db.prepare('SELECT * FROM authorizations').all()).toEqual(history);
});
it('rejects child approval, automation approval, and authorization outside autonomous policy',()=>{
 const f=setup();const automation={...f.context,actor:{...f.context.actor,role:'automation' as const}};
 expect(()=>f.service.execute(f.context,'authorization.approve',{itemId:'B-2',expectedRevision:2,rationale:'No'})).toThrow();
 expect(()=>f.service.execute(automation,'authorization.approve',{itemId:'B-1',expectedRevision:1,rationale:'No'})).toThrow();
 expect(()=>f.service.execute(automation,'authorization.authorize',{itemId:'B-1',expectedRevision:1,rationale:'No'})).toThrow();
 f.service.execute(f.context,'project.policy',{expectedPolicyVersion:1,policy:'autonomous'});
 expect(()=>f.service.execute(automation,'authorization.authorize',{itemId:'B-1',expectedRevision:1,rationale:''})).toThrow();
 f.service.execute(automation,'authorization.authorize',{itemId:'B-1',expectedRevision:1,rationale:'Safe'});expect(currentAuthorization(f.db,getItem(f.db,'B-1'))).toBeDefined();
 f.service.execute(f.context,'project.policy',{expectedPolicyVersion:2,policy:'approval_required'});expect(currentAuthorization(f.db,getItem(f.db,'B-1'))).toBeUndefined();
});
