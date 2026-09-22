import { existsSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { BacklogError } from './errors.ts';
import { prepareStorePaths, type StorePaths } from './paths.ts';
import { openStore, type StoreConnection } from './store.ts';
import { projectProjection, registerProject, selectProject, requireOperator, changeProject } from './registry.ts';
import { addItem, updateItem, getItem, projection } from './items.ts';
import { strictObject, validate } from './validation.ts';
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
  if(operation==='item.add'||operation==='item.show'||operation==='item.update') {
   const fields=operation==='item.add'?['kind','title','description','criteria','priority','mutationId']:operation==='item.show'?['itemId']:['itemId','expectedRevision','title','description','criteria','priority','mutationId'];
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
