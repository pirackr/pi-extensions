import { afterEach, expect, it } from 'vitest';
import { evaluateEligibility } from '../../modules/backlog/eligibility.ts';
import { getItem } from '../../modules/backlog/items.ts';
import { serviceFixture } from './helpers.ts';
const fs:ReturnType<typeof serviceFixture>[]=[];afterEach(()=>fs.splice(0).forEach(f=>f.close()));
it('explains each prerequisite without creating authority or ownership',()=>{
 const f=serviceFixture();fs.push(f);
 f.service.execute(f.context,'item.add',{kind:'task',title:'Draft'});
 const inspect=()=>evaluateEligibility(f.db,getItem(f.db,'B-1'),f.now());
 expect(inspect().reasons).toEqual(expect.arrayContaining(['category','scope_incomplete','authorization_required']));
 f.service.execute(f.context,'item.update',{itemId:'B-1',expectedRevision:1,description:'Scope',criteria:['Done']});f.service.execute(f.context,'authorization.approve',{itemId:'B-1',expectedRevision:2,rationale:'Reviewed'});
 f.db.exec("UPDATE items SET stage='ready' WHERE id='B-1'");expect(inspect().eligible).toBe(true);
 f.service.execute(f.context,'item.add',{kind:'task',title:'Prerequisite'});f.db.exec("INSERT INTO dependencies VALUES ('B-1','B-2'); UPDATE items SET stage='canceled' WHERE id='B-2'");expect(inspect().reasons).toContain('dependencies_incomplete');
 f.db.exec("UPDATE items SET stage='done' WHERE id='B-2'");expect(inspect().eligible).toBe(true);
 f.db.prepare('INSERT INTO claims VALUES (?,?,?,?,?,?,?,?,?)').run('B-1','lease',1,'secret','worker',f.now()+300000,300,2,null);
 expect(inspect().reasons).toContain('claim_conflict');f.advance(300000);expect(inspect().reasons).toContain('recovery_required');
 expect(f.db.prepare('SELECT * FROM claims').all()).toHaveLength(1);expect(f.db.prepare('SELECT * FROM authorizations').all()).toHaveLength(1);
});
it('requires a ready/active authorized parent and rejects requests',()=>{
 const f=serviceFixture();fs.push(f);for(const kind of ['request','task'] as const)f.service.execute(f.context,'item.add',{kind,title:kind,description:'Scope',criteria:['Done']});
 f.service.execute(f.context,'item.update',{itemId:'B-2',expectedRevision:1,parent:{projectId:f.projectRecord.id,itemId:'B-1'}});f.db.exec("UPDATE items SET stage='ready' WHERE id='B-2'");
 expect(evaluateEligibility(f.db,getItem(f.db,'B-2'),f.now()).reasons).toEqual(expect.arrayContaining(['parent_category','authorization_required']));
 expect(evaluateEligibility(f.db,getItem(f.db,'B-1'),f.now()).reasons).toContain('not_task');
});
