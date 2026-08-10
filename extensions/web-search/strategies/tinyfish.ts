// extensions/web-search/strategies/tinyfish.ts
import type { FetchStrategyAdapter, FetchWebRequest, FetchResponse } from "../types.ts";
import { TinyFish } from "@tiny-fish/sdk";
import { classifyError, errorText, type ErrorCategory } from "../errors.ts";

/**
 * TinyFish Fetch strategy using the official @tiny-fish/sdk.
 *
 * Requests Markdown by default; supports explicit "html" and "json" via
 * advancedOptions.tinyfish.format. Forwards all SDK-accepted options
 * (selector, conditionals, etc.) verbatim. Maps SDK responses to FetchResponse.
 *
 * SDK retries are disabled (maxRetries: 0) so every physical attempt is
 * represented in shared quota accounting.
 */
export class TinyFishFetchStrategy implements FetchStrategyAdapter {
	name = "tinyfish";

	private readonly client: TinyFish;

	constructor(apiKey: string) {
		// Disable SDK retries — the router reserves and retries instead.
		this.client = new TinyFish({ apiKey, maxRetries: 0 });
	}

	async fetch(
		request: FetchWebRequest,
		signal?: AbortSignal,
	): Promise<FetchResponse> {
		const opts = request.advancedOptions?.tinyfish;
		const format = (opts?.format ?? "markdown") as FetchResponse["format"];

		try {
			const params: Record<string, unknown> = {
				urls: [request.url],
			};
			if (opts?.purpose) params.purpose = opts.purpose;
			if (opts?.format) params.format = opts.format;
			if (opts?.include_html_head != null) params.include_html_head = opts.include_html_head;
			if (opts?.links != null) params.links = opts.links;
			if (opts?.image_links != null) params.image_links = opts.image_links;
			if (opts?.ttl != null) params.ttl = opts.ttl;
			if (opts?.per_url_timeout_ms != null) params.per_url_timeout_ms = opts.per_url_timeout_ms;
			if (opts?.if_none_match != null) params.if_none_match = opts.if_none_match;
			if (opts?.if_modified_since != null) params.if_modified_since = opts.if_modified_since;
			if (opts?.include_etag_and_last_modified != null) {
				params.include_etag_and_last_modified = opts.include_etag_and_last_modified;
			}

			// @tiny-fish/sdk does not accept AbortSignal — the SDK's own
			// timeout/retry logic runs independently. We check here only to
			// avoid invoking the SDK after the caller has already cancelled.
			if (signal?.aborted) {
				const e = new Error("request aborted by caller");
				e.name = "AbortError";
				throw e;
			}

			const response = await this.client.fetch.getContents(params as any);
			const result = response.results[0];

			if (!result) {
				const sdkError = response.errors[0]?.error ?? "no result returned";
				const err = new Error(sdkError);
				throw err;
			}

			let content: string;
			const actualFormat = result.format as FetchResponse["format"];

			if (result.text == null) {
				content = "";
			} else if (result.format === "json") {
				// JSON results are serialized into readable JSON text for Pi's
				// text content.
				content = JSON.stringify(result.text);
			} else {
				content = result.text;
			}

			return {
				url: request.url,
				title: result.title ?? "",
				content,
				strategy: "tinyfish",
				format: actualFormat,
				error: null,
				attempts: [{ strategy: "tinyfish", outcome: "success" }],
			};
		} catch (err: unknown) {
			// Cancellation — re-throw as-is so the router detects it by name.
			if (
				err &&
				typeof err === "object" &&
				(err as Error).name === "AbortError"
			) {
				throw err;
			}
			// Preserve status code for the router's classifyError.
			const wrapped =
				err instanceof Error ? err : new Error(String(err));
			const status =
				err && typeof err === "object" && "statusCode" in err
					? (err as { statusCode: number }).statusCode
					: null;
			if (status != null) {
				(wrapped as any).statusCode = status;
			}
			throw wrapped;
		}
	}
}
