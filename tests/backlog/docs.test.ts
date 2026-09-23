import { expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createBacklogExtension } from '../../extensions/backlog/index.ts';
import { fixture } from './helpers.ts';
import { defaultWorkflow } from '../../modules/backlog/workflows.ts';
vi.mock('@earendil-works/pi-coding-agent',()=>({getAgentDir:()=>'/unused'}));
import { readFileSync } from 'node:fs';
it('smokes a fresh Pi adapter against real CLI processes and custom active stages without workers',async()=>{
 const f=fixture();const instances:(()=>void)[]=[];
 const cli=(operation:string,input:unknown={})=>{const child=spawnSync(process.execPath,[resolve('bin/pi-backlog.mjs'),...operation.split('.'),'--input','-','--data-dir',f.dataRoot,'--json'],{cwd:f.project,input:JSON.stringify(input),encoding:'utf8'});expect(child.status,child.stdout+child.stderr).toBe(0);return JSON.parse(child.stdout).data;};
 const piSession=()=>{let command:Parameters<ExtensionAPI['registerCommand']>[1];let message:{content:string|{text:string}[]};const events=new Map<string,Function>();const pi={registerTool:vi.fn(),registerFlag:vi.fn(),getFlag:()=>undefined,registerCommand:(_n:string,c:typeof command)=>{command=c;},sendMessage:(m:typeof message)=>{message=m;},on:(name:string,handler:Function)=>events.set(name,handler)} as unknown as ExtensionAPI;createBacklogExtension(pi,{env:{PI_BACKLOG_DIR:f.dataRoot}});instances.push(()=>events.get('session_shutdown')?.());const context={cwd:f.project,sessionManager:{getSessionId:()=> 'smoke'}} as ExtensionContext;return async(args:string)=>{await command.handler(args+' --json',context);const text=typeof message.content==='string'?message.content:message.content[0].text;const result=JSON.parse(text);expect(result.ok,text).toBe(true);return result.data;};};
 try{
  const command=piSession(),project=await command('project register . --name Smoke');const graph=defaultWorkflow('task');graph.stages.find(s=>s.id==='verifying')!.next=['review','blocked','canceled'];graph.stages.push({id:'review',name:'Review',category:'active',next:['done']});cli('workflow.publish',{kind:'task',expectedWorkflowVersion:1,definition:graph});
  await command('item add --kind request --title Parent');await command('item add --kind task --title Child');
  let parent=cli('item.update',{itemId:'B-1',expectedRevision:1,description:'Request scope',criteria:['Accepted']});let child=cli('item.update',{itemId:'B-2',expectedRevision:1,description:'Task scope',criteria:['Verified'],parent:{projectId:project.id,itemId:'B-1'}});
  const fresh=piSession();expect((await fresh('item show B-2')).revision).toBe(child.revision);
  parent=cli('authorization.approve',{itemId:'B-1',expectedRevision:parent.revision,rationale:'Reviewed'});for(const stage of ['shaping','ready'])parent=cli('item.transition',{itemId:'B-1',expectedRevision:parent.revision,stage});
  child=cli('item.transition',{itemId:'B-2',expectedRevision:child.revision,stage:'ready'});const claim=cli('claim.acquire',{itemId:'B-2',expectedRevision:child.revision,expectedParentScopeRevision:parent.scopeRevision,worker:'smoke'});child.revision=claim.revision;const proof={leaseId:claim.leaseId,generation:claim.generation,token:claim.token};
  for(const stage of ['implementing','verifying','review','done'])child=cli('item.transition',{itemId:'B-2',expectedRevision:child.revision,stage,proof,...(stage==='done'?{completion:{summary:'Finished',verification:'Scenario assertions',evidence:[{label:'Test',reference:'docs.test.ts'}]}}:{})});
  expect((await fresh('item show B-2')).stage).toBe('done');expect(cli('item.show',{itemId:'B-1'}).stage).toBe('ready');
 }finally{instances.forEach(close=>close());f.close();}
});
it('documents the discoverable skill, automation boundaries and operational contracts',()=>{
 const skill=readFileSync('skills/backlog/SKILL.md','utf8'),guide=readFileSync('docs/backlog.md','utf8');expect(skill).toMatch(/^---\nname: backlog\ndescription: .+/);expect(skill).toContain('../../docs/backlog.md');
 for(const tool of ['backlog_read','backlog_item','backlog_authorize','backlog_claim'])expect(skill).toContain(tool);
 for(const text of ['300','30','3600','one third','PI_BACKLOG_DIR','PI_CODING_AGENT_DIR','--data-dir','--backlog-data-dir','createBacklogService','expectedParentScopeRevision','apiVersion','local','project policy','workflow publish','item read-text'])expect(guide).toContain(text);
 expect(readFileSync('README.md','utf8')).toContain('docs/backlog.md');
});
