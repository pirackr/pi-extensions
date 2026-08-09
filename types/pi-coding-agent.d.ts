declare module "@earendil-works/pi-coding-agent" {
	export interface ExtensionUIContext {
		notify(message: string, type?: "info" | "warning" | "error"): void;
		confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
		select(
			title: string,
			options: string[],
			opts?: unknown,
		): Promise<string | undefined>;
		input(
			title: string,
			placeholder?: string,
			opts?: unknown,
		): Promise<string | undefined>;
		setStatus(key: string, text: string | undefined): void;
	}

	export interface SessionEntry {
		type: string;
		id: string;
		parentId: string | null;
		timestamp: string;
		customType?: string;
		data?: unknown;
	}

	export interface ExtensionContext {
		ui: ExtensionUIContext;
		mode: "tui" | "rpc" | "json" | "print";
		hasUI: boolean;
		cwd: string;
		sessionManager: {
			getEntries(): SessionEntry[];
			getBranch(fromId?: string): SessionEntry[];
		};
		isIdle(): boolean;
		hasPendingMessages(): boolean;
	}

	export interface ExtensionCommandContext extends ExtensionContext {}

	export interface RegisteredCommand {
		description?: string;
		getArgumentCompletions?: (
			prefix: string,
		) =>
			| Array<{ value: string; label?: string }>
			| null
			| Promise<Array<{ value: string; label?: string }> | null>;
		handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
	}

	export interface ExtensionAPI {
		registerTool(tool: {
			name: string;
			label: string;
			description: string;
			promptSnippet?: string;
			promptGuidelines?: string[];
			parameters: unknown;
			execute: (
				toolCallId: string,
				params: unknown,
				signal: AbortSignal | undefined,
				onUpdate:
					| ((update: {
							content: Array<{ type: string; text: string }>;
							details?: unknown;
					  }) => void)
					| undefined,
				ctx: ExtensionContext,
			) => Promise<{
				content: Array<{ type: string; text: string }>;
				details?: unknown;
				usage?: unknown;
				isError?: boolean;
			}>;
		}): void;
		registerCommand(name: string, options: RegisteredCommand): void;
		registerFlag(
			name: string,
			options: {
				description?: string;
				type: "boolean" | "string";
				default?: boolean | string;
			},
		): void;
		getFlag(name: string): boolean | string | undefined;
		sendMessage(
			message: {
				customType: string;
				content: string | Array<{ type: string; text: string }>;
				display: boolean;
				details?: unknown;
			},
			options?: {
				triggerTurn?: boolean;
				deliverAs?: "steer" | "followUp" | "nextTurn";
			},
		): void;
		appendEntry<T = unknown>(customType: string, data?: T): void;
		on(
			event: "session_start" | "turn_start" | "turn_end" | "agent_end",
			handler: (
				event: unknown,
				ctx: ExtensionContext,
			) => Promise<unknown> | unknown,
		): void;
		getActiveTools(): string[];
		setActiveTools(toolNames: string[]): void;
	}

	export function getAgentDir(): string;

	export function parseFrontmatter<T>(content: string): {
		frontmatter: T;
		body: string;
	};
}
