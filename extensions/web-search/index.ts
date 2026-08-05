import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { readFileSync, resolve, writeFileSync } from "node:fs";

const DEFAULT_ENGINES = "exa,duckduckgo,brave";

const EXA_PATCH = `import axios from 'axios';
import { buildAxiosRequestOptions } from "../../utils/httpRequest.js";
export async function searchExa(query, limit) {
    const apiKey = process.env.EXA_API_KEY;
    const requestOptions = buildAxiosRequestOptions({
        trustedStaticHost: true,
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Safari/537.36",
            "Connection": "keep-alive",
            "Accept": "*/*",
            "Accept-Encoding": "gzip, deflate, br",
            "sec-ch-ua": "\\"Chromium\\";v=\\"112\\", \\"Google Chrome\\";v=\\"112\\", \\"Not:A-Brand\\";v=\\"99\\"",
            "content-type": "application/json",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\\"Windows\\"",
            "origin": "https://exa.ai",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
            "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
            ...(apiKey ? { "x-api-key": apiKey } : {})
        }
    });
    const data = {
        "numResults": limit,
        "query": query,
        "type": "auto",
        "useAutoprompt": true,
        "domainFilterType": "include",
        "text": true,
        "density": "compact",
        "resolvedSearchType": "neural",
        "moderation": true,
        "fastMode": false,
        "rerankerType": "default"
    };
    try {
        const response = await axios.post('https://api.exa.ai/search', data, requestOptions);
        const apiResults = response.data.results;
        if (!apiResults || apiResults.length === 0) {
            console.error('⚠️ No results returned from Exa.ai API.');
            return [];
        }
        const allResults = apiResults.map((item) => {
            return {
                title: item.title || 'No title',
                url: item.url,
                description: \`Author: \${item.author || 'N/A'}. Published: \${item.publishedDate ? new Date(item.publishedDate).toLocaleDateString() : 'N/A'}\`,
                source: new URL(item.url).hostname,
                engine: 'exa'
            };
        });
        return allResults.slice(0, limit);
    }
    catch (error) {
        console.error('❌ Error fetching search results from Exa.ai:', error.message);
        if (axios.isAxiosError(error) && error.response) {
            console.error('API Error Response:', error.response.data);
        }
        return [];
    }
}
`;

function patchExaEngine(): void {
	try {
		const candidatePaths = [
			resolve(import.meta.dirname, "../../node_modules/open-websearch/build/engines/exa/exa.js"),
			resolve(import.meta.dirname, "../../../.npm/_npx/*/node_modules/open-websearch/build/engines/exa/exa.js"),
		];
		for (const p of candidatePaths) {
			try {
				if (p.includes("*")) continue; // glob, skip
				const current = readFileSync(p, "utf-8");
				if (current.includes("api.exa.ai")) return; // already patched
				writeFileSync(p, EXA_PATCH);
				return;
			} catch { /* not this path */ }
		}
	} catch { /* best effort */ }
}

function loadExaApiKey(): string | undefined {
	try {
		const envPath = resolve(import.meta.dirname, "../../.env");
		const lines = readFileSync(envPath, "utf-8").split("\n");
		for (const line of lines) {
			const m = line.match(/^EXA_API_KEY=(.+)$/);
			if (m) return m[1].trim();
		}
	} catch {
		/* .env may not exist */
	}
	return undefined;
}

function runOpenWebSearch(
	args: string[],
	timeoutMs = 60000,
	signal?: AbortSignal,
): Promise<unknown> {
	patchExaEngine();
	const env = { ...process.env };
	const exaKey = loadExaApiKey();
	if (exaKey) env.EXA_API_KEY = exaKey;

	return new Promise((resolve, reject) => {
		let killTimeout: ReturnType<typeof setTimeout> | undefined;

		const child = execFile(
			"npx",
			["open-websearch", ...args, "--json"],
			{
				timeout: timeoutMs,
				maxBuffer: 10 * 1024 * 1024, // 10MB
				env,
			},
			(error, stdout, _stderr) => {
				if (killTimeout) clearTimeout(killTimeout);
				if (signal) {
					signal.removeEventListener("abort", onAbort);
				}
				if (error) {
					reject(error);
					return;
				}
				try {
					resolve(JSON.parse(stdout));
				} catch (e) {
					reject(e);
				}
			},
		);

		function onAbort() {
			child.kill("SIGTERM");
			killTimeout = setTimeout(() => {
				if (!child.killed) {
					child.kill("SIGKILL");
				}
			}, 5000);
		}

		if (signal) {
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
	});
}

export interface LookupWebResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
}

export async function lookupWeb(params: {
	query: string;
	limit?: number;
	engine?: string;
	search_mode?: string;
	signal?: AbortSignal;
}): Promise<LookupWebResult> {
	const args = ["search", params.query];
	if (params.limit) args.push("--limit", String(params.limit));
	if (params.engine) {
		args.push("--engine", params.engine);
	} else {
		args.push("--engines", DEFAULT_ENGINES);
	}
	if (params.search_mode) args.push("--search-mode", params.search_mode);

	const result = await runOpenWebSearch(args, 60000, params.signal);

	let text = "";
	const data = (result as any)?.data;
	if (data) {
		text += `Query: "${data.query}"\n`;
		text += `Engines: ${data.engines?.join(", ") ?? "unknown"}\n`;
		text += `Total results: ${data.totalResults ?? 0}\n\n`;
		if (data.results?.length) {
			data.results.forEach((r: any, i: number) => {
				text += `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.description}\n\n`;
			});
		}
		if (data.partialFailures?.length) {
			text += `Partial failures: ${data.partialFailures.length}\n`;
		}
	} else {
		text = JSON.stringify(result, null, 2);
	}

	return {
		content: [{ type: "text", text }],
		details: result,
	};
}

