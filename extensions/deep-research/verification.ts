// Pure parser for the score.md table contract.
// Throws descriptive errors on any malformation so the checkpoint can turn
// them into repair instructions.
export interface ScoreTableRow {
	id: string;
	score: number;
}

export function parseScoreTable(text: string): {
	ids: string[];
	scores: number[];
	rows: ScoreTableRow[];
} {
	const lines = text
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.length > 0);

	if (lines.length < 3) {
		throw new Error(
			"score.md must be a markdown table with at least a header, separator, and one data row — got only " +
				lines.length +
				" non-empty lines",
		);
	}

	// Header: '| ID | Question | Score | Notes |'
	const headerLine = lines[0].replace(/^\|/, "").replace(/\|$/, "").trim();
	const expectedHeader = "ID | Question | Score | Notes";
	if (headerLine !== expectedHeader) {
		throw new Error(
			`score.md header mismatch: expected '| ID | Question | Score | Notes |' but got '| ${headerLine} |'`,
		);
	}

	// Separator line (must have at least 4 columns with dashes)
	const sepLine = lines[1];
	const sepParts = sepLine
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((s) => s.trim());
	if (sepParts.length < 4 || sepParts.some((p) => !/^\-+:?\s*$/.test(p))) {
		throw new Error(
			"score.md separator row must have at least 4 columns of dashes — got: " +
				sepLine,
		);
	}

	// Data rows
	const dataLines = lines.slice(2);
	const rows: ScoreTableRow[] = [];
	const seenIds = new Set<string>();

	for (const line of dataLines) {
		// Strip leading/trailing pipe characters
		const cells = line
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((s) => s.trim());

		if (cells.length < 4) {
			throw new Error(
				`score.md data row must have at least 4 columns — got: ${line}`,
			);
		}

		const id = cells[0];
		const scoreStr = cells[2];

		if (!id || id.trim() === "") {
			throw new Error(
				"score.md data row has an empty ID — all rows must have a non-empty ID",
			);
		}

		if (seenIds.has(id)) {
			throw new Error(
				`score.md contains a duplicate ID '${id}' — all IDs must be unique`,
			);
		}
		seenIds.add(id);

		const score = Number(scoreStr);
		if (!Number.isInteger(score)) {
			throw new Error(
				`score.md row for ID '${id}' has a non-integer score '${scoreStr}' — scores must be integers`,
			);
		}
		if (score < 0 || score > 100) {
			throw new Error(
				`score.md row for ID '${id}' has score ${score} — scores must be between 0 and 100`,
			);
		}

		rows.push({ id, score });
	}

	if (rows.length < 5) {
		throw new Error(
			`score.md must contain between 5 and 8 sub-question rows — got ${rows.length}`,
		);
	}
	if (rows.length > 8) {
		throw new Error(
			`score.md must contain between 5 and 8 sub-question rows — got ${rows.length}`,
		);
	}

	return {
		ids: rows.map((r) => r.id),
		scores: rows.map((r) => r.score),
		rows,
	};
}
