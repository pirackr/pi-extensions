import { createHash } from 'node:crypto';
import { BacklogError, type Json } from './errors.ts';
import { withWriteTransaction, type StoreConnection } from './store.ts';
import type { OperationContext } from './types.ts';
function canonical(value: unknown): string {
  if(Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if(value && typeof value==='object') return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';
  return JSON.stringify(value);
}
export interface MutationResult<T> { receipt: T; event: Json }
export function runMutation<T>(db: StoreConnection, context: OperationContext, operation: string, input: {mutationId?:string}, apply: ()=>MutationResult<T>, now: ()=>number = Date.now): T {
  const digest=createHash('sha256').update(canonical({operation,input,role:context.actor.role})).digest('hex');
  return withWriteTransaction(db,()=>{
    if(input.mutationId!==undefined) {
      const old=db.prepare('SELECT digest,receipt FROM receipts WHERE actor=? AND channel=? AND mutation_id=?').get(context.actor.id,context.actor.channel,input.mutationId);
      if(old) {if(old.digest!==digest) throw new BacklogError('MUTATION_ID_CONFLICT','Mutation ID was already used for another payload'); return JSON.parse(String(old.receipt)) as T;}
    }
    const result=apply();
    const event=new BacklogError('STORE_ERROR','',result.event).details;
    db.prepare('INSERT INTO events(operation,timestamp,actor,payload) VALUES (?,?,?,?)').run(operation,new Date(now()).toISOString(),JSON.stringify(context.actor),JSON.stringify(event));
    if(input.mutationId!==undefined) db.prepare('INSERT INTO receipts VALUES (?,?,?,?,?)').run(context.actor.id,context.actor.channel,input.mutationId,digest,JSON.stringify(result.receipt));
    return result.receipt;
  });
}
