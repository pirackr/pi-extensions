// extensions/web-search/credentials.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Credentials {
	tinyfish: string | null;
	exa: string | null;
	tavily: string | null;
}

/**
 * Resolves an API key from environment variables first, then from the
 * repository-root .env file. Returns null when absent.
 *
 * Resolution path for the .env file: from this module up to the repo root
 * (same pattern used by exa.ts and tavily.ts).
 */
function resolveApiKey(envName: string): string | null {
	// Environment variable takes precedence
	if (process.env[envName]) return process.env[envName]!.trim();

	// Fall back to repo-root .env
	try {
		const envPath = resolve(import.meta.dirname, "../../../.env");
		const lines = readFileSync(envPath, "utf-8").split("\n");
		for (const line of lines) {
			const m = line.match(new RegExp(`^${envName}\\s*=\\s*(.+)$`));
			if (m) return m[1].trim();
		}
	} catch {
		/* .env may not exist */
	}
	return null;
}

/**
 * Loads API credentials for all supported providers.
 * Resolution order: environment variables → repository-root .env file.
 */
export async function loadCredentials(): Promise<Credentials> {
	return {
		tinyfish: resolveApiKey("TINYFISH_API_KEY"),
		exa: resolveApiKey("EXA_API_KEY"),
		tavily: resolveApiKey("TAVILY_API_KEY"),
	};
}
