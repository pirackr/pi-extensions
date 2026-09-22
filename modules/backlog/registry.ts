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
