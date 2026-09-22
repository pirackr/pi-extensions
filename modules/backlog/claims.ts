import { timingSafeEqual } from 'node:crypto';
import { BacklogError } from './errors.ts';
import type { StoreConnection } from './store.ts';
import type { ClaimReceipt, OperationContext, OperationMap, OwnershipProof } from './types.ts';
import { advanceItem, checkRevision, getItem } from './items.ts';
import { evaluateEligibility } from './eligibility.ts';
import { runMutation } from './mutations.ts';
import type { Runtime } from './service.ts';
export function acquireClaim(rt:Runtime,db:StoreConnection,ctx:OperationContext,input:OperationMap['claim.acquire']['input']):ClaimReceipt {
 return runMutation(db,ctx,'claim.acquire',input,()=>{
  const item=getItem(db,input.itemId);checkRevision(item,input.expectedRevision);const now=rt.now();const eligible=evaluateEligibility(db,item,now);
  if(item.parent_id&&input.expectedParentScopeRevision!==eligible.parentScopeRevision)throw new BacklogError('REVISION_CONFLICT','Stale or missing parent scope revision',{actualRevision:eligible.parentScopeRevision!});
  if(!eligible.eligible){const reasons=eligible.reasons;throw new BacklogError(reasons.includes('recovery_required')?'RECOVERY_REQUIRED':reasons.includes('claim_conflict')?'CLAIM_CONFLICT':reasons.includes('authorization_required')?'AUTHORIZATION_REQUIRED':'VALIDATION_ERROR','Task is not eligible',{reasons});}
  const generation=Number(db.prepare('INSERT INTO generations(item_id,value) VALUES (?,1) ON CONFLICT(item_id) DO UPDATE SET value=value+1 RETURNING value').get(item.id)!.value);
  const leaseId=rt.uuid(),token=rt.randomToken(),durationSeconds=input.durationSeconds??300,expires=now+durationSeconds*1000;
  db.prepare('INSERT INTO claims VALUES (?,?,?,?,?,?,?,?,?)').run(item.id,leaseId,generation,token,input.worker,expires,durationSeconds,item.scope_revision,eligible.parentScopeRevision??null);
  advanceItem(db,item,ctx,now);
  return {receipt:{leaseId,generation,token,worker:input.worker,expiresAt:new Date(expires).toISOString(),durationSeconds,revision:item.revision+1,taskScopeRevision:item.scope_revision,...(eligible.parentScopeRevision?{parentScopeRevision:eligible.parentScopeRevision}:{})},event:{ids:[item.id],revision:item.revision+1,leaseId,generation,changedFields:['claim']}};
 },rt.now);
}
export interface StoredClaim { item_id:string;lease_id:string;generation:number;token:string;worker:string;expires_at:number;duration_seconds:number;task_scope_revision:number;parent_scope_revision:number|null }
export function claimFor(db:StoreConnection,itemId:string):StoredClaim|undefined{return db.prepare('SELECT * FROM claims WHERE item_id=?').get(itemId) as unknown as StoredClaim|undefined;}
export function assertOwnership(db:StoreConnection,itemId:string,proof:OwnershipProof|undefined,now:number):StoredClaim {
 const claim=claimFor(db,itemId);
 if(!claim||!proof||claim.lease_id!==proof.leaseId||claim.generation!==proof.generation||typeof proof.token!=='string')throw new BacklogError('CLAIM_CONFLICT','Ownership mismatch');
 const expected=Buffer.from(claim.token),actual=Buffer.from(proof.token);
 if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new BacklogError('CLAIM_CONFLICT','Ownership mismatch');
 if(claim.expires_at<=now)throw new BacklogError('LEASE_EXPIRED','Lease expired; explicit recovery required');return claim;
}
