import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import createExtension from "../extensions/web-search/index.ts";
import type {
	SearchResult,
	SearchResponse,
	ExtractedContent,
	FetchResponse,
} from "../extensions/web-search/types";

// Mock node:fs readFileSync to throw ENOENT so the real repo .env cannot
// make isAvailable() return true when process.env.EXA_API_KEY is deleted.
// This ensures the ExaEngine tests are deterministic regardless of the real .env.
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
// Mock config, credentials, and rate-limit so the full routing path works
// without real network calls or filesystem reads.
// ---------------------------------------------------------------------------
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
					fetch: { capacity: 150, windowMs: 60000, maxRetries: 1 },
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

vi.mock("../extensions/web-search/credentials.ts", () => ({
	loadCredentials: vi.fn().mockResolvedValue({
		tinyfish: "tf-test-key",
		exa: "exa-test-key",
		tavily: "tavily-test-key",
	}),
}));

vi.mock("../extensions/web-search/rate-limit.ts", () => {
	const mockReserve = vi.fn().mockResolvedValue("allowed");
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

// ---------------------------------------------------------------------------
// Mock SDKs for deterministic engine tests.
// ---------------------------------------------------------------------------
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

vi.mock("@tiny-fish/sdk", () => {
	const mockFn = vi.fn();
	return {
		TinyFish: vi.fn().mockImplementation(() => ({
			search: { query: mockFn },
		})),
		__mockTinyFishSearchQuery: mockFn,
	};
});

// ---------------------------------------------------------------------------
// Access mock instances after module evaluation
// ---------------------------------------------------------------------------
const { __mockExaSearch: mockExaSearch } = await import("exa-js");
const { __mockTavilySearch: mockTavilySearch } = await import("@tavily/core");
const { __mockTinyFishSearchQuery: mockTinyFishSearchQuery } =
	await import("@tiny-fish/sdk");
const { __mockReserve: mockReserve } = await import(
	"../extensions/web-search/rate-limit.ts"
);

describe("types", () => {
	it("SearchResult has required fields", () => {
		const r: SearchResult = {
			title: "t",
			url: "u",
			snippet: "s",
			engine: "exa",
		};
		expect(r.title).toBe("t");
	});

	it("SearchResponse has required fields", () => {
		const r: SearchResponse = {
			query: "q",
			results: [],
			engines: [],
			partialFailures: [],
		};
		expect(r.query).toBe("q");
	});

	it("ExtractedContent has required fields", () => {
		const r: ExtractedContent = {
			url: "u",
			title: "t",
			content: "c",
			error: null,
		};
		expect(r.error).toBeNull();
	});

	it("FetchResponse has required fields", () => {
		const r: FetchResponse = {
			url: "u",
			title: "t",
			content: "c",
			strategy: "s",
			format: "markdown",
			error: null,
			attempts: [{ strategy: "s", outcome: "success" }],
		};
		expect(r.strategy).toBe("s");
		expect(r.format).toBe("markdown");
		expect(r.attempts).toHaveLength(1);
	});
});

import { ExaEngine } from "../extensions/web-search/engines/exa.ts";
import {
	DuckDuckGoEngine,
	decodeDdgUrl,
	stripHtml,
} from "../extensions/web-search/engines/duckduckgo.ts";

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

	it("clamps numResults to 1-50", async () => {
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
				{ title: "T1", url: "https://example.com/1", text: "  snippet one  " },
				{ title: "T2", url: "https://example.com/2", text: "snippet two" },
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
});

describe("DuckDuckGoEngine helpers", () => {
	it("decodeDdgUrl strips &rut suffix (bare &)", () => {
		const encoded =
			"//duckduckgo.com/l/?uddg=https%3A%2F%2Frust-lang.org%2F&rut=0c07a1b2c3d4e5f6";
		expect(decodeDdgUrl(encoded)).toBe("https://rust-lang.org/");
	});

	it("decodeDdgUrl strips &rut suffix (amp HTML entity &amp;)", () => {
		const encoded =
			"//duckduckgo.com/l/?uddg=https%3A%2F%2Frust-lang.org%2F&amp;rut=0c07a1b2c3d4e5f6";
		expect(decodeDdgUrl(encoded)).toBe("https://rust-lang.org/");
	});

	it("decodeDdgUrl handles clean URL without suffix", () => {
		const encoded = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F";
		expect(decodeDdgUrl(encoded)).toBe("https://example.com/");
	});

	it("decodeDdgUrl guards against URIError from bare %", () => {
		const encoded = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%";
		expect(decodeDdgUrl(encoded)).toBe("https%3A%2F%2Fexample.com%");
	});

	it("stripHtml removes inner <b> tags", () => {
		expect(stripHtml("<b>Rust</b> is a fast")).toBe("Rust is a fast");
	});

	it("stripHtml handles mixed inner tags", () => {
		expect(
			stripHtml("<b>Rust</b> is a <i>fast</i>, <b>safe</b> language"),
		).toBe("Rust is a fast, safe language");
	});

	it("snippetRegex matches snippets with embedded <b> tags", () => {
		const html =
			'<a class="result__snippet"><b>Rust</b> is a fast, safe systems programming language</a>';
		const snippetRegex =
			/<a[^>]*class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
		const matches = [...html.matchAll(snippetRegex)];
		expect(matches.length).toBe(1);
		expect(stripHtml(matches[0][1])).toBe(
			"Rust is a fast, safe systems programming language",
		);
	});
});

describe("DuckDuckGoEngine", () => {
	let engine: DuckDuckGoEngine;

	beforeEach(() => {
		engine = new DuckDuckGoEngine();
	});

	it("has correct name", () => {
		expect(engine.name).toBe("duckduckgo");
	});

	it("search returns results with titles and URLs (live)", async () => {
		const results = await engine.search({ query: "rust programming language", limit: 3 });
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].title).toBeTruthy();
		expect(results[0].url).toBeTruthy();
		expect(results[0].engine).toBe("duckduckgo");
	});
});

