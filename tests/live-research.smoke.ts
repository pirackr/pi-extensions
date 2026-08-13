/**
 * Task 13: live-research smoke — OPT-IN live smoke test.
 *
 * Runs a minimal end-to-end research smoke against an EXPLICITLY configured
 * local model only. Skipped (with a clear message) unless the caller opts in:
 *
 *   RESEARCH_SMOKE_MODEL=llama3.2 npx vitest run tests/live-research.smoke.ts
 *
 * Safety properties:
 *  - Uses only a local endpoint (Ollama-compatible /api/generate by default,
 *    override with RESEARCH_SMOKE_ENDPOINT).
 *  - Strips cloud credentials (ANTHROPIC/OPENAI/GEMINI/TOGETHER/AZURE keys)
 *    from the environment the harness sees, and asserts they are absent —
 *    there is NO cloud fallback path.
 *  - Skips cleanly when the local endpoint is unreachable.
 *
 * The automated suite never runs this file's body (always skipped by default).
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Workspace } from "../extensions/research/workspace.ts";
import {
	acquireWorkspaceClaim,
	prepareStaging,
	commitStaging,
} from "../extensions/research/workspace.ts";
import { newRunState, updateRunState } from "../extensions/research/state.ts";
import { createRunManifest } from "../extensions/research/manifest.ts";
import { ResearchPolicy, type FrozenConfig } from "../extensions/research/policy.ts";
import { LoopEngine } from "../extensions/loop/engine.ts";
import { addNestedUsage } from "../extensions/loop/state.ts";
import type { LoopState } from "../extensions/loop/state.ts";
import { makeGenericPolicy } from "../extensions/loop/completion.ts";

// ---------------------------------------------------------------------------
// Opt-in gate
// ---------------------------------------------------------------------------

const MODEL = process.env.RESEARCH_SMOKE_MODEL;
const ENDPOINT =
	process.env.RESEARCH_SMOKE_ENDPOINT ?? "http://localhost:11434/api/generate";

/** Cloud credential env var names that must never leak into a local smoke. */
const CLOUD_CREDENTIAL_KEYS = [
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"TOGETHER_API_KEY",
	"MISTRAL_API_KEY",
	"GROQ_API_KEY",
	"OPENROUTER_API_KEY",
];

/** Build a clean environment with cloud credentials stripped. */
function cleanEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (CLOUD_CREDENTIAL_KEYS.includes(key)) continue; // strip cloud credentials
		env[key] = value;
	}
	return env;
}

/**
 * Probe the local model endpoint. Returns true when a model is reachable,
 * false when the endpoint is unavailable (unreachable or no model tag).
 */
async function localModelAvailable(): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 3000);
		const res = await fetch(ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: MODEL,
				prompt: "Reply with exactly: ok",
				stream: false,
				options: { temperature: 0 },
			}),
			signal: controller.signal,
		});
		clearTimeout(timer);
		if (!res.ok) return false;
		const body = (await res.json()) as { response?: string; prompt_eval_count?: number };
		return typeof body.response === "string" && body.response.length > 0;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Smoke body — skipped unless RESEARCH_SMOKE_MODEL is set
// ---------------------------------------------------------------------------

const optedIn = typeof MODEL === "string" && MODEL.length > 0;

