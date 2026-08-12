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
		message?: { role?: string; content?: unknown };
	}

	// ------------------------------------------------------------------
	// Model
	// ------------------------------------------------------------------

	export interface Model<TApi = unknown> {
		id: string;
		provider: string;
		contextWindow: number;
	}

	// ------------------------------------------------------------------
	// Context usage and compaction
	// ------------------------------------------------------------------

	export interface ContextUsage {
		tokens: number | null;
		contextWindow: number;
		percent: number | null;
	}

	export interface CompactionResult {
		summary: string;
		firstKeptEntryId: string;
		tokensBefore: number;
		estimatedTokensAfter?: number;
	}

	export interface CompactOptions {
		customInstructions?: string;
		onComplete?: (result: CompactionResult) => void;
		onError?: (error: Error) => void;
	}

	// ------------------------------------------------------------------
	// Extension context (extended)
	// ------------------------------------------------------------------

	export interface ExtensionContext {
		ui: ExtensionUIContext;
		mode: "tui" | "rpc" | "json" | "print";
		hasUI: boolean;
		cwd: string;
		model: Model<any> | undefined;
		sessionManager: {
			getEntries(): SessionEntry[];
			getBranch(fromId?: string): SessionEntry[];
			getSessionId(): string;
			getSessionName(): string | undefined;
		};
		isIdle(): boolean;
		isProjectTrusted(): boolean;
		hasPendingMessages(): boolean;
		getContextUsage(): ContextUsage | undefined;
		compact(options?: CompactOptions): void;
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

	// ------------------------------------------------------------------
	// Events
	// ------------------------------------------------------------------

	export interface SessionStartEvent {
		type: "session_start";
		reason: "startup" | "reload" | "new" | "resume" | "fork";
		previousSessionFile?: string;
	}

	export interface ModelSelectEvent {
		type: "model_select";
		model: Model<any>;
		previousModel: Model<any> | undefined;
		source: string;
	}

	export interface TurnEndEvent {
		type: "turn_end";
		turnIndex: number;
		message: unknown;
		toolResults: unknown[];
	}

	export interface CompactionPreparation {
		firstKeptEntryId: string;
		tokensBefore: number;
	}

	export interface SessionBeforeCompactEvent {
		type: "session_before_compact";
		preparation: CompactionPreparation;
		branchEntries: SessionEntry[];
		customInstructions?: string;
		reason: "manual" | "threshold" | "overflow";
		willRetry: boolean;
		signal: AbortSignal;
	}

	export interface SessionBeforeCompactResult {
		cancel?: boolean;
	}

	export interface SessionCompactEvent {
		type: "session_compact";
		compactionEntry: unknown;
		fromExtension: boolean;
		reason: "manual" | "threshold" | "overflow";
		willRetry: boolean;
	}

	// ------------------------------------------------------------------
	// ExtensionAPI
	// ------------------------------------------------------------------

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
			event: "session_start",
			handler: (
				event: SessionStartEvent,
				ctx: ExtensionContext,
			) => void | Promise<void>,
		): void;
		on(
			event: "model_select",
			handler: (
				event: ModelSelectEvent,
				ctx: ExtensionContext,
			) => void | Promise<void>,
		): void;
		on(
			event: "turn_end",
			handler: (
				event: TurnEndEvent,
				ctx: ExtensionContext,
			) => void | Promise<void>,
		): void;
		on(
			event: "session_before_compact",
			handler: (
				event: SessionBeforeCompactEvent,
				ctx: ExtensionContext,
			) => void | SessionBeforeCompactResult | Promise<void | SessionBeforeCompactResult>,
		): void;
		on(
			event: "session_compact",
			handler: (
				event: SessionCompactEvent,
				ctx: ExtensionContext,
			) => void | Promise<void>,
		): void;
		on(
			event:
				| "turn_start"
				| "agent_end"
				| "session_info_changed"
				| "session_shutdown",
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

	export const CONFIG_DIR_NAME: string;
}
