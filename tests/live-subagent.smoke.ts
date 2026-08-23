#!/usr/bin/env node
/// <reference types="node" />
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import type {
	ExtensionRuntime,
	RuntimeFactoryContext,
} from "../extensions/subagent/index.ts";
import type { ResolvedProfile } from "../extensions/subagent/types.ts";

const execFileAsync = promisify(execFile);
const SELF = fileURLToPath(import.meta.url);
const EXTENSION_DIR = join(dirname(SELF), "..", "extensions", "subagent");
const PI_ROOT = process.env.PI_CODING_AGENT_ROOT
	?? "/home/pirackr/.npm/_npx/99fca8174466655b/node_modules/@earendil-works/pi-coding-agent";
const piRequire = createRequire(`${PI_ROOT}/package.json`);
const jitiPackage = piRequire("jiti") as {
	createJiti?: (id: string, options?: object) => { import(id: string, options?: object): Promise<unknown> };
	default?: { createJiti?: (id: string, options?: object) => { import(id: string, options?: object): Promise<unknown> } };
};
const createJiti = jitiPackage.createJiti ?? jitiPackage.default?.createJiti;
if (!createJiti) throw new Error("jiti.createJiti not found in the Pi installation");
const jiti = createJiti(pathToFileURL(SELF).href, {
	moduleCache: true,
	alias: { "@earendil-works/pi-coding-agent": `${PI_ROOT}/dist/index.js` },
});
const indexModule = await jiti.import(join(EXTENSION_DIR, "index.ts")) as typeof import("../extensions/subagent/index.ts");
const configModule = await jiti.import(join(EXTENSION_DIR, "config.ts")) as typeof import("../extensions/subagent/config.ts");
const identityModule = await jiti.import(join(EXTENSION_DIR, "identity.ts")) as typeof import("../extensions/subagent/identity.ts");
const tmuxModule = await jiti.import(join(EXTENSION_DIR, "tmux.ts")) as typeof import("../extensions/subagent/tmux.ts");
const { createProductionRuntime, installSubagentExtension } = indexModule;
const { loadSubagentConfiguration } = configModule;
const { projectSlug } = identityModule;
const tmuxExec = tmuxModule.nodeTmuxExecutor();
const signal = new AbortController().signal;

interface SmokeContext {
	mode: "tui" | "rpc";
	hasUI: boolean;
	cwd: string;
	ui: {
		widgets: Map<string, unknown>;
		statuses: Map<string, unknown>;
		notifications: string[];
		setWidget(key: string, value: unknown): void;
		setStatus(key: string, value: unknown): void;
		notify(message: string): void;
	};
	sessionManager: {
		getSessionId(): string;
		getSessionName(): undefined;
		getEntries(): never[];
		getBranch(): never[];
	};
	isProjectTrusted(): boolean;
}

interface InstalledExtension {
	pi: ReturnType<typeof fakePi>;
	context: SmokeContext;
	tools: Map<string, any>;
	commands: Map<string, any>;
	handlers: Map<string, Array<(event: any, context: any) => any>>;
	messages: any[];
	getRuntime(): ExtensionRuntime;
}

const workerProfile: ResolvedProfile = {
	name: "worker",
	description: "deterministic live-smoke worker",
	model: "fake/smoke",
	thinking: "off",
	tools: [],
	access: "read",
	timeoutSeconds: 30,
	systemPrompt: "",
	source: "live-smoke",
};
const researchProfile: ResolvedProfile = {
	...workerProfile,
	name: "research-fixture",
	description: "deterministic research workflow fixture",
};

function smokeContext(cwd: string, origin: string, mode: "tui" | "rpc" = "tui"): SmokeContext {
	const ui = {
		widgets: new Map<string, unknown>(),
		statuses: new Map<string, unknown>(),
		notifications: [] as string[],
		setWidget(key: string, value: unknown) { this.widgets.set(key, value); },
		setStatus(key: string, value: unknown) { this.statuses.set(key, value); },
		notify(message: string) { this.notifications.push(message); },
	};
	return {
		mode,
		hasUI: mode === "tui",
		cwd,
		ui,
		sessionManager: {
			getSessionId: () => origin,
			getSessionName: () => undefined,
			getEntries: () => [],
			getBranch: () => [],
		},
		isProjectTrusted: () => true,
	};
}

