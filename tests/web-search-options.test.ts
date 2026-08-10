import { Errors } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	TinyFishSearchOptionsSchema,
	TinyFishFetchOptionsSchema,
} from "../extensions/web-search/options/tinyfish.ts";
import {
	ExaSearchOptionsSchema,
	ExaContentsOptionsSchema,
	ExaOutputSchemaSchema,
} from "../extensions/web-search/options/exa.ts";
import { TavilySearchOptionsSchema } from "../extensions/web-search/options/tavily.ts";
import {
	validateTinyFishSearchOptions,
	validateTinyFishFetchOptions,
	validateExaSearchOptions,
	validateTavilySearchOptions,
} from "../extensions/web-search/options/validate.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collect TypeBox Errors output into an errors array. Returns [] when valid. */
function schemaErrors(schema: any, value: unknown): string[] {
	const result = Errors(schema, value);
	if (result.length === 0) return [];
	return (result as Array<{ keyword: string; instancePath: string; message: string }>).map(
		(e) => `${e.keyword} ${e.instancePath || "/"} ${e.message}`,
	);
}

function assertValid(schema: any, value: unknown, label: string) {
	const errs = schemaErrors(schema, value);
	if (errs.length > 0) {
		throw new Error(`${label}: unexpected schema errors: ${errs.join("; ")}`);
	}
}

function assertInvalid(schema: any, value: unknown, label: string) {
	const errs = schemaErrors(schema, value);
	if (errs.length === 0) {
		throw new Error(`${label}: expected schema to reject but it accepted`);
	}
}

// ---------------------------------------------------------------------------
// Accepted provider fields — schema passes
// ---------------------------------------------------------------------------

describe("TinyFishSearchOptionsSchema", () => {
	it("accepts empty object", () => {
		assertValid(TinyFishSearchOptionsSchema, {}, "empty");
	});

	it("accepts all valid fields", () => {
		assertValid(TinyFishSearchOptionsSchema, {
			purpose: "find recent papers",
			location: "US",
			language: "en",
			include_domains: "arxiv.org",
			exclude_domains: "facebook.com",
			after_date: "2024-01-01",
			before_date: "2024-12-31",
			recency_minutes: 60,
			domain_type: "news",
			pub_year_min: 2020,
			pub_year_max: 2024,
			page: 2,
		}, "all fields");
	});

	it("accepts research_paper domain_type with year range", () => {
		assertValid(TinyFishSearchOptionsSchema, {
			domain_type: "research_paper",
			pub_year_min: 2019,
			pub_year_max: 2024,
		}, "research_paper with years");
	});
});

describe("TinyFishFetchOptionsSchema", () => {
	it("accepts empty object", () => {
		assertValid(TinyFishFetchOptionsSchema, {}, "empty");
	});

	it("accepts all valid fields", () => {
		assertValid(TinyFishFetchOptionsSchema, {
			purpose: "extract article",
			format: "markdown",
			include_html_head: true,
			links: true,
			image_links: false,
			ttl: 300,
			per_url_timeout_ms: 10000,
			include_etag_and_last_modified: true,
		}, "all fields");
	});

	it("accepts json format", () => {
		assertValid(TinyFishFetchOptionsSchema, { format: "json" }, "json format");
	});
});

describe("ExaSearchOptionsSchema", () => {
	it("accepts empty object", () => {
		assertValid(ExaSearchOptionsSchema, {}, "empty");
	});

	it("accepts all valid top-level fields", () => {
		assertValid(ExaSearchOptionsSchema, {
			includeDomains: ["example.com"],
			excludeDomains: ["spam.com"],
			startPublishedDate: "2024-01-01",
			endPublishedDate: "2024-12-31",
			category: "news",
			includeText: ["rust"],
			excludeText: ["clickbait"],
			flags: ["experimental"],
			userLocation: "US",
			modulation: true,
			useAutoprompt: true,
			systemPrompt: "be concise",
			type: "neural",
		}, "top-level fields");
	});

	it("accepts contents with text: true", () => {
		assertValid(ExaSearchOptionsSchema, {
			contents: true,
		}, "contents true");
	});

	it("accepts contents with text object", () => {
		assertValid(ExaSearchOptionsSchema, {
			contents: {
				text: { maxCharacters: 500, verbosity: "compact" },
				maxAgeHours: 0,
			},
		}, "contents text object");
	});

	it("accepts outputSchema type=text", () => {
		assertValid(ExaSearchOptionsSchema, {
			outputSchema: { type: "text", description: "a summary" },
		}, "outputSchema text");
	});

	it("accepts outputSchema type=object with <=10 properties", () => {
		assertValid(ExaSearchOptionsSchema, {
			outputSchema: {
				type: "object",
				properties: { a: {}, b: {} },
				required: ["a"],
			},
		}, "outputSchema object");
	});
});

