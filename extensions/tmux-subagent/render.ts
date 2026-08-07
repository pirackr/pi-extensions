import * as path from "node:path";

// Pure result renderers for run_subagents — kept free of pi imports so they
// are unit-testable in isolation (same pattern as extensions/loop/sources.ts).

export interface RenderStatus {
	taskId: string;
	agent: string;
	state:
		| "starting"
		| "running"
		| "succeeded"
		| "failed"
		| "timed_out"
		| "cancelled";
	model: string;
	result?: string;
	errorMessage?: string;
}

const SUMMARY_DIGEST_CHARS = 600;

function digestText(text: string): string {
	if (text.length <= SUMMARY_DIGEST_CHARS) return text;
	return `${text.slice(0, SUMMARY_DIGEST_CHARS)}\n… [${text.length - SUMMARY_DIGEST_CHARS} more chars; full output on disk]`;
}

/**
 * Summary mode for research loops: the coordinator must not carry full
 * subagent payloads in context — a ~600-char digest per agent plus artifact
 * paths is enough to steer, and the full outputs stay on disk (pass
 * retain_artifacts: "always" so they persist). Prompts are never echoed
 * here: the caller wrote them.
 */
export function renderSummaryResults(
	statuses: RenderStatus[],
	artifactsPath: string | null,
): string {
	const sections = statuses.map((status) => {
		const heading = `=== ${status.agent} / ${status.taskId} (${status.state}) — model: ${status.model} ===`;
		const body =
			status.state === "succeeded"
				? status.result || "(no output)"
				: [
						status.errorMessage,
						status.result && `Partial output:\n${status.result}`,
					]
						.filter(Boolean)
						.join("\n\n") || "(no output)";
		const digest = digestText(body);
		const artifact =
			artifactsPath && status.result
				? `Full output: ${path.join(artifactsPath, "output", `${status.taskId}.jsonl`)}`
				: "";
		return `${heading}\n${digest}${artifact ? `\n${artifact}` : ""}`;
	});
	if (artifactsPath) sections.push(`Artifacts retained at: ${artifactsPath}`);
	return sections.join("\n\n");
}
