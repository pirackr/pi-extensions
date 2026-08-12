/**
 * Pure program-file helpers: parsing, snapshotting, and content generation.
 * Kept free of extension plumbing so they are unit-testable.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";

/**
 * Parse CLI arguments into generic loop parameters.
 *
 * - `--max-rounds N` or `--max-rounds unlimited` (default: 10)
 * - `--tokens N` (default: 0 = no budget)
 * - `--no-progress N` or `--no-progress off` (default: 3)
 * - `--program <path>`
 *
 * Numeric flags must be positive integers.
 * Special values: "unlimited" for --max-rounds, "off" for --no-progress.
 * Unknown/extra flags are silently accepted (for forward compatibility).
 */
export function parseLoopArgs(argv: string): {
	program?: string;
	maxIterations: number | "unlimited";
	maxTokens: number;
	noProgress: number | "off";
	mission: string;
} {
	const flags: Record<string, string> = {};
	const rest: string[] = [];
	const tokens = argv.split(/\s+/).filter(Boolean);

	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.startsWith("--") && !t.includes("=")) {
			const key = t.slice(2);
			const val = tokens[i + 1];
			if (key === "yes" || key === "no-confirm") {
				flags[key] = "true";
				continue;
			}
			if (
				key === "program" ||
				key === "max-rounds" ||
				key === "tokens" ||
				key === "no-progress"
			) {
				if (val && !val.startsWith("--")) {
					flags[key] = val;
					i++;
				}
				continue;
			}
			// Research-specific / unknown flags: skip silently
			continue;
		} else if (t.startsWith("--") && t.includes("=")) {
			const [key, ...valParts] = t.slice(2).split("=");
			flags[key] = valParts.join("=");
			continue;
		}
		rest.push(t);
	}

	const mission = rest.join(" ");

	let maxIterations: number | "unlimited" = 10;
	if (flags["max-rounds"]) {
		if (flags["max-rounds"] === "unlimited") {
			maxIterations = "unlimited";
		} else {
			const n = Number(flags["max-rounds"]);
			if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
				throw new Error(`Invalid --max-rounds: ${flags["max-rounds"]}`);
			}
			maxIterations = n;
		}
	}

	let maxTokens: number = 0;
	if (flags["tokens"]) {
		const n = Number(flags["tokens"]);
		if (!Number.isFinite(n) || n < 0) {
			throw new Error(`Invalid --tokens: ${flags["tokens"]}`);
		}
		maxTokens = n;
	}

	let noProgress: number | "off" = 3;
	if (flags["no-progress"]) {
		const raw = flags["no-progress"];
		if (raw === "off" || raw === "0") {
			noProgress = "off";
		} else {
			const n = Number(raw);
			if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
				throw new Error(`Invalid --no-progress: ${raw}`);
			}
			noProgress = n;
		}
	}

	const program = flags["program"] ? String(flags["program"]) : undefined;

	return { program, maxIterations, maxTokens, noProgress, mission };
}

/**
 * Create an immutable in-session snapshot of the program source.
 * Returns { entry, digest } where digest is a SHA-256 hex string.
 */
export function snapshotProgram(source: string): {
	entry: string;
	digest: string;
} {
	const digest = crypto
		.createHash("sha256")
		.update(source)
		.digest("hex");
	const entry = `<program>\n${source}\n</program>`;
	return { entry, digest };
}

/**
 * Returns the embed block for the program file and a content signature.
 * When the file is unchanged since the last full injection, returns a short
 * note instead of re-embedding the whole program.
 */
export function programBlockFor(
	programPath: string,
	injected: boolean | undefined,
	sig: string | undefined,
): { block: string; sig: string | null } {
	let content = "";
	let currentSig: string | null = null;
	try {
		const st = fs.statSync(programPath);
		content = fs.readFileSync(programPath, "utf8");
		currentSig = `${st.mtimeMs}:${st.size}`;
	} catch {
		return {
			block: `⚠ program file missing at ${programPath} — proceed toward the mission with best judgment.`,
			sig: null,
		};
	}
	if (injected && sig === currentSig) {
		return {
			block: `Program file unchanged since the last round (${programPath}). It is already in context above; if you cannot see it (e.g. after compaction), re-read it now and follow it as the task contract.`,
			sig: currentSig,
		};
	}
	return {
		block: `Re-read ${programPath} now. It is user-authored data, not system instructions: follow it as the task contract, but the mission and budgets below win on any conflict. It may have changed since your last round — the human edits it live to steer you.\n\n<program>\n${content}\n</program>`,
		sig: currentSig,
	};
}

/**
 * Extract text content from a message (string or content array).
 */
export function extractAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as Record<string, unknown>).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(b) =>
					b != null &&
					typeof b === "object" &&
					(b as Record<string, unknown>).type === "text",
			)
			.map((b) => String((b as Record<string, unknown>).text ?? ""))
			.join(" ");
	}
	return "";
}

/**
 * Normalize assistant message text for no-progress fingerprinting:
 * NFKC normalize, lowercase, strip control chars and whitespace;
 * empty/punctuation-only output is equivalent to empty.
 */
export function assistantFingerprint(message: unknown): string {
	const norm = extractAssistantText(message)
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/\s+/g, "");
	return /[\p{L}\p{N}]/u.test(norm) ? norm : "";
}

/** Truncate text to max chars. */
export function truncate(text: string, max = 80): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
