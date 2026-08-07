import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_STATES = new Set(["starting", "running"]);
export const TERMINAL_STATES = new Set([
	"succeeded",
	"failed",
	"timed_out",
	"cancelled",
]);

// ---------- discovery ----------

/** Read and parse a status file; null on missing or corrupt. */
export function readStatus(statusPath) {
	try {
		const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/** Validate a dir as a subagent run; null if not one. */
export function inspectDir(dir) {
	let statusFiles = [];
	try {
		statusFiles = fs
			.readdirSync(path.join(dir, "status"))
			.filter((f) => f.endsWith(".json"));
	} catch {
		return null;
	}
	if (statusFiles.length === 0) return null;
	const counts = {};
	let start = null;
	let live = false;
	for (const file of statusFiles) {
		const status = readStatus(path.join(dir, "status", file));
		if (!status) continue;
		counts[status.state] = (counts[status.state] || 0) + 1;
		const s = Date.parse(status.startedAt || "");
		if (!Number.isNaN(s) && (!start || s < start)) start = s;
		if (LIVE_STATES.has(status.state)) live = true;
	}
	let mtime = Date.now();
	try {
		mtime = fs.statSync(dir).mtimeMs;
	} catch {
		// dir vanished between readdir and stat — caller will treat as ended
	}
	return {
		dir,
		session: path.basename(dir),
		start: new Date(start || mtime),
		counts,
		live,
	};
}

/** Scan baseDir for pi-subagent-* runs, most recent first. */
export function findRuns(baseDir = "/tmp") {
	let entries = [];
	try {
		entries = fs.readdirSync(baseDir);
	} catch {
		return [];
	}
	const runs = [];
	for (const name of entries) {
		if (!name.startsWith("pi-subagent-")) continue;
		const info = inspectDir(path.join(baseDir, name));
		if (info) runs.push(info);
	}
	runs.sort((a, b) => b.start.getTime() - a.start.getTime());
	return runs;
}

/** Resolve a CLI argument (or none) to a run. */
export function resolveRunArg(arg, baseDir = "/tmp") {
	if (!arg) {
		const runs = findRuns(baseDir);
		return { run: runs[0] || null, error: null };
	}
	const looksLikePath =
		arg.includes("/") ||
		arg.startsWith(".") ||
		path.isAbsolute(arg) ||
		fs.existsSync(arg);
	if (looksLikePath) {
		const info = inspectDir(path.resolve(arg));
		if (!info)
			return { run: null, error: `not a subagent run dir: ${path.resolve(arg)}` };
		return { run: info, error: null };
	}
	const matches = findRuns(baseDir).filter((r) => r.session.includes(arg));
	if (matches.length === 0)
		return { run: null, error: `no run matching "${arg}"` };
	return { run: matches[0], error: null };
}

/** Human listing for -l and the picker. */
export function listRunsText(runs) {
	if (runs.length === 0) {
		return 'No subagent runs found.\nReplay requires retained artifacts (pass retain_artifacts: "always" to run_subagents).';
	}
	return runs
		.map((run, i) => {
			const counts =
				Object.entries(run.counts)
					.map(([state, count]) => `${count} ${state}`)
					.join(", ") || "no status";
			const mark = run.live ? "●" : "○";
			return `${i + 1}. ${mark} ${run.session}  started ${formatAge(Date.now() - run.start.getTime())} ago  [${counts}]`;
		})
		.join("\n");
}
// ---------- stream tailing ----------

export function createTailState() {
	return { offset: 0, partial: "" };
}

/** Read new JSONL lines from `outputPath` since `state.offset`. */
export function nextEvents(outputPath, state) {
	let size = 0;
	let text = "";
	try {
		const fd = fs.openSync(outputPath, "r");
		size = fs.fstatSync(fd).size;
		if (size < state.offset) state.offset = 0; // file rewritten
		if (size > state.offset) {
			const buf = Buffer.alloc(size - state.offset);
			fs.readSync(fd, buf, 0, buf.length, state.offset);
			text = buf.toString("utf8");
			state.offset = size;
		}
		fs.closeSync(fd);
	} catch {
		return { events: [], state }; // file not present yet
	}
	const events = [];
	if (text) {
		const lines = (state.partial + text).split("\n");
		state.partial = lines.pop() || "";
		for (const line of lines) {
			if (!line.trim()) continue;
			try {
				events.push(JSON.parse(line));
			} catch {
				// malformed line — skip, keep parsing
			}
		}
	}
	return { events, state };
}

// ---------- stream rendering ----------

const truncate = (s, n = 120) =>
	typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s ?? "";

export function summarizeArgs(args) {
	if (!args || typeof args !== "object") return "";
	const parts = [];
	if (typeof args.query === "string") parts.push(`query="${truncate(args.query)}"`);
	if (typeof args.url === "string") parts.push(`url=${truncate(args.url)}`);
	if (typeof args.path === "string") parts.push(`path=${truncate(args.path)}`);
	if (args.limit) parts.push(`limit=${args.limit}`);
	if (args.engine) parts.push(`engine=${args.engine}`);
	if (typeof args.command === "string") parts.push(`cmd=${truncate(args.command)}`);
	return parts.join(" ");
}

export function summarizeResult(toolName, event) {
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
}

export function createStreamState(maxLines = 2000) {
	return { lines: [], current: "", maxLines };
}

function pushLine(acc, line) {
	acc.lines.push(line);
	if (acc.lines.length > acc.maxLines) {
		acc.lines.splice(0, acc.lines.length - acc.maxLines);
	}
}

/** Fold one JSONL stream event into a renderable line buffer. */
export function accumulate(acc, event) {
	if (!event || typeof event !== "object") return;
	if (event.type === "message_update") {
		const delta = event.assistantMessageEvent?.delta;
		if (typeof delta === "string" && delta) {
			acc.current += delta;
			let idx;
			while ((idx = acc.current.indexOf("\n")) !== -1) {
				pushLine(acc, acc.current.slice(0, idx));
				acc.current = acc.current.slice(idx + 1);
			}
		}
	} else if (event.type === "tool_execution_start") {
		const name = event.toolName || event.toolCall?.name || "tool";
		const args = event.args ?? event.toolCall?.arguments ?? {};
		const summary = summarizeArgs(args);
		pushLine(acc, `[${name}]${summary ? " " + summary : ""}`);
	} else if (event.type === "tool_execution_end") {
		const name = event.toolName || "tool";
		pushLine(acc, `  ${summarizeResult(name, event)}`);
	}
}

/** Re-render a task's entire jsonl as plain text (for the pager). */
export function renderFullOutput(task) {
	const tail = createTailState();
	const stream = createStreamState(100000);
	const { events } = nextEvents(task.outputPath, tail);
	for (const event of events) accumulate(stream, event);
	const lines = [...stream.lines];
	if (stream.current) lines.push(stream.current);
	if (tail.partial) lines.push(tail.partial);
	return lines.join("\n") || "(no output)";
}

// ---------- run loading ----------

/** Load a run's task metadata from its request files (paths, labels). */
export function loadRun(dir) {
	const requestDir = path.join(dir, "request");
	let requestFiles = [];
	try {
		requestFiles = fs
			.readdirSync(requestDir)
			.filter((f) => f.endsWith(".json"));
	} catch {
		// no request dir — fall back to status files below
	}
	const tasks = [];
	const seen = new Set();
	for (const file of requestFiles.sort()) {
		const taskId = path.basename(file, ".json");
		let agent = taskId;
		let model = "";
		let cwd = "";
		let statusPath = path.join(dir, "status", `${taskId}.json`);
		let outputPath = path.join(dir, "output", `${taskId}.jsonl`);
		let stderrPath = path.join(dir, "stderr", `${taskId}.log`);
		try {
			const req = JSON.parse(
				fs.readFileSync(path.join(requestDir, file), "utf8"),
			);
			if (req && typeof req === "object") {
				if (typeof req.agent === "string") agent = req.agent;
				if (typeof req.model === "string") model = req.model;
				if (typeof req.cwd === "string") cwd = req.cwd;
				if (typeof req.statusPath === "string") statusPath = req.statusPath;
				if (typeof req.outputPath === "string") outputPath = req.outputPath;
				if (typeof req.stderrPath === "string") stderrPath = req.stderrPath;
			}
		} catch {
			// unreadable request file — use derived paths
		}
		seen.add(taskId);
		tasks.push({ taskId, agent, model, cwd, statusPath, outputPath, stderrPath });
	}
	// status files without a request file (partial runs)
	const statusDir = path.join(dir, "status");
	let statusFiles = [];
	try {
		statusFiles = fs
			.readdirSync(statusDir)
			.filter((f) => f.endsWith(".json"));
	} catch {
		// no status dir — nothing to fall back to
	}
	for (const file of statusFiles) {
		const taskId = path.basename(file, ".json");
		if (seen.has(taskId)) continue;
		tasks.push({
			taskId,
			agent: taskId,
			model: "",
			cwd: "",
			statusPath: path.join(statusDir, file),
			outputPath: path.join(dir, "output", `${taskId}.jsonl`),
			stderrPath: path.join(dir, "stderr", `${taskId}.log`),
		});
	}
	tasks.sort((a, b) =>
		a.taskId.localeCompare(b.taskId, undefined, { numeric: true }),
	);
	return { dir, session: path.basename(dir), tasks };
}


// ---------- formatting (used above; full impl in Task 5) ----------

export function formatAge(ms) {
	ms = Math.max(0, ms);
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m${s % 60}s`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
}

export function formatDuration(startedAt, finishedAt) {
	const start = Date.parse(startedAt || "");
	if (Number.isNaN(start)) return "–";
	const end = finishedAt ? Date.parse(finishedAt) : Date.now();
	if (Number.isNaN(end)) return "–";
	return formatAge(end - start);
}

export function formatTokens(n) {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
	return String(n);
}

export function aggregateStats(statuses) {
	const counts = {};
	let totalTokens = 0;
	let totalCost = 0;
	let turns = 0;
	for (const status of statuses) {
		if (!status) continue;
		counts[status.state] = (counts[status.state] || 0) + 1;
		totalTokens += status.usage?.totalTokens || 0;
		totalCost += status.usage?.cost?.total || 0;
		turns += status.usage?.turns || 0;
	}
	return { counts, totalTokens, totalCost, turns };
}

export function formatStatus(task) {
	const status = task.status;
	const state = status?.state || "unknown";
	const elapsed = formatDuration(status?.startedAt, status?.finishedAt);
	const tokens = status?.usage?.totalTokens
		? ` · ${formatTokens(status.usage.totalTokens)} tok`
		: "";
	return `${task.taskId} · ${task.agent} · ${state.toUpperCase()} · ${elapsed}${tokens}`;
}

// ---------- entry guard (TUI main lands in Task 8) ----------

const isMainModule =
	process.argv[1] === fileURLToPath(import.meta.url) ||
	process.argv[1]?.endsWith("/tools/watch-subagents.mjs");

if (isMainModule) {
	import("./main.ts").catch(() => {
		process.stderr.write("TUI not yet implemented (Task 8).\n");
		process.exit(1);
	});
}
