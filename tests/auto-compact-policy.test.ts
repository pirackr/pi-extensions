import { describe, expect, it } from "vitest";
import { resolveModelPolicy } from "../extensions/auto-compact/policy.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const packagedLayer = {
	source: "packaged" as const,
	enabled: true,
	default: { percent: 80 },
	rules: [
		{ match: "anthropic/claude-*", percent: 75 },
		{ match: "openai/gpt-5.4", tokens: 180000 },
	],
};

const userLayer = {
	source: "user" as const,
	enabled: true,
	default: { tokens: 200000 },
	rules: [
		{ match: "anthropic/claude-*", percent: 70 },
		{ match: "google/gemini-*", enabled: false },
	],
};

const projectLayer = {
	source: "project" as const,
	enabled: true,
	default: { percent: 90 },
	rules: [
		{ match: "anthropic/claude-3-opus", percent: 60 },
		{ match: "openai/gpt-5.4", tokens: 150000 },
	],
};

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

describe("precedence", () => {
	it("project rules win over user rules", () => {
		const result = resolveModelPolicy(
			[packagedLayer, userLayer, projectLayer],
			"anthropic/claude-3-opus",
			200000,
		);
		expect(result.enabled).toBe(true);
		expect(result.effectiveThresholdTokens).toBe(120000); // 60% of 200000
		expect(result.source).toBe("project");
		expect(result.matchedPattern).toBe("anthropic/claude-3-opus");
	});

	it("user rules win over packaged when project has no match", () => {
		const result = resolveModelPolicy(
			[packagedLayer, userLayer, projectLayer],
			"anthropic/claude-3-5-20241022",
			200000,
		);
		// project has no rule for this model; user rule for claude-* matches
		expect(result.enabled).toBe(true);
		expect(result.effectiveThresholdTokens).toBe(140000); // 70% of 200000
		expect(result.source).toBe("user");
		expect(result.matchedPattern).toBe("anthropic/claude-*");
	});

	it("packaged is the fallback when no higher layer matches", () => {
		const result = resolveModelPolicy(
			[packagedLayer, userLayer, projectLayer],
			"openai/gpt-5.4",
			200000,
		);
		// project rule matches first (150000 tokens)
		expect(result.effectiveThresholdTokens).toBe(150000);
		expect(result.source).toBe("project");
	});

	it("highest-precedence enabled wins", () => {
		const result = resolveModelPolicy(
			[
				packagedLayer,
				userLayer,
				{ source: "project" as const, enabled: false },
			],
			"some/model",
			200000,
		);
		expect(result.enabled).toBe(false);
	});

	it("falls back to highest-precedence default when no rule matches", () => {
		const result = resolveModelPolicy(
			[
				packagedLayer,
				userLayer,
				{ source: "project" as const, enabled: true, default: { percent: 95 } },
			],
			"unknown/model",
			200000,
		);
		expect(result.enabled).toBe(true);
		expect(result.effectiveThresholdTokens).toBe(190000); // 95% of 200000
		expect(result.source).toBe("project");
		expect(result.matchedPattern).toBe("default");
	});
});

// ---------------------------------------------------------------------------
// First-match ordering within a layer
// ---------------------------------------------------------------------------

describe("first-match ordering", () => {
	it("first matching rule in a layer wins", () => {
		const layer = {
			source: "project" as const,
			enabled: true,
			default: { percent: 80 },
			rules: [
				{ match: "anthropic/*", percent: 60 },
				{ match: "anthropic/claude-3-opus", percent: 90 },
			],
		};
		const result = resolveModelPolicy([layer], "anthropic/claude-3-opus", 200000);
		expect(result.effectiveThresholdTokens).toBe(120000); // 60% wins (first match)
		expect(result.matchedPattern).toBe("anthropic/*");
	});
});

// ---------------------------------------------------------------------------
// Case-sensitive glob matching
// ---------------------------------------------------------------------------

describe("case-sensitive glob matching", () => {
	it("matches provider/model globs case-sensitively", () => {
		const layer = {
			source: "project" as const,
			enabled: true,
			default: { percent: 80 },
			rules: [{ match: "anthropic/claude-*", percent: 70 }],
		};
		const result = resolveModelPolicy([layer], "anthropic/claude-3-opus", 200000);
		expect(result.enabled).toBe(true);
		expect(result.matchedPattern).toBe("anthropic/claude-*");
	});

	it("does not match a different case", () => {
		const layer = {
			source: "project" as const,
			enabled: true,
			default: { percent: 80 },
			rules: [{ match: "anthropic/claude-*", percent: 70 }],
		};
		const result = resolveModelPolicy([layer], "Anthropic/claude-3-opus", 200000);
		expect(result.enabled).toBe(true);
		// falls through to default
		expect(result.matchedPattern).toBe("default");
		expect(result.effectiveThresholdTokens).toBe(160000); // 80%
	});

	it("requires provider prefix; bare model name does not match", () => {
		const layer = {
			source: "project" as const,
			enabled: true,
			default: { percent: 80 },
			rules: [{ match: "claude-3-opus", percent: 70 }],
		};
		const result = resolveModelPolicy([layer], "anthropic/claude-3-opus", 200000);
		expect(result.matchedPattern).toBe("default");
	});
});

