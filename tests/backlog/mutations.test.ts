import { afterEach, expect, it } from 'vitest';
import { runMutation } from '../../modules/backlog/mutations.ts';
import { openStore, type StoreConnection } from '../../modules/backlog/store.ts';
import { fixture } from './helpers.ts';
const cleanup: (()=>void)[]=[];afterEach(()=>cleanup.splice(0).reverse().forEach(fn=>fn()));
function setup(){const f=fixture();cleanup.push(f.close);const db=openStore(f.dataRoot+'/registry.sqlite','registry','create-new');cleanup.push(()=>db.close());return {...f,db};}
function write(db:StoreConnection){db.prepare('INSERT INTO metadata VALUES (?,?)').run('state','done');return {receipt:{id:'B-1',token:'secret'},event:{ids:['B-1'],revision:2,changedFields:['state'],token:'secret'}};}
it('replays canonical payloads before reapplying stale mutations and keeps tokens out of events',()=>{
 const f=setup(); const input={mutationId:'retry',expectedRevision:1,proof:{token:'private',generation:1}};
 const original=runMutation(f.db,f.context,'test',input,()=>write(f.db),f.now);
 expect(original).toEqual({id:'B-1',token:'secret'});
 const replay=runMutation(f.db,f.context,'test',{proof:{generation:1,token:'private'},expectedRevision:1,mutationId:'retry'},()=>{throw Error('stale revision');},f.now);
 expect(replay).toEqual(original);
 expect(f.db.prepare('SELECT * FROM events').all()).toHaveLength(1);
 expect(JSON.stringify(f.db.prepare('SELECT * FROM events').all())).not.toContain('secret');
 expect(()=>runMutation(f.db,f.context,'test',{...input,expectedRevision:2},()=>write(f.db),f.now)).toThrow(/mutation/i);
});
it('rolls state, events and receipt back together',()=>{
 const f=setup();
 expect(()=>runMutation(f.db,f.context,'test',{mutationId:'retry'},()=>{write(f.db);throw Error('failed');},f.now)).toThrow('failed');
 expect(f.db.prepare("SELECT * FROM metadata WHERE key='state'").get()).toBeUndefined();
 expect(f.db.prepare('SELECT * FROM events').all()).toHaveLength(0);expect(f.db.prepare('SELECT * FROM receipts').all()).toHaveLength(0);
});
it('isolates receipt identity by actor/channel and database',()=>{
 const f=setup();const other=setup();let calls=0;
 for(const [db,context] of [[f.db,f.context],[f.db,{...f.context,actor:{...f.context.actor,id:'other'}}],[f.db,{...f.context,actor:{...f.context.actor,channel:'cli' as const}}],[other.db,other.context]] as const){
  runMutation(db,context,'test',{mutationId:'same'},()=>({receipt:++calls,event:{}}),f.now);
 }
 expect(calls).toBe(4);
});
