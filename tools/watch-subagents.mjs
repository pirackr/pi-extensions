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
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h${m % 60}m`;
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
