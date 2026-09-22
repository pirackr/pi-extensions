import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { createBacklogService } from '../../modules/backlog/service.ts';
import { fixture } from './helpers.ts';
const cleanup: (()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(fn=>fn()));
function setup(){const f=fixture();cleanup.push(f.close);const service=createBacklogService(f);cleanup.push(()=>service.close());return {...f,service};}
it('unregistered reads create nothing',()=>{const f=setup();expect(()=>f.service.execute(f.context,'project.show',{})).toThrow();expect(existsSync(f.dataRoot)).toBe(false);});
it('registers non-Git directories, canonicalizes symlinks, and returns the original registration',()=>{
 const f=setup();const p=f.service.execute(f.context,'project.register',{directory:'.',name:'Original'});
 const alias=f.directory+'/alias';symlinkSync(f.project,alias);
 const again=f.service.execute(f.context,'project.register',{directory:alias,name:'Changed'});
 expect(again.id).toBe(p.id);expect(again.name).toBe('Original');expect(p.registryRevision).toBe(1);
 expect(f.service.execute(f.context,'project.list',{}).items).toHaveLength(1);
});
it('selects deepest ancestors without prefix or explicit-ID fallback',()=>{
 const f=setup();const nested=f.project+'/nested';mkdirSync(nested);mkdirSync(f.project+'-other');
 const parent=f.service.execute(f.context,'project.register',{directory:f.project,name:'Same'});
 const child=f.service.execute(f.context,'project.register',{directory:nested,name:'Same'});
 expect(f.service.execute({...f.context,cwd:nested},'project.show',{}).id).toBe(child.id);
 expect(f.service.execute({...f.context,projectId:parent.id,cwd:nested},'project.show',{}).id).toBe(parent.id);
 expect(()=>f.service.execute({...f.context,cwd:f.project+'-other'},'project.show',{})).toThrow();
 expect(()=>f.service.execute({...f.context,projectId:'00000000-0000-4000-8000-999999999999'},'project.show',{})).toThrow();
});
it('retains identity after a directory disappears and across reopen',()=>{
 const f=setup();const p=f.service.execute(f.context,'project.register',{directory:f.project,name:'Missing'});f.service.close();f.service.close();rmSync(f.project,{recursive:true});
 const next=createBacklogService(f);cleanup.push(()=>next.close());
 expect(next.execute({...f.context,projectId:p.id},'project.show',{})).toMatchObject({id:p.id,available:false});
});
it('revision-checks operator metadata changes and preserves project identity',()=>{
 const f=setup();const p=f.service.execute(f.context,'project.register',{directory:'.',name:'Before'});const ctx={...f.context,projectId:p.id};
 const renamed=f.service.execute(ctx,'project.rename',{name:'After',expectedRegistryRevision:1});
 expect(renamed).toMatchObject({id:p.id,name:'After',directory:f.project,registryRevision:2});
 expect(()=>f.service.execute(ctx,'project.rename',{name:'Stale',expectedRegistryRevision:1})).toThrow();
 const target=f.directory+'/relocated';mkdirSync(target);
 const moved=f.service.execute(ctx,'project.relocate',{directory:target,expectedRegistryRevision:2});
 expect(moved).toMatchObject({id:p.id,directory:target,registryRevision:3});expect(existsSync(f.project)).toBe(true);
 expect(()=>f.service.execute({...ctx,actor:{...ctx.actor,role:'automation'}},'project.rename',{name:'No',expectedRegistryRevision:3})).toThrow();
 expect(()=>f.service.execute(ctx,'project.relocate',{directory:f.directory+'/missing',expectedRegistryRevision:3})).toThrow();
 const other=f.service.execute(f.context,'project.register',{directory:f.project,name:'Other'});
 expect(()=>f.service.execute(ctx,'project.relocate',{directory:other.directory,expectedRegistryRevision:3})).toThrow();
 expect(f.service.execute(ctx,'project.show',{}).registryRevision).toBe(3);
});
it('rejects automation registration and unknown inputs',()=>{
 const f=setup();expect(()=>f.service.execute({...f.context,actor:{...f.context.actor,role:'automation'}},'project.register',{directory:'.',name:'No'})).toThrow();
 expect(()=>f.service.execute(f.context,'project.register',{directory:'.',name:'No',hook:'run'} as never)).toThrow();
 expect(existsSync(f.dataRoot)).toBe(false);
});
