import { currentAuthorization } from './authorization.ts';
import { claimFor } from './claims.ts';
import { category, getItem, scopeComplete, type StoredItem } from './items.ts';
import { resolvePolicy } from './policy.ts';
import type { StoreConnection } from './store.ts';
import type { Eligibility } from './types.ts';
export function dependenciesComplete(db:StoreConnection,item:StoredItem):boolean {
 return db.prepare('SELECT prerequisite_id FROM dependencies WHERE task_id=?').all(item.id).every(row=>category(db,getItem(db,String(row.prerequisite_id)))==='done');
}
export function evaluateEligibility(db:StoreConnection,item:StoredItem,now:number):Eligibility {
 const stage=category(db,item),policy=resolvePolicy(db,item),authorized=!!currentAuthorization(db,item),reasons:string[]=[];
 if(item.kind!=='task')reasons.push('not_task');
 if(!['ready','active'].includes(stage))reasons.push('category');
 if(!scopeComplete(item))reasons.push('scope_incomplete');
 if(!authorized)reasons.push('authorization_required');
 const parent=item.parent_id?getItem(db,item.parent_id):undefined;
 if(parent&&!['ready','active'].includes(category(db,parent)))reasons.push('parent_category');
 if(!dependenciesComplete(db,item))reasons.push('dependencies_incomplete');
 const claim=claimFor(db,item.id);if(claim)reasons.push(claim.expires_at<=now?'recovery_required':'claim_conflict');
 return {eligible:!reasons.length,category:stage,policy,authorized,...(parent?{parentScopeRevision:parent.scope_revision}:{}),reasons};
}
