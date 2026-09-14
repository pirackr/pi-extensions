import { describe, expect, it } from "vitest";
import createExtension from "../extensions/web-search/index.ts";
import {
	NATIVE_WEB_COMPATIBILITY,
	augmentNativeWebTools,
	augmentNativeWebToolsIfNeeded,
	getNativeWebStatus,
	inspectNativeWebCapabilities,
	resolveNativeWebCapabilities,
	type NativeWebCapabilities,
} from "../extensions/web-search/native.ts";

function model(overrides: Record<string, unknown> = {}) {
	return {
		id: "gpt-5.5",
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		...overrides,
	};
}

function enabledCapabilities(
	overrides: Partial<NativeWebCapabilities> = {},
): NativeWebCapabilities {
	return {
		provider: "openai",
		api: "openai-responses",
		endpoint: "https://api.openai.com/v1",
		modelId: "gpt-5.5",
		search: true,
		fetch: false,
		...overrides,
	};
}

describe("native web capability detection", () => {
	it.each([
		{
			name: "official OpenAI Responses",
			input: model(),
			provider: true,
			endpoint: true,
			api: true,
			model: true,
		},
		{
			name: "official ChatGPT Codex Responses",
			input: model({
				id: "gpt-5.6-luna",
				provider: "openai-codex",
				api: "openai-codex-responses",
				baseUrl: "https://chatgpt.com/backend-api",
			}),
			provider: true,
			endpoint: true,
			api: true,
			model: true,
		},
		{
			name: "official Anthropic Messages",
			input: model({
				id: "claude-sonnet-4-5",
				provider: "anthropic",
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com/",
			}),
			provider: true,
			endpoint: true,
			api: true,
			model: true,
		},
		{
			name: "official DeepSeek Anthropic-compatible endpoint",
			input: model({
				id: "deepseek-v4-flash",
				provider: "deepseek",
				api: "anthropic-messages",
				baseUrl: "https://api.deepseek.com/anthropic/",
			}),
			provider: true,
			endpoint: true,
			api: true,
			model: true,
		},
		{
			name: "DeepSeek's currently installed Completions transport",
			input: model({
				id: "deepseek-v4-flash",
				provider: "deepseek",
				api: "openai-completions",
				baseUrl: "https://api.deepseek.com",
			}),
			provider: true,
			endpoint: false,
			api: false,
			model: true,
		},
		{
			name: "OpenRouter gateway with an OpenAI-looking model",
			input: model({
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
			}),
			provider: false,
			endpoint: false,
			api: false,
			model: false,
		},
		{
			name: "OpenCode Zen gateway with a Claude-looking model",
			input: model({
				id: "claude-sonnet-4-5",
				provider: "opencode",
				baseUrl: "https://opencode.ai/zen/v1",
			}),
			provider: false,
			endpoint: false,
			api: false,
			model: false,
		},
		{
			name: "custom proxy",
			input: model({ baseUrl: "https://proxy.example.test/v1" }),
			provider: true,
			endpoint: false,
			api: true,
			model: true,
		},
		{
			name: "unsupported OpenAI model",
			input: model({ id: "gpt-3.5-turbo" }),
			provider: true,
			endpoint: true,
			api: true,
			model: false,
		},
		{
			name: "unsupported API protocol",
			input: model({ api: "openai-completions" }),
			provider: true,
			endpoint: true,
			api: false,
			model: true,
		},
	])(
		"checks every capability boundary: $name",
		({ input, provider, endpoint, api, model: supportedModel }) => {
			const inspection = inspectNativeWebCapabilities(input);
			expect(inspection.officialProvider).toBe(provider);
			expect(inspection.officialEndpoint).toBe(endpoint);
			expect(inspection.supportedApi).toBe(api);
			expect(inspection.supportedModel).toBe(supportedModel);
		},
	);

	it("enables official OpenAI, Codex, and Anthropic adapters but keeps DeepSeek gated", () => {
		expect(NATIVE_WEB_COMPATIBILITY.openai.verified).toBe(true);
		expect(NATIVE_WEB_COMPATIBILITY["openai-codex"].verified).toBe(true);
		expect(NATIVE_WEB_COMPATIBILITY.anthropic.verified).toBe(true);
		expect(NATIVE_WEB_COMPATIBILITY.deepseek.verified).toBe(false);
		expect(resolveNativeWebCapabilities(model())).toMatchObject({
			provider: "openai",
			search: true,
			fetch: false,
		});
		expect(
			resolveNativeWebCapabilities(
				model({
					id: "gpt-5.6-luna",
					provider: "openai-codex",
					api: "openai-codex-responses",
					baseUrl: "https://chatgpt.com/backend-api",
				}),
			),
		).toMatchObject({ provider: "openai-codex", search: true, fetch: false });
		expect(
			resolveNativeWebCapabilities(
				model({
					id: "claude-sonnet-4-5",
					provider: "anthropic",
					api: "anthropic-messages",
					baseUrl: "https://api.anthropic.com",
				}),
			),
		).toMatchObject({ provider: "anthropic", search: true, fetch: false });
		expect(
			resolveNativeWebCapabilities(
				model({
					id: "deepseek-v4-flash",
					provider: "deepseek",
					api: "anthropic-messages",
					baseUrl: "https://api.deepseek.com/anthropic",
				}),
			),
		).toBeUndefined();
	});

	it("reports native-first status for enabled official models", () => {
		expect(getNativeWebStatus(model())).toBe("web: native+fallback");
	});
});

