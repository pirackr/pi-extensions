import { beforeEach, describe, expect, it, vi } from "vitest";

const clientLookup = vi.fn();
vi.mock("../extensions/web-search/search.ts", () => ({ webLookup: clientLookup }));

const { default: createExtension } = await import("../extensions/web-search/index.ts");

function openAIModel(overrides: Record<string, unknown> = {}) {
	return {
		id: "gpt-5.5",
		provider: "openai",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		...overrides,
	};
}

function response(text: string, overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason: "stop",
		usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		...overrides,
	};
}

function harness(options: { model?: any; complete?: ReturnType<typeof vi.fn>; budget?: string } = {}) {
	const tools: any[] = [];
	const handlers = new Map<string, Function>();
	const complete = options.complete ?? vi.fn();
	const pi = {
		registerFlag() {},
		getFlag(name: string) { return name === "web-search-max-lookups" ? options.budget : undefined; },
		registerTool(tool: any) { tools.push(tool); },
		on(name: string, handler: Function) { handlers.set(name, handler); },
	};
	createExtension(pi as any);
	return {
		tool: tools.find((tool) => tool.name === "web_search"),
		handlers,
		complete,
		ctx: { model: options.model ?? openAIModel(), modelRegistry: { complete }, ui: { setStatus() {} } },
	};
}

const nativeJson = JSON.stringify([{ title: "Native", url: "https://example.com/a", snippet: "Useful result" }]);

beforeEach(() => {
	clientLookup.mockReset();
	clientLookup.mockResolvedValue({ query: "q", results: [], engines: [], partialFailures: [] });
});

