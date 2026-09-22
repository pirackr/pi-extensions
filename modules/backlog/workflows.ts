import { BacklogError } from './errors.ts';
import { strictObject, validate } from './validation.ts';
import type { Category, Kind } from './types.ts';
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
