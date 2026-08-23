// Durable grouped completion delivery for the `subagent` extension.
//
// The {@link NotificationCoordinator} owns the lifecycle of a single background
// turn: {@link NotificationCoordinator.turnStart} allocates a durable group,
// background tasks publish into it, and {@link NotificationCoordinator.turnEnd}
// (or {@link NotificationCoordinator.evaluate} when the last member settles)
// delivers one at-most-once notification to the active conversation.
//
// Delivery is serialized against task-9 result consumption with the same
// {@link withRegistryLock} and current manager-generation assertion the store
// uses, and {@link DeliveryRecord} state (`pending` → `dispatching` →
// `delivered` / `consumed`) is persisted atomically. `dispatching` is written
// before the single {@link pi.sendMessage} attempt so a crash or failure in
// that tiny interval is recoverable without ever sending twice.
//
// This module owns nothing research-specific: it consumes generic manifests,
// results, and delivery records, binds to the live {@link NotificationCoordinatorDeps.activeOrigin},
// and never interprets an owner's policy.

import { createHash } from "node:crypto";

import { withRegistryLock, type ManagerLease } from "./locks.ts";

import {
	type ArtifactStore,
} from "./storage.ts";
import {
	type GroupRecord,
	type NotificationItem,
	type DeliveryRecord,
	type TerminalResult,
} from "./types.ts";

export { type NotificationItem } from "./types.ts";

/** Exact Pi message shape delivered for a group notification. */
export interface NotificationMessage {
	readonly customType: "subagent-notification";
	readonly content: string;
	readonly display: boolean;
	readonly details: {
		readonly notificationId: string;
		readonly groupId: string;
		readonly agentIds: string[];
	};
}

/** Exact Pi options delivered alongside a group notification. */
export interface NotificationOptions {
	readonly deliverAs: "followUp";
	readonly triggerTurn: boolean;
}

/**
 * Injectable dependencies for {@link createNotificationCoordinator}. Every
 * side effect — filesystem (via {@link ArtifactStore}), manager lease, active
 * origin, generation assertion, clock, and nonce — is injectable so delivery,
 * serialization, and recovery are verified deterministically without a live
 * manager or conversation.
 */
export interface NotificationCoordinatorDeps {
	/** The durable artifact store for the current parent. */
	readonly store: ArtifactStore;
	/**
	 * Send one notification message. The single physical delivery attempt; a
	 * throw here is treated as an ambiguous (possibly delivered) outcome.
	 */
	readonly pi: {
		sendMessage: (
			message: NotificationMessage,
			options: NotificationOptions,
		) => Promise<void>;
	};
	/** Path to the short-lived {@link registry.lock}. */
	readonly registryLockPath: string;
	/** Owner label recorded in the registry lease. */
	readonly owner: string;
	/** Returns the current active origin conversation UUID. */
	readonly activeOrigin: () => string;
	/** Current manager generation, recorded on every group record. */
	readonly managerGeneration: string;
	/**
	 * Throw when the manager generation is stale, so durable mutations cannot
	 * happen under a superseded manager.
	 */
	readonly assertManagerCurrent: () => Promise<void>;
	/** Fresh nonce source disambiguating same-turn groups. */
	readonly nonce: () => string;
	/** Monotonic-ish clock. */
	readonly now: () => number;
	/** How long to wait for every member before partial-flushing terminals. */
	readonly groupWaitMs: number;
	/**
	 * Install a one-shot flush timer for the active turn's partial delivery.
	 * Returns an opaque handle to pass to {@link cancelScheduled}. Injectable so
	 * the timeout seam is driven deterministically (and on a real event loop)
	 * by callers and tests.
	 */
	readonly schedule: (callback: () => Promise<void>, delayMs: number) => ScheduledHandle;
	/** Cancel a handle returned by {@link schedule}. */
	readonly cancelScheduled: (handle: ScheduledHandle) => void;
}

/**
 * The grouped-notification coordinator. One instance per active turn; methods
 * are the durable, lock-serialized surface the manager wires into lifecycle
 * events.
 */
