import { chmodSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { BacklogError } from './errors.ts';
import { validate } from './validation.ts';
export interface RootOptions { cwd: string; dataDir?: string; agentDir?: string; env?: Record<string,string|undefined>; home?: string }
export interface StorePaths { root: string; registry: string; project(id: string): string }
export function resolveDataRoot(options: RootOptions): string {
  const env=options.env ?? process.env;
  return resolve(options.cwd, options.dataDir ?? env.PI_BACKLOG_DIR ?? join(options.agentDir ?? env.PI_CODING_AGENT_DIR ?? join(options.home ?? homedir(),'.pi','agent'),'backlog'));
}
export function assertContained(root: string, target: string): void {
  const part=relative(resolve(root),resolve(target));
  if (part==='..' || part.startsWith(`..${sep}`) || isAbsolute(part)) throw new BacklogError('STORE_ERROR','Data path escapes selected root');
}
export function assertNoSymlinks(target: string): void {
  const absolute=resolve(target); let current=parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current=join(current,part);
    try { if (lstatSync(current).isSymbolicLink()) throw new BacklogError('STORE_ERROR','Symlink in data path'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error; }
  }
}
export function privateDirectory(target: string): void {
  assertNoSymlinks(target);
  mkdirSync(target,{recursive:true, mode:0o700}); chmodSync(target,0o700);
}
export function prepareStorePaths(dataRoot: string): StorePaths {
  const root=resolve(dataRoot); privateDirectory(root); privateDirectory(join(root,'projects'));
  return {root,registry:join(root,'registry.sqlite'),project(id) {
    validate('projectId',id);
    const target=join(root,'projects',id.toLowerCase(),'backlog.sqlite'); assertContained(root,target); assertNoSymlinks(target);
    return target;
  }};
}
export function guardDatabasePath(path: string, create: boolean): void {
  assertNoSymlinks(path);
  for (const suffix of ['-wal','-shm','-journal']) assertNoSymlinks(path+suffix);
  if (create) privateDirectory(dirname(path));
}
