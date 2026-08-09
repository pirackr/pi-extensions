import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

export function runControlMode(controlName) {
	process.stdout.write(`Subagent controller: ${controlName || "unknown"}\n`);
	const timer = setInterval(() => {}, 60_000);
	const stop = () => {
		clearInterval(timer);
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	process.on("SIGHUP", stop);
}

export function runTaskMode(requestPath) {
	let request;
	try {
		request = JSON.parse(fs.readFileSync(requestPath, "utf8"));
	} catch (error) {
		process.stderr.write(`Failed to parse request file: ${error.message}\n`);
		process.exit(2);
	}
	const startedAt = new Date().toISOString();
	let child;
	let timeout;
	let killTimer;
	let timedOut = false;
	let cancelled = false;
	let settled = false;
	let buffer = "";
	let finalOutput = "";
	let stopReason;
	let errorMessage;
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		turns: 0,
	};

	const writeStatus = (status) => {
		const temporary = `${request.statusPath}.${process.pid}.tmp`;
		fs.writeFileSync(temporary, JSON.stringify(status, null, 2), {
			mode: 0o600,
		});
		fs.renameSync(temporary, request.statusPath);
	};

	const baseStatus = () => ({
		taskId: request.taskId,
		agent: request.agent,
		startedAt,
		model: request.model,
	});

	const killChild = (signal) => {
		if (!child?.pid) return;
		try {
			process.kill(-child.pid, signal);
		} catch {
			try {
				child.kill(signal);
			} catch {
				// Process already exited.
			}
		}
	};

	const requestTermination = (state) => {
		if (settled) return;
		if (state === "timed_out") timedOut = true;
		if (state === "cancelled") cancelled = true;
		killChild("SIGTERM");
		killTimer = setTimeout(() => killChild("SIGKILL"), 5_000);
	};

	const truncate = (s, n = 120) =>
		typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : (s ?? "");

	const summarizeArgs = (args) => {
		if (!args || typeof args !== "object") return "";
		const parts = [];
		if (typeof args.query === "string")
			parts.push(`query="${truncate(args.query)}"`);
		if (typeof args.url === "string") parts.push(`url=${truncate(args.url)}`);
		if (typeof args.path === "string")
			parts.push(`path=${truncate(args.path)}`);
		if (args.limit) parts.push(`limit=${args.limit}`);
		if (args.engine) parts.push(`engine=${args.engine}`);
		if (typeof args.command === "string")
			parts.push(`cmd=${truncate(args.command)}`);
		return parts.join(" ");
	};

	const summarizeResult = (toolName, event) => {
		const result = event.result;
		const details = result?.details;
		if (event.isError) return `ERROR: ${result?.error ?? "tool failed"}`;
		if (toolName === "web_lookup") {
			const results = Array.isArray(details?.results) ? details.results : [];
			const engines = details?.engines?.length
				? details.engines.join(",")
				: "none";
			const head = results
				.slice(0, 2)
				.map((r) => `${r.title} — ${r.url}`)
				.join(" | ");
			const failures = details?.partialFailures?.length
				? ` | failures: ${details.partialFailures.map((p) => p.engine).join(",")}`
				: "";
			return `${results.length} results [${engines}]${results.length ? " | " + truncate(head, 180) : ""}${failures}`;
		}
		if (toolName === "fetch_web") {
			const text = result?.content?.map((c) => c.text ?? "").join("") ?? "";
			return `"${truncate(details?.title ?? "(no title)", 80)}" ${text.length} chars`;
		}
		const text =
			result?.content
				?.map((c) => c.text ?? "")
				.join(" ")
				.replace(/\s+/g, " ")
				.trim() ?? "";
		return truncate(text || "(no content)", 160);
	};

	const toolCounts = {};

	const processEvent = (line) => {
		if (!line.trim()) return;
		let event;
		try {
			event = JSON.parse(line);
		} catch {
			return;
		}

		if (event.type === "message_update") {
			const update = event.assistantMessageEvent;
			if (update?.type === "text_delta" && update.delta)
				process.stdout.write(update.delta);
		}

		if (event.type === "tool_execution_start") {
			const name = event.toolName || event.toolCall?.name || "tool";
			toolCounts[name] = (toolCounts[name] ?? 0) + 1;
			const args = event.args ?? event.toolCall?.arguments ?? {};
			const summary = summarizeArgs(args);
			process.stdout.write(`\n[${name}]${summary ? " " + summary : ""}\n`);
		}

		if (event.type === "tool_execution_end") {
			const name = event.toolName || "tool";
			process.stdout.write(`  ${summarizeResult(name, event)}\n`);
		}

		if (event.type === "message_end" && event.message?.role === "assistant") {
			const message = event.message;
			finalOutput = message.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			usage.turns += 1;
			usage.input += message.usage?.input || 0;
			usage.output += message.usage?.output || 0;
			usage.cacheRead += message.usage?.cacheRead || 0;
			usage.cacheWrite += message.usage?.cacheWrite || 0;
			usage.totalTokens += message.usage?.totalTokens || 0;
			usage.cost.input += message.usage?.cost?.input || 0;
			usage.cost.output += message.usage?.cost?.output || 0;
			usage.cost.cacheRead += message.usage?.cost?.cacheRead || 0;
			usage.cost.cacheWrite += message.usage?.cost?.cacheWrite || 0;
			usage.cost.total += message.usage?.cost?.total || 0;
			stopReason = message.stopReason;
			errorMessage = message.errorMessage;
		}
	};

	writeStatus({ ...baseStatus(), state: "starting" });
	const output = fs.createWriteStream(request.outputPath, {
		flags: "w",
		mode: 0o600,
	});
	const stderr = fs.createWriteStream(request.stderrPath, {
		flags: "w",
		mode: 0o600,
	});
	const args = [
		...request.pi.args,
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		...request.childExtensions.flatMap((extension) => [
			"--extension",
			extension,
		]),
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		...(request.loadContextFiles ? [] : ["--no-context-files"]),
		"--model",
		request.model,
		...(request.thinking ? ["--thinking", request.thinking] : []),
		"--tools",
		request.tools.join(","),
		// Pass web-search budgets directly as CLI flags (no env vars).
		// The web-search extension registers these and reads them via getFlag().
		...(Number.isInteger(request.webSearchMaxLookups) &&
		request.webSearchMaxLookups > 0
			? ["--web-search-max-lookups", String(request.webSearchMaxLookups)]
			: []),
		...(Number.isInteger(request.webSearchMaxFetches) &&
		request.webSearchMaxFetches > 0
			? ["--web-search-max-fetches", String(request.webSearchMaxFetches)]
			: []),
		"--append-system-prompt",
		request.promptPath,
	];

	child = spawn(request.pi.command, args, {
		cwd: request.cwd,
		detached: true,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	});
	child.stdin.on("error", (error) => {
		errorMessage ||= `Failed to send task input to Pi: ${error.message}`;
	});
	child.stdin.end(fs.readFileSync(request.taskPath));
	writeStatus({ ...baseStatus(), state: "running", pid: child.pid });

	child.stdout.on("data", (chunk) => {
		output.write(chunk);
		buffer += chunk.toString();
		const lines = buffer.split("\n");
		buffer = lines.pop() || "";
		for (const line of lines) processEvent(line);
	});

	child.stderr.on("data", (chunk) => {
		stderr.write(chunk);
		process.stderr.write(chunk);
	});

	child.on("error", (error) => {
		errorMessage = error.message;
	});

	child.on("exit", () => {
		if (timedOut || cancelled || !child.pid) return;
		try {
			process.kill(-child.pid, "SIGTERM");
			killTimer = setTimeout(() => killChild("SIGKILL"), 1_000);
		} catch {
			// No descendants remain in the detached process group.
		}
	});

	child.on("close", (code) => {
		settled = true;
		clearTimeout(timeout);
		if (killTimer && child.pid) {
			try {
				process.kill(-child.pid, 0);
			} catch {
				clearTimeout(killTimer);
			}
		}
		if (buffer.trim()) processEvent(buffer);
		output.end();
		stderr.end();

		const stoppedNormally =
			code === 0 &&
			stopReason !== "error" &&
			stopReason !== "aborted" &&
			finalOutput.trim();
		const state = timedOut
			? "timed_out"
			: cancelled
				? "cancelled"
				: stoppedNormally
					? "succeeded"
					: "failed";
		writeStatus({
			...baseStatus(),
			state,
			pid: child.pid,
			exitCode: code,
			finishedAt: new Date().toISOString(),
			stopReason,
			errorMessage,
			result: finalOutput,
			usage,
		});
		process.stdout.write(`\n\n[${request.agent} ${state}]\n`);
		if (Object.keys(toolCounts).length) {
			const summary = Object.entries(toolCounts)
				.sort((a, b) => b[1] - a[1])
				.map(([k, v]) => `${k}=${v}`)
				.join(" ");
			process.stdout.write(`tool calls: ${summary}\n`);
		}
		process.exitCode = state === "succeeded" ? 0 : 1;
	});

	timeout = setTimeout(
		() => requestTermination("timed_out"),
		request.timeoutMs,
	);
	process.on("SIGINT", () => requestTermination("cancelled"));
	process.on("SIGTERM", () => requestTermination("cancelled"));
	process.on("SIGHUP", () => requestTermination("cancelled"));
}

export function main(argv = process.argv) {
	const [, , requestArg, controlName] = argv;

	if (requestArg === "--control") {
		runControlMode(controlName);
	} else {
		if (!requestArg) {
			process.stderr.write("Usage: node runner.mjs <request.json>\n");
			process.exit(2);
		}
		runTaskMode(requestArg);
	}
}

const __filename = fileURLToPath(import.meta.url);
const isMainModule =
	process.argv[1] === __filename || process.argv[1]?.endsWith("runner.mjs");

if (isMainModule) {
	main();
}
