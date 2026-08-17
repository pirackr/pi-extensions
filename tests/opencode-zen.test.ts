import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
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