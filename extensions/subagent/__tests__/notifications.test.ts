import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import {
	createNotificationCoordinator,
	renderNotificationXml,
	type NotificationCoordinator,
	type NotificationCoordinatorDeps,
	type NotificationItem,
} from "../notifications.ts";
import { createArtifactStore, type ArtifactStore } from "../storage.ts";
import type {
	AgentManifest,
	ResolvedProfile,
	TerminalResult,
} from "../types.ts";

const PROFILE: ResolvedProfile = {
	name: "reviewer",
	description: "Reviews changes",
	model: "model",
	thinking: "off",
	tools: ["read"],
	access: "read",
	timeoutSeconds: 900,
	systemPrompt: "Review carefully.",
	source: "bundled",
};

function manifest(
	agentId: string,
	groupId: string | null,
	origin = "conversation-a",
	sequence = 1,
): AgentManifest {
	return {
		schema: 1,
		generation: `task-${agentId}`,
		revision: 1,
		parentId: "a7k2",
		agentId,
		parentAgentId: null,
		ownershipTreeId: agentId,
		origin,
		groupId,
		description: `Audit ${agentId}`,
		prompt: "Perform the complete audit.",
		profile: PROFILE,
		state: "queued",
		sequence,
		queuedAt: 1_700_000_000_000,
		startedAt: null,
		heartbeatAt: null,
		finishedAt: null,
		runnerPid: null,
		processStart: "",
		tmuxSession: null,
		tmuxWindow: null,
		timeoutSeconds: 900,
		terminalReason: null,
	};
}

function result(
	agentId: string,
	finishedAt: number,
	output = `result-${agentId}`,
): TerminalResult {
	return {
		agentId,
		state: "succeeded",
		output,
		usage: { totalTokens: 12_400, toolUses: 5, durationMs: 4_100 },
		finishedAt,
		terminalReason: null,
	};
}

type SentMessage = {
	message: {
		customType: string;
		content: string;
		display: boolean;
		details: { notificationId: string; groupId: string; agentIds: string[] };
	};
	options: { deliverAs: string; triggerTurn: boolean };
};

let root: string;
let store: ArtifactStore;
let activeOrigin: string;
let nowMs: number;
let nonce: number;
let sent: SentMessage[];
let sendImpl: NotificationCoordinatorDeps["pi"]["sendMessage"];
type ScheduledFlush = {
	callback: () => Promise<void>;
	delayMs: number;
	cancelled: boolean;
};
let scheduled: ScheduledFlush[];
let coordinator: NotificationCoordinator;

function coordinatorDeps(
	overrides: Partial<NotificationCoordinatorDeps> = {},
): NotificationCoordinatorDeps {
	return {
		store,
		pi: {
			sendMessage: async (message, options) => sendImpl(message, options),
		},
		registryLockPath: join(store.artifactRoot, "registry.lock"),
		owner: "notification-tests",
		activeOrigin: () => activeOrigin,
		managerGeneration: "manager-generation",
		assertManagerCurrent: async () => {},
		nonce: () => `nonce-${++nonce}`,
		now: () => nowMs,
		groupWaitMs: 30_000,
		schedule: (callback, delayMs) => {
			const flush = { callback, delayMs, cancelled: false };
			scheduled.push(flush);
			return flush;
		},
		cancelScheduled: (handle) => {
			(handle as ScheduledFlush).cancelled = true;
		},
		...overrides,
	};
}

async function enqueueTerminal(
	agentId: string,
	groupId: string | null,
	sequence = 1,
	origin = "conversation-a",
	finishedAt = nowMs,
	output?: string,
): Promise<void> {
	await store.enqueue(manifest(agentId, groupId, origin, sequence), {});
	await store.publishTerminal(agentId, result(agentId, finishedAt, output));
}

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "subagent-notifications-"));
	store = createArtifactStore({
		id: "a7k2",
		tmuxSession: "pi-a7k2",
		tmpRoot: root,
		projectSlug: "project-hash",
		artifactRoot: join(root, "project-hash", "pi-a7k2"),
	});
	await store.initializeParent();
	activeOrigin = "conversation-a";
	nowMs = 1_700_000_000_000;
	nonce = 0;
	sent = [];
	scheduled = [];
	sendImpl = async (message, options) => {
		sent.push({ message, options });
	};
	coordinator = createNotificationCoordinator(coordinatorDeps());
});

