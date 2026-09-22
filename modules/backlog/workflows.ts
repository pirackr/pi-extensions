import { BacklogError } from './errors.ts';
import { strictObject, validate } from './validation.ts';
import type { Category, Kind, OperationContext, OperationMap, Project, WorkflowRecord } from './types.ts';
import type { StoreConnection } from './store.ts';
import type { Runtime } from './service.ts';
import { runMutation } from './mutations.ts';
import { metadata } from './policy.ts';
import { requireOperator } from './registry.ts';
import { cursorFor, cursorKey, pageLimit } from './queries.ts';
export function showWorkflow(db:StoreConnection,project:Project,input:OperationMap['workflow.show']['input']):WorkflowRecord {
 const version=input.version??Number(metadata(db,input.kind+'Workflow'));
 const row=db.prepare('SELECT definition FROM workflows WHERE kind=? AND version=?').get(input.kind,version);
 if(!row)throw new BacklogError('VALIDATION_ERROR','Unknown workflow version');
 const definition=JSON.parse(String(row.definition)) as WorkflowDefinition,scope=project.id+':workflow:'+input.kind+':'+version,key=cursorKey(scope,input);
 if(key&&(key.length!==1||typeof key[0]!=='number'))throw new BacklogError('VALIDATION_ERROR','Invalid workflow cursor');
 const offset=key?Number(key[0])+1:0,limit=pageLimit(input),stages=definition.stages.slice(offset,offset+limit);
 return {projectId:project.id,dataRoot:project.dataRoot,kind:input.kind,version,definition:{initial:definition.initial,stages},...(offset+limit<definition.stages.length?{nextCursor:cursorFor(scope,input,[offset+limit-1])}:{})};
}
export function publishWorkflow(rt:Runtime,db:StoreConnection,project:Project,ctx:OperationContext,input:OperationMap['workflow.publish']['input']):WorkflowRecord {
 requireOperator(ctx);const definition=validateWorkflow(input.definition);
 return runMutation(db,ctx,'workflow.publish',{...input,definition},()=>{
  const current=Number(metadata(db,input.kind+'Workflow'));if(current!==input.expectedWorkflowVersion)throw new BacklogError('REVISION_CONFLICT','Stale workflow version',{actualVersion:current});
  db.prepare('INSERT INTO workflows VALUES (?,?,?)').run(input.kind,current+1,JSON.stringify(definition));db.prepare('UPDATE metadata SET value=? WHERE key=?').run(String(current+1),input.kind+'Workflow');
  return {receipt:showWorkflow(db,project,{kind:input.kind}),event:{ids:[],kind:input.kind,workflowVersion:current+1,changedFields:['workflow']}};
 },rt.now);
}
export interface Stage { id: string; name: string; category: Category; next: string[] }
export interface WorkflowDefinition { initial: string; stages: Stage[] }
export function defaultWorkflow(kind: Kind): WorkflowDefinition {
 const rows: [string,Category,string[]][] = kind==='request' ? [
 ['inbox','draft',['shaping','canceled']], ['shaping','draft',['inbox','ready','blocked','canceled']], ['ready','ready',['shaping','delivering','blocked','canceled']], ['delivering','active',['shaping','done','blocked','canceled']], ['blocked','blocked',['shaping','canceled']], ['done','done',[]], ['canceled','canceled',[]]
 ] : [
 ['draft','draft',['ready','canceled']], ['ready','ready',['draft','implementing','blocked','canceled']], ['implementing','active',['verifying','blocked','canceled']], ['verifying','active',['implementing','done','blocked','canceled']], ['blocked','blocked',['draft','canceled']], ['done','done',[]], ['canceled','canceled',[]]
 ];
 return {initial:rows[0][0],stages:rows.map(([id,category,next])=>({id,name:id,category,next}))};
}
function invalid(): never {throw new BacklogError('VALIDATION_ERROR','Invalid workflow graph');}
export function validateWorkflow(value: unknown): WorkflowDefinition {
 const input=strictObject(value,['initial','stages']);
 if(!Array.isArray(input.stages) || typeof input.initial!=='string' || input.stages.length>200) invalid();
 const stages: Stage[]=input.stages.map(raw=>{
  const s=strictObject(raw,['id','name','category','next']);
  if(typeof s.id!=='string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(s.id)) invalid();
  validate('label',s.name);
  if(!['draft','ready','active','blocked','done','canceled'].includes(String(s.category))) invalid();
  if(!Array.isArray(s.next) || s.next.some(n=>typeof n!=='string') || new Set(s.next).size!==s.next.length) invalid();
  return {id:s.id,name:s.name as string,category:s.category as Category,next:[...s.next]};
 });
 const map=new Map(stages.map(s=>[s.id,s]));
 if(map.size!==stages.length || map.get(input.initial)?.category!=='draft') invalid();
 for(const c of ['ready','active']) if(!stages.some(s=>s.category===c)) invalid();
 for(const c of ['blocked','done','canceled']) if(stages.filter(s=>s.category===c).length!==1) invalid();
 for(const s of stages) if(s.next.some(id=>!map.has(id)) || (['done','canceled'].includes(s.category) && s.next.length)) invalid();
 const reached=new Set<string>();const seen=new Set<string>();const queue:[string,boolean,boolean][]=[[input.initial,false,false]];
 while(queue.length){const [id,ready,active]=queue.pop()!;const key=`${id}:${ready}:${active}`;if(seen.has(key))continue;seen.add(key);reached.add(id);const s=map.get(id)!;
  const r=ready||s.category==='ready',a=active||(ready&&s.category==='active');
  if(s.category==='done' && (!r||!a)) invalid();
  for(const next of s.next)queue.push([next,r,a]);
 }
 if(reached.size!==stages.length)invalid();
 const terminal=new Set(stages.filter(s=>['done','canceled'].includes(s.category)).map(s=>s.id));
 let changed=true;while(changed){changed=false;for(const s of stages)if(!terminal.has(s.id)&&s.next.some(id=>terminal.has(id))){terminal.add(s.id);changed=true;}}
 if(terminal.size!==stages.length)invalid();
 return {initial:input.initial,stages};
}
