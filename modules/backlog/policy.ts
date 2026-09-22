import { BacklogError } from './errors.ts';
import { advanceItem, category, checkRevision, getItem, projection, scopeMutable, type StoredItem } from './items.ts';
import { runMutation } from './mutations.ts';
import { requireOperator } from './registry.ts';
import type { Runtime } from './service.ts';
import type { StoreConnection } from './store.ts';
import type { EffectivePolicy, OperationContext, OperationMap, Policy, Project } from './types.ts';
export function metadata(db:StoreConnection,key:string):string{return String(db.prepare('SELECT value FROM metadata WHERE key=?').get(key)!.value);}
export function resolvePolicy(db:StoreConnection,item:StoredItem):EffectivePolicy {
 const governing=item.parent_id?getItem(db,item.parent_id):item;
 if(governing.policy_override)return {policy:governing.policy_override as Policy,source:governing.id,version:`${governing.id}:${governing.scope_revision}`,governingId:governing.id};
 return {policy:metadata(db,'policy') as Policy,source:'project',version:'project:'+metadata(db,'policyVersion'),governingId:governing.id};
}
export function changePolicy(rt:Runtime,db:StoreConnection,project:Project,ctx:OperationContext,input:OperationMap['project.policy']['input']):OperationMap['project.policy']['output'] {
 requireOperator(ctx);
 return runMutation(db,ctx,'project.policy',input,()=>{
  let version=Number(metadata(db,'policyVersion'));
  if(version!==input.expectedPolicyVersion)throw new BacklogError('REVISION_CONFLICT','Stale policy version',{actualVersion:version});
  if(input.itemId){
   const item=getItem(db,input.itemId);checkRevision(item,input.expectedRevision!);scopeMutable(db,item);
   if(item.parent_id)throw new BacklogError('VALIDATION_ERROR','Child policy overrides are forbidden');
   db.prepare('UPDATE items SET policy_override=? WHERE id=?').run(input.policy,item.id);advanceItem(db,item,ctx,rt.now(),true);
   return {receipt:{policy:resolvePolicy(db,getItem(db,item.id)).policy,policyVersion:version,item:projection(getItem(db,item.id),project)},event:{ids:[item.id],revision:item.revision+1,changedFields:['policy']}};
  }
  if(input.policy===null)throw new BacklogError('VALIDATION_ERROR','Project default cannot be cleared');
  if(input.policy!==metadata(db,'policy')){
   for(const row of db.prepare('SELECT item_id FROM claims').all())if(resolvePolicy(db,getItem(db,String(row.item_id))).source==='project')throw new BacklogError('CLAIM_CONFLICT','Project policy is frozen by recorded ownership');
   version++;
   for(const row of db.prepare('SELECT id FROM items WHERE parent_id IS NULL AND policy_override IS NULL').all()){
    const item=getItem(db,String(row.id));if(!['done','canceled'].includes(category(db,item)))db.prepare('DELETE FROM current_authorizations WHERE item_id=?').run(item.id);
   }
   db.prepare("UPDATE metadata SET value=? WHERE key='policy'").run(input.policy);db.prepare("UPDATE metadata SET value=? WHERE key='policyVersion'").run(String(version));
  }
  return {receipt:{policy:input.policy,policyVersion:version},event:{ids:[],policyVersion:version,changedFields:['policy']}};
 },rt.now);
}