export interface NotificationCoordinator {
	/**
	 * Allocate a durable, path-safe group id for background turn `turnIndex`,
	 * persist its record, and return the id.
	 *
	 * @throws when the manager generation is stale.
	 */
	turnStart(turnIndex: number): Promise<string>;

	/**
	 * Mark the active group ended. When every background member is terminal,
	 * deliver immediately; otherwise schedule a partial flush of the members
	 * that have settled by the group timeout.
	 *
	 * @throws when the manager generation is stale.
	 */
	turnEnd(): Promise<void>;

	/**
	 * Re-check the group that owns `agentId` when it settles: cancel the flush
	 * timer and deliver if every member is now terminal.
	 */
	evaluate(agentId: string): Promise<void>;

	/** Mark a member's delivery consumed, omitting it from any delivery. */
	consume(agentId: string): Promise<void>;

	/**
	 * Recover durable state after a crash: mark any in-flight
	 * `dispatching` delivery as `delivered` without resending, then re-attempt
	 * every all-terminal group whose origin still matches.
	 */
	recover(): Promise<void>;
}

/** The notification group XML root element. */
const NOTIFICATIONS_ROOT = "<task-notifications>";
const NOTIFICATION_ELEMENT = "<task-notification>";

/** Opaque handle returned by {@link NotificationCoordinatorDeps.schedule}. */
type ScheduledHandle = unknown;

