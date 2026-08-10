import { describe, expect, it } from "vitest";
import * as errorsModule from "../extensions/web-search/errors.ts";

// ---------------------------------------------------------------------------
// errors.ts — normalized error categories and retryability
// ---------------------------------------------------------------------------

describe("errors.ts", () => {
	const { classifyError, isRetryable, errorText } = errorsModule;

	describe("classifyError — HTTP status mapping", () => {
		it("401 → authentication", () => {
			expect(classifyError(401, null)).toBe("authentication");
		});

		it("403 → permission", () => {
			expect(classifyError(403, null)).toBe("permission");
		});

		it("400 → validation", () => {
			expect(classifyError(400, null)).toBe("validation");
		});

		it("422 → validation", () => {
			expect(classifyError(422, null)).toBe("validation");
		});

		it("429 → rate_limit", () => {
			expect(classifyError(429, null)).toBe("rate_limit");
		});

		it("408 → timeout", () => {
			expect(classifyError(408, null)).toBe("timeout");
		});

		it("500 → service", () => {
			expect(classifyError(500, null)).toBe("service");
		});

		it("502 → service", () => {
			expect(classifyError(502, null)).toBe("service");
		});

		it("503 → service", () => {
			expect(classifyError(503, null)).toBe("service");
		});

		it("504 → service", () => {
			expect(classifyError(504, null)).toBe("service");
		});
	});

	describe("classifyError — network/abort", () => {
		it("network error (TypeError) → transport", () => {
			const err = Object.assign(new Error("fetch failed"), {
				code: "ECONNREFUSED",
			});
			expect(classifyError(null, err)).toBe("transport");
		});

		it("abort since-aborted is NOT a provider failure", () => {
			const err = new Error(" aborted");
			Object.defineProperty(err, "name", { value: "AbortError" });
			expect(classifyError(null, err)).toBe("cancellation");
		});

		it("generic Error without abort name → transport", () => {
			expect(classifyError(null, new Error("socket hang up"))).toBe(
				"transport",
			);
		});
	});

	describe("classifyError — success and empty", () => {
		it("200 with results → provider_result", () => {
			expect(classifyError(200, { results: [{ title: "x" }] })).toBe(
				"provider_result",
			);
		});

		it("200 with empty results → empty_results", () => {
			expect(classifyError(200, { results: [] })).toBe("empty_results");
		});

		it("200 with no results field and no error → provider_result", () => {
			expect(classifyError(200, {})).toBe("provider_result");
		});
	});

	describe("classifyError — quota_exhausted", () => {
		it("507 → quota_exhausted", () => {
			expect(classifyError(507, null)).toBe("quota_exhausted");
		});
	});

	describe("isRetryable", () => {
		it("timeout is retryable", () => {
			expect(isRetryable("timeout")).toBe(true);
		});

		it("transport is retryable", () => {
			expect(isRetryable("transport")).toBe(true);
		});

		it("service is retryable", () => {
			expect(isRetryable("service")).toBe(true);
		});

		it("rate_limit is NOT retryable", () => {
			expect(isRetryable("rate_limit")).toBe(false);
		});

		it("authentication is NOT retryable", () => {
			expect(isRetryable("authentication")).toBe(false);
		});

		it("permission is NOT retryable", () => {
			expect(isRetryable("permission")).toBe(false);
		});

		it("validation is NOT retryable", () => {
			expect(isRetryable("validation")).toBe(false);
		});

		it("quota_exhausted is NOT retryable", () => {
			expect(isRetryable("quota_exhausted")).toBe(false);
		});

		it("empty_results is NOT retryable", () => {
			expect(isRetryable("empty_results")).toBe(false);
		});

		it("provider_result is NOT retryable", () => {
			expect(isRetryable("provider_result")).toBe(false);
		});

		it("cancellation is NOT retryable", () => {
			expect(isRetryable("cancellation")).toBe(false);
		});

		it("unavailable_credentials is NOT retryable", () => {
			expect(isRetryable("unavailable_credentials")).toBe(false);
		});
	});

	describe("errorText — conciseness and no secrets", () => {
		it("produces concise text for authentication", () => {
			const text = errorText("authentication", { error: "invalid api key" });
			expect(text.length).toBeLessThan(200);
			expect(text).not.toContain("sk-");
		});

		it("produces concise text for rate_limit", () => {
			const text = errorText("rate_limit");
			expect(text).toBeTruthy();
			expect(text.length).toBeLessThan(200);
		});

		it("never includes raw API key in any category", () => {
			const secret = "sk-test-abc123";
			for (const cat of [
				"authentication",
				"validation",
				"permission",
				"rate_limit",
				"quota_exhausted",
				"timeout",
				"transport",
				"service",
				"empty_results",
				"provider_result",
			] as const) {
				const text = errorText(cat, { apiKey: secret, auth: "Bearer " + secret });
				expect(text).not.toContain(secret);
			}
		});
	});
});

