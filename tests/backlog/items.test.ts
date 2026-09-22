import { afterEach, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { createBacklogService } from '../../modules/backlog/service.ts';
import { openStore } from '../../modules/backlog/store.ts';
import { fixture } from './helpers.ts';
const cleanup: (()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(fn=>fn()));
function setup(){const f=fixture();cleanup.push(f.close);const service=createBacklogService(f);cleanup.push(()=>service.close());const p=service.execute(f.context,'project.register',{name:'Test',directory:'.'});return {...f,service,p};}
it('captures title-only drafts and allocates independent project counters',()=>{
 const f=setup();const a=f.service.execute(f.context,'item.add',{kind:'task',title:'First'});
 expect(a).toMatchObject({id:'B-1',stage:'draft',priority:'normal',revision:1,scopeRevision:1});
 expect(f.service.execute(f.context,'item.add',{kind:'request',title:'Request'})).toMatchObject({id:'B-2',stage:'inbox'});
 const dir=f.directory+'/other';mkdirSync(dir);const other=f.service.execute(f.context,'project.register',{directory:dir,name:'Other'});
 expect(f.service.execute({...f.context,projectId:other.id},'item.add',{kind:'task',title:'First'}).id).toBe('B-1');
});
it('scope and priority edits have separate revision effects and stale writes leave state intact',()=>{
 const f=setup();f.service.execute(f.context,'item.add',{kind:'task',title:'First'});
 const a=f.service.execute(f.context,'item.update',{itemId:'B-1',expectedRevision:1,description:'Scope',criteria:['Done']});expect(a).toMatchObject({revision:2,scopeRevision:2});
 expect(f.service.execute(f.context,'item.update',{itemId:'B-1',expectedRevision:2,priority:'high'})).toMatchObject({revision:3,scopeRevision:2});
 expect(()=>f.service.execute(f.context,'item.update',{itemId:'B-1',expectedRevision:2,title:'Stale'})).toThrow();
 expect(f.service.execute(f.context,'item.show',{itemId:'B-1'}).title).toBe('First');
 for(const field of ['kind','workflowVersion','revision','scopeRevision','stage','authorization','token'])expect(()=>f.service.execute(f.context,'item.update',{itemId:'B-1',expectedRevision:3,[field]:'bad'} as never)).toThrow();
});
it('rejects terminal scope and recorded-claim scope edits but allows terminal priority',()=>{
 const f=setup();f.service.execute(f.context,'item.add',{kind:'task',title:'First'});
 const db=openStore(f.dataRoot+'/projects/'+f.p.id+'/backlog.sqlite','project','open-existing');
 try{
  db.exec("UPDATE items SET stage='done' WHERE id='B-1'");
  expect(()=>f.service.execute(f.context,'item.update',{itemId:'B-1',expectedRevision:1,title:'No'})).toThrow();
  expect(f.service.execute(f.context,'item.update',{itemId:'B-1',expectedRevision:1,priority:'low'}).revision).toBe(2);
  db.exec("UPDATE items SET stage='ready' WHERE id='B-1'");
  expect(()=>f.service.execute(f.context,'item.update',{itemId:'B-1',expectedRevision:2,description:''})).toThrow();
  db.exec("UPDATE items SET stage='draft' WHERE id='B-1'");
  db.exec("INSERT INTO claims VALUES ('B-1','lease',1,'token','worker',0,300,1,NULL)");
  expect(()=>f.service.execute(f.context,'item.update',{itemId:'B-1',expectedRevision:2,title:'No'})).toThrow();
 }finally{db.close();}
});
