import { BacklogError } from './errors.ts';
import { advanceItem, category, checkRevision, getItem, projection, scopeComplete, type StoredItem } from './items.ts';
import { runMutation } from './mutations.ts';
import { resolvePolicy } from './policy.ts';
import { requireOperator } from './registry.ts';
import type { Runtime } from './service.ts';
import type { StoreConnection } from './store.ts';
import type { AuthorizationInput, OperationContext, Project } from './types.ts';
export type AuthorizationOperation='authorization.approve'|'authorization.authorize'|'authorization.revoke';
export function currentAuthorization(db:StoreConnection,item:StoredItem):Record<string,unknown>|undefined {
 const policy=resolvePolicy(db,item),governing=getItem(db,policy.governingId);
 const row=db.prepare('SELECT a.* FROM authorizations a JOIN current_authorizations c ON c.authorization_id=a.id WHERE c.item_id=?').get(governing.id);
 return row&&row.scope_revision===governing.scope_revision&&row.policy===policy.policy&&row.policy_version===policy.version?row:undefined;
}
export function requireAuthorization(db:StoreConnection,item:StoredItem):void {
 if(!currentAuthorization(db,item))throw new BacklogError('AUTHORIZATION_REQUIRED','Current scope authorization required');
 if(item.parent_id&&!['ready','active'].includes(category(db,getItem(db,item.parent_id))))throw new BacklogError('AUTHORIZATION_REQUIRED','Parent must be ready or active');
}
export function changeAuthorization(rt:Runtime,db:StoreConnection,project:Project,ctx:OperationContext,operation:AuthorizationOperation,input:AuthorizationInput) {
 if(operation!=='authorization.authorize')requireOperator(ctx);
 return runMutation(db,ctx,operation,input,()=>{
  const item=getItem(db,input.itemId);checkRevision(item,input.expectedRevision);
  if(item.parent_id||['done','canceled'].includes(category(db,item)))throw new BacklogError('VALIDATION_ERROR','Authorize only nonterminal requests or standalone tasks');
  const policy=resolvePolicy(db,item);
  if(operation==='authorization.revoke')db.prepare('DELETE FROM current_authorizations WHERE item_id=?').run(item.id);
  else {
   if(!scopeComplete(item))throw new BacklogError('VALIDATION_ERROR','Scope is incomplete');
   if(operation==='authorization.authorize'&&policy.policy!=='autonomous')throw new BacklogError('AUTHORIZATION_REQUIRED','Autonomous policy required');
   const row=db.prepare('INSERT INTO authorizations(item_id,scope_revision,policy,policy_version,rationale,actor,timestamp) VALUES (?,?,?,?,?,?,?) RETURNING id').get(item.id,item.scope_revision,policy.policy,policy.version,input.rationale,JSON.stringify(ctx.actor),new Date(rt.now()).toISOString())!;
   db.prepare('INSERT OR REPLACE INTO current_authorizations VALUES (?,?)').run(item.id,row.id);
  }
  advanceItem(db,item,ctx,rt.now());
  return {receipt:projection(getItem(db,item.id),project),event:{ids:[item.id],revision:item.revision+1,reason:input.rationale,changedFields:['authorization']}};
 },rt.now);
}
