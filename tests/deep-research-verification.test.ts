import { describe, it, expect } from "vitest";
import { parseScoreTable } from "../extensions/deep-research/verification.ts";

describe("parseScoreTable", () => {
	const validHeader = "| ID | Question | Score | Notes |";
	const validSep = "| --- | --- | ---: | --- |";

	function makeTable(rows: Array<{ id: string; score: number }>): string {
		const body = rows
			.map((r) => `| ${r.id} | some question | ${r.score} | some notes |`)
			.join("\n");
		return `${validHeader}\n${validSep}\n${body}`;
	}

	it("accepts exactly 5 rows", () => {
		const result = parseScoreTable(
			makeTable([
				{ id: "q1", score: 80 },
				{ id: "q2", score: 85 },
				{ id: "q3", score: 90 },
				{ id: "q4", score: 75 },
				{ id: "q5", score: 80 },
			]),
		);
		expect(result.ids).toEqual(["q1", "q2", "q3", "q4", "q5"]);
		expect(result.scores).toEqual([80, 85, 90, 75, 80]);
		expect(result.rows).toHaveLength(5);
	});

	it("accepts 8 rows", () => {
		const rows = Array.from({ length: 8 }, (_, i) => ({
			id: `q${i + 1}`,
			score: 80,
		}));
		const result = parseScoreTable(makeTable(rows));
		expect(result.ids).toHaveLength(8);
		expect(result.rows).toHaveLength(8);
	});

	it("accepts scores 0 and 100", () => {
		const result = parseScoreTable(
			makeTable([
				{ id: "q1", score: 0 },
				{ id: "q2", score: 100 },
				{ id: "q3", score: 50 },
				{ id: "q4", score: 80 },
				{ id: "q5", score: 25 },
			]),
		);
		expect(result.scores).toEqual([0, 100, 50, 80, 25]);
	});

	it("rejects 4 rows (below minimum)", () => {
		expect(() =>
			parseScoreTable(
				makeTable([
					{ id: "q1", score: 80 },
					{ id: "q2", score: 80 },
					{ id: "q3", score: 80 },
					{ id: "q4", score: 80 },
				]),
			),
		).toThrow("between 5 and 8");
	});

	it("rejects 9 rows (above maximum)", () => {
		expect(() =>
			parseScoreTable(
				makeTable(
					Array.from({ length: 9 }, (_, i) => ({ id: `q${i + 1}`, score: 80 })),
				),
			),
		).toThrow("between 5 and 8");
	});

	it("rejects duplicate IDs", () => {
		expect(() =>
			parseScoreTable(
				makeTable([
					{ id: "q1", score: 80 },
					{ id: "q1", score: 90 },
					{ id: "q3", score: 80 },
					{ id: "q4", score: 80 },
					{ id: "q5", score: 80 },
				]),
			),
		).toThrow("duplicate ID");
	});

	it("rejects score -1", () => {
		expect(() =>
			parseScoreTable(
				makeTable([
					{ id: "q1", score: -1 },
					{ id: "q2", score: 80 },
					{ id: "q3", score: 80 },
					{ id: "q4", score: 80 },
					{ id: "q5", score: 80 },
				]),
			),
		).toThrow("between 0 and 100");
	});

	it("rejects score 101", () => {
		expect(() =>
			parseScoreTable(
				makeTable([
					{ id: "q1", score: 101 },
					{ id: "q2", score: 80 },
					{ id: "q3", score: 80 },
					{ id: "q4", score: 80 },
					{ id: "q5", score: 80 },
				]),
			),
		).toThrow("between 0 and 100");
	});

	it("rejects malformed header", () => {
		expect(() =>
			parseScoreTable(
				`| Id | Question | Score | Notes |\n| --- | --- | ---: | --- |\n| q1 | ? | 80 | n |\n| q2 | ? | 80 | n |\n| q3 | ? | 80 | n |\n| q4 | ? | 80 | n |\n| q5 | ? | 80 | n |`,
			),
		).toThrow("header mismatch");
	});

	it("rejects wrong column count in separator", () => {
		expect(() =>
			parseScoreTable(
				"| ID | Question | Score | Notes |\n| --- | --- |\n| q1 | ? | 80 | n |\n| q2 | ? | 80 | n |\n| q3 | ? | 80 | n |\n| q4 | ? | 80 | n |\n| q5 | ? | 80 | n |",
			),
		).toThrow("separator row");
	});

	it("rejects non-integer score", () => {
		expect(() =>
			parseScoreTable(
				`| ID | Question | Score | Notes |\n| --- | --- | ---: | --- |\n| q1 | ? | 80.5 | n |\n| q2 | ? | 80 | n |\n| q3 | ? | 80 | n |\n| q4 | ? | 80 | n |\n| q5 | ? | 80 | n |`,
			),
		).toThrow("non-integer score");
	});

	it("rejects data row with wrong column count", () => {
		expect(() =>
			parseScoreTable(
				`| ID | Question | Score | Notes |\n| --- | --- | ---: | --- |\n| q1 | ? | 80 |\n| q2 | ? | 80 | n |\n| q3 | ? | 80 | n |\n| q4 | ? | 80 | n |\n| q5 | ? | 80 | n |`,
			),
		).toThrow("4 columns");
	});

	it("rejects empty text", () => {
		expect(() => parseScoreTable("")).toThrow("non-empty lines");
	});

	it("rejects too few lines", () => {
		expect(() => parseScoreTable("| ID | Question | Score | Notes |")).toThrow(
			"non-empty lines",
		);
	});
});
