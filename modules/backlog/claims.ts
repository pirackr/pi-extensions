import { timingSafeEqual } from 'node:crypto';
import { BacklogError } from './errors.ts';
import type { StoreConnection } from './store.ts';
import type { OwnershipProof } from './types.ts';
export interface StoredClaim { item_id:string;lease_id:string;generation:number;token:string;worker:string;expires_at:number;duration_seconds:number;task_scope_revision:number;parent_scope_revision:number|null }
export function claimFor(db:StoreConnection,itemId:string):StoredClaim|undefined{return db.prepare('SELECT * FROM claims WHERE item_id=?').get(itemId) as unknown as StoredClaim|undefined;}
export function assertOwnership(db:StoreConnection,itemId:string,proof:OwnershipProof|undefined,now:number):StoredClaim {
 const claim=claimFor(db,itemId);
 if(!claim||!proof||claim.lease_id!==proof.leaseId||claim.generation!==proof.generation||typeof proof.token!=='string')throw new BacklogError('CLAIM_CONFLICT','Ownership mismatch');
 const expected=Buffer.from(claim.token),actual=Buffer.from(proof.token);
 if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new BacklogError('CLAIM_CONFLICT','Ownership mismatch');
 if(claim.expires_at<=now)throw new BacklogError('LEASE_EXPIRED','Lease expired; explicit recovery required');return claim;
}
