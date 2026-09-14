/**
 * Provider-native web capability detection and request augmentation.
 *
 * This module deliberately has no Pi or provider SDK dependency. Native
 * adapters are restricted to known official endpoints and transports.
 */

export type NativeWebProvider =
	| "openai"
	| "openai-codex"
	| "anthropic"
	| "deepseek";
export type NativeWebApi =
	| "openai-responses"
	| "openai-codex-responses"
	| "anthropic-messages";

export interface NativeWebModelContext {
	readonly id?: unknown;
	readonly provider?: unknown;
	readonly api?: unknown;
	readonly baseUrl?: unknown;
}

export interface NativeWebCapabilities {
	readonly provider: NativeWebProvider;
	readonly api: NativeWebApi;
	readonly endpoint: string;
	readonly modelId: string;
	readonly search: boolean;
	readonly fetch: boolean;
}

export interface NativeWebCapabilityInspection {
	readonly provider: string | undefined;
	readonly api: string | undefined;
	readonly endpoint: string | undefined;
	readonly modelId: string | undefined;
	readonly officialProvider: boolean;
	readonly officialEndpoint: boolean;
	readonly supportedApi: boolean;
	readonly supportedModel: boolean;
	readonly verified: boolean;
	readonly search: boolean;
	readonly fetch: boolean;
	readonly reason: string | undefined;
}

interface NativeWebCompatibilityEntry {
	readonly api: NativeWebApi;
	readonly endpoint: string;
	readonly search: boolean;
	readonly fetch: boolean;
	readonly verified: boolean;
	readonly reason: string;
}

/**
 * Native-tool support enabled for the Pi version this package targets.
 * Provider-internal trace blocks may not all appear in Pi's normalized message,
 * but final answer text remains available. Client fallback tools remain active
 * when a native operation fails or produces insufficient output.
 */
export const NATIVE_WEB_COMPATIBILITY: Readonly<
	Record<NativeWebProvider, NativeWebCompatibilityEntry>
> = Object.freeze({
	openai: {
		api: "openai-responses",
		endpoint: "https://api.openai.com/v1",
		search: true,
		fetch: false,
		verified: true,
		reason: "Official OpenAI Responses native web search.",
	},
	"openai-codex": {
		api: "openai-codex-responses",
		endpoint: "https://chatgpt.com/backend-api",
		search: true,
		fetch: false,
		verified: true,
		reason: "Official ChatGPT Codex Responses native web search.",
	},
	anthropic: {
		api: "anthropic-messages",
		endpoint: "https://api.anthropic.com",
		search: true,
		fetch: false,
		verified: true,
		reason:
			"Official Anthropic Messages native web search. Fetch remains client-routed.",
	},
	deepseek: {
		api: "anthropic-messages",
		endpoint: "https://api.deepseek.com/anthropic",
		search: true,
		fetch: false,
		verified: false,
		reason:
			"DeepSeek documents web search through its Anthropic-compatible Claude Code endpoint, but the installed Pi DeepSeek provider uses openai-completions at https://api.deepseek.com.",
	},
});

/** Alias used by diagnostics and future compatibility updates. */
export const NATIVE_WEB_CAPABILITY_MATRIX = NATIVE_WEB_COMPATIBILITY;

/**
 * Exact provider-native definitions.  They are kept separate from the
 * compatibility gate so payload tests can pin the official wire shapes before
 * a future Pi parser update enables an adapter.
 */
export const NATIVE_WEB_TOOL_DEFINITIONS = Object.freeze({
	openai: Object.freeze([{ type: "web_search" }]),
	"openai-codex": Object.freeze([{ type: "web_search" }]),
	anthropic: Object.freeze([
		{
			type: "web_search_20250305",
			name: "web_search",
			max_uses: 1,
		},
	]),
	// DeepSeek's documented native-search path is Anthropic-compatible, but
	// this package has no enabled DeepSeek adapter while Pi selects a different
	// transport. Do not invent an OpenAI Responses definition for it.
	deepseek: Object.freeze([]),
});

const OPENAI_WEB_SEARCH_MODEL_IDS = new Set([
	"gpt-4o",
	"gpt-4o-mini",
	"gpt-4.1",
	"gpt-4.1-mini",
	"gpt-4.1-nano",
	"gpt-4o-search-preview",
	"gpt-4o-mini-search-preview",
	"gpt-5",
	"gpt-5-mini",
	"gpt-5-nano",
	"gpt-5.1",
	"gpt-5.2",
	"gpt-5.3",
	"gpt-5.4",
	"gpt-5.5",
	"o1",
	"o3",
	"o3-mini",
	"o4-mini",
]);

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isNativeProvider(
	value: string | undefined,
): value is NativeWebProvider {
	return (
		value === "openai" ||
		value === "openai-codex" ||
		value === "anthropic" ||
		value === "deepseek"
	);
}

