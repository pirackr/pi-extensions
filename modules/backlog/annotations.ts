import { BacklogError } from './errors.ts';
import { assertOwnership, claimFor } from './claims.ts';
import { advanceItem, category, checkRevision, getItem, projection } from './items.ts';
import { runMutation } from './mutations.ts';
import type { Runtime } from './service.ts';
import type { StoreConnection } from './store.ts';
import type { OperationContext, OperationMap, Project } from './types.ts';
export type AnnotationOperation='note.append'|'artifact.attach'|'result.append';
export function appendAnnotation(rt:Runtime,db:StoreConnection,project:Project,ctx:OperationContext,operation:AnnotationOperation,input:OperationMap[AnnotationOperation]['input']) {
 return runMutation(db,ctx,operation,input,()=>{
  const item=getItem(db,input.itemId);checkRevision(item,input.expectedRevision);
  if('result' in input){
   if(['done','canceled'].includes(category(db,item)))throw new BacklogError('INVALID_TRANSITION','Terminal progress is immutable');
   if(claimFor(db,item.id))assertOwnership(db,item.id,input.proof,rt.now());
  }
  const kind=operation.split('.')[0];const records='artifacts' in input?input.artifacts:['text' in input?input.text:input.result];
  for(const body of records)db.prepare('INSERT INTO annotations(item_id,kind,body,timestamp,actor) VALUES (?,?,?,?,?)').run(item.id,kind,JSON.stringify(body),new Date(rt.now()).toISOString(),JSON.stringify(ctx.actor));
  advanceItem(db,item,ctx,rt.now());
  return {receipt:projection(getItem(db,item.id),project),event:{ids:[item.id],revision:item.revision+1,changedFields:[kind]}};
 },rt.now);
}
