import { afterEach, expect, it } from 'vitest';
import { serviceFixture } from './helpers.ts';
const fs:ReturnType<typeof serviceFixture>[]=[];afterEach(()=>fs.splice(0).forEach(f=>f.close()));
function setup(){const f=serviceFixture();fs.push(f);return f;}
it('pages stable priority/creation/numeric-ID order and binds cursors to the query',()=>{
 const f=setup();for(let i=0;i<12;i++)f.service.execute(f.context,'item.add',{kind:'task',title:'Item '+i,priority:i===10?'urgent':'normal'});
 const first=f.service.execute(f.context,'item.list',{limit:3});expect(first.items.map(i=>i.id)).toEqual(['B-11','B-1','B-2']);expect(first.nextCursor).toBeTruthy();
 const second=f.service.execute(f.context,'item.list',{limit:3,cursor:first.nextCursor});expect(second.items.map(i=>i.id)).toEqual(['B-3','B-4','B-5']);
 expect(()=>f.service.execute(f.context,'item.list',{limit:3,priority:'high',cursor:first.nextCursor})).toThrow();expect(()=>f.service.execute(f.context,'item.list',{cursor:'garbage'})).toThrow();expect(()=>f.service.execute(f.context,'item.list',{limit:201})).toThrow();
 expect(f.service.execute(f.context,'item.list',{text:'%'}).items).toHaveLength(0);expect(f.service.execute(f.context,'item.list',{priority:'urgent'}).items[0].id).toBe('B-11');
});
it('filters eligibility before limiting and returns separate history/annotation pages without tokens',()=>{
 const f=setup();for(let i=0;i<3;i++)f.service.execute(f.context,'item.add',{kind:'task',title:'Task',description:'Scope',criteria:['Done']});
 f.service.execute(f.context,'authorization.approve',{itemId:'B-3',expectedRevision:1,rationale:'Reviewed'});f.service.execute(f.context,'item.transition',{itemId:'B-3',expectedRevision:2,stage:'ready'});
 expect(f.service.execute(f.context,'item.list',{eligible:true,limit:1}).items.map(i=>i.id)).toEqual(['B-3']);
 const receipt=f.service.execute(f.context,'claim.acquire',{itemId:'B-3',expectedRevision:3,worker:'w'});
 f.service.execute(f.context,'note.append',{itemId:'B-1',expectedRevision:1,text:'One'});f.service.execute(f.context,'note.append',{itemId:'B-1',expectedRevision:2,text:'Two'});
 const notes=f.service.execute(f.context,'note.list',{itemId:'B-1',limit:1});expect(notes.items).toHaveLength(1);expect(f.service.execute(f.context,'note.list',{itemId:'B-1',limit:1,cursor:notes.nextCursor}).items).toHaveLength(1);
 const history=f.service.execute(f.context,'history.list',{itemId:'B-3'});expect(JSON.stringify(history)).not.toContain(receipt.token);expect(history.items.length).toBe(4);
 expect(f.service.execute(f.context,'backlog.summary',{}).project.id).toBe(f.projectRecord.id);
});
it('reconstructs multibyte text with bounded revision-bound chunks and refuses spliced revisions',()=>{
 const f=setup();const description='😀'.repeat(16384);f.service.execute(f.context,'item.add',{kind:'task',title:'Large',description});
 let cursor:string|undefined;let text='';do{const chunk=f.service.execute(f.context,'item.read-text',{itemId:'B-1',field:'description',cursor});expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(8192);text+=chunk.text;cursor=chunk.nextCursor;}while(cursor);expect(text).toBe(description);
 const first=f.service.execute(f.context,'item.read-text',{itemId:'B-1',field:'description'});f.service.execute(f.context,'item.update',{itemId:'B-1',expectedRevision:1,description:'Changed'});
 expect(()=>f.service.execute(f.context,'item.read-text',{itemId:'B-1',field:'description',cursor:first.nextCursor})).toThrowError(expect.objectContaining({code:'REVISION_CONFLICT'}));
 expect(()=>f.service.execute(f.context,'item.read-text',{itemId:'B-1',field:'title',cursor:first.nextCursor})).toThrow();
});
it('keeps annotation previews bounded and supports their complete text',()=>{
 const f=setup();f.service.execute(f.context,'item.add',{kind:'task',title:'Task'});const text='漢'.repeat(21000);f.service.execute(f.context,'note.append',{itemId:'B-1',expectedRevision:1,text});
 const notes=f.service.execute(f.context,'note.list',{itemId:'B-1'});expect(Buffer.byteLength(JSON.stringify(notes))).toBeLessThan(8192);
 const locator=notes.items[0].locator as {recordId:string};let cursor:string|undefined;let recovered='';do{const chunk=f.service.execute(f.context,'item.read-text',{itemId:'B-1',field:'note',recordId:locator.recordId,cursor});recovered+=chunk.text;cursor=chunk.nextCursor;}while(cursor);expect(recovered).toBe(text);
});
it('pages criteria and dependency sections separately',()=>{
 const f=setup();f.service.execute(f.context,'item.add',{kind:'task',title:'Task',criteria:['First','Second','Third']});
 const first=f.service.execute(f.context,'item.show',{itemId:'B-1',section:'criteria',limit:2});expect(first.section!.items).toHaveLength(2);
 const next=f.service.execute(f.context,'item.show',{itemId:'B-1',section:'criteria',limit:2,cursor:first.section!.nextCursor});expect(next.section!.items).toHaveLength(1);
});
