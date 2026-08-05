export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  engines: string[];
  partialFailures: { engine: string; error: string }[];
}

export interface ExtractedContent {
  url: string;
  title: string;
  content: string;
  error: string | null;
}

export interface FetchResponse {
  url: string;
  title: string;
  content: string;
  strategy: string;
  error: string | null;
}

export interface SearchEngine {
  name: string;
  search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]>;
  isAvailable?(): boolean;
}

export interface FetchStrategy {
  name: string;
  fetch(url: string, signal?: AbortSignal): Promise<ExtractedContent | null>;
}
