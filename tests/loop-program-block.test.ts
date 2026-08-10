import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { programBlockFor } from "../extensions/loop/index.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: vi.fn().mockReturnValue("/mock/agent/dir"),
	parseFrontmatter: vi.fn(),
}));

// The loop re-injects the program file every round today, which is the
// biggest fixed context tax on long runs. programBlockFor gates that:
// when the file is unchanged since the last full injection, the coordinator
// gets a short note instead of the whole program re-embedded.

describe("programBlockFor", () => {
	let dir: string;
	let file: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-program-block-"));
		file = path.join(dir, "program.md");
		fs.writeFileSync(file, "# Program v1\nRound 1 instructions.\n");
	});

	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it("embeds the full program on first injection and returns a signature", () => {
		const { block, sig } = programBlockFor(file, undefined, undefined);
		expect(block).toContain("<program>");
		expect(block).toContain("# Program v1");
		expect(sig).toBeTruthy();
	});

	it("embeds the full program when restored state has no signature", () => {
		// injected=true but sig lost (e.g. state from an older session)
		const { block } = programBlockFor(file, true, undefined);
		expect(block).toContain("<program>");
	});

	it("skips re-embedding when the file is unchanged since last injection", () => {
		const first = programBlockFor(file, undefined, undefined);
		const second = programBlockFor(file, true, first.sig ?? undefined);
		expect(second.block).toContain("unchanged since the last round");
		expect(second.block).not.toContain("<program>");
		expect(second.sig).toBe(first.sig);
	});

	it("re-embeds after a human edit (mtime/size change)", () => {
		const first = programBlockFor(file, undefined, undefined);
		fs.writeFileSync(file, "# Program v2\nChanged instructions.\n");
		// bump mtime explicitly so the sig differs even on coarse-granularity fs
		const future = new Date(Date.now() + 60_000);
		fs.utimesSync(file, future, future);
		const second = programBlockFor(file, true, first.sig ?? undefined);
		expect(second.block).toContain("<program>");
		expect(second.block).toContain("# Program v2");
		expect(second.sig).not.toBe(first.sig);
	});

	it("handles a missing program file", () => {
		const { block, sig } = programBlockFor(
			path.join(dir, "nope.md"),
			undefined,
			undefined,
		);
		expect(block).toContain("program file missing");
		expect(sig).toBeNull();
	});
});
