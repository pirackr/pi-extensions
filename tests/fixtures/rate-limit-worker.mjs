#!/usr/bin/env node
/**
 * Standalone worker for cross-process rate-limit tests.
 * Imports the real RateLimitCoordinator from rate-limit.ts.
 *
 * Usage:
 *   node tests/fixtures/rate-limit-worker.mjs <stateDir> <action> [args...]
 *
 * Actions:
 *   reserve   <provider> <operation> <apiKey>
 *   cooldown  <provider> <operation> <retryAfterMs> <apiKey>
 *   read      <provider> <operation> <apiKey>
 *   count     <provider> <operation> <apiKey>
 */

import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const stateDirArg = process.argv[2];
const action = process.argv[3];
const args = process.argv.slice(4);

if (!stateDirArg || !action) {
	console.error("usage: rate-limit-worker.mjs <stateDir> <action> [args...]");
	process.exit(1);
}

// Import the real coordinator via dynamic import (supports .ts in Node v24).
const { createCoordinator } = await import(
	resolve(__dirname, "../../extensions/web-search/rate-limit.ts")
);

// Resolve config from PI_AGENT_DIR or stateDir.
const configPath = resolve(process.env.PI_AGENT_DIR || stateDirArg, "web-search.json");
let providersConfig = {};
try {
	const raw = JSON.parse(
		(await import("node:fs")).readFileSync(configPath, "utf-8"),
	);
	providersConfig = raw.providers ?? {};
} catch {
	// No config — providers will default to null capacity / 60s windows.
}

if (action === "reserve") {
	const [provider, operation, apiKey] = args;
	console.error("PID", process.pid, "reserve", provider, operation, apiKey, "stateDir=", stateDirArg, "config=", JSON.stringify(providersConfig[provider]?.[operation]));
	const c = createCoordinator(stateDirArg, providersConfig);
	const result = await c.reserve(provider, operation, apiKey);
	console.log(result);
} else if (action === "cooldown") {
	const [provider, operation, retryAfterMsStr, apiKey] = args;
	const c = createCoordinator(stateDirArg, providersConfig);
	await c.publishCooldown(
		provider,
		operation,
		retryAfterMsStr ? Number(retryAfterMsStr) : undefined,
		apiKey,
	);
	console.log("cooldown-published");
} else if (action === "read") {
	const [provider, operation, apiKey] = args;
	const { readFileSync } = await import("node:fs");
	const { resolve: resolvePath } = await import("node:path");
	const { createHash } = await import("node:crypto");
	const fp = createHash("sha256").update(apiKey || "").digest("hex");
	const stateFile = resolvePath(stateDirArg, `${provider}.${operation}.${fp}.json`);
	try {
		console.log(readFileSync(stateFile, "utf-8"));
	} catch {
		console.log("{}");
	}
} else if (action === "count") {
	const [provider, operation, apiKey] = args;
	const { readFileSync } = await import("node:fs");
	const { resolve: resolvePath } = await import("node:path");
	const { createHash } = await import("node:crypto");
	const fp = createHash("sha256").update(apiKey || "").digest("hex");
	const stateFile = resolvePath(stateDirArg, `${provider}.${operation}.${fp}.json`);
	try {
		const data = JSON.parse(readFileSync(stateFile, "utf-8"));
		console.log((data.timestamps || []).length);
	} catch {
		console.log(0);
	}
} else {
	console.error(`unknown action: ${action}`);
	process.exit(1);
}