/** Escape XML text and strip NUL characters so they never reach the output. */
function escapeText(value: string): string {
	return value
		.replace(/\u0000/g, "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/**
 * Truncate `value` to at most `limit` Unicode code points, appending an
 * ellipsis only when truncation actually drops characters. The result is
 * never longer than `limit` code points and never contains a replacement
 * character.
 */
function truncatePreview(value: string, limit: number): string {
	const chars = Array.from(value);
	if (chars.length <= limit) return value;
	return `${chars.slice(0, limit - 1).join("")}…`;
}

/**
 * Render the exact task-notifications XML for a set of terminal members.
 * `previewLimit` caps the code points of each member's `output` preview.
 */
export function renderNotificationXml(
	items: NotificationItem[],
	previewLimit: number,
): string {
	const bodies = items.map((item) => [
		"  <task-notification>",
		`    <task-id>${escapeText(item.agentId)}</task-id>`,
		`    <status>${escapeText(item.state)}</status>`,
		`    <summary>${escapeText(item.summary)}</summary>`,
		`    <result>${escapeText(truncatePreview(item.output, previewLimit))}</result>`,
		"    <usage>",
		`      <total_tokens>${item.usage.totalTokens}</total_tokens>`,
		`      <tool_uses>${item.usage.toolUses}</tool_uses>`,
		`      <duration_ms>${item.usage.durationMs}</duration_ms>`,
		"    </usage>",
		"  </task-notification>",
	].join("\n"));

	return `${NOTIFICATIONS_ROOT}
${bodies.join("\n")}
</task-notifications>`;
}

/** Terminal task states that make a member eligible for delivery. */
const TERMINAL_STATES: readonly TerminalResult["state"][] = [
	"succeeded",
	"failed",
	"timed_out",
	"cancelled",
	"interrupted",
];

/**
 * Build a coordinator from {@link NotificationCoordinatorDeps}. Returns a frozen
 * coordinator instance.
 */
export function createNotificationCoordinator(
	deps: NotificationCoordinatorDeps,
): NotificationCoordinator {
	const { store, registryLockPath, owner, activeOrigin, managerGeneration,
		assertManagerCurrent, nonce, now, groupWaitMs, schedule, cancelScheduled } = deps;
	const pi = deps.pi;
	// A single never-aborted signal guards the registry lease for the
	// coordinator's lifetime; delivery is short-lived and never abortable.
	const signal = new AbortController().signal;

	/** Acquire the registry lease for a durable notification mutation. */
	function lock<T>(fn: () => Promise<T>): Promise<T> {
		return withRegistryLock(registryLockPath, owner, fn, signal);
	}

	let currentGroupId: string | null = null;
	const flushTimers = new Map<string, ScheduledHandle>();

	/**
	 * Install the active turn's partial-flush timer. The scheduled callback
	 * runs the durable {@link deliver} path so the flush persists
	 * `dispatching` before its single send and `delivered` afterwards — the same
	 * at-most-once contract as immediate and recovery delivery. Rejections are
	 * swallowed so a send failure never surfaces as an unhandled rejection.
	 */
	function scheduleFlushTimer(groupId: string): void {
		const handle = schedule(
			() =>
				(async () => {
					flushTimers.delete(groupId);
					await deliver(groupId);
				})().catch(() => {
					// A failure leaves members as `dispatching`; recover()
					// treats that as an ambiguous, already-attempted delivery and
					// never resends. Swallow so the timer raises no rejection.
				}),
			groupWaitMs,
		);
		flushTimers.set(groupId, handle);
	}

	async function clearFlushTimer(groupId: string): Promise<void> {
		const handle = flushTimers.get(groupId);
		if (handle !== undefined) {
			cancelScheduled(handle);
			flushTimers.delete(groupId);
		}
	}

	function deriveGroupId(inputs: {
		origin: string;
		managerGeneration: string;
		turnIndex: number;
		nonce: string;
	}): string {
		// A lowercase hex digest is a subset of `[a-z0-9]`, so the derived id is
		// always path-safe and stable for the same inputs.
		return createHash("sha256")
			.update([inputs.origin, inputs.managerGeneration, String(inputs.turnIndex), inputs.nonce].join("\u0000"))
			.digest("hex")
			.slice(0, 12);
	}

	function makeNotificationId(clock: number): string {
		const salt = `${clock}-${Math.random().toString(36).slice(2)}`;
		return `notif-${createHash("sha256")
			.update(salt)
			.digest("hex")
			.slice(0, 12)}`;
	}

	async function readGroupMembers(groupId: string): Promise<string[]> {
		const manifests = await store.scanAll();
		return manifests
			.filter((m) => m.groupId === groupId)
			.map((m) => m.agentId)
			.sort((a, b) => {
				const ma = manifests.find((m) => m.agentId === a);
				const mb = manifests.find((m) => m.agentId === b);
				return (ma?.sequence ?? 0) - (mb?.sequence ?? 0);
			});
	}

	async function isTerminal(agentId: string): Promise<boolean> {
		const result = await store.readResult(agentId);
		return result !== null;
	}

	async function allMembersTerminal(groupId: string): Promise<boolean> {
		const memberIds = await readGroupMembers(groupId);
		if (memberIds.length === 0) return false;
		for (const id of memberIds) {
			if (!(await isTerminal(id))) return false;
		}
		return true;
	}

	async function isEligible(agentId: string): Promise<boolean> {
		const delivery = await store.readDelivery(agentId);
		return delivery === null || delivery.state === "pending";
	}

	async function buildItem(agentId: string): Promise<NotificationItem> {
		const manifest = await store.readTask(agentId);
		const terminal = await store.readResult(agentId);
		const name = manifest?.profile.name ?? "agent";
		const description = manifest?.description ?? agentId;
		return {
			agentId,
			state: terminal?.state ?? (manifest?.state as TerminalResult["state"]) ?? "succeeded",
			summary: `${name}: ${description}`,
			output: terminal?.output ?? "",
			usage: terminal?.usage ?? { totalTokens: 0, toolUses: 0, durationMs: 0 },
		};
	}

	/**
	 * Deliver one notification for `groupId`: compute eligible members under the
	 * registry lease, persist `dispatching`, send exactly once, then mark
	 * `delivered` only if no consumer claimed it during the send.
	 */
	async function deliver(groupId: string): Promise<void> {
		await clearFlushTimer(groupId);

		// Central origin binding: a group that no longer belongs to the active
		// conversation (for example after a `/new`) never sends, even when a
		// straggler settles or a scheduled flush fires later. Resuming the
		// original origin makes pending delivery eligible again.
		const group = await store.readGroup(groupId);
		if (!group || group.origin !== activeOrigin()) return;

		let eligible: string[] = [];
		let notificationId = "";
		await lock(async () => {
			await assertManagerCurrent();
			const memberIds = await readGroupMembers(groupId);
			for (const id of memberIds) {
				const terminal = await store.readResult(id);
				if (terminal && (await isEligible(id))) {
					eligible.push(id);
				}
			}
			if (eligible.length === 0) return;
			notificationId = makeNotificationId(now());
			for (const id of eligible) {
				await store.updateDelivery(id, {
					groupId,
					agentIds: eligible,
					state: "dispatching",
					notificationId,
					createdAt: now(),
					dispatchedAt: now(),
					consumedAt: null,
				});
			}
		});

		if (eligible.length === 0) return;

		const items = [];
		for (const id of eligible) {
			items.push(await buildItem(id));
		}
		const previewLimit = eligible.length === 1 ? 500 : 300;
		const content = renderNotificationXml(items, previewLimit);

		const message: NotificationMessage = {
			customType: "subagent-notification",
			content,
			display: true,
			details: { notificationId, groupId, agentIds: eligible },
		};
		const options: NotificationOptions = {
			deliverAs: "followUp",
			triggerTurn: true,
		};

		await pi.sendMessage(message, options);

		// A consumer may have claimed a member mid-send; only promote to delivered
		// when the record is still dispatching.
		await lock(async () => {
			for (const id of eligible) {
				const current = await store.readDelivery(id);
				if (current && current.state === "dispatching") {
					await store.updateDelivery(id, { state: "delivered" });
				}
			}
		});
	}

	return Object.freeze({
		async turnStart(turnIndex: number): Promise<string> {
			await assertManagerCurrent();
			const origin = activeOrigin();
			const value = nonce();
			const groupId = deriveGroupId({
				origin,
				managerGeneration,
				turnIndex,
				nonce: value,
			});
			await lock(async () => {
				await store.writeGroup({
					groupId,
					origin,
					managerGeneration,
					turnIndex,
					nonce: value,
					createdAt: now(),
					endedAt: null,
				});
			});
			currentGroupId = groupId;
			return groupId;
		},

		async turnEnd(): Promise<void> {
			await assertManagerCurrent();
			const groupId = currentGroupId;
			currentGroupId = null;
			if (!groupId) return;

			const origin = activeOrigin();
			await lock(async () => {
				await store.updateGroup(groupId, { endedAt: now() });
			});

			const group = await store.readGroup(groupId);
			if (group && origin === group.origin && await allMembersTerminal(groupId)) {
				await deliver(groupId);
			} else {
				scheduleFlushTimer(groupId);
			}
		},

		async evaluate(agentId: string): Promise<void> {
			const manifest = await store.readTask(agentId);
			if (!manifest || !manifest.groupId) return;
			const groupId = manifest.groupId;
			await clearFlushTimer(groupId);
			if (await allMembersTerminal(groupId)) {
				await deliver(groupId);
			}
		},

		async consume(agentId: string): Promise<void> {
			await lock(async () => {
				await assertManagerCurrent();
				const existing = await store.readDelivery(agentId);
				await store.updateDelivery(agentId, {
					state: "consumed",
					consumedAt: now(),
					groupId: existing?.groupId ?? "",
					agentIds: existing?.agentIds ?? [agentId],
					notificationId: existing?.notificationId ?? "",
					createdAt: existing?.createdAt ?? now(),
					dispatchedAt: existing?.dispatchedAt ?? null,
				});
			});
		},

		async recover(): Promise<void> {
			// Crash recovery: an in-flight `dispatching` delivery is treated as
			// already attempted and promoted to `delivered` without resending.
			await lock(async () => {
				await assertManagerCurrent();
				const manifests = await store.scanAll();
				for (const manifest of manifests) {
					const delivery = await store.readDelivery(manifest.agentId);
					if (delivery && delivery.state === "dispatching") {
						await store.updateDelivery(manifest.agentId, {
							state: "delivered",
						});
					}
				}
			});

			// Re-attempt every all-terminal group whose origin still matches the
			// active conversation (for example after a `/new` suppression).
			const groups = await store.scanGroups();
			const origin = activeOrigin();
			for (const group of groups) {
				if (group.origin !== origin) continue;
				if (!(await allMembersTerminal(group.groupId))) continue;
				await deliver(group.groupId);
			}
		},
	});
}
