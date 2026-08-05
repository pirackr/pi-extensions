import { describe, it, expect, vi } from 'vitest';
import type { SearchResult, SearchResponse, ExtractedContent, FetchResponse, SearchEngine, FetchStrategy } from '../extensions/web-search/types';

// Mock node:fs readFileSync to throw ENOENT so the real repo .env cannot
// make isAvailable() return true when process.env.EXA_API_KEY is deleted.
// This ensures the ExaEngine tests are deterministic regardless of the real .env.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    readFileSync: vi.fn(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }),
  };
});

describe('types', () => {
  it('SearchResult has required fields', () => {
    const r: SearchResult = { title: 't', url: 'u', snippet: 's', engine: 'exa' };
    expect(r.title).toBe('t');
  });

  it('SearchResponse has required fields', () => {
    const r: SearchResponse = { query: 'q', results: [], engines: [], partialFailures: [] };
    expect(r.query).toBe('q');
  });

  it('ExtractedContent has required fields', () => {
    const r: ExtractedContent = { url: 'u', title: 't', content: 'c', error: null };
    expect(r.error).toBeNull();
  });

  it('FetchResponse has required fields', () => {
    const r: FetchResponse = { url: 'u', title: 't', content: 'c', strategy: 's', error: null };
    expect(r.strategy).toBe('s');
  });
});

import { ExaEngine } from '../extensions/web-search/engines/exa';

describe('ExaEngine', () => {
  let engine: ExaEngine;

  beforeEach(() => {
    engine = new ExaEngine();
  });

  it('isAvailable returns false when no API key', () => {
    // Temporarily clear the key
    const original = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    // Also clear cache by reloading the module behavior
    expect(engine.isAvailable()).toBe(false);
    if (original) process.env.EXA_API_KEY = original;
  });

  it('isAvailable returns true when API key exists', () => {
    process.env.EXA_API_KEY = 'test-key';
    expect(engine.isAvailable()).toBe(true);
    delete process.env.EXA_API_KEY;
  });

  it('search returns empty results when no API key', async () => {
    const original = process.env.EXA_API_KEY;
    delete process.env.EXA_API_KEY;
    const results = await engine.search('test', 3);
    expect(results).toEqual([]);
    if (original) process.env.EXA_API_KEY = original;
  });
});
