declare module "typebox" {
	/** Minimal structural type matching TypeBox's TSchema. */
	export type TSchema = { [key: string]: unknown };

	export const Type: {
		/** Creates a boolean schema. */
		Boolean(options?: { description?: string }): TSchema;
		/** Creates a number schema. */
		Number(options?: { description?: string }): TSchema;
		Integer(options?: { minimum?: number; maximum?: number; description?: string }): TSchema;
		Null(): TSchema;
		/** Creates a string schema. */
		String(options?: { description?: string; minLength?: number; maxLength?: number }): TSchema;
		/** Creates an object schema. */
		Object<T extends Record<string, unknown>>(
			properties: T,
			options?: {
				description?: string;
				minItems?: number;
				maxItems?: number;
				additionalProperties?: boolean;
				enum?: unknown[];
			},
		): TSchema & { properties: T; required?: string[] };
		/** Creates an array schema. */
		Array<T>(
			item: T,
			options?: { description?: string; minItems?: number; maxItems?: number },
		): TSchema;
		/** Creates an optional wrapper. */
		Optional<T>(item: T): TSchema;
		/** Creates a union of the given schemas. */
		Union<T extends unknown[]>(
			anyOf: [...T],
			options?: { description?: string },
		): TSchema;
		/** Creates a literal schema. */
		Literal<T extends string | number | boolean>(
			value: T,
			options?: { description?: string },
		): TSchema;
		/** Creates a record schema (key: string, value: TSchema). */
		Record<K extends TSchema, V extends TSchema>(key: K, value: V): TSchema;
		/** Creates an unknown schema. */
		Unknown(): TSchema;
	};
}

declare module "typebox/value" {
	import type { TSchema } from "typebox";
	export function Check(schema: TSchema, value: unknown): boolean;
	/** Validates a value against a TypeBox schema, returning validation errors. */
	export function Errors(schema: TSchema, value: unknown): Array<{
		keyword: string;
		instancePath: string;
		message: string;
	}>;
}
