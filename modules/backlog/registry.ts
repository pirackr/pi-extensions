import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { BacklogError } from './errors.ts';
import { runMutation } from './mutations.ts';
import { openStore, withWriteTransaction, type StoreConnection } from './store.ts';
import { defaultWorkflow } from './workflows.ts';
import type { OperationContext, OperationMap, Project } from './types.ts';
import type { Runtime } from './service.ts';
export function canonicalDirectory(cwd:string,directory:string):string {
 try{const result=realpathSync(resolve(cwd,directory));if(!statSync(result).isDirectory())throw Error();return result;}
 catch{throw new BacklogError('DIRECTORY_UNAVAILABLE','Directory does not exist or is unavailable');}
}
export function projectProjection(row:Record<string,unknown>,dataRoot:string):Project {
 let available=false;try{available=statSync(String(row.directory)).isDirectory();}catch{}
 return {id:String(row.id),name:String(row.name),directory:String(row.directory),available,registryRevision:Number(row.revision),createdAt:String(row.created_at),updatedAt:String(row.updated_at),dataRoot};
}
export function requireOperator(ctx:OperationContext):void {if(ctx.actor.role!=='operator')throw new BacklogError('AUTHORIZATION_REQUIRED','Operator action required');}
export function selectProject(db:StoreConnection,ctx:OperationContext,dataRoot:string):Project {
 let row:Record<string,unknown>|undefined;
 if(ctx.projectId){row=db.prepare('SELECT * FROM projects WHERE id=?').get(ctx.projectId);if(!row)throw new BacklogError('PROJECT_NOT_FOUND','Unknown project UUID');}
 else {
  const cwd=canonicalDirectory(ctx.cwd,'.');
  row=db.prepare('SELECT * FROM projects').all().filter(p=>{const r=relative(String(p.directory),cwd);return !isAbsolute(r)&&r!=='..'&&!r.startsWith(`..${sep}`);}).sort((a,b)=>String(b.directory).length-String(a.directory).length)[0];
  if(!row)throw new BacklogError('PROJECT_UNREGISTERED','Current directory is not registered');
 }
 return projectProjection(row,dataRoot);
}
export function changeProject(rt:Runtime,ctx:OperationContext,operation:'project.rename'|'project.relocate',input:{name?:string;directory?:string;expectedRegistryRevision:number;mutationId?:string}):Project {
 requireOperator(ctx);const db=rt.registry();const selected=selectProject(db,ctx,rt.dataRoot);
 const directory=operation==='project.relocate'?canonicalDirectory(ctx.cwd,input.directory!):undefined;
 return runMutation(db,ctx,operation,{...input,projectId:selected.id,directory},()=>{
  const row=db.prepare('SELECT * FROM projects WHERE id=?').get(selected.id)!;
  if(row.revision!==input.expectedRegistryRevision)throw new BacklogError('REVISION_CONFLICT','Stale registry revision',{actualRevision:Number(row.revision)});
  if(directory&&db.prepare('SELECT id FROM projects WHERE directory=? AND id<>?').get(directory,selected.id))throw new BacklogError('VALIDATION_ERROR','Directory is already registered');
  db.prepare('UPDATE projects SET name=?,directory=?,revision=revision+1,updated_at=? WHERE id=?').run(input.name??String(row.name),directory??String(row.directory),new Date(rt.now()).toISOString(),selected.id);
  return {receipt:projectProjection(db.prepare('SELECT * FROM projects WHERE id=?').get(selected.id)!,rt.dataRoot),event:{ids:[selected.id],revision:input.expectedRegistryRevision+1,changedFields:[operation==='project.rename'?'name':'directory']}};
 },rt.now);
}
export function registerProject(rt:Runtime,ctx:OperationContext,input:OperationMap['project.register']['input']):Project {
 requireOperator(ctx);const directory=canonicalDirectory(ctx.cwd,input.directory);const registry=rt.registry(true);
 const existing=registry.prepare('SELECT * FROM projects WHERE directory=?').get(directory);
 // Publication below repeats this lookup under the writer lock.
 if(existing&&!input.mutationId)return projectProjection(existing,rt.dataRoot);
 const id=rt.uuid();const paths=rt.paths();const db=openStore(paths.project(id),'project','create-new');
 const timestamp=new Date(rt.now()).toISOString();
 try{withWriteTransaction(db,()=>{
  for(const [key,value] of Object.entries({projectId:id,policy:'approval_required',policyVersion:'1',requestWorkflow:'1',taskWorkflow:'1'}))db.prepare('INSERT INTO metadata VALUES (?,?)').run(key,value);
  for(const kind of ['request','task'] as const)db.prepare('INSERT INTO workflows VALUES (?,?,?)').run(kind,1,JSON.stringify(defaultWorkflow(kind)));
 });}finally{db.close();}
 return runMutation(registry,ctx,'project.register',{...input,directory},()=>{
  let row=registry.prepare('SELECT * FROM projects WHERE directory=?').get(directory);
  if(!row){registry.prepare('INSERT INTO projects VALUES (?,?,?,?,?,?)').run(id,input.name,directory,1,timestamp,timestamp);row=registry.prepare('SELECT * FROM projects WHERE id=?').get(id)!;}
  return {receipt:projectProjection(row,rt.dataRoot),event:{ids:[String(row.id)],revision:Number(row.revision),changedFields:['registration']}};
 },rt.now);
}
