import { describe, it, expect } from "vitest";
import {
	shortenPath,
	slugifyTopic,
	topicFromFirstPrompt,
	buildWindowName,
	planGrid,
	paneGridPosition,
	type GridPlan,
} from "../tmux.ts";

const HOME = "/home/user";

describe("shortenPath", () => {
	it("makes paths below home home-relative", () => {
		expect(shortenPath("/home/user/Working/grinder/pi-extensions", HOME)).toBe(
			"w/g/pi-extensions",
		);
	});

	it("shortens ancestor segments to their first lowercase alphanumeric character", () => {
		expect(shortenPath("/home/user/Projects/My-Proj", HOME)).toBe("p/my-proj");
	});

	it("keeps a single segment below home readable", () => {
		expect(shortenPath("/home/user/project", HOME)).toBe("project");
	});

	it("returns empty for the home directory itself", () => {
		expect(shortenPath(HOME, HOME)).toBe("");
	});

	it("shortens paths outside home the same way", () => {
		expect(shortenPath("/mnt/data/Projects/Alpha", HOME)).toBe("m/d/p/alpha");
	});

	it("normalizes trailing slashes and redundant segments", () => {
		expect(shortenPath("/home/user/Working//grinder/pi-extensions/", HOME)).toBe(
			"w/g/pi-extensions",
		);
	});

	it("produces only lowercase alphanumerics, hyphens, and slashes", () => {
		const result = shortenPath(
			"/home/user/Work Space/.hidden/Über-Project",
			HOME,
		);
		expect(result).toMatch(/^[a-z0-9/-]+$/);
		expect(result).not.toContain(" ");
	});
});

describe("slugifyTopic", () => {
	it("lowercases the topic", () => {
		expect(slugifyTopic("Observability")).toBe("observability");
	});

	it("normalizes punctuation into hyphens", () => {
		expect(slugifyTopic("Fix auth bug!! (urgent)")).toBe("fix-auth-bug-urgent");
	});

	it("collapses runs of punctuation", () => {
		expect(slugifyTopic("API  Gateway   v2")).toBe("api-gateway-v2");
	});

	it("drops leading and trailing hyphens", () => {
		expect(slugifyTopic("--hello world--")).toBe("hello-world");
	});

	it("strips non-ASCII and emoji", () => {
		expect(slugifyTopic("Pi 日本語 テスト")).toBe("pi");
		expect(slugifyTopic("🚀 launch")).toBe("launch");
	});

	it("returns empty string for non-alphanumeric-only input", () => {
		expect(slugifyTopic("日本語テスト")).toBe("");
		expect(slugifyTopic("!!!")).toBe("");
	});

	it("bounds the length and never ends with a hyphen", () => {
		const result = slugifyTopic("a-very-long-topic-that-exceeds-the-limit", 20);
		expect(result.length).toBeLessThanOrEqual(20);
		expect(result).not.toMatch(/-$/);
	});
});

describe("topicFromFirstPrompt", () => {
	it("slugs the first line of the prompt", () => {
		expect(topicFromFirstPrompt("Fix the auth bug in the gateway\nmore text")).toBe(
			"fix-the-auth-bug-in-the-gateway",
		);
	});

	it("falls back to a later part when the first line is blank", () => {
		expect(topicFromFirstPrompt("\n\nReview the API design")).toBe(
			"review-the-api-design",
		);
	});

	it("returns undefined when the prompt has no usable text", () => {
		expect(topicFromFirstPrompt("   \n日本語テスト\n")).toBeUndefined();
	});

	it("is deterministic for the same prompt", () => {
		const a = topicFromFirstPrompt("Design the layout engine");
		const b = topicFromFirstPrompt("Design the layout engine");
		expect(a).toBe(b);
	});
});

