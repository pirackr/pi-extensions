import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildModelFromModelsDev,
	getVisibleModels,
	isAnonymousMode,
	opencodeHeaders,
	resolveApiKey,
	staticModels,
} from "../extensions/opencode-zen/index.ts";

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("isAnonymousMode", () => {
	it("treats missing and 'public' keys as anonymous", () => {
		expect(isAnonymousMode(undefined)).toBe(true);
		expect(isAnonymousMode("public")).toBe(true);
		expect(isAnonymousMode("")).toBe(true);
	});

	it("treats real keys as authenticated", () => {
		expect(isAnonymousMode("oc_live_abc123")).toBe(false);
	});
});

describe("resolveApiKey", () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-zen-test-"));
	const authPath = join(dir, "auth.json");

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("prefers the environment variable", () => {
		vi.stubEnv("OPENCODE_API_KEY", "oc_env_key");
		expect(resolveApiKey(authPath)).toBe("oc_env_key");
	});

	it("falls back to auth.json under the opencode-zen entry", () => {
		writeFileSync(
			authPath,
			JSON.stringify({ "opencode-zen": { type: "api_key", key: "oc_auth_key" } }),
		);
		expect(resolveApiKey(authPath)).toBe("oc_auth_key");
		rmSync(authPath, { force: true });
	});

	it("defaults to the anonymous public credential", () => {
		expect(resolveApiKey(authPath)).toBe("public");
	});

	it("tolerates a missing or malformed auth.json", () => {
		writeFileSync(authPath, "not json");
		expect(resolveApiKey(authPath)).toBe("public");
		rmSync(authPath, { force: true });
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("opencodeHeaders", () => {
	it("sends the opencode CLI identity headers", () => {
		const headers = opencodeHeaders();
		expect(headers["User-Agent"]).toMatch(/^opencode\//);
		for (const name of [
			"x-opencode-client",
			"x-opencode-session",
			"x-opencode-project",
			"x-opencode-request",
		]) {
			expect(headers[name]).toBeTruthy();
		}
		expect(headers["x-opencode-client"]).toBe("cli");
	});
});

const modelsDevInfo = {
	"deepseek-v4-flash-free": {
		status: "available",
		cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
	},
	"big-pickle": {
		status: "available",
		cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
	},
	"kimi-k2.6": {
		status: "available",
		cost: { input: 0.95, output: 4, cache_read: 0.16, cache_write: 0 },
	},
	"glm-5": {
		status: "deprecated",
		cost: { input: 1, output: 3.2, cache_read: 0.1, cache_write: 0 },
	},
};

describe("getVisibleModels", () => {
	it("keeps only free models in anonymous mode", () => {
		const models = getVisibleModels(undefined, modelsDevInfo, true);
		expect(models.map((m) => m.id).sort()).toEqual(
			["big-pickle", "deepseek-v4-flash-free"].sort(),
		);
		for (const m of models) expect(m.cost?.input).toBe(0);
	});

	it("keeps paid models when authenticated", () => {
		const models = getVisibleModels(undefined, modelsDevInfo, false);
		const ids = models.map((m) => m.id);
		expect(ids).toContain("kimi-k2.6");
		expect(ids).not.toContain("glm-5");
	});

	it("drops deprecated models", () => {
		const models = getVisibleModels(undefined, modelsDevInfo, false);
		expect(models.map((m) => m.id)).not.toContain("glm-5");
	});

	it("narrows to the live /zen/v1/models set", () => {
		const visible = new Set(["big-pickle", "deepseek-v4-flash-free"]);
		const models = getVisibleModels(visible, modelsDevInfo, false);
		expect(models.map((m) => m.id).sort()).toEqual(
			["big-pickle", "deepseek-v4-flash-free"].sort(),
		);
	});

	it("falls back to the static free subset offline in anonymous mode", () => {
		const models = getVisibleModels(undefined, undefined, true);
		expect(models.length).toBeGreaterThan(0);
		for (const m of models) expect(m.cost?.input).toBe(0);
	});

	it("returns the full static catalog offline when authenticated", () => {
		const models = getVisibleModels(undefined, undefined, false);
		expect(models.length).toBe(staticModels.length);
	});
});

describe("deepseek compat", () => {
	it("sets requiresReasoningContentOnAssistantMessages on every DeepSeek model", () => {
		const deepseekModels = staticModels.filter((m) => m.id.startsWith("deepseek-"));
		expect(deepseekModels.length).toBeGreaterThan(0);
		for (const m of deepseekModels) {
			expect(m.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
		}
	});

	it("does not leak the DeepSeek compat flag onto other providers", () => {
		for (const m of staticModels.filter((m) => !m.id.startsWith("deepseek-"))) {
			expect(m.compat?.requiresReasoningContentOnAssistantMessages).toBeUndefined();
		}
	});
});

// --- dynamic model building from models.dev ---

const fullModelsDevInfo = {
	"big-pickle": {
		name: "Big Pickle",
		reasoning: true,
		modalities: { input: ["text"], output: ["text"] },
		limit: { context: 200000, output: 128000 },
		status: "available",
		cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
	},
	"x-preview-f-free": {
		name: "Ox Alpha Free",
		reasoning: true,
		modalities: { input: ["text", "image", "video"], output: ["text"] },
		limit: { context: 1000000, output: 131072 },
		status: "available",
		cost: { input: 0, output: 0, cache_read: 0 },
	},
	"deepseek-v4-pro": {
		name: "DeepSeek V4 Pro",
		reasoning: true,
		modalities: { input: ["text"], output: ["text"] },
		limit: { context: 1048576, output: 128000 },
		status: "available",
		cost: { input: 1.74, output: 3.48, cache_read: 0.145, cache_write: 0 },
	},
	"glm-5": {
		name: "GLM 5",
		reasoning: true,
		modalities: { input: ["text"], output: ["text"] },
		limit: { context: 204800, output: 131072 },
		status: "deprecated",
		cost: { input: 1, output: 3.2, cache_read: 0.1, cache_write: 0 },
	},
};

describe("buildModelFromModelsDev", () => {
	it("builds a ProviderModelConfig from models.dev data", () => {
		const model = buildModelFromModelsDev(
			"big-pickle",
			fullModelsDevInfo["big-pickle"],
		);
		expect(model).toEqual({
			id: "big-pickle",
			name: "Big Pickle",
			reasoning: true,
			input: ["text"],
			contextWindow: 200000,
			maxTokens: 128000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		});
	});

	it("sets deepseekCompat for deepseek model IDs", () => {
		const model = buildModelFromModelsDev(
			"deepseek-v4-pro",
			fullModelsDevInfo["deepseek-v4-pro"],
		);
		expect(model.compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
	});

	it("does not set deepseekCompat for non-deepseek models", () => {
		const model = buildModelFromModelsDev(
			"big-pickle",
			fullModelsDevInfo["big-pickle"],
		);
		expect(model.compat).toBeUndefined();
	});

	it("returns undefined for missing models.dev entry", () => {
		expect(buildModelFromModelsDev("unknown-model", undefined)).toBeUndefined();
	});

	it("maps modalities.input to input array", () => {
		const model = buildModelFromModelsDev(
			"x-preview-f-free",
			fullModelsDevInfo["x-preview-f-free"],
		);
		expect(model.input).toEqual(["text", "image", "video"]);
	});
});

describe("getVisibleModels dynamic", () => {
	it("builds models from Zen IDs + models.dev, not from staticModels", () => {
		// Only Ox Alpha and Big Pickle are on Zen; Kimi is not
		const visibleIds = new Set(["big-pickle", "x-preview-f-free"]);
		const models = getVisibleModels(visibleIds, fullModelsDevInfo, false);
		const ids = models.map((m) => m.id).sort();
		expect(ids).toEqual(["big-pickle", "x-preview-f-free"].sort());
	});

	it("includes new models not in staticModels when on Zen", () => {
		const visibleIds = new Set(["x-preview-f-free"]);
		const models = getVisibleModels(visibleIds, fullModelsDevInfo, false);
		expect(models).toHaveLength(1);
		expect(models[0].id).toBe("x-preview-f-free");
		expect(models[0].name).toBe("Ox Alpha Free");
		expect(models[0].contextWindow).toBe(1000000);
	});

	it("drops deprecated models from Zen set", () => {
		const visibleIds = new Set(["big-pickle", "glm-5"]);
		const models = getVisibleModels(visibleIds, fullModelsDevInfo, false);
		expect(models.map((m) => m.id)).not.toContain("glm-5");
	});

	it("filters to free models in anonymous mode", () => {
		const visibleIds = new Set(["big-pickle", "x-preview-f-free", "deepseek-v4-pro"]);
		const models = getVisibleModels(visibleIds, fullModelsDevInfo, true);
		const ids = models.map((m) => m.id).sort();
		expect(ids).toEqual(["big-pickle", "x-preview-f-free"].sort());
		for (const m of models) expect(m.cost?.input).toBe(0);
	});

	it("falls back to staticModels when models.dev is unavailable", () => {
		const visibleIds = new Set(["big-pickle", "x-preview-f-free"]);
		const models = getVisibleModels(visibleIds, undefined, false);
		// x-preview-f-free is not in staticModels, so only big-pickle survives
		expect(models.map((m) => m.id)).toEqual(["big-pickle"]);
	});

	it("falls back to staticModels when Zen API is unavailable", () => {
		const models = getVisibleModels(undefined, fullModelsDevInfo, false);
		// Without Zen IDs, should use staticModels filtered by models.dev
		expect(models.length).toBeGreaterThan(0);
		expect(models.map((m) => m.id)).toContain("big-pickle");
		expect(models.map((m) => m.id)).not.toContain("glm-5");
	});

	it("applies deepseekCompat dynamically for deepseek IDs from Zen", () => {
		const visibleIds = new Set(["deepseek-v4-pro"]);
		const models = getVisibleModels(visibleIds, fullModelsDevInfo, false);
		expect(models[0].compat?.requiresReasoningContentOnAssistantMessages).toBe(true);
	});
});