function fakePi() {
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, context: any) => any>>();
	const messages: any[] = [];
	return {
		tools,
		commands,
		handlers,
		messages,
		registerTool(tool: any) { tools.set(tool.name, tool); },
		registerCommand(name: string, command: any) { commands.set(name, command); },
		registerMessageRenderer() {},
		on(name: string, handler: (event: any, context: any) => any) {
			const bucket = handlers.get(name) ?? [];
			bucket.push(handler);
			handlers.set(name, bucket);
		},
		sendMessage(message: any) { messages.push(message); },
		events: {
			on() {},
			emit(name: string, envelope: any) {
				if (name !== "subagent:discover-profiles") return;
				envelope.contributions.push(
					{ owner: "live-smoke", profile: workerProfile },
					{ owner: "live-smoke", profile: researchProfile },
				);
			},
		},
	};
}

function install(
	cwd: string,
	origin: string,
	env: Readonly<Record<string, string | undefined>>,
	root: string,
	fakePiPath: string,
	mode: "tui" | "rpc" = "tui",
): InstalledExtension {
	const pi = fakePi();
	const context = smokeContext(cwd, origin, mode);
	let runtime: ExtensionRuntime | null = null;
	installSubagentExtension(pi as never, {
		env,
		createRuntime: async (factory: RuntimeFactoryContext) => {
			runtime = await createProductionRuntime(factory, {
				tmpRoot: root,
				tmuxExec,
				pi: { command: process.execPath, args: [fakePiPath] },
			});
			return runtime;
		},
	});
	return {
		pi,
		context,
		tools: pi.tools,
		commands: pi.commands,
		handlers: pi.handlers,
		messages: pi.messages,
		getRuntime() {
			if (!runtime) throw new Error("extension runtime has not started");
			return runtime;
		},
	};
}

async function emit(extension: InstalledExtension, name: string, event: any): Promise<void> {
	for (const handler of extension.handlers.get(name) ?? []) {
		await handler(event, extension.context);
	}
}

async function tool(extension: InstalledExtension, name: string, params: any): Promise<any> {
	const registered = extension.tools.get(name);
	assert(registered, `missing registered tool ${name}`);
	return registered.execute(`smoke-${Date.now()}`, params, signal, undefined, extension.context);
}

async function waitFor<T>(
	label: string,
	read: () => Promise<T> | T,
	accept: (value: T) => boolean,
	timeoutMs = 15_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	let last: T;
	while (true) {
		last = await read();
		if (accept(last)) return last;
		if (Date.now() >= deadline) throw new Error(`${label} timed out; last=${JSON.stringify(last)}`);
		await new Promise((resolve) => setTimeout(resolve, 75));
	}
}

async function windows(session: string): Promise<string[]> {
	try {
		const { stdout } = await execFileAsync("tmux", ["list-windows", "-t", session, "-F", "#{window_name}"]);
		return String(stdout).split("\n").map((line: string) => line.trim()).filter(Boolean);
	} catch {
		return [];
	}
}

async function exists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function shellJoin(argv: readonly string[]): string {
	return argv.map(shellQuote).join(" ");
}

async function allocateOwnedId(root: string, cwd: string): Promise<string> {
	const slug = projectSlug(cwd);
	for (let attempt = 0; attempt < 64; attempt += 1) {
		const id = randomBytes(2).toString("hex");
		assert(/^[a-z0-9]{4}$/.test(id));
		if (await exists(join(root, slug, `pi-${id}`))) continue;
		try {
			await execFileAsync("tmux", ["has-session", "-t", `pi-${id}`]);
		} catch {
			return id;
		}
	}
	throw new Error("unable to allocate isolated live-smoke parent id");
}