import { TavilyEngine } from "../extensions/web-search/engines/tavily.ts";

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

	it("clamps maxResults to 1-20", async () => {
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

	it("maps results with content as snippet", async () => {
		mockTavilySearch.mockResolvedValue({
			query: "test",
			results: [
				{ title: "T1", url: "https://example.com/1", content: "  snippet one  " },
				{ title: "T2", url: "https://example.com/2", content: "snippet two" },
				{ url: "https://example.com/3" },
			],
			responseTime: 0.1,
			images: [],
			requestId: "req-1",
		});

		const results = await engine.search({ query: "q", limit: 3 });
		expect(results).toEqual([
			{
				title: "T1",
				url: "https://example.com/1",
				snippet: "snippet one",
				engine: "tavily",
			},
			{
				title: "T2",
				url: "https://example.com/2",
				snippet: "snippet two",
				engine: "tavily",
			},
			{
				title: "No title",
				url: "https://example.com/3",
				snippet: "",
				engine: "tavily",
			},
		]);
	});

	it("surfaces SDK errors", async () => {
		const err = new Error("rate limited");
		(err as any).statusCode = 429;
		mockTavilySearch.mockRejectedValue(err);

		await expect(
			engine.search({ query: "test", limit: 5 }),
		).rejects.toThrow();
	});
});

import {
	resolveChain,
	searchEngines,
	webLookup,
} from "../extensions/web-search/search.ts";
import type { WebLookupRequest } from "../extensions/web-search/types.ts";
import { createCoordinator } from "../extensions/web-search/rate-limit.ts";

