#!/usr/bin/env node
/**
 * Standalone worker for cross-process rate-limit tests.
 * Implements the same bucket/state logic as rate-limit.ts with zero deps
 * beyond node:fs, node:crypto, and node:path.
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

import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const SCHEMA_VERSION = 1;
const STATE_SUFFIX = ".json";
const LOCK_SUFFIX = ".lock";
const DEFAULT_FALLBACK_COOLDOWN_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const MAX_LOCK_RETRIES = 20;
const LOCK_RETRY_BASE_MS = 5;

const ANONYMOUS_FINGERPRINT = createHash("sha256")
	.update("anonymous-ddg")
	.digest("hex");

function fingerprint(key) {
	if (!key) return ANONYMOUS_FINGERPRINT;
	return createHash("sha256").update(key).digest("hex");
}

function bucketPath(stateDir, provider, operation, apiKey) {
	const fp = fingerprint(apiKey);
	return resolve(stateDir, `${provider}.${operation}.${fp}${STATE_SUFFIX}`);
}

function lockPath(stateDir, provider, operation, apiKey) {
	const fp = fingerprint(apiKey);
	return resolve(stateDir, `${provider}.${operation}.${fp}${LOCK_SUFFIX}`);
}

function readState(file) {
	try {
		const raw = readFileSync(file, "utf-8");
		const parsed = JSON.parse(raw);
		if (typeof parsed.version !== "number" || !Array.isArray(parsed.timestamps)) {
			return { version: SCHEMA_VERSION, timestamps: [], blockedUntil: null };
		}
		const timestamps = parsed.timestamps.filter((v) => typeof v === "number");
		const blockedUntil = typeof parsed.blockedUntil === "number" ? parsed.blockedUntil : null;
		return { version: SCHEMA_VERSION, timestamps, blockedUntil };
	} catch {
		return { version: SCHEMA_VERSION, timestamps: [], blockedUntil: null };
	}
}

function writeState(file, state) {
	const dir = resolve(file, "..");
	mkdirSync(dir, { recursive: true });
	const tmp = file + ".tmp";
	writeFileSync(tmp, JSON.stringify(state), "utf-8");
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
}

function acquireLock(lockFile) {
	const start = Date.now();
	for (let i = 0; i < MAX_LOCK_RETRIES; i++) {
		try {
			const fd = openSync(lockFile, "wx", 0o600);
			writeFileSync(lockFile, `${process.pid}:${Date.now()}\n`, { flag: "w" });
			return fd;
		} catch (err) {
			const code =
				err && typeof err === "object" && "code" in err ? err.code : null;
			if (code !== "EEXIST" && code !== "EACCES") return -1;
			try {
				const content = readFileSync(lockFile, "utf-8");
				const parts = content.trim().split(":");
				const lockTime = parts.length >= 2 ? Number(parts[1]) : 0;
				if (Date.now() - lockTime > STALE_LOCK_MS) {
					unlinkSync(lockFile);
					continue;
				}
			} catch {
				continue;
			}
			if (Date.now() - start > 2000) return -1;
			const jitter = Math.random() * LOCK_RETRY_BASE_MS;
			const end = Date.now() + LOCK_RETRY_BASE_MS + jitter;
			while (Date.now() < end) {}
		}
	}
	return -1;
}

function releaseLock(lockFile) {
	try {
		unlinkSync(lockFile);
	} catch {
		// best-effort
	}
}

function getCapacity(provider, operation) {
	const configPath = resolve(process.env.PI_AGENT_DIR || ".", "web-search.json");
	try {
		const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
		const opCfg = cfg.providers?.[provider]?.[operation];
		if (opCfg) return opCfg.capacity ?? null;
	} catch {
		// no config
	}
	return null;
}

function getWindowMs(provider, operation) {
	const configPath = resolve(process.env.PI_AGENT_DIR || ".", "web-search.json");
	try {
		const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
		const opCfg = cfg.providers?.[provider]?.[operation];
		if (opCfg) return opCfg.windowMs ?? 60_000;
	} catch {
		return 60_000;
	}
}

function getFallbackCooldownMs(provider, operation) {
	const configPath = resolve(process.env.PI_AGENT_DIR || ".", "web-search.json");
	try {
		const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
		const opCfg = cfg.providers?.[provider]?.[operation];
		if (opCfg) return opCfg.fallbackCooldownMs ?? DEFAULT_FALLBACK_COOLDOWN_MS;
	} catch {
		return DEFAULT_FALLBACK_COOLDOWN_MS;
	}
}

const [, , stateDir, action, ...args] = process.argv;

if (!stateDir || !action) {
	console.error("usage: rate-limit-worker.mjs <stateDir> <action> [args...]");
	process.exit(1);
}

if (action === "reserve") {
	const [provider, operation, apiKey] = args;
	const stateFile = bucketPath(stateDir, provider, operation, apiKey);
	const lockFile = lockPath(stateDir, provider, operation, apiKey);
	const capacity = getCapacity(provider, operation);
	const windowMs = getWindowMs(provider, operation);

	const fd = acquireLock(lockFile);
	if (fd < 0) {
		console.log("contention");
		process.exit(0);
	}
	try {
		const state = readState(stateFile);
		const now = Date.now();
		state.timestamps = state.timestamps.filter((t) => t > now - windowMs);
		if (state.blockedUntil !== null && now < state.blockedUntil) {
			writeState(stateFile, state);
			console.log("cooldown-blocked");
			process.exit(0);
		}
		if (capacity !== null && state.timestamps.length >= capacity) {
			writeState(stateFile, state);
			console.log("capacity-blocked");
			process.exit(0);
		}
		state.timestamps.push(now);
		writeState(stateFile, state);
		console.log("allowed");
	} finally {
		releaseLock(lockFile);
	}
} else if (action === "cooldown") {
	const [provider, operation, retryAfterMsStr, apiKey] = args;
	const stateFile = bucketPath(stateDir, provider, operation, apiKey);
	const lockFile = lockPath(stateDir, provider, operation, apiKey);
	const fallbackCooldownMs = getFallbackCooldownMs(provider, operation);
	const retryAfterMs = retryAfterMsStr ? Number(retryAfterMsStr) : undefined;
	const cooldownMs = retryAfterMs ?? fallbackCooldownMs;

	const fd = acquireLock(lockFile);
	if (fd < 0) process.exit(0);
	try {
		const state = readState(stateFile);
		state.blockedUntil = Date.now() + cooldownMs;
		writeState(stateFile, state);
		console.log("cooldown-published");
	} finally {
		releaseLock(lockFile);
	}
} else if (action === "read") {
	const [provider, operation, apiKey] = args;
	const fp = fingerprint(args[2] || "");
	const stateFile = resolve(stateDir, `${provider}.${operation}.${fp}.json`);
	try {
		console.log(readFileSync(stateFile, "utf-8"));
	} catch {
		console.log("{}");
	}
} else if (action === "count") {
	const [provider, operation, apiKey] = args;
	const fp = fingerprint(args[2] || "");
	const stateFile = resolve(stateDir, `${provider}.${operation}.${fp}.json`);
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
