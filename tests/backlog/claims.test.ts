import { afterEach, expect, it } from 'vitest';
import { assertOwnership } from '../../modules/backlog/claims.ts';
import { serviceFixture } from './helpers.ts';
const fixtures:ReturnType<typeof serviceFixture>[]=[];afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
it('checks every proof component and rejects expiry equality',()=>{
 const f=serviceFixture();fixtures.push(f);f.service.execute(f.context,'item.add',{kind:'task',title:'Test'});
 f.db.prepare('INSERT INTO claims VALUES (?,?,?,?,?,?,?,?,?)').run('B-1','lease',1,'secret','worker',f.now()+300000,300,1,null);
 const proof={leaseId:'lease',generation:1,token:'secret'};
 expect(()=>assertOwnership(f.db,'B-1',proof,f.now())).not.toThrow();
 for(const change of [{leaseId:'other'},{generation:2},{token:'bad'}])expect(()=>assertOwnership(f.db,'B-1',{...proof,...change},f.now())).toThrow();
 expect(()=>assertOwnership(f.db,'B-1',proof,f.now()+300000)).toThrow(/expired/i);
 expect(()=>assertOwnership(f.db,'B-2',proof,f.now())).toThrow();
});
