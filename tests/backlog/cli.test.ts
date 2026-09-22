import { afterEach, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
const roots:string[]=[];afterEach(()=>roots.splice(0).forEach(root=>rmSync(root,{recursive:true,force:true})));
const bin=resolve('bin/pi-backlog.mjs');
function fixture(){const root=mkdtempSync(join(tmpdir(),'backlog-cli-'));roots.push(root);const cwd=join(root,'project');mkdirSync(cwd);return {root,cwd,run:(args:string[],input?:string)=>{const r=spawnSync(process.execPath,[bin,...args,'--json','--data-dir',join(root,'data')],{cwd,input,encoding:'utf8'});return {status:r.status,stderr:r.stderr,raw:r.stdout,envelope:JSON.parse(r.stdout)};}};}
it('executes fresh processes, file/stdin JSON and revisions with exactly one envelope',()=>{
 const f=fixture();expect(f.run(['project','register','.','--name','App']).status).toBe(0);
 const created=f.run(['item','add','--input','-'],JSON.stringify({kind:'task',title:'A',description:'Scope'}));expect(created.envelope).toMatchObject({apiVersion:1,ok:true,data:{id:'B-1'}});
 writeFileSync(join(f.cwd,'payload.json'),JSON.stringify({title:'Updated'}));expect(f.run(['item','update','B-1','--expected-revision','1','--input','payload.json']).status).toBe(0);
 expect(f.run(['item','show','B-1']).envelope.data.title).toBe('Updated');expect(f.run(['item','update','B-1','--expected-revision','1','--title','Stale']).status).toBe(3);
});
it('frames validation, missing input, domain and storage errors without noisy stdout',()=>{
 const f=fixture();expect(f.run(['item','show','B-1']).status).toBe(3);expect(f.run(['item','add','--input','-'],'{bad').status).toBe(2);expect(f.run(['item','add','--input','missing.json']).status).toBe(2);
 mkdirSync(join(f.root,'data'));writeFileSync(join(f.root,'data','registry.sqlite'),'bad sqlite');const error=f.run(['project','show']);expect(error.status).toBe(1);expect(error.envelope).toMatchObject({apiVersion:1,ok:false});expect(error.raw.trim().split('\n')).toHaveLength(1);
});
it('frames even bootstrap import errors',()=>{
 const f=fixture();const isolated=join(f.root,'standalone.mjs');copyFileSync(bin,isolated);const child=spawnSync(process.execPath,[isolated,'--json'],{encoding:'utf8'});expect(child.status).toBe(1);expect(JSON.parse(child.stdout)).toMatchObject({apiVersion:1,ok:false,error:{code:'STORE_ERROR'}});
});
