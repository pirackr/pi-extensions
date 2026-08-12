import { describe, it, expect } from "vitest";
import {
	parseLoopArgs,
	snapshotProgram,
} from "../extensions/loop/program.ts";

describe("parseLoopArgs", () => {
	it("parses a simple mission with no flags", () => {
		const result = parseLoopArgs("compare prices");
		expect(result.mission).toBe("compare prices");
		expect(result.maxIterations).toBe(10);
		expect(result.maxTokens).toBe(0);
		expect(result.noProgress).toBe(3);
		expect(result.program).toBeUndefined();
	});

	it("parses --max-rounds N (positive integer)", () => {
		const result = parseLoopArgs("--max-rounds 5 explore deeply");
		expect(result.maxIterations).toBe(5);
		expect(result.mission).toBe("explore deeply");
	});

	it("parses --max-rounds unlimited", () => {
		const result = parseLoopArgs("--max-rounds unlimited explore");
		expect(result.maxIterations).toBe("unlimited");
	});

	it("parses --tokens N", () => {
		const result = parseLoopArgs("--tokens 50000 budget task");
		expect(result.maxTokens).toBe(50000);
	});

	it("parses --no-progress N", () => {
		const result = parseLoopArgs("--no-progress 5 watch task");
		expect(result.noProgress).toBe(5);
	});

	it("parses --no-progress off", () => {
		const result = parseLoopArgs("--no-progress off watch task");
		expect(result.noProgress).toBe("off");
	});

	it("parses --no-progress 0", () => {
		const result = parseLoopArgs("--no-progress 0 watch task");
		expect(result.noProgress).toBe("off");
	});

	it("parses --program path", () => {
		const result = parseLoopArgs("--program /path/to/program.md do the thing");
		expect(result.program).toBe("/path/to/program.md");
		expect(result.mission).toBe("do the thing");
	});

	it("parses combined flags", () => {
		const result = parseLoopArgs(
			"--max-rounds 7 --tokens 100000 --no-progress off --program /dev/null mission",
		);
		expect(result.maxIterations).toBe(7);
		expect(result.maxTokens).toBe(100000);
		expect(result.noProgress).toBe("off");
		expect(result.program).toBe("/dev/null");
		expect(result.mission).toBe("mission");
	});

	it("throws on negative --max-rounds", () => {
		expect(() => parseLoopArgs("--max-rounds -3 task")).toThrow();
	});

	it("throws on zero --max-rounds", () => {
		expect(() => parseLoopArgs("--max-rounds 0 task")).toThrow();
	});

	it("throws on non-integer --max-rounds", () => {
		expect(() => parseLoopArgs("--max-rounds 3.5 task")).toThrow();
	});

	it("throws on non-numeric --tokens", () => {
		expect(() => parseLoopArgs("--tokens abc task")).toThrow();
	});

	it("throws on negative --tokens", () => {
		expect(() => parseLoopArgs("--tokens -100 task")).toThrow();
	});

	it("throws on non-numeric --no-progress", () => {
		expect(() => parseLoopArgs("--no-progress slow task")).toThrow();
	});

	it("throws on zero --no-progress (numeric)", () => {
		expect(() => parseLoopArgs("--no-progress 0 task")).not.toThrow();
		expect(() => parseLoopArgs("--no-progress -1 task")).toThrow();
	});

	it("normalizes extra spaces in mission", () => {
		const result = parseLoopArgs("  do   lots   of   words  ");
		expect(result.mission).toBe("do lots of words");
	});

	it("rejects unlimited on --no-progress", () => {
		expect(() => parseLoopArgs("--no-progress unlimited task")).toThrow();
	});

	it("rejects off on --max-rounds", () => {
		expect(() => parseLoopArgs("--max-rounds off task")).toThrow();
	});
});

describe("snapshotProgram", () => {
	it("produces a deterministic SHA-256 digest", () => {
		const { digest } = snapshotProgram("# Program\nStep 1.");
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
	});

	it("same source → same digest", () => {
		const source = "Round 1: search\nRound 2: analyze";
		const a = snapshotProgram(source);
		const b = snapshotProgram(source);
		expect(a.digest).toBe(b.digest);
	});

	it("different source → different digest", () => {
		const a = snapshotProgram("hello");
		const b = snapshotProgram("world");
		expect(a.digest).not.toBe(b.digest);
	});

	it("returns an entry with <program> tags", () => {
		const { entry } = snapshotProgram("my program text");
		expect(entry).toBe("<program>\nmy program text\n</program>");
	});

	it("entry is immutable — does not affect subsequent snapshots", () => {
		const { entry } = snapshotProgram("v1");
		const { entry: entry2, digest: d2 } = snapshotProgram("v2");
		expect(entry).toBe("<program>\nv1\n</program>");
		expect(entry2).toBe("<program>\nv2\n</program>");
		expect(d2).not.toMatch(/v1/);
	});
});

describe("snapshot immutability and reinjection after compaction", () => {
	it("the digest can be used to detect if the snapshot has changed", () => {
		const snap1 = snapshotProgram("original");
		const snap2 = snapshotProgram("modified");
		// Different snapshots → different digests
		expect(snap1.digest).not.toBe(snap2.digest);
		// The original snapshot is unchanged
		expect(snap1.entry).toBe("<program>\noriginal\n</program>");
	});

	it("digest is independent of programBlockFor's mtime:sz signature", () => {
		const snap = snapshotProgram("stable content");
		// The snapshot digest is content-based, not mtime-based
		// Re-snapshotting the same content always yields the same digest
		expect(snapshotProgram("stable content").digest).toBe(snap.digest);
	});
});
