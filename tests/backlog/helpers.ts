import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBacklogService } from '../../modules/backlog/service.ts';
import { openStore } from '../../modules/backlog/store.ts';
import type { OperationContext } from '../../modules/backlog/types.ts';
export function snapshotManifest(root:string,prefix=''):Record<string,string> {
 const manifest:Record<string,string>={};for(const entry of readdirSync(join(root,prefix),{withFileTypes:true})){const name=join(prefix,entry.name);if(entry.isDirectory())Object.assign(manifest,snapshotManifest(root,name));else if(entry.isFile())manifest[name]=createHash('sha256').update(readFileSync(join(root,name))).digest('hex');else throw Error('Snapshot must contain regular files only');}return manifest;
}
export function validateSnapshot(root:string,manifest:Record<string,string>):void {
 const actual=snapshotManifest(root);if(JSON.stringify(Object.entries(actual).sort())!==JSON.stringify(Object.entries(manifest).sort()))throw Error('Incomplete or mixed snapshot');
 const check=(path:string)=>{const db=new DatabaseSync(path,{readOnly:true});try{if(db.prepare('PRAGMA integrity_check').all().some(r=>r.integrity_check!=='ok')||db.prepare('PRAGMA foreign_key_check').all().length)throw Error('Invalid snapshot database');return db;}catch(error){db.close();throw error;}};
 const registry=check(join(root,'registry.sqlite'));try{for(const row of registry.prepare('SELECT id FROM projects').all()){const db=check(join(root,'projects',String(row.id),'backlog.sqlite'));try{if(db.prepare("SELECT value FROM metadata WHERE key='projectId'").get()?.value!==row.id)throw Error('Snapshot identity mismatch');}finally{db.close();}}}finally{registry.close();}
}
export function serviceFixture() {
  const f=fixture();const service=createBacklogService(f);
  const project=service.execute(f.context,'project.register',{directory:f.project,name:'Test'});
  const db=openStore(join(f.dataRoot,'projects',project.id,'backlog.sqlite'),'project','open-existing');
  return {...f,service,projectRecord:project,db,close:()=>{db.close();service.close();f.close();}};
}
export function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'pi-backlog-test-'));
  const project = join(directory, 'project'); mkdirSync(project, {mode:0o700});
  let time = Date.UTC(2026, 0, 1); let sequence = 0;
  return { directory, project, dataRoot: join(directory, 'data'), now: () => time,
    advance: (milliseconds: number) => { time += milliseconds; },
    uuid: () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
    randomToken: () => (++sequence).toString(16).padStart(64, '0'),
    context: {cwd:project, actor:{id:'tester', channel:'library', role:'operator'}} as OperationContext,
    close: () => rmSync(directory, {recursive:true, force:true}) };
}
