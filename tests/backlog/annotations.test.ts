import { afterEach, expect, it } from 'vitest';
import { serviceFixture } from './helpers.ts';
const fixtures:ReturnType<typeof serviceFixture>[]=[];afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
function setup(){const f=serviceFixture();fixtures.push(f);f.service.execute(f.context,'item.add',{kind:'task',title:'Test'});return f;}
it('appends notes/artifacts without changing scope or executing references',()=>{
 const f=setup();expect(f.service.execute(f.context,'note.append',{itemId:'B-1',expectedRevision:1,text:'Note'})).toMatchObject({revision:2,scopeRevision:1});
 const ref='$(touch should-not-exist)';expect(f.service.execute(f.context,'artifact.attach',{itemId:'B-1',expectedRevision:2,artifacts:[{label:'Evidence',reference:ref}]})).toMatchObject({revision:3,scopeRevision:1});
 expect(f.db.prepare('SELECT * FROM annotations ORDER BY id').all()).toHaveLength(2);
 expect(String(f.db.prepare("SELECT body FROM annotations WHERE kind='artifact'").get()!.body)).toContain(ref);
 expect(()=>f.service.execute(f.context,'note.append',{itemId:'B-1',expectedRevision:1,text:'Stale'})).toThrow();
});
it('records results separately from completion and restricts terminal progress',()=>{
 const f=setup();const result={summary:'Done part',verification:'Checked manually',evidence:[{label:'Log',reference:'log.txt'}]};
 expect(f.service.execute(f.context,'result.append',{itemId:'B-1',expectedRevision:1,result})).toMatchObject({stage:'draft',revision:2});
 f.db.exec("UPDATE items SET stage='done' WHERE id='B-1'");
 expect(()=>f.service.execute(f.context,'result.append',{itemId:'B-1',expectedRevision:2,result})).toThrow();
 expect(f.service.execute(f.context,'note.append',{itemId:'B-1',expectedRevision:2,text:'Postscript'}).revision).toBe(3);
});
it('validates completion content and ownership before claimed progress',()=>{
 const f=setup();const input={itemId:'B-1',expectedRevision:1,result:{summary:'Ok',verification:'Checked',evidence:[{label:'x',reference:'x'}]}};
 expect(()=>f.service.execute(f.context,'result.append',{...input,result:{...input.result,summary:''}})).toThrow();
 expect(()=>f.service.execute(f.context,'note.append',{itemId:'B-1',expectedRevision:1,text:'x'.repeat(65537)})).toThrow();
 f.db.prepare('INSERT INTO claims VALUES (?,?,?,?,?,?,?,?,?)').run('B-1','lease',1,'secret','worker',f.now()+300000,300,1,null);
 expect(()=>f.service.execute(f.context,'result.append',input)).toThrow();
 expect(f.service.execute(f.context,'result.append',{...input,proof:{leaseId:'lease',generation:1,token:'secret'}}).revision).toBe(2);
});
