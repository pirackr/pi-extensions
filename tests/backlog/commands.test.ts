import { expect, it } from 'vitest';
import { operationSchemas } from '../../modules/backlog/validation.ts';
import { defaultWorkflow } from '../../modules/backlog/workflows.ts';
import { parseCommand, tokenize } from '../../modules/backlog/commands.ts';
it.each(Object.keys(operationSchemas))('maps human operation %s through the shared contract',operation=>{
 const samples:Record<string,unknown>={directory:'.',name:'Project',kind:'task',title:'Title',itemId:'B-1',stage:'ready',worker:'w',policy:'autonomous',expectedRevision:1,expectedRegistryRevision:1,expectedPolicyVersion:1,expectedWorkflowVersion:1,leaseId:'lease',generation:1,reason:'Reason',rationale:'Reviewed',text:'Note',field:'description',proof:{leaseId:'lease',generation:1,token:'secret'},prerequisite:{projectId:'11111111-1111-1111-1111-111111111111',itemId:'B-2'},artifacts:[{label:'Evidence',reference:'file'}],result:{summary:'Done',verification:'Checked',evidence:[{label:'Evidence',reference:'file'}]},definition:defaultWorkflow('task')};
 const schema=operationSchemas[operation as keyof typeof operationSchemas];const payload=Object.fromEntries((schema.required??[]).map(key=>[key,samples[key]]));expect(parseCommand(operation.split('.'),payload).operation).toBe(operation);
});
it('tokenizes quoting literally without shell evaluation',()=>{
 expect(tokenize('item add --kind task --title "A $HOME $(echo x)"')).toEqual(['item','add','--kind','task','--title','A $HOME $(echo x)']);expect(()=>tokenize('item add "unfinished')).toThrow();
 expect(parseCommand(tokenize('item add --kind task --title "A task" --json'))).toMatchObject({operation:'item.add',input:{kind:'task',title:'A task'},json:true});
});
it('validates operation inputs, revisions, duplicate and conflicting flags',()=>{
 expect(()=>parseCommand(['item','update','B-1','--title','No revision'])).toThrow();
 expect(()=>parseCommand(['item','add','--kind','task','--title','A','--title','B'])).toThrow();
 expect(()=>parseCommand(['item','add','--kind','task','--title','A','--unknown','x'])).toThrow();
 expect(()=>parseCommand(['item','add','--kind','task','--title','A'],{title:'B'})).toThrow();
 expect(()=>parseCommand(['item','update','B-1','--expected-revision','1.5'])).toThrow();
});
it('merges JSON, preserves selection and credentials, and maps bare summary',()=>{
 expect(parseCommand([]).operation).toBe('backlog.summary');
 expect(parseCommand(['project','register','/a path','--name','A']).input).toEqual({directory:'/a path',name:'A'});
 expect(parseCommand(['project','policy','--item','B-1','--policy','autonomous','--expected-revision','2','--expected-policy-version','1']).input).toMatchObject({itemId:'B-1',expectedRevision:2});
 expect(parseCommand(['claim','renew','B-1','--lease-id','lease','--generation','2','--token','private']).input).toEqual({itemId:'B-1',proof:{leaseId:'lease',generation:2,token:'private'}});
 expect(parseCommand(['item','update','B-1','--expected-revision','1','--input','payload.json','--data-dir','/store'],{description:'Scope',criteria:['Done']})).toMatchObject({dataDir:'/store',input:{itemId:'B-1',expectedRevision:1,description:'Scope'}});
});