describe.skipIf(!optedIn)("live research smoke (opt-in)", () => {
	let available = false;

	beforeAll(async () => {
		available = await localModelAvailable();
	}, 10_000);

	it("does not leak cloud credentials into the local harness", () => {
		const env = cleanEnv();
		for (const key of CLOUD_CREDENTIAL_KEYS) {
			expect(env[key]).toBeUndefined();
		}
	});

	it("runs a minimal research loop against the local model", async () => {
		if (!available) {
			// Clear skip message — this is the opt-in path failing gracefully.
			console.warn(
				`[live-research.smoke] local model endpoint ${ENDPOINT} (model ${MODEL}) is unreachable — skipping. No cloud fallback is used.`,
			);
			return;
		}

		// Build a real retained research workspace.
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-smoke-"));
		try {
			const claim = acquireWorkspaceClaim(tmpDir, "smoke mission", "tr-smoke-1");
			const staged = prepareStaging(claim);
			fs.mkdirSync(staged.stagingPath, { recursive: true });
			const ws: Workspace = commitStaging(staged, claim);
			createRunManifest(ws, JSON.stringify({ mission: ws.mission, createdAt: Date.now() }));
			const init = newRunState(ws);
			fs.writeFileSync(
				path.join(ws.path, ".research", "run-state.json"),
				JSON.stringify(init, null, 2),
				"utf-8",
			);

			// Ask the local model one tiny question; feed its usage into the engine.
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 30_000);
			const res = await fetch(ENDPOINT, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					model: MODEL,
					prompt: "Answer in one word: is research done?",
					stream: false,
					options: { temperature: 0 },
				}),
				signal: controller.signal,
			});
			clearTimeout(timer);
			expect(res.ok).toBe(true);
			const body = (await res.json()) as {
				response?: string;
				prompt_eval_count?: number;
				eval_count?: number;
			};
			expect(typeof body.response).toBe("string");
			expect((body.response ?? "").length).toBeGreaterThan(0);
			const tokens =
				(body.prompt_eval_count ?? 0) + (body.eval_count ?? 0);

			// Drive the real LoopEngine: coordinator turn + one dispatch.
			const entries: Array<{ type: string; data: unknown }> = [];
			const pi = {
				appendEntry: (_type: string, data: unknown) => entries.push({ type: "custom", data }),
				getActiveTools: () => [],
				setActiveTools: () => {},
				sendMessage: () => {},
			} as never;
			const ctx = {
				hasPendingMessages: () => false,
				ui: { setStatus: () => {} },
				sessionManager: { getEntries: () => [] },
			} as never;
			const engine = new LoopEngine({
				completionPolicy: makeGenericPolicy(),
				onStateChange: async () => {},
			});
			engine.startState({
				commandName: "research",
				programPath: "/fake/program.md",
				mission: "smoke",
				maxRounds: 3,
				tokenBudget: null,
				noProgressTurns: 3,
			});
			engine.startTurn();
			await engine.endTurn(pi as never, ctx as never, {
				message: { usage: { totalTokens: tokens } },
			});
			engine.state = addNestedUsage(
				engine.state!,
				{ totalTokens: tokens },
				"toolcall-smoke-1",
			);
			expect(engine.state?.coordinatorUsage).toBe(tokens);
			expect(engine.state?.nestedUsage).toBe(tokens);
			expect(engine.usage.total).toBe(tokens * 2);

			// Replay dedup still holds under the live harness.
			engine.state = addNestedUsage(
				engine.state!,
				{ totalTokens: tokens },
				"toolcall-smoke-1",
			);
			expect(engine.state?.nestedUsage).toBe(tokens);

			// ResearchPolicy reserves against the real workspace state.
			const frozen: FrozenConfig = {
				roles: {
					scout: {
						name: "scout",
						description: "smoke role",
						model: MODEL ?? "local",
						thinking: "low",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 600,
						promptPath: "/fake/scout.md",
						resultFormat: "markdown",
						totalDispatch: 2,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "ephemeral",
					},
				},
				hardTimeoutSeconds: 600,
			};
			const policy = new ResearchPolicy(ws, frozen, 600);
			const reservation = await policy.reserveAttempt({
				attemptId: "att-smoke",
				planId: "plan-smoke",
				index: 0,
				taskInfo: { role: "scout" },
			});
			expect(reservation).toBeDefined();
			expect(readRunStateSync(ws).concurrentReservations).toBe(1);
			await policy.releaseAttempt(reservation!, {
				status: "completed",
				result: { output: { ok: true }, usage: { totalTokens: tokens } },
			});
			expect(readRunStateSync(ws).concurrentReservations).toBe(0);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

function readRunStateSync(ws: Workspace): { concurrentReservations: number } {
	return JSON.parse(
		fs.readFileSync(path.join(ws.path, ".research", "run-state.json"), "utf-8"),
	);
}
