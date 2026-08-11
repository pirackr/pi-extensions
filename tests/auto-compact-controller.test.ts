import { describe, expect, it, beforeEach } from "vitest";
import { AutoCompactController } from "../extensions/auto-compact/controller.ts";
import type { ResolvedPolicy } from "../extensions/auto-compact/policy.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePolicy(overrides: Partial<ResolvedPolicy> = {}): ResolvedPolicy {
	return {
		source: "packaged",
		matchedPattern: "default",
		enabled: true,
		effectiveThresholdTokens: 80000,
		warnings: [],
		...overrides,
	};
}

function makeSnapshot(overrides: {
	modelKey?: string;
	contextWindow?: number;
	usageTokens?: number | null;
	policy?: ResolvedPolicy;
} = {}): Parameters<
	ReturnType<typeof makeController>["evaluate"]
>[0] {
	return {
		modelKey: "anthropic/claude-3-opus",
		contextWindow: 200000,
		usageTokens: null,
		policy: makePolicy(),
		...overrides,
	};
}

function makeController(): AutoCompactController {
	return new AutoCompactController();
}

// ---------------------------------------------------------------------------
// 1. Initial/resumed evaluation
// ---------------------------------------------------------------------------

describe("initial/resumed evaluation", () => {
	it("arms when usage is below threshold on initial evaluate", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		const result = ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 50000,
			policy,
		});

		expect(result.triggered).toBe(false);
		expect(ctrl.status().armed).toBe(true);
		expect(ctrl.status().inFlight).toBe(false);
	});

	it("triggers immediately on resumed session already above threshold", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		// Simulate resumed session: usage already above threshold
		const result = ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 90000,
			policy,
		});

		expect(result.triggered).toBe(true);
		expect(ctrl.status().armed).toBe(false);
		expect(ctrl.status().inFlight).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 2. Model-change reset
// ---------------------------------------------------------------------------

describe("model-change reset", () => {
	it("clears armed/in-flight state on model change", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 90000,
			policy,
		});
		expect(ctrl.status().inFlight).toBe(true);

		// Switch model — should clear state
		ctrl.resetSession("openai/gpt-4o");
		expect(ctrl.status().armed).toBe(false);
		expect(ctrl.status().inFlight).toBe(false);
		expect(ctrl.status().modelKey).toBe("openai/gpt-4o");
	});

	it("resets lastPolicy and lastError on model change", () => {
		const ctrl = makeController();
		ctrl.resetSession("old/model");
		ctrl.evaluate({
			modelKey: "old/model",
			contextWindow: 100000,
			usageTokens: 50000,
			policy: makePolicy({ matchedPattern: "old/pattern" }),
		});
		ctrl.recordFailure(new Error("oops"));
		expect(ctrl.status().lastError).toBe("oops");

		ctrl.resetSession("new/model");
		expect(ctrl.status().lastPolicy).toBeNull();
		expect(ctrl.status().lastError).toBeNull();
		expect(ctrl.status().modelKey).toBe("new/model");
	});
});

// ---------------------------------------------------------------------------
// 3. Unknown usage skipped
// ---------------------------------------------------------------------------

describe("unknown usage skipped", () => {
	it("skips evaluation when usageTokens is null", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		const result = ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: null,
			policy,
		});

		expect(result.triggered).toBe(false);
		expect(ctrl.status().armed).toBe(false);
	});

	it("skips evaluation when usageTokens is undefined", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		const result = ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: undefined as unknown as number | null,
			policy,
		});

		expect(result.triggered).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 4. >= boundary behavior
// ---------------------------------------------------------------------------

describe(">= boundary behavior", () => {
	it("triggers when usage equals threshold exactly", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		const result = ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 80000,
			policy,
		});

		expect(result.triggered).toBe(true);
		expect(ctrl.status().inFlight).toBe(true);
	});

	it("does not trigger when usage is one below threshold", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		const result = ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 79999,
			policy,
		});

		expect(result.triggered).toBe(false);
		expect(ctrl.status().armed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 5. One-shot threshold crossing
// ---------------------------------------------------------------------------

describe("one-shot threshold crossing", () => {
	it("fires once and does not re-trigger while above threshold", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		const first = ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 80000,
			policy,
		});
		expect(first.triggered).toBe(true);

		// Second evaluate with same/above usage should not fire again
		const second = ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 90000,
			policy,
		});
		expect(second.triggered).toBe(false);
	});

	it("rearms after usage falls below threshold", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		// Fire
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 80000,
			policy,
		});
		expect(ctrl.status().inFlight).toBe(true);

		// Complete and below threshold
		ctrl.recordComplete();
		expect(ctrl.status().armed).toBe(false);

		// Usage below threshold should arm
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 50000,
			policy,
		});
		expect(ctrl.status().armed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 6. In-flight deduplication
// ---------------------------------------------------------------------------

describe("in-flight deduplication", () => {
	it("evaluate returns triggered=false while already in flight", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 80000,
			policy,
		});
		expect(ctrl.status().inFlight).toBe(true);

		const duplicate = ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 90000,
			policy,
		});
		expect(duplicate.triggered).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 7. Rearming below threshold
