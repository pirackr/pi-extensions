import { BacklogError } from './errors.ts';
import { operationSchemas, strictObject, validate, validateOperationInput } from './validation.ts';
import type { OperationMap } from './types.ts';
export interface ParsedCommand {operation:keyof OperationMap;input:OperationMap[keyof OperationMap]['input'];projectId?:string;dataDir?:string;inputFile?:string;actor?:string;json:boolean}
function invalid():never {throw new BacklogError('VALIDATION_ERROR','Invalid command, flag, or payload conflict');}
/** Quoting only: never shell expansion, execution, or environment substitution. */
export function tokenize(source:string):string[] {
 const tokens:string[]=[];let token='',quote='',started=false;
 for(let i=0;i<source.length;i++){
  const char=source[i];
  if(char==='\\'&&quote!=="'"){if(++i===source.length)invalid();token+=source[i];started=true;}
  else if(quote){if(char===quote)quote='';else token+=char;}
  else if(char==='"'||char==="'"){quote=char;started=true;}
  else if(/\s/.test(char)){if(started){tokens.push(token);token='';started=false;}}
  else {token+=char;started=true;}
 }
 if(quote)invalid();if(started)tokens.push(token);return tokens;
}
export function parseCommand(argv:string[],payload?:unknown):ParsedCommand {
 const flags:Record<string,string|boolean>={},positionals:string[]=[];
 for(let i=0;i<argv.length;i++){
  const arg=argv[i];if(!arg.startsWith('--')){positionals.push(arg);continue;}
  if(!/^--[a-z][a-z-]*$/.test(arg))invalid();const key=arg.slice(2).replace(/-([a-z])/g,(_,c:string)=>c.toUpperCase());
  if(Object.hasOwn(flags,key))invalid();
  if(key==='json'){flags[key]=true;continue;}
  if(key==='eligible'&&!['true','false'].includes(argv[i+1])){flags[key]=true;continue;}
  if(i+1>=argv.length||argv[i+1].startsWith('--'))invalid();flags[key]=argv[++i];
 }
 const operation=(positionals.length?positionals.splice(0,2).join('.'):'backlog.summary') as keyof OperationMap;
 if(!Object.hasOwn(operationSchemas,operation))invalid();
 const input:Record<string,unknown>=payload===undefined?{}:{...strictObject(payload,Object.keys(operationSchemas[operation].properties))};
 function set(key:string,value:unknown){if(Object.hasOwn(input,key))invalid();input[key]=value;}
 if(positionals.length){if(positionals.length!==1)invalid();set(operation==='project.register'?'directory':'itemId',positionals[0]);}
 const result:ParsedCommand={operation,input,json:flags.json===true};delete flags.json;
 for(const [flag,property] of [['project','projectId'],['dataDir','dataDir'],['input','inputFile'],['actor','actor']] as const){if(flags[flag]!==undefined){result[property]=String(flags[flag]);delete flags[flag];}}
 if(result.actor!==undefined)validate('label',result.actor);
 if(result.projectId!==undefined)validate('projectId',result.projectId);
 const credentials:Record<string,unknown>={};
 for(const [raw,value] of Object.entries(flags)){
  const key=raw==='item'?'itemId':raw;
  const credential=['leaseId','generation','token'].includes(key)&&operation!=='claim.recover';
  if(!credential&&!Object.hasOwn(operationSchemas[operation].properties,key))invalid();
  let parsed:unknown=value;
  if(/^(expected.*|revision|generation|durationSeconds|version|limit)$/.test(key)){if(typeof value!=='string'||!/^\d+$/.test(value))invalid();parsed=Number(value);}
  else if(key==='eligible')parsed=value===true||value==='true';
  else if(['criteria','artifacts','result','completion','definition','proof','prerequisite'].includes(key)||(key==='parent'&&operation==='item.update')||(key==='policy'&&value==='null')){try{parsed=JSON.parse(String(value));}catch{invalid();}}
  if(credential)credentials[key]=parsed;else set(key,parsed);
 }
 if(Object.keys(credentials).length)set('proof',credentials);
 validateOperationInput(operation,input);return result;
}
