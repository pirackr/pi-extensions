import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Cutover guard: verifies the new extension is the sole subagent runtime
 * and the legacy stack has been removed.
 */

const projectRoot = path.resolve(".");

describe("subagent cutover guard", () => {
	it("new extension entrypoint exists", () => {
		const ext = path.join(projectRoot, "extensions/subagent/index.ts");
		expect(fs.existsSync(ext), `Missing ${ext}`).toBe(true);
	});

	it("new extension config exists", () => {
		const cfg = path.join(projectRoot, "config/subagent.json");
		expect(fs.existsSync(cfg), `Missing ${cfg}`).toBe(true);
	});

	it("legacy tmux-subagent extension is removed", () => {
		const legacy = path.join(projectRoot, "extensions/tmux-subagent");
		expect(
			fs.existsSync(legacy),
			`Legacy directory ${legacy} must be removed`,
		).toBe(false);
	});

	it("legacy subagent-dispatch extension is removed", () => {
		const legacy = path.join(projectRoot, "extensions/subagent-dispatch");
		expect(
			fs.existsSync(legacy),
			`Legacy directory ${legacy} must be removed`,
		).toBe(false);
	});

	it("legacy tmux-subagent config is removed", () => {
		const legacy = path.join(projectRoot, "config/tmux-subagent.json");
		expect(
			fs.existsSync(legacy),
			`Legacy config ${legacy} must be removed`,
		).toBe(false);
	});

	it("legacy subagent-dispatch config is removed", () => {
		const legacy = path.join(projectRoot, "config/subagent-dispatch.json");
		expect(
			fs.existsSync(legacy),
			`Legacy config ${legacy} must be removed`,
		).toBe(false);
	});

	it("legacy tmux-subagent smoke test is removed", () => {
		const legacy = path.join(projectRoot, "tests/tmux-subagent-load.smoke.ts");
		expect(
			fs.existsSync(legacy),
			`Legacy test ${legacy} must be removed`,
		).toBe(false);
	});

	it("new extension exposes Agent, get_subagent_result, stop_subagent tools", () => {
		const ext = path.join(projectRoot, "extensions/subagent/index.ts");
		const content = fs.readFileSync(ext, "utf8");
		expect(content).toMatch(/name:\s*["']Agent["']/);
		expect(content).toMatch(/name:\s*["']get_subagent_result["']/);
		expect(content).toMatch(/name:\s*["']stop_subagent["']/);
	});

	it("legacy tmux-ui-render test is removed", () => {
		const legacy = path.join(projectRoot, "tests/tmux-ui-render.test.ts");
		expect(
			fs.existsSync(legacy),
			`Legacy test ${legacy} must be removed`,
		).toBe(false);
	});

	it("legacy tmux-provider test is removed", () => {
		const legacy = path.join(projectRoot, "tests/tmux-provider.test.ts");
		expect(
			fs.existsSync(legacy),
			`Legacy test ${legacy} must be removed`,
		).toBe(false);
	});

	it("legacy subagent-contract test is removed", () => {
		const legacy = path.join(projectRoot, "tests/subagent-contract.test.ts");
		expect(
			fs.existsSync(legacy),
			`Legacy test ${legacy} must be removed`,
		).toBe(false);
	});

	it("legacy subagent-summary test is removed", () => {
		const legacy = path.join(projectRoot, "tests/subagent-summary.test.ts");
		expect(
			fs.existsSync(legacy),
			`Legacy test ${legacy} must be removed`,
		).toBe(false);
	});

	it("legacy research-legacy-restore test is removed", () => {
		const legacy = path.join(projectRoot, "tests/research-legacy-restore.test.ts");
		expect(
			fs.existsSync(legacy),
			`Legacy test ${legacy} must be removed`,
		).toBe(false);
	});

	it("no production references to run_subagents in new extension", () => {
		const ext = path.join(projectRoot, "extensions/subagent/index.ts");
		const content = fs.readFileSync(ext, "utf8");
		expect(content).not.toMatch(/run_subagents/);
	});

	it("no production references to run_subagents in research integration", () => {
		const files = [
			"extensions/research/subagent.ts",
			"extensions/research/startup.ts",
			"extensions/loop/index.ts",
		];
		for (const file of files) {
			const full = path.join(projectRoot, file);
			if (fs.existsSync(full)) {
				const content = fs.readFileSync(full, "utf8");
				expect(
					content,
					`${file} must not reference run_subagents`,
				).not.toMatch(/run_subagents/);
			}
		}
	});
});
