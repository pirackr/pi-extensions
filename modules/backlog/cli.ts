import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { userInfo } from 'node:os';
import { parseCommand } from './commands.ts';
import { BacklogError, exitCode } from './errors.ts';
import { resolveDataRoot } from './paths.ts';
import { createBacklogService } from './service.ts';
import type { BacklogService } from './types.ts';
export interface CliIO {cwd:string;env:Record<string,string|undefined>;stdin:()=>Promise<string>;stdout:(text:string)=>void;stderr:(text:string)=>void}
export const defaultIO:CliIO={cwd:process.cwd(),env:process.env,stdin:async()=>{let text='';for await(const chunk of process.stdin){text+=chunk.toString();if(Buffer.byteLength(text)>16*1024*1024)throw new BacklogError('VALIDATION_ERROR','Input exceeds 16 MiB');}return text;},stdout:text=>{process.stdout.write(text);},stderr:text=>{process.stderr.write(text);}};
export async function inputPayload(argv:string[],io:Pick<CliIO,'cwd'|'stdin'>):Promise<unknown> {
 const index=argv.indexOf('--input');if(index<0)return undefined;
 try{const path=argv[index+1];if(!path)throw Error();const text=path==='-'?await io.stdin():await readFile(resolve(io.cwd,path),'utf8');if(Buffer.byteLength(text)>16*1024*1024)throw Error();return JSON.parse(text);}
 catch{throw new BacklogError('VALIDATION_ERROR','Cannot read or parse input JSON');}
}
export async function runCli(argv:string[],io:CliIO=defaultIO):Promise<number> {
 let service:BacklogService|undefined;const json=argv.includes('--json');
 try{
  const parsed=parseCommand(argv,await inputPayload(argv,io));
  service=createBacklogService({dataRoot:resolveDataRoot({cwd:io.cwd,env:io.env,dataDir:parsed.dataDir})});
  const data=service.execute({cwd:io.cwd,projectId:parsed.projectId,actor:{id:parsed.actor??userInfo().username,channel:'cli',role:'operator'}},parsed.operation,parsed.input);
  io.stdout(JSON.stringify(json?{apiVersion:1,ok:true,data}:data,null,json?undefined:2)+'\n');return 0;
 }catch(error){
  const domain=error instanceof BacklogError?error:new BacklogError('STORE_ERROR','Backlog storage/runtime failure');
  const body={code:domain.code,message:domain.message,details:domain.details};
  if(json)io.stdout(JSON.stringify({apiVersion:1,ok:false,error:body})+'\n');else io.stderr(`${body.code}: ${body.message}\n`);return exitCode(domain.code);
 }finally{service?.close();}
}