function isNativeApi(value: string | undefined): value is NativeWebApi {
	return (
		value === "openai-responses" ||
		value === "openai-codex-responses" ||
		value === "anthropic-messages"
	);
}

/** Normalize only URL syntax; callers still compare against an exact allowlist. */
export function normalizeNativeEndpoint(value: unknown): string | undefined {
	const raw = readString(value);
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		if (
			url.protocol !== "https:" ||
			url.username ||
			url.password ||
			url.search ||
			url.hash
		) {
			return undefined;
		}
		const pathname = url.pathname.replace(/\/+$/, "");
		return `https://${url.hostname.toLowerCase()}${
			url.port ? `:${url.port}` : ""
		}${pathname}`;
	} catch {
		return undefined;
	}
}

function supportsOpenAIModel(modelId: string | undefined): boolean {
	if (!modelId) return false;
	if (OPENAI_WEB_SEARCH_MODEL_IDS.has(modelId)) return true;
	// New dated/point releases inherit the capability only within an already
	// supported family; provider and endpoint checks happen before this rule is
	// considered, so a gateway model name cannot activate it.
	return /^gpt-5(?:\.\d+)?(?:-[a-z0-9.-]+)?$/i.test(modelId);
}

function supportsAnthropicModel(modelId: string | undefined): boolean {
	return (
		!!modelId &&
		/^claude-(?:3-(?:5-(?:haiku|sonnet)|7-sonnet)|(?:haiku|sonnet|opus)-4)(?:[.-]|$)/i.test(
			modelId,
		)
	);
}

function supportsDeepSeekModel(modelId: string | undefined): boolean {
	return (
		modelId === "deepseek-v4-flash" ||
		modelId === "deepseek-v4-pro" ||
		modelId === "deepseek-v4-flash-vision-exp"
	);
}

function providerModelSupported(
	provider: string | undefined,
	modelId: string | undefined,
): boolean {
	switch (provider) {
		case "openai":
		case "openai-codex":
			return supportsOpenAIModel(modelId);
		case "anthropic":
			return supportsAnthropicModel(modelId);
		case "deepseek":
			return supportsDeepSeekModel(modelId);
		default:
			return false;
	}
}

function providerApiSupported(
	provider: string | undefined,
	api: string | undefined,
): boolean {
	return (
		(provider === "openai" && api === "openai-responses") ||
		(provider === "openai-codex" && api === "openai-codex-responses") ||
		((provider === "anthropic" || provider === "deepseek") &&
			api === "anthropic-messages")
	);
}

/**
 * Inspect all provider, endpoint, protocol, and model boundaries independently.
 */
export function inspectNativeWebCapabilities(
	model: NativeWebModelContext | null | undefined,
): NativeWebCapabilityInspection {
	const provider = readString(model?.provider);
	const api = readString(model?.api);
	const endpoint = normalizeNativeEndpoint(model?.baseUrl);
	const modelId = readString(model?.id);
	const officialProvider = isNativeProvider(provider);
	const compatibility = officialProvider
		? NATIVE_WEB_COMPATIBILITY[provider]
		: undefined;
	const officialEndpoint =
		compatibility !== undefined && endpoint === compatibility.endpoint;
	const supportedApi = providerApiSupported(provider, api);
	const supportedModel = providerModelSupported(provider, modelId);
	const verified = compatibility?.verified === true;
	const usable =
		officialProvider &&
		officialEndpoint &&
		supportedApi &&
		supportedModel &&
		verified;

	let reason: string | undefined;
	if (!officialProvider) reason = "provider is not an official native provider";
	else if (!officialEndpoint)
		reason = "endpoint is not the provider's official endpoint";
	else if (!supportedApi)
		reason = "API protocol is not the supported native transport";
	else if (!supportedModel)
		reason = "model is not in the supported native model family";
	else if (!verified) reason = compatibility.reason;

	return {
		provider,
		api,
		endpoint,
		modelId,
		officialProvider,
		officialEndpoint,
		supportedApi,
		supportedModel,
		verified,
		search: usable ? compatibility.search : false,
		fetch: usable ? compatibility.fetch : false,
		reason,
	};
}

/**
 * Return capabilities only when every boundary and compatibility gate passes.
 */