export interface FetchWebContentResult {
	content: Array<{ type: "text"; text: string }>;
	details: unknown;
}

export async function fetchWebContent(params: {
	url: string;
	max_chars?: number;
	readability?: boolean;
	include_links?: boolean;
	signal?: AbortSignal;
}): Promise<FetchWebContentResult> {
	const args = ["fetch-web", params.url];
	if (params.max_chars) args.push("--max-chars", String(params.max_chars));
	if (params.readability) args.push("--readability");
	if (params.include_links) args.push("--include-links");

	const result = await runOpenWebSearch(args, 45000, params.signal);

	const data = (result as any)?.data;
	let text = "";
	if (data) {
		text += `Title: ${data.title ?? "(none)"}\n`;
		text += `URL: ${data.finalUrl ?? data.url}\n`;
		text += `Content-Type: ${data.contentType ?? "unknown"}\n`;
		text += `Retrieval: ${data.retrievalMethod ?? "unknown"}\n`;
		text += `Readability: ${data.readabilityApplied ? "yes" : "no"}\n`;
		text += `Truncated: ${data.truncated ? "yes" : "no"}\n\n`;
		text += data.content ?? "(no content)";
		if (data.links?.length) {
			text += `\n\nLinks (${data.links.length}):\n`;
			data.links.forEach((l: string) => (text += `  - ${l}\n`));
		}
	} else {
		text = JSON.stringify(result, null, 2);
	}

	return {
		content: [{ type: "text", text }],
		details: result,
	};
}

export async function fetchWebContentRequestOnly(params: {
	url: string;
	max_chars?: number;
	signal?: AbortSignal;
}): Promise<FetchWebContentResult> {
	return fetchWebContent({
		url: params.url,
		max_chars: params.max_chars,
		readability: false,
		include_links: false,
		signal: params.signal,
	});
}

export const LookupWebToolDefinition = {
	name: "lookup_web",
	label: "Web Search",
	description:
		"Search the web using open-websearch via npx. No API keys required. " +
		"Returns search results with title, URL, and description snippets. " +
		"Use for finding documentation, facts, code examples, or discovering relevant pages.",
	parameters: Type.Object({
		query: Type.String({
			description: "Search query string",
		}),
		limit: Type.Optional(
			Type.Number({
				description: "Max results per engine, 1-50. Defaults to 10 if omitted.",
			}),
		),
		engine: Type.Optional(
			Type.String({
				description:
					"Search engine: startpage, bing, duckduckgo, exa, brave. Defaults to exa (with duckduckgo/brave fallback) if omitted.",
			}),
		),
		search_mode: Type.Optional(
			Type.String({
				description:
					"Search mode: request, auto, playwright. Defaults to request if omitted. " +
					"Playwright requires a Chromium-based browser (Chrome/Edge) installed. " +
					"Currently only affects Bing.",
			}),
		),
	}),
	async execute(_id: string, params: any, signal?: AbortSignal) {
		return lookupWeb({ ...params, signal });
	},
};

export const FetchWebContentToolDefinition = {
	name: "fetch_web_content",
	label: "Fetch Web Content",
	description:
		"Fetch and extract readable content from a public URL using open-websearch via npx. " +
		"Returns the page title, extracted text content, and metadata. " +
		"Use for reading documentation, articles, or any public web page.",
	parameters: Type.Object({
		url: Type.String({
			description: "Public HTTP(S) URL to fetch",
		}),
		max_chars: Type.Optional(
			Type.Number({
				description:
					"Max characters to return, 1000-200000. Defaults to 30000 if omitted.",
			}),
		),
		readability: Type.Optional(
			Type.Number({
				description:
					"Use Mozilla Readability (1=yes, 0=no). Defaults to 0 if omitted.",
			}),
		),
		include_links: Type.Optional(
			Type.Number({
				description:
					"Include extracted links (1=yes, 0=no). Defaults to 0 if omitted.",
			}),
		),
	}),
	async execute(_id: string, params: any, signal?: AbortSignal) {
		return fetchWebContent({
			url: params.url,
			max_chars: params.max_chars,
			readability: params.readability ? true : undefined,
			include_links: params.include_links ? true : undefined,
			signal,
		});
	},
};

export default function (pi: ExtensionAPI) {
	pi.registerTool(LookupWebToolDefinition);
	pi.registerTool(FetchWebContentToolDefinition);

	pi.registerTool({
		name: "fetch_github_readme",
		label: "Fetch GitHub README",
		description:
			"Fetch the README from a GitHub repository using open-websearch via npx. " +
			"Use when the target is a GitHub repository URL.",
		parameters: Type.Object({
			url: Type.String({
				description: "GitHub repository URL (https or ssh form)",
			}),
		}),
		async execute(_id: string, params: any, signal?: AbortSignal) {
			const result = await runOpenWebSearch(
				["fetch-github-readme", params.url],
				60000,
				signal,
			);

			const data = (result as any)?.data;
			const text = data?.content ?? JSON.stringify(result, null, 2);

			return {
				content: [{ type: "text", text }],
				details: result,
			};
		},
	});
}
