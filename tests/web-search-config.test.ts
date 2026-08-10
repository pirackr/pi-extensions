import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Helpers — use real node:fs (no mocking needed for config tests)
// ---------------------------------------------------------------------------

async function writeFixture(overrides: Record<string, unknown>): Promise<string> {
	const fs = await import("node:fs");
	const os = await import("node:os");
	const path = await import("node:path");
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ws-config-test-"));
	fs.writeFileSync(
		path.join(tmpDir, "web-search.json"),
		JSON.stringify(overrides, null, 2),
		"utf-8",
	);
	return tmpDir;
}

async function cleanupFixture(dir: string): Promise<void> {
	const fs = await import("node:fs");
	fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// loadWebSearchConfig — packaged defaults
// ---------------------------------------------------------------------------

describe("loadWebSearchConfig — packaged defaults", async () => {
	const { loadWebSearchConfig } = await import("../extensions/web-search/config.ts");

	it("loads exact packaged defaults", async () => {
		// Ensure no user override exists
		delete process.env.PI_AGENT_DIR;
		const { config, warnings } = await loadWebSearchConfig();

		expect(config.routing.searchAuto).toEqual(["tinyfish", "exa", "duckduckgo"]);
		expect(config.routing.fetch).toEqual(["tinyfish", "readability"]);

		expect(config.providers.tinyfish.search).toEqual({
			capacity: 30,
			windowMs: 60000,
			maxRetries: 1,
		});
		expect(config.providers.tinyfish.fetch).toEqual({
			capacity: 150,
			windowMs: 60000,
			maxRetries: 1,
		});
		expect(config.providers.exa.search).toEqual({
			capacity: 10,
			windowMs: 1000,
			maxRetries: 1,
		});
		expect(config.providers.tavily.search).toEqual({
			capacity: 100,
			windowMs: 60000,
			maxRetries: 1,
		});
		expect(config.providers.duckduckgo.search).toEqual({
			capacity: null,
			windowMs: 60000,
			maxRetries: 1,
			fallbackCooldownMs: 60000,
		});
		expect(warnings).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// loadWebSearchConfig — user deep-merge precedence
// ---------------------------------------------------------------------------

describe("loadWebSearchConfig — user deep-merge", () => {
	let tmpDir: string;
	let loadWebSearchConfig: () => Promise<{ config: unknown; warnings: string[] }>;

	beforeEach(async () => {
		const mod = await import("../extensions/web-search/config.ts");
		loadWebSearchConfig = mod.loadWebSearchConfig;
		tmpDir = await writeFixture({});
		process.env.PI_AGENT_DIR = tmpDir;
	});

	afterEach(async () => {
		delete process.env.PI_AGENT_DIR;
		await cleanupFixture(tmpDir);
	});

	it("user scalar override replaces default scalar", async () => {
		const dir = await writeFixture({
			routing: { searchAuto: ["tinyfish", "duckduckgo"] },
		});
		process.env.PI_AGENT_DIR = dir;
		const { config, warnings } = await loadWebSearchConfig();
		expect((config as any).routing.searchAuto).toEqual(["tinyfish", "duckduckgo"]);
		// fetch should still be the default since user didn't override it
		expect((config as any).routing.fetch).toEqual(["tinyfish", "readability"]);
		expect(warnings).toEqual([]);
	});

	it("user override replaces arrays (not merged)", async () => {
		const dir = await writeFixture({
			routing: { searchAuto: ["tinyfish"] },
		});
		process.env.PI_AGENT_DIR = dir;
		const { config } = await loadWebSearchConfig();
		// Array is replaced, not concatenated
		expect((config as any).routing.searchAuto).toEqual(["tinyfish"]);
	});

	it("user override merges nested provider objects", async () => {
		const dir = await writeFixture({
			providers: {
				tinyfish: {
					search: { capacity: 50, windowMs: 30000 },
				},
			},
		});
		process.env.PI_AGENT_DIR = dir;
		const { config } = await loadWebSearchConfig();
		expect((config as any).providers.tinyfish.search).toEqual({
			capacity: 50,
			windowMs: 30000,
			maxRetries: 1, // default preserved
		});
	});

	it("user override can add new provider entries — warning for unknown provider", async () => {
		const dir = await writeFixture({
			providers: {
				myprovider: {
					search: { capacity: 5, windowMs: 1000, maxRetries: 0 },
				},
			},
		});
		process.env.PI_AGENT_DIR = dir;
		const { warnings } = await loadWebSearchConfig();
		// myprovider is an unknown provider — validation should reject it
		expect(warnings.length).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// loadWebSearchConfig — invalid override recovery
// ---------------------------------------------------------------------------

describe("loadWebSearchConfig — invalid override recovery", () => {
	let tmpDir: string;
	let loadWebSearchConfig: () => Promise<{ config: unknown; warnings: string[] }>;

	beforeEach(async () => {
		const mod = await import("../extensions/web-search/config.ts");
		loadWebSearchConfig = mod.loadWebSearchConfig;
		tmpDir = await writeFixture({});
		process.env.PI_AGENT_DIR = tmpDir;
	});

	afterEach(async () => {
		delete process.env.PI_AGENT_DIR;
		await cleanupFixture(tmpDir);
	});

	it("invalid capacity produces a warning and falls back to packaged defaults", async () => {
		const dir = await writeFixture({
			providers: {
				tinyfish: {
					search: { capacity: -1, windowMs: 60000, maxRetries: 1 },
				},
			},
		});
		process.env.PI_AGENT_DIR = dir;
		const { config, warnings } = await loadWebSearchConfig();
		expect(warnings.length).toBeGreaterThan(0);
		// Falls back to packaged defaults
		expect((config as any).providers.tinyfish.search.capacity).toBe(30);
	});

	it("non-integer maxRetries produces a warning and falls back", async () => {
		const dir = await writeFixture({
			providers: {
				exa: {
					search: { capacity: 10, windowMs: 1000, maxRetries: 1.5 },
				},
			},
		});
		process.env.PI_AGENT_DIR = dir;
		const { config, warnings } = await loadWebSearchConfig();
		expect(warnings.length).toBeGreaterThan(0);
		expect((config as any).providers.exa.search.maxRetries).toBe(1); // default
	});

	it("unknown provider key produces a warning and falls back", async () => {
		const dir = await writeFixture({
			providers: {
				unknownProvider: {
					search: { capacity: 5, windowMs: 1000, maxRetries: 0 },
				},
			},
		});
		process.env.PI_AGENT_DIR = dir;
		const { config, warnings } = await loadWebSearchConfig();
		expect(warnings.length).toBeGreaterThan(0);
		// Packaged defaults are used for known providers
		expect((config as any).providers.tinyfish.search.capacity).toBe(30);
	});

	it("invalid routing engine produces a warning and falls back", async () => {
		const dir = await writeFixture({
			routing: { searchAuto: ["tinyfish", "bogus-engine"] },
		});
		process.env.PI_AGENT_DIR = dir;
		const { config, warnings } = await loadWebSearchConfig();
		expect(warnings.length).toBeGreaterThan(0);
		expect((config as any).routing.searchAuto).toEqual([
			"tinyfish",
			"exa",
			"duckduckgo",
		]); // default
	});
});

// ---------------------------------------------------------------------------
// loadWebSearchConfig — secrets never exposed
// ---------------------------------------------------------------------------

describe("loadWebSearchConfig — no secret leakage in warnings", () => {
	let tmpDir: string;
	let loadWebSearchConfig: () => Promise<{ config: unknown; warnings: string[] }>;

	beforeEach(async () => {
		const mod = await import("../extensions/web-search/config.ts");
		loadWebSearchConfig = mod.loadWebSearchConfig;
		tmpDir = await writeFixture({});
		process.env.PI_AGENT_DIR = tmpDir;
	});

	afterEach(async () => {
		delete process.env.PI_AGENT_DIR;
		await cleanupFixture(tmpDir);
	});

	it("does not echo secret values in warning text (sk- prefix)", async () => {
		const secret = "sk-live-abc123secret";
		const dir = await writeFixture({
			providers: {
				tinyfish: {
					search: { api_key: secret, capacity: 30, windowMs: 60000, maxRetries: 1 },
				},
			},
		});
		process.env.PI_AGENT_DIR = dir;
		const { warnings } = await loadWebSearchConfig();
		const joinedWarnings = warnings.join(" ");
		expect(joinedWarnings).not.toContain(secret);
		expect(warnings.length).toBeGreaterThan(0);
	});

	it("does not echo secret values in warning text (key in field name)", async () => {
		const secret = "my-super-secret-key-value";
		const dir = await writeFixture({
			providers: {
				tinyfish: {
					search: { authorization: secret, capacity: 30, windowMs: 60000, maxRetries: 1 },
				},
			},
		});
		process.env.PI_AGENT_DIR = dir;
		const { warnings } = await loadWebSearchConfig();
		const joinedWarnings = warnings.join(" ");
		expect(joinedWarnings).not.toContain(secret);
		expect(warnings.length).toBeGreaterThan(0);
	});
});