describe("buildWindowName", () => {
	it("combines shortened path with explicit session name", () => {
		expect(
			buildWindowName("/home/user/Working/grinder/pi-extensions", {
				homedir: HOME,
				topic: "Observability",
			}),
		).toBe("w/g/pi-extensions-observability");
	});

	it("derives the topic from the first user prompt when no name exists", () => {
		expect(
			buildWindowName("/home/user/Working/grinder/pi-extensions", {
				homedir: HOME,
				firstPrompt: "Fix auth bug!!",
			}),
		).toBe("w/g/pi-extensions-fix-auth-bug");
	});

	it("prefers the explicit name over the first prompt", () => {
		expect(
			buildWindowName("/home/user/Working/grinder/pi-extensions", {
				homedir: HOME,
				topic: "Explicit",
				firstPrompt: "first prompt topic",
			}),
		).toBe("w/g/pi-extensions-explicit");
	});

	it("falls back to the bare shortened path when unnamed", () => {
		expect(
			buildWindowName("/home/user/Working/grinder/pi-extensions", {
				homedir: HOME,
			}),
		).toBe("w/g/pi-extensions");
	});

	it("falls back to a generic name for an empty path and no topic", () => {
		expect(buildWindowName(HOME, { homedir: HOME })).toBe("session");
	});

	it("uses the topic alone when the path shortens to nothing", () => {
		expect(buildWindowName(HOME, { homedir: HOME, topic: "Core" })).toBe(
			"core",
		);
	});

	it("caps the full name and truncates the topic before the path", () => {
		const name = buildWindowName("/home/user/Working/grinder/pi-extensions", {
			homedir: HOME,
			topic: "x".repeat(200),
			maxNameLength: 30,
		});
		expect(name.length).toBeLessThanOrEqual(30);
		expect(name.startsWith("w/g/pi-extensions-")).toBe(true);
	});

	it("produces tmux-safe names without colons or control characters", () => {
		const name = buildWindowName("/home/user/Working/grinder/pi-extensions", {
			homedir: HOME,
			topic: "weird: name\twith\nchars!",
		});
		expect(name).not.toMatch(/[:[:cntrl:]]/);
	});
});

describe("planGrid", () => {
	function expectBalanced(plan: GridPlan, n: number) {
		expect(plan.rowsPerColumn.reduce((a, b) => a + b, 0)).toBe(n);
		const min = Math.min(...plan.rowsPerColumn);
		const max = Math.max(...plan.rowsPerColumn);
		expect(max - min).toBeLessThanOrEqual(1);
	}

	it("plans one pane as a single column", () => {
		expect(planGrid(1)).toEqual({ columns: 1, rowsPerColumn: [1] });
	});

	it("places two panes side by side", () => {
		expect(planGrid(2)).toEqual({ columns: 2, rowsPerColumn: [1, 1] });
	});

	it("places three panes as a two-row first column plus one-pane second column", () => {
		expect(planGrid(3)).toEqual({ columns: 2, rowsPerColumn: [2, 1] });
	});

	it("places four panes as a two-by-two grid", () => {
		expect(planGrid(4)).toEqual({ columns: 2, rowsPerColumn: [2, 2] });
	});

	it("places five panes as three columns with a short last column", () => {
		expect(planGrid(5)).toEqual({ columns: 3, rowsPerColumn: [2, 2, 1] });
	});

	it("keeps every count from one through sixteen balanced", () => {
		for (let n = 1; n <= 16; n++) {
			const plan = planGrid(n);
			expect(plan.columns).toBe(Math.ceil(Math.sqrt(n)));
			expect(plan.rowsPerColumn).toHaveLength(plan.columns);
			expectBalanced(plan, n);
		}
	});

	it("keeps creation order top-to-bottom then left-to-right", () => {
		// Six panes: 3 columns x 2 rows. Pane 0 and 1 are the first column.
		expect(paneGridPosition(6, 0)).toEqual({ column: 0, row: 0 });
		expect(paneGridPosition(6, 1)).toEqual({ column: 0, row: 1 });
		expect(paneGridPosition(6, 2)).toEqual({ column: 1, row: 0 });
		expect(paneGridPosition(6, 5)).toEqual({ column: 2, row: 1 });
		// Three panes: pane 1 is below pane 0 in the first column.
		expect(paneGridPosition(3, 1)).toEqual({ column: 0, row: 1 });
		expect(paneGridPosition(3, 2)).toEqual({ column: 1, row: 0 });
	});
});
