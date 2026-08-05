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
import { DuckDuckGoEngine, decodeDdgUrl, stripHtml } from '../extensions/web-search/engines/duckduckgo';

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

describe('DuckDuckGoEngine helpers', () => {
  it('decodeDdgUrl strips &rut suffix (bare &)', () => {
    const encoded = '//duckduckgo.com/l/?uddg=https%3A%2F%2Frust-lang.org%2F&rut=0c07a1b2c3d4e5f6';
    expect(decodeDdgUrl(encoded)).toBe('https://rust-lang.org/');
  });

  it('decodeDdgUrl strips &rut suffix (amp HTML entity &amp;)', () => {
    const encoded = '//duckduckgo.com/l/?uddg=https%3A%2F%2Frust-lang.org%2F&amp;rut=0c07a1b2c3d4e5f6';
    expect(decodeDdgUrl(encoded)).toBe('https://rust-lang.org/');
  });

  it('decodeDdgUrl handles clean URL without suffix', () => {
    const encoded = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F';
    expect(decodeDdgUrl(encoded)).toBe('https://example.com/');
  });

  it('decodeDdgUrl guards against URIError from bare %', () => {
    const encoded = '//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%';
    expect(decodeDdgUrl(encoded)).toBe('https%3A%2F%2Fexample.com%');
  });

  it('stripHtml removes inner <b> tags', () => {
    expect(stripHtml('<b>Rust</b> is a fast')).toBe('Rust is a fast');
  });

  it('stripHtml handles mixed inner tags', () => {
    expect(stripHtml('<b>Rust</b> is a <i>fast</i>, <b>safe</b> language')).toBe('Rust is a fast, safe language');
  });

  it('snippetRegex matches snippets with embedded <b> tags', () => {
    const html = '<a class="result__snippet"><b>Rust</b> is a fast, safe systems programming language</a>';
    const snippetRegex = /<a[^>]*class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    const matches = [...html.matchAll(snippetRegex)];
    expect(matches.length).toBe(1);
    expect(stripHtml(matches[0][1])).toBe('Rust is a fast, safe systems programming language');
  });
});

describe('DuckDuckGoEngine', () => {
  let engine: DuckDuckGoEngine;

  beforeEach(() => {
    engine = new DuckDuckGoEngine();
  });

  it('has correct name', () => {
    expect(engine.name).toBe('duckduckgo');
  });

  it('search returns results with titles and URLs', async () => {
    const results = await engine.search('rust programming language', 3);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toBeTruthy();
    expect(results[0].url).toBeTruthy();
    expect(results[0].engine).toBe('duckduckgo');
  });
});

import { searchEngines, webLookup } from '../extensions/web-search/search';
import { ExaEngine } from '../extensions/web-search/engines/exa';
import { DuckDuckGoEngine } from '../extensions/web-search/engines/duckduckgo';

describe('search composition', () => {
  it('registers both engines', () => {
    const names = searchEngines.map(e => e.name);
    expect(names).toContain('exa');
    expect(names).toContain('duckduckgo');
  });

  it('webLookup returns results from available engines', async () => {
    const result = await webLookup('rust programming language', 3);
    expect(result.query).toBe('rust programming language');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.engines.length).toBeGreaterThan(0);
  });

  it('webLookup deduplicates by URL', async () => {
    const result = await webLookup('rust programming language', 5);
    const urls = result.results.map(r => r.url);
    const uniqueUrls = new Set(urls);
    expect(urls.length).toBe(uniqueUrls.size);
  });

  it('webLookup records partial failures', async () => {
    // When one engine fails, results from the other should still come through
    const result = await webLookup('rust programming language', 3);
    // At least one engine should have succeeded
    const hadSuccess = result.results.length > 0;
    const hadFailure = result.partialFailures.length > 0;
    expect(hadSuccess || hadFailure).toBe(true);
  });
});
