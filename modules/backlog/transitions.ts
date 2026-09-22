import { BacklogError } from './errors.ts';
import { requireAuthorization } from './authorization.ts';
import { assertOwnership, claimFor } from './claims.ts';
import { advanceItem, category, checkRevision, getItem, projection, scopeComplete, workflow } from './items.ts';
import { dependenciesComplete } from './eligibility.ts';
import { validateCompletion } from './validation.ts';
import { runMutation } from './mutations.ts';
import type { Runtime } from './service.ts';
import type { StoreConnection } from './store.ts';
import type { OperationContext, OperationMap, Project } from './types.ts';
export function transitionItem(rt:Runtime,db:StoreConnection,project:Project,ctx:OperationContext,input:OperationMap['item.transition']['input']) {
 return runMutation(db,ctx,'item.transition',input,()=>{
  const item=getItem(db,input.itemId);checkRevision(item,input.expectedRevision);const graph=workflow(db,item),from=graph.stages.find(s=>s.id===item.stage)!,to=graph.stages.find(s=>s.id===input.stage);
  if(!to||!from.next.includes(to.id))throw new BacklogError('INVALID_TRANSITION','Transition edge is not allowed');
  if(['ready','active'].includes(to.category)&&!scopeComplete(item))throw new BacklogError('VALIDATION_ERROR','Scope is incomplete');
  if(['blocked','canceled'].includes(to.category)&&!input.reason?.trim())throw new BacklogError('VALIDATION_ERROR','Transition reason required');
  if(item.kind==='task'){
   if(claimFor(db,item.id)||['active','done'].includes(to.category))assertOwnership(db,item.id,input.proof,rt.now());
  }else{
   const children=db.prepare('SELECT id FROM items WHERE parent_id=?').all(item.id).map(r=>getItem(db,String(r.id)));
   if(!['ready','active'].includes(to.category)&&children.some(c=>claimFor(db,c.id)))throw new BacklogError('CLAIM_CONFLICT','Release or recover child claims first');
   if(['done','canceled'].includes(to.category)&&children.some(c=>!['done','canceled'].includes(category(db,c))))throw new BacklogError('INVALID_TRANSITION','All children must be terminal');
  }
  if(['active','done'].includes(to.category))requireAuthorization(db,item);
  if(to.category==='done'){
   validateCompletion(input.completion);
   if(item.kind==='task'&&!dependenciesComplete(db,item))throw new BacklogError('INVALID_TRANSITION','Prerequisites must be done');
   db.prepare('INSERT INTO annotations(item_id,kind,body,timestamp,actor) VALUES (?,\'result\',?,?,?)').run(item.id,JSON.stringify(input.completion),new Date(rt.now()).toISOString(),JSON.stringify(ctx.actor));
  }
  db.prepare('UPDATE items SET stage=? WHERE id=?').run(to.id,item.id);
  if(['blocked','done','canceled'].includes(to.category))db.prepare('DELETE FROM claims WHERE item_id=?').run(item.id);
  advanceItem(db,item,ctx,rt.now());
  return {receipt:projection(getItem(db,item.id),project),event:{ids:[item.id],revision:item.revision+1,reason:input.reason??'',changedFields:['stage']}};
 },rt.now);
}
