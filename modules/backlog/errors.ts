export const errorCodes = ['PROJECT_NOT_FOUND', 'PROJECT_UNREGISTERED', 'DIRECTORY_UNAVAILABLE', 'VALIDATION_ERROR', 'INVALID_TRANSITION', 'DEPENDENCY_CYCLE', 'REVISION_CONFLICT', 'AUTHORIZATION_REQUIRED', 'CLAIM_CONFLICT', 'LEASE_EXPIRED', 'RECOVERY_REQUIRED', 'MUTATION_ID_CONFLICT', 'STORE_BUSY', 'STORE_CORRUPT', 'SCHEMA_UNSUPPORTED', 'STORE_ERROR'] as const;
export type ErrorCode = typeof errorCodes[number];
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
function redact(value: Json): Json {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, /token|credential|password|secret/i.test(key) ? '[REDACTED]' : redact(item)]));
  return value;
}
export class BacklogError extends Error {
  readonly details: Json;
  constructor(readonly code: ErrorCode, message: string, details: Json = {}) {
    super(message); this.name = 'BacklogError'; this.details = redact(details);
  }
}
export function exitCode(code: ErrorCode): number {
  if (code === 'VALIDATION_ERROR') return 2;
  return ['STORE_BUSY', 'STORE_CORRUPT', 'SCHEMA_UNSUPPORTED', 'STORE_ERROR'].includes(code) ? 1 : 3;
}
