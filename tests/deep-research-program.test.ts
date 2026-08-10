import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve("skills/deep-research");
const PROGRAM_PATH = path.join(REPO_ROOT, "program.v2.md");
const AGENTS_DIR = path.join(REPO_ROOT, "agents");

const AGENT_FILES = [
	"planner.md",
	"scout.md",
	"fetcher.md",
	"judge.md",
	"citation-agent.md",
	"source-auditor.md",
	"contradiction-resolver.md",
];

function readMd(filename: string): string {
	return fs.readFileSync(path.join(REPO_ROOT, filename), "utf8");
}

function readAgent(name: string): string {
	return fs.readFileSync(path.join(AGENTS_DIR, name), "utf8");
}

// Every agent: "..." literal in run_subagents examples must resolve to a
// registered profile. These are the only names the engine will accept.
const RESOLVABLE_AGENT_NAMES = new Set([
	"planner",
	"scout_research",
	"fetcher",
	"worker",
	"judge",
	"citation_agent",
	"source_auditor",
	"contradiction_resolver",
]);

describe("deep-research-program contract", () => {
	describe("program.v2.md — no embedded runtime configuration", () => {
		const program = readMd("program.v2.md");

		it("does not contain profile threshold tables with numeric values", () => {
			// Match lines like "| quick | 10 | 15 | 10 |" etc.
			const profileTable = /\|+\s*(quick|standard|intermediate|deep)\s*\|\s*\d+\s*\|/i;
			expect(program).not.toMatch(profileTable);
		});

		it("does not contain hardcoded budget/dispatch count numbers in prose", () => {
			// Patterns like "MAXIMUM 50 web_lookup", "timeout_seconds: 1800", dispatch
			// counts like "scout ×3", "scout ×8", "32 scouts"
			const budgetPatterns = [
				/HARD MAXIMUM\s*\d+\s*(web_lookup|fetch_web)/i,
				/timeout_seconds:\s*\d+/i,
				/scout\s*[×x]\s*\d+/i,
				/fetch\s*[×x]\s*\d+/i,
				/\d+\s*scouts/i,
				/\d+\s*fetchers/i,
			];
			for (const pat of budgetPatterns) {
				expect(program, `program must not match: ${pat}`).not.toMatch(pat);
			}
		});

		it("does not contain a verification matrix table", () => {
			// Profile → verification mapping table
			const matrixPatterns = [
				/\| Quick \|.*judge/i,
				/\| Intermediate \|.*judge.*citation/i,
				/\| Deep \|.*judge.*citation.*source/i,
			];
			for (const pat of matrixPatterns) {
				expect(program, `program must not contain verification matrix: ${pat}`).not.toMatch(pat);
			}
		});

		it("references active profile config but not literal threshold values", () => {
			// It's OK to reference the config file or "active profile's config";
			// not OK to embed literal thresholds
			const hasConfigRef = program.includes("config/deep-research.json") || program.includes("active profile's config");
			expect(hasConfigRef).toBe(true);
		});

		it("does not embed per-agent runtime config (model/tools/access/timeout) adjacent to dispatches", () => {
			// Within run_subagents code blocks, no per-agent runtime config fields
			// are allowed — those belong in config/deep-research.json
			const blockPattern = /```js\s*([\s\S]*?)```/g;
			let block: RegExpExecArray | null;
			while ((block = blockPattern.exec(program)) !== null) {
				const code = block[1];
				if (code.includes("run_subagents")) {
					expect(code, "run_subagents block must not contain model:").not.toMatch(/\bmodel:\s*/i);
					expect(code, "run_subagents block must not contain tools:").not.toMatch(/\btools:\s*/i);
					expect(code, "run_subagents block must not contain access:").not.toMatch(/\baccess:\s*/i);
					expect(code, "run_subagents block must not contain timeoutSeconds").not.toMatch(/\btimeoutSeconds\b/);
				}
			}
		});
	});

	describe("program.v2.md — dispatch names resolve to registered profiles", () => {
		const program = readMd("program.v2.md");

		it("every agent: \"...\" literal in run_subagents examples is a registered profile", () => {
			// Parse every agent: "..." literal in JS run_subagents examples
			const agentLiteralPattern = /agent:\s*["']([^"']+)["']/gi;
			const found = new Set<string>();
			let match: RegExpExecArray | null;
			while ((match = agentLiteralPattern.exec(program)) !== null) {
				found.add(match[1]);
			}
			for (const name of found) {
				expect(
					RESOLVABLE_AGENT_NAMES.has(name),
					`agent literal "${name}" is not a registered profile (allowed: ${[...RESOLVABLE_AGENT_NAMES].join(", ")})`,
				).toBe(true);
			}
		});

		it("contains the role→profile mapping note", () => {
			// The mapping note must exist and reference at least the key profile names
			expect(program).toContain("scout_research");
			expect(program).toContain("worker");
			expect(program).toContain("citation_agent");
		});
	});

	describe("program.v2.md — single-task run_subagents examples", () => {
		const program = readMd("program.v2.md");

		it("contains no multi-task arrays in run_subagents examples", () => {
			// Multi-task would look like tasks: [\n    { ... },\n    { ... }\n  ]
			// with at least 2 object literals inside tasks:
			const multiTaskPattern = /tasks:\s*\[\s*\{[\s\S]*?\},\s*\{/i;
			expect(program).not.toMatch(multiTaskPattern);
		});
	});

	describe("program.v2.md — valid org heading markers in report structure", () => {
		const program = readMd("program.v2.md");

		it("contains valid org heading markers (*, **, ***) in report structure guidance", () => {
			// The report structure section should use *, **, *** as heading markers
			expect(program).toMatch(/\*\*\*\s/);
		});

		it("does not contain invalid heading level prose (level-4, level-5, etc.)", () => {
			const invalidLevel = /level-\d+\s+heading/i;
			expect(program).not.toMatch(invalidLevel);
		});

		it("uses [[URL][description]] inline citation format, not [n] numbered citations", () => {
			// Inline org citations present
			expect(program).toMatch(/\[\[URL\]\[description\]\]/);
			// Numbered citation guidance absent
			const numberedCitation = /\[\s*\d+\s*\]/;
			expect(program).not.toMatch(numberedCitation);
		});
	});

	describe("program.v2.md — coordinator-summary and artifact-block instructions", () => {
		const program = readMd("program.v2.md");

		it("instructs returning the coordinator-summary block", () => {
			expect(program).toMatch(/<coordinator-summary>/);
		});

		it("instructs returning the artifact block for durable outputs", () => {
			expect(program).toMatch(/<artifact>/);
		});
	});
});

describe("agent prompt contract — coordinator-summary", () => {
	const agents = AGENT_FILES.map((f) => ({
		name: f.replace(".md", ""),
		content: readAgent(f),
	}));

	for (const agent of agents) {
		it(`[${agent.name}] contains coordinator-summary block instructions`, () => {
			expect(agent.content, `${agent.name} must contain coordinator-summary block`).toMatch(/<coordinator-summary>/);
		});
	}
});

describe("agent prompt contract — artifact block", () => {
	// All 7 agents produce durable artifacts
	const artifactAgents = AGENT_FILES.map((f) => f.replace(".md", ""));

	for (const name of artifactAgents) {
		const content = readAgent(`${name}.md`);
		it(`[${name}] contains artifact block instructions`, () => {
			expect(content, `${name} must contain artifact block instructions`).toMatch(/<artifact>/);
		});
	}
});

describe("agent prompt contract — verification JSON schemas", () => {
	// Verification agents must reference the exact schema field names from verification.ts
	const verificationAgents = [
		{ name: "judge", fields: ["version", "runId", "pass", "verdict", "failedChecks", "fixes"] },
		{ name: "citation-agent", fields: ["version", "runId", "pass", "unsupportedClaims", "misattributedClaims"] },
		{ name: "source-auditor", fields: ["version", "runId", "pass", "unresolvedReplacements"] },
		{ name: "contradiction-resolver", fields: ["version", "runId", "pass", "unhandled", "acknowledged"] },
	];

	for (const agent of verificationAgents) {
		const content = readAgent(`${agent.name}.md`);
		for (const field of agent.fields) {
			it(`[${agent.name}] references schema field '${field}' in artifact instructions`, () => {
				expect(content, `${agent.name} must reference field: ${field}`).toMatch(new RegExp(field, "i"));
			});
		}
	}
});

describe("agent prompt contract — inline org citations", () => {
	const reportWriters = ["planner", "scout", "fetcher", "judge"];

	for (const name of reportWriters) {
		const content = readAgent(`${name}.md`);
		it(`[${name}] instructs inline [[URL][description]] org citations`, () => {
			expect(content).toMatch(/\[\[URL\]\[description\]\]/);
		});
		it(`[${name}] does not instruct [n] numbered citations`, () => {
			expect(content).not.toMatch(/\[\s*\d+\s*\]/);
		});
	}
});
