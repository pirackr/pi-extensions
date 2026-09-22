import { afterEach, expect, it, vi } from 'vitest';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerBacklogTools } from '../../extensions/backlog/tools.ts';
import { formatToolResult } from '../../extensions/backlog/output.ts';
import { serviceFixture } from './helpers.ts';
import { createBacklogExtension } from '../../extensions/backlog/index.ts';
vi.mock('@earendil-works/pi-coding-agent',()=>({getAgentDir:()=>'/unused-agent'}));
const fixtures:ReturnType<typeof serviceFixture>[]=[];afterEach(()=>fixtures.splice(0).forEach(f=>f.close()));
export function harness(){const f=serviceFixture();fixtures.push(f);const tools=new Map<string,Parameters<ExtensionAPI['registerTool']>[0]>();const pi={registerTool:(t:Parameters<ExtensionAPI['registerTool']>[0])=>{tools.set(t.name,t);}} as ExtensionAPI;registerBacklogTools(pi,()=>f.service);const ctx={cwd:f.context.cwd,sessionManager:{getSessionId:()=> 'session'}} as ExtensionContext;return {...f,tools,ctx,call:(name:string,args:unknown)=>tools.get(name)!.execute('id',args,undefined,undefined,ctx)};}
it('keeps lifecycle inert, uses current cwd, supports no UI and closes lazily on reload/shutdown',async()=>{
 const f=serviceFixture();fixtures.push(f);const events=new Map<string,Function>();let command:Parameters<ExtensionAPI['registerCommand']>[1];const messages:unknown[]=[];const close=vi.spyOn(f.service,'close');const execute=vi.spyOn(f.service,'execute');const createService=vi.fn(()=>f.service);
 const pi={registerTool:vi.fn(),registerFlag:vi.fn(),getFlag:()=>undefined,registerCommand:(_name:string,c:typeof command)=>{command=c;},sendMessage:(message:unknown)=>messages.push(message),on:(name:string,handler:Function)=>events.set(name,handler)} as unknown as ExtensionAPI;
 createBacklogExtension(pi,{agentDir:()=>'/agent',env:{PI_BACKLOG_DIR:f.projectRecord.dataRoot},createService});
 const context={cwd:f.context.cwd,hasUI:false,sessionManager:{getSessionId:()=> 'session',getBranch:()=>[{type:'message',message:{role:'toolResult',details:{action:'claim.acquire'}}}]}} as unknown as ExtensionContext;
 expect(createService).not.toHaveBeenCalled();for(const reason of ['startup','reload','new','resume','fork','tree'])await events.get('session_start')?.({reason},context);expect(execute).not.toHaveBeenCalled();expect(messages).toEqual([]);
 await command!.handler('item add --kind task --title Example',context);expect(execute).toHaveBeenCalledWith(expect.objectContaining({cwd:context.cwd,actor:expect.objectContaining({role:'operator',channel:'pi-command'})}),'item.add',expect.anything());
 await command!.handler('',context);expect(messages).toHaveLength(2);expect(f.service.execute(f.context,'item.show',{itemId:'B-1'}).title).toBe('Example');
 await command!.handler('item add --input -',context);expect(messages).toHaveLength(3);
 await events.get('session_start')?.({reason:'reload'},context);await events.get('session_shutdown')?.({},context);expect(close).toHaveBeenCalledTimes(1);
});
it('exposes no operator controls and rejects actor/unknown-field injection before service use',async()=>{
 const h=harness();expect([...h.tools.keys()]).toEqual(['backlog_read','backlog_item','backlog_authorize','backlog_claim']);
 for(const action of ['project.register','project.policy','authorization.approve','authorization.revoke','workflow.publish'])await expect(h.call('backlog_item',{action,input:{}})).rejects.toThrow();
 await expect(h.call('backlog_item',{action:'item.add',input:{kind:'task',title:'A'},actor:{role:'operator'}})).rejects.toThrow();await expect(h.call('backlog_item',{action:'item.add',input:{kind:'task',title:'A',stage:'done'}})).rejects.toThrow();
 const added=await h.call('backlog_item',{action:'item.add',input:{kind:'task',title:'A'}});expect(added.details).toMatchObject({createdBy:{role:'automation',channel:'pi-tool'}});
});
it('reduces service pages without skipping discarded records and bounds both surfaces',async()=>{
 const h=harness();for(let i=0;i<80;i++)h.service.execute(h.context,'item.add',{kind:'task',title:String(i),description:'漢'.repeat(2000)});
 let cursor:string|undefined;const ids:string[]=[];do{const result=await h.call('backlog_read',{action:'item.list',input:{limit:80,cursor}});expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThanOrEqual(51200);expect(Buffer.byteLength(result.content[0].text)).toBeLessThanOrEqual(51200);const data=result.details as {items:{id:string}[];nextCursor?:string};ids.push(...data.items.map(i=>i.id));cursor=data.nextCursor;}while(cursor);expect(ids).toHaveLength(80);expect(new Set(ids).size).toBe(80);
});
it('escapes terminal controls only in display and never truncates private acquisition credentials',()=>{
 const token='private-token';const result=formatToolResult({token,title:'\u001b]52;c;payload\u0007\u009b31m',worker:'w'.repeat(240)});expect(result.content[0].text).not.toContain('\u001b');expect(result.content[0].text).not.toContain('\u009b');expect(result.details).toMatchObject({token,title:'\u001b]52;c;payload\u0007\u009b31m'});expect(()=>formatToolResult({text:'x'.repeat(100000)})).toThrow();
});
