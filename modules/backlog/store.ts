import { chmodSync, closeSync, existsSync, openSync, linkSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { BacklogError } from './errors.ts';
import { guardDatabasePath } from './paths.ts';
import { schema, type StoreKind } from './schema.ts';
export type StoreConnection = Database;
export function storageError(error: unknown): never {
  if(error instanceof BacklogError) throw error;
  const code=(error as {errcode?:number}).errcode;
  if(code===5 || code===6) throw new BacklogError('STORE_BUSY','Store is busy; retry later');
  if(code===11 || code===26) throw new BacklogError('STORE_CORRUPT','Invalid or corrupt backlog store');
  throw new BacklogError('STORE_ERROR','Unable to access backlog store');
}
function checkSchema(db: Database, kind: StoreKind, projectId?:string): void {
  const version=db.prepare('PRAGMA user_version').get() as {user_version:number};
  if(version.user_version!==1) throw new BacklogError('SCHEMA_UNSUPPORTED','Expected backlog schema version 1');
  const stored=db.prepare("SELECT value FROM metadata WHERE key='kind'").get();
  if(stored?.value!==kind) throw new BacklogError('STORE_CORRUPT','Store kind mismatch');
  if(projectId!==undefined&&db.prepare("SELECT value FROM metadata WHERE key='projectId'").get()?.value!==projectId)throw new BacklogError('STORE_CORRUPT','Project database UUID does not match its registry entry');
  const integrity=db.prepare('PRAGMA quick_check').all();
  if(integrity.some(row=>row.quick_check!=='ok')) throw new BacklogError('STORE_CORRUPT','Store integrity check failed');
  if(db.prepare('PRAGMA foreign_key_check').all().length) throw new BacklogError('STORE_CORRUPT','Store foreign-key check failed');
}
function privateFiles(path: string): void {
  for(const suffix of ['','-wal','-shm','-journal']) if(existsSync(path+suffix)) chmodSync(path+suffix,0o600);
}
export function openStore(path: string, kind: StoreKind, mode: 'create-new' | 'open-existing', projectId?:string): StoreConnection {
  let db: Database | undefined;
  try {
    guardDatabasePath(path,mode==='create-new');
    if(mode==='create-new') { const fd=openSync(path,'wx',0o600);closeSync(fd); }
    else {
      if(!existsSync(path)) throw new BacklogError('STORE_CORRUPT','Registered store is missing');
      // Validate before any writable setup; invalid stores must retain their bytes.
      const probe=new DatabaseSync(path,{readOnly:true});
      try { checkSchema(probe,kind,projectId); } finally {probe.close();}
    }
    db=new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout=1000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    if(mode==='create-new') withWriteTransaction(db,()=>{
      db!.exec(schema(kind));
      db!.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run('kind',kind);
      db!.exec('PRAGMA user_version=1');
    });
    privateFiles(path); return db;
  } catch(error) { db?.close(); return storageError(error); }
}
/** Publish only a closed, fully initialized registry. Never replace an existing file. */
export function initializeRegistry(path:string):void {
 guardDatabasePath(path,false);if(existsSync(path))return;
 const staging=path+'.initializing-'+randomUUID();const db=openStore(staging,'registry','create-new');
 try{db.close();try{linkSync(staging,path);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
 finally{unlinkSync(staging);}
}
export function withReadTransaction<T>(db:StoreConnection,read:()=>T):T {
 db.exec('BEGIN');try{const result=read();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}
}
export function withWriteTransaction<T>(db: StoreConnection, apply: ()=>T): T {
  let begun=false;
  try {db.exec('BEGIN IMMEDIATE');begun=true;const result=apply();db.exec('COMMIT');return result;}
  catch(error) {if(begun) db.exec('ROLLBACK');if((error as {errcode?:number}).errcode===5) return storageError(error);throw error;}
}