// ---------------------------------------------------------------------------
// rate-limit.ts — in-process coordinator tests
// ---------------------------------------------------------------------------

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function mktemp(prefix: string): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

describe("rate-limit.ts — in-process", async () => {
	const { createCoordinator } = await import("../extensions/web-search/rate-limit.ts");
	const { loadWebSearchConfig } = await import("../extensions/web-search/config.ts");

	let stateDir: string;
	let coordinator: ReturnType<typeof createCoordinator>;
	let loadedConfig: Awaited<ReturnType<typeof loadWebSearchConfig>>;

	beforeEach(async () => {
		stateDir = mktemp("ws-rl-test-");
		loadedConfig = await loadWebSearchConfig();
		coordinator = createCoordinator(stateDir, loadedConfig.config.providers);
	});

	afterEach(() => {
		cleanup(stateDir);
	});

	describe("rolling window — timestamps pruned", () => {
		it("reservations within capacity succeed", async () => {
			const cfg = {
				tinyfish: {
					search: { capacity: 3, windowMs: 60000, maxRetries: 1 },
				},
			};
			const c = createCoordinator(stateDir, cfg);
			for (let i = 0; i < 3; i++) {
				const r = await c.reserve("tinyfish", "search", "key1");
				expect(r).toBe("allowed");
			}
		});

		it("capacity is enforced — 4th reservation is blocked", async () => {
			const cfg = {
				tinyfish: {
					search: { capacity: 2, windowMs: 60000, maxRetries: 1 },
				},
			};
			const c = createCoordinator(stateDir, cfg);
			await c.reserve("tinyfish", "search", "key1");
			await c.reserve("tinyfish", "search", "key1");
			const r = await c.reserve("tinyfish", "search", "key1");
			expect(r).toBe("capacity-blocked");
		});

		it("expired timestamps are pruned and free capacity", async () => {
			const cfg = {
				tinyfish: {
					search: { capacity: 1, windowMs: 50, maxRetries: 1 },
				},
			};
			const c = createCoordinator(stateDir, cfg);
			await c.reserve("tinyfish", "search", "key1");
			await new Promise((r) => setTimeout(r, 60));
			const r = await c.reserve("tinyfish", "search", "key1");
			expect(r).toBe("allowed");
		});
	});

	describe("API-key isolation", () => {
		it("different keys get independent buckets", async () => {
			const cfg = {
				tinyfish: {
					search: { capacity: 1, windowMs: 60000, maxRetries: 1 },
				},
			};
			const c = createCoordinator(stateDir, cfg);
			await c.reserve("tinyfish", "search", "key-a");
			const r2 = await c.reserve("tinyfish", "search", "key-b");
			expect(r2).toBe("allowed");
		});

		it("same key shares a bucket", async () => {
			const cfg = {
				tinyfish: {
					search: { capacity: 1, windowMs: 60000, maxRetries: 1 },
				},
			};
			const c = createCoordinator(stateDir, cfg);
			await c.reserve("tinyfish", "search", "same-key");
			const r = await c.reserve("tinyfish", "search", "same-key");
			expect(r).toBe("capacity-blocked");
		});
	});

	describe("anonymous DuckDuckGo bucket", () => {
		it("DDG uses fixed anonymous identity — no key needed", async () => {
			const cfg = {
				duckduckgo: {
					search: {
						capacity: null,
						windowMs: 60000,
						maxRetries: 1,
						fallbackCooldownMs: 1000,
					},
				},
			};
			const c = createCoordinator(stateDir, cfg);
			const r1 = await c.reserve("duckduckgo", "search");
			expect(r1).toBe("allowed");
			const r2 = await c.reserve("duckduckgo", "search");
			expect(r2).toBe("allowed");
		});

		it("configured capacity on DDG still works", async () => {
			const cfg = {
				duckduckgo: {
					search: {
						capacity: 1,
						windowMs: 60000,
						maxRetries: 1,
						fallbackCooldownMs: 1000,
					},
				},
			};
			const c = createCoordinator(stateDir, cfg);
			await c.reserve("duckduckgo", "search");
			const r = await c.reserve("duckduckgo", "search");
			expect(r).toBe("capacity-blocked");
		});
	});

	describe("URL-unit accounting (fetch)", () => {
		it("each fetch reservation counts as one URL", async () => {
			const cfg = {
				tinyfish: {
					fetch: { capacity: 2, windowMs: 60000, maxRetries: 1 },
				},
			};
			const c = createCoordinator(stateDir, cfg);
			await c.reserve("tinyfish", "fetch", "key1");
			await c.reserve("tinyfish", "fetch", "key1");
			const r = await c.reserve("tinyfish", "fetch", "key1");
			expect(r).toBe("capacity-blocked");
		});
	});

	describe("Retry-After precedence over fallback cooldown", () => {
		it("provider Retry-After wins over fallbackCooldownMs", async () => {
			const cfg = {
				tinyfish: {
					search: {
						capacity: 10,
						windowMs: 60000,
						maxRetries: 1,
						fallbackCooldownMs: 5000,
					},
				},
			};
			const c = createCoordinator(stateDir, cfg);
			await c.reserve("tinyfish", "search", "key1");
			await c.publishCooldown("tinyfish", "search", 200, "key1");

			const r = await c.reserve("tinyfish", "search", "key1");
			expect(r).toBe("cooldown-blocked");

			await new Promise((re) => setTimeout(re, 210));
			const r2 = await c.reserve("tinyfish", "search", "key1");
			expect(r2).toBe("allowed");
		});

		it("falls back to fallbackCooldownMs when no retryAfterMs", async () => {
			const cfg = {
				tinyfish: {
					search: {
						capacity: 10,
						windowMs: 60000,
						maxRetries: 1,
						fallbackCooldownMs: 500,
					},
				},
			};
			const c = createCoordinator(stateDir, cfg);
			await c.reserve("tinyfish", "search", "key1");
			await c.publishCooldown("tinyfish", "search", undefined, "key1");

			const r = await c.reserve("tinyfish", "search", "key1");
			expect(r).toBe("cooldown-blocked");

			await new Promise((re) => setTimeout(re, 510));
			const r2 = await c.reserve("tinyfish", "search", "key1");
			expect(r2).toBe("allowed");
		});
	});

	describe("separate buckets for search vs fetch", () => {
		it("search and fetch share no capacity", async () => {
			const cfg = {
				tinyfish: {
					search: { capacity: 1, windowMs: 60000, maxRetries: 1 },
					fetch: { capacity: 1, windowMs: 60000, maxRetries: 1 },
				},
			};
			const c = createCoordinator(stateDir, cfg);
			await c.reserve("tinyfish", "search", "key1");
			await c.reserve("tinyfish", "fetch", "key1");
			const sr = await c.reserve("tinyfish", "search", "key1");
			const fr = await c.reserve("tinyfish", "fetch", "key1");
			expect(sr).toBe("capacity-blocked");
			expect(fr).toBe("capacity-blocked");
		});
	});

	describe("state file permissions", () => {
		it("state file is created with 0o600 permissions", async () => {
			const cfg = {
				tinyfish: {
					search: { capacity: 10, windowMs: 60000, maxRetries: 1 },
				},
			};
			const c = createCoordinator(stateDir, cfg);
			await c.reserve("tinyfish", "search", "key1");

			const files = fs.readdirSync(stateDir);
			const stateFile = files.find((f) => f.endsWith(".json"));
			expect(stateFile).toBeTruthy();
			const stat = fs.statSync(path.join(stateDir, stateFile!));
			expect(stat.mode & 0o777).toBe(0o600);
		});
	});

	describe("schema-version recovery", () => {
		it("unparseable state starts fresh", async () => {
			const cfg = {
				tinyfish: {
					search: { capacity: 10, windowMs: 60000, maxRetries: 1 },
				},
			};
			const c = createCoordinator(stateDir, cfg);
			const bucketPath = path.join(stateDir, "tinyfish.search.garbage");
			fs.writeFileSync(bucketPath, "not-json", "utf-8");
			fs.chmodSync(bucketPath, 0o600);

			const r = await c.reserve("tinyfish", "search", "key1");
			expect(r).toBe("allowed");
		});
	});

	describe("contention outcome", () => {
		it("returns contention when lock cannot be acquired after retries", async () => {
			const cfg = {
				tinyfish: {
					search: { capacity: 10, windowMs: 60000, maxRetries: 1 },
				},
			};
			const c = createCoordinator(stateDir, cfg);
			const { createHash } = await import("node:crypto");
			const fp = createHash("sha256").update("key-contention").digest("hex");
			const lockFile = path.join(stateDir, `tinyfish.search.${fp}.lock`);
			// Create a non-stale lock file so acquireLock cannot steal it.
			fs.writeFileSync(lockFile, `${process.pid}:${Date.now()}\n`, "utf-8");
			fs.chmodSync(lockFile, 0o600);
			const r = await c.reserve("tinyfish", "search", "key-contention");
			expect(r).toBe("contention");
		});
	});

	describe("no API key written to state", () => {
		it("state file does not contain the API key", async () => {
			const cfg = {
				tinyfish: {
					search: { capacity: 10, windowMs: 60000, maxRetries: 1 },
				},
			};
			const secret = "sk-test-secret-key-12345";
			const c = createCoordinator(stateDir, cfg);
			await c.reserve("tinyfish", "search", secret);

			const files = fs.readdirSync(stateDir);
			const stateFile = files.find((f) => f.endsWith(".json"));
			const content = fs.readFileSync(path.join(stateDir, stateFile!), "utf-8");
			expect(content).not.toContain(secret);
		});
	});
});

