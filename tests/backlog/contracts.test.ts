import { describe, expect, it } from 'vitest';
import { validate } from '../../modules/backlog/validation.ts';
import { BacklogError } from '../../modules/backlog/errors.ts';

describe('backlog contracts', () => {
  it.each(['request', 'task'])('accepts kind %s', value => expect(validate('kind', value)).toBe(value));
  it.each(['epic', '', null])('rejects invalid kind %s', value => expect(() => validate('kind', value)).toThrow());
  it.each(['urgent', 'high', 'normal', 'low'])('accepts priority %s', value => expect(validate('priority', value)).toBe(value));
  it.each(['critical', 1, null])('rejects priority %s', value => expect(() => validate('priority', value)).toThrow());
  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', Infinity])('rejects revision %s', value => expect(() => validate('revision', value)).toThrow());
  it('accepts safe positive revisions', () => expect(validate('revision', Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER));
  it.each([['title', 240], ['label', 240], ['criterion', 4096], ['reference', 4096]] as const)('%s counts Unicode characters', (field, size) => {
    expect(validate(field, '😀'.repeat(size))).toBe('😀'.repeat(size));
    expect(() => validate(field, '😀'.repeat(size + 1))).toThrow();
    expect(() => validate(field, '   ')).toThrow();
  });
  it.each(['description', 'note', 'result'] as const)('%s bounds UTF-8 bytes', field => {
    expect(validate(field, '😀'.repeat(16384))).toBe('😀'.repeat(16384));
    expect(() => validate(field, '😀'.repeat(16384) + 'x')).toThrow();
  });
  it('bounds criteria and artifact arrays', () => {
    expect(validate('criteria', Array(100).fill('ok'))).toHaveLength(100);
    expect(() => validate('criteria', Array(101).fill('ok'))).toThrow();
    expect(validate('artifacts', Array(100).fill({label:'x', reference:'file'}))).toHaveLength(100);
    expect(() => validate('artifacts', Array(101).fill({label:'x', reference:'file'}))).toThrow();
    expect(() => validate('artifacts', [{label:'x', reference:'file', execute:true}])).toThrow();
  });
  it.each(['stage', 'workflowVersion', 'revision', 'scopeRevision', 'authorization', 'token', 'kind', 'policy', 'unknown'])('rejects protected update %s', field => {
    expect(() => validate('update', {expectedRevision:1, [field]:'x'})).toThrow();
  });
  it('accepts draft scope updates', () => expect(validate('update', {expectedRevision:1, title:'Draft', description:'', criteria:[]})).toEqual({expectedRevision:1, title:'Draft', description:'', criteria:[]}));
  it('redacts nested ownership credentials in errors', () => {
    const error = new BacklogError('CLAIM_CONFLICT', 'Ownership mismatch', {proof:{token:'secret'}, credentials:'secret'});
    expect(JSON.stringify(error.details)).not.toContain('secret');
  });
});