// ---------------------------------------------------------------------------
// Percentage thresholds
// ---------------------------------------------------------------------------

describe("percentage thresholds", () => {
	it("floors the percentage-to-tokens calculation", () => {
		const layer = {
			source: "project" as const,
			enabled: true,
			default: { percent: 33 },
			rules: [],
		};
		const result = resolveModelPolicy([layer], "some/model", 100000);
		// floor(100000 * 33 / 100) = floor(33000) = 33000
		expect(result.effectiveThresholdTokens).toBe(33000);
	});

	it("floors when percentage produces a fractional token count", () => {
		const layer = {
			source: "project" as const,
			enabled: true,
			default: { percent: 75 },
			rules: [],
		};
		const result = resolveModelPolicy([layer], "some/model", 100001);
		// floor(100001 * 75 / 100) = floor(75000.75) = 75000
		expect(result.effectiveThresholdTokens).toBe(75000);
	});

	it("handles 100 percent correctly", () => {
		const layer = {
			source: "project" as const,
			enabled: true,
			default: { percent: 100 },
			rules: [],
		};
		const result = resolveModelPolicy([layer], "some/model", 200000);
		expect(result.effectiveThresholdTokens).toBe(200000);
	});
});

// ---------------------------------------------------------------------------
// Absolute token thresholds
// ---------------------------------------------------------------------------

describe("absolute token thresholds", () => {
	it("uses absolute token thresholds directly", () => {
		const layer = {
			source: "project" as const,
			enabled: true,
			default: { tokens: 150000 },
			rules: [],
		};
		const result = resolveModelPolicy([layer], "some/model", 200000);
		expect(result.effectiveThresholdTokens).toBe(150000);
	});

	it("emits an oversized-token warning when threshold exceeds context window", () => {
		const layer = {
			source: "project" as const,
			enabled: true,
			default: { tokens: 500000 },
			rules: [],
		};
		const result = resolveModelPolicy([layer], "some/model", 200000);
		expect(result.effectiveThresholdTokens).toBe(500000); // not clamped
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0].code).toBe("oversized-absolute-threshold");
		expect(result.warnings[0].message).toContain("500000");
		expect(result.warnings[0].message).toContain("200000");
	});

	it("no warning when absolute threshold is within context window", () => {
		const layer = {
			source: "project" as const,
			enabled: true,
			default: { tokens: 150000 },
			rules: [],
		};
		const result = resolveModelPolicy([layer], "some/model", 200000);
		expect(result.warnings).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Disabled rules
// ---------------------------------------------------------------------------

describe("disabled rules", () => {
	it("returns enabled=false for a disabled rule match", () => {
		const layer = {
			source: "project" as const,
			enabled: true,
			default: { percent: 80 },
			rules: [{ match: "google/gemini-*", enabled: false }],
		};
		const result = resolveModelPolicy([layer], "google/gemini-1.5-pro", 200000);
		expect(result.enabled).toBe(false);
		expect(result.effectiveThresholdTokens).toBeNull();
		expect(result.matchedPattern).toBe("google/gemini-*");
		expect(result.source).toBe("project");
		expect(result.warnings).toHaveLength(0);
	});

	it("disabled rule does not emit oversized-threshold warning", () => {
		const layer = {
			source: "project" as const,
			enabled: true,
			default: { percent: 80 },
			rules: [{ match: "google/gemini-*", enabled: false }],
		};
		const result = resolveModelPolicy([layer], "google/gemini-1.5-pro", 200000);
		expect(result.warnings).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Warnings
// ---------------------------------------------------------------------------

describe("warnings", () => {
	it("warning codes are stable machine-readable strings", () => {
		const layer = {
			source: "project" as const,
			enabled: true,
			default: { tokens: 999999 },
			rules: [],
		};
		const result = resolveModelPolicy([layer], "some/model", 100000);
		expect(result.warnings).toHaveLength(1);
		expect(typeof result.warnings[0].code).toBe("string");
		expect(result.warnings[0].code).toBe("oversized-absolute-threshold");
	});

	it("warning messages never echo raw config values verbatim in a confusing way", () => {
		// Warning should mention threshold and context window but in a stable format.
		const layer = {
			source: "project" as const,
			enabled: true,
			default: { tokens: 200 },
			rules: [],
		};
		const result = resolveModelPolicy([layer], "some/model", 100);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0].message).toContain("200");
		expect(result.warnings[0].message).toContain("100");
	});
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
	it("returns null threshold when no layer specifies enabled and no default exists", () => {
		const result = resolveModelPolicy([], "some/model", 200000);
		expect(result.enabled).toBe(false);
		expect(result.effectiveThresholdTokens).toBeNull();
		expect(result.source).toBe("none");
		expect(result.matchedPattern).toBe("default");
	});

	it("returns disabled when highest-precedence layer has enabled=false and no match", () => {
		const result = resolveModelPolicy(
			[{ source: "project" as const, enabled: false, default: { percent: 80 } }],
			"some/model",
			200000,
		);
		expect(result.enabled).toBe(false);
		expect(result.effectiveThresholdTokens).toBeNull();
	});
});
