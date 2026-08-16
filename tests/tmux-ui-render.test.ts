import { describe, expect, it } from "vitest";

import {
	ACTIVITY_GLYPH,
	COMPACTION_GLYPH,
	SPINNER_FRAMES,
	TOOL_GLYPH,
	TURN_GLYPH,
	formatElapsed,
	formatTokens,
	statusIcon,
} from "../extensions/tmux-subagent/render.ts";

// ---------------------------------------------------------------------------
// Glyph constants
// ---------------------------------------------------------------------------

describe("glyph constants", () => {
	it("SPINNER_FRAMES has 10 braille dot frames", () => {
		expect(SPINNER_FRAMES).toHaveLength(10);
		expect(SPINNER_FRAMES[2]).toBe("⠹");
	});

	it("TURN_GLYPH", () => {
		expect(TURN_GLYPH).toBe("↻");
	});

	it("TOOL_GLYPH", () => {
		expect(TOOL_GLYPH).toBe("⚙");
	});

	it("ACTIVITY_GLYPH", () => {
		expect(ACTIVITY_GLYPH).toBe("⎿");
	});

	it("COMPACTION_GLYPH", () => {
		expect(COMPACTION_GLYPH).toBe("⇊");
	});
});

// ---------------------------------------------------------------------------
// statusIcon
// ---------------------------------------------------------------------------

describe("statusIcon", () => {
	it("returns ✓ for succeeded", () => {
		expect(statusIcon("succeeded", 0)).toBe("✓");
	});

	it("returns ✗ for failed", () => {
		expect(statusIcon("failed", 0)).toBe("✗");
	});

	it("returns ✗ for timed_out", () => {
		expect(statusIcon("timed_out", 0)).toBe("✗");
	});

	it("returns ■ for cancelled", () => {
		expect(statusIcon("cancelled", 0)).toBe("■");
	});

	it("returns the frame-indexed spinner for starting", () => {
		for (let i = 0; i < SPINNER_FRAMES.length; i++) {
			expect(statusIcon("starting", i)).toBe(SPINNER_FRAMES[i]);
		}
		// Modulo wrap-around
		expect(statusIcon("starting", 10)).toBe(SPINNER_FRAMES[0]);
		expect(statusIcon("starting", 13)).toBe(SPINNER_FRAMES[3]);
	});

	it("returns the frame-indexed spinner for running", () => {
		for (let i = 0; i < SPINNER_FRAMES.length; i++) {
			expect(statusIcon("running", i)).toBe(SPINNER_FRAMES[i]);
		}
	});
});

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
	it("returns '0 tok' for 0", () => {
		expect(formatTokens(0)).toBe("0 tok");
	});

	it("returns '812 tok' for 812", () => {
		expect(formatTokens(812)).toBe("812 tok");
	});

	it("returns '12.4k tok' for 12400", () => {
		expect(formatTokens(12400)).toBe("12.4k tok");
	});

	it("returns '1.2M tok' for 1200000", () => {
		expect(formatTokens(1200000)).toBe("1.2M tok");
	});

	it("returns '1.0k tok' at 1000", () => {
		expect(formatTokens(1000)).toBe("1.0k tok");
	});

	it("returns '999 tok' just below 1k", () => {
		expect(formatTokens(999)).toBe("999 tok");
	});

	it("returns '10.0k tok' at 10000", () => {
		expect(formatTokens(10000)).toBe("10.0k tok");
	});

	it("returns '999.9k tok' just below 1M", () => {
		expect(formatTokens(999900)).toBe("999.9k tok");
	});
});

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

describe("formatElapsed", () => {
	it('returns "" when startedAt is missing', () => {
		expect(formatElapsed()).toBe("");
	});

	it("returns '0ms' for 0 ms", () => {
		const now = Date.now();
		expect(formatElapsed(now, now)).toBe("0ms");
	});

	it("returns '812ms' for 812 ms", () => {
		const start = Date.now();
		const end = start + 812;
		expect(formatElapsed(start, end)).toBe("812ms");
	});

	it("returns '12.3s' for 12300 ms", () => {
		const start = Date.now();
		const end = start + 12300;
		expect(formatElapsed(start, end)).toBe("12.3s");
	});

	it("returns '2m17s' for 137000 ms", () => {
		const start = Date.now();
		const end = start + 137000;
		expect(formatElapsed(start, end)).toBe("2m17s");
	});

	it("returns '2h5m' for 7500000 ms", () => {
		const start = Date.now();
		const end = start + 7500000;
		expect(formatElapsed(start, end)).toBe("2h5m");
	});

	it("returns '1m0s' for 60000 ms — switches to minutes at 60s", () => {
		const start = Date.now();
		const end = start + 60000;
		expect(formatElapsed(start, end)).toBe("1m0s");
	});

	it("returns '1h0m' for 3600000 ms — switches to hours at 3600s", () => {
		const start = Date.now();
		const end = start + 3600000;
		expect(formatElapsed(start, end)).toBe("1h0m");
	});
});
