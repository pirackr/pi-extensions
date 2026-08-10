import { Errors } from "typebox/value";
import { TinyFishSearchOptionsSchema } from "./tinyfish.ts";
import { TinyFishFetchOptionsSchema } from "./tinyfish.ts";
import { ExaSearchOptionsSchema } from "./exa.ts";
import { TavilySearchOptionsSchema } from "./tavily.ts";

export type ValidationError = {
	path: string;
	message: string;
};

/**
 * Returns TypeBox schema errors plus cross-field validation errors for
 * TinyFish search options. Never consumes quota or invokes the provider.
 */
export function validateTinyFishSearchOptions(
	opts: Record<string, unknown>,
): ValidationError[] {
	const errors: ValidationError[] = [];

	const schemaResult = Errors(TinyFishSearchOptionsSchema, opts);
	if (schemaResult.length > 0) {
		for (const err of schemaResult as Array<{
			keyword: string;
			instancePath: string;
			message: string;
		}>) {
			errors.push({ path: err.instancePath, message: err.message });
		}
		return errors;
	}

	// Cross-field: recency_minutes is mutually exclusive with after_date/before_date.
	if (
		opts.recency_minutes != null &&
		(opts.after_date != null || opts.before_date != null)
	) {
		errors.push({
			path: "",
			message:
				"recency_minutes is mutually exclusive with after_date and before_date",
		});
	}

	// Cross-field: pub_year_min must be <= pub_year_max.
	if (
		opts.pub_year_min != null &&
		opts.pub_year_max != null &&
		Number(opts.pub_year_min) > Number(opts.pub_year_max)
	) {
		errors.push({
			path: "",
			message: "pub_year_min must be <= pub_year_max",
		});
	}

	// Cross-field: when both after_date and before_date are present,
	// after_date must be <= before_date (ISO date string comparison).
	if (
		opts.after_date != null &&
		opts.before_date != null &&
		opts.after_date > opts.before_date
	) {
		errors.push({
			path: "",
			message: "after_date must be <= before_date",
		});
	}

	// Cross-field: research_paper domain_type restricts calendar date usage.
	// When domain_type is research_paper, after_date/before_date are not
	// meaningful — pub_year_min/pub_year_max should be used instead.
	if (opts.domain_type === "research_paper") {
		if (opts.after_date != null || opts.before_date != null) {
			errors.push({
				path: "",
				message:
					"domain_type=research_paper does not support after_date/before_date; use pub_year_min/pub_year_max instead",
			});
		}
	}

	return errors;
}

/**
 * Returns TypeBox schema errors plus cross-field validation errors for
 * TinyFish fetch options. Never consumes quota or invokes the provider.
 */
export function validateTinyFishFetchOptions(
	opts: Record<string, unknown>,
): ValidationError[] {
	const errors: ValidationError[] = [];

	const schemaResult = Errors(TinyFishFetchOptionsSchema, opts);
	if (schemaResult.length > 0) {
		for (const err of schemaResult as Array<{
			keyword: string;
			instancePath: string;
			message: string;
		}>) {
			errors.push({ path: err.instancePath, message: err.message });
		}
		return errors;
	}

	// Cross-field: if_none_match and if_modified_since are alternative ETag/
	// Last-Modified validators. Using both on the same request is semantically
	// invalid (they represent mutually exclusive conditional-fetch strategies).
	if (opts.if_none_match != null && opts.if_modified_since != null) {
		errors.push({
			path: "",
			message:
				"if_none_match and if_modified_since are mutually exclusive; use at most one",
		});
	}

	return errors;
}

/**
 * Returns TypeBox schema errors plus cross-field validation errors for
 * Exa search options. Never consumes quota or invokes the provider.
 */
