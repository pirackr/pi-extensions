/**
 * Engine selection for web_lookup:
 * - "auto": walk the fallback chain (Exa first, DuckDuckGo backup).
 * - "exa" / "duckduckgo": force a single engine, bypassing the chain.
 * - "tavily": opt-in engine for heavy deep research (advanced depth, needs TAVILY_API_KEY).
 * - "tinyfish": force TinyFish search (added for provider routing).
 */
export type EngineChoice =
	| "auto"
	| "tinyfish"
	| "exa"
	| "duckduckgo"
	| "tavily";

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
	format: FetchFormat;
	error: string | null;
	attempts: FetchAttempt[];
}

export interface SearchEngine {
	name: string;
	search(
		query: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<SearchResult[]>;
	isAvailable?(): boolean;
}

export interface FetchStrategy {
	name: string;
	fetch(url: string, signal?: AbortSignal): Promise<ExtractedContent | null>;
}

// ---------------------------------------------------------------------------
// Provider-keyed advanced options (typed contracts for future adapters)
// ---------------------------------------------------------------------------

/** TinyFish Search API options (mapped from searchQueryParamsSchema). */
export interface TinyFishSearchOptions {
	purpose?: string;
	location?: string;
	language?: string;
	include_domains?: string;
	exclude_domains?: string;
	after_date?: string;
	before_date?: string;
	recency_minutes?: number;
	domain_type?: "web" | "news" | "research_paper";
	pub_year_min?: number;
	pub_year_max?: number;
	page?: number;
}

/** TinyFish Fetch API options (mapped from fetchGetContentsParamsSchema). */
export interface TinyFishFetchOptions {
	purpose?: string;
	format?: "markdown" | "html" | "json";
	include_html_head?: boolean;
	links?: boolean;
	image_links?: boolean;
	ttl?: number;
	per_url_timeout_ms?: number;
	if_none_match?: string;
	if_modified_since?: string;
	include_etag_and_last_modified?: boolean;
}

/** Exa contents sub-options. */
export interface ExaTextContentsOptions {
	maxCharacters?: number;
	includeHtmlTags?: boolean;
	verbosity?: "compact" | "standard" | "full";
	includeSections?: ExaSectionTag[];
	excludeSections?: ExaSectionTag[];
}

export interface ExaHighlightsContentsOptions {
	query?: string;
	maxCharacters?: number;
}

export interface ExaSummaryContentsOptions {
	query?: string;
	schema?: Record<string, unknown>;
}

export interface ExaExtrasOptions {
	links?: number;
	imageLinks?: number;
}

export type ExaSectionTag =
	| "unspecified"
	| "header"
	| "navigation"
	| "banner"
	| "body"
	| "sidebar"
	| "footer"
	| "metadata";

export interface ExaContentsOptions {
	text?: ExaTextContentsOptions | true;
	highlights?: ExaHighlightsContentsOptions | true;
	summary?: ExaSummaryContentsOptions | true;
	livecrawl?: "never" | "fallback" | "always" | "auto" | "preferred";
	maxAgeHours?: number;
	filterEmptyResults?: boolean;
	subpages?: number;
	subpageTarget?: string | string[];
	extras?: ExaExtrasOptions;
}

export interface ExaOutputSchema {
	type: "text" | "object";
	description?: string;
	properties?: Record<string, unknown>;
	required?: string[];
}

/** Exa Search API options (subset of BaseSearchOptions applicable to our integration). */
export interface ExaSearchOptions {
	contents?: ExaContentsOptions | boolean;
	includeDomains?: string[];
	excludeDomains?: string[];
	/** @deprecated Mapped from SDK; preserved for schema parity. */
	startCrawlDate?: string;
	/** @deprecated Mapped from SDK; preserved for schema parity. */
	endCrawlDate?: string;
	startPublishedDate?: string;
	endPublishedDate?: string;
	category?:
		| "company"
		| "publication"
		| "news"
		| "personal site"
		| "financial report"
		| "people";
	includeText?: string[];
	excludeText?: string[];
	flags?: string[];
	userLocation?: string;
	modulation?: boolean;
	useAutoprompt?: boolean;
	systemPrompt?: string;
	outputSchema?: ExaOutputSchema;
	type?:
		| "keyword"
		| "neural"
		| "auto"
		| "hybrid"
		| "fast"
		| "instant"
		| "deep-lite"
		| "deep"
		| "deep-reasoning";
}

/** Tavily Search API options (subset of TavilySearchOptions applicable to our integration). */
export interface TavilySearchOptions {
	searchDepth?: "basic" | "advanced" | "fast" | "ultra-fast";
	topic?: "general" | "news" | "finance";
	days?: number;
	includeImages?: boolean;
	includeImageDescriptions?: boolean;
	includeAnswer?: boolean | "basic" | "advanced";
	includeRawContent?: false | "markdown" | "text";
	includeDomains?: string[];
	excludeDomains?: string[];
	maxTokens?: number;
	timeRange?: "year" | "month" | "week" | "day" | "y" | "m" | "w" | "d";
	chunksPerSource?: number;
	country?: string;
	startDate?: string;
	endDate?: string;
	autoParameters?: boolean;
	includeFavicon?: boolean;
	includeUsage?: boolean;
	exactMatch?: boolean;
}

/** Unified advanced-options container, keyed by provider. */
export interface AdvancedOptions {
	tinyfish?: TinyFishSearchOptions | TinyFishFetchOptions;
	exa?: ExaSearchOptions;
	tavily?: TavilySearchOptions;
}

/** Unified search request that future request-object-based adapters consume. */
export interface WebLookupRequest {
	query: string;
	limit: number;
	engine?: EngineChoice;
	advancedOptions?: {
		tinyfish?: TinyFishSearchOptions;
		exa?: ExaSearchOptions;
		tavily?: TavilySearchOptions;
	};
}

/** Unified fetch request that future request-object-based adapters consume. */
export interface FetchWebRequest {
	url: string;
	max_chars?: number;
	advancedOptions?: {
		tinyfish?: TinyFishFetchOptions;
	};
}

/** A single attempt record for fetch responses. */
export interface FetchAttempt {
	strategy: string;
	outcome: "success" | "skipped" | "failed" | "rate_limited";
	reason?: string;
}

/** The format of fetch content. */
export type FetchFormat = "markdown" | "html" | "json" | "text" | "unknown";

/** Request-object-based search engine interface for future adapters. */
export interface SearchEngineAdapter {
	name: string;
	search(
		request: WebLookupRequest,
		signal?: AbortSignal,
	): Promise<SearchResult[]>;
	/** Engines that need no API key (e.g. DuckDuckGo) set this to false. */
	requiresKey?: boolean;
}

export interface Credentials {
	tinyfish: string | null;
	exa: string | null;
	tavily: string | null;
}

export interface WebLookupContext {
	credentials: Credentials;
	config: import("./config.ts").WebSearchConfig;
	coordinator: import("./rate-limit.ts").RateLimitCoordinator;
}

/** Request-object-based fetch strategy interface for future adapters. */
export interface FetchStrategyAdapter {
	fetch(request: FetchWebRequest, signal?: AbortSignal): Promise<FetchResponse>;
}