describe("search composition", () => {
	it("full registry lists chain engines first, then opt-in tavily", () => {
		const names = searchEngines.map((e) => e.name);
		expect(names).toEqual(["tinyfish", "exa", "duckduckgo", "tavily"]);
	});

	describe("resolveChain", () => {
		it("defaults to the full chain (tinyfish first)", () => {
			expect(resolveChain()).toEqual(["tinyfish", "exa", "duckduckgo"]);
		});

		it("honors explicit 'auto'", () => {
			expect(resolveChain("auto")).toEqual(["tinyfish", "exa", "duckduckgo"]);
		});

		it("forces a single engine", () => {
			expect(resolveChain("tinyfish")).toEqual(["tinyfish"]);
			expect(resolveChain("exa")).toEqual(["exa"]);
			expect(resolveChain("duckduckgo")).toEqual(["duckduckgo"]);
			expect(resolveChain("tavily")).toEqual(["tavily"]);
		});

		it("degrades unknown choices to the default chain", () => {
			expect(resolveChain("bogus" as any)).toEqual([
				"tinyfish",
				"exa",
				"duckduckgo",
			]);
		});

		it("auto chain never includes opt-in engines", () => {
			expect(resolveChain()).toEqual(["tinyfish", "exa", "duckduckgo"]);
			expect(resolveChain("auto")).toEqual(["tinyfish", "exa", "duckduckgo"]);
			expect(resolveChain("tavily")).toEqual(["tavily"]);
		});
	});

	describe("webLookup chain behavior", () => {
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
			mockTinyFishSearchQuery.mockReset();
			mockExaSearch.mockReset();
			mockTavilySearch.mockReset();
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
			mockReserve.mockResolvedValue("allowed");

			const result = await webLookup(makeRequest(), makeContext());

			expect(result.engines).toEqual(["exa"]);
			expect(result.results).toHaveLength(1);
			expect(result.results[0].engine).toBe("exa");
			expect(
				result.partialFailures.some((pf) => pf.engine === "tinyfish"),
			).toBe(true);
		});

		it("honors a forced engine choice", async () => {
			mockExaSearch.mockResolvedValue({
				results: [{ title: "E", url: "https://e.com/1", text: "t" }],
			});
			mockReserve.mockResolvedValue("allowed");

			const result = await webLookup(
				makeRequest({ engine: "exa" }),
				makeContext(),
			);

			expect(result.engines).toEqual(["exa"]);
			expect(result.results).toHaveLength(1);
			expect(mockTinyFishSearchQuery).not.toHaveBeenCalled();
		});

		it("forced exa with no key returns no results and reports the skip", async () => {
			const ctx = makeContext({ exaKey: null });
			mockReserve.mockResolvedValue("allowed");

			const result = await webLookup(makeRequest({ engine: "exa" }), ctx);

			expect(result.results).toEqual([]);
			expect(result.engines).toEqual([]);
			const exaFailures = result.partialFailures.filter(
				(pf) => pf.engine === "exa",
			);
			expect(exaFailures.length).toBeGreaterThan(0);
			expect(exaFailures[0].error).toContain("provider credentials unavailable");
			expect(mockExaSearch).not.toHaveBeenCalled();
		});

		it("forced tavily with no key returns no results and reports the skip", async () => {
			const ctx = makeContext({ tavilyKey: null });
			mockReserve.mockResolvedValue("allowed");

			const result = await webLookup(
				makeRequest({ engine: "tavily" }),
				ctx,
			);

			expect(result.results).toEqual([]);
			expect(result.engines).toEqual([]);
			const tavilyFailures = result.partialFailures.filter(
				(pf) => pf.engine === "tavily",
			);
			expect(tavilyFailures.length).toBeGreaterThan(0);
			expect(tavilyFailures[0].error).toContain(
				"provider credentials unavailable",
			);
			expect(mockTavilySearch).not.toHaveBeenCalled();
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
	});

	it("webLookup deduplicates by URL", async () => {
		mockTinyFishSearchQuery.mockResolvedValue({
			query: "test",
			results: [
				{
					position: 1,
					site_name: "TF",
					snippet: "s1",
					title: "T1",
					url: "https://example.com/1",
				},
			],
			total_results: 1,
			page: 1,
		});
		mockReserve.mockResolvedValue("allowed");

		const result = await webLookup({ query: "test", limit: 5 });
		const urls = result.results.map((r) => r.url);
		const uniqueUrls = new Set(urls);
		expect(urls.length).toBe(uniqueUrls.size);
	});
});

import { ReadabilityStrategy } from "../extensions/web-search/strategies/readability.ts";

describe("ReadabilityStrategy", () => {
	let strategy: ReadabilityStrategy;

	beforeEach(() => {
		strategy = new ReadabilityStrategy();
	});

	it("has correct name", () => {
		expect(strategy.name).toBe("readability");
	});

	it("fetches and extracts content from a real page", async () => {
		const result = await strategy.fetch(
			"https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html",
		);
		expect(result).not.toBeNull();
		expect(result!.title).toBeTruthy();
		expect(result!.content.length).toBeGreaterThan(100);
		expect(result!.error).toBeNull();
	});

	it("returns error for unreachable URL", async () => {
		const result = await strategy.fetch(
			"https://this-domain-does-not-exist-12345.com/page",
		);
		expect(result).not.toBeNull();
		expect(result!.error).toBeTruthy();
	});
});

