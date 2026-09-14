// extensions/web-search/index.ts
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { webLookup } from "./search.ts";
import { fetchWeb } from "./fetch.ts";
import {
	TinyFishSearchOptionsSchema,
	TinyFishFetchOptionsSchema,
} from "./options/tinyfish.ts";
import { ExaSearchOptionsSchema } from "./options/exa.ts";
import { TavilySearchOptionsSchema } from "./options/tavily.ts";
import { getNativeWebStatus, tryNativeSearch } from "./native.ts";
import {
	validateExaSearchOptions,
	validateTavilySearchOptions,
	validateTinyFishSearchOptions,
} from "./options/validate.ts";

export const fetchStrategies: import("./types.ts").FetchStrategy[] = [];

/**
 * Parse a positive-integer budget from a CLI flag value. 0/absent/NaN = unlimited.
 * The tmux-subagent runner passes --web-search-max-lookups/--web-search-max-fetches
 * to the child pi process so each subagent that receives this extension gets a
 * hard cap on search calls, passed directly (no env vars).
 */
function parseBudgetFlag(value: boolean | string | undefined): number {
	if (typeof value !== "string" || !value.trim()) return 0;
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

const PI_TOOL_OUTPUT_SAFETY_LIMIT = 100_000;
const NATIVE_WEB_STATUS_KEY = "web-search";

type StatusContext = {
	model?: Parameters<typeof getNativeWebStatus>[0];
	ui?: { setStatus?: (key: string, text: string | undefined) => void };
};

function registerNativeWebStatus(pi: ExtensionAPI): void {
	if (typeof pi.on !== "function") return;
	pi.on("session_start", (_event, context) => {
		const ctx = context as StatusContext;
		ctx.ui?.setStatus?.(NATIVE_WEB_STATUS_KEY, getNativeWebStatus(ctx.model));
	});
	pi.on("model_select", (event, context) => {
		const ctx = context as StatusContext;
		ctx.ui?.setStatus?.(NATIVE_WEB_STATUS_KEY, getNativeWebStatus(event.model ?? ctx.model));
	});
	pi.on("session_shutdown", (_event, context) => {
		(context as StatusContext).ui?.setStatus?.(NATIVE_WEB_STATUS_KEY, undefined);
	});
}

function validateSearchRequest(params: any): void {
	if (typeof params?.query !== "string" || !params.query.trim()) throw new Error("query must be a non-empty string");
	if (params.limit !== undefined && (typeof params.limit !== "number" || !Number.isFinite(params.limit))) throw new Error("limit must be a finite number");
	if (params.engine !== undefined && !["auto", "tinyfish", "exa", "duckduckgo", "tavily"].includes(params.engine)) throw new Error("unsupported search engine");
	validateSearchAdvancedOptions(params.advancedOptions);
}

function validateSearchAdvancedOptions(advancedOptions: unknown): void {
	if (advancedOptions === undefined) return;
	if (!advancedOptions || typeof advancedOptions !== "object" || Array.isArray(advancedOptions)) {
		throw new Error("advancedOptions must be an object");
	}
	const options = advancedOptions as Record<string, unknown>;
	for (const key of Object.keys(options)) {
		if (key !== "tinyfish" && key !== "exa" && key !== "tavily") throw new Error(`unknown advancedOptions provider: ${key}`);
	}
	const validators = {
		tinyfish: validateTinyFishSearchOptions,
		exa: validateExaSearchOptions,
		tavily: validateTavilySearchOptions,
	} as const;
	for (const key of Object.keys(validators) as Array<keyof typeof validators>) {
		const value = options[key];
		if (value === undefined) continue;
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`advancedOptions.${key} must be an object`);
		const errors = validators[key](value as Record<string, unknown>);
		if (errors.length) throw new Error(`invalid advancedOptions.${key}: ${errors.map((error) => error.message).join("; ")}`);
	}
}