export function resolveNativeWebCapabilities(
	model: NativeWebModelContext | null | undefined,
): NativeWebCapabilities | undefined {
	const inspection = inspectNativeWebCapabilities(model);
	if (
		!inspection.provider ||
		!isNativeProvider(inspection.provider) ||
		!isNativeApi(inspection.api) ||
		!inspection.endpoint ||
		!inspection.modelId ||
		!inspection.officialEndpoint ||
		!inspection.supportedApi ||
		!inspection.supportedModel ||
		!inspection.verified
	) {
		return undefined;
	}

	const compatibility = NATIVE_WEB_COMPATIBILITY[inspection.provider];
	if (compatibility.api !== inspection.api) return undefined;
	return {
		provider: inspection.provider,
		api: inspection.api,
		endpoint: inspection.endpoint,
		modelId: inspection.modelId,
		search: compatibility.search,
		fetch: compatibility.fetch,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolHasCapabilityName(
	tool: Record<string, unknown>,
	capability: "search" | "fetch",
): boolean {
	const name = tool.name;
	if (typeof name !== "string") return false;
	return capability === "search" ? name === "web_search" : name === "web_fetch";
}

function toolHasCapabilityType(
	tool: Record<string, unknown>,
	capability: "search" | "fetch",
): boolean {
	const type = tool.type;
	if (typeof type !== "string") return false;
	if (capability === "search")
		return type === "web_search" || type.startsWith("web_search_");
	return type === "web_fetch" || type.startsWith("web_fetch_");
}

function alreadyHasNativeCapability(
	tools: readonly Record<string, unknown>[],
	capability: "search" | "fetch",
): boolean {
	return tools.some(
		(tool) =>
			toolHasCapabilityType(tool, capability) ||
			toolHasCapabilityName(tool, capability),
	);
}

/** Return cloned native definitions for a capability object. */
export function getNativeWebToolDefinitions(
	capabilities: NativeWebCapabilities | null | undefined,
): Record<string, unknown>[] {
	if (!capabilities) return [];
	const definitions = NATIVE_WEB_TOOL_DEFINITIONS[capabilities.provider];
	if (!definitions) return [];
	return definitions
		.filter((tool) => {
			if (tool.type === "web_search" || tool.type.startsWith("web_search_")) {
				return capabilities.search;
			}
			return capabilities.fetch;
		})
		.map((tool) => ({ ...tool }));
}

/**
 * Augment a provider payload without mutating it.  Returning the original
 * object is useful to callers that need to distinguish a no-op from a
 * replacement; `augmentNativeWebToolsIfNeeded` maps that no-op to undefined
 * for Pi's before_provider_request hook.
 */
export function augmentNativeWebTools(
	payload: unknown,
	capabilities: NativeWebCapabilities | null | undefined,
): Record<string, unknown> | undefined {
	if (!capabilities || !isRecord(payload)) return undefined;
	if (payload.tools !== undefined && !Array.isArray(payload.tools))
		return payload;

	const existing = payload.tools === undefined ? [] : payload.tools;
	if (!existing.every(isRecord)) return payload;

	const tools = existing as Record<string, unknown>[];
	const additions = getNativeWebToolDefinitions(capabilities).filter(
		(candidate) => {
			const capability = candidate.type?.toString().startsWith("web_fetch")
				? "fetch"
				: "search";
			return !alreadyHasNativeCapability(tools, capability);
		},
	);
	if (additions.length === 0) return payload;

	return { ...payload, tools: [...tools, ...additions] };
}

/** Pi hook form: undefined means the request should be sent unchanged. */
export function augmentNativeWebToolsIfNeeded(
	payload: unknown,
	capabilities: NativeWebCapabilities | null | undefined,
): Record<string, unknown> | undefined {
	const augmented = augmentNativeWebTools(payload, capabilities);
	return augmented === payload ? undefined : augmented;
}

/** Descriptive aliases for consumers that call the input a provider payload. */
export const augmentNativeWebPayload = augmentNativeWebTools;
export const augmentNativeWebPayloadIfNeeded = augmentNativeWebToolsIfNeeded;

export function getNativeWebStatus(
	model: NativeWebModelContext | null | undefined,
): "web: native+fallback" | "web: extension" {
	return resolveNativeWebCapabilities(model)
		? "web: native+fallback"
		: "web: extension";
}

const NATIVE_TIMEOUT_MS = 20_000;
const MAX_NATIVE_TEXT = 50_000;
const MAX_TITLE = 200;
const MAX_URL = 2_048;
const MAX_SNIPPET = 1_000;

export interface NativeSearchContext {
	model?: NativeWebModelContext;
	modelRegistry?: {
		complete(
			model: unknown,
			context: unknown,
			options?: Record<string, unknown>,
		): Promise<any>;
	};
}

export interface NativeSearchOutcome {
	response?: import("./types.ts").SearchResponse;
	usage?: unknown;
	failure?: { engine: string; error: string };
}

function nativeAbortError(): Error {
	const error = new Error("web_search cancelled");
	error.name = "AbortError";
	return error;
}

function nativePayload(
	payload: unknown,
	capabilities: NativeWebCapabilities,
): Record<string, unknown> {
	if (!isRecord(payload)) throw new Error("invalid native search payload");
	const tools = getNativeWebToolDefinitions(capabilities);
	if (capabilities.api === "anthropic-messages") {
		// Pi may add adaptive thinking even without a reasoning option. Forced
		// tool choice is incompatible with it; this isolated extraction call
		// deliberately omits thinking and effort configuration.
		const {
			thinking: _thinking,
			output_config: _outputConfig,
			...request
		} = payload;
		return { ...request, tools, tool_choice: { type: "any" } };
	}
	return { ...payload, tools, tool_choice: "required" };
}

function validatedNativeResults(
	text: string,
	limit: number,
): import("./types.ts").SearchResult[] | undefined {
	if (!text || text.length > MAX_NATIVE_TEXT) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 50)
		return undefined;
	const results: import("./types.ts").SearchResult[] = [];
	for (const item of parsed) {
		if (!isRecord(item)) return undefined;
		const title = typeof item.title === "string" ? item.title.trim() : "";
		const rawUrl = typeof item.url === "string" ? item.url.trim() : "";
		const snippet = typeof item.snippet === "string" ? item.snippet.trim() : "";
		if (
			!title ||
			title.length > MAX_TITLE ||
			!rawUrl ||
			rawUrl.length > MAX_URL ||
			!snippet ||
			snippet.length > MAX_SNIPPET
		)
			return undefined;
		try {
			const url = new URL(rawUrl);
			if (
				(url.protocol !== "http:" && url.protocol !== "https:") ||
				url.username ||
				url.password
			)
				return undefined;
		} catch {
			return undefined;
		}
		results.push({ title, url: rawUrl, snippet, engine: "native" });
	}
	return results.slice(0, limit);
}

/** One isolated provider-native search attempt. Invalid output is a normal miss. */
export async function tryNativeSearch(
	query: string,
	limit: number,
	ctx: NativeSearchContext | undefined,
	callerSignal?: AbortSignal,
): Promise<NativeSearchOutcome> {
	const capabilities = resolveNativeWebCapabilities(ctx?.model);
	if (!capabilities?.search || !ctx?.model || !ctx.modelRegistry?.complete)
		return {};
	if (callerSignal?.aborted) throw nativeAbortError();

	const timeoutSignal = AbortSignal.timeout(NATIVE_TIMEOUT_MS);
	const signal = callerSignal
		? AbortSignal.any([callerSignal, timeoutSignal])
		: timeoutSignal;
	const prompt = `Search the web for the query below using the provided native web search tool exactly once. Return ONLY a JSON array, with no markdown or commentary. Each item must be {"title":"...","url":"https://...","snippet":"..."}. Include explicit absolute HTTP(S) URLs and a non-empty factual snippet. Return at most ${limit} items.\n\nQuery: ${query}`;
	let answer: any;
	try {
		answer = await ctx.modelRegistry.complete(
			ctx.model,
			{
				systemPrompt: "You are a bounded web search result extractor.",
				messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
				tools: [],
			},
			{
				signal,
				maxRetries: 0,
				timeoutMs: NATIVE_TIMEOUT_MS,
				maxTokens: 2_000,
				onPayload: (payload: unknown) => nativePayload(payload, capabilities),
			},
		);
	} catch {
		if (callerSignal?.aborted) throw nativeAbortError();
		return {
			failure: {
				engine: `native:${capabilities.provider}`,
				error: timeoutSignal.aborted
					? "native search timed out"
					: "native search failed",
			},
		};
	}
	if (callerSignal?.aborted) throw nativeAbortError();
	if (
		timeoutSignal.aborted ||
		answer?.stopReason === "aborted" ||
		answer?.stopReason === "error" ||
		typeof answer?.errorMessage === "string"
	) {
		return {
			usage: answer?.usage,
			failure: {
				engine: `native:${capabilities.provider}`,
				error: timeoutSignal.aborted
					? "native search timed out"
					: "native search failed",
			},
		};
	}
	const text = Array.isArray(answer?.content)
		? answer.content
				.filter(
					(part: any) => part?.type === "text" && typeof part.text === "string",
				)
				.map((part: any) => part.text)
				.join("")
		: "";
	const results = validatedNativeResults(text, limit);
	if (!results)
		return {
			usage: answer?.usage,
			failure: {
				engine: `native:${capabilities.provider}`,
				error: "native search returned no usable results with source URLs",
			},
		};
	for (const result of results)
		result.engine = `native:${capabilities.provider}`;
	return {
		response: {
			query,
			results,
			engines: [`native:${capabilities.provider}`],
			partialFailures: [],
		},
		usage: answer?.usage,
	};
}
