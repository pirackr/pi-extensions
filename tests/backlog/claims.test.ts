import { afterEach, expect, it } from 'vitest';
import { assertOwnership } from '../../modules/backlog/claims.ts';
import { serviceFixture } from './helpers.ts';
const fixtures:ReturnType<typeof serviceFixture>[]=[];afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
function eligible(){const f=serviceFixture();fixtures.push(f);f.service.execute(f.context,'item.add',{kind:'task',title:'Task',description:'Scope',criteria:['Done']});f.service.execute(f.context,'authorization.approve',{itemId:'B-1',expectedRevision:1,rationale:'Reviewed'});f.db.exec("UPDATE items SET stage='ready' WHERE id='B-1'");return f;}
it('acquires one owner and replays the original private receipt without renewal',()=>{
 const f=eligible();const input={itemId:'B-1',expectedRevision:2,worker:'worker',mutationId:'retry'};
 const receipt=f.service.execute(f.context,'claim.acquire',input);expect(receipt).toMatchObject({generation:1,revision:3,durationSeconds:300,taskScopeRevision:1});expect(receipt.token).toHaveLength(64);
 expect(()=>assertOwnership(f.db,'B-1',receipt,f.now())).not.toThrow();
 expect(()=>f.service.execute(f.context,'claim.acquire',{...input,expectedRevision:3,mutationId:'other'})).toThrow();
 f.advance(100000);expect(f.service.execute(f.context,'claim.acquire',input)).toEqual(receipt);
 expect(JSON.stringify(f.service.execute(f.context,'item.show',{itemId:'B-1'}))).not.toContain(receipt.token);
 expect(JSON.stringify(f.db.prepare('SELECT * FROM events').all())).not.toContain(receipt.token);
});
it.each([0,29,3601,30.5])('rejects duration %s',durationSeconds=>{const f=eligible();expect(()=>f.service.execute(f.context,'claim.acquire',{itemId:'B-1',expectedRevision:2,worker:'w',durationSeconds})).toThrow();});
it('requires the exact parent scope for automation child claims',()=>{
 const f=serviceFixture();fixtures.push(f);for(const kind of ['request','task'] as const)f.service.execute(f.context,'item.add',{kind,title:kind,description:'Scope',criteria:['Done']});
 f.service.execute(f.context,'item.update',{itemId:'B-2',expectedRevision:1,parent:{projectId:f.projectRecord.id,itemId:'B-1'}});f.service.execute(f.context,'authorization.approve',{itemId:'B-1',expectedRevision:1,rationale:'Reviewed'});f.db.exec("UPDATE items SET stage='ready'");
 const ctx={...f.context,actor:{...f.context.actor,role:'automation' as const}};const input={itemId:'B-2',expectedRevision:2,worker:'w'};
 expect(()=>f.service.execute(ctx,'claim.acquire',input)).toThrow();expect(()=>f.service.execute(ctx,'claim.acquire',{...input,expectedParentScopeRevision:2})).toThrow();
 expect(f.service.execute(ctx,'claim.acquire',{...input,expectedParentScopeRevision:1})).toMatchObject({parentScopeRevision:1,taskScopeRevision:2});
});
it('renews from now without item revision changes, rejects revoked renewal but allows owner release',()=>{
 const f=eligible();const proof=f.service.execute(f.context,'claim.acquire',{itemId:'B-1',expectedRevision:2,worker:'w'});const credentials={leaseId:proof.leaseId,generation:proof.generation,token:proof.token};
 f.advance(100000);const renewed=f.service.execute(f.context,'claim.renew',{itemId:'B-1',proof:credentials});
 expect(renewed.expiresAt).toBe(new Date(f.now()+300000).toISOString());expect(renewed).not.toHaveProperty('token');expect(f.service.execute(f.context,'item.show',{itemId:'B-1'}).revision).toBe(3);
 f.service.execute(f.context,'authorization.revoke',{itemId:'B-1',expectedRevision:3,rationale:'Stop'});
 expect(()=>f.service.execute(f.context,'claim.renew',{itemId:'B-1',proof:credentials})).toThrow();
 expect(f.service.execute(f.context,'claim.release',{itemId:'B-1',expectedRevision:4,proof:credentials})).toMatchObject({stage:'ready',revision:5,scopeRevision:1});
 f.service.execute(f.context,'authorization.approve',{itemId:'B-1',expectedRevision:5,rationale:'Again'});
 const next=f.service.execute(f.context,'claim.acquire',{itemId:'B-1',expectedRevision:6,worker:'other'});expect(next.generation).toBe(2);expect(next.token).not.toBe(proof.token);
 f.advance(300000);const nextProof={leaseId:next.leaseId,generation:next.generation,token:next.token};
 expect(()=>f.service.execute(f.context,'claim.renew',{itemId:'B-1',proof:nextProof})).toThrow();expect(()=>f.service.execute(f.context,'claim.release',{itemId:'B-1',expectedRevision:7,proof:nextProof})).toThrow();
});
it('checks every proof component and rejects expiry equality',()=>{
 const f=serviceFixture();fixtures.push(f);f.service.execute(f.context,'item.add',{kind:'task',title:'Test'});
 f.db.prepare('INSERT INTO claims VALUES (?,?,?,?,?,?,?,?,?)').run('B-1','lease',1,'secret','worker',f.now()+300000,300,1,null);
 const proof={leaseId:'lease',generation:1,token:'secret'};
 expect(()=>assertOwnership(f.db,'B-1',proof,f.now())).not.toThrow();
 for(const change of [{leaseId:'other'},{generation:2},{token:'bad'}])expect(()=>assertOwnership(f.db,'B-1',{...proof,...change},f.now())).toThrow();
 expect(()=>assertOwnership(f.db,'B-1',proof,f.now()+300000)).toThrow(/expired/i);
 expect(()=>assertOwnership(f.db,'B-2',proof,f.now())).toThrow();
});