function budgetLine(used: number, max: number): string {
	return `[Search budget: ${used}/${max} calls used — ${max - used} remaining]`;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag?.("web-search-max-lookups", {
		description:
			"Hard cap on web_search calls per process. Passed by the tmux-subagent runner; 0/unset = unlimited.",
		type: "string",
	});
	pi.registerFlag?.("web-search-max-fetches", {
		description:
			"Hard cap on fetch_web calls per process. Passed by the tmux-subagent runner; 0/unset = unlimited.",
		type: "string",
	});

	registerNativeWebStatus(pi);

	// Per-process counters: each subagent runs in its own pi process, so this
	// closure state is naturally a per-subagent budget.
	let lookupCalls = 0;
	let fetchCalls = 0;
	const maxLookups = () =>
		parseBudgetFlag(pi.getFlag?.("web-search-max-lookups"));
	const maxFetches = () =>
		parseBudgetFlag(pi.getFlag?.("web-search-max-fetches"));

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web. Automatically attempts supported provider-native search first, then falls back to TinyFish, Exa, and DuckDuckGo. " +
			"Pass engine to force a specific engine ('tinyfish', 'exa', 'duckduckgo', or 'tavily' for heavy deep research — runs alone, needs TAVILY_API_KEY). " +
			"For engine:auto without advancedOptions, verified official OpenAI Responses, Codex Responses, and Anthropic models make one isolated native search attempt before the client fallback chain. " +
			"Explicit engines and any provider-specific advancedOptions use client-only routing so options are never ignored. Unknown provider keys are rejected. " +
			"Returns search results with title, URL, and snippet. " +
			"Use for finding documentation, facts, code examples, or discovering relevant pages.",
		parameters: Type.Object({
			query: Type.String({ description: "Search query string" }),
			limit: Type.Optional(
				Type.Number({
					description: "Max results per engine, 1-50. Defaults to 20 if omitted.",
				}),
			),
			engine: Type.Optional(
				Type.Union(
					[
						Type.Literal("auto"),
						Type.Literal("tinyfish"),
						Type.Literal("exa"),
						Type.Literal("duckduckgo"),
						Type.Literal("tavily"),
					],
					{
						description:
							"Engine to use: 'auto' (default) attempts supported native search first unless advancedOptions are provided, then uses TinyFish, Exa, and DuckDuckGo as client fallbacks. " +
							"'tinyfish', 'exa', or 'duckduckgo' force a single engine; 'tavily' runs Tavily alone (advanced depth, requires TAVILY_API_KEY) for heavy research.",
					},
				),
			),
			advancedOptions: Type.Optional(
				Type.Object(
					{
						tinyfish: Type.Optional(TinyFishSearchOptionsSchema),
						exa: Type.Optional(ExaSearchOptionsSchema),
						tavily: Type.Optional(TavilySearchOptionsSchema),
					},
					{ additionalProperties: false },
				),
			),
		}),
		async execute(_id: string, params: any, signal?: AbortSignal, _onUpdate?: unknown, ctx?: any) {
			validateSearchRequest(params);
			signal?.throwIfAborted();
			const max = maxLookups();
			if (max > 0 && lookupCalls >= max) {
				throw new Error(
					`web_search budget exhausted: ${lookupCalls}/${max} searches used. ` +
						"Stop searching and write your report from the results already collected.",
				);
			}
			lookupCalls += 1;
			const limit = Math.min(Math.max(params.limit ?? 20, 1), 50);
			const request = {
				query: params.query,
				limit,
				engine: params.engine,
				advancedOptions: params.advancedOptions,
			};
			if (signal) (request as any).__signal = signal;
			let nativeUsage: unknown;
			let nativeFailure: { engine: string; error: string } | undefined;
			let result;
			const nativeEligible = (!params.engine || params.engine === "auto") && params.advancedOptions === undefined;
			if (nativeEligible) {
				const native = await tryNativeSearch(params.query, limit, ctx, signal);
				nativeUsage = native.usage;
				nativeFailure = native.failure;
				result = native.response;
			}
			signal?.throwIfAborted();
			if (!result) result = await webLookup(request);
			if (nativeFailure) result = { ...result, partialFailures: [nativeFailure, ...result.partialFailures] };

			let text = `Query: "${result.query}"\n`;
			text += `Engines: ${result.engines.join(", ") || "none"}\n`;
			text += `Total results: ${result.results.length}\n\n`;
			if (result.results.length) {
				result.results.forEach((r, i) => {
					text += `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}\n   [${r.engine}]\n\n`;
				});
			}
			if (result.partialFailures.length) {
				text += `Partial failures: ${result.partialFailures.length}\n`;
				for (const pf of result.partialFailures) {
					text += `  - ${pf.engine}: ${pf.error}\n`;
				}
			}
			if (max > 0) text += `\n${budgetLine(lookupCalls, max)}\n`;

			return {
				content: [{ type: "text", text }],
				details: result,
				...(nativeUsage ? { usage: nativeUsage } : {}),
			};
		},
	});

	pi.registerTool({
		name: "fetch_web",
		label: "Fetch Web Content",
		description:
			"Fetch and extract readable content from a public URL. Uses TinyFish by default (Markdown), " +
			"falling back to Mozilla Readability (HTML). " +
			"Returns the page title and content in the strategy's native format (markdown, html, json, text, or unknown). " +
			"Pass advancedOptions.tinyfish to control TinyFish-specific fetch behavior (format, links, ttl, etc.). " +
			"Unknown fields in advancedOptions.tinyfish are rejected. " +
			"Use for reading documentation, articles, or any public web page.",
		parameters: Type.Object({
			url: Type.String({ description: "Public HTTP(S) URL to fetch" }),
			max_chars: Type.Optional(
				Type.Number({
					description: "Max characters to return. Defaults to no truncation.",
				}),
			),
			advancedOptions: Type.Optional(
				Type.Object(
					{
						tinyfish: Type.Optional(TinyFishFetchOptionsSchema),
					},
					{ additionalProperties: false },
				),
			),
		}),
		async execute(_id: string, params: any, signal?: AbortSignal) {
			const max = maxFetches();
			if (max > 0 && fetchCalls >= max) {
				throw new Error(
					`fetch_web budget exhausted: ${fetchCalls}/${max} fetches used. ` +
						"Stop fetching and write your report from the content already collected.",
				);
			}
			fetchCalls += 1;
			const request = {
				url: params.url,
				max_chars: params.max_chars,
				advancedOptions: params.advancedOptions,
			};
			if (signal) (request as any).__signal = signal;
			const result = await fetchWeb(request);

			let content = result.content;
			if (params.max_chars && content.length > params.max_chars) {
				content = content.slice(0, params.max_chars) + "\n\n[Content truncated]";
			}
			if (content.length > PI_TOOL_OUTPUT_SAFETY_LIMIT) {
				content =
					content.slice(0, PI_TOOL_OUTPUT_SAFETY_LIMIT) +
					"\n\n[Content truncated due to output safety limit]";
			}

			const text = `Title: ${result.title || "(none)"}\nURL: ${result.url}\nStrategy: ${result.strategy}\nFormat: ${result.format}\n\n${content}`;
			const output =
				max > 0 ? `${text}\n\n${budgetLine(fetchCalls, max)}\n` : text;

			return {
				content: [{ type: "text", text: output }],
				details: result,
			};
		},
	});
}
