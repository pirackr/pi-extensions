import { expect, it } from 'vitest';
import { serviceFixture } from './helpers.ts';
import { defaultWorkflow, validateWorkflow } from '../../modules/backlog/workflows.ts';
it.each(['request','task'] as const)('accepts the %s default with rework cycles',kind=>expect(validateWorkflow(defaultWorkflow(kind))).toEqual(defaultWorkflow(kind)));
it.each(['duplicate','dangling','terminal-edge','unreachable','missing-active','no-terminal-path','bypass-ready','bypass-active','hook'])('rejects %s',failure=>{
 const graph=defaultWorkflow('task');
 if(failure==='duplicate')graph.stages.push({...graph.stages[0]});
 if(failure==='dangling')graph.stages[0].next.push('missing');
 if(failure==='terminal-edge')graph.stages.find(s=>s.id==='done')!.next.push('draft');
 if(failure==='unreachable')graph.stages.push({id:'unused',name:'Unused',category:'draft',next:['canceled']});
 if(failure==='missing-active')graph.stages.filter(s=>s.category==='active').forEach(s=>s.category='draft');
 if(failure==='no-terminal-path')graph.stages.find(s=>s.id==='blocked')!.next=['blocked'];
 if(failure==='bypass-ready')graph.stages[0].next.push('implementing');
 if(failure==='bypass-active')graph.stages.find(s=>s.id==='ready')!.next.push('done');
 if(failure==='hook')Object.assign(graph.stages[0],{hook:'exec'});
 expect(()=>validateWorkflow(graph)).toThrow();
});
it('publishes new immutable defaults without migrating old items or approvals',()=>{
 const f=serviceFixture();try {
  f.service.execute(f.context,'item.add',{kind:'task',title:'Old',description:'Scope',criteria:['Done']});f.service.execute(f.context,'authorization.approve',{itemId:'B-1',expectedRevision:1,rationale:'Reviewed'});f.service.execute(f.context,'item.transition',{itemId:'B-1',expectedRevision:2,stage:'ready'});const claim=f.service.execute(f.context,'claim.acquire',{itemId:'B-1',expectedRevision:3,worker:'w'});
  const definition=defaultWorkflow('task');definition.stages.find(s=>s.id==='verifying')!.next=['review','blocked','canceled'];definition.stages.push({id:'review',name:'Review',category:'active',next:['done']});
  const published=f.service.execute(f.context,'workflow.publish',{kind:'task',expectedWorkflowVersion:1,definition});expect(published.version).toBe(2);
  expect(f.service.execute(f.context,'item.add',{kind:'task',title:'New'}).workflowVersion).toBe(2);expect(f.service.execute(f.context,'item.show',{itemId:'B-1'}).workflowVersion).toBe(1);
  expect(f.service.execute(f.context,'workflow.show',{kind:'task',version:1}).definition.stages.some(s=>s.id==='review')).toBe(false);
  expect(()=>f.service.execute(f.context,'workflow.publish',{kind:'task',expectedWorkflowVersion:1,definition})).toThrow();
  expect(()=>f.service.execute({...f.context,actor:{...f.context.actor,role:'automation'}},'workflow.publish',{kind:'task',expectedWorkflowVersion:2,definition})).toThrow();
  expect(f.service.execute(f.context,'claim.renew',{itemId:'B-1',proof:{leaseId:claim.leaseId,generation:claim.generation,token:claim.token}})).toHaveProperty('expiresAt');
 }finally{f.close();}
});
it('supports custom testing/review names without changing active meaning',()=>{
 const graph=defaultWorkflow('task');
 graph.stages.find(s=>s.id==='verifying')!.next=['review','blocked','canceled'];
 graph.stages.push({id:'review',name:'Human review',category:'active',next:['done','implementing']});
 expect(validateWorkflow(graph).stages.find(s=>s.id==='review')!.category).toBe('active');
});
