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
import {
	augmentNativeWebToolsIfNeeded,
	getNativeWebStatus,
	resolveNativeWebCapabilities,
} from "./native.ts";

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
const NATIVE_WEB_GUIDANCE_MARKER = "[web-search native-first routing]";
const NATIVE_WEB_FALLBACK_GUIDANCE = `${NATIVE_WEB_GUIDANCE_MARKER}
Use a verified provider-native web tool first when one is available. If native search or fetch fails, returns empty or insufficient information, or does not preserve usable citations/source metadata, use the client fallback tools web_lookup or fetch_web. Do not retry a failed native operation indefinitely; continue with the fallback result and cite its URLs. The fallback tools remain available on every provider.`;

function appendNativeWebGuidance(systemPrompt: string): string {
	return systemPrompt.includes(NATIVE_WEB_GUIDANCE_MARKER)
		? systemPrompt
		: `${systemPrompt}${systemPrompt ? "\n\n" : ""}${NATIVE_WEB_FALLBACK_GUIDANCE}`;
}

type NativeHookContext = {
	model?: Parameters<typeof resolveNativeWebCapabilities>[0];
	ui?: { setStatus?: (key: string, text: string | undefined) => void };
};

type NativeEventHandler = (event: unknown, context: unknown) => unknown;

function nativeContext(value: unknown): NativeHookContext {
	return typeof value === "object" && value !== null
		? (value as NativeHookContext)
		: {};
}

function registerNativeWebHooks(pi: ExtensionAPI): void {
	// SAFETY: newer Pi runtimes expose these documented events; the structural
	// adapter keeps this package compatible with older compile-time declarations.
	const on = (
		pi as unknown as {
			on?: (event: string, handler: NativeEventHandler) => void;
		}
	).on;
	if (typeof on !== "function") return;

	on.call(pi, "before_provider_request", (event, context) => {
		const payload =
			typeof event === "object" && event !== null
				? (event as { payload?: unknown }).payload
				: undefined;
		return augmentNativeWebToolsIfNeeded(
			payload,
			resolveNativeWebCapabilities(nativeContext(context).model),
		);
	});

	on.call(pi, "before_agent_start", (event) => {
		const systemPrompt =
			typeof event === "object" &&
			event !== null &&
			typeof (event as { systemPrompt?: unknown }).systemPrompt === "string"
				? (event as { systemPrompt: string }).systemPrompt
				: "";
		return { systemPrompt: appendNativeWebGuidance(systemPrompt) };
	});

	on.call(pi, "session_start", (_event, context) => {
		const ctx = nativeContext(context);
		ctx.ui?.setStatus?.(NATIVE_WEB_STATUS_KEY, getNativeWebStatus(ctx.model));
	});

	on.call(pi, "model_select", (event, context) => {
		const selectedModel =
			typeof event === "object" && event !== null
				? (event as { model?: Parameters<typeof resolveNativeWebCapabilities>[0] })
						.model
				: undefined;
		const ctx = nativeContext(context);
		ctx.ui?.setStatus?.(
			NATIVE_WEB_STATUS_KEY,
			getNativeWebStatus(selectedModel ?? ctx.model),
		);
	});

	on.call(pi, "session_shutdown", (_event, context) => {
		nativeContext(context).ui?.setStatus?.(NATIVE_WEB_STATUS_KEY, undefined);
	});
}

function budgetLine(used: number, max: number): string {
	return `[Search budget: ${used}/${max} calls used — ${max - used} remaining]`;
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag?.("web-search-max-lookups", {
		description:
			"Hard cap on web_lookup calls per process. Passed by the tmux-subagent runner; 0/unset = unlimited.",
		type: "string",
	});
	pi.registerFlag?.("web-search-max-fetches", {
		description:
			"Hard cap on fetch_web calls per process. Passed by the tmux-subagent runner; 0/unset = unlimited.",
		type: "string",
	});

	registerNativeWebHooks(pi);

	// Per-process counters: each subagent runs in its own pi process, so this
	// closure state is naturally a per-subagent budget.
	let lookupCalls = 0;
	let fetchCalls = 0;
	const maxLookups = () =>
		parseBudgetFlag(pi.getFlag?.("web-search-max-lookups"));
	const maxFetches = () =>
		parseBudgetFlag(pi.getFlag?.("web-search-max-fetches"));

	pi.registerTool({
		name: "web_lookup",
		label: "Web Search",
		description:
			"Search the web. Uses TinyFish by default, falling back to Exa then DuckDuckGo. " +
			"Pass engine to force a specific engine ('tinyfish', 'exa', 'duckduckgo', or 'tavily' for heavy deep research — runs alone, needs TAVILY_API_KEY). " +
			"Provider-specific advanced options are accepted under advancedOptions.tinyfish, advancedOptions.exa, or advancedOptions.tavily; " +
			"unknown provider keys are rejected. " +
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
							"Engine to use: 'auto' (default) walks the fallback chain — TinyFish first, then Exa, then DuckDuckGo. " +
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
		async execute(_id: string, params: any, signal?: AbortSignal) {
			const max = maxLookups();
			if (max > 0 && lookupCalls >= max) {
				throw new Error(
					`web_lookup budget exhausted: ${lookupCalls}/${max} searches used. ` +
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
			const result = await webLookup(request);

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
