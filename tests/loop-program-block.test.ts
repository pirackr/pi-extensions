import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
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
// (the loop injects program.md each round; the agent prompts are
// referenced from that document and must conform to the same contract).
describe("research prompt contract", () => {
	const agentsDir = path.resolve("skills/research/agents");
	const programPath = path.resolve("skills/research/program.md");

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
		{
			name: "judge",
			fields: ["version", "runId", "pass", "verdict", "failedChecks", "fixes"],
		},
		{
			name: "citation-agent",
			fields: [
				"version",
				"runId",
				"pass",
				"unsupportedClaims",
				"misattributedClaims",
			],
		},
		{
			name: "source-auditor",
			fields: ["version", "runId", "pass", "unresolvedReplacements"],
		},
		{
			name: "contradiction-resolver",
			fields: ["version", "runId", "pass", "unhandled", "acknowledged"],
		},
	];

	describe("program.md", () => {
		const content = fs.readFileSync(programPath, "utf8");

		it("contains coordinator-summary block reference", () => {
			expect(content).toMatch(/<coordinator-summary>/);
		});

		it("contains artifact block reference", () => {
			expect(content).toMatch(/<artifact>/);
		});

		it('every subagent_type: "..." literal in Agent examples is a registered profile', () => {
			const resolvable = new Set([
				"planner",
				"scout_research",
				"fetcher",
				"consolidator",
				"fragment_writer",
				"worker",
				"judge",
				"citation_agent",
				"source_auditor",
				"contradiction_resolver",
			]);
			const subagentTypePattern = /subagent_type:\s*["']([^"']+)["']/gi;
			const found = new Set<string>();
			let match: RegExpExecArray | null;
			while ((match = subagentTypePattern.exec(content)) !== null) {
				found.add(match[1]);
			}
			for (const name of found) {
				expect(
					resolvable.has(name),
					`subagent_type literal "${name}" is not a registered profile`,
				).toBe(true);
			}
		});

		it("contains the role→profile mapping note", () => {
			expect(content).toContain("scout_research");
			expect(content).toContain("worker");
			expect(content).toContain("citation_agent");
			expect(content).toContain('subagent_type: "consolidator"');
			expect(content).toContain('subagent_type: "fragment_writer"');
		});

		it("does not embed per-agent runtime config (model/tools/access/timeout) adjacent to Agent calls", () => {
			const blockPattern = /```js\s*([\s\S]*?)```/g;
			let block: RegExpExecArray | null;
			while ((block = blockPattern.exec(content)) !== null) {
				const code = block[1];
				if (code.includes("Agent(")) {
					expect(
						code,
						"Agent block must not contain model:",
					).not.toMatch(/\bmodel:\s*/i);
					expect(
						code,
						"Agent block must not contain tools:",
					).not.toMatch(/\btools:\s*/i);
					expect(
						code,
						"Agent block must not contain access:",
					).not.toMatch(/\baccess:\s*/i);
					expect(
						code,
						"Agent block must not contain timeoutSeconds",
					).not.toMatch(/\btimeoutSeconds\b/);
				}
			}
		});

		it("uses foreground Agent calls (run_in_background: false) for research dispatch", () => {
			const blockPattern = /```js\s*([\s\S]*?)```/g;
			let block: RegExpExecArray | null;
			while ((block = blockPattern.exec(content)) !== null) {
				const code = block[1];
				if (code.includes("Agent(") && code.includes("subagent_type:")) {
					expect(
						code,
						"Research Agent calls must use run_in_background: false",
					).toMatch(/run_in_background:\s*false/);
				}
			}
		});

		it("does not use run_subagents in Agent-based dispatch examples", () => {
			const blockPattern = /```js\s*([\s\S]*?)```/g;
			let block: RegExpExecArray | null;
			while ((block = blockPattern.exec(content)) !== null) {
				const code = block[1];
				if (code.includes("Agent(")) {
					expect(
						code,
						"Agent block must not contain run_subagents",
					).not.toMatch(/run_subagents/);
				}
			}
		});

		it("does not use legacy batch fields (tasks, return_mode, retain_artifacts, result_path) in Agent calls", () => {
			const blockPattern = /```js\s*([\s\S]*?)```/g;
			let block: RegExpExecArray | null;
			while ((block = blockPattern.exec(content)) !== null) {
				const code = block[1];
				if (code.includes("Agent(")) {
					expect(code, "Agent block must not contain tasks:").not.toMatch(/\btasks:\s*\[/);
					expect(code, "Agent block must not contain return_mode:").not.toMatch(/\breturn_mode:/);
					expect(code, "Agent block must not contain retain_artifacts:").not.toMatch(/\bretain_artifacts:/);
					expect(code, "Agent block must not contain result_path:").not.toMatch(/\bresult_path:/);
				}
			}
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

			it("is a self-contained task contract (mentions the mission or a placeholder)", () => {
				// Each role prompt must be self-contained — it should reference
				// the mission or have an injection point for it
				expect(
					content.toLowerCase(),
					"Role prompt must reference mission or have injection point",
				).toMatch(/mission|<injected|research mission|\[mission/);
			});
		});
	}

	for (const agent of verificationAgents) {
		describe(`[${agent.name}] verification JSON schema`, () => {
			const content = fs.readFileSync(
				path.join(agentsDir, `${agent.name}.md`),
				"utf8",
			);
			for (const field of agent.fields) {
				it(`references schema field '${field}'`, () => {
					expect(content).toMatch(new RegExp(field, "i"));
				});
			}
		});
	}
});
