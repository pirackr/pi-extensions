import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { prepareStorePaths, resolveDataRoot, assertContained } from '../../modules/backlog/paths.ts';
import { fixture } from './helpers.ts';
const roots: ReturnType<typeof fixture>[] = [];
afterEach(() => roots.splice(0).forEach(f => f.close()));
function setup() { const f = fixture(); roots.push(f); return f; }
describe('backlog paths', () => {
  it.each([
    [{dataDir:'explicit', env:{PI_BACKLOG_DIR:'env'}, agentDir:'/agent'}, '/cwd/explicit'],
    [{env:{PI_BACKLOG_DIR:'env'}, agentDir:'/agent'}, '/cwd/env'],
    [{agentDir:'/agent', env:{PI_CODING_AGENT_DIR:'/cli'}}, '/agent/backlog'],
    [{env:{PI_CODING_AGENT_DIR:'/cli'}}, '/cli/backlog'],
    [{env:{}}, '/home/test/.pi/agent/backlog'],
  ])('resolves precedence without creating directories', (options, expected) => {
    expect(resolveDataRoot({cwd:'/cwd', home:'/home/test', ...options})).toBe(expected);
  });
  it('resolution does not initialize a store', () => { const f=setup(); expect(resolveDataRoot({cwd:f.directory,dataDir:'data'})).toBe(f.dataRoot); expect(existsSync(f.dataRoot)).toBe(false); });
  it('creates private directories and derives only UUID paths', () => {
    const f=setup(); const old=process.umask(0);
    try {
      const paths=prepareStorePaths(f.dataRoot);
      expect(statSync(f.dataRoot).mode & 0o777).toBe(0o700);
      expect(paths.registry).toBe(join(f.dataRoot,'registry.sqlite'));
      expect(paths.project('00000000-0000-4000-8000-000000000001')).toBe(join(f.dataRoot,'projects','00000000-0000-4000-8000-000000000001','backlog.sqlite'));
      expect(() => paths.project('../../escape')).toThrow();
    } finally { process.umask(old); }
  });
  it('rejects symlink components without touching targets', () => {
    const f=setup(); const outside=join(f.directory,'outside'); mkdirSync(outside); symlinkSync(outside,f.dataRoot);
    expect(() => prepareStorePaths(f.dataRoot)).toThrow(); expect(statSync(outside).mode & 0o777).not.toBe(0o700);
  });
  it('checks component boundaries, not string prefixes', () => { expect(() => assertContained('/data','/database/file')).toThrow(); expect(() => assertContained('/data','/data/inside')).not.toThrow(); });
});
