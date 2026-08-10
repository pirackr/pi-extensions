import { Type } from "typebox";

// ---------------------------------------------------------------------------
// TinyFish Search
// ---------------------------------------------------------------------------

export const TinyFishSearchOptionsSchema = Type.Object(
	{
		purpose: Type.Optional(Type.String({ maxLength: 2000 })),
		location: Type.Optional(Type.String()),
		language: Type.Optional(Type.String()),
		include_domains: Type.Optional(Type.String()),
		exclude_domains: Type.Optional(Type.String()),
		after_date: Type.Optional(Type.String()),
		before_date: Type.Optional(Type.String()),
		recency_minutes: Type.Optional(Type.Number()),
		domain_type: Type.Optional(
			Type.Union([
				Type.Literal("web"),
				Type.Literal("news"),
				Type.Literal("research_paper"),
			]),
		),
		pub_year_min: Type.Optional(Type.Number()),
		pub_year_max: Type.Optional(Type.Number()),
		page: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

// ---------------------------------------------------------------------------
// TinyFish Fetch
// ---------------------------------------------------------------------------

export const TinyFishFetchOptionsSchema = Type.Object(
	{
		purpose: Type.Optional(Type.String({ maxLength: 2000 })),
		format: Type.Optional(
			Type.Union([
				Type.Literal("markdown"),
				Type.Literal("html"),
				Type.Literal("json"),
			]),
		),
		include_html_head: Type.Optional(Type.Boolean()),
		links: Type.Optional(Type.Boolean()),
		image_links: Type.Optional(Type.Boolean()),
		ttl: Type.Optional(Type.Number()),
		per_url_timeout_ms: Type.Optional(Type.Number()),
		if_none_match: Type.Optional(Type.String()),
		if_modified_since: Type.Optional(Type.String()),
		include_etag_and_last_modified: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
