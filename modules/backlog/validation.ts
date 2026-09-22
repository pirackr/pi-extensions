import { BacklogError } from './errors.ts';
import { Type, type TSchema } from 'typebox';
import { Check } from 'typebox/value';
import type { OperationMap } from './types.ts';
const string=Type.String(),integer=Type.Integer({minimum:1,maximum:Number.MAX_SAFE_INTEGER}),optional=Type.Optional;
const object=(properties:Record<string,TSchema>)=>Type.Object(properties,{additionalProperties:false});
const choices=(values:string[])=>Type.Union(values.map(v=>Type.Literal(v)));
const kind=choices(['request','task']),priority=choices(['urgent','high','normal','low']);
const proof=object({leaseId:string,generation:integer,token:string});
const ref=object({projectId:string,itemId:string});
const artifacts=Type.Array(object({label:string,reference:string}),{maxItems:100});
const completion=object({summary:string,verification:string,evidence:artifacts});
const mutation={mutationId:optional(string)},revision={itemId:string,expectedRevision:integer,...mutation};
const page={limit:optional(Type.Integer({minimum:1,maximum:200})),cursor:optional(Type.String({maxLength:4096}))};
const fields={title:optional(string),description:optional(string),criteria:optional(Type.Array(string,{maxItems:100})),priority:optional(priority)};
const auth=object({...revision,rationale:string}),dependency=object({...revision,prerequisite:ref}),records=object({...page,itemId:optional(string)});
export const operationSchemas:Record<keyof OperationMap,ReturnType<typeof Type.Object>>={
 'project.register':object({directory:string,name:string,...mutation}),'project.list':object(page),'project.show':object({}),
 'project.rename':object({name:string,expectedRegistryRevision:integer,...mutation}),'project.relocate':object({directory:string,expectedRegistryRevision:integer,...mutation}),
 'project.policy':object({policy:Type.Union([choices(['approval_required','autonomous']),Type.Null()]),expectedPolicyVersion:integer,itemId:optional(string),expectedRevision:optional(integer),...mutation}),
 'item.add':object({...fields,kind,title:string,...mutation}),'item.update':object({...fields,...revision,parent:optional(Type.Union([ref,Type.Null()]))}),
 'item.transition':object({...revision,stage:string,reason:optional(string),proof:optional(proof),completion:optional(completion)}),
 'item.list':object({...page,kind:optional(kind),priority:optional(priority),category:optional(choices(['draft','ready','active','blocked','done','canceled'])),stage:optional(string),parent:optional(string),eligible:optional(Type.Boolean()),text:optional(string)}),
 'item.show':object({...page,itemId:string,section:optional(choices(['criteria','dependencies']))}),
 'item.read-text':object({itemId:string,field:choices(['title','description','criterion','note','artifact','result']),recordId:optional(string),revision:optional(integer),cursor:optional(string)}),
 'dependency.add':dependency,'dependency.remove':dependency,'authorization.approve':auth,'authorization.authorize':auth,'authorization.revoke':auth,
 'note.append':object({...revision,text:string}),'artifact.attach':object({...revision,artifacts}),'result.append':object({...revision,result:completion,proof:optional(proof)}),
 'note.list':records,'artifact.list':records,'result.list':records,'history.list':records,'backlog.summary':object({}),
 'claim.acquire':object({...revision,worker:string,durationSeconds:optional(Type.Integer({minimum:30,maximum:3600})),expectedParentScopeRevision:optional(integer)}),
 'claim.renew':object({itemId:string,proof,...mutation}),'claim.release':object({...revision,proof}),'claim.recover':object({...revision,leaseId:string,generation:integer,reason:string}),
 'workflow.show':object({...page,kind,version:optional(integer)}),
 'workflow.publish':object({kind,expectedWorkflowVersion:integer,definition:object({initial:string,stages:Type.Array(object({id:string,name:string,category:choices(['draft','ready','active','blocked','done','canceled']),next:Type.Array(string,{maxItems:200})}),{maxItems:200})}),...mutation}),
};
export function validateOperationInput(operation:keyof OperationMap,input:unknown):void {
 if(!Object.hasOwn(operationSchemas,operation)||!Check(operationSchemas[operation],input))fail('operation input');
 const value=input as Record<string,unknown>;
 for(const field of ['kind','priority','title','description','criteria','artifacts','itemId','mutationId','worker','name','directory','rationale','reason','text'] as const){
  if(value[field]!==undefined)validate(({mutationId:'label',worker:'label',name:'label',directory:'reference',rationale:'note',reason:'note',text:'note'} as Record<string,Field>)[field]??field as Field,value[field]);
 }
 if(value.proof!==undefined)validateProof(value.proof);if(value.completion!==undefined)validateCompletion(value.completion);if(value.result!==undefined)validateCompletion(value.result);
 if(operation==='project.policy'&&value.itemId!==undefined)validate('revision',value.expectedRevision);
}

export type Field = 'kind' | 'priority' | 'revision' | 'title' | 'label' | 'criterion' | 'reference' | 'description' | 'note' | 'result' | 'criteria' | 'artifacts' | 'update' | 'projectId' | 'itemId';
function fail(field: string): never { throw new BacklogError('VALIDATION_ERROR', `Invalid ${field}`); }
export function strictObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail('object fields');
  return value as Record<string, unknown>;
}
export function validateProof(value:unknown):void {
 const p=strictObject(value,['leaseId','generation','token']);validate('label',p.leaseId);validate('revision',p.generation);validate('reference',p.token);
}
export function validateCompletion(value:unknown):void {
 const r=strictObject(value,['summary','verification','evidence']);
 for(const key of ['summary','verification']){validate('result',r[key]);if(!(r[key] as string).trim())fail(key);}
 validate('artifacts',r.evidence);if(!(r.evidence as unknown[]).length)fail('evidence');
}
export function validate(field: Field, value: unknown): unknown {
  if (field === 'kind' || field === 'priority') {
    const allowed = field === 'kind' ? ['request', 'task'] : ['urgent', 'high', 'normal', 'low'];
    if (typeof value !== 'string' || !allowed.includes(value)) fail(field);
  } else if (field === 'revision') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(field);
  } else if (field === 'criteria' || field === 'artifacts') {
    if (!Array.isArray(value) || value.length > 100) fail(field);
    for (const entry of value) {
      if (field === 'criteria') validate('criterion', entry);
      else { const record = strictObject(entry, ['label', 'reference']); validate('label', record.label); validate('reference', record.reference); }
    }
  } else if (field === 'update') {
    const input = strictObject(value, ['expectedRevision', 'title', 'description', 'criteria', 'priority']);
    validate('revision', input.expectedRevision);
    for (const key of ['title', 'description', 'criteria', 'priority'] as const) if (Object.hasOwn(input, key)) validate(key, input[key]);
  } else {
    if (typeof value !== 'string') fail(field);
    if (field === 'projectId') { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail(field); }
    else if (field === 'itemId') { if (!/^B-[1-9][0-9]*$/.test(value)) fail(field); }
    else if (['description', 'note', 'result'].includes(field)) { if (Buffer.byteLength(value, 'utf8') > 65536) fail(field); }
    else if (!value.trim() || [...value].length > (field === 'title' || field === 'label' ? 240 : 4096)) fail(field);
  }
  return value;
}
