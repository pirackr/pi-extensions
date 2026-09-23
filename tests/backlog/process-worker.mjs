import { createJiti } from 'jiti';
import { randomUUID } from 'node:crypto';
import { readSync } from 'node:fs';
import { createRequire } from 'node:module';
const {DatabaseSync}=createRequire(import.meta.url)('node:sqlite');
const jiti=createJiti(import.meta.url);
const {createBacklogService}=await jiti.import('../../modules/backlog/service.ts');
const {openStore}=await jiti.import('../../modules/backlog/store.ts');
process.once('message',async spec=>{
 let service,db;
 try{
  if(spec.mode==='hold'||spec.mode==='crash-write'){
   db=openStore(spec.path,spec.kind??'project','open-existing');db.exec('BEGIN IMMEDIATE');if(spec.sql)db.exec(spec.sql);process.send({ready:true});await new Promise(resolve=>process.once('message',resolve));db.exec('ROLLBACK');return;
  }
  service=createBacklogService({dataRoot:spec.dataRoot,now:spec.now===undefined?undefined:()=>spec.now,uuid:()=>{if(spec.publicationBarrier){process.send({ready:true});readSync(0,Buffer.alloc(1));}return randomUUID();}});
  if(!spec.publicationBarrier){process.send({ready:true});await new Promise(resolve=>process.once('message',resolve));}
  if(spec.pauseCommit){let intercepted=false;const exec=DatabaseSync.prototype.exec;DatabaseSync.prototype.exec=function(sql){const pause=sql==='COMMIT'&&!intercepted;if(pause)intercepted=true;if(pause&&spec.pauseCommit==='before'){process.send({paused:true});readSync(0,Buffer.alloc(1));}const value=exec.call(this,sql);if(pause&&spec.pauseCommit==='after'){process.send({paused:true});readSync(0,Buffer.alloc(1));}return value;};}
  const data=service.execute(spec.context,spec.operation,spec.input);process.send({ok:true,data});
 }catch(error){process.send({ok:false,code:error.code??'RUNTIME',message:error.message});}
 finally{db?.close();service?.close();process.disconnect();}
});
