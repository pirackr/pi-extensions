/**
 * Summarizer for timed-out or failed subagents.
 *
 * Reads the transcript and result from the artifact directory, then spawns
 * a lightweight Pi RPC child process to produce a 2-3 sentence summary.
 * This saves orchestrator tokens by distilling raw logs into a concise
 * overview before the parent agent sees the result.
 */

import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const GRACEFUL_SHUTDOWN_MS = 30_000;
const MAX_TRANSCRIPT_CHARS = 8_000;

export interface SummarizerDeps {
	readonly nodeBin: string;
	readonly runnerPath: string;
	readonly model: string;
	readonly cwd: string;
}

function readText(filePath: string, maxChars: number): string {
	if (!existsSync(filePath)) return "";
	try {
		const raw = readFileSync(filePath, "utf8");
		return raw.length > maxChars
			? raw.slice(0, maxChars) + "\n... (truncated)"
			: raw;
	} catch {
		return "";
	}
}

function buildSummaryPrompt(
	transcript: string,
	resultOutput: string,
	terminalReason: string | null,
): string {
	const reasonLine = terminalReason ? `\nStop reason: ${terminalReason}` : "";
	return `You are a summarizer. Read the following agent transcript and produce a concise summary in 2-3 sentences:
- What the agent was trying to do
- What it accomplished (if anything)
- Why it stopped${reasonLine}
- Any partial results or files produced

Be specific about file paths and concrete outcomes. If the agent produced no useful output, say so briefly.

--- TRANSCRIPT ---
${transcript || "(empty transcript)"}

--- LAST OUTPUT ---
${resultOutput || "(no output)"}`;
}

function spawnSummarizer(
	prompt: string,
	deps: SummarizerDeps,
): Promise<string> {
	return new Promise((resolve) => {
		const child = nodeSpawn(
			deps.nodeBin,
			[
				deps.runnerPath.replace(/runner\.mjs$/, "../cli.js"),
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--model",
				deps.model,
				"--tools",
				"none",
			],
			{
				cwd: deps.cwd,
				detached: true,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: {
					...process.env,
					PI_SUBAGENT: "1",
				},
			},
		);

		let stdout = "";
		let settled = false;

		const finish = (text: string) => {
			if (settled) return;
			settled = true;
			try {
				child.kill("SIGTERM");
			} catch {
				/* best effort */
			}
			resolve(text);
		};

		child.stdout.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
			// Look for the RPC response pattern in stdout
			const lines = stdout.split("\n");
			for (const line of lines) {
				try {
					const msg = JSON.parse(line);
					if (msg.type === "response" && typeof msg.text === "string") {
						finish(msg.text);
						return;
					}
				} catch {
					// not JSON, continue
				}
			}
		});

		child.stderr.on("data", () => {
			/* ignore stderr */
		});

		child.on("error", () => finish(""));
		child.on("close", () => finish(stdout.trim() || ""));

		// Send the prompt via stdin (Pi RPC protocol)
		const promptMsg = JSON.stringify({
			type: "prompt",
			id: "sum-1",
			message: prompt,
		});
		child.stdin.write(promptMsg + "\n");

		// Timeout safety: don't let the summarizer run forever
		setTimeout(() => finish(""), GRACEFUL_SHUTDOWN_MS);
	});
}

/**
 * Summarize a timed-out or failed agent's transcript.
 *
 * @param artifactDir - Directory containing transcript.log and result.json
 * @param deps - Runtime dependencies (node binary, model, cwd)
 * @returns Summary text, or null if summarization fails
 */
export async function summarizeAgent(
	artifactDir: string,
	deps: SummarizerDeps,
): Promise<string | null> {
	const transcriptPath = path.join(artifactDir, "transcript.log");
	const resultPath = path.join(artifactDir, "result.json");

	const transcript = readText(transcriptPath, MAX_TRANSCRIPT_CHARS);

	let resultOutput = "";
	let terminalReason: string | null = null;
	if (existsSync(resultPath)) {
		try {
			const result = JSON.parse(readFileSync(resultPath, "utf8"));
			resultOutput = result.output ?? "";
			terminalReason = result.terminalReason ?? null;
		} catch {
			// ignore parse errors
		}
	}

	if (!transcript && !resultOutput) return null;

	const prompt = buildSummaryPrompt(transcript, resultOutput, terminalReason);
	const summary = await spawnSummarizer(prompt, deps);
	return summary || null;
}
