import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";

// Mock node:fs before importing config
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		default: {
			...actual,
			readFileSync: vi.fn(),
		},
		readFileSync: vi.fn(),
	};
});

// Mock the pi-coding-agent module before importing config
vi.mock("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".pi",
}));

import * as fsReal from "node:fs";
import {
	loadAutoCompactConfiguration,
	type LoadConfigurationOptions,
} from "../extensions/auto-compact/config.ts";

const mockReadFileSync = vi.mocked(fsReal.readFileSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function baseOptions(): LoadConfigurationOptions {
	return {
		packageRoot: "/mock/package",
		agentDir: "/mock/agent",
		cwd: "/mock/project",
		projectTrusted: true,
	};
}

function mockFileContents(contents: Record<string, string>): void {
	mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
		const p = typeof path === "string" ? path : String(path);
		if (p in contents) {
			return contents[p];
		}
		const err = new Error(`ENOENT: no such file or directory, open '${p}'`) as NodeJS.ErrnoException;
		err.code = "ENOENT";
		throw err;
	});
}

// ---------------------------------------------------------------------------
// Packaged default
// ---------------------------------------------------------------------------

describe("packaged default", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
	});

	it("loads exact 80% packaged default", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(1);
		expect(result.layers[0].source).toBe("packaged");
		expect(result.layers[0].enabled).toBe(true);
		expect(result.layers[0].default).toEqual({ percent: 80 });
		expect(result.layers[0].rules).toEqual([]);
		expect(result.loadedPaths).toHaveLength(1);
		expect(result.loadedPaths[0]).toBe("/mock/package/config/auto-compact.json");
		expect(result.ignoredPaths).toHaveLength(0);
		expect(result.warnings).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Partial user/project files
// ---------------------------------------------------------------------------

describe("partial user and project files", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
	});

	it("applies user default override over packaged", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				default: { percent: 70 },
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(2);
		expect(result.layers[0].source).toBe("packaged");
		expect(result.layers[1].source).toBe("user");
		expect(result.layers[1].default).toEqual({ percent: 70 });
	});

	it("applies project default override over user", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				default: { percent: 70 },
			}),
			"/mock/project/.pi/auto-compact.json": JSON.stringify({
				default: { percent: 90 },
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(3);
		expect(result.layers[2].source).toBe("project");
		expect(result.layers[2].default).toEqual({ percent: 90 });
	});

	it("searches project rules before user rules", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				rules: [{ match: "user/model", percent: 50 }],
			}),
			"/mock/project/.pi/auto-compact.json": JSON.stringify({
				rules: [{ match: "user/model", percent: 30 }],
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(3);
		expect(result.layers[2].rules).toEqual([
			{ match: "user/model", percent: 30 },
		]);
		expect(result.layers[1].rules).toEqual([
			{ match: "user/model", percent: 50 },
		]);
	});

	it("preserves first-match order within a layer", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [
					{ match: "anthropic/*", percent: 60 },
					{ match: "anthropic/claude-3-opus", percent: 90 },
				],
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(1);
		expect(result.layers[0].rules).toEqual([
			{ match: "anthropic/*", percent: 60 },
			{ match: "anthropic/claude-3-opus", percent: 90 },
		]);
	});
});

// ---------------------------------------------------------------------------
// Strict unknown-field rejection
// ---------------------------------------------------------------------------

describe("strict unknown-field rejection", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
	});

	it("rejects unknown top-level fields in user config", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				enabled: true,
				default: { percent: 70 },
				rules: [],
				unknownField: true,
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(1);
		expect(result.layers[0].source).toBe("packaged");
		expect(result.ignoredPaths).toHaveLength(1);
		expect(result.ignoredPaths[0].path).toBe("/mock/agent/auto-compact/config.json");
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0].code).toBe("invalid-unknown-field");
	});

	it("rejects unknown rule fields", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				rules: [{ match: "foo/bar", percent: 50, unknownRuleField: 123 }],
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(1);
		expect(result.ignoredPaths).toHaveLength(1);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0].code).toBe("invalid-unknown-field");
	});
});

// ---------------------------------------------------------------------------
// Threshold exclusivity
// ---------------------------------------------------------------------------

describe("threshold exclusivity", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
	});

	it("rejects enabled rules with both percent and tokens", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				rules: [{ match: "foo/bar", percent: 50, tokens: 100000 }],
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(1);
		expect(result.ignoredPaths).toHaveLength(1);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0].code).toBe("invalid-threshold");
	});

	it("rejects enabled rules with neither percent nor tokens", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				rules: [{ match: "foo/bar" }],
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(1);
		expect(result.ignoredPaths).toHaveLength(1);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0].code).toBe("invalid-threshold");
	});

	it("rejects default with both percent and tokens", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				default: { percent: 70, tokens: 100000 },
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(1);
		expect(result.ignoredPaths).toHaveLength(1);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0].code).toBe("invalid-threshold");
	});
});

// ---------------------------------------------------------------------------
// Disabled-rule validation
// ---------------------------------------------------------------------------

