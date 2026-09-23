import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { BacklogError } from './errors.ts';
import { evaluateEligibility } from './eligibility.ts';
import { claimFor } from './claims.ts';
import { category, getItem, projection, type StoredItem } from './items.ts';
import { projectProjection } from './registry.ts';
import type { StoreConnection } from './store.ts';
import type { ItemListInput, ItemShow, ItemSummary, ItemShowInput, Page, PageInput, Project, RecordListInput, TextReadInput, TextChunk } from './types.ts';
export function pageLimit(input:PageInput):number {
 const limit=input.limit??50;if(!Number.isInteger(limit)||limit<1||limit>200)throw new BacklogError('VALIDATION_ERROR','Page size must be 1–200');return limit;
}
function binding(scope:string,input:PageInput):string {
 const clean=Object.fromEntries(Object.entries(input).filter(([k,v])=>k!=='cursor'&&k!=='limit'&&v!==undefined).sort(([a],[b])=>a.localeCompare(b)));
 return createHash('sha256').update(JSON.stringify([scope,clean])).digest('hex');
}
export function cursorFor(scope:string,input:PageInput,key:(string|number)[]):string {return Buffer.from(JSON.stringify({binding:binding(scope,input),key})).toString('base64url');}
export function cursorKey(scope:string,input:PageInput): (string|number)[]|undefined {
 if(input.cursor===undefined)return;
 try{
  if(typeof input.cursor!=='string'||input.cursor.length>4096||!/^[\w-]+$/.test(input.cursor))throw Error();
  const value=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));
  if(value.binding!==binding(scope,input)||!Array.isArray(value.key)||!value.key.length||value.key.some((v:unknown)=>typeof v!=='string'&&(typeof v!=='number'||!Number.isSafeInteger(v))))throw Error();return value.key;
 }catch{throw new BacklogError('VALIDATION_ERROR','Malformed or mismatched continuation cursor');}
}
function page<T>(scope:string,input:PageInput,rows:T[],key:(row:T)=>(string|number)[]):Page<T> {
 const limit=pageLimit(input),more=rows.length>limit,items=rows.slice(0,limit);
 return {items,...(more&&items.length?{nextCursor:cursorFor(scope,input,key(items[items.length-1]))}:{})};
}
export function listProjects(db:StoreConnection,root:string,input:PageInput):Page<Project> {
 const scope='registry:'+root,key=cursorKey(scope,input);if(key&&(key.length!==1||typeof key[0]!=='string'))throw new BacklogError('VALIDATION_ERROR','Invalid project cursor');
 const rows=db.prepare('SELECT * FROM projects WHERE id>? ORDER BY id LIMIT ?').all(key?.[0]??'',pageLimit(input)+1).map(r=>projectProjection(r,root));
 return {...page(scope,input,rows,p=>[p.id]),dataRoot:root};
}
function statusProjection(db:StoreConnection,project:Project,item:StoredItem,now:number):ItemSummary {
 const claim=claimFor(db,item.id);
 return {...projection(item,project),status:evaluateEligibility(db,item,now),...(claim?{claim:{leaseId:claim.lease_id,generation:claim.generation,worker:claim.worker,expiresAt:new Date(claim.expires_at).toISOString(),expired:claim.expires_at<=now,durationSeconds:claim.duration_seconds,taskScopeRevision:claim.task_scope_revision,...(claim.parent_scope_revision!==null?{parentScopeRevision:claim.parent_scope_revision}:{})}}:{})};
}
export function listItems(db:StoreConnection,project:Project,input:ItemListInput,now:number) {
 const scope=project.id+':items',key=cursorKey(scope,input),where:string[]=[],params:(string|number)[]=[];
 const rank="CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END";
 if(key){if(key.length!==3||typeof key[0]!=='number'||typeof key[1]!=='string'||typeof key[2]!=='number')throw new BacklogError('VALIDATION_ERROR','Invalid item cursor');where.push(`(${rank},created_at,number)>(?,?,?)`);params.push(...key);}
 for(const [field,column] of [['kind','kind'],['priority','priority'],['stage','stage'],['parent','parent_id']] as const)if(input[field]!==undefined){where.push(`${column}=?`);params.push(input[field]!);}
 if(input.text!==undefined){where.push('instr(lower(title || char(10) || description),lower(?))>0');params.push(input.text);}
 const rows:StoredItem[]=[];const limit=pageLimit(input);
 for(const raw of db.prepare(`SELECT * FROM items ${where.length?'WHERE '+where.join(' AND '):''} ORDER BY ${rank},created_at,number`).iterate(...params)){
  const row=raw as unknown as StoredItem;
  if(input.category&&category(db,row)!==input.category)continue;
  if(input.eligible!==undefined&&evaluateEligibility(db,row,now).eligible!==input.eligible)continue;
  rows.push(row);if(rows.length>limit)break;
 }
 const result=page(scope,input,rows,r=>[['urgent','high','normal','low'].indexOf(r.priority),r.created_at,r.number]);
 return {...result,items:result.items.map(r=>statusProjection(db,project,r,now)),projectId:project.id,dataRoot:project.dataRoot};
}
export function showItem(db:StoreConnection,project:Project,input:ItemShowInput,now=Date.now()):ItemShow {
 const item=getItem(db,input.itemId),result:ItemShow=statusProjection(db,project,item,now);pageLimit(input);
 if(!input.section){if(input.cursor)throw new BacklogError('VALIDATION_ERROR','Section required with cursor');return result;}
 const scope=project.id+':'+item.id+':'+item.revision+':'+input.section,key=cursorKey(scope,input);if(key&&(key.length!==1||typeof key[0]!=='number'))throw new BacklogError('VALIDATION_ERROR','Invalid section cursor');
 const offset=key?Number(key[0])+1:0;
 const records:Record<string,unknown>[]=input.section==='criteria'?(JSON.parse(item.criteria) as string[]).map((text,index)=>({index,text:[...text].slice(0,1024).join(''),truncated:[...text].length>1024,locator:{itemId:item.id,field:'criterion',recordId:String(index),revision:item.revision}})):db.prepare('SELECT prerequisite_id FROM dependencies WHERE task_id=? ORDER BY prerequisite_id').all(item.id).map((row,index)=>({index,projectId:project.id,itemId:row.prerequisite_id}));
 result.section=page(scope,input,records.slice(offset,offset+pageLimit(input)+1),row=>[Number(row.index)]);return result;
}
export function listRecords(db:StoreConnection,project:Project,operation:string,input:RecordListInput):Page<Record<string,unknown>> {
 const scope=project.id+':'+operation,key=cursorKey(scope,input);if(key&&(key.length!==1||typeof key[0]!=='number'))throw new BacklogError('VALIDATION_ERROR','Invalid record cursor');
 const after=key?.[0]??0,limit=pageLimit(input);if(input.itemId)getItem(db,input.itemId);
 if(operation==='history.list'){
  const rows=db.prepare(`SELECT * FROM events WHERE sequence>? ${input.itemId?"AND EXISTS (SELECT 1 FROM json_each(events.payload,'$.ids') WHERE value=?)":''} ORDER BY sequence LIMIT ?`).all(...(input.itemId?[after,input.itemId,limit+1]:[after,limit+1]));
  const mapped:Record<string,unknown>[]=rows.map(row=>{const payload=JSON.parse(String(row.payload));if(typeof payload.reason==='string')payload.reason=[...payload.reason].slice(0,1024).join('');return {...row,actor:JSON.parse(String(row.actor)),payload};});
  return {...page(scope,input,mapped,r=>[Number(r.sequence)]),projectId:project.id,dataRoot:project.dataRoot};
 }
 const rows=db.prepare(`SELECT * FROM annotations WHERE kind=? AND id>? ${input.itemId?'AND item_id=?':''} ORDER BY id LIMIT ?`).all(...(input.itemId?[operation.split('.')[0],after,input.itemId,limit+1]:[operation.split('.')[0],after,limit+1]));
 const mapped=rows.map(row=>{
  const body=JSON.parse(String(row.body));const item=getItem(db,String(row.item_id));
  const result:Record<string,unknown>={id:Number(row.id),itemId:item.id,kind:row.kind,timestamp:row.timestamp,actor:JSON.parse(String(row.actor)),locator:{itemId:item.id,field:String(row.kind),recordId:String(row.id),revision:item.revision}};
  if(row.kind==='artifact')Object.assign(result,body,{resolvedReference:/^[a-z][a-z0-9+.-]*:/i.test(body.reference)?body.reference:resolve(project.directory,body.reference)});
  else result.preview=[...(typeof body==='string'?body:body.summary)].slice(0,1024).join('');return result;
 });
 return {...page(scope,input,mapped,r=>[Number(r.id)]),projectId:project.id,dataRoot:project.dataRoot};
}
export function readText(db:StoreConnection,project:Project,input:TextReadInput):TextChunk {
 const item=getItem(db,input.itemId),scope=project.id+':text',key=cursorKey(scope,input);
 if(key&&(key.length!==2||typeof key[0]!=='number'||typeof key[1]!=='number'))throw new BacklogError('VALIDATION_ERROR','Invalid text cursor');
 const revision=key?.[1]??input.revision??item.revision;
 if(revision!==item.revision)throw new BacklogError('REVISION_CONFLICT','Text revision changed',{actualRevision:item.revision});
 let text:string;
 if(input.field==='description'||input.field==='title')text=item[input.field];
 else if(input.field==='criterion'){
  if(!input.recordId||!/^(0|[1-9][0-9]*)$/.test(input.recordId))throw new BacklogError('VALIDATION_ERROR','Criterion index required');
  text=JSON.parse(item.criteria)[Number(input.recordId)];
 }else if(['note','artifact','result'].includes(input.field)){
  if(!input.recordId||!/^[1-9][0-9]*$/.test(input.recordId))throw new BacklogError('VALIDATION_ERROR','Annotation record ID required');
  const row=db.prepare('SELECT body FROM annotations WHERE item_id=? AND id=? AND kind=?').get(item.id,input.recordId,input.field);
  if(!row)throw new BacklogError('VALIDATION_ERROR','Unknown annotation');text=input.field==='note'?JSON.parse(String(row.body)):String(row.body);
 }else throw new BacklogError('VALIDATION_ERROR','Unknown text field');
 if(typeof text!=='string')throw new BacklogError('VALIDATION_ERROR','Unknown text record');
 const start=Number(key?.[0]??0);if(start<0||start>text.length||(start>0&&/[\uDC00-\uDFFF]/.test(text[start]??'')&&/[\uD800-\uDBFF]/.test(text[start-1])))throw new BacklogError('VALIDATION_ERROR','Invalid text offset');
 let end=start,bytes=0;for(const char of text.slice(start)){const size=Buffer.byteLength(char);if(bytes+size>8192)break;bytes+=size;end+=char.length;}
 return {projectId:project.id,dataRoot:project.dataRoot,itemId:item.id,field:input.field,...(input.recordId?{recordId:input.recordId}:{}),revision:item.revision,text:text.slice(start,end),...(end<text.length?{nextCursor:cursorFor(scope,input,[end,item.revision])}:{})};
}
export function summary(db:StoreConnection,project:Project) {
 const counts:Record<string,number>={};for(const row of db.prepare('SELECT id FROM items').iterate()){const c=category(db,getItem(db,String(row.id)));counts[c]=(counts[c]??0)+1;}
 return {project,counts};
}