export function validateExaSearchOptions(
	opts: Record<string, unknown>,
): ValidationError[] {
	const errors: ValidationError[] = [];

	const schemaResult = Errors(ExaSearchOptionsSchema, opts);
	if (schemaResult.length > 0) {
		for (const err of schemaResult as Array<{
			keyword: string;
			instancePath: string;
			message: string;
		}>) {
			errors.push({ path: err.instancePath, message: err.message });
		}
		return errors;
	}

	// Cross-field: includeText / excludeText support at most 1 entry of up to 5
	// words each (per the Exa API).
	for (const field of ["includeText", "excludeText"] as const) {
		const value = opts[field];
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; i++) {
				const part = value[i];
				if (
					typeof part === "string" &&
					part.trim().split(/\s+/).length > 5
				) {
					errors.push({
						path: `/${field}`,
						message: `entry ${i} must be at most 5 words`,
					});
				}
			}
		}
	}

	// Cross-field: contents.text with verbosity or section filters requires
	// maxAgeHours: 0 (fresh cache).
	const contents = opts.contents;
	if (contents != null && typeof contents === "object" && !Array.isArray(contents)) {
		const text = (contents as Record<string, unknown>).text;
		if (text != null && typeof text === "object") {
			const textOpts = text as Record<string, unknown>;
			if (
				(textOpts.verbosity != null ||
					textOpts.includeSections != null ||
					textOpts.excludeSections != null) &&
				(contents as Record<string, unknown>).maxAgeHours !== 0
			) {
				errors.push({
					path: "/contents",
					message:
						"text verbosity and section filters require contents.maxAgeHours: 0",
				});
			}
		}
	}

	// Cross-field: outputSchema type=object supports at most 10 properties.
	const outputSchema = opts.outputSchema;
	if (
		outputSchema != null &&
		typeof outputSchema === "object" &&
		(outputSchema as Record<string, unknown>).type === "object"
	) {
		const schema = outputSchema as Record<string, unknown>;
		const properties = schema.properties as Record<string, unknown> | undefined;
		if (properties != null && Object.keys(properties).length > 10) {
			errors.push({
				path: "/outputSchema",
				message: "object outputSchema supports at most 10 properties",
			});
		}
	}

	// Cross-field: category=company or category=people disable date, text,
	// and domain filters. The Exa API returns a 400 when these are combined.
	const incompatibleWithCategory = ["company", "people"];
	if (
		incompatibleWithCategory.includes(opts.category as string) &&
		opts.category != null
	) {
		for (const field of [
			"includeText",
			"excludeText",
			"excludeDomains",
			"startPublishedDate",
			"endPublishedDate",
		] as const) {
			if (opts[field] != null) {
				errors.push({
					path: `/${field}`,
					message: `${field} is not supported with category=${opts.category}`,
				});
			}
		}
	}

	return errors;
}

/**
 * Returns TypeBox schema errors plus cross-field validation errors for
 * Tavily search options. Never consumes quota or invokes the provider.
 */
export function validateTavilySearchOptions(
	opts: Record<string, unknown>,
): ValidationError[] {
	const errors: ValidationError[] = [];

	const schemaResult = Errors(TavilySearchOptionsSchema, opts);
	if (schemaResult.length > 0) {
		for (const err of schemaResult as Array<{
			keyword: string;
			instancePath: string;
			message: string;
		}>) {
			errors.push({ path: err.instancePath, message: err.message });
		}
		return errors;
	}

	// Cross-field: days and timeRange are mutually exclusive.
	if (opts.days != null && opts.timeRange != null) {
		errors.push({
			path: "",
			message: "days and timeRange are mutually exclusive",
		});
	}

	// Cross-field: startDate / endDate are mutually exclusive with days and
	// timeRange.
	if (opts.startDate != null && (opts.days != null || opts.timeRange != null)) {
		errors.push({
			path: "",
			message: "startDate is mutually exclusive with days and timeRange",
		});
	}
	if (opts.endDate != null && (opts.days != null || opts.timeRange != null)) {
		errors.push({
			path: "",
			message: "endDate is mutually exclusive with days and timeRange",
		});
	}

	// Cross-field: includeRawContent requires searchDepth: advanced.
	if (
		opts.includeRawContent != null &&
		opts.includeRawContent !== false &&
		opts.searchDepth !== "advanced"
	) {
		errors.push({
			path: "",
			message: "includeRawContent requires searchDepth: advanced",
		});
	}

	// Cross-field: includeAnswer: advanced requires searchDepth: advanced.
	if (opts.includeAnswer === "advanced" && opts.searchDepth !== "advanced") {
		errors.push({
			path: "",
			message: "includeAnswer: advanced requires searchDepth: advanced",
		});
	}

	return errors;
}
