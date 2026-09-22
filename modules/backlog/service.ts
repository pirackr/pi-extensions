import { existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { BacklogError } from './errors.ts';
import { prepareStorePaths, type StorePaths } from './paths.ts';
import { openStore, type StoreConnection } from './store.ts';
import { projectProjection, registerProject, selectProject, requireOperator, changeProject } from './registry.ts';
import { changeDependency, reference } from './relationships.ts';
import { addItem, updateItem, getItem, projection } from './items.ts';
import { changeAuthorization } from './authorization.ts';
import { changePolicy } from './policy.ts';
import { appendAnnotation, type AnnotationOperation } from './annotations.ts';
import { strictObject, validate, validateProof, validateCompletion } from './validation.ts';
import type { BacklogService, OperationContext, OperationMap, ServiceOptions } from './types.ts';
export interface Runtime {
 dataRoot:string;now:()=>number;uuid:()=>string;randomToken:()=>string;
 registry(create?:boolean):StoreConnection;paths():StorePaths;
}
export function createBacklogService(options:ServiceOptions):BacklogService {
 if(!isAbsolute(options.dataRoot))throw new BacklogError('VALIDATION_ERROR','dataRoot must be absolute');
 let connection:StoreConnection|undefined;let closed=false;
 const projects=new Map<string,StoreConnection>();
 const rt:Runtime={dataRoot:options.dataRoot,now:options.now??Date.now,uuid:options.uuid??randomUUID,randomToken:options.randomToken??(()=>randomBytes(32).toString('hex')),
  paths:()=>prepareStorePaths(options.dataRoot),
  registry(create=false){
   if(connection)return connection;
   const path=join(options.dataRoot,'registry.sqlite');
   if(!existsSync(path)&&!create)throw new BacklogError('PROJECT_UNREGISTERED','No backlog registry');
   if(create)rt.paths();
   connection=openStore(path,'registry',existsSync(path)?'open-existing':'create-new');return connection;
  }
 };
 function dispatch(ctx:OperationContext,operation:keyof OperationMap,raw:unknown):unknown {
  if(closed)throw new BacklogError('STORE_ERROR','Service is closed');
  if(ctx.projectId!==undefined)validate('projectId',ctx.projectId);
  if(operation==='project.register'){
   requireOperator(ctx);const input=strictObject(raw,['directory','name','mutationId']);validate('reference',input.directory);validate('label',input.name);
   if(input.mutationId!==undefined)validate('label',input.mutationId);
   return registerProject(rt,ctx,input as unknown as OperationMap['project.register']['input']);
  }
  if(operation==='project.rename'||operation==='project.relocate'){
   requireOperator(ctx);const input=strictObject(raw,[operation==='project.rename'?'name':'directory','expectedRegistryRevision','mutationId']);
   validate('revision',input.expectedRegistryRevision);validate(operation==='project.rename'?'label':'reference',input[operation==='project.rename'?'name':'directory']);
   if(input.mutationId!==undefined)validate('label',input.mutationId);
   return changeProject(rt,ctx,operation,input as unknown as {name?:string;directory?:string;expectedRegistryRevision:number;mutationId?:string});
  }
  if(operation==='authorization.approve'||operation==='authorization.authorize'||operation==='authorization.revoke'){
   if(operation!=='authorization.authorize')requireOperator(ctx);
   const input=strictObject(raw,['itemId','expectedRevision','mutationId','rationale']);validate('itemId',input.itemId);validate('revision',input.expectedRevision);validate('note',input.rationale);if(!(input.rationale as string).trim())throw new BacklogError('VALIDATION_ERROR','Rationale required');if(input.mutationId!==undefined)validate('label',input.mutationId);
   const project=selectProject(rt.registry(),ctx,rt.dataRoot);
   let db=projects.get(project.id);if(!db){db=openStore(rt.paths().project(project.id),'project','open-existing');projects.set(project.id,db);}
   return changeAuthorization(rt,db,project,ctx,operation,input as unknown as OperationMap['authorization.approve']['input']);
  }
  if(operation==='project.policy'){
   requireOperator(ctx);const input=strictObject(raw,['policy','expectedPolicyVersion','itemId','expectedRevision','mutationId']);validate('revision',input.expectedPolicyVersion);
   if(input.policy!==null&&!['autonomous','approval_required'].includes(String(input.policy)))throw new BacklogError('VALIDATION_ERROR','Invalid policy');
   if(input.itemId!==undefined){validate('itemId',input.itemId);validate('revision',input.expectedRevision);}if(input.mutationId!==undefined)validate('label',input.mutationId);
   const project=selectProject(rt.registry(),ctx,rt.dataRoot);
   let db=projects.get(project.id);if(!db){db=openStore(rt.paths().project(project.id),'project','open-existing');projects.set(project.id,db);}
   return changePolicy(rt,db,project,ctx,input as unknown as OperationMap['project.policy']['input']);
  }
  if(operation==='note.append'||operation==='artifact.attach'||operation==='result.append'){
   const extra=operation==='note.append'?['text']:operation==='artifact.attach'?['artifacts']:['result','proof'];
   const input=strictObject(raw,['itemId','expectedRevision','mutationId',...extra]);validate('itemId',input.itemId);validate('revision',input.expectedRevision);if(input.mutationId!==undefined)validate('label',input.mutationId);
   if(operation==='note.append')validate('note',input.text);else if(operation==='artifact.attach')validate('artifacts',input.artifacts);else validateCompletion(input.result);
   if(input.proof!==undefined)validateProof(input.proof);
   const project=selectProject(rt.registry(),ctx,rt.dataRoot);
   let db=projects.get(project.id);if(!db){db=openStore(rt.paths().project(project.id),'project','open-existing');projects.set(project.id,db);}
   return appendAnnotation(rt,db,project,ctx,operation,input as unknown as OperationMap[AnnotationOperation]['input']);
  }
  if(operation==='dependency.add'||operation==='dependency.remove'){
   const input=strictObject(raw,['itemId','prerequisite','expectedRevision','mutationId']);validate('itemId',input.itemId);validate('revision',input.expectedRevision);if(input.mutationId!==undefined)validate('label',input.mutationId);
   const project=selectProject(rt.registry(),ctx,rt.dataRoot);reference(input.prerequisite,project.id);
   let db=projects.get(project.id);if(!db){db=openStore(rt.paths().project(project.id),'project','open-existing');projects.set(project.id,db);}
   return changeDependency(rt,db,project,ctx,operation,input as unknown as OperationMap['dependency.add']['input']);
  }
  if(operation==='item.add'||operation==='item.show'||operation==='item.update') {
   const fields=operation==='item.add'?['kind','title','description','criteria','priority','mutationId']:operation==='item.show'?['itemId']:['itemId','expectedRevision','title','description','criteria','priority','parent','mutationId'];
   const input=strictObject(raw,fields);
   if(operation==='item.add'){validate('kind',input.kind);validate('title',input.title);}else validate('itemId',input.itemId);
   if(operation==='item.update')validate('revision',input.expectedRevision);
   for(const key of ['title','description','criteria','priority'] as const)if(Object.hasOwn(input,key))validate(key,input[key]);
   if(input.mutationId!==undefined)validate('label',input.mutationId);
   const project=selectProject(rt.registry(),ctx,rt.dataRoot);
   let db=projects.get(project.id);if(!db){db=openStore(rt.paths().project(project.id),'project','open-existing');projects.set(project.id,db);}
   if(operation==='item.show')return projection(getItem(db,String(input.itemId)),project);
   if(operation==='item.add')return addItem(rt,db,project,ctx,input as unknown as OperationMap['item.add']['input']);
   return updateItem(rt,db,project,ctx,input as unknown as OperationMap['item.update']['input']);
  }
  strictObject(raw,[]);
  if(operation==='project.list'){
   if(!existsSync(join(rt.dataRoot,'registry.sqlite')))return {items:[]};
   return {items:rt.registry().prepare('SELECT * FROM projects ORDER BY created_at,id LIMIT 50').all().map(row=>projectProjection(row,rt.dataRoot))};
  }
  if(operation==='project.show')return selectProject(rt.registry(),ctx,rt.dataRoot);
  throw new BacklogError('VALIDATION_ERROR','Unknown operation');
 }
 return {execute:dispatch as BacklogService['execute'],close(){if(!closed){for(const db of projects.values())db.close();projects.clear();connection?.close();connection=undefined;closed=true;}}};
}
