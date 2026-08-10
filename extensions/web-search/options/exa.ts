import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Exa nested types
// ---------------------------------------------------------------------------

export const ExaSectionTagSchema = Type.Union([
	Type.Literal("unspecified"),
	Type.Literal("header"),
	Type.Literal("navigation"),
	Type.Literal("banner"),
	Type.Literal("body"),
	Type.Literal("sidebar"),
	Type.Literal("footer"),
	Type.Literal("metadata"),
]);

export const ExaTextContentsOptionsSchema = Type.Object(
	{
		maxCharacters: Type.Optional(Type.Number()),
		includeHtmlTags: Type.Optional(Type.Boolean()),
		verbosity: Type.Optional(
			Type.Union([
				Type.Literal("compact"),
				Type.Literal("standard"),
				Type.Literal("full"),
			]),
		),
		includeSections: Type.Optional(Type.Array(ExaSectionTagSchema)),
		excludeSections: Type.Optional(Type.Array(ExaSectionTagSchema)),
	},
	{ additionalProperties: false },
);

export const ExaHighlightsContentsOptionsSchema = Type.Object(
	{
		query: Type.Optional(Type.String()),
		maxCharacters: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

export const ExaSummaryContentsOptionsSchema = Type.Object(
	{
		query: Type.Optional(Type.String()),
		schema: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	},
	{ additionalProperties: false },
);

export const ExaExtrasOptionsSchema = Type.Object(
	{
		links: Type.Optional(Type.Number()),
		imageLinks: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

export const ExaContentsOptionsSchema = Type.Object(
	{
		text: Type.Optional(
			Type.Union([ExaTextContentsOptionsSchema, Type.Literal(true)]),
		),
		highlights: Type.Optional(
			Type.Union([ExaHighlightsContentsOptionsSchema, Type.Literal(true)]),
		),
		summary: Type.Optional(
			Type.Union([ExaSummaryContentsOptionsSchema, Type.Literal(true)]),
		),
		livecrawl: Type.Optional(
			Type.Union([
				Type.Literal("never"),
				Type.Literal("fallback"),
				Type.Literal("always"),
				Type.Literal("auto"),
				Type.Literal("preferred"),
			]),
		),
		maxAgeHours: Type.Optional(Type.Number()),
		filterEmptyResults: Type.Optional(Type.Boolean()),
		subpages: Type.Optional(Type.Number()),
		subpageTarget: Type.Optional(
			Type.Union([Type.String(), Type.Array(Type.String())]),
		),
		extras: Type.Optional(ExaExtrasOptionsSchema),
	},
	{ additionalProperties: false },
);

export const ExaOutputSchemaSchema = Type.Object(
	{
		type: Type.Union([Type.Literal("text"), Type.Literal("object")]),
		description: Type.Optional(Type.String()),
		properties: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
		required: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// Exa Search
// ---------------------------------------------------------------------------

export const ExaSearchOptionsSchema = Type.Object(
	{
		contents: Type.Optional(
			Type.Union([
				ExaContentsOptionsSchema,
				Type.Literal(true),
				Type.Literal(false),
			]),
		),
		includeDomains: Type.Optional(Type.Array(Type.String())),
		excludeDomains: Type.Optional(Type.Array(Type.String())),
		startCrawlDate: Type.Optional(Type.String()),
		endCrawlDate: Type.Optional(Type.String()),
		startPublishedDate: Type.Optional(Type.String()),
		endPublishedDate: Type.Optional(Type.String()),
		category: Type.Optional(
			Type.Union([
				Type.Literal("company"),
				Type.Literal("publication"),
				Type.Literal("news"),
				Type.Literal("personal site"),
				Type.Literal("financial report"),
				Type.Literal("people"),
			]),
		),
		includeText: Type.Optional(Type.Array(Type.String())),
		excludeText: Type.Optional(Type.Array(Type.String())),
		flags: Type.Optional(Type.Array(Type.String())),
		userLocation: Type.Optional(Type.String()),
		modulation: Type.Optional(Type.Boolean()),
		useAutoprompt: Type.Optional(Type.Boolean()),
		systemPrompt: Type.Optional(Type.String()),
		outputSchema: Type.Optional(ExaOutputSchemaSchema),
		type: Type.Optional(
			Type.Union([
				Type.Literal("keyword"),
				Type.Literal("neural"),
				Type.Literal("auto"),
				Type.Literal("hybrid"),
				Type.Literal("fast"),
				Type.Literal("instant"),
				Type.Literal("deep-lite"),
				Type.Literal("deep"),
				Type.Literal("deep-reasoning"),
			]),
		),
	},
	{ additionalProperties: false },
);