async function writeFakePi(path: string): Promise<void> {
	await writeFile(path, `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
let output = "fake Pi completed";
let settled = false;
rl.on("line", (line) => {
  const command = JSON.parse(line);
  if (command.type === "get_state") {
    send({ type: "response", id: command.id, success: true, data: { model: { contextWindow: 32000 } } });
  } else if (command.type === "prompt") {
    send({ type: "response", id: command.id, success: true, data: {} });
    const delay = Number(String(command.message).split("[delay=")[1]?.split("]")[0] ?? 100);
    output = String(command.message).split("[output=")[1]?.split("]")[0] ?? "fake Pi completed";
    setTimeout(() => {
      if (settled) return;
      settled = true;
      const message = { role: "assistant", content: [{ type: "text", text: output }], stopReason: "stop", usage: { input: 3, output: 5, total: 8 } };
      send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: output }, usage: message.usage });
      send({ type: "message_end", message });
      send({ type: "agent_settled", stopReason: "stop", message });
    }, delay);
  } else if (command.type === "get_session_stats") {
    send({ type: "response", id: command.id, success: true, data: { totalTokens: 8, toolCalls: 0, assistantMessages: 1, cost: 0 } });
  } else if (command.type === "get_last_assistant_text") {
    send({ type: "response", id: command.id, success: true, data: { text: output } });
  }
});
`, { mode: 0o700 });
}

async function runInsideCheck(args: string[]): Promise<void> {
	const [root, cwd, id, fakePiPath, marker] = args;
	assert(root && cwd && id && fakePiPath && marker, "inside-check arguments missing");
	assert(process.env.TMUX, "inside-check was not launched inside tmux");
	const extension = install(cwd, "origin-live", { TMUX: process.env.TMUX }, root, fakePiPath, "rpc");
	await emit(extension, "session_start", { type: "session_start", reason: "startup" });
	assert.equal(extension.getRuntime().mode, "manager");
	await emit(extension, "session_shutdown", { type: "session_shutdown" });
	await writeFile(marker, JSON.stringify({ reused: true, id }), { mode: 0o600 });
}

function resultText(response: any): string {
	return String(response?.content?.[0]?.text ?? "");
}

