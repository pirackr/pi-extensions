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

// Hardcoded agent-profile names that must NOT appear as run_subagents agent literals
const BANNED_AGENT_LITERALS = [
	"scout_research",
	"citation_agent",
	"source_auditor",
	"contradiction_resolver",
];

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
	});

	describe("program.v2.md — logical roles only (no hardcoded agent literals)", () => {
		const program = readMd("program.v2.md");

		it("does not use banned agent-profile names as run_subagents agent literals", () => {
			for (const name of BANNED_AGENT_LITERALS) {
				// Match agent: "name" or agent: 'name' patterns (the JS run_subagents examples)
				const literalPattern = new RegExp(`agent:\\s*["']${name}["']`, "i");
				expect(program, `program must not contain agent literal: ${name}`).not.toMatch(literalPattern);
			}
		});

		it("uses logical role names in run_subagents examples", () => {
			// Logical roles that should appear instead
			const logicalRoles = ["planner", "scout", "fetcher", "consolidator", "judge", "citation-agent", "source-auditor", "contradiction-resolver"];
			const foundRoles = new Set<string>();
			for (const role of logicalRoles) {
				const pattern = new RegExp(`agent:\\s*["']${role}["']`, "i");
				if (program.match(pattern)) foundRoles.add(role);
			}
			// At least some logical roles should be present in examples
			expect(foundRoles.size).toBeGreaterThan(0);
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