describe("renderNotificationXml", () => {
	const item = (output: string): NotificationItem => ({
		agentId: "q9xm",
		state: "succeeded",
		summary: "reviewer: Audit authentication",
		output,
		usage: { totalTokens: 12_400, toolUses: 5, durationMs: 4_100 },
	});

	it("renders the specified XML structure and escapes every dynamic field", () => {
		const xml = renderNotificationXml([
			{
				...item("<result>&\"'\u0000"),
				agentId: "q&9xm",
				summary: "reviewer: <audit> & \"auth\"",
			},
		], 500);

		expect(xml).toBe([
			"<task-notifications>",
			"  <task-notification>",
			"    <task-id>q&amp;9xm</task-id>",
			"    <status>succeeded</status>",
			"    <summary>reviewer: &lt;audit&gt; &amp; &quot;auth&quot;</summary>",
			"    <result>&lt;result&gt;&amp;&quot;&apos;</result>",
			"    <usage>",
			"      <total_tokens>12400</total_tokens>",
			"      <tool_uses>5</tool_uses>",
			"      <duration_ms>4100</duration_ms>",
			"    </usage>",
			"  </task-notification>",
			"</task-notifications>",
		].join("\n"));
	});

	it("truncates by Unicode code point without exceeding 500 or 300 characters", () => {
		const emoji = "😀";
		const solo = renderNotificationXml([item(emoji.repeat(600))], 500);
		const grouped = renderNotificationXml([item(emoji.repeat(600))], 300);
		const soloPreview = solo.match(/<result>(.*)<\/result>/)?.[1] ?? "";
		const groupedPreview = grouped.match(/<result>(.*)<\/result>/)?.[1] ?? "";

		expect(Array.from(soloPreview)).toHaveLength(500);
		expect(Array.from(groupedPreview)).toHaveLength(300);
		expect(soloPreview.endsWith("…")).toBe(true);
		expect(groupedPreview.endsWith("…")).toBe(true);
		expect(soloPreview).not.toContain("�");
	});
});

