import { getAgentDir, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createBacklogService } from '../../modules/backlog/service.ts';
import { resolveDataRoot } from '../../modules/backlog/paths.ts';
import { parseCommand, tokenize } from '../../modules/backlog/commands.ts';
import { inputPayload } from '../../modules/backlog/cli.ts';
import { BacklogError } from '../../modules/backlog/errors.ts';
import type { BacklogService } from '../../modules/backlog/types.ts';
import { registerBacklogTools } from './tools.ts';
import { formatToolResult, safeDisplay } from './output.ts';
export interface BacklogDependencies {agentDir?:()=>string;env?:Record<string,string|undefined>;createService?:typeof createBacklogService}
export function createBacklogExtension(pi:ExtensionAPI,dependencies:BacklogDependencies={}):void {
 const services=new Map<string,BacklogService>();
 const close=()=>{for(const service of services.values())service.close();services.clear();};
 const getService=(ctx:ExtensionContext,dataDir?:string)=>{
  const flag=pi.getFlag('backlog-data-dir');
  const root=resolveDataRoot({cwd:ctx.cwd,dataDir:dataDir??(typeof flag==='string'?flag:undefined),env:dependencies.env,agentDir:(dependencies.agentDir??getAgentDir)()});
  let service=services.get(root);if(!service){service=(dependencies.createService??createBacklogService)({dataRoot:root});services.set(root,service);}return service;
 };
 pi.registerFlag('backlog-data-dir',{type:'string',description:'Central backlog data directory (overrides PI_BACKLOG_DIR)'});
 registerBacklogTools(pi,getService);
 pi.registerCommand('backlog',{description:'Shared project backlog; explicit operator commands, never a work runner',handler:async(args,ctx)=>{
  try{
   const argv=tokenize(args);if(argv[argv.indexOf('--input')+1]==='-'&&argv.includes('--input'))throw new BacklogError('VALIDATION_ERROR','Pi does not accept stdin payloads; use --input <file>');
   const payload=await inputPayload(argv,{cwd:ctx.cwd,stdin:async()=>{throw new Error('No terminal input');}}),parsed=parseCommand(argv,payload);
   const result=getService(ctx,parsed.dataDir).execute({cwd:ctx.cwd,projectId:parsed.projectId,actor:{id:parsed.actor??'pi:'+ctx.sessionManager.getSessionId(),channel:'pi-command',role:'operator'}},parsed.operation,parsed.input);
   const formatted=formatToolResult(parsed.json?{apiVersion:1,ok:true,data:result}:result);
   pi.sendMessage({customType:'backlog',content:formatted.content,display:true},{triggerTurn:false});
  }catch(error){const e=error instanceof BacklogError?error:new BacklogError('STORE_ERROR','Backlog operation failed');pi.sendMessage({customType:'backlog',content:safeDisplay(JSON.stringify({apiVersion:1,ok:false,error:{code:e.code,message:e.message,details:e.details}})),display:true},{triggerTurn:false});}
 }});
 pi.on('session_shutdown',close);
 // Session history is never inspected; replacement only discards connections.
 pi.on('session_start',close);
}
export default function backlogExtension(pi:ExtensionAPI):void {createBacklogExtension(pi);}
