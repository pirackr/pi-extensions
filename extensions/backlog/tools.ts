import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { Check } from 'typebox/value';
import { BacklogError } from '../../modules/backlog/errors.ts';
import { operationSchemas, validateOperationInput } from '../../modules/backlog/validation.ts';
import type { BacklogService, OperationMap } from '../../modules/backlog/types.ts';
import { fitsToolResult, formatToolResult, safeDisplay } from './output.ts';
export type ServiceProvider=(ctx:ExtensionContext,dataDir?:string)=>BacklogService;
const actions:Record<string,(keyof OperationMap)[]>={
 backlog_read:['project.list','project.show','item.list','item.show','item.read-text','workflow.show','history.list','note.list','artifact.list','result.list','backlog.summary'],
 backlog_item:['item.add','item.update','item.transition','dependency.add','dependency.remove','note.append','artifact.attach','result.append'],
 backlog_authorize:['authorization.authorize'],
 backlog_claim:['claim.acquire','claim.renew','claim.release','claim.recover'],
};
export function registerBacklogTools(pi:ExtensionAPI,getService:ServiceProvider):void {
 for(const [name,operations] of Object.entries(actions)){
  const parameters=Type.Union(operations.map(action=>Type.Object({action:Type.Literal(action),input:operationSchemas[action],projectId:Type.Optional(Type.String())},{additionalProperties:false})));
  pi.registerTool({name,label:name,description:`Shared project backlog ${name.slice(8)} operations. Maintenance does not authorize execution. Claims require caller-owned renewal; no automatic heartbeat. Follow nextCursor for additional records; item.read-text retrieves full text. Operator controls are not available.`,parameters,
   async execute(_id,raw,_signal,_update,ctx){
    try{
     if(!Check(parameters,raw))throw new BacklogError('VALIDATION_ERROR','Invalid backlog tool input');
     const params=raw as {action:keyof OperationMap;input:OperationMap[keyof OperationMap]['input'];projectId?:string};validateOperationInput(params.action,params.input);
     const service=getService(ctx),context={cwd:ctx.cwd,projectId:params.projectId,actor:{id:'pi:'+ctx.sessionManager.getSessionId(),channel:'pi-tool' as const,role:'automation' as const}};
     let result=service.execute(context,params.action,params.input),limit=('limit' in params.input?params.input.limit:undefined)??50;
     const pageable=Object.hasOwn(operationSchemas[params.action].properties,'limit');
     // Re-query from the ORIGINAL cursor with a smaller limit. Its returned cursor
     // names the last emitted record, never the discarded page's last record.
     while(!fitsToolResult(result)&&pageable&&limit>1){limit=Math.max(1,Math.floor(limit/2));result=service.execute(context,params.action,{...params.input,limit});result=Object.assign(result,{truncated:true});}
     return formatToolResult(result);
    }catch(error){if(error instanceof BacklogError)throw new BacklogError(error.code,safeDisplay(error.message),error.details);throw new BacklogError('STORE_ERROR','Backlog operation failed');}
   },
  });
 }
}
