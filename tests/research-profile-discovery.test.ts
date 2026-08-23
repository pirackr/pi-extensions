/**
 * Task 15: research profile discovery seam in the loop extension.
 *
 * Verifies that extensions/loop/index.ts registers a synchronous
 * `subagent:discover-profiles` listener that appends research-owned
 * ProfileContribution exactly once by owner/name, independent of whether loop
 * or subagent discovery runs first, and that repeated discovery does not
 * duplicate roles.
 *
 * Fails against the current loop extension, which never registers a
 * `subagent:discover-profiles` listener.
 */

import { describe, it, expect } from "vitest";
import type {
	ProfileContribution,
	ResolvedProfile,
} from "../extensions/subagent/types.ts";

interface EventPi {
	registerCommand: (...args: unknown[]) => void;
	registerTool: (...args: unknown[]) => void;
	registerMessageRenderer: (...args: unknown[]) => void;
	getActiveTools: () => string[];
	setActiveTools: (tools: string[]) => void;
	on: (channel: string, listener: (data: unknown) => void) => void;
	events: {
		on: (channel: string, listener: (data: unknown) => void) => void;
		emit: (channel: string, data: unknown) => void;
	};
}

interface CapturedPi {
	pi: EventPi;
	listeners: Map<string, ((data: unknown) => void)[]>;
}

/**
 * Minimal pi double whose `on`/`events.emit` share one channel-routing table,
 * mirroring how the real pi routes a channel to its registered listeners.
 */
function makeEventPi(): CapturedPi {
	const listeners = new Map<string, ((data: unknown) => void)[]>();
	const pi = {
		registerCommand: () => {},
		registerTool: () => {},
		registerMessageRenderer: () => {},
		getActiveTools: () => [],
		setActiveTools: () => {},
		on: (channel: string, listener: (data: unknown) => void) => {
			const existing = listeners.get(channel) ?? [];
			existing.push(listener);
			listeners.set(channel, existing);
		},
		events: {
			on: (channel: string, listener: (data: unknown) => void) => {
				const existing = listeners.get(channel) ?? [];
				existing.push(listener);
				listeners.set(channel, existing);
			},
			emit: (channel: string, data: unknown) => {
				for (const listener of listeners.get(channel) ?? []) {
					listener(data);
				}
			},
		},
	};
	return { pi, listeners };
}

function researchNames(envelope: { contributions: ProfileContribution[] }): string[] {
	return envelope.contributions
		.filter((c) => c.owner === "research")
		.map((c) => c.profile.name)
		.sort();
}

describe("Task 15 — subagent:discover-profiles listener (loop extension)", () => {
	it("registers a synchronous discovery listener that contributes research roles", async () => {
		const { default: piLoop } = await import("../extensions/loop/index.ts");
		const { pi, listeners } = makeEventPi();

		piLoop(pi as never);

		const discovery = listeners.get("subagent:discover-profiles") ?? [];
		expect(discovery.length).toBeGreaterThan(0);

		const envelope = { contributions: [] as ProfileContribution[] };
		for (const listener of discovery) {
			listener(envelope);
		}

		expect(envelope.contributions.length).toBeGreaterThan(0);
		expect(envelope.contributions.every((c) => c.owner === "research")).toBe(
			true,
		);
		for (const contribution of envelope.contributions) {
			const profile: ResolvedProfile = contribution.profile;
			expect(typeof profile.name).toBe("string");
			expect(profile.name.length).toBeGreaterThan(0);
			expect(typeof profile.systemPrompt).toBe("string");
			expect(Array.isArray(profile.tools)).toBe(true);
		}
	});

	it("does not duplicate the discovery listener when the loop loads more than once", async () => {
		const { default: piLoop } = await import("../extensions/loop/index.ts");
		const { pi, listeners } = makeEventPi();

		piLoop(pi as never);
		piLoop(pi as never);

		const discovery = listeners.get("subagent:discover-profiles") ?? [];
		expect(discovery.length).toBe(1);
	});

	it("contributes research roles after the listener registers, regardless of discovery timing", async () => {
		const { default: piLoop } = await import("../extensions/loop/index.ts");
		const { pi } = makeEventPi();

		// Subagent discovery runs before the loop extension is loaded.
		const before = { contributions: [] as ProfileContribution[] };
		pi.events.emit("subagent:discover-profiles", before);
		expect(before.contributions).toHaveLength(0);

		// The loop extension loads and registers the discovery listener.
		piLoop(pi as never);

		// Discovery again — research roles are now contributed exactly once.
		const after = { contributions: [] as ProfileContribution[] };
		pi.events.emit("subagent:discover-profiles", after);
		const names = researchNames(after);
		expect(names.length).toBeGreaterThan(0);
		expect(new Set(names).size).toBe(names.length); // no duplicate names
	});

	it("reuses immutable resolved snapshots instead of re-reading role sources per discovery", async () => {
		const { default: piLoop } = await import("../extensions/loop/index.ts");
		const { pi } = makeEventPi();
		piLoop(pi as never);

		const first = { contributions: [] as ProfileContribution[] };
		const second = { contributions: [] as ProfileContribution[] };
		pi.events.emit("subagent:discover-profiles", first);
		pi.events.emit("subagent:discover-profiles", second);

		const firstByName = new Map(
			first.contributions.map((entry) => [entry.profile.name, entry.profile]),
		);
		for (const entry of second.contributions) {
			expect(entry.profile).toBe(firstByName.get(entry.profile.name));
		}
	});

	it("appends each research role exactly once per discovery invocation", async () => {
		const { default: piLoop } = await import("../extensions/loop/index.ts");
		const { pi, listeners } = makeEventPi();
		piLoop(pi as never);

		const discovery = listeners.get("subagent:discover-profiles") ?? [];
		expect(discovery.length).toBe(1);

		const tally = new Map<string, number>();
		for (let invocation = 0; invocation < 3; invocation++) {
			const envelope = { contributions: [] as ProfileContribution[] };
			for (const listener of discovery) {
				listener(envelope);
			}
			for (const contribution of envelope.contributions) {
				tally.set(contribution.profile.name, (tally.get(contribution.profile.name) ?? 0) + 1);
			}
		}

		// Exactly three invocations → each contributed role appears exactly three times.
		expect(tally.size).toBeGreaterThan(0);
		for (const count of tally.values()) {
			expect(count).toBe(3);
		}
	});
});