describe("NotificationCoordinator groups", () => {
	it("allocates distinct path-safe durable IDs from turn index and nonce", async () => {
		const first = await coordinator.turnStart(7);
		await coordinator.turnEnd();
		const second = await coordinator.turnStart(8);

		expect(first).not.toBe(second);
		expect(first).toMatch(/^[a-z0-9_-]+$/);
		expect(first).not.toContain("..");
		expect(await store.readGroup(first)).toMatchObject({
			groupId: first,
			origin: "conversation-a",
			managerGeneration: "manager-generation",
			turnIndex: 7,
			nonce: "nonce-1",
			endedAt: expect.any(Number),
		});
		expect(await store.readGroup(second)).toMatchObject({
			turnIndex: 8,
			nonce: "nonce-2",
			endedAt: null,
		});
	});

	it("groups same-turn background members once and excludes foreground work", async () => {
		const groupId = await coordinator.turnStart(3);
		await enqueueTerminal("q9xm", groupId, 1);
		await enqueueTerminal("v4nr", groupId, 2);
		await enqueueTerminal("fgab", null, 3);

		await coordinator.evaluate("fgab");
		expect(sent).toHaveLength(0);
		await coordinator.turnEnd();

		expect(sent).toHaveLength(1);
		expect(sent[0].message).toMatchObject({
			customType: "subagent-notification",
			display: true,
			details: { groupId, agentIds: ["q9xm", "v4nr"] },
		});
		expect(sent[0].options).toEqual({ deliverAs: "followUp", triggerTurn: true });
		expect(sent[0].message.content.match(/<task-notification>/g)).toHaveLength(2);
		expect(sent[0].message.content).not.toContain("fgab");
		const first = await store.readDelivery("q9xm");
		const second = await store.readDelivery("v4nr");
		expect(first).toMatchObject({ state: "delivered", agentIds: ["q9xm", "v4nr"] });
		expect(second?.notificationId).toBe(first?.notificationId);
	});

	it("waits for every member, then delivers immediately when the last settles", async () => {
		const groupId = await coordinator.turnStart(4);
		await enqueueTerminal("q9xm", groupId, 1);
		await store.enqueue(manifest("v4nr", groupId, "conversation-a", 2), {});
		await coordinator.turnEnd();
		expect(sent).toHaveLength(0);

		await store.publishTerminal("v4nr", result("v4nr", nowMs + 1));
		await coordinator.evaluate("v4nr");
		expect(sent).toHaveLength(1);
		expect(sent[0].message.details.agentIds).toEqual(["q9xm", "v4nr"]);
	});

	it("flushes terminal members durably after 30 seconds and later delivers stragglers separately", async () => {
		const groupId = await coordinator.turnStart(5);
		await enqueueTerminal("q9xm", groupId, 1, "conversation-a", nowMs);
		await store.enqueue(manifest("v4nr", groupId, "conversation-a", 2), {});
		let stateObservedDuringSend: string | undefined;
		sendImpl = async (message, options) => {
			stateObservedDuringSend = (await store.readDelivery("q9xm"))?.state;
			sent.push({ message, options });
		};
		await coordinator.turnEnd();
		expect(sent).toHaveLength(0);
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]).toMatchObject({ delayMs: 30_000, cancelled: false });

		nowMs += 30_000;
		await scheduled[0].callback();
		expect(stateObservedDuringSend).toBe("dispatching");
		expect(sent).toHaveLength(1);
		expect(sent[0].message.details.agentIds).toEqual(["q9xm"]);
		expect(await store.readDelivery("q9xm")).toMatchObject({ state: "delivered" });

		nowMs += 10_000;
		await store.publishTerminal("v4nr", result("v4nr", nowMs));
		await coordinator.evaluate("v4nr");
		expect(sent).toHaveLength(2);
		expect(sent[1].message.details.agentIds).toEqual(["v4nr"]);
	});

	it("uses 500 characters for solo delivery and 300 per grouped item", async () => {
		const emoji = "😀";
		const soloGroup = await coordinator.turnStart(6);
		await enqueueTerminal("q9xm", soloGroup, 1, "conversation-a", nowMs, emoji.repeat(600));
		await coordinator.turnEnd();
		const soloPreview = sent[0].message.content.match(/<result>(.*)<\/result>/)?.[1] ?? "";
		expect(Array.from(soloPreview)).toHaveLength(500);

		const groupedId = await coordinator.turnStart(7);
		await enqueueTerminal("v4nr", groupedId, 2, "conversation-a", nowMs, emoji.repeat(600));
		await enqueueTerminal("k2pd", groupedId, 3, "conversation-a", nowMs, emoji.repeat(600));
		await coordinator.turnEnd();
		const previews = [...sent[1].message.content.matchAll(/<result>(.*)<\/result>/g)];
		expect(previews).toHaveLength(2);
		expect(previews.map((match) => Array.from(match[1]).length)).toEqual([300, 300]);
	});

	it("does not deliver a wrong-origin straggler after activeOrigin changes", async () => {
		const groupId = await coordinator.turnStart(20);
		await enqueueTerminal("q9xm", groupId, 1, "conversation-a");
		// active conversation changed (e.g. /new); the straggler settles afterwards
		activeOrigin = "conversation-b";
		await store.enqueue(manifest("v4nr", groupId, "conversation-a", 2), {});
		await store.publishTerminal("v4nr", result("v4nr", nowMs + 1));
		await coordinator.evaluate("v4nr");
		expect(sent).toHaveLength(0);
		expect(await store.readDelivery("q9xm")).toBeNull();
	});

	it("does not deliver a scheduled flush for a wrong-origin group after activeOrigin changes", async () => {
		const groupId = await coordinator.turnStart(21);
		await enqueueTerminal("q9xm", groupId, 1, "conversation-a");
		await store.enqueue(manifest("v4nr", groupId, "conversation-a", 2), {});
		await coordinator.turnEnd();
		expect(scheduled).toHaveLength(1);
		// origin changes after the flush is scheduled
		activeOrigin = "conversation-b";
		nowMs += 30_000;
		await scheduled[0].callback();
		expect(sent).toHaveLength(0);
		expect(await store.readDelivery("q9xm")).toBeNull();
	});
});

