#!/usr/bin/env node

import { spawn as nodeSpawn } from "node:child_process";
import {
	appendFileSync,
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";

function realClock() {
	return {
		now: () => Date.now(),
		setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
		clearTimeout: (timer) => clearTimeout(timer),
	};
}

function processStartIdentity(pid) {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		const closeParen = stat.lastIndexOf(")");
		const fieldsAfterCommand = stat.slice(closeParen + 2).trim().split(/\s+/);
		return fieldsAfterCommand[19] ?? `${pid}`;
	} catch {
		return `${pid}`;
	}
}

function fsyncDirectory(directory) {
	let descriptor;
	try {
		descriptor = openSync(directory, "r");
		fsyncSync(descriptor);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

// This intentionally mirrors ArtifactStore's publication boundary. The runner
// cannot import TypeScript at runtime, so its tiny durability primitive remains
// self-contained and directly executable by plain Node.
function atomicWriteJson(destination, value, onWrite) {
	const directory = path.dirname(destination);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = path.join(
		directory,
		`.${path.basename(destination)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
	);
	let descriptor;
	try {
		descriptor = openSync(temporary, "wx", 0o600);
		writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
		fsyncSync(descriptor);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
	renameSync(temporary, destination);
	chmodSync(destination, 0o600);
	fsyncDirectory(directory);
	onWrite?.(destination);
}

function ensureLog(file) {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const descriptor = openSync(file, "a", 0o600);
	chmodSync(file, 0o600);
	closeSync(descriptor);
}

function flushFile(file) {
	let descriptor;
	try {
		descriptor = openSync(file, "r");
		fsyncSync(descriptor);
	} finally {
		if (descriptor !== undefined) closeSync(descriptor);
	}
}

function contentText(message) {
	if (!message || typeof message !== "object") return "";
	if (typeof message.text === "string") return message.text;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part && typeof part === "object" && part.type === "text")
		.map((part) => (typeof part.text === "string" ? part.text : ""))
		.join("");
}

function toolActivity(name) {
	const activities = {
		web_lookup: "searching web",
		fetch_web: "fetching web page",
		read: "reading files",
		ctx_read: "reading files",
		write: "writing files",
		edit: "editing files",
		ctx_shell: "running command",
		shell: "running command",
	};
	return activities[name] ?? `using ${name}`;
}

function totalTokensFrom(value) {
	if (!value || typeof value !== "object") return 0;
	const tokens = value.tokens && typeof value.tokens === "object" ? value.tokens : value;
	const total = tokens.total ?? tokens.totalTokens;
	if (Number.isFinite(total)) return Number(total);
	return [tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite]
		.filter(Number.isFinite)
		.reduce((sum, tokenCount) => sum + Number(tokenCount), 0);
}

function buildArguments(request) {
	const args = [
		...(request.pi.args ?? []),
		"--mode",
		"rpc",
		"--no-session",
		"--no-extensions",
	];
	for (const extension of request.childExtensions ?? []) {
		args.push("--extension", extension);
	}
	args.push("--no-skills", "--no-prompt-templates", "--no-themes");
	if (!request.loadContextFiles) args.push("--no-context-files");
	if (request.profile.model) args.push("--model", request.profile.model);
	if (request.profile.thinking) args.push("--thinking", request.profile.thinking);
	if (request.profile.tools?.length) {
		args.push("--tools", request.profile.tools.join(","));
	}
	if (request.webSearchMaxLookups > 0) {
		args.push("--web-search-max-lookups", String(request.webSearchMaxLookups));
	}
	if (request.webSearchMaxFetches > 0) {
		args.push("--web-search-max-fetches", String(request.webSearchMaxFetches));
	}
	if (request.profile.systemPrompt) {
		args.push("--append-system-prompt", request.profile.systemPrompt);
	}
	return args;
}

function baseStatus(request, now, processStart) {
	return {
		schema: request.schema ?? 1,
		generation: `runner-${request.agentId}`,
		revision: 0,
		parentId: request.parentId,
		agentId: request.agentId,
		parentAgentId: request.parentAgentId ?? null,
		ownershipTreeId: request.agentId,
		origin: request.origin,
		groupId: request.groupId ?? null,
		description: request.description,
		prompt: request.prompt,
		profile: request.profile,
		state: "starting",
		sequence: request.sequence ?? 0,
		queuedAt: request.queuedAt ?? now,
		startedAt: now,
		heartbeatAt: now,
		finishedAt: null,
		runnerPid: process.pid,
		processStart,
		tmuxSession: null,
		tmuxWindow: null,
		timeoutSeconds: request.profile.timeoutSeconds ?? null,
		terminalReason: null,
		reservation: request.reservation ?? null,
	};
}

/**
 * Run one persisted task without importing the TypeScript extension runtime.
 * @param {string} requestPath
 * @param {import("./runner.d.mts").RunnerDeps} [deps]
 */
export async function runTaskMode(requestPath, deps = {}) {
	const requestFile = path.resolve(requestPath);
	const taskDirectory = path.dirname(requestFile);
	const request = JSON.parse(readFileSync(requestFile, "utf8"));
	const clock = deps.clock ?? realClock();
	const spawn = deps.spawn ?? nodeSpawn;
	const killProcessGroup =
		deps.killProcessGroup ?? ((pid, signal) => process.kill(-pid, signal));
	const killGraceMs = deps.killGraceMs ?? 5_000;
	const statsFallbackMs = deps.statsFallbackMs ?? 3_000;
	const cancelPollMs = deps.cancelPollMs ?? 200;
	const outputStream = deps.stdout ?? process.stdout;
	const errorStream = deps.stderr ?? process.stderr;
	const writeOutput = (text) =>
		typeof outputStream === "function"
			? outputStream(text)
			: outputStream.write(text);
	const writeError = (text) =>
		typeof errorStream === "function"
			? errorStream(text)
			: errorStream.write(text);

	const files = {
		status: path.join(taskDirectory, "status.json"),
		result: path.join(taskDirectory, "result.json"),
		events: path.join(taskDirectory, "events.jsonl"),
		stderr: path.join(taskDirectory, "stderr.log"),
		transcript: path.join(taskDirectory, "transcript.log"),
		cancel: path.join(taskDirectory, "control", "cancel"),
	};
	for (const log of [files.events, files.stderr, files.transcript]) ensureLog(log);

	const startedAt = clock.now();
	const processStart = processStartIdentity(process.pid);
	let fallback = baseStatus(request, startedAt, processStart);
	let pendingStatus = {};
	let statusFlushQueued = false;
	let terminalPublished = false;

	function readStatus() {
		try {
			return JSON.parse(readFileSync(files.status, "utf8"));
		} catch {
			return fallback;
		}
	}

	function writeStatus(patch) {
		const current = readStatus();
		const next = {
			...current,
			...patch,
			revision: Number(current.revision ?? 0) + 1,
		};
		fallback = next;
		atomicWriteJson(files.status, next, deps.onWrite);
		return next;
	}

	function flushLiveStatus() {
		statusFlushQueued = false;
		if (terminalPublished || Object.keys(pendingStatus).length === 0) return;
		const patch = pendingStatus;
		pendingStatus = {};
		writeStatus(patch);
	}

	function scheduleStatus(patch) {
		Object.assign(pendingStatus, patch);
		if (statusFlushQueued || terminalPublished) return;
		statusFlushQueued = true;
		queueMicrotask(flushLiveStatus);
	}

	writeStatus({
		state: "starting",
		startedAt: readStatus().startedAt ?? startedAt,
		heartbeatAt: startedAt,
		runnerPid: process.pid,
		processStart,
		terminalReason: null,
	});

	let child;
	let childClosed = false;
	let closeCode = null;
	let terminalIntent = null;
	let protocolSettled = false;
	let authoritativePending = false;
	let statsDone = false;
	let textDone = false;
	let authoritativeText = "";
	let fallbackText = "";
	let streamedText = "";
	let totalTokens = 0;
	let toolUses = 0;
	let activeTool = null;
	let turns = 0;
	let compactionCount = 0;
	let stopReason = null;
	let nextRequestId = 1;
	let startupRequestId = null;
	let promptRequestId = null;
	let statsRequestId = null;
	let textRequestId = null;
	let cancelTimer;
	let heartbeatTimer;
	let timeoutTimer;
	let killTimer;
	let statsTimer;
	let settled = false;
	let stdoutEnded = false;

	let resolveDone;
	const done = new Promise((resolve) => {
		resolveDone = resolve;
	});

	function appendLog(file, text) {
		appendFileSync(file, text, { encoding: "utf8", mode: 0o600 });
	}

	function send(command) {
		if (!child?.stdin || child.stdin.ended) return null;
		const id = `runner-${nextRequestId++}`;
		child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		return id;
	}

	function clearTimers() {
		for (const timer of [cancelTimer, heartbeatTimer, timeoutTimer, killTimer, statsTimer]) {
			if (timer !== undefined) clock.clearTimeout(timer);
		}
		cancelTimer = heartbeatTimer = timeoutTimer = killTimer = statsTimer = undefined;
	}

	function publishTerminal(state, reason) {
		if (settled) return;
		settled = true;
		clearTimers();
		flushLiveStatus();
		for (const log of [files.events, files.stderr, files.transcript]) flushFile(log);
		const finishedAt = clock.now();
		const output = authoritativeText || fallbackText || streamedText;
		const result = {
			agentId: request.agentId,
			state,
			output,
			usage: {
				totalTokens,
				toolUses,
				durationMs: Math.max(0, finishedAt - startedAt),
			},
			finishedAt,
			terminalReason: reason,
		};
		atomicWriteJson(files.result, result, deps.onWrite);
		terminalPublished = true;
		writeStatus({
			state,
			finishedAt,
			heartbeatAt: finishedAt,
			terminalReason: reason,
			activity: state,
			usage: result.usage,
			toolUses,
			turns,
			compactionCount,
		});
		resolveDone();
	}

	function maybeFinishAfterClose() {
		if (!childClosed || settled) return;
		if (terminalIntent) {
			publishTerminal(terminalIntent.state, terminalIntent.reason);
			return;
		}
		if (protocolSettled) {
			const failed = stopReason === "error" || stopReason === "aborted";
			publishTerminal(
				failed ? "failed" : "succeeded",
				failed ? `Pi stopped with reason: ${stopReason}` : null,
			);
			return;
		}
		publishTerminal(
			"failed",
			`Pi RPC process exited unexpectedly${closeCode === null ? "" : ` (code ${closeCode})`}`,
		);
	}

	function terminate(state, reason) {
		if (terminalIntent || settled) return;
		terminalIntent = { state, reason };
		if (child?.pid) {
			try {
				killProcessGroup(child.pid, "SIGTERM");
			} catch (error) {
				appendLog(files.stderr, `SIGTERM failed: ${String(error)}\n`);
			}
			killTimer = clock.setTimeout(() => {
				if (childClosed || settled || !child?.pid) return;
				try {
					killProcessGroup(child.pid, "SIGKILL");
				} catch (error) {
					appendLog(files.stderr, `SIGKILL failed: ${String(error)}\n`);
				}
			}, killGraceMs);
		} else {
			childClosed = true;
		}
		maybeFinishAfterClose();
	}

	function finishAuthoritativeRequests() {
		if (!authoritativePending || (!statsDone || !textDone)) return;
		authoritativePending = false;
		if (statsTimer !== undefined) clock.clearTimeout(statsTimer);
		statsTimer = undefined;
		try {
			child?.stdin?.end();
		} catch {
			// Closing stdin is best effort; child close is the commit gate.
		}
		maybeFinishAfterClose();
	}

	function beginAuthoritativeRequests(event) {
		if (protocolSettled) return;
		protocolSettled = true;
		stopReason = event.stopReason ?? null;
		fallbackText = contentText(event.message) || fallbackText;
		authoritativePending = true;
		statsRequestId = send({ type: "get_session_stats" });
		textRequestId = send({ type: "get_last_assistant_text" });
		statsDone = statsRequestId === null;
		textDone = textRequestId === null;
		statsTimer = clock.setTimeout(() => {
			statsDone = true;
			textDone = true;
			finishAuthoritativeRequests();
		}, statsFallbackMs);
		finishAuthoritativeRequests();
	}

	function handleResponse(event) {
		if (event.id === startupRequestId) {
			if (!event.success) {
				terminate("failed", `Pi RPC startup failed: ${event.error ?? "unknown error"}`);
				return;
			}
			const contextWindow = event.data?.model?.contextWindow ?? null;
			writeStatus({
				state: "running",
				heartbeatAt: clock.now(),
				runnerPid: process.pid,
				processStart,
				contextWindow,
				activity: "starting task",
				usage: { totalTokens, toolUses, durationMs: clock.now() - startedAt },
			});
			promptRequestId = send({ type: "prompt", message: request.prompt });
			return;
		}
		if (event.id === promptRequestId && !event.success) {
			terminate("failed", `Pi rejected prompt: ${event.error ?? "unknown error"}`);
			return;
		}
		if (event.id === statsRequestId) {
			statsDone = true;
			if (event.success) {
				totalTokens = totalTokensFrom(event.data);
				if (Number.isFinite(event.data?.toolCalls)) {
					toolUses = Number(event.data.toolCalls);
				}
				if (Number.isFinite(event.data?.assistantMessages)) {
					turns = Number(event.data.assistantMessages);
				}
				scheduleStatus({
					usage: { totalTokens, toolUses, durationMs: clock.now() - startedAt },
					toolUses,
					turns,
					cost: Number.isFinite(event.data?.cost) ? Number(event.data.cost) : null,
					contextUsage: event.data?.contextUsage ?? null,
				});
			}
			finishAuthoritativeRequests();
			return;
		}
		if (event.id === textRequestId) {
			textDone = true;
			if (event.success && typeof event.data?.text === "string") {
				authoritativeText = event.data.text;
			}
			finishAuthoritativeRequests();
		}
	}

	function handleEvent(event) {
		if (!event || typeof event !== "object") return;
		if (event.type === "response") {
			handleResponse(event);
			return;
		}
		if (event.type === "message_update") {
			const streamedTokens = totalTokensFrom(event.usage);
			if (streamedTokens > 0) totalTokens = Math.max(totalTokens, streamedTokens);
			const streamedCost = event.usage?.cost?.total ?? event.usage?.cost ?? null;
			const messageEvent = event.assistantMessageEvent;
			if (messageEvent?.type === "text_delta" && typeof messageEvent.delta === "string") {
				streamedText += messageEvent.delta;
				appendLog(files.transcript, messageEvent.delta);
				writeOutput(messageEvent.delta);
				scheduleStatus({
					...(activeTool === null ? { activity: "responding" } : {}),
					heartbeatAt: clock.now(),
					usage: { totalTokens, toolUses, durationMs: clock.now() - startedAt },
					...(Number.isFinite(streamedCost) ? { cost: Number(streamedCost) } : {}),
				});
			}
			return;
		}
		if (event.type === "message_end" && event.message?.role === "assistant") {
			turns += 1;
			const text = contentText(event.message);
			if (text) {
				fallbackText = text;
				if (!streamedText.endsWith(text)) appendLog(files.transcript, `\n${text}\n`);
			}
			totalTokens = Math.max(totalTokens, totalTokensFrom(event.message.usage));
			stopReason = event.message.stopReason ?? stopReason;
			scheduleStatus({
				turns,
				usage: { totalTokens, toolUses, durationMs: clock.now() - startedAt },
				heartbeatAt: clock.now(),
			});
			return;
		}
		if (event.type === "tool_execution_start") {
			toolUses += 1;
			const name = String(event.toolName ?? "tool");
			activeTool = name;
			const current = readStatus();
			const tools = Array.from(new Set([...(current.tools ?? []), name]));
			appendLog(files.transcript, `\n[tool] ${name} ${JSON.stringify(event.args ?? {})}\n`);
			writeOutput(`\n[tool] ${name}\n`);
			scheduleStatus({
				activity: toolActivity(name),
				tools,
				toolUses,
				usage: { totalTokens, toolUses, durationMs: clock.now() - startedAt },
				heartbeatAt: clock.now(),
			});
			return;
		}
		if (event.type === "tool_execution_end") {
			activeTool = null;
			const resultSummary = contentText(event.result).trim();
			if (resultSummary) {
				const compactSummary = resultSummary.length > 500
					? `${resultSummary.slice(0, 497)}...`
					: resultSummary;
				appendLog(
					files.transcript,
					`[tool ${event.isError ? "error" : "result"}] ${String(event.toolName ?? "tool")}: ${compactSummary}\n`,
				);
			}
			scheduleStatus({
				activity: event.isError ? "tool failed" : "responding",
				toolSummary: resultSummary ? resultSummary.slice(0, 500) : null,
				heartbeatAt: clock.now(),
			});
			return;
		}
		if (event.type === "compaction_end") {
			compactionCount += 1;
			scheduleStatus({ compactionCount, heartbeatAt: clock.now() });
			return;
		}
		if (event.type === "agent_settled") beginAuthoritativeRequests(event);
	}

	const decoder = new StringDecoder("utf8");
	let decodedBuffer = "";
	function consumeDecoded(text, final = false) {
		decodedBuffer += text;
		let newline;
		while ((newline = decodedBuffer.indexOf("\n")) !== -1) {
			const line = decodedBuffer.slice(0, newline);
			decodedBuffer = decodedBuffer.slice(newline + 1);
			consumeLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		}
		if (final && decodedBuffer.length > 0) {
			const line = decodedBuffer;
			decodedBuffer = "";
			consumeLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		}
	}

	function consumeLine(line) {
		if (!line) return;
		try {
			const event = JSON.parse(line);
			appendLog(files.events, `${line}\n`);
			handleEvent(event);
		} catch (error) {
			const message = `Invalid Pi RPC JSONL: ${error instanceof Error ? error.message : String(error)}\n`;
			appendLog(files.stderr, message);
			writeError(message);
		}
	}

	function endStdout() {
		if (stdoutEnded) return;
		stdoutEnded = true;
		consumeDecoded(decoder.end(), true);
	}

	function scheduleCancellationPoll() {
		cancelTimer = clock.setTimeout(() => {
			if (settled || terminalIntent) return;
			try {
				if (existsSync(files.cancel) && lstatSync(files.cancel).isFile()) {
					let reason = "Cancelled by request";
					try {
						const marker = JSON.parse(readFileSync(files.cancel, "utf8"));
						if (typeof marker.reason === "string" && marker.reason) reason = marker.reason;
					} catch {
						// Existence of the durable regular-file marker is authoritative.
					}
					terminate("cancelled", reason);
					return;
				}
			} catch (error) {
				appendLog(files.stderr, `Cancellation check failed: ${String(error)}\n`);
			}
			scheduleCancellationPoll();
		}, cancelPollMs);
	}

	function scheduleHeartbeat() {
		heartbeatTimer = clock.setTimeout(() => {
			if (settled || terminalIntent) return;
			scheduleStatus({ heartbeatAt: clock.now() });
			scheduleHeartbeat();
		}, 1_000);
	}

	try {
		child = spawn(request.pi.command, buildArguments(request), {
			cwd: request.cwd,
			detached: true,
			shell: false,
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				...process.env,
				PI_SUBAGENT: "1",
				PI_SUBAGENT_PARENT: request.parentId,
				PI_SUBAGENT_AGENT: request.agentId,
				PI_SUBAGENT_ARTIFACT_ROOT: request.artifactRoot,
			},
		});
	} catch (error) {
		terminalIntent = {
			state: "failed",
			reason: `Unable to spawn Pi RPC process: ${error instanceof Error ? error.message : String(error)}`,
		};
		childClosed = true;
		maybeFinishAfterClose();
		return done;
	}

	child.stdout.on("data", (chunk) => consumeDecoded(decoder.write(Buffer.from(chunk))));
	child.stdout.on("end", endStdout);
	child.stderr.on("data", (chunk) => {
		const text = Buffer.from(chunk).toString("utf8");
		appendLog(files.stderr, text);
		writeError(text);
	});
	child.on("error", (error) => {
		appendLog(files.stderr, `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		terminate(
			"failed",
			`Pi RPC process error: ${error instanceof Error ? error.message : String(error)}`,
		);
	});
	child.on("close", (code) => {
		endStdout();
		childClosed = true;
		closeCode = code;
		maybeFinishAfterClose();
	});

	scheduleCancellationPoll();
	scheduleHeartbeat();
	if (request.profile.timeoutSeconds !== null && request.profile.timeoutSeconds > 0) {
		timeoutTimer = clock.setTimeout(() => {
			// Graceful shutdown: fetch the last assistant text before killing,
			// so the result includes whatever the agent was working on.
			beginAuthoritativeRequests({ stopReason: "timeout" });
			const gracefulMs = 5_000;
			clock.setTimeout(() => {
				terminate(
					"timed_out",
					`Timed out after ${request.profile.timeoutSeconds} seconds`,
				);
			}, gracefulMs);
		}, request.profile.timeoutSeconds * 1_000);
	}
	startupRequestId = send({ type: "get_state" });
	if (startupRequestId === null) {
		terminate("failed", "Pi RPC stdin was unavailable at startup");
	}

	return done;
}

/**
 * @param {readonly string[]} [argv]
 * @param {import("./runner.d.mts").RunnerDeps} [deps]
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
	const requestPath = argv[0];
	if (!requestPath) {
		(deps.stderr ?? process.stderr).write("Usage: node runner.mjs <request.json>\n");
		process.exitCode = 2;
		return;
	}
	await runTaskMode(requestPath, deps);
	try {
		const status = JSON.parse(
			readFileSync(path.join(path.dirname(path.resolve(requestPath)), "status.json"), "utf8"),
		);
		process.exitCode = status.state === "succeeded" ? 0 : 1;
	} catch {
		process.exitCode = 1;
	}
}

const directPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (directPath === import.meta.url) {
	main().catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
}