async function runFakeAcceptance(): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "live-subagent-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent-home");
	const fakePiPath = join(root, "fake-pi.mjs");
	const marker = join(root, "inside.json");
	await mkdir(join(cwd, ".pi", "subagent"), { recursive: true });
	await mkdir(join(agentDir, "subagent"), { recursive: true });
	await writeFakePi(fakePiPath);
	const oldAgentDir = process.env.PI_AGENT_DIR;
	process.env.PI_AGENT_DIR = agentDir;
	await writeFile(join(agentDir, "subagent", "config.json"), JSON.stringify({
		maxConcurrent: 9,
		notificationGroupWaitSeconds: 2,
	}), { mode: 0o600 });
	await writeFile(join(cwd, ".pi", "subagent", "config.json"), JSON.stringify({
		maxConcurrent: 10,
		notificationGroupWaitSeconds: 1,
	}), { mode: 0o600 });
	const id = await allocateOwnedId(root, cwd);
	const session = `pi-${id}`;
	let active: InstalledExtension | null = null;
	try {
		// 1. Outside tmux creates pi-xxxx.
		active = install(cwd, "origin-live", { PI_SESSION_ID: id }, root, fakePiPath, "tui");
		await emit(active, "session_start", { type: "session_start", reason: "startup" });
		assert((await windows(session)).includes("main"), "outside-tmux startup did not create keeper session");
		await emit(active, "session_shutdown", { type: "session_shutdown" });
		active = null;

		// 2. A process actually launched inside pi-xxxx reuses the same durable parent.
		const insideArgv = [process.execPath, ...process.execArgv, SELF, "--inside-check", root, cwd, id, fakePiPath, marker];
		await tmuxExec([
			"new-window", "-d", "-t", session, "-n", "acceptance-inside", "-c", cwd,
			shellJoin(insideArgv),
		]);
		await waitFor("inside-tmux reuse", () => exists(marker), Boolean, 10_000);
		assert.deepEqual(JSON.parse(await readFile(marker, "utf8")), { reused: true, id });

		// 9. Layered configuration is executable: trusted project overrides user.
		const loaded = loadSubagentConfiguration(EXTENSION_DIR, { projectRoot: cwd, projectTrusted: true });
		assert.equal(loaded.config.maxConcurrent, 10);
		assert.equal(loaded.config.notificationGroupWaitSeconds, 1);

		active = install(cwd, "origin-live", { PI_SESSION_ID: id }, root, fakePiPath, "tui");
		await emit(active, "session_start", { type: "session_start", reason: "resume" });
		await emit(active, "turn_start", { type: "turn_start", turnIndex: 1, timestamp: Date.now() });

		// 3 + 4. Eleven tasks occupy ten detached, correctly named windows; one queues.
		const receipts = await Promise.all(Array.from({ length: 11 }, (_, index) => tool(active!, "Agent", {
			description: `live ${index + 1}`,
			prompt: `[delay=5000] [output=live-${index + 1}]`,
			subagent_type: "worker",
			run_in_background: true,
		})));
		const ids = receipts.map((response) => /subagent-([a-z0-9]{4})/.exec(resultText(response))?.[1]);
		assert(ids.every(Boolean), `missing durable receipt ids: ${JSON.stringify(receipts)}`);
		await waitFor("ten running windows", () => windows(session), (value) => value.filter((name) => name.startsWith("subagent-")).length === 10);
		const manifests = await active.getRuntime().manager.list();
		assert.equal(manifests.filter((item) => item.state === "queued").length, 1);
		assert.equal(manifests.filter((item) => item.state === "starting" || item.state === "running").length, 10);
		assert((await windows(session)).filter((name) => name.startsWith("subagent-")).every((name) => /^subagent-[a-z0-9]{4}$/.test(name)));

		// 5. Real runner event streams and parent widget/status are live.
		await waitFor("runner event streams", async () => {
			const checks = await Promise.all(ids.slice(0, 10).map((agentId) => exists(join(root, projectSlug(cwd), session, "subagents", agentId!, "events.jsonl"))));
			return checks.filter(Boolean).length;
		}, (count) => count === 10);
		assert(active.context.ui.widgets.get("subagent-agents"), "parent widget missing");
		assert(active.context.ui.statuses.get("subagent-agents"), "parent status/footer missing");
		await emit(active, "turn_end", { type: "turn_end", turnIndex: 1, timestamp: Date.now() });

		// 6. Parent exit is non-destructive; ten runners publish and close themselves.
		await emit(active, "session_shutdown", { type: "session_shutdown" });
		active = null;
		const artifactRoot = join(root, projectSlug(cwd), session);
		await waitFor("detached runner results", async () => {
			const done = await Promise.all(ids.slice(0, 10).map((agentId) => exists(join(artifactRoot, "subagents", agentId!, "result.json"))));
			return done.filter(Boolean).length;
		}, (count) => count === 10, 12_000);
		await waitFor("terminal windows close", () => windows(session), (value) => value.every((name) => !name.startsWith("subagent-")));

		// 7. Same-id restart dispatches the durable queue and recovers origin delivery.
		active = install(cwd, "origin-live", { PI_SESSION_ID: id }, root, fakePiPath, "tui");
		await emit(active, "session_start", { type: "session_start", reason: "resume" });
		await waitFor("queued task result after restart", () => exists(join(artifactRoot, "subagents", ids[10]!, "result.json")), Boolean, 12_000);
		await waitFor("pending origin notification", () => active!.messages.length, (count) => count > 0, 5_000);
		assert(JSON.stringify(active.messages).includes("task-notification"));

		// 8. Public result, artifact, attach, and stop behavior stays manager-owned.
		const full = await tool(active, "get_subagent_result", { agent_id: ids[0], wait: false });
		assert(resultText(full).includes("live-1"));
		assert(resultText(receipts[0]).includes(`subagent-${ids[0]}`));
		assert(receipts.some((receipt) => resultText(receipt).includes("tmux attach -t")));
		assert(await exists(join(artifactRoot, "subagents", ids[0]!)));
		const stopStartedAt = Date.now();
		const stoppable = await tool(active, "Agent", {
			description: "stop acceptance",
			prompt: "[delay=20000] [output=should-not-finish]",
			subagent_type: "worker",
			run_in_background: true,
		});
		const stopId = /subagent-([a-z0-9]{4})/.exec(resultText(stoppable))?.[1];
		assert(stopId);
		assert(Date.now() - stopStartedAt < 5_000, "background receipt waited for child completion");
		await tool(active, "stop_subagent", { agent_id: stopId });
		const stopped = await tool(active, "get_subagent_result", { agent_id: stopId, wait: true });
		assert.equal(stopped.details?.state, "cancelled");
		assert(active.commands.has("agents"));

		// 10. An explicitly foreground nested child executes in the existing tree;
		// recursive stop then cancels a second descendant deepest-first.
		const top = await tool(active, "Agent", {
			description: "nested owner",
			prompt: "[delay=20000] [output=top-finished]",
			subagent_type: "worker",
			run_in_background: true,
		});
		const topId = /subagent-([a-z0-9]{4})/.exec(resultText(top))?.[1];
		assert(topId);
		const nestedEnv = {
			PI_SUBAGENT: "1",
			PI_SUBAGENT_PARENT: id,
			PI_SUBAGENT_AGENT: topId,
			PI_SUBAGENT_ARTIFACT_ROOT: artifactRoot,
		};
		const nested = install(cwd, "origin-live", nestedEnv, root, fakePiPath, "rpc");
		await emit(nested, "session_start", { type: "session_start", reason: "startup" });
		const nestedSuccess = await tool(nested, "Agent", {
			description: "nested foreground",
			prompt: "[delay=100] [output=nested-finished]",
			subagent_type: "worker",
			run_in_background: false,
		});
		assert(resultText(nestedSuccess).includes("nested-finished"));
		const nestedPending = tool(nested, "Agent", {
			description: "nested cancelled",
			prompt: "[delay=20000] [output=nested-should-not-finish]",
			subagent_type: "worker",
			run_in_background: false,
		});
		await waitFor("second nested descendant", () => active!.getRuntime().manager.list(), (items) => items.filter((item) => item.parentAgentId === topId).length >= 2);
		await tool(active, "stop_subagent", { agent_id: topId });
		assert.equal((await nestedPending).details?.state, "cancelled");
		const descendants = (await active.getRuntime().manager.list()).filter((item) => item.parentAgentId === topId);
		assert(descendants.every((item) => item.state === "succeeded" || item.state === "cancelled"));
		await emit(nested, "session_shutdown", { type: "session_shutdown" });

		// 11. Fake mode executes a deterministic full research-profile foreground workflow.
		const research = await tool(active, "Agent", {
			description: "research acceptance",
			prompt: "[delay=100] [output=research-workflow-complete]",
			subagent_type: "research-fixture",
			run_in_background: false,
		});
		assert(resultText(research).includes("research-workflow-complete"));

		console.log(`PASS live subagent fake-Pi acceptance (11/11 assertions, ${session})`);
	} finally {
		if (active) await emit(active, "session_shutdown", { type: "session_shutdown" }).catch(() => undefined);
		if (process.env.LIVE_SUBAGENT_KEEP === "1") {
			console.error(`retained live-smoke state: root=${root} session=${session}`);
		} else {
			if (/^pi-[a-z0-9]{4}$/.test(session)) {
				await execFileAsync("tmux", ["kill-session", "-t", session]).catch(() => undefined);
			}
			await rm(root, { recursive: true, force: true });
		}
		if (oldAgentDir === undefined) delete process.env.PI_AGENT_DIR;
		else process.env.PI_AGENT_DIR = oldAgentDir;
	}
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args[0] === "--inside-check") {
		await runInsideCheck(args.slice(1));
		return;
	}
	if (args.length !== 1 || !["--fake-pi", "--real-pi"].includes(args[0])) {
		throw new Error("usage: npx tsx tests/live-subagent.smoke.ts --fake-pi|--real-pi");
	}
	if (args[0] === "--real-pi") {
		const researchIntegration = join(dirname(SELF), "..", "extensions", "research", "subagent.ts");
		if (!(await exists(researchIntegration))) {
			throw new Error("--real-pi requires the Task 14-16 research migration; rerun this operator gate before Task 18 cutover");
		}
		throw new Error("--real-pi operator execution is intentionally gated until the migrated research profile supplies its live model contract");
	}
	await runFakeAcceptance();
}

const isDirectExecution = process.argv[1] !== undefined
	&& resolve(process.argv[1]) === resolve(SELF);

if (isDirectExecution) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.stack ?? error.message : String(error));
		process.exitCode = 1;
	});
} else {
	// `vitest.config.ts` intentionally collects `tests/*.smoke.ts`. Keep import
	// side-effect free while giving the repository suite a real, cheap contract;
	// real tmux work remains opt-in through the executable CLI modes above.
	const { describe, expect, it } = await import("vitest");
	describe("live subagent acceptance driver", () => {
		it("loads without starting tmux and keeps both modes explicit", () => {
			expect(isDirectExecution).toBe(false);
			expect(main).toBeTypeOf("function");
			expect(shellJoin(["a b", "c'd"])).toBe("'a b' 'c'\"'\"'d'");
		});
	});
}
