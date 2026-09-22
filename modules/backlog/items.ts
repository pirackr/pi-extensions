import { BacklogError } from './errors.ts';
import { runMutation } from './mutations.ts';
import type { StoreConnection } from './store.ts';
import type { Runtime } from './service.ts';
import type { ActorContext, Category, Item, ItemChange, Kind, OperationContext, OperationMap, Priority, Project } from './types.ts';
import type { WorkflowDefinition } from './workflows.ts';
export interface StoredItem { id:string;number:number;kind:Kind;title:string;description:string;criteria:string;priority:Priority;workflow_version:number;stage:string;revision:number;scope_revision:number;parent_id:string|null;policy_override:string|null;created_at:string;updated_at:string;created_by:string;updated_by:string }
export function getItem(db:StoreConnection,id:string):StoredItem {
 const row=db.prepare('SELECT * FROM items WHERE id=?').get(id);
 if(!row)throw new BacklogError('VALIDATION_ERROR','Unknown item');return row as unknown as StoredItem;
}
export function workflow(db:StoreConnection,item:StoredItem):WorkflowDefinition {return JSON.parse(String(db.prepare('SELECT definition FROM workflows WHERE kind=? AND version=?').get(item.kind,item.workflow_version)!.definition));}
export function category(db:StoreConnection,item:StoredItem):Category{return workflow(db,item).stages.find(s=>s.id===item.stage)!.category;}
export function checkRevision(item:StoredItem,expected:number):void {if(item.revision!==expected)throw new BacklogError('REVISION_CONFLICT','Stale item revision',{actualRevision:item.revision});}
export function scopeComplete(item:StoredItem):boolean{return !!item.description.trim()&&(JSON.parse(item.criteria) as string[]).some(c=>c.trim());}
export function scopeMutable(db:StoreConnection,item:StoredItem):void {
 if(['done','canceled'].includes(category(db,item)))throw new BacklogError('INVALID_TRANSITION','Terminal scope is immutable');
 if(db.prepare('SELECT item_id FROM claims WHERE item_id=? OR item_id IN (SELECT id FROM items WHERE parent_id=?) LIMIT 1').get(item.id,item.id))throw new BacklogError('CLAIM_CONFLICT','Scope is frozen by recorded ownership');
}
export function projection(item:StoredItem,project:Project):Item {
 const text=[...item.description].slice(0,1024).join('');
 return {projectId:project.id,dataRoot:project.dataRoot,id:item.id,kind:item.kind,title:item.title,description:{text,truncated:text!==item.description,locator:{itemId:item.id,field:'description',revision:item.revision}},priority:item.priority,workflowVersion:item.workflow_version,stage:item.stage,revision:item.revision,scopeRevision:item.scope_revision,createdAt:item.created_at,updatedAt:item.updated_at,createdBy:JSON.parse(item.created_by) as ActorContext,updatedBy:JSON.parse(item.updated_by) as ActorContext,...(item.parent_id?{parentId:item.parent_id}:{})};
}
export function advanceItem(db:StoreConnection,item:StoredItem,ctx:OperationContext,now:number,scope=false):void {
 db.prepare('UPDATE items SET revision=revision+1,scope_revision=scope_revision+?,updated_at=?,updated_by=? WHERE id=?').run(scope?1:0,new Date(now).toISOString(),JSON.stringify(ctx.actor),item.id);
 if(scope)db.prepare('UPDATE authorizations SET revoked=1 WHERE item_id=?').run(item.id);
}
export function addItem(rt:Runtime,db:StoreConnection,project:Project,ctx:OperationContext,input:OperationMap['item.add']['input']):Item {
 return runMutation(db,ctx,'item.add',input,()=>{
  const number=Number(db.prepare("UPDATE counters SET value=value+1 WHERE name='items' RETURNING value").get()!.value);
  const version=Number(db.prepare('SELECT value FROM metadata WHERE key=?').get(input.kind+'Workflow')!.value);
  const graph=JSON.parse(String(db.prepare('SELECT definition FROM workflows WHERE kind=? AND version=?').get(input.kind,version)!.definition)) as WorkflowDefinition;
  const id='B-'+number;const date=new Date(rt.now()).toISOString();const actor=JSON.stringify(ctx.actor);
  db.prepare('INSERT INTO items(id,number,kind,title,description,criteria,priority,workflow_version,stage,revision,scope_revision,created_at,updated_at,created_by,updated_by) VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?,?,?)').run(id,number,input.kind,input.title,input.description??'',JSON.stringify(input.criteria??[]),input.priority??'normal',version,graph.initial,date,date,actor,actor);
  return {receipt:projection(getItem(db,id),project),event:{ids:[id],revision:1,changedFields:['capture']}};
 },rt.now);
}
export function updateItem(rt:Runtime,db:StoreConnection,project:Project,ctx:OperationContext,input:ItemChange):Item {
 return runMutation(db,ctx,'item.update',input,()=>{
  const item=getItem(db,input.itemId);checkRevision(item,input.expectedRevision);
  const scope=['title','description','criteria'].some(k=>Object.hasOwn(input,k));if(scope)scopeMutable(db,item);
  const next={...item,title:input.title??item.title,description:input.description??item.description,criteria:input.criteria?JSON.stringify(input.criteria):item.criteria,priority:input.priority??item.priority};
  if(scope&&['ready','active'].includes(category(db,item))&&!scopeComplete(next))throw new BacklogError('VALIDATION_ERROR','Ready/active scope must remain complete');
  db.prepare('UPDATE items SET title=?,description=?,criteria=?,priority=? WHERE id=?').run(next.title,next.description,next.criteria,next.priority,item.id);
  advanceItem(db,item,ctx,rt.now(),scope);
  return {receipt:projection(getItem(db,item.id),project),event:{ids:[item.id],revision:item.revision+1,changedFields:Object.keys(input).filter(k=>!['itemId','expectedRevision','mutationId'].includes(k))}};
 },rt.now);
}
