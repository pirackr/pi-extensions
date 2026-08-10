import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Module-level fs mock — hoisted by vi.mock so it is in place when
// credentials.ts is imported.  We use a shared ref object so the mock
// closure captures the current content without relying on hoisting order.
// ---------------------------------------------------------------------------
const __envRef = { content: null as string | null };

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		readFileSync: vi.fn((path: string) => {
			if (String(path).endsWith(".env") && __envRef.content !== null) {
				return __envRef.content;
			}
			throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		}),
	};
});

function setEnvContent(content: string | null): void {
	__envRef.content = content;
}

describe("loadCredentials", () => {
	beforeEach(() => {
		delete process.env.TINYFISH_API_KEY;
		delete process.env.EXA_API_KEY;
		delete process.env.TAVILY_API_KEY;
		setEnvContent(null);
	});

	afterEach(() => {
		delete process.env.TINYFISH_API_KEY;
		delete process.env.EXA_API_KEY;
		delete process.env.TAVILY_API_KEY;
	});

	it("returns null keys when no env vars and no .env file", async () => {
		const { loadCredentials } = await import("../extensions/web-search/credentials.ts");
		const creds = await loadCredentials();
		expect(creds).toEqual({ tinyfish: null, exa: null, tavily: null });
	});

	it("reads from environment variables", async () => {
		process.env.TINYFISH_API_KEY = "tf-key-from-env";
		process.env.EXA_API_KEY = "exa-key-from-env";
		process.env.TAVILY_API_KEY = "tavily-key-from-env";
		const { loadCredentials } = await import("../extensions/web-search/credentials.ts");
		const creds = await loadCredentials();
		expect(creds).toEqual({
			tinyfish: "tf-key-from-env",
			exa: "exa-key-from-env",
			tavily: "tavily-key-from-env",
		});
	});

	it("falls back to .env when env var is absent", async () => {
		setEnvContent("EXA_API_KEY = exa-key-from-dotenv\n");
		const { loadCredentials } = await import("../extensions/web-search/credentials.ts");
		const creds = await loadCredentials();
		expect(creds).toEqual({
			tinyfish: null,
			exa: "exa-key-from-dotenv",
			tavily: null,
		});
	});

	it("env var takes precedence over .env value", async () => {
		setEnvContent("EXA_API_KEY = exa-key-from-dotenv\n");
		process.env.EXA_API_KEY = "exa-key-from-env";
		const { loadCredentials } = await import("../extensions/web-search/credentials.ts");
		const creds = await loadCredentials();
		expect(creds.exa).toBe("exa-key-from-env");
	});

	it("trims whitespace from credential values", async () => {
		process.env.TINYFISH_API_KEY = "  tf-key  \n";
		const { loadCredentials } = await import("../extensions/web-search/credentials.ts");
		const creds = await loadCredentials();
		expect(creds.tinyfish).toBe("tf-key");
	});
});
