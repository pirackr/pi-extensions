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

// Prompt-discovery tests: verify agent prompt files contain the required
// coordinator-summary, artifact, and verification-JSON instructions.
// These live here because they exercise the same program-block loader path
// (the loop injects program.v2.md each round; the agent prompts are
// referenced from that document and must conform to the same contract).
describe("deep-research prompt contract", () => {
	const agentsDir = path.resolve("skills/deep-research/agents");
	const programPath = path.resolve("skills/deep-research/program.v2.md");

	const agentFiles = [
		"planner.md",
		"scout.md",
		"fetcher.md",
		"judge.md",
		"citation-agent.md",
		"source-auditor.md",
		"contradiction-resolver.md",
	];

	const verificationAgents = [
		{ name: "judge", fields: ["version", "runId", "pass", "verdict", "failedChecks", "fixes"] },
		{ name: "citation-agent", fields: ["version", "runId", "pass", "unsupportedClaims", "misattributedClaims"] },
		{ name: "source-auditor", fields: ["version", "runId", "pass", "unresolvedReplacements"] },
		{ name: "contradiction-resolver", fields: ["version", "runId", "pass", "unhandled", "acknowledged"] },
	];

	describe("program.v2.md", () => {
		const content = fs.readFileSync(programPath, "utf8");

		it("contains coordinator-summary block reference", () => {
			expect(content).toMatch(/<coordinator-summary>/);
		});

		it("contains artifact block reference", () => {
			expect(content).toMatch(/<artifact>/);
		});

		it("uses logical role names in run_subagents examples", () => {
			const logicalRoles = ["planner", "scout", "fetcher", "consolidator", "judge", "citation-agent", "source-auditor", "contradiction-resolver"];
			const found = new Set<string>();
			for (const role of logicalRoles) {
				if (content.match(new RegExp(`agent:\\s*["']${role}["']`, "i"))) found.add(role);
			}
			expect(found.size).toBeGreaterThan(0);
		});

		it("does not contain banned agent-profile literals as run_subagents agents", () => {
			const banned = ["scout_research", "citation_agent", "source_auditor", "contradiction_resolver"];
			for (const name of banned) {
				const pat = new RegExp(`agent:\\s*["']${name}["']`, "i");
				expect(content, `must not contain agent literal: ${name}`).not.toMatch(pat);
			}
		});

		it("does not contain multi-task run_subagents arrays", () => {
			const multiTask = /tasks:\s*\[\s*\{[\s\S]*?\},\s*\{/i;
			expect(content).not.toMatch(multiTask);
		});

		it("contains valid org heading markers", () => {
			expect(content).toMatch(/\*\*\*\s/);
		});

		it("does not contain invalid heading level prose", () => {
			expect(content).not.toMatch(/level-\d+\s+heading/i);
		});

		it("uses inline [[URL][description]] citations", () => {
			expect(content).toMatch(/\[\[URL\]\[description\]\]/);
		});

		it("does not use numbered citation guidance", () => {
			expect(content).not.toMatch(/\[\s*\d+\s*\]/);
		});
	});

	for (const file of agentFiles) {
		describe(`[${file.replace(".md", "")}]`, () => {
			const content = fs.readFileSync(path.join(agentsDir, file), "utf8");

			it("contains coordinator-summary block instructions", () => {
				expect(content).toMatch(/<coordinator-summary>/);
			});

			it("contains artifact block instructions", () => {
				expect(content).toMatch(/<artifact>/);
			});
		});
	}

	for (const agent of verificationAgents) {
		describe(`[${agent.name}] verification JSON schema`, () => {
			const content = fs.readFileSync(path.join(agentsDir, `${agent.name}.md`), "utf8");
			for (const field of agent.fields) {
				it(`references schema field '${field}'`, () => {
					expect(content).toMatch(new RegExp(field, "i"));
				});
			}
		});
	}
});