describe("native web extension hooks", () => {
	it("keeps only accurate status hooks; routing happens inside web_search", () => {
		const handlers = new Map<string, Function>();
		createExtension({
			registerFlag() {},
			registerTool() {},
			on(event: string, handler: Function) { handlers.set(event, handler); },
		} as any);
		expect(handlers.has("before_provider_request")).toBe(false);
		expect(handlers.has("before_agent_start")).toBe(false);
		expect(handlers.has("session_start")).toBe(true);
	});
});

describe("native web payload augmentation", () => {
	it("adds the exact OpenAI Responses web-search definition without changing client tools", () => {
		const payload = {
			model: "gpt-5.5",
			input: [],
			tools: [{ type: "function", name: "existing", parameters: {} }],
		};
		const result = augmentNativeWebTools(
			payload,
			enabledCapabilities(),
		) as typeof payload & {
			tools: Array<Record<string, unknown>>;
		};

		expect(result).not.toBe(payload);
		expect(result.tools).toEqual([
			{ type: "function", name: "existing", parameters: {} },
			{ type: "web_search" },
		]);
		expect(payload.tools).toHaveLength(1);
	});

	it("adds only the bounded Anthropic search definition", () => {
		const payload = { model: "claude-sonnet-4-5", messages: [] };
		const result = augmentNativeWebTools(
			payload,
			enabledCapabilities({
				provider: "anthropic",
				api: "anthropic-messages",
				endpoint: "https://api.anthropic.com",
				modelId: "claude-sonnet-4-5",
				search: true,
				fetch: true,
			}),
		) as typeof payload & { tools: Array<Record<string, unknown>> };

		expect(result.tools).toEqual([
			{
				type: "web_search_20250305",
				name: "web_search",
				max_uses: 1,
			},
		]);
	});

	it("does not invent a DeepSeek wire shape while its installed transport is unsupported", () => {
		const payload = { model: "deepseek-v4-flash", messages: [] };
		const result = augmentNativeWebTools(
			payload,
			enabledCapabilities({
				provider: "deepseek",
				api: "anthropic-messages",
				endpoint: "https://api.deepseek.com/anthropic",
				modelId: "deepseek-v4-flash",
			}),
		);

		expect(result).toBe(payload);
	});

	it("preserves unrelated tools and avoids duplicate native definitions", () => {
		const existingSearch = { type: "web_search_20260209", name: "web_search" };
		const existingFetch = { type: "web_fetch_20260318", name: "web_fetch" };
		const payload = {
			tools: [
				{ type: "function", name: "first" },
				existingSearch,
				existingFetch,
				{ type: "function", name: "last" },
			],
		};
		const result = augmentNativeWebTools(
			payload,
			enabledCapabilities({
				provider: "anthropic",
				api: "anthropic-messages",
				endpoint: "https://api.anthropic.com",
				modelId: "claude-sonnet-4-5",
				search: true,
				fetch: true,
			}),
		);

		expect(result).toBe(payload);
	});

	it("does not add native fetch when search already exists", () => {
		const payload = {
			tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }],
		};
		const result = augmentNativeWebTools(
			payload,
			enabledCapabilities({
				provider: "anthropic",
				api: "anthropic-messages",
				endpoint: "https://api.anthropic.com",
				modelId: "claude-sonnet-4-5",
				search: true,
				fetch: false,
			}),
		);

		expect(result).toBe(payload);
	});

	it.each([
		undefined,
		null,
		[],
		{ tools: null },
		{ tools: "not-an-array" },
		{ tools: [{ type: "function" }, null] },
	])("does not augment malformed payloads", (payload) => {
		const result = augmentNativeWebTools(payload, enabledCapabilities());
		expect(result === undefined || result === payload).toBe(true);
	});

	it("returns undefined from the hook helper when no replacement is needed", () => {
		const payload = { input: "hello" };
		expect(augmentNativeWebToolsIfNeeded(payload, undefined)).toBeUndefined();
		expect(
			augmentNativeWebToolsIfNeeded(payload, enabledCapabilities()),
		).not.toBeUndefined();
	});
});
