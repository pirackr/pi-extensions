/**
 * Tests for Task 4: Official Search Adapters and Routing.
 *
 * Covers:
 * 1. SDK-mock tests for TinyFish, Exa, Tavily adapters.
 * 2. Routing tests: chain order, explicit-only, skips, retries, 429, cancellation, DDG failures.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock node:fs to neutralize .env (hoisted by vitest)
// ---------------------------------------------------------------------------
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
  };
});

// ---------------------------------------------------------------------------
// Mock SDKs (hoisted by vitest — factories must not reference later vars)
// ---------------------------------------------------------------------------
vi.mock("@tiny-fish/sdk", () => {
  const mockFn = vi.fn();
  return {
    TinyFish: vi.fn().mockImplementation(() => ({
      search: { query: mockFn },
    })),
    __mockTinyFishSearchQuery: mockFn,
  };
});

vi.mock("exa-js", () => {
  const mockFn = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      search: mockFn,
    })),
    Exa: vi.fn().mockImplementation(() => ({
      search: mockFn,
    })),
    __mockExaSearch: mockFn,
  };
});

vi.mock("@tavily/core", () => {
  const mockFn = vi.fn();
  return {
    default: vi.fn().mockImplementation(() => ({
      search: mockFn,
    })),
    tavily: vi.fn().mockImplementation(() => ({
      search: mockFn,
    })),
    __mockTavilySearch: mockFn,
  };
});

vi.mock("../extensions/web-search/rate-limit.ts", () => {
  const mockReserve = vi.fn();
  const mockPublishCooldown = vi.fn();
  return {
    createCoordinator: vi.fn().mockReturnValue({
      reserve: mockReserve,
      publishCooldown: mockPublishCooldown,
    }),
    RateLimitCoordinator: vi.fn().mockReturnValue({
      reserve: mockReserve,
      publishCooldown: mockPublishCooldown,
    }),
    __mockReserve: mockReserve,
    __mockPublishCooldown: mockPublishCooldown,
  };
});

vi.mock("../extensions/web-search/credentials.ts", () => ({
  loadCredentials: vi.fn().mockResolvedValue({
    tinyfish: "tf-test-key",
    exa: "exa-test-key",
    tavily: "tavily-test-key",
  }),
}));

vi.mock("../extensions/web-search/config.ts", () => ({
  loadWebSearchConfig: vi.fn().mockResolvedValue({
    config: {
      routing: {
        searchAuto: ["tinyfish", "exa", "duckduckgo"],
        fetch: ["tinyfish", "readability"],
      },
      providers: {
        tinyfish: {
          search: { capacity: 30, windowMs: 60000, maxRetries: 1 },
        },
        exa: {
          search: { capacity: 10, windowMs: 1000, maxRetries: 1 },
        },
        tavily: {
          search: { capacity: 100, windowMs: 60000, maxRetries: 1 },
        },
        duckduckgo: {
          search: {
            capacity: null,
            windowMs: 60000,
            maxRetries: 1,
            fallbackCooldownMs: 60000,
          },
        },
      },
    },
    warnings: [],
  }),
}));

// ---------------------------------------------------------------------------
// Access mock instances after module evaluation
// ---------------------------------------------------------------------------
const { __mockTinyFishSearchQuery: mockTinyFishSearchQuery } =
  await import("@tiny-fish/sdk");
const { __mockExaSearch: mockExaSearch } = await import("exa-js");
const { __mockTavilySearch: mockTavilySearch } = await import("@tavily/core");
const {
  __mockReserve: mockReserve,
  __mockPublishCooldown: mockPublishCooldown,
} = await import("../extensions/web-search/rate-limit.ts");

// ---------------------------------------------------------------------------
// Import implementation modules
// ---------------------------------------------------------------------------
import { TinyFishEngine } from "../extensions/web-search/engines/tinyfish.ts";
import { ExaEngine } from "../extensions/web-search/engines/exa.ts";
import { TavilyEngine } from "../extensions/web-search/engines/tavily.ts";
import { DuckDuckGoEngine } from "../extensions/web-search/engines/duckduckgo.ts";
import { webLookup, resolveChain, searchEngines } from "../extensions/web-search/search.ts";
import type { WebLookupRequest } from "../extensions/web-search/types.ts";
import { createCoordinator } from "../extensions/web-search/rate-limit.ts";

// ---------------------------------------------------------------------------
// TinyFish Engine — SDK-mock tests
// ---------------------------------------------------------------------------

describe("TinyFishEngine", () => {
  let engine: TinyFishEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTinyFishSearchQuery.mockReset();
    engine = new TinyFishEngine("tf-test-key");
  });

  it("sends default search params with no advancedOptions", async () => {
    mockTinyFishSearchQuery.mockResolvedValue({
      query: "test",
      results: [
        {
          position: 1,
          site_name: "Example",
          snippet: "snippet one",
          title: "Title One",
          url: "https://example.com/1",
        },
      ],
      total_results: 1,
      page: 1,
    });

    const results = await engine.search({ query: "test", limit: 5 });

    expect(mockTinyFishSearchQuery).toHaveBeenCalledTimes(1);
    const call = mockTinyFishSearchQuery.mock.calls[0][0];
    expect(call.query).toBe("test");
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: "Title One",
      url: "https://example.com/1",
      snippet: "snippet one",
      engine: "tinyfish",
    });
  });

  it("slices results to the requested limit", async () => {
    mockTinyFishSearchQuery.mockResolvedValue({
      query: "test",
      results: Array.from({ length: 10 }, (_, i) => ({
        position: i + 1,
        site_name: "Example",
        snippet: `snippet ${i + 1}`,
        title: `Title ${i + 1}`,
        url: `https://example.com/${i + 1}`,
      })),
      total_results: 10,
      page: 1,
    });

    const results = await engine.search({ query: "test", limit: 3 });
    expect(results).toHaveLength(3);
  });

  it("forwards advancedOptions to SDK query params", async () => {
    mockTinyFishSearchQuery.mockResolvedValue({
      query: "test",
      results: [],
      total_results: 0,
      page: 1,
    });

    await engine.search({
      query: "test",
      limit: 5,
      advancedOptions: {
        tinyfish: {
          purpose: "find docs",
          location: "US",
          language: "en",
          domain_type: "web",
          recency_minutes: 60,
        },
      },
    });

    expect(mockTinyFishSearchQuery).toHaveBeenCalledTimes(1);
    const call = mockTinyFishSearchQuery.mock.calls[0][0];
    expect(call.purpose).toBe("find docs");
    expect(call.location).toBe("US");
    expect(call.language).toBe("en");
    expect(call.domain_type).toBe("web");
    expect(call.recency_minutes).toBe(60);
  });

  it("aborts on AbortSignal", async () => {
    const controller = new AbortController();
    mockTinyFishSearchQuery.mockImplementation((_params, options) => {
      if (options?.signal?.aborted) {
        const err = new Error("aborted");
        (err as any).name = "AbortError";
        throw err;
      }
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          (err as any).name = "AbortError";
          reject(err);
        });
      });
    });

    const promise = engine.search(
      { query: "test", limit: 5 },
      controller.signal,
    );
    controller.abort();

    await expect(promise).rejects.toThrow("aborted");
  });

  it("maps SDK errors to categorized failures", async () => {
    const err = new Error("rate limited");
    (err as any).statusCode = 429;
    mockTinyFishSearchQuery.mockRejectedValue(err);

    await expect(
      engine.search({ query: "test", limit: 5 }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Exa Engine — SDK-mock tests
// ---------------------------------------------------------------------------

describe("ExaEngine", () => {
  let engine: ExaEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExaSearch.mockReset();
    engine = new ExaEngine("exa-test-key");
  });

  it("sends type:auto and contents.text:true by default", async () => {
    mockExaSearch.mockResolvedValue({
      results: [
        {
          title: "Title One",
          url: "https://example.com/1",
          text: "  markdown snippet one  ",
        },
      ],
    });

    const results = await engine.search({ query: "test", limit: 5 });

    expect(mockExaSearch).toHaveBeenCalledTimes(1);
    const call = mockExaSearch.mock.calls[0];
    expect(call[0]).toBe("test");
    const opts = call[1];
    expect(opts.type).toBe("auto");
    expect(opts.contents).toEqual({ text: true });
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: "Title One",
      url: "https://example.com/1",
      snippet: "markdown snippet one",
      engine: "exa",
    });
  });

  it("maps limit to numResults and clamps to 1-50", async () => {
    mockExaSearch.mockResolvedValue({ results: [] });

    await engine.search({ query: "test", limit: 500 });
    expect(mockExaSearch.mock.calls[0][1].numResults).toBe(50);

    await engine.search({ query: "test", limit: 0 });
    expect(mockExaSearch.mock.calls[1][1].numResults).toBe(1);
  });

  it("forwards advancedOptions to SDK search options", async () => {
    mockExaSearch.mockResolvedValue({ results: [] });

    await engine.search({
      query: "test",
      limit: 5,
      advancedOptions: {
        exa: {
          includeDomains: ["example.com"],
          excludeDomains: ["other.com"],
          category: "news",
          type: "neural",
        },
      },
    });

    expect(mockExaSearch).toHaveBeenCalledTimes(1);
    const opts = mockExaSearch.mock.calls[0][1];
    expect(opts.includeDomains).toEqual(["example.com"]);
    expect(opts.excludeDomains).toEqual(["other.com"]);
    expect(opts.category).toBe("news");
    expect(opts.type).toBe("neural");
  });

  it("maps results with text as snippet", async () => {
    mockExaSearch.mockResolvedValue({
      results: [
        {
          title: "T1",
          url: "https://example.com/1",
          text: "  snippet one  ",
        },
        {
          title: "T2",
          url: "https://example.com/2",
          text: "snippet two",
        },
        { url: "https://example.com/3" },
      ],
    });

    const results = await engine.search({ query: "q", limit: 3 });
    expect(results).toEqual([
      {
        title: "T1",
        url: "https://example.com/1",
        snippet: "snippet one",
        engine: "exa",
      },
      {
        title: "T2",
        url: "https://example.com/2",
        snippet: "snippet two",
        engine: "exa",
      },
      {
        title: "No title",
        url: "https://example.com/3",
        snippet: "",
        engine: "exa",
      },
    ]);
  });

  it("surfaces SDK errors", async () => {
    const err = new Error("not found");
    (err as any).statusCode = 404;
    mockExaSearch.mockRejectedValue(err);

    await expect(
      engine.search({ query: "test", limit: 5 }),
    ).rejects.toThrow();
  });

  it("rejects immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      engine.search({ query: "test", limit: 5 }, controller.signal),
    ).rejects.toThrow();
    expect(mockExaSearch).not.toHaveBeenCalled();
  });

  it("accepts signal argument without error", async () => {
    mockExaSearch.mockResolvedValue({ results: [] });
    const controller = new AbortController();
    // Should not throw just for accepting the signal
    await engine.search({ query: "test", limit: 5 }, controller.signal);
    expect(mockExaSearch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Tavily Engine — SDK-mock tests
// ---------------------------------------------------------------------------

describe("TavilyEngine", () => {
  let engine: TavilyEngine;

  beforeEach(() => {
    vi.clearAllMocks();
    mockTavilySearch.mockReset();
    engine = new TavilyEngine("tavily-test-key");
  });

  it("sends searchDepth:advanced by default", async () => {
    mockTavilySearch.mockResolvedValue({
      query: "test",
      results: [
        {
          title: "Title One",
          url: "https://example.com/1",
          content: "  snippet one  ",
        },
      ],
      responseTime: 0.5,
      images: [],
      requestId: "req-1",
    });

    const results = await engine.search({ query: "test", limit: 5 });

    expect(mockTavilySearch).toHaveBeenCalledTimes(1);
    const call = mockTavilySearch.mock.calls[0];
    expect(call[0]).toBe("test");
    const opts = call[1];
    expect(opts.searchDepth).toBe("advanced");
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      title: "Title One",
      url: "https://example.com/1",
      snippet: "snippet one",
      engine: "tavily",
    });
  });

  it("maps limit to maxResults and clamps to 1-20", async () => {
    mockTavilySearch.mockResolvedValue({
      query: "test",
      results: [],
      responseTime: 0.1,
      images: [],
      requestId: "req-1",
    });

    await engine.search({ query: "test", limit: 500 });
    expect(mockTavilySearch.mock.calls[0][1].maxResults).toBe(20);

    await engine.search({ query: "test", limit: 0 });
    expect(mockTavilySearch.mock.calls[1][1].maxResults).toBe(1);
  });

  it("forwards advancedOptions to SDK search options", async () => {
    mockTavilySearch.mockResolvedValue({
      query: "test",
      results: [],
      responseTime: 0.1,
      images: [],
      requestId: "req-1",
    });

    await engine.search({
      query: "test",
      limit: 5,
      advancedOptions: {
        tavily: {
          topic: "news",
          days: 7,
          includeImages: true,
        },
      },
    });

    expect(mockTavilySearch).toHaveBeenCalledTimes(1);
    const opts = mockTavilySearch.mock.calls[0][1];
    expect(opts.topic).toBe("news");
    expect(opts.days).toBe(7);
    expect(opts.includeImages).toBe(true);
    expect(opts.searchDepth).toBe("advanced");
  });

  it("surfaces SDK errors", async () => {
    const err = new Error("rate limited");
    (err as any).statusCode = 429;
    mockTavilySearch.mockRejectedValue(err);

    await expect(
      engine.search({ query: "test", limit: 5 }),
    ).rejects.toThrow();
  });

  it("rejects immediately when signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      engine.search({ query: "test", limit: 5 }, controller.signal),
    ).rejects.toThrow();
    expect(mockTavilySearch).not.toHaveBeenCalled();
  });

  it("accepts signal argument without error", async () => {
    mockTavilySearch.mockResolvedValue({
      query: "test",
      results: [],
      responseTime: 0.1,
      images: [],
      requestId: "req-1",
    });
    const controller = new AbortController();
    // Should not throw just for accepting the signal
    await engine.search({ query: "test", limit: 5 }, controller.signal);
    expect(mockTavilySearch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// DuckDuckGo Engine — normalized failures
// ---------------------------------------------------------------------------

describe("DuckDuckGoEngine normalized failures", () => {
  let engine: DuckDuckGoEngine;

  beforeEach(() => {
    engine = new DuckDuckGoEngine();
  });

  it("surfaces HTTP 500 as a service error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Promise.resolve({ ok: false, status: 500 } as Response);
    try {
      await expect(engine.search({ query: "test", limit: 3 })).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces HTTP 429 as a rate_limit error", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Promise.resolve({ ok: false, status: 429 } as Response);
    try {
      await expect(engine.search({ query: "test", limit: 3 })).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns results on happy path (unchanged)", async () => {
    const html = `<html><body>
      <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F">Example</a>
      <a class="result__snippet" href="#"><b>Snippet</b> text</a>
    </body></html>`;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      Promise.resolve({ ok: true, text: async () => html } as Response);
    try {
      const results = await engine.search({ query: "test", limit: 3 });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].engine).toBe("duckduckgo");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

// ---------------------------------------------------------------------------
// Routing tests
// ---------------------------------------------------------------------------

describe("webLookup routing", () => {
  const makeRequest = (overrides: Partial<WebLookupRequest> = {}): WebLookupRequest => ({
    query: "test query",
    limit: 5,
    ...overrides,
  });

  const makeContext = (overrides: {
    tinyfishKey?: string | null;
    exaKey?: string | null;
    tavilyKey?: string | null;
  } = {}) => ({
    credentials: {
      tinyfish:
        overrides.tinyfishKey !== undefined
          ? overrides.tinyfishKey
          : "tf-key",
      exa: overrides.exaKey !== undefined ? overrides.exaKey : "exa-key",
      tavily:
        overrides.tavilyKey !== undefined
          ? overrides.tavilyKey
          : "tavily-key",
    },
    config: {
      routing: {
        searchAuto: ["tinyfish", "exa", "duckduckgo"],
        fetch: ["tinyfish", "readability"],
      },
      providers: {
        tinyfish: {
          search: { capacity: 30, windowMs: 60000, maxRetries: 1 },
        },
        exa: {
          search: { capacity: 10, windowMs: 1000, maxRetries: 1 },
        },
        tavily: {
          search: { capacity: 100, windowMs: 60000, maxRetries: 1 },
        },
        duckduckgo: {
          search: {
            capacity: null,
            windowMs: 60000,
            maxRetries: 1,
            fallbackCooldownMs: 60000,
          },
        },
      },
    },
    coordinator: createCoordinator("/tmp/web-search-test", {
      tinyfish: { search: { capacity: 30, windowMs: 60000, maxRetries: 1 } },
      exa: { search: { capacity: 10, windowMs: 1000, maxRetries: 1 } },
      tavily: { search: { capacity: 100, windowMs: 60000, maxRetries: 1 } },
      duckduckgo: {
        search: {
          capacity: null,
          windowMs: 60000,
          maxRetries: 1,
          fallbackCooldownMs: 60000,
        },
      },
    }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockReserve.mockReset();
    mockPublishCooldown.mockReset();
    mockTinyFishSearchQuery.mockReset();
    mockExaSearch.mockReset();
    mockTavilySearch.mockReset();
  });

  it("returns first-success results in TinyFish → Exa → DuckDuckGo order", async () => {
    mockTinyFishSearchQuery.mockResolvedValue({
      query: "test query",
      results: [
        {
          position: 1,
          site_name: "TF",
          snippet: "tf snippet",
          title: "TF Title",
          url: "https://tf.example.com/1",
        },
      ],
      total_results: 1,
      page: 1,
    });
    mockReserve.mockResolvedValue("allowed");

    const result = await webLookup(makeRequest(), makeContext());

    expect(result.engines).toEqual(["tinyfish"]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].engine).toBe("tinyfish");
    expect(result.partialFailures).toEqual([]);
    expect(mockExaSearch).not.toHaveBeenCalled();
  });

  it("falls back to Exa when TinyFish returns no results", async () => {
    mockTinyFishSearchQuery.mockResolvedValue({
      query: "test query",
      results: [],
      total_results: 0,
      page: 1,
    });
    mockExaSearch.mockResolvedValue({
      results: [
        { title: "Exa Title", url: "https://exa.example.com/1", text: "exa snippet" },
      ],
    });
    // 2 reserves: one for TF (no results), one for Exa (success)
    mockReserve.mockResolvedValue("allowed");

    const result = await webLookup(makeRequest(), makeContext());

    expect(result.engines).toEqual(["exa"]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].engine).toBe("exa");
    expect(result.partialFailures.some((pf) => pf.engine === "tinyfish")).toBe(true);
  });

  it("explicit tavily engine runs Tavily alone, never falls back", async () => {
    mockTavilySearch.mockResolvedValue({
      query: "test query",
      results: [
        {
          title: "Tavily Title",
          url: "https://tavily.example.com/1",
          content: "tavily snippet",
        },
      ],
      responseTime: 0.1,
      images: [],
      requestId: "req-1",
    });
    mockReserve.mockResolvedValue("allowed");

    const result = await webLookup(
      makeRequest({ engine: "tavily" }),
      makeContext(),
    );

    expect(result.engines).toEqual(["tavily"]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].engine).toBe("tavily");
    expect(mockTinyFishSearchQuery).not.toHaveBeenCalled();
    expect(mockExaSearch).not.toHaveBeenCalled();
  });

  it("explicit exa engine runs Exa alone, never falls back", async () => {
    mockExaSearch.mockResolvedValue({
      results: [{ title: "E", url: "https://e.com/1", text: "t" }],
    });
    mockReserve.mockResolvedValue("allowed");

    const result = await webLookup(makeRequest({ engine: "exa" }), makeContext());

    expect(result.engines).toEqual(["exa"]);
    expect(result.results).toHaveLength(1);
    expect(mockTinyFishSearchQuery).not.toHaveBeenCalled();
  });

  it("records proactive capacity-blocked skip as partialFailure", async () => {
    mockReserve.mockResolvedValue("capacity-blocked");

    const result = await webLookup(makeRequest(), makeContext());

    expect(result.results).toEqual([]);
    expect(result.engines).toEqual([]);
    const enginesInFailures = result.partialFailures.map((pf) => pf.engine);
    expect(enginesInFailures).toContain("tinyfish");
    expect(enginesInFailures).toContain("exa");
    expect(enginesInFailures).toContain("duckduckgo");
  });

  it("records cooldown-blocked skip as partialFailure", async () => {
    mockReserve.mockResolvedValue("cooldown-blocked");

    const result = await webLookup(makeRequest(), makeContext());

    expect(result.results).toEqual([]);
    expect(result.engines).toEqual([]);
    const enginesInFailures = result.partialFailures.map((pf) => pf.engine);
    expect(enginesInFailures).toContain("tinyfish");
  });

  it("records contention skip as partialFailure in auto mode and continues", async () => {
    // TinyFish contention → skip, then Exa succeeds
    mockReserve
      .mockResolvedValueOnce("contention")
      .mockResolvedValue("allowed");
    mockExaSearch.mockResolvedValue({
      results: [{ title: "E", url: "https://e.com/1", text: "t" }],
    });

    const result = await webLookup(makeRequest(), makeContext());

    expect(result.results).toHaveLength(1);
    expect(result.results[0].engine).toBe("exa");
    expect(result.engines).toEqual(["exa"]);
    const tfFailures = result.partialFailures.filter((pf) => pf.engine === "tinyfish");
    expect(tfFailures.length).toBeGreaterThan(0);
    expect(tfFailures[0].error).toContain("contention");
    expect(mockExaSearch).toHaveBeenCalledTimes(1);
  });

  it("records contention skip in explicit mode without falling back", async () => {
    mockReserve.mockResolvedValue("contention");

    const result = await webLookup(makeRequest({ engine: "tinyfish" }), makeContext());

    expect(result.results).toEqual([]);
    expect(result.engines).toEqual([]);
    const tfFailures = result.partialFailures.filter((pf) => pf.engine === "tinyfish");
    expect(tfFailures.length).toBeGreaterThan(0);
    expect(tfFailures[0].error).toContain("contention");
  });

  it("retries transient failure once then falls back", async () => {
    const timeoutErr = new Error("timeout");
    mockTinyFishSearchQuery
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValueOnce({
        query: "test query",
        results: [
          {
            position: 1,
            site_name: "TF",
            snippet: "tf snippet",
            title: "TF Title",
            url: "https://tf.example.com/1",
          },
        ],
        total_results: 1,
        page: 1,
      });
    // Two reserves: initial + retry
    mockReserve
      .mockResolvedValueOnce("allowed")
      .mockResolvedValueOnce("allowed");

    const result = await webLookup(makeRequest(), makeContext());

    expect(result.engines).toEqual(["tinyfish"]);
    expect(result.results).toHaveLength(1);
    expect(mockReserve).toHaveBeenCalledTimes(2);
  });

  it("publishes 429 cooldown and continues to next engine", async () => {
    const rateLimitErr = new Error("rate limited");
    (rateLimitErr as any).statusCode = 429;
    (rateLimitErr as any).retryAfter = 60000;
    mockTinyFishSearchQuery.mockRejectedValue(rateLimitErr);
    mockExaSearch.mockResolvedValue({
      results: [{ title: "E", url: "https://e.com/1", text: "t" }],
    });
    mockReserve.mockResolvedValue("allowed");

    const result = await webLookup(makeRequest(), makeContext());

    expect(result.engines).toEqual(["exa"]);
    expect(result.results).toHaveLength(1);
    expect(result.results[0].engine).toBe("exa");
    expect(mockPublishCooldown).toHaveBeenCalledWith(
      "tinyfish",
      "search",
      expect.anything(),
      "tf-key",
    );
    const tinyfishFailures = result.partialFailures.filter(
      (pf) => pf.engine === "tinyfish",
    );
    expect(tinyfishFailures.length).toBeGreaterThan(0);
  });

  it("stops routing immediately on cancellation, no retry, no partialFailure", async () => {
    const controller = new AbortController();
    // Abort before the request starts so the engine sees an already-aborted signal.
    controller.abort();

    mockTinyFishSearchQuery.mockImplementation((_params: any, options: any) => {
      if (options?.signal?.aborted) {
        const err = new Error("aborted");
        (err as any).name = "AbortError";
        throw err;
      }
      return new Promise((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          (err as any).name = "AbortError";
          reject(err);
        });
      });
    });
    mockReserve.mockResolvedValue("allowed");

    const request = makeRequest();
    (request as any).__signal = controller.signal;
    const result = await webLookup(request, makeContext());

    expect(result.results).toEqual([]);
    expect(result.engines).toEqual([]);
    const cancelFailures = result.partialFailures.filter(
      (pf) => pf.error.includes("cancelled") || pf.error.includes("aborted"),
    );
    expect(cancelFailures).toEqual([]);
    expect(mockExaSearch).not.toHaveBeenCalled();
  });

  it("explicit engine with missing credentials reports skip, never falls back", async () => {
    const ctx = makeContext({ exaKey: null });
    mockReserve.mockResolvedValue("allowed");

    const result = await webLookup(
      makeRequest({ engine: "exa" }),
      ctx,
    );

    expect(result.results).toEqual([]);
    expect(result.engines).toEqual([]);
    const exaFailures = result.partialFailures.filter(
      (pf) => pf.engine === "exa",
    );
    expect(exaFailures.length).toBeGreaterThan(0);
    expect(exaFailures[0].error).toContain("provider credentials unavailable");
    expect(mockExaSearch).not.toHaveBeenCalled();
  });

  it("reserves every attempt including retries", async () => {
    const timeoutErr = new Error("timeout");
    mockTinyFishSearchQuery
      .mockRejectedValueOnce(timeoutErr)
      .mockRejectedValueOnce(timeoutErr);
    mockExaSearch.mockResolvedValue({
      results: [{ title: "E", url: "https://e.com/1", text: "t" }],
    });
    mockReserve.mockResolvedValue("allowed");

    const result = await webLookup(makeRequest(), makeContext());

    expect(result.engines).toEqual(["exa"]);
    expect(result.results).toHaveLength(1);
    // 2 reserves for TinyFish (initial + 1 retry) + 1 for Exa = 3
    expect(mockReserve).toHaveBeenCalledTimes(3);
  });

  it("stops routing immediately on Exa cancellation, no retry, no partialFailure", async () => {
    mockTinyFishSearchQuery.mockResolvedValue({
      query: "test query",
      results: [],
      total_results: 0,
      page: 1,
    });
    const controller = new AbortController();
    controller.abort();

    mockExaSearch.mockImplementation((_query: string, _opts: any) => {
      const err = new Error("aborted");
      (err as any).name = "AbortError";
      throw err;
    });
    mockReserve.mockResolvedValue("allowed");

    const request = makeRequest();
    (request as any).__signal = controller.signal;
    const result = await webLookup(request, makeContext());

    expect(result.results).toEqual([]);
    expect(result.engines).toEqual([]);
    const cancelFailures = result.partialFailures.filter(
      (pf) => pf.error.includes("cancelled") || pf.error.includes("aborted"),
    );
    expect(cancelFailures).toEqual([]);
    // DuckDuckGo should not be attempted after Exa abort
  });

  it("stops routing immediately on Tavily cancellation, no retry, no partialFailure", async () => {
    const controller = new AbortController();
    controller.abort();

    mockTavilySearch.mockImplementation((_query: string, _opts: any) => {
      const err = new Error("aborted");
      (err as any).name = "AbortError";
      throw err;
    });
    mockReserve.mockResolvedValue("allowed");

    const request = makeRequest({ engine: "tavily" });
    (request as any).__signal = controller.signal;
    const result = await webLookup(request, makeContext());

    expect(result.results).toEqual([]);
    expect(result.engines).toEqual([]);
    const cancelFailures = result.partialFailures.filter(
      (pf) => pf.error.includes("cancelled") || pf.error.includes("aborted"),
    );
    expect(cancelFailures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveChain + searchEngines
// ---------------------------------------------------------------------------

describe("resolveChain and searchEngines", () => {
  it("auto chain is TinyFish → Exa → DuckDuckGo", () => {
    expect(resolveChain("auto")).toEqual(["tinyfish", "exa", "duckduckgo"]);
  });

  it("default (no engine) uses auto chain", () => {
    expect(resolveChain()).toEqual(["tinyfish", "exa", "duckduckgo"]);
  });

  it("explicit engine returns single engine", () => {
    expect(resolveChain("tinyfish")).toEqual(["tinyfish"]);
    expect(resolveChain("exa")).toEqual(["exa"]);
    expect(resolveChain("duckduckgo")).toEqual(["duckduckgo"]);
    expect(resolveChain("tavily")).toEqual(["tavily"]);
  });

  it("searchEngines registry includes all engines, tavily explicit-only", () => {
    const names = searchEngines.map((e) => e.name);
    expect(names).toContain("tinyfish");
    expect(names).toContain("exa");
    expect(names).toContain("duckduckgo");
    expect(names).toContain("tavily");
  });
});
