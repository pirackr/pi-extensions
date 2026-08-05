declare module "typebox" {
	export const Type: {
		Object<T extends Record<string, unknown>>(
			properties: T,
			options?: { description?: string; minItems?: number; maxItems?: number },
		): unknown;
		String(options?: { description?: string }): unknown;
		Number(options?: { description?: string }): unknown;
		Array<T>(
			item: T,
			options?: { description?: string; minItems?: number; maxItems?: number },
		): unknown;
		Optional<T>(item: T): unknown;
	};
}
