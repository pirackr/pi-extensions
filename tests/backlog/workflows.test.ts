import { expect, it } from 'vitest';
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
it('supports custom testing/review names without changing active meaning',()=>{
 const graph=defaultWorkflow('task');
 graph.stages.find(s=>s.id==='verifying')!.next=['review','blocked','canceled'];
 graph.stages.push({id:'review',name:'Human review',category:'active',next:['done','implementing']});
 expect(validateWorkflow(graph).stages.find(s=>s.id==='review')!.category).toBe('active');
});
