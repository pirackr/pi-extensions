import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Tavily Search
// ---------------------------------------------------------------------------

export const TavilySearchOptionsSchema = Type.Object(
	{
		searchDepth: Type.Optional(
			Type.Union([
				Type.Literal("basic"),
				Type.Literal("advanced"),
				Type.Literal("fast"),
				Type.Literal("ultra-fast"),
			]),
		),
		topic: Type.Optional(
			Type.Union([
				Type.Literal("general"),
				Type.Literal("news"),
				Type.Literal("finance"),
			]),
		),
		days: Type.Optional(Type.Number()),
		includeImages: Type.Optional(Type.Boolean()),
		includeImageDescriptions: Type.Optional(Type.Boolean()),
		includeAnswer: Type.Optional(
			Type.Union([
				Type.Literal(true),
				Type.Literal(false),
				Type.Literal("basic"),
				Type.Literal("advanced"),
			]),
		),
		includeRawContent: Type.Optional(
			Type.Union([
				Type.Literal(false),
				Type.Literal("markdown"),
				Type.Literal("text"),
			]),
		),
		includeDomains: Type.Optional(Type.Array(Type.String())),
		excludeDomains: Type.Optional(Type.Array(Type.String())),
		maxTokens: Type.Optional(Type.Number()),
		timeRange: Type.Optional(
			Type.Union([
				Type.Literal("year"),
				Type.Literal("month"),
				Type.Literal("week"),
				Type.Literal("day"),
				Type.Literal("y"),
				Type.Literal("m"),
				Type.Literal("w"),
				Type.Literal("d"),
			]),
		),
		chunksPerSource: Type.Optional(Type.Number()),
		country: Type.Optional(Type.String()),
		startDate: Type.Optional(Type.String()),
		endDate: Type.Optional(Type.String()),
		autoParameters: Type.Optional(Type.Boolean()),
		includeFavicon: Type.Optional(Type.Boolean()),
		includeUsage: Type.Optional(Type.Boolean()),
		exactMatch: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
