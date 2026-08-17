// extensions/opencode-zen/index.ts
//
// OpenCode Zen provider for pi. Lets pi use OpenCode's hosted models — including
// the free tier (deepseek-v4-flash-free, nemotron-3-ultra-free, big-pickle, ...) —
// the same way the opencode CLI does.
//
// How opencode works without a key: the client authenticates anonymously with the
// shared credential `public` plus opencode client headers (x-opencode-client,
// x-opencode-session, x-opencode-project, x-opencode-request) and a CLI User-Agent.
// The Zen gateway recognizes the client and grants access to the free models,
// rate-limited. This extension mirrors that:
//   - no OPENCODE_API_KEY configured  -> anonymous "public" mode, free models only
//   - OPENCODE_API_KEY=public          -> same anonymous mode
//   - OPENCODE_API_KEY=<real key>      -> all Zen models (free + paid)
//
// Only models served over the OpenAI-compatible /chat/completions endpoint are
// registered (that covers every free model and the DeepSeek/MiniMax/GLM/Kimi
// families). Claude/GPT/Gemini lines need other streaming APIs and are omitted.
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PROVIDER_NAME = "opencode-zen";
const API_KEY_ENV = "OPENCODE_API_KEY";
const BASE_URL = "https://opencode.ai/zen/v1";
const MODELS_DEV_URL = "https://models.dev/api.json";
const ANONYMOUS_KEY = "public";
const OPENCODE_UA = "opencode/latest/1.3.15/cli";

// Static catalog (fallback when the live endpoints are unreachable). Context
// windows/max tokens are from models.dev / the official Zen docs where known.
// `visible` is refined at load time by GET /zen/v1/models + models.dev status/cost.
export const staticModels: ProviderModelConfig[] = [
	// --- free tier -------------------------------------------------------
	{
		id: "big-pickle",
		name: "Big Pickle",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 128000,
	},
	{
		id: "deepseek-v4-flash-free",
		name: "DeepSeek V4 Flash Free",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 131072,
	},
	{
		id: "hy3-free",
		name: "Hy3 Free",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 64000,
	},
	{
		id: "laguna-s-2.1-free",
		name: "Laguna S 2.1 Free",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 64000,
	},
	{
		id: "mimo-v2.5-free",
		name: "MiMo-V2.5 Free",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 128000,
	},
	{
		id: "nemotron-3-ultra-free",
		name: "Nemotron 3 Ultra Free",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 128000,
	},
	{
		id: "nemotron-3.5-lightning-free",
		name: "Nemotron 3.5 Lightning Free",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 65536,
	},
	{
		id: "north-mini-code-free",
		name: "North Mini Code Free",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 65536,
	},
	// --- paid (OpenAI-compatible only) -----------------------------------
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.74, output: 3.48, cacheRead: 0.145, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 128000,
	},
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 128000,
	},
	{
		id: "minimax-m3",
		name: "MiniMax M3",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
		contextWindow: 1048576,
		maxTokens: 128000,
	},
	{
		id: "minimax-m2.7",
		name: "MiniMax M2.7",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 131072,
	},
	{
		id: "glm-5.2",
		name: "GLM 5.2",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		contextWindow: 202752,
		maxTokens: 131072,
	},
	{
		id: "glm-5.1",
		name: "GLM 5.1",
		reasoning: true,
		input: ["text"],
		cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
		contextWindow: 202752,
		maxTokens: 131072,
	},
	{
		id: "kimi-k2.7-code",
		name: "Kimi K2.7 Code",
		reasoning: true,
		input: ["text"],
		cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 131072,
	},
	{
		id: "kimi-k3",
		name: "Kimi K3",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 131072,
	},
	{
		id: "kimi-k2.6",
		name: "Kimi K2.6",
		reasoning: false,
		input: ["text"],
		cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
		contextWindow: 262144,
		maxTokens: 131072,
	},
];

interface ModelsDevModelInfo {
	status?: string | null;
	cost?: {
		input?: number | null;
		output?: number | null;
		cache_read?: number | null;
		cache_write?: number | null;
	} | null;
}

