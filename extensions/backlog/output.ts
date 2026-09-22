import { BacklogError } from '../../modules/backlog/errors.ts';
export function safeDisplay(text:string):string {return text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));}
export function fitsToolResult(result:unknown):boolean {
 const serialized=JSON.stringify(result),display=safeDisplay(serialized);
 return Buffer.byteLength(serialized)<=51200&&Buffer.byteLength(display)<=51200&&display.split('\n').length<=2000;
}
export function formatToolResult(result:unknown) {
 if(!fitsToolResult(result))throw new BacklogError('STORE_ERROR','Result exceeds tool budget; use a smaller page or text continuation');
 return {content:[{type:'text' as const,text:safeDisplay(JSON.stringify(result))}],details:result};
}
