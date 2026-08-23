import { describe, it, expect } from "vitest";
import {
	AgentRequest,
	AgentManifest,
	ProfileContribution,
	ProfilePolicyAdapter,
	ProfileReservation,
	ProfileSettlement,
	ResolvedProfile,
	TaskStatus,
	TerminalResult,
	DeliveryRecord,
	AgentReceipt,
	ResultResponse,
	StopResponse,
	Usage,
	normalizeAgentRequest,
	isShortId,
	assertTransition,
	type AgentAccess,
} from "../types.ts";

// ---------------------------------------------------------------------------
// isShortId
// ---------------------------------------------------------------------------

describe("isShortId", () => {
	it("accepts lowercase four-character alphanumerics", () => {
		for (const id of ["a7k2", "q9xm", "4vnr", "z000", "aaaa", "9zz9"]) {
			expect(isShortId(id)).toBe(true);
		}
	});

	it("rejects anything that is not exactly four a-z0-9 characters", () => {
		for (const bad of [
			"",
			"a",
			"abc",
			"abcd1",
			"ABCd",
			"a7k_",
			"a7-k",
			" a7k",
			"a7k ",
			"Ａ７Ｋ２",
			"\\x1b",
			undefined,
			null,
			1234,
			true,
		]) {
			expect(isShortId(bad as unknown as string)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// normalizeAgentRequest — strictness + run_in_background defaulting
// ---------------------------------------------------------------------------

describe("normalizeAgentRequest", () => {
	it("defaults run_in_background to true when omitted", () => {
		const request = normalizeAgentRequest({
			description: "do abc",
			prompt: "the whole task",
			subagent_type: "worker",
		});
		expect(request.run_in_background).toBe(true);
	});

	it("defaults run_in_background to true when null", () => {
		const request = normalizeAgentRequest({
			description: "do abc",
			prompt: "the whole task",
			subagent_type: "worker",
			run_in_background: null,
		});
		expect(request.run_in_background).toBe(true);
	});

	it("preserves an explicit run_in_background: false", () => {
		const request = normalizeAgentRequest({
			description: "do abc",
			prompt: "the whole task",
			subagent_type: "worker",
			run_in_background: false,
		});
		expect(request.run_in_background).toBe(false);
	});

	it("rejects non-boolean run_in_background", () => {
		expect(() =>
			normalizeAgentRequest({
				description: "do abc",
				prompt: "the whole task",
				subagent_type: "worker",
				run_in_background: "yes",
			}),
		).toThrow("run_in_background must be a boolean");
	});

	it("rejects empty or missing required fields", () => {
		expect(() =>
			normalizeAgentRequest({
				description: "",
				prompt: "the whole task",
				subagent_type: "worker",
			}),
		).toThrow();
		expect(() =>
			normalizeAgentRequest({
				description: "do abc",
				subagent_type: "worker",
			}),
		).toThrow();
		expect(() =>
			normalizeAgentRequest({
				description: "do abc",
				prompt: "the whole task",
			}),
		).toThrow();
	});

	it("rejects non-string required fields", () => {
		expect(() =>
			normalizeAgentRequest({
				description: 42,
				prompt: "the whole task",
				subagent_type: "worker",
			}),
		).toThrow();
	});

	it("returns a frozen request with exactly the four contract fields", () => {
		const request = normalizeAgentRequest({
			description: "do abc",
			prompt: "the whole task",
			subagent_type: "worker",
		});
		expect(Object.keys(request).sort()).toEqual([
			"description",
			"prompt",
			"run_in_background",
			"subagent_type",
		]);
		expect(Object.isFrozen(request)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// assertTransition — every allowed and forbidden edge
// ---------------------------------------------------------------------------

const STATES: TaskStatus[] = [
	"queued",
	"starting",
	"running",
	"succeeded",
	"failed",
	"timed_out",
	"cancelled",
	"interrupted",
];

const ALLOWED: Array<[TaskStatus, TaskStatus]> = [
	["queued", "starting"],
	["queued", "cancelled"],
	["starting", "running"],
	["running", "succeeded"],
	["running", "failed"],
	["running", "timed_out"],
	["running", "cancelled"],
	["running", "interrupted"],
];

describe("assertTransition", () => {
	it("permits every allowed lifecycle edge", () => {
		for (const [from, to] of ALLOWED) {
			expect(() => assertTransition(from, to)).not.toThrow();
		}
	});

	it("rejects every forbidden lifecycle edge exactly once", () => {
		for (const from of STATES) {
			for (const to of STATES) {
				if (from === to) continue;
				const isAllowed = ALLOWED.some(
					([f, t]) => f === from && t === to,
				);
				if (isAllowed) continue;
				expect(
					() => assertTransition(from, to),
					`should reject ${from} → ${to}`,
				).toThrow();
			}
		}
	});

	it("rejects self-loops", () => {
		for (const state of STATES) {
			expect(() => assertTransition(state, state)).toThrow();
		}
	});

	it("describes the rejected edge in its error", () => {
		expect(() => assertTransition("queued", "running")).toThrow(
			/queued → running/,
		);
	});
});

// ---------------------------------------------------------------------------
// ResolvedProfile + manifest — serializable, owner-neutral, required fields
// ---------------------------------------------------------------------------

const SAMPLE_ACCESS: AgentAccess = "write";

const SAMPLE_PROFILE: ResolvedProfile = {
	name: "worker",
	description: "A worker agent",
	model: "Qwen3.6-35B-A3B-MTP-GGUF",
	thinking: "high",
	tools: ["read", "edit", "grep"],
	access: SAMPLE_ACCESS,
	timeoutSeconds: 900,
	systemPrompt: "You are a worker.",
	source: "bundled",
};

const SAMPLE_MANIFEST: AgentManifest = {
	schema: 1,
	generation: "g1a2b3c4",
	revision: 1,
	parentId: "a7k2",
	agentId: "q9xm",
	parentAgentId: null,
	ownershipTreeId: "q9xm",
	origin: "00000000-0000-0000-0000-000000000000",
	groupId: null,
	description: "worker (do abc)",
	prompt: "do abc xyz",
	profile: SAMPLE_PROFILE,
	state: "queued",
	sequence: 7,
	queuedAt: 1_700_000_000_000,
	startedAt: null,
	heartbeatAt: null,
	finishedAt: null,
	runnerPid: null,
	processStart: "39182",
	tmuxSession: "pi-a7k2",
	tmuxWindow: null,
	timeoutSeconds: 900,
	terminalReason: null,
};

describe("ResolvedProfile snapshot", () => {
	it("round-trips through JSON without losing fields", () => {
		const round = JSON.parse(JSON.stringify(SAMPLE_PROFILE)) as ResolvedProfile;
		expect(round).toEqual(SAMPLE_PROFILE);
	});

	it("contains no non-serializable values", () => {
		expect(JSON.stringify(SAMPLE_PROFILE)).not.toContain("undefined");
	});
});

describe("ProfileContribution", () => {
	it("binds an owner-neutral resolved profile", () => {
		const contribution: ProfileContribution = {
			owner: "research",
			profile: SAMPLE_PROFILE,
		};
		expect(contribution.owner).toBe("research");
		expect(contribution.profile).toEqual(SAMPLE_PROFILE);
		expect(JSON.parse(JSON.stringify(contribution))).toEqual(contribution);
	});
});

describe("AgentManifest required identity fields", () => {
	it("always carries schema, process, and ownership-tree identity", () => {
		const {
			schema,
			generation,
			revision,
			processStart,
			parentId,
			agentId,
			ownershipTreeId,
		} = SAMPLE_MANIFEST;
		expect(schema).toBeTypeOf("number");
		expect(revision).toBeTypeOf("number");
		expect(processStart).toBeTypeOf("string");
		expect(processStart.length).toBeGreaterThan(0);
		expect(parentId).toBeTypeOf("string");
		expect(agentId).toBeTypeOf("string");
		expect(ownershipTreeId).toBe(agentId);
		// generation is a required serializable token present in the record.
		expect(generation).toBeTypeOf("string");
		expect(generation.length).toBeGreaterThan(0);
	});

	it("keeps generation intact across a JSON round-trip", () => {
		const round = JSON.parse(
			JSON.stringify(SAMPLE_MANIFEST),
		) as AgentManifest;
		expect(round).toEqual(SAMPLE_MANIFEST);
		expect(round.generation).toBe(SAMPLE_MANIFEST.generation);
	});
});

// ---------------------------------------------------------------------------
// Downstream contract shapes are present and structurally valid
// ---------------------------------------------------------------------------

const SAMPLE_RESERVATION: ProfileReservation = {
	owner: "research",
	profile: "briefing",
	token: "tok-99zz",
	acquiredAt: 1_700_000_000_000,
};

// A minimal in-memory adapter mirroring the documented idempotent contract.
class TestProfilePolicyAdapter implements ProfilePolicyAdapter {
	private held = new Map<string, ProfileReservation>();
	private settled = new Map<string, ProfileSettlement>();

	async reserve(owner: string, profile: string, agentId: string): Promise<ProfileReservation> {
		const key = `${owner}::${profile}::${agentId}`;
		const existing = this.held.get(key);
		if (existing) return existing; // idempotent: no double count
		const reservation: ProfileReservation = {
			owner,
			profile,
			token: `tok-${owner}-${profile}-${agentId}`,
			acquiredAt: Date.now(),
		};
		this.held.set(key, reservation);
		return reservation;
	}

	async settle(settlement: ProfileSettlement): Promise<void> {
		const key = `${settlement.owner}::${settlement.profile}`;
		if (this.settled.has(key)) return; // idempotent: already applied
		this.settled.set(key, settlement);
	}
}

describe("ProfilePolicyAdapter", () => {
	it("reserve returns durable, JSON-serializable reservation metadata", async () => {
		const adapter = new TestProfilePolicyAdapter();
		const reservation = await adapter.reserve("research", "briefing", "q9xm");
		expect(reservation.owner).toBe("research");
		expect(reservation.profile).toBe("briefing");
		expect(typeof reservation.token).toBe("string");
		expect(reservation.acquiredAt).toBeTypeOf("number");
		expect(JSON.parse(JSON.stringify(reservation))).toEqual(reservation);
	});

	it("reserve is idempotent for the same owner, profile, and agent", async () => {
		const adapter = new TestProfilePolicyAdapter();
		const a = await adapter.reserve("research", "briefing", "q9xm");
		const b = await adapter.reserve("research", "briefing", "q9xm");
		expect(b).toEqual(a);
	});

	it("settle receives generic terminal context and is idempotent", async () => {
		const adapter = new TestProfilePolicyAdapter();
		await adapter.reserve("research", "briefing", "q9xm");
		const settlement: ProfileSettlement = {
			owner: "research",
			profile: "briefing",
			agentId: "q9xm",
			state: "succeeded",
			terminalReason: null,
			reservation: SAMPLE_RESERVATION,
			artifactPath: "/tmp/proj/pi-q9xm/subagents/q9xm",
			result: {
				agentId: "q9xm",
				state: "succeeded",
				output: "done",
				usage: { totalTokens: 1, toolUses: 0, durationMs: 1 },
				finishedAt: 1,
				terminalReason: null,
			},
		};
		await expect(adapter.settle(settlement)).resolves.toBeUndefined();
		// a second settle on the same reservation is a no-op
		await expect(adapter.settle(settlement)).resolves.toBeUndefined();
	});

	it("reserve metadata and settlement are fully JSON-serializable", () => {
		expect(JSON.parse(JSON.stringify(SAMPLE_RESERVATION))).toEqual(
			SAMPLE_RESERVATION,
		);
		const settlement: ProfileSettlement = {
			owner: "research",
			profile: "briefing",
			agentId: "q9xm",
			state: "failed",
			terminalReason: "timed_out",
			reservation: SAMPLE_RESERVATION,
			artifactPath: "/tmp/proj/pi-q9xm/subagents/q9xm",
			result: {
				agentId: "q9xm",
				state: "failed",
				output: "",
				usage: { totalTokens: 0, toolUses: 0, durationMs: 1 },
				finishedAt: 1,
				terminalReason: "timed_out",
			},
		};
		expect(JSON.parse(JSON.stringify(settlement))).toEqual(settlement);
	});

	it("exposes reserve and settle as the async policy contract", () => {
		const adapter: ProfilePolicyAdapter = new TestProfilePolicyAdapter();
		expect(typeof adapter.reserve).toBe("function");
		expect(typeof adapter.settle).toBe("function");
	});
});

describe("downstream contract shapes", () => {
	it("TerminalResult is a plain serializable object", () => {
		const usage: Usage = {
			totalTokens: 12400,
			toolUses: 5,
			durationMs: 4100,
		};
		const result: TerminalResult = {
			agentId: "q9xm",
			state: "succeeded",
			output: "done",
			usage,
			finishedAt: 1_700_000_004_100,
			terminalReason: null,
		};
		expect(JSON.parse(JSON.stringify(result))).toEqual(result);
	});

	it("DeliveryRecord tracks its lifecycle states", () => {
		const delivery: DeliveryRecord = {
			groupId: "g1",
			agentIds: ["q9xm", "4vnr"],
			state: "pending",
			notificationId: "n1",
			createdAt: 1_700_000_000_000,
			dispatchedAt: null,
			consumedAt: null,
		};
		expect(delivery.state).toBe("pending");
		expect(JSON.parse(JSON.stringify(delivery))).toEqual(delivery);
	});

	it("AgentReceipt carries delivery surfaces", () => {
		const receipt: AgentReceipt = {
			agentId: "q9xm",
			state: "queued",
			tmuxSession: "pi-a7k2",
			tmuxWindow: null,
			attachCommand: null,
			artifactDir: "/tmp/proj/pi-a7k2/subagents/q9xm",
		};
		expect(receipt.agentId).toBe("q9xm");
		expect(JSON.parse(JSON.stringify(receipt))).toEqual(receipt);
	});

	it("ResultResponse carries state, optional result, and consumed flag", () => {
		const response: ResultResponse = {
			agentId: "q9xm",
			state: "running",
			result: null,
			activity: "reading",
			elapsedMs: 4000,
			usage: { totalTokens: 10, toolUses: 1, durationMs: 4000 },
			tmuxTarget: "pi-a7k2:subagent-q9xm",
			artifactDir: "/tmp/proj/pi-a7k2/subagents/q9xm",
			consumed: false,
			notFound: false,
		};
		expect(JSON.parse(JSON.stringify(response))).toEqual(response);
	});

	it("StopResponse reports stop outcome", () => {
		const response: StopResponse = {
			agentId: "q9xm",
			state: "cancelled",
			stopped: true,
			message: "queued task cancelled without launch",
		};
		expect(response.stopped).toBe(true);
		expect(JSON.parse(JSON.stringify(response))).toEqual(response);
	});
});

// ---------------------------------------------------------------------------
// Type-level guarantee: AgentRequest carries exactly the four contract fields
// ---------------------------------------------------------------------------

it("AgentRequest is a value type with a boolean background flag", () => {
	const request: AgentRequest = normalizeAgentRequest({
		description: "do abc",
		prompt: "the whole task",
		subagent_type: "worker",
		run_in_background: false,
	});
	expect(request.run_in_background).toBe(false);
	expect(request.subagent_type).toBe("worker");
});
