import { BacklogError } from './errors.ts';
import { advanceItem, category, checkRevision, getItem, projection, scopeMutable, type StoredItem } from './items.ts';
import { runMutation } from './mutations.ts';
import { strictObject, validate } from './validation.ts';
import type { Runtime } from './service.ts';
import type { StoreConnection } from './store.ts';
import type { DependencyChange, Item, ItemReference, OperationContext, Project } from './types.ts';
export function reference(value:unknown,projectId:string):ItemReference {
 const input=strictObject(value,['projectId','itemId']);validate('projectId',input.projectId);validate('itemId',input.itemId);
 if(input.projectId!==projectId)throw new BacklogError('VALIDATION_ERROR','Cross-project relationship is forbidden');return input as unknown as ItemReference;
}
export function assignParent(db:StoreConnection,item:StoredItem,value:ItemReference|null,project:Project):void {
 scopeMutable(db,item);
 if(item.kind!=='task'||category(db,item)!=='draft')throw new BacklogError('VALIDATION_ERROR','Only unclaimed draft tasks may change parent');
 if(value){const ref=reference(value,project.id);const parent=getItem(db,ref.itemId);
  if(parent.kind!=='request'||['done','canceled'].includes(category(db,parent)))throw new BacklogError('VALIDATION_ERROR','Parent must be a nonterminal request');
  if(item.policy_override!==null)throw new BacklogError('VALIDATION_ERROR','Clear the task policy override before parenting');
 }
 db.prepare('UPDATE items SET parent_id=? WHERE id=?').run(value?.itemId??null,item.id);
}
export function changeDependency(rt:Runtime,db:StoreConnection,project:Project,ctx:OperationContext,operation:'dependency.add'|'dependency.remove',input:DependencyChange):Item {
 return runMutation(db,ctx,operation,input,()=>{
  const item=getItem(db,input.itemId);checkRevision(item,input.expectedRevision);scopeMutable(db,item);
  const ref=reference(input.prerequisite,project.id),dep=getItem(db,ref.itemId);
  if(item.kind!=='task'||dep.kind!=='task'||item.id===dep.id)throw new BacklogError('VALIDATION_ERROR','Dependencies must be distinct tasks');
  if(operation==='dependency.add'){
   const seen=new Set<string>(),queue=[dep.id];while(queue.length){const id=queue.pop()!;if(id===item.id)throw new BacklogError('DEPENDENCY_CYCLE','Dependency cycle');if(seen.has(id))continue;seen.add(id);for(const row of db.prepare('SELECT prerequisite_id FROM dependencies WHERE task_id=?').all(id))queue.push(String(row.prerequisite_id));}
   db.prepare('INSERT OR IGNORE INTO dependencies VALUES (?,?)').run(item.id,dep.id);
  }else db.prepare('DELETE FROM dependencies WHERE task_id=? AND prerequisite_id=?').run(item.id,dep.id);
  advanceItem(db,item,ctx,rt.now(),true);
  return {receipt:projection(getItem(db,item.id),project),event:{ids:[item.id],revision:item.revision+1,changedFields:['dependencies']}};
 },rt.now);
}
