import { describe, it, expect } from 'vitest';
import type { SearchResult, SearchResponse, ExtractedContent, FetchResponse, SearchEngine, FetchStrategy } from '../extensions/web-search/types';

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