function isFreeModel(info: ModelsDevModelInfo | undefined): boolean {
	const input = info?.cost?.input;
	return typeof input === "number" && input === 0;
}

export function isAnonymousMode(apiKey: string | undefined): boolean {
	return !apiKey || apiKey === ANONYMOUS_KEY;
}

/**
 * Resolve the Zen credential: env var, then ~/.pi/agent/auth.json
 * ("opencode-zen" entry), then the anonymous "public" shared credential.
 * authPath is injectable for tests.
 */
export function resolveApiKey(authPath?: string): string {
	const env = process.env[API_KEY_ENV]?.trim();
	if (env) return env;
	if (authPath) {
		try {
			const auth = JSON.parse(readFileSync(authPath, "utf8")) as Record<
				string,
				{ key?: string }
			>;
			const key = auth?.[PROVIDER_NAME]?.key?.trim();
			if (key) return key;
		} catch {
			// missing/unreadable auth.json — fall through to anonymous
		}
	}
	return ANONYMOUS_KEY;
}

export function opencodeHeaders(): Record<string, string> {
	const id = () => crypto.randomUUID().replace(/-/g, "").slice(0, 26);
	return {
		"User-Agent": OPENCODE_UA,
		"x-opencode-client": "cli",
		"x-opencode-session": id(),
		"x-opencode-project": id(),
		"x-opencode-request": id(),
	};
}

export async function fetchVisibleModelIds(
	apiKey: string,
): Promise<Set<string> | undefined> {
	try {
		const response = await fetch(`${BASE_URL}/models`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});
		if (!response.ok) return undefined;
		const json = (await response.json()) as { data?: Array<{ id?: string }> };
		return new Set(
			(json.data ?? [])
				.map((m) => m.id)
				.filter((id): id is string => Boolean(id)),
		);
	} catch {
		return undefined;
	}
}

export async function fetchModelsDevInfo(): Promise<
	Record<string, ModelsDevModelInfo> | undefined
> {
	try {
		const response = await fetch(MODELS_DEV_URL);
		if (!response.ok) return undefined;
		const json = (await response.json()) as {
			opencode?: { models?: Record<string, ModelsDevModelInfo> };
		};
		return json.opencode?.models;
	} catch {
		return undefined;
	}
}

/**
 * Compute the provider model list:
 * - visibleIds (live /zen/v1/models) narrows the static catalog when available
 * - models.dev status === "deprecated" removes dead models
 * - anonymous/public mode keeps only free models (models.dev cost.input === 0;
 *   falls back to the static catalog's own zero-cost entries offline)
 */
export function getVisibleModels(
	visibleIds?: Set<string>,
	modelsDevInfo?: Record<string, ModelsDevModelInfo>,
	anonymousMode = false,
): ProviderModelConfig[] {
	let models = visibleIds
		? staticModels.filter((m) => visibleIds.has(m.id))
		: [...staticModels];
	if (modelsDevInfo) {
		models = models.filter(
			(m) => modelsDevInfo[m.id]?.status !== "deprecated",
		);
		if (anonymousMode) {
			models = models.filter((m) => isFreeModel(modelsDevInfo[m.id]));
		}
	} else if (anonymousMode) {
		models = models.filter((m) => m.cost?.input === 0);
	}
	return models.map((m) => ({ ...m, cost: { ...m.cost! } }));
}

export default async function (pi: ExtensionAPI): Promise<void> {
	const apiKey = resolveApiKey(join(process.env["HOME"] ?? "", ".pi", "agent", "auth.json"));
	const anonymous = isAnonymousMode(apiKey);
	const [visibleIds, modelsDevInfo] = await Promise.all([
		apiKey ? fetchVisibleModelIds(apiKey) : Promise.resolve(undefined),
		fetchModelsDevInfo(),
	]);

	pi.registerProvider(PROVIDER_NAME, {
		name: "OpenCode Zen",
		baseUrl: BASE_URL,
		api: "openai-completions",
		apiKey,
		headers: opencodeHeaders(),
		models: getVisibleModels(visibleIds, modelsDevInfo, anonymous),
	});
}