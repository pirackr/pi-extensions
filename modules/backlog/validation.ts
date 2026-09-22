import { BacklogError } from './errors.ts';
export type Field = 'kind' | 'priority' | 'revision' | 'title' | 'label' | 'criterion' | 'reference' | 'description' | 'note' | 'result' | 'criteria' | 'artifacts' | 'update' | 'projectId' | 'itemId';
function fail(field: string): never { throw new BacklogError('VALIDATION_ERROR', `Invalid ${field}`); }
export function strictObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail('object fields');
  return value as Record<string, unknown>;
}
export function validate(field: Field, value: unknown): unknown {
  if (field === 'kind' || field === 'priority') {
    const allowed = field === 'kind' ? ['request', 'task'] : ['urgent', 'high', 'normal', 'low'];
    if (typeof value !== 'string' || !allowed.includes(value)) fail(field);
  } else if (field === 'revision') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) fail(field);
  } else if (field === 'criteria' || field === 'artifacts') {
    if (!Array.isArray(value) || value.length > 100) fail(field);
    for (const entry of value) {
      if (field === 'criteria') validate('criterion', entry);
      else { const record = strictObject(entry, ['label', 'reference']); validate('label', record.label); validate('reference', record.reference); }
    }
  } else if (field === 'update') {
    const input = strictObject(value, ['expectedRevision', 'title', 'description', 'criteria', 'priority']);
    validate('revision', input.expectedRevision);
    for (const key of ['title', 'description', 'criteria', 'priority'] as const) if (Object.hasOwn(input, key)) validate(key, input[key]);
  } else {
    if (typeof value !== 'string') fail(field);
    if (field === 'projectId') { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) fail(field); }
    else if (field === 'itemId') { if (!/^B-[1-9][0-9]*$/.test(value)) fail(field); }
    else if (['description', 'note', 'result'].includes(field)) { if (Buffer.byteLength(value, 'utf8') > 65536) fail(field); }
    else if (!value.trim() || [...value].length > (field === 'title' || field === 'label' ? 240 : 4096)) fail(field);
  }
  return value;
}