describe("TavilySearchOptionsSchema", () => {
	it("accepts empty object", () => {
		assertValid(TavilySearchOptionsSchema, {}, "empty");
	});

	it("accepts all valid fields", () => {
		assertValid(TavilySearchOptionsSchema, {
			searchDepth: "advanced",
			topic: "news",
			days: 7,
			includeImages: true,
			includeImageDescriptions: true,
			includeAnswer: "advanced",
			includeRawContent: "markdown",
			includeDomains: ["example.com"],
			excludeDomains: ["spam.com"],
			maxTokens: 500,
			timeRange: "week",
			chunksPerSource: 3,
			country: "US",
			autoParameters: true,
			includeFavicon: true,
			includeUsage: true,
			exactMatch: true,
		}, "all fields");
	});

	it("accepts includeRawContent=false", () => {
		assertValid(TavilySearchOptionsSchema, {
			includeRawContent: false,
			searchDepth: "basic",
		}, "includeRawContent false with basic depth");
	});
});

// ---------------------------------------------------------------------------
// Unknown-field rejection
// ---------------------------------------------------------------------------

describe("unknown fields are rejected", () => {
	it("TinyFishSearch rejects unknown field", () => {
		const errs = schemaErrors(TinyFishSearchOptionsSchema, {
			bogus_field: true,
		});
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});

	it("TinyFishFetch rejects unknown field", () => {
		const errs = schemaErrors(TinyFishFetchOptionsSchema, {
			bogus_field: true,
		});
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});

	it("ExaSearch rejects unknown field", () => {
		const errs = schemaErrors(ExaSearchOptionsSchema, {
			bogus_field: true,
		});
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});

	it("TavilySearch rejects unknown field", () => {
		const errs = schemaErrors(TavilySearchOptionsSchema, {
			bogus_field: true,
		});
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Canonical-field exclusion (query/limit/url/auth rejected inside advancedOptions)
// ---------------------------------------------------------------------------

describe("canonical fields are excluded from advancedOptions schemas", () => {
	it("TinyFishSearch rejects query", () => {
		const errs = schemaErrors(TinyFishSearchOptionsSchema, { query: "rust" });
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});

	it("TinyFishSearch rejects limit", () => {
		const errs = schemaErrors(TinyFishSearchOptionsSchema, { limit: 10 });
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});

	it("TinyFishFetch rejects url", () => {
		const errs = schemaErrors(TinyFishFetchOptionsSchema, { url: "https://example.com" });
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});

	it("TinyFishSearch rejects api_key", () => {
		const errs = schemaErrors(TinyFishSearchOptionsSchema, { api_key: "sk-xxx" });
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});

	it("TinyFishFetch rejects authorization", () => {
		const errs = schemaErrors(TinyFishFetchOptionsSchema, { authorization: "Bearer xxx" });
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});

	it("ExaSearch rejects query", () => {
		const errs = schemaErrors(ExaSearchOptionsSchema, { query: "rust" });
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});

	it("ExaSearch rejects numResults (canonical limit)", () => {
		const errs = schemaErrors(ExaSearchOptionsSchema, { numResults: 10 });
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});

	it("ExaSearch rejects api_key", () => {
		const errs = schemaErrors(ExaSearchOptionsSchema, { api_key: "exa-xxx" });
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});

	it("TavilySearch rejects query", () => {
		const errs = schemaErrors(TavilySearchOptionsSchema, { query: "rust" });
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});

	it("TavilySearch rejects maxResults (canonical limit)", () => {
		const errs = schemaErrors(TavilySearchOptionsSchema, { maxResults: 10 });
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});

	it("TavilySearch rejects api_key", () => {
		const errs = schemaErrors(TavilySearchOptionsSchema, { api_key: "tvly-xxx" });
		expect(errs.some((e) => e.includes("additionalProperties"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// TinyFish cross-field validation
// ---------------------------------------------------------------------------

describe("TinyFishSearch cross-field constraints", () => {
	it("rejects recency_minutes with after_date", () => {
		const errs = validateTinyFishSearchOptions({
			recency_minutes: 60,
			after_date: "2024-01-01",
		});
		expect(errs.some((e) => e.message.includes("mutually exclusive"))).toBe(true);
	});

	it("rejects recency_minutes with before_date", () => {
		const errs = validateTinyFishSearchOptions({
			recency_minutes: 30,
			before_date: "2024-12-31",
		});
		expect(errs.some((e) => e.message.includes("mutually exclusive"))).toBe(true);
	});

	it("accepts recency_minutes without calendar dates", () => {
		const errs = validateTinyFishSearchOptions({ recency_minutes: 60 });
		expect(errs).toEqual([]);
	});

	it("accepts after_date/before_date without recency_minutes", () => {
		const errs = validateTinyFishSearchOptions({
			after_date: "2024-01-01",
			before_date: "2024-12-31",
		});
		expect(errs).toEqual([]);
	});

	it("rejects pub_year_min > pub_year_max", () => {
		const errs = validateTinyFishSearchOptions({
			pub_year_min: 2024,
			pub_year_max: 2020,
		});
		expect(errs.some((e) => e.message.includes("pub_year_min"))).toBe(true);
	});

	it("accepts pub_year_min <= pub_year_max", () => {
		const errs = validateTinyFishSearchOptions({
			pub_year_min: 2020,
			pub_year_max: 2024,
		});
		expect(errs).toEqual([]);
	});

	it("rejects after_date after before_date", () => {
		const errs = validateTinyFishSearchOptions({
			after_date: "2024-12-31",
			before_date: "2024-01-01",
		});
		expect(errs.some((e) => e.message.includes("after_date"))).toBe(true);
	});

	it("accepts after_date equal to before_date", () => {
		const errs = validateTinyFishSearchOptions({
			after_date: "2024-06-15",
			before_date: "2024-06-15",
		});
		expect(errs).toEqual([]);
	});

	it("accepts after_date before before_date", () => {
		const errs = validateTinyFishSearchOptions({
			after_date: "2024-01-01",
			before_date: "2024-12-31",
		});
		expect(errs).toEqual([]);
	});

	it("rejects research_paper with after_date", () => {
		const errs = validateTinyFishSearchOptions({
			domain_type: "research_paper",
			after_date: "2024-01-01",
		});
		expect(errs.some((e) => e.message.includes("research_paper"))).toBe(true);
	});

	it("rejects research_paper with before_date", () => {
		const errs = validateTinyFishSearchOptions({
			domain_type: "research_paper",
			before_date: "2024-12-31",
		});
		expect(errs.some((e) => e.message.includes("research_paper"))).toBe(true);
	});

	it("accepts research_paper with pub_year range", () => {
		const errs = validateTinyFishSearchOptions({
			domain_type: "research_paper",
			pub_year_min: 2019,
			pub_year_max: 2024,
		});
		expect(errs).toEqual([]);
	});
});

describe("TinyFishFetch cross-field constraints", () => {
	it("rejects if_none_match with if_modified_since", () => {
		const errs = validateTinyFishFetchOptions({
			if_none_match: "abc123",
			if_modified_since: "2024-01-01",
		});
		expect(errs.some((e) => e.message.includes("mutually exclusive"))).toBe(true);
	});

	it("accepts if_none_match alone", () => {
		const errs = validateTinyFishFetchOptions({ if_none_match: "abc123" });
		expect(errs).toEqual([]);
	});

	it("accepts if_modified_since alone", () => {
		const errs = validateTinyFishFetchOptions({ if_modified_since: "2024-01-01" });
		expect(errs).toEqual([]);
	});

	it("accepts neither validator", () => {
		const errs = validateTinyFishFetchOptions({});
		expect(errs).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Exa cross-field validation
// ---------------------------------------------------------------------------

describe("ExaSearch cross-field constraints", () => {
	it("rejects includeText entry with >5 words", () => {
		const errs = validateExaSearchOptions({
			includeText: ["this has too many words here now"],
		});
		expect(errs.some((e) => e.path.includes("includeText"))).toBe(true);
	});

	it("accepts includeText entry with <=5 words", () => {
		const errs = validateExaSearchOptions({
			includeText: ["rust programming"],
		});
		expect(errs).toEqual([]);
	});

	it("rejects excludeText entry with >5 words", () => {
		const errs = validateExaSearchOptions({
			excludeText: ["clickbait title here now plus more"],
		});
		expect(errs.some((e) => e.path.includes("excludeText"))).toBe(true);
	});

	it("rejects contents.text verbosity without maxAgeHours:0", () => {
		const errs = validateExaSearchOptions({
			contents: {
				text: { verbosity: "full" },
			},
		});
		expect(errs.some((e) => e.message.includes("maxAgeHours"))).toBe(true);
	});

	it("accepts contents.text verbosity with maxAgeHours:0", () => {
		const errs = validateExaSearchOptions({
			contents: {
				text: { verbosity: "full" },
				maxAgeHours: 0,
			},
		});
		expect(errs).toEqual([]);
	});

	it("rejects contents.text includeSections without maxAgeHours:0", () => {
		const errs = validateExaSearchOptions({
			contents: {
				text: { includeSections: ["body"] },
			},
		});
		expect(errs.some((e) => e.message.includes("maxAgeHours"))).toBe(true);
	});

	it("accepts outputSchema object with <=10 properties", () => {
		const errs = validateExaSearchOptions({
			outputSchema: {
				type: "object",
				properties: { a: {}, b: {}, c: {}, d: {}, e: {}, f: {}, g: {}, h: {}, i: {}, j: {} },
			},
		});
		expect(errs).toEqual([]);
	});

	it("rejects outputSchema object with >10 properties", () => {
		const props: Record<string, unknown> = {};
		for (let i = 0; i < 11; i++) props[`p${i}`] = {};
		const errs = validateExaSearchOptions({
			outputSchema: { type: "object", properties: props },
		});
		expect(errs.some((e) => e.message.includes("10 properties"))).toBe(true);
	});

	// Exa category/filter incompatibilities (company/people disable date, text, and domain filters)
	it("rejects includeText with category=company", () => {
		const errs = validateExaSearchOptions({
			category: "company",
			includeText: ["rust"],
		});
		expect(errs.some((e) => e.message.includes("category"))).toBe(true);
	});

	it("rejects includeText with category=people", () => {
		const errs = validateExaSearchOptions({
			category: "people",
			includeText: ["rust"],
		});
		expect(errs.some((e) => e.message.includes("category"))).toBe(true);
	});

	it("rejects excludeText with category=company", () => {
		const errs = validateExaSearchOptions({
			category: "company",
			excludeText: ["clickbait"],
		});
		expect(errs.some((e) => e.message.includes("category"))).toBe(true);
	});

	it("rejects excludeDomains with category=people", () => {
		const errs = validateExaSearchOptions({
			category: "people",
			excludeDomains: ["spam.com"],
		});
		expect(errs.some((e) => e.message.includes("category"))).toBe(true);
	});

	it("rejects startPublishedDate with category=company", () => {
		const errs = validateExaSearchOptions({
			category: "company",
			startPublishedDate: "2024-01-01",
		});
		expect(errs.some((e) => e.message.includes("category"))).toBe(true);
	});

	it("rejects endPublishedDate with category=people", () => {
		const errs = validateExaSearchOptions({
			category: "people",
			endPublishedDate: "2024-12-31",
		});
		expect(errs.some((e) => e.message.includes("category"))).toBe(true);
	});

	it("accepts includeText with category=news", () => {
		const errs = validateExaSearchOptions({
			category: "news",
			includeText: ["rust"],
		});
		expect(errs).toEqual([]);
	});

	it("accepts excludeDomains with category=publication", () => {
		const errs = validateExaSearchOptions({
			category: "publication",
			excludeDomains: ["spam.com"],
		});
		expect(errs).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Tavily cross-field validation
// ---------------------------------------------------------------------------

describe("TavilySearch cross-field constraints", () => {
	it("rejects days with timeRange", () => {
		const errs = validateTavilySearchOptions({ days: 7, timeRange: "week" });
		expect(errs.some((e) => e.message.includes("mutually exclusive"))).toBe(true);
	});

	it("accepts days alone", () => {
		const errs = validateTavilySearchOptions({ days: 7 });
		expect(errs).toEqual([]);
	});

	it("accepts timeRange alone", () => {
		const errs = validateTavilySearchOptions({ timeRange: "week" });
		expect(errs).toEqual([]);
	});

	it("rejects startDate with days", () => {
		const errs = validateTavilySearchOptions({ startDate: "2024-01-01", days: 7 });
		expect(errs.some((e) => e.message.includes("startDate"))).toBe(true);
	});

	it("rejects startDate with timeRange", () => {
		const errs = validateTavilySearchOptions({ startDate: "2024-01-01", timeRange: "week" });
		expect(errs.some((e) => e.message.includes("startDate"))).toBe(true);
	});

	it("rejects endDate with days", () => {
		const errs = validateTavilySearchOptions({ endDate: "2024-12-31", days: 7 });
		expect(errs.some((e) => e.message.includes("endDate"))).toBe(true);
	});

	it("rejects endDate with timeRange", () => {
		const errs = validateTavilySearchOptions({ endDate: "2024-12-31", timeRange: "week" });
		expect(errs.some((e) => e.message.includes("endDate"))).toBe(true);
	});

	it("accepts startDate and endDate together", () => {
		const errs = validateTavilySearchOptions({
			startDate: "2024-01-01",
			endDate: "2024-12-31",
		});
		expect(errs).toEqual([]);
	});

	it("rejects includeRawContent with basic depth", () => {
		const errs = validateTavilySearchOptions({
			includeRawContent: "markdown",
			searchDepth: "basic",
		});
		expect(errs.some((e) => e.message.includes("includeRawContent"))).toBe(true);
	});

	it("accepts includeRawContent with advanced depth", () => {
		const errs = validateTavilySearchOptions({
			includeRawContent: "markdown",
			searchDepth: "advanced",
		});
		expect(errs).toEqual([]);
	});

	it("accepts includeRawContent false with any depth", () => {
		const errs = validateTavilySearchOptions({
			includeRawContent: false,
			searchDepth: "basic",
		});
		expect(errs).toEqual([]);
	});

	it("rejects includeAnswer advanced without advanced depth", () => {
		const errs = validateTavilySearchOptions({
			includeAnswer: "advanced",
			searchDepth: "basic",
		});
		expect(errs.some((e) => e.message.includes("includeAnswer"))).toBe(true);
	});

	it("accepts includeAnswer advanced with advanced depth", () => {
		const errs = validateTavilySearchOptions({
			includeAnswer: "advanced",
			searchDepth: "advanced",
		});
		expect(errs).toEqual([]);
	});

	it("accepts includeAnswer basic with any depth", () => {
		const errs = validateTavilySearchOptions({
			includeAnswer: "basic",
			searchDepth: "basic",
		});
		expect(errs).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Schema-to-reference coverage assertion
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("schema-to-reference coverage", () => {
	it("every accepted TinyFishSearchOptionsSchema property appears in the provider-options doc", () => {
		const docPath = resolve(import.meta.dirname, "../docs/web-search-provider-options.md");
		const doc = readFileSync(docPath, "utf-8");
		const props = [
			"advancedOptions.tinyfish.purpose",
			"advancedOptions.tinyfish.location",
			"advancedOptions.tinyfish.language",
			"advancedOptions.tinyfish.include_domains",
			"advancedOptions.tinyfish.exclude_domains",
			"advancedOptions.tinyfish.after_date",
			"advancedOptions.tinyfish.before_date",
			"advancedOptions.tinyfish.recency_minutes",
			"advancedOptions.tinyfish.domain_type",
			"advancedOptions.tinyfish.pub_year_min",
			"advancedOptions.tinyfish.pub_year_max",
			"advancedOptions.tinyfish.page",
		];
		const missing = props.filter((p) => !doc.includes(p));
		if (missing.length > 0) throw new Error(`Missing from doc: ${missing.join(", ")}`);
	});

	it("every accepted TinyFishFetchOptionsSchema property appears in the provider-options doc", () => {
		const docPath = resolve(import.meta.dirname, "../docs/web-search-provider-options.md");
		const doc = readFileSync(docPath, "utf-8");
		const props = [
			"advancedOptions.tinyfish.purpose",
			"advancedOptions.tinyfish.format",
			"advancedOptions.tinyfish.include_html_head",
			"advancedOptions.tinyfish.links",
			"advancedOptions.tinyfish.image_links",
			"advancedOptions.tinyfish.ttl",
			"advancedOptions.tinyfish.per_url_timeout_ms",
			"advancedOptions.tinyfish.if_none_match",
			"advancedOptions.tinyfish.if_modified_since",
			"advancedOptions.tinyfish.include_etag_and_last_modified",
		];
		const missing = props.filter((p) => !doc.includes(p));
		if (missing.length > 0) throw new Error(`Missing from doc: ${missing.join(", ")}`);
	});

	it("every accepted ExaSearchOptionsSchema property appears in the provider-options doc", () => {
		const docPath = resolve(import.meta.dirname, "../docs/web-search-provider-options.md");
		const doc = readFileSync(docPath, "utf-8");
		const props = [
			"advancedOptions.exa.contents",
			"advancedOptions.exa.contents.text",
			"advancedOptions.exa.contents.highlights",
			"advancedOptions.exa.contents.summary",
			"advancedOptions.exa.contents.livecrawl",
			"advancedOptions.exa.contents.maxAgeHours",
			"advancedOptions.exa.contents.filterEmptyResults",
			"advancedOptions.exa.contents.subpages",
			"advancedOptions.exa.contents.subpageTarget",
			"advancedOptions.exa.contents.extras",
			"advancedOptions.exa.includeDomains",
			"advancedOptions.exa.excludeDomains",
			"advancedOptions.exa.startCrawlDate",
			"advancedOptions.exa.endCrawlDate",
			"advancedOptions.exa.startPublishedDate",
			"advancedOptions.exa.endPublishedDate",
			"advancedOptions.exa.category",
			"advancedOptions.exa.includeText",
			"advancedOptions.exa.excludeText",
			"advancedOptions.exa.flags",
			"advancedOptions.exa.userLocation",
			"advancedOptions.exa.modulation",
			"advancedOptions.exa.useAutoprompt",
			"advancedOptions.exa.systemPrompt",
			"advancedOptions.exa.outputSchema",
			"advancedOptions.exa.type",
		];
		const missing = props.filter((p) => !doc.includes(p));
		if (missing.length > 0) throw new Error(`Missing from doc: ${missing.join(", ")}`);
	});

	it("every accepted TavilySearchOptionsSchema property appears in the provider-options doc", () => {
		const docPath = resolve(import.meta.dirname, "../docs/web-search-provider-options.md");
		const doc = readFileSync(docPath, "utf-8");
		const props = [
			"advancedOptions.tavily.searchDepth",
			"advancedOptions.tavily.topic",
			"advancedOptions.tavily.days",
			"advancedOptions.tavily.includeImages",
			"advancedOptions.tavily.includeImageDescriptions",
			"advancedOptions.tavily.includeAnswer",
			"advancedOptions.tavily.includeRawContent",
			"advancedOptions.tavily.includeDomains",
			"advancedOptions.tavily.excludeDomains",
			"advancedOptions.tavily.maxTokens",
			"advancedOptions.tavily.timeRange",
			"advancedOptions.tavily.chunksPerSource",
			"advancedOptions.tavily.country",
			"advancedOptions.tavily.startDate",
			"advancedOptions.tavily.endDate",
			"advancedOptions.tavily.autoParameters",
			"advancedOptions.tavily.includeFavicon",
			"advancedOptions.tavily.includeUsage",
			"advancedOptions.tavily.exactMatch",
		];
		const missing = props.filter((p) => !doc.includes(p));
		if (missing.length > 0) throw new Error(`Missing from doc: ${missing.join(", ")}`);
	});
});
