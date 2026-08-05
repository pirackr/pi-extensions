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
			error: null,
		};
		expect(r.strategy).toBe("s");
	});
});

import { ExaEngine } from "../extensions/web-search/engines/exa";
import {
	DuckDuckGoEngine,
	decodeDdgUrl,
	stripHtml,
} from "../extensions/web-search/engines/duckduckgo";

describe("ExaEngine", () => {
	let engine: ExaEngine;

	beforeEach(() => {
		engine = new ExaEngine();
	});

	it("isAvailable returns false when no API key", () => {
		// Temporarily clear the key
		const original = process.env.EXA_API_KEY;
		delete process.env.EXA_API_KEY;
		// Also clear cache by reloading the module behavior
		expect(engine.isAvailable()).toBe(false);
		if (original) process.env.EXA_API_KEY = original;
	});

	it("isAvailable returns true when API key exists", () => {
		process.env.EXA_API_KEY = "test-key";
		expect(engine.isAvailable()).toBe(true);
		delete process.env.EXA_API_KEY;
	});

	it("search returns empty results when no API key", async () => {
		const original = process.env.EXA_API_KEY;
		delete process.env.EXA_API_KEY;
		const results = await engine.search("test", 3);
		expect(results).toEqual([]);
		if (original) process.env.EXA_API_KEY = original;
	});

	it("clamps numResults to 1-50", async () => {
		process.env.EXA_API_KEY = "test-key";
		const bodies: any[] = [];
		const originalFetch = globalThis.fetch;
		(globalThis as any).fetch = async (_url: any, opts: any) => {
			bodies.push(JSON.parse(opts.body));
			return { ok: true, json: async () => ({ results: [] }) };
		};
		try {
			await engine.search("q", 500);
			await engine.search("q", 0);
			expect(bodies[0].numResults).toBe(50);
			expect(bodies[1].numResults).toBe(1);
		} finally {
			(globalThis as any).fetch = originalFetch;
			delete process.env.EXA_API_KEY;
		}
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

	it("search returns results with titles and URLs", async () => {
		const results = await engine.search("rust programming language", 3);
		expect(results.length).toBeGreaterThan(0);
		expect(results[0].title).toBeTruthy();
		expect(results[0].url).toBeTruthy();
		expect(results[0].engine).toBe("duckduckgo");
	});
});

import {
	resolveChain,
	searchEngines,
	webLookup,
} from "../extensions/web-search/search";

describe("search composition", () => {
	it("registers both engines with exa first (default chain)", () => {
		const names = searchEngines.map((e) => e.name);
		expect(names).toEqual(["exa", "duckduckgo"]);
	});

	describe("resolveChain", () => {
		it("defaults to the full chain (exa first)", () => {
			const names = resolveChain().map((e) => e.name);
			expect(names).toEqual(["exa", "duckduckgo"]);
		});

		it("honors explicit 'auto'", () => {
			expect(resolveChain("auto").map((e) => e.name)).toEqual([
				"exa",
				"duckduckgo",
			]);
		});

		it("forces a single engine", () => {
			expect(resolveChain("exa").map((e) => e.name)).toEqual(["exa"]);
			expect(resolveChain("duckduckgo").map((e) => e.name)).toEqual([
				"duckduckgo",
			]);
		});

		it("degrades unknown choices to the default chain", () => {
			expect(resolveChain("bogus" as any).map((e) => e.name)).toEqual([
				"exa",
				"duckduckgo",
			]);
		});
	});

	describe("webLookup chain behavior", () => {
		// These tests assume no EXA_API_KEY is set: the fs mock neutralizes .env
		// and we clear the env var explicitly so Exa is always skipped.
		const originalKey = process.env.EXA_API_KEY;
		beforeEach(() => {
			delete process.env.EXA_API_KEY;
		});
		afterEach(() => {
			if (originalKey) process.env.EXA_API_KEY = originalKey;
		});

		it("falls back to DuckDuckGo when Exa is unavailable", async () => {
			const result = await webLookup("rust programming language", 3);
			expect(result.query).toBe("rust programming language");
			expect(result.results.length).toBeGreaterThan(0);
			// Exa skipped (no key), DuckDuckGo served the results.
			expect(result.engines).toEqual(["duckduckgo"]);
			expect(result.partialFailures.some((pf) => pf.engine === "exa")).toBe(
				true,
			);
		});

		it("honors a forced engine choice", async () => {
			const result = await webLookup(
				"rust programming language",
				3,
				undefined,
				"duckduckgo",
			);
			expect(result.engines).toEqual(["duckduckgo"]);
			expect(result.results.length).toBeGreaterThan(0);
		});

		it("forced exa with no key returns no results and reports the skip", async () => {
			const result = await webLookup(
				"rust programming language",
				3,
				undefined,
				"exa",
			);
			expect(result.results).toEqual([]);
			expect(result.engines).toEqual([]);
			expect(result.partialFailures.some((pf) => pf.engine === "exa")).toBe(
				true,
			);
		});
	});

	it("webLookup deduplicates by URL", async () => {
		const result = await webLookup("rust programming language", 5);
		const urls = result.results.map((r) => r.url);
		const uniqueUrls = new Set(urls);
		expect(urls.length).toBe(uniqueUrls.size);
	});
});

import { ReadabilityStrategy } from "../extensions/web-search/strategies/readability";

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
	it("registers web_lookup tool", () => {
		const registered: string[] = [];
		const mockPi = {
			registerTool: (tool: { name: string }) => registered.push(tool.name),
		};
		createExtension(mockPi as any);
		expect(registered).toContain("web_lookup");
	});

	it("registers fetch_web tool", () => {
		const registered: string[] = [];
		const mockPi = {
			registerTool: (tool: { name: string }) => registered.push(tool.name),
		};
		createExtension(mockPi as any);
		expect(registered).toContain("fetch_web");
	});

	it("web_lookup returns SearchResponse shape", async () => {
		const results: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => results.push(tool),
		};
		createExtension(mockPi as any);
		const lookupTool = results.find((t: any) => t.name === "web_lookup");
		expect(lookupTool).toBeDefined();

		const res = await lookupTool.execute("test-id", { query: "rust async" });
		expect(res.content).toHaveLength(1);
		expect(res.content[0].type).toBe("text");
		expect(res.details).toHaveProperty("query");
		expect(res.details).toHaveProperty("results");
		expect(res.details).toHaveProperty("engines");
		expect(res.details).toHaveProperty("partialFailures");
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
		expect(res.details).toHaveProperty("error");
	});
});