describe("NotificationCoordinator delivery safety", () => {
	it("omits consumed members and emits nothing for a fully consumed group", async () => {
		const groupId = await coordinator.turnStart(9);
		await enqueueTerminal("q9xm", groupId);
		await coordinator.consume("q9xm");
		await coordinator.turnEnd();

		expect(sent).toHaveLength(0);
		expect(await store.readDelivery("q9xm")).toMatchObject({ state: "consumed" });
	});

	it("serializes consumption against dispatch so the lock winner determines visibility", async () => {
		const consumedFirst = await coordinator.turnStart(10);
		await enqueueTerminal("q9xm", consumedFirst);
		await coordinator.consume("q9xm");
		await coordinator.turnEnd();
		expect(sent).toHaveLength(0);

		const dispatchFirst = await coordinator.turnStart(11);
		await enqueueTerminal("v4nr", dispatchFirst, 2);
		sendImpl = async (message, options) => {
			sent.push({ message, options });
			await coordinator.consume("v4nr");
		};
		await coordinator.turnEnd();
		expect(sent).toHaveLength(1);
		expect(await store.readDelivery("v4nr")).toMatchObject({ state: "consumed" });
	});

	it("persists dispatching before send and never retries an ambiguous send failure", async () => {
		const groupId = await coordinator.turnStart(12);
		await enqueueTerminal("q9xm", groupId);
		let attempts = 0;
		sendImpl = async () => {
			attempts += 1;
			expect(await store.readDelivery("q9xm")).toMatchObject({ state: "dispatching" });
			throw new Error("send refused");
		};

		await expect(coordinator.turnEnd()).rejects.toThrow("send refused");
		expect(attempts).toBe(1);
		expect(await store.readDelivery("q9xm")).toMatchObject({ state: "dispatching" });
		sendImpl = async () => {
			attempts += 1;
		};
		await coordinator.recover();
		expect(attempts).toBe(1);
		expect(await store.readDelivery("q9xm")).toMatchObject({ state: "delivered" });
	});

	it("recovers a crash-marked dispatching delivery as attempted without sending", async () => {
		const groupId = await coordinator.turnStart(13);
		await enqueueTerminal("q9xm", groupId);
		await store.updateDelivery("q9xm", {
			groupId,
			agentIds: ["q9xm"],
			state: "dispatching",
			notificationId: "notification-crash",
			createdAt: nowMs,
			dispatchedAt: nowMs,
			consumedAt: null,
		});

		await coordinator.recover();
		expect(sent).toHaveLength(0);
		expect(await store.readDelivery("q9xm")).toMatchObject({ state: "delivered" });
	});

	it("fails closed on a stale manager in evaluate before any durable mutation", async () => {
		const stale = createNotificationCoordinator(coordinatorDeps({
			assertManagerCurrent: async () => {
				throw new Error("manager generation changed");
			},
		}));
		// Seed a real group so evaluate's delivery path reaches the lease.
		const seeded = createNotificationCoordinator(coordinatorDeps());
		const groupId = await seeded.turnStart(22);
		await enqueueTerminal("q9xm", groupId, 1, "conversation-a");
		await store.enqueue(manifest("v4nr", groupId, "conversation-a", 2), {});
		await store.publishTerminal("v4nr", result("v4nr", nowMs + 1));
		await expect(stale.evaluate("q9xm")).rejects.toThrow("manager generation changed");
		expect(sent).toHaveLength(0);
		expect(await store.readDelivery("q9xm")).toBeNull();
	});

	it("fails closed on a stale manager in consume before any durable mutation", async () => {
		const stale = createNotificationCoordinator(coordinatorDeps({
			assertManagerCurrent: async () => {
				throw new Error("manager generation changed");
			},
		}));
		const groupId = "group-stale-consume";
		await enqueueTerminal("q9xm", groupId, 1, "conversation-a");
		await expect(stale.consume("q9xm")).rejects.toThrow("manager generation changed");
		expect(await store.readDelivery("q9xm")).toBeNull();
	});

	it("fails closed on a stale manager in recover before any durable promotion", async () => {
		const stale = createNotificationCoordinator(coordinatorDeps({
			assertManagerCurrent: async () => {
				throw new Error("manager generation changed");
			},
		}));
		const groupId = "group-stale-recover";
		await enqueueTerminal("q9xm", groupId, 1, "conversation-a");
		await store.updateDelivery("q9xm", {
			groupId,
			agentIds: ["q9xm"],
			state: "dispatching",
			notificationId: "notif-stale",
			createdAt: nowMs,
			dispatchedAt: nowMs,
			consumedAt: null,
		});
		await expect(stale.recover()).rejects.toThrow("manager generation changed");
		const delivery = await store.readDelivery("q9xm");
		expect(delivery?.state).toBe("dispatching");
	});

	it("suppresses /new and sends when the original conversation resumes", async () => {
		const groupId = await coordinator.turnStart(14);
		await enqueueTerminal("q9xm", groupId);
		activeOrigin = "conversation-new";
		await coordinator.turnEnd();
		expect(sent).toHaveLength(0);

		activeOrigin = "conversation-a";
		await coordinator.recover();
		expect(sent).toHaveLength(1);
		expect(sent[0].message.details.groupId).toBe(groupId);
	});

	it("fails closed before durable mutation when manager ownership is stale", async () => {
		const stale = createNotificationCoordinator(coordinatorDeps({
			assertManagerCurrent: async () => {
				throw new Error("manager generation changed");
			},
		}));
		await expect(stale.turnStart(15)).rejects.toThrow("manager generation changed");
		expect(await store.scanGroups()).toEqual([]);
	});
});