// ---------------------------------------------------------------------------

describe("rearming below threshold", () => {
	it("arms after seeing usage below threshold when previously disarmed", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		// Start disarmed (reset state)
		expect(ctrl.status().armed).toBe(false);

		// See usage below threshold → should arm
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 50000,
			policy,
		});
		expect(ctrl.status().armed).toBe(true);

		// Stay armed while still below
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 60000,
			policy,
		});
		expect(ctrl.status().armed).toBe(true);
	});

	it("does not arm while above threshold when disarmed", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		// Already above threshold but disarmed (e.g., after a failure)
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 90000,
			policy,
		});
		// Should trigger because we're in disarmed state and above threshold
		expect(ctrl.status().inFlight).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 8. Successful completion leaves disarmed until below-threshold usage
// ---------------------------------------------------------------------------

describe("successful completion", () => {
	it("leaves controller disarmed after successful completion", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 80000,
			policy,
		});
		expect(ctrl.status().inFlight).toBe(true);

		ctrl.recordComplete();
		expect(ctrl.status().inFlight).toBe(false);
		expect(ctrl.status().armed).toBe(false);
	});

	it("does not re-trigger after completion if usage is still above threshold", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 80000,
			policy,
		});
		ctrl.recordComplete();
		expect(ctrl.status().armed).toBe(false);

		// Even though usage is still above threshold, should not re-trigger
		const result = ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 85000,
			policy,
		});
		expect(result.triggered).toBe(false);
		expect(ctrl.status().armed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 9. Failure disarms (no retry loop)
// ---------------------------------------------------------------------------

describe("failure disarms", () => {
	it("clears in-flight and disarms on failure", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 80000,
			policy,
		});
		expect(ctrl.status().inFlight).toBe(true);

		ctrl.recordFailure(new Error("compaction failed"));
		expect(ctrl.status().inFlight).toBe(false);
		expect(ctrl.status().armed).toBe(false);
		expect(ctrl.status().lastError).toBe("compaction failed");
	});

	it("does not immediately re-trigger after failure even if still above threshold", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 80000,
			policy,
		});
		ctrl.recordFailure(new Error("failed"));

		// Still above threshold but disarmed — should not re-trigger immediately
		const result = ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 85000,
			policy,
		});
		expect(result.triggered).toBe(false);
		expect(ctrl.status().armed).toBe(false);
	});

	it("re-arms after failure once usage falls below threshold", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 80000,
			policy,
		});
		ctrl.recordFailure(new Error("failed"));
		expect(ctrl.status().armed).toBe(false);

		// Now usage is below threshold → should arm
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 50000,
			policy,
		});
		expect(ctrl.status().armed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 10. Disabled model rules
// ---------------------------------------------------------------------------

describe("disabled model rules", () => {
	it("evaluate skips disabled rules", () => {
		const ctrl = makeController();
		const policy = makePolicy({
			enabled: false,
			matchedPattern: "google/gemini-*",
			effectiveThresholdTokens: null,
		});

		ctrl.resetSession("google/gemini-1.5-pro");
		const result = ctrl.evaluate({
			modelKey: "google/gemini-1.5-pro",
			contextWindow: 200000,
			usageTokens: 90000,
			policy,
		});

		expect(result.triggered).toBe(false);
		expect(ctrl.status().armed).toBe(false);
	});

	it("gate cancels threshold when matched rule is disabled", () => {
		const ctrl = makeController();
		const policy = makePolicy({
			enabled: false,
			matchedPattern: "google/gemini-*",
			effectiveThresholdTokens: null,
		});

		const allowed = ctrl.gate({
			reason: "threshold",
			tokens: 90000,
			policy,
		});
		expect(allowed).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 11. Global disablement
// ---------------------------------------------------------------------------

describe("global disablement", () => {
	it("evaluate skips when globally disabled", () => {
		const ctrl = makeController();
		const policy = makePolicy({
			enabled: false,
			matchedPattern: "default",
			effectiveThresholdTokens: null,
		});

		ctrl.resetSession("some/model");
		const result = ctrl.evaluate({
			modelKey: "some/model",
			contextWindow: 200000,
			usageTokens: 90000,
			policy,
		});

		expect(result.triggered).toBe(false);
	});

	it("gate allows threshold when globally disabled", () => {
		const ctrl = makeController();
		const policy = makePolicy({
			enabled: false,
			matchedPattern: "default",
			effectiveThresholdTokens: null,
		});

		const allowed = ctrl.gate({
			reason: "threshold",
			tokens: 90000,
			policy,
		});
		expect(allowed).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 12. Manual/overflow pass-through
// ---------------------------------------------------------------------------

describe("manual/overflow pass-through", () => {
	it("manual reason always allows", () => {
		const ctrl = makeController();
		const policy = makePolicy({
			enabled: false,
			matchedPattern: "google/gemini-*",
			effectiveThresholdTokens: null,
		});

		expect(
			ctrl.gate({ reason: "manual", tokens: null, policy }),
		).toBe(true);
	});

	it("overflow reason always allows", () => {
		const ctrl = makeController();
		const policy = makePolicy({
			enabled: false,
			matchedPattern: "google/gemini-*",
			effectiveThresholdTokens: null,
		});

		expect(
			ctrl.gate({ reason: "overflow", tokens: null, policy }),
		).toBe(true);
	});

	it("manual allows even when in flight", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 80000,
			policy,
		});
		expect(ctrl.status().inFlight).toBe(true);

		expect(
			ctrl.gate({ reason: "manual", tokens: null, policy }),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 13. Fail-open when context unresolvable
// ---------------------------------------------------------------------------

describe("fail-open when context unresolvable", () => {
	it("gate allows when policy is null", () => {
		const ctrl = makeController();
		expect(
			ctrl.gate({ reason: "threshold", tokens: 90000, policy: null }),
		).toBe(true);
	});

	it("gate allows when threshold is null", () => {
		const ctrl = makeController();
		const policy = makePolicy({
			effectiveThresholdTokens: null,
		});
		expect(
			ctrl.gate({ reason: "threshold", tokens: 90000, policy }),
		).toBe(true);
	});

	it("evaluate skips when policy is null", () => {
		const ctrl = makeController();
		ctrl.resetSession("some/model");
		const result = ctrl.evaluate({
			modelKey: "some/model",
			contextWindow: 200000,
			usageTokens: 90000,
			policy: null as unknown as ResolvedPolicy,
		});
		expect(result.triggered).toBe(false);
	});

	it("evaluate skips when threshold is null", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: null });
		ctrl.resetSession("some/model");
		const result = ctrl.evaluate({
			modelKey: "some/model",
			contextWindow: 200000,
			usageTokens: 90000,
			policy,
		});
		expect(result.triggered).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Gate: threshold below / at / above
// ---------------------------------------------------------------------------

describe("gate threshold comparison", () => {
	it("cancels threshold when tokens are below effective threshold", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		expect(
			ctrl.gate({ reason: "threshold", tokens: 70000, policy }),
		).toBe(false);
	});

	it("allows threshold when tokens equal effective threshold", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		expect(
			ctrl.gate({ reason: "threshold", tokens: 80000, policy }),
		).toBe(true);
	});

	it("allows threshold when tokens exceed effective threshold", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		expect(
			ctrl.gate({ reason: "threshold", tokens: 90000, policy }),
		).toBe(true);
	});

	it("cancels threshold when already in flight", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });

		ctrl.resetSession("anthropic/claude-3-opus");
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 80000,
			policy,
		});
		expect(ctrl.status().inFlight).toBe(true);

		// Pi also tries to compact — should be cancelled (dedup)
		expect(
			ctrl.gate({ reason: "threshold", tokens: 85000, policy }),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe("status", () => {
	it("returns correct initial state", () => {
		const ctrl = makeController();
		const st = ctrl.status();
		expect(st.armed).toBe(false);
		expect(st.inFlight).toBe(false);
		expect(st.modelKey).toBeNull();
		expect(st.lastPolicy).toBeNull();
		expect(st.lastError).toBeNull();
		expect(st.lastUsageTokens).toBeNull();
	});

	it("tracks model key after reset", () => {
		const ctrl = makeController();
		ctrl.resetSession("anthropic/claude-3-opus");
		expect(ctrl.status().modelKey).toBe("anthropic/claude-3-opus");
	});

	it("tracks last policy and usage after evaluate", () => {
		const ctrl = makeController();
		const policy = makePolicy({ effectiveThresholdTokens: 80000 });
		ctrl.resetSession("anthropic/claude-3-opus");
		ctrl.evaluate({
			modelKey: "anthropic/claude-3-opus",
			contextWindow: 200000,
			usageTokens: 50000,
			policy,
		});
		expect(ctrl.status().lastPolicy).toBe(policy);
		expect(ctrl.status().lastUsageTokens).toBe(50000);
	});
});