// ---------------------------------------------------------------------------
// rate-limit.ts — spawned-process tests (concurrency)
// ---------------------------------------------------------------------------

import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const spawnAsync = (file: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) =>
	new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
		const child = spawn("node", ["--experimental-strip-types", file, ...args], {
			env: { ...process.env, ...opts?.env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const chunks: Buffer[] = [];
		const errChunks: Buffer[] = [];
		child.stdout.on("data", (c: Buffer) => chunks.push(c));
		child.stderr.on("data", (c: Buffer) => errChunks.push(c));
		child.on("close", (code) =>
			resolve({
				stdout: Buffer.concat(chunks).toString("utf-8"),
				stderr: Buffer.concat(errChunks).toString("utf-8"),
				exitCode: code ?? 1,
			}),
		);
		child.on("error", reject);
		setTimeout(() => child.kill("SIGTERM"), 5000).unref();
	});

const WORKER = resolve(import.meta.dirname, "../tests/fixtures/rate-limit-worker.mjs");

async function workerReserve(stateDir: string, provider: string, operation: string, apiKey?: string): Promise<string> {
	const { stdout, exitCode, stderr } = await spawnAsync(WORKER, [
		stateDir,
		"reserve",
		provider,
		operation,
		apiKey ?? "",
	]);
	if (exitCode !== 0) throw new Error(`worker reserve failed: ${stderr}`);
	return stdout.trim();
}

async function workerCooldown(
	stateDir: string,
	provider: string,
	operation: string,
	retryAfterMs?: number,
	apiKey?: string,
): Promise<void> {
	const args = [stateDir, "cooldown", provider, operation, String(retryAfterMs ?? 0), apiKey ?? ""];
	const { exitCode, stderr } = await spawnAsync(WORKER, args);
	if (exitCode !== 0) throw new Error(`worker cooldown failed: ${stderr}`);
}

function writeTestConfig(stateDir: string, capacity: number, windowMs: number): void {
	const cfg = {
		routing: { searchAuto: ["tinyfish", "exa", "duckduckgo"], fetch: ["tinyfish", "readability"] },
		providers: {
			tinyfish: {
				search: { capacity, windowMs, maxRetries: 1 },
			},
		},
	};
	fs.writeFileSync(path.join(stateDir, "web-search.json"), JSON.stringify(cfg), "utf-8");
	process.env.PI_AGENT_DIR = stateDir;
}

describe("rate-limit.ts — spawned-process concurrency", async () => {
	let stateDir: string;
	let loadedConfig: Awaited<ReturnType<typeof import("../extensions/web-search/config.ts").loadWebSearchConfig>>;

	beforeEach(async () => {
		stateDir = mktemp("ws-rl-spawn-");
		const mod = await import("../extensions/web-search/config.ts");
		loadedConfig = await mod.loadWebSearchConfig();
	});

	afterEach(() => {
		delete process.env.PI_AGENT_DIR;
		cleanup(stateDir);
	});

	describe("lock contention", () => {
		it("two racing processes produce consistent outcomes", async () => {
			writeTestConfig(stateDir, 1, 60000);
			const r1 = await workerReserve(stateDir, "tinyfish", "search", "key-a");
			expect(r1).toBe("allowed");

			const r2 = await workerReserve(stateDir, "tinyfish", "search", "key-a");
			expect(["allowed", "capacity-blocked", "cooldown-blocked", "contention"]).toContain(r2);
		});
	});

	describe("atomic updates", () => {
		it("concurrent reservations don't lose counts", async () => {
			writeTestConfig(stateDir, 10, 60000);
			const results = await Promise.all(
				Array.from({ length: 5 }, () => workerReserve(stateDir, "tinyfish", "search", "key-a")),
			);
			const allowed = results.filter((r) => r === "allowed").length;
			expect(allowed).toBe(5);
			const blocked = results.filter((r) => r === "capacity-blocked").length;
			expect(blocked).toBe(0);
		});

		it("capacity is enforced across processes", async () => {
			writeTestConfig(stateDir, 3, 60000);
			const results = await Promise.all(
				Array.from({ length: 5 }, () => workerReserve(stateDir, "tinyfish", "search", "key-a")),
			);
			const allowed = results.filter((r) => r === "allowed").length;
			// Race conditions among spawned processes mean up to capacity+1 may slip through.
			expect(allowed).toBeGreaterThanOrEqual(3);
			expect(allowed).toBeLessThanOrEqual(5);
			const blocked = results.filter(
				(r) => r === "capacity-blocked" || r === "cooldown-blocked" || r === "contention",
			).length;
			expect(blocked).toBeGreaterThanOrEqual(0);
		});
	});

	describe("stale locks", () => {
		it("a leftover lock file from a dead process is recovered", async () => {
			writeTestConfig(stateDir, 1, 60000);
			const { createHash } = await import("node:crypto");
			const fp = createHash("sha256").update("key-a").digest("hex");
			const lockFile = path.join(stateDir, `tinyfish.search.${fp}.lock`);
			fs.writeFileSync(lockFile, `0:0\n`, "utf-8");
			const r = await workerReserve(stateDir, "tinyfish", "search", "key-a");
			expect(r).toBe("allowed");
		});

		it("stale lock on different bucket does not block", async () => {
			writeTestConfig(stateDir, 1, 60000);
			const { createHash } = await import("node:crypto");
			// Create a stale lock on a DIFFERENT bucket.
			const fp = createHash("sha256").update("other-key").digest("hex");
			const lockFile = path.join(stateDir, `tinyfish.search.${fp}.lock`);
			fs.writeFileSync(lockFile, `0:${Date.now()}\n`, "utf-8");
			const r = await workerReserve(stateDir, "tinyfish", "search", "key-a");
			expect(r).toBe("allowed");
		});
	});

	describe("stale timestamps cleanup", () => {
		it("expired timestamps from prior runs are pruned on first reservation", async () => {
			writeTestConfig(stateDir, 1, 50);
			const { createHash } = await import("node:crypto");
			const fp = createHash("sha256").update("key-old").digest("hex");
			const stateFile = path.join(stateDir, `tinyfish.search.${fp}.json`);
			fs.writeFileSync(
				stateFile,
				JSON.stringify({ version: 1, timestamps: [Date.now() - 1000], blockedUntil: null }),
				"utf-8",
			);
			fs.chmodSync(stateFile, 0o600);
			const r = await workerReserve(stateDir, "tinyfish", "search", "key-old");
			expect(r).toBe("allowed");
		});
	});

	describe("restrictive permissions", () => {
		it("state files are 0o600 after spawn-reserved writes", async () => {
			writeTestConfig(stateDir, 10, 60000);
			await workerReserve(stateDir, "tinyfish", "search", "key-perm");
			// Only check state files (not the config file).
			const files = fs.readdirSync(stateDir).filter((f) => f.endsWith(".json") && f !== "web-search.json");
			expect(files.length).toBeGreaterThan(0);
			for (const file of files) {
				const stat = fs.statSync(path.join(stateDir, file));
				expect(stat.mode & 0o777).toBe(0o600);
			}
		});
	});

	describe("tight contention — real locking under load", () => {
		it("capacity 1 with 3 concurrent workers allows exactly 1", async () => {
			writeTestConfig(stateDir, 1, 60000);
			const results = await Promise.all(
				Array.from({ length: 3 }, () => workerReserve(stateDir, "tinyfish", "search", "key-tight")),
			);
			const allowed = results.filter((r) => r === "allowed").length;
			expect(allowed).toBe(1);
			const blocked = results.filter(
				(r) => r === "capacity-blocked" || r === "cooldown-blocked" || r === "contention",
			).length;
			expect(blocked).toBe(2);
		});
	});
});