describe("extension tools", () => {
	it("registers web_search tool", () => {
		const registered: string[] = [];
		const mockPi = {
			registerTool: (tool: { name: string }) => registered.push(tool.name),
		};
		createExtension(mockPi as any);
		expect(registered).toContain("web_search");
	});

	it("registers fetch_web tool", () => {
		const registered: string[] = [];
		const mockPi = {
			registerTool: (tool: { name: string }) => registered.push(tool.name),
		};
		createExtension(mockPi as any);
		expect(registered).toContain("fetch_web");
	});

	it("web_search returns SearchResponse shape", async () => {
		const results: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => results.push(tool),
		};
		createExtension(mockPi as any);
		const lookupTool = results.find((t: any) => t.name === "web_search");
		expect(lookupTool).toBeDefined();

		mockTinyFishSearchQuery.mockResolvedValue({
			query: "rust async",
			results: [
				{
					position: 1,
					site_name: "TF",
					snippet: "rust async snippet",
					title: "Rust Async",
					url: "https://rust.example.com/async",
				},
			],
			total_results: 1,
			page: 1,
		});
		mockReserve.mockResolvedValue("allowed");

		const res = await lookupTool.execute("test-id", { query: "rust async" });
		expect(res.content).toHaveLength(1);
		expect(res.content[0].type).toBe("text");
		expect(res.details).toHaveProperty("query");
		expect(res.details).toHaveProperty("results");
		expect(res.details).toHaveProperty("engines");
		expect(res.details).toHaveProperty("partialFailures");
	});

	it("web_search schema advertises the tavily engine", async () => {
		const results: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => results.push(tool),
		};
		createExtension(mockPi as any);
		const lookupTool = results.find((t: any) => t.name === "web_search");
		expect(JSON.stringify(lookupTool.parameters)).toContain("tavily");
	});

	it("web_search schema advertises the tinyfish engine", async () => {
		const results: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => results.push(tool),
		};
		createExtension(mockPi as any);
		const lookupTool = results.find((t: any) => t.name === "web_search");
		expect(JSON.stringify(lookupTool.parameters)).toContain("tinyfish");
	});

	it("web_search advancedOptions rejects unknown provider keys", async () => {
		const results: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => results.push(tool),
		};
		createExtension(mockPi as any);
		const lookupTool = results.find((t: any) => t.name === "web_search");
		// The schema should reject unknown keys like 'unknown_provider'
		expect(JSON.stringify(lookupTool.parameters)).not.toContain("unknown_provider");
		// Should accept the three known provider keys
		expect(JSON.stringify(lookupTool.parameters)).toContain("tinyfish");
		expect(JSON.stringify(lookupTool.parameters)).toContain("exa");
		expect(JSON.stringify(lookupTool.parameters)).toContain("tavily");
	});

	it("fetch_web advancedOptions rejects unknown fields in tinyfish", async () => {
		const results: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => results.push(tool),
		};
		createExtension(mockPi as any);
		const fetchTool = results.find((t: any) => t.name === "fetch_web");
		const schemaJson = JSON.stringify(fetchTool.parameters);
		// Should contain known tinyfish fields
		expect(schemaJson).toContain("format");
		expect(schemaJson).toContain("links");
		expect(schemaJson).toContain("ttl");
		// Should NOT contain unknown fields
		expect(schemaJson).not.toContain("bogus_field");
	});

	it("fetch_web output text includes format and truncation notice", async () => {
		const results: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => results.push(tool),
		};
		createExtension(mockPi as any);
		const fetchTool = results.find((t: any) => t.name === "fetch_web");

		const res = await fetchTool.execute("test-id", {
			url: "https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html",
			max_chars: 10,
		});
		const text = res.content[0].text as string;
		expect(text).toContain("Format:");
		expect(text).toContain("[Content truncated]");
	});

	it("fetch_web details include attempts", async () => {
		const results: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => results.push(tool),
		};
		createExtension(mockPi as any);
		const fetchTool = results.find((t: any) => t.name === "fetch_web");

		const res = await fetchTool.execute("test-id", {
			url: "https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html",
		});
		expect(res.details).toHaveProperty("attempts");
		expect(Array.isArray(res.details.attempts)).toBe(true);
		expect(res.details.attempts.length).toBeGreaterThan(0);
	});

	it("fetch_web returns FetchResponse shape", async () => {
		const results: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => results.push(tool),
		};
		createExtension(mockPi as any);
		const fetchTool = results.find((t: any) => t.name === "fetch_web");
		expect(fetchTool).toBeDefined();

		const res = await fetchTool.execute("test-id", {
			url: "https://rust-lang.github.io/async-book/08_ecosystem/00_chapter.html",
		});
		expect(res.content).toHaveLength(1);
		expect(res.content[0].type).toBe("text");
		expect(res.details).toHaveProperty("url");
		expect(res.details).toHaveProperty("title");
		expect(res.details).toHaveProperty("content");
		expect(res.details).toHaveProperty("strategy");
		expect(res.details).toHaveProperty("format");
		expect(res.details).toHaveProperty("error");
		expect(res.details).toHaveProperty("attempts");
	});

	it("web_search throws when budget flag is exhausted", async () => {
		const results: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => results.push(tool),
			getFlag: (name: string) =>
				name === "web-search-max-lookups" ? "2" : undefined,
		};
		createExtension(mockPi as any);
		const lookupTool = results.find((t: any) => t.name === "web_search");

		// Mock a successful response for the first two calls.
		mockTinyFishSearchQuery.mockResolvedValue({
			query: "test",
			results: [],
			total_results: 0,
			page: 1,
		});
		mockReserve.mockResolvedValue("allowed");

		await expect(lookupTool.execute("1", { query: "a" })).resolves.toBeTruthy();
		await expect(lookupTool.execute("2", { query: "b" })).resolves.toBeTruthy();
		await expect(lookupTool.execute("3", { query: "c" })).rejects.toThrow(
			"web_search budget exhausted",
		);
	});

	it("web_search includes remaining budget in results when capped", async () => {
		const results: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => results.push(tool),
			getFlag: (name: string) =>
				name === "web-search-max-lookups" ? "2" : undefined,
		};
		createExtension(mockPi as any);
		const lookupTool = results.find((t: any) => t.name === "web_search");

		mockTinyFishSearchQuery.mockResolvedValue({
			query: "test",
			results: [],
			total_results: 0,
			page: 1,
		});
		mockReserve.mockResolvedValue("allowed");

		const res = await lookupTool.execute("1", { query: "a" });
		const text = res.content[0].text as string;
		expect(text).toContain("[Search budget: 1/2 calls used");
	});

	it("fetch_web throws when budget flag is exhausted", async () => {
		const results: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => results.push(tool),
			getFlag: (name: string) =>
				name === "web-search-max-fetches" ? "1" : undefined,
		};
		createExtension(mockPi as any);
		const fetchTool = results.find((t: any) => t.name === "fetch_web");

		// First call succeeds (Readability fetch).
		await expect(
			fetchTool.execute("1", { url: "https://example.com/a" }),
		).resolves.toBeTruthy();
		await expect(
			fetchTool.execute("2", { url: "https://example.com/b" }),
		).rejects.toThrow("fetch_web budget exhausted");
	});

	it("web_search is unlimited when budget flag is absent", async () => {
		const results: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => results.push(tool),
		};
		createExtension(mockPi as any);
		const lookupTool = results.find((t: any) => t.name === "web_search");

		mockTinyFishSearchQuery.mockResolvedValue({
			query: "test",
			results: [],
			total_results: 0,
			page: 1,
		});
		mockReserve.mockResolvedValue("allowed");

		await expect(lookupTool.execute("1", { query: "a" })).resolves.toBeTruthy();
		const res = await lookupTool.execute("2", { query: "b" });
		const text = res.content[0].text as string;
		expect(text).not.toContain("[Search budget:");
	});
});