describe("disabled-rule validation", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
	});

	it("accepts disabled rules without thresholds", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				rules: [{ match: "foo/bar", enabled: false }],
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(2);
		expect(result.layers[1].source).toBe("user");
		expect(result.layers[1].rules).toEqual([
			{ match: "foo/bar", enabled: false },
		]);
		expect(result.warnings).toHaveLength(0);
	});

	it("rejects disabled rules with percent", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				rules: [{ match: "foo/bar", enabled: false, percent: 50 }],
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(1);
		expect(result.ignoredPaths).toHaveLength(1);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0].code).toBe("invalid-threshold");
	});

	it("rejects disabled rules with tokens", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				rules: [{ match: "foo/bar", enabled: false, tokens: 100000 }],
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(1);
		expect(result.ignoredPaths).toHaveLength(1);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0].code).toBe("invalid-threshold");
	});
});

// ---------------------------------------------------------------------------
// Invalid-layer fallback
// ---------------------------------------------------------------------------

describe("invalid-layer fallback", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
	});

	it("ignores invalid user layer and keeps packaged", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				enabled: "not-a-boolean",
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(1);
		expect(result.layers[0].source).toBe("packaged");
		expect(result.loadedPaths).toHaveLength(1);
		expect(result.ignoredPaths).toHaveLength(1);
		expect(result.ignoredPaths[0].path).toBe("/mock/agent/auto-compact/config.json");
		expect(result.warnings).toHaveLength(1);
	});

	it("ignores invalid project layer and keeps user and packaged", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				default: { percent: 70 },
			}),
			"/mock/project/.pi/auto-compact.json": JSON.stringify({
				enabled: "not-a-boolean",
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.layers).toHaveLength(2);
		expect(result.layers[0].source).toBe("packaged");
		expect(result.layers[1].source).toBe("user");
		expect(result.loadedPaths).toHaveLength(2);
		expect(result.ignoredPaths).toHaveLength(1);
		expect(result.ignoredPaths[0].path).toBe("/mock/project/.pi/auto-compact.json");
	});

	it("throws for invalid packaged layer", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: "not-a-boolean",
			}),
		});

		expect(() => loadAutoCompactConfiguration(baseOptions())).toThrow(
			"Packaged auto-compaction configuration is invalid",
		);
	});

	it("throws for unparseable packaged JSON", () => {
		mockReadFileSync.mockReturnValue("not valid json {{{");

		expect(() => loadAutoCompactConfiguration(baseOptions())).toThrow(
			"Cannot load packaged auto-compaction configuration",
		);
	});

	it("throws for missing packaged file", () => {
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		expect(() => loadAutoCompactConfiguration(baseOptions())).toThrow(
			"Cannot load packaged auto-compaction configuration",
		);
	});
});

// ---------------------------------------------------------------------------
// Warning redaction
// ---------------------------------------------------------------------------

describe("warning redaction", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
	});

	it("warnings name the file and field but never the offending value", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				badField: "super-secret-value-12345",
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0].code).toBe("invalid-unknown-field");
		expect(result.warnings[0].message).toContain("badField");
		expect(result.warnings[0].message).toContain("config.json");
		expect(result.warnings[0].message).not.toContain("super-secret-value-12345");
	});

	it("warnings for invalid threshold name the file and field", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				default: { percent: -1 },
			}),
		});

		const result = loadAutoCompactConfiguration(baseOptions());

		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0].code).toBe("invalid-threshold");
		expect(result.warnings[0].message).toContain("config.json");
		expect(result.warnings[0].message).toContain("default");
		expect(result.warnings[0].message).not.toContain("-1");
	});
});

// ---------------------------------------------------------------------------
// Untrusted project exclusion
// ---------------------------------------------------------------------------

describe("untrusted project exclusion", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
	});

	it("ignores project configuration when not trusted", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/project/.pi/auto-compact.json": JSON.stringify({
				default: { percent: 90 },
			}),
		});

		const result = loadAutoCompactConfiguration({
			...baseOptions(),
			projectTrusted: false,
		});

		expect(result.layers).toHaveLength(1);
		expect(result.layers[0].source).toBe("packaged");
		expect(result.ignoredPaths).toHaveLength(1);
		expect(result.ignoredPaths[0].reason).toBe("project not trusted");
		expect(result.ignoredPaths[0].path).toBe("/mock/project/.pi/auto-compact.json");
		expect(result.warnings).toHaveLength(0);
	});

	it("still loads user config when project is untrusted", () => {
		mockFileContents({
			"/mock/package/config/auto-compact.json": JSON.stringify({
				enabled: true,
				default: { percent: 80 },
				rules: [],
			}),
			"/mock/agent/auto-compact/config.json": JSON.stringify({
				default: { percent: 70 },
			}),
			"/mock/project/.pi/auto-compact.json": JSON.stringify({
				default: { percent: 90 },
			}),
		});

		const result = loadAutoCompactConfiguration({
			...baseOptions(),
			projectTrusted: false,
		});

		expect(result.layers).toHaveLength(2);
		expect(result.layers[0].source).toBe("packaged");
		expect(result.layers[1].source).toBe("user");
		expect(result.layers[1].default).toEqual({ percent: 70 });
	});
});