describe("registered web_search native routing", () => {
	it("uses one isolated native request for auto search and skips client fallback", async () => {
		const complete = vi.fn(async (_model, context, options) => {
			expect(context.messages).toHaveLength(1);
			expect(context.tools ?? []).toEqual([]);
			const payload = await options.onPayload({ model: "gpt-5.5", input: [], tools: [{ type: "function", name: "leak" }] });
			expect(payload.tools).toEqual([{ type: "web_search" }]);
			expect(payload.tool_choice).toBe("required");
			expect(options.maxRetries).toBe(0);
			return response(nativeJson);
		});
		const h = harness({ complete });
		const result = await h.tool.execute("id", { query: "q", limit: 3 }, undefined, undefined, h.ctx);
		expect(complete).toHaveBeenCalledTimes(1);
		expect(clientLookup).not.toHaveBeenCalled();
		expect(result.details.engines).toEqual(["native:openai"]);
		expect(result.details.results).toHaveLength(1);
		expect(result.usage.totalTokens).toBe(18);
	});

	it.each([
		["empty", "[]"],
		["malformed", "not json"],
		["missing URL", JSON.stringify([{ title: "x", snippet: "s" }])],
		["empty snippet", JSON.stringify([{ title: "x", url: "https://example.com", snippet: "" }])],
		["credential URL", JSON.stringify([{ title: "x", url: "https://user:pass@example.com", snippet: "s" }])],
	])("falls back exactly once for %s native output", async (_name, text) => {
		const h = harness({ complete: vi.fn().mockResolvedValue(response(text)) });
		await h.tool.execute("id", { query: "q" }, undefined, undefined, h.ctx);
		expect(clientLookup).toHaveBeenCalledTimes(1);
	});

	it.each([
		[openAIModel({ id: "gpt-5.6-luna", provider: "openai-codex", api: "openai-codex-responses", baseUrl: "https://chatgpt.com/backend-api" }), [{ type: "web_search" }], "required"],
		[openAIModel({ id: "claude-sonnet-4-5", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }), [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }], { type: "any" }],
	])("serializes a native-only forced payload for supported providers", async (model, tools, toolChoice) => {
		const complete = vi.fn(async (_model, _context, options) => {
			const payload = await options.onPayload({ tools: [{ type: "function", name: "client" }] });
			expect(payload.tools).toEqual(tools);
			expect(payload.tool_choice).toEqual(toolChoice);
			return response(nativeJson);
		});
		const h = harness({ model, complete });
		await h.tool.execute("id", { query: "q" }, undefined, undefined, h.ctx);
		expect(clientLookup).not.toHaveBeenCalled();
	});

	it("falls back exactly once after a redacted native failure", async () => {
		const h = harness({ complete: vi.fn().mockRejectedValue(new Error("secret sk-live-value")) });
		const result = await h.tool.execute("id", { query: "q" }, undefined, undefined, h.ctx);
		expect(clientLookup).toHaveBeenCalledTimes(1);
		expect(JSON.stringify(result)).not.toContain("sk-live-value");
	});

	it.each([
		openAIModel({ provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1" }),
		openAIModel({ baseUrl: "https://proxy.example.test/v1" }),
	])("uses client-only routing for unsupported providers and proxies", async (model) => {
		const h = harness({ model, complete: vi.fn() });
		await h.tool.execute("id", { query: "q" }, undefined, undefined, h.ctx);
		expect(h.complete).not.toHaveBeenCalled();
		expect(clientLookup).toHaveBeenCalledTimes(1);
	});

	it("keeps explicit engines client-only", async () => {
		const h = harness({ complete: vi.fn() });
		await h.tool.execute("id", { query: "q", engine: "exa" }, undefined, undefined, h.ctx);
		expect(h.complete).not.toHaveBeenCalled();
		expect(clientLookup).toHaveBeenCalledWith(expect.objectContaining({ engine: "exa" }));
	});

	it("bypasses native when advanced options are present", async () => {
		const h = harness({ complete: vi.fn() });
		await h.tool.execute("id", { query: "q", advancedOptions: { exa: { includeDomains: ["example.com"] } } }, undefined, undefined, h.ctx);
		expect(h.complete).not.toHaveBeenCalled();
		expect(clientLookup).toHaveBeenCalledTimes(1);
	});

	it("does not fallback when caller cancellation aborts native", async () => {
		const controller = new AbortController();
		const complete = vi.fn(async () => { controller.abort(); return response("", { stopReason: "aborted" }); });
		const h = harness({ complete });
		await expect(h.tool.execute("id", { query: "q" }, controller.signal, undefined, h.ctx)).rejects.toMatchObject({ name: "AbortError" });
		expect(clientLookup).not.toHaveBeenCalled();
	});

	it("validates advanced options before budget or native calls", async () => {
		const h = harness({ complete: vi.fn(), budget: "1" });
		await expect(h.tool.execute("id", { query: "q", advancedOptions: { tinyfish: { recency_minutes: 5, after_date: "2026-01-01" } } }, undefined, undefined, h.ctx)).rejects.toThrow("mutually exclusive");
		expect(h.complete).not.toHaveBeenCalled();
		expect(clientLookup).not.toHaveBeenCalled();
		await expect(h.tool.execute("id", { query: "valid", engine: "duckduckgo" }, undefined, undefined, h.ctx)).resolves.toBeTruthy();
	});

	it("applies the call budget and clamps native result count to limit", async () => {
		const many = Array.from({ length: 5 }, (_, i) => ({ title: `T${i}`, url: `https://example.com/${i}`, snippet: `S${i}` }));
		const h = harness({ complete: vi.fn().mockResolvedValue(response(JSON.stringify(many))), budget: "1" });
		const first = await h.tool.execute("id", { query: "q", limit: 2 }, undefined, undefined, h.ctx);
		expect(first.details.results).toHaveLength(2);
		await expect(h.tool.execute("id2", { query: "q2" }, undefined, undefined, h.ctx)).rejects.toThrow("budget exhausted");
	});

	it("falls back on native timeout without treating it as caller cancellation", async () => {
		const deadline = new AbortController();
		const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
		try {
			const complete = vi.fn(async () => {
				deadline.abort();
				return response("", { stopReason: "aborted" });
			});
			const h = harness({ complete });
			const result = await h.tool.execute("id", { query: "q" }, undefined, undefined, h.ctx);
			expect(clientLookup).toHaveBeenCalledTimes(1);
			expect(result.details.partialFailures).toContainEqual({ engine: "native:openai", error: "native search timed out" });
			expect(result.usage.totalTokens).toBe(18);
		} finally {
			timeout.mockRestore();
		}
	});

	it("explains unusable native output while preserving client diagnostics and usage", async () => {
		clientLookup.mockResolvedValue({ query: "q", results: [], engines: [], partialFailures: [{ engine: "tinyfish", error: "no credentials" }] });
		const h = harness({ complete: vi.fn().mockResolvedValue(response("[]")) });
		const result = await h.tool.execute("id", { query: "q" }, undefined, undefined, h.ctx);
		expect(result.details.partialFailures).toEqual([
			{ engine: "native:openai", error: "native search returned no usable results with source URLs" },
			{ engine: "tinyfish", error: "no credentials" },
		]);
		expect(result.usage.totalTokens).toBe(18);
	});

	it("does not spend budget or start any request after caller cancellation", async () => {
		const h = harness({ model: openAIModel({ provider: "proxy" }), budget: "1" });
		const controller = new AbortController();
		controller.abort();
		await expect(h.tool.execute("id", { query: "q", engine: "exa" }, controller.signal, undefined, h.ctx)).rejects.toMatchObject({ name: "AbortError" });
		expect(clientLookup).not.toHaveBeenCalled();
		await expect(h.tool.execute("id", { query: "q", engine: "exa" }, undefined, undefined, h.ctx)).resolves.toBeTruthy();
	});

	it("removes adaptive thinking before forcing Anthropic native search", async () => {
		const complete = vi.fn(async (_model, _context, options) => {
			const payload = await options.onPayload({
				model: "claude-opus-4-7",
				thinking: { type: "adaptive" },
				output_config: { effort: "high" },
				messages: [],
			});
			expect(payload.thinking).toBeUndefined();
			expect(payload.output_config).toBeUndefined();
			expect(payload.tool_choice).toEqual({ type: "any" });
			return response(nativeJson);
		});
		const h = harness({ model: openAIModel({ id: "claude-opus-4-7", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }), complete });
		const result = await h.tool.execute("id", { query: "q" }, undefined, undefined, h.ctx);
		expect(result.details.engines).toEqual(["native:anthropic"]);
	});

	it("does not attempt native search on unsupported legacy Claude models", async () => {
		const h = harness({ model: openAIModel({ id: "claude-3-opus-20240229", provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" }) });
		await h.tool.execute("id", { query: "q" }, undefined, undefined, h.ctx);
		expect(h.complete).not.toHaveBeenCalled();
		expect(clientLookup).toHaveBeenCalledTimes(1);
	});

	it("does not register parent request injection or prompt guidance hooks", () => {
		const h = harness();
		expect(h.handlers.has("before_provider_request")).toBe(false);
		expect(h.handlers.has("before_agent_start")).toBe(false);
	});
});
