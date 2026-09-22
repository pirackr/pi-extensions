import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OperationContext } from '../../modules/backlog/types.ts';
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
