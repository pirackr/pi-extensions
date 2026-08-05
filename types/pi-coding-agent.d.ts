declare module "@earendil-works/pi-coding-agent" {
	export interface ExtensionAPI {
		registerTool(tool: {
			name: string;
			label: string;
			description: string;
			parameters: unknown;
			execute: (
				toolCallId: string,
				params: unknown,
				signal?: AbortSignal,
				onUpdate?: (update: {
					content: Array<{ type: string; text: string }>;
					details?: unknown;
				}) => void,
				ctx?: { cwd: string },
			) => Promise<{
				content: Array<{ type: string; text: string }>;
				details?: unknown;
				usage?: unknown;
			}>;
		}): void;
	}

	export function getAgentDir(): string;

	export function parseFrontmatter<T>(content: string): {
		frontmatter: T;
		body: string;
	};
}
