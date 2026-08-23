/**
 * Dispatch-neutral attempt contracts owned by the research integration.
 *
 * These structural types preserve the legacy dispatch-policy boundary while
 * removing ResearchPolicy's dependency on `extensions/subagent-dispatch`. The
 * legacy façade remains structurally compatible until its Task 15 cutover.
 */

export interface SerializedError {
	message: string;
	code?: string;
	stack?: string;
	[key: string]: unknown;
}

export type AttemptOutcomeStatus =
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export interface AttemptUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

export interface AttemptResult {
	output: unknown;
	usage?: AttemptUsage;
	metadata?: Record<string, unknown>;
}

export interface AttemptCompleted {
	status: "completed";
	result: AttemptResult;
}

export interface AttemptFailed {
	status: "failed" | "cancelled" | "interrupted";
	error: SerializedError;
}

export type AttemptOutcome = AttemptCompleted | AttemptFailed;

export interface ProviderDescriptor {
	id: string;
	adapterVersion: string;
	protocolVersion?: string;
	executionSpecVersion?: string;
	capabilities: string[];
	maxConcurrentAttempts?: number;
	maxAttemptsPerTask?: number;
}

export interface DispatchContext {
	readonly context: Record<string, unknown>;
}

export interface RequestedPlan {
	providerId: string | null;
	requiredCapabilities: string[];
	concurrency: number;
	totalAttempts: number;
	activePolicy?: string | null;
}

export interface ResolvedAttempt {
	attemptId: string;
	planId: string;
	index: number;
	taskInfo?: Record<string, unknown>;
}

export interface ResolvedDispatch {
	providerId: string;
	descriptor: ProviderDescriptor;
	attempts: ResolvedAttempt[];
	totalAttempts: number;
}

export interface AttemptReservation {
	reservationId: string;
	attempt: ResolvedAttempt;
	providerId: string;
}

export interface ArtifactMetadata {
	artifactId: string;
	metadata?: Record<string, unknown>;
}
