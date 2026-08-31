import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Static tests verifying the subagent documentation names the correct public
 * tools, uses correct defaults, and does not reference legacy vocabulary.
 */

const skillPath = path.resolve("skills/subagent/SKILL.md");
const readmePath = path.resolve("README.md");

describe("subagent skill documentation", () => {
	const content = fs.readFileSync(skillPath, "utf8");

	it("mentions the Agent tool", () => {
		expect(content).toMatch(/\bAgent\b/);
	});

	it("mentions get_subagent_result", () => {
		expect(content).toMatch(/get_subagent_result/);
	});
	it("names general-purpose as the fallback profile", () => {
		expect(content).toMatch(/general-purpose/);
	});


	it("mentions stop_subagent", () => {
		expect(content).toMatch(/stop_subagent/);
	});

	it("states background execution defaults to true", () => {
		expect(content).toMatch(/background.*default.*true|default.*background.*true|run_in_background.*true/i);
	});

	it("mentions parallelism or multiple calls", () => {
		expect(content).toMatch(/parallel|multiple.*call|concurrent/i);
	});

	it("mentions four-character IDs or agent IDs", () => {
		expect(content).toMatch(/four.*character|agent.?id|agentId/i);
	});

	it("mentions config precedence or layers", () => {
		expect(content).toMatch(/config.*precedence|precedence|layer|configur/i);
	});

	it("mentions trusted project gate", () => {
		expect(content).toMatch(/trusted.*project|project.*gate/i);
	});

	it("mentions attach or result retrieval", () => {
		expect(content).toMatch(/attach|result.*retriev|get_subagent_result/i);
	});

	it("mentions foreground nested rule", () => {
		expect(content).toMatch(/foreground.*nested|nested.*foreground|run_in_background.*false/i);
	});

	it("mentions /tmp sensitivity", () => {
		expect(content).toMatch(/\/tmp|tmp.*sensitiv/i);
	});

	it("does not mention run_subagents in active guidance", () => {
		// Allow historical references but not in instruction sections
		const lines = content.split("\n");
		const instructionLines = lines.filter(
			(l) => !l.startsWith("#") && !l.startsWith(">") && l.trim().length > 0,
		);
		const hasRunSubagents = instructionLines.some((l) => l.includes("run_subagents"));
		expect(
			hasRunSubagents,
			"Active guidance must not reference run_subagents",
		).toBe(false);
	});

	it("does not mention maxTasks in active guidance", () => {
		expect(content).not.toMatch(/maxTasks/);
	});

	it("does not mention retainArtifacts in active guidance", () => {
		expect(content).not.toMatch(/retainArtifacts/);
	});
});

describe("README subagent section", () => {
	const content = fs.readFileSync(readmePath, "utf8");

	it("mentions the Agent tool", () => {
		expect(content).toMatch(/\bAgent\b/);
	});

	it("mentions get_subagent_result", () => {
		expect(content).toMatch(/get_subagent_result/);
	});

	it("mentions stop_subagent", () => {
		expect(content).toMatch(/stop_subagent/);
	});

	it("does not reference run_subagents as the primary API", () => {
		// The README should not instruct users to use run_subagents
		const lines = content.split("\n");
		const instructionLines = lines.filter(
			(l) => !l.startsWith("#") && !l.startsWith(">") && l.trim().length > 0,
		);
		const hasRunSubagents = instructionLines.some((l) => l.includes("run_subagents"));
		expect(
			hasRunSubagents,
			"README must not instruct users to use run_subagents",
		).toBe(false);
	});

	it("does not mention retainArtifacts", () => {
		expect(content).not.toMatch(/retainArtifacts/);
	});

	it("mentions background execution default", () => {
		expect(content).toMatch(/background|run_in_background/i);
	});
});
