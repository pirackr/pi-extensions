/**
 * Subagent dispatch façade — provider-neutral execution layer.
 *
 * This module:
 *  1. Creates a ProviderRegistry and registers a default (in-memory fake) provider.
 *  2. Loads configuration from config/subagent-dispatch.json.
 *  3. Registers the `run_subagents` tool on the pi ExtensionAPI.
 *  4. The façade owns batching expansion, retries, reservation/release, and
 *     artifact export — providers must not implement hidden retries.
 */

import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	AttemptOutcome,
	AttemptResult,
	ProviderDescriptor,
	SerializedError,
	DiscoveredProvider,
} from "./contract.ts";
import { negotiateProvider } from "./contract.ts";
import { ProviderRegistry } from "./registry.ts";

// ---------------------------------------------------------------------------
// In-memory fake provider — records every launch for test verification
// ---------------------------------------------------------------------------

export interface FakeProviderRecord {
	attemptId: string;
	planId: string;
	index: number;
	abortReason?: string;
	outcome: AttemptOutcome;
	exportedArtifact: boolean;
}

export class FakeSubagentProvider {
	static readonly ID = "fake-provider";
	static readonly ADAPTER_VERSION = "0.0.1";
	/** Static descriptor — shared by all instances so the façade can register
	 * one without creating an instance. */
	static readonly DESCRIPTOR: ProviderDescriptor = {
		id: FakeSubagentProvider.ID,
		adapterVersion: FakeSubagentProvider.ADAPTER_VERSION,
		protocolVersion: "0.1.0",
		executionSpecVersion: "0.1.0",
		capabilities: ["local"],
		maxConcurrentAttempts: 10,
		maxAttemptsPerTask: 100,
	};

	/** Records of every executeAttempt call — test consumers inspect this. */
	readonly records: FakeProviderRecord[] = [];
	/** If set, executeAttempt throws this instead of succeeding. */
	onExecuteAttempt?: (plan: {
		attemptId: string;
		planId: string;
		index: number;
	}) => void;
	/** If set, exportArtifact returns null (simulating artifact export failure). */
	onExportArtifactFailure?: boolean;
	/** Simulate a slow executeAttempt. */
	delayMs?: number;

	get descriptor(): ProviderDescriptor {
		return FakeSubagentProvider.DESCRIPTOR;
	}

	/**
	 * Execute a single attempt — the façade calls this exactly once per attempt.
	 * The provider must not retry internally.
	 * Receives the full ResolvedAttempt including optional taskInfo.
	 */
	async executeAttempt(
		plan: { attemptId: string; planId: string; index: number },
		signal: AbortSignal,
	): Promise<AttemptResult> {
		let outcome: AttemptOutcome;

		if (signal.aborted) {
			outcome = { status: "cancelled", error: { message: "already-aborted" } };
			this.records.push({
				attemptId: plan.attemptId,
				planId: plan.planId,
				index: plan.index,
				abortReason: "already-aborted",
				outcome,
				exportedArtifact: false,
			});
			return {
				output: { attemptId: plan.attemptId, error: "already-aborted" },
				metadata: { provider: FakeSubagentProvider.ID },
			};
		}

		// Check for an injected error — the provider catches it and produces a
		// failed outcome rather than propagating (the façade normalises all outcomes).
		let errorCaptured: Error | null = null;
		if (this.onExecuteAttempt) {
			try {
				this.onExecuteAttempt(plan);
			} catch (err) {
				errorCaptured = err instanceof Error ? err : new Error(String(err));
			}
		}

		// Simulate delay if configured
		if (this.delayMs) {
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(resolve, this.delayMs);
				signal.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						reject(new Error("Attempt cancelled by abort signal"));
					},
					{ once: true },
				);
			});
		}

		// Check abort during execution
		if (signal.aborted) {
			outcome = {
				status: "cancelled",
				error: { message: "aborted-during-execute" },
			};
			this.records.push({
				attemptId: plan.attemptId,
				planId: plan.planId,
				index: plan.index,
				abortReason: "aborted-during-execute",
				outcome,
				exportedArtifact: false,
			});
			return {
				output: { attemptId: plan.attemptId, error: "aborted-during-execute" },
				metadata: { provider: FakeSubagentProvider.ID },
			};
		}

		// Handle captured error from onExecuteAttempt
		if (errorCaptured) {
			outcome = { status: "failed", error: { message: errorCaptured.message } };
			this.records.push({
				attemptId: plan.attemptId,
				planId: plan.planId,
				index: plan.index,
				outcome,
				exportedArtifact: false,
			});
			return {
				output: { attemptId: plan.attemptId, error: errorCaptured.message },
				metadata: { provider: FakeSubagentProvider.ID },
			};
		}

		// Normal success path
		const result: AttemptResult = {
			output: { attemptId: plan.attemptId, result: "done" },
			usage: { totalTokens: 0 },
			metadata: { provider: FakeSubagentProvider.ID },
		};
		outcome = { status: "completed", result };
		this.records.push({
			attemptId: plan.attemptId,
			planId: plan.planId,
			index: plan.index,
			outcome,
			exportedArtifact: false,
		});
		return result;
	}

	/** Reset records and counter (for test isolation). */
	reset(): void {
		this.records.length = 0;
		this.records.length = 0;
		this.onExecuteAttempt = undefined;
		this.onExportArtifactFailure = undefined;
		this.delayMs = undefined;
	}
}

// ---------------------------------------------------------------------------
// Mock DispatchPolicy — records every call for test verification
// ---------------------------------------------------------------------------

export interface MockPolicyRecord {
	method: string;
	attemptId?: string;
	planId?: string;
	outcome?: AttemptOutcome;
}

/**
 * Mock DispatchPolicy that records every policy call.
 * The façade calls reserveAttempt, exportArtifact, and releaseAttempt through
 * this policy, allowing tests to assert the real call sequence.
 */
export class MockDispatchPolicy {
	readonly records: MockPolicyRecord[] = [];
	/** If set, reserveAttempt throws (simulating reservation failure). */
	onReserveAttemptFailure?: Error;
	/** If set, exportArtifact returns undefined (simulating export failure). */
	onExportArtifactFailure?: boolean;

	private record(method: string, attemptId?: string, planId?: string): void {
		this.records.push({ method, attemptId, planId });
	}

	async reserveAttempt(attempt: {
		attemptId: string;
		planId: string;
		index: number;
	}): Promise<{
		reservationId: string;
		attempt: typeof attempt;
		providerId: string;
	}> {
		this.record("reserveAttempt", attempt.attemptId, attempt.planId);
		if (this.onReserveAttemptFailure) {
			throw this.onReserveAttemptFailure;
		}
		return {
			reservationId: `res-${attempt.attemptId}`,
			attempt,
			providerId: "fake-provider",
		};
	}

	async releaseAttempt(
		_reservation: {
			reservationId: string;
			attempt: { attemptId: string; planId: string; index: number };
			providerId: string;
		},
		_outcome: AttemptOutcome,
	): Promise<void> {
		this.record(
			"releaseAttempt",
			_reservation.attempt.attemptId,
			_reservation.attempt.planId,
		);
	}

	async exportArtifact(
		_reservation: {
			reservationId: string;
			attempt: { attemptId: string; planId: string; index: number };
			providerId: string;
		},
		_result: AttemptResult,
	): Promise<{ artifactId: string } | undefined> {
		this.record(
			"exportArtifact",
			_reservation.attempt.attemptId,
			_reservation.attempt.planId,
		);
		if (this.onExportArtifactFailure) {
			return undefined;
		}
		return { artifactId: `art-${_reservation.attempt.attemptId}` };
	}

	/** Reset records for test isolation. */
	reset(): void {
		this.records.length = 0;
		this.onReserveAttemptFailure = undefined;
		this.onExportArtifactFailure = undefined;
	}
}

// ---------------------------------------------------------------------------
// Configuration loader
// ---------------------------------------------------------------------------

interface DispatchConfigShape {
	/** Provider selected for generic dispatch (null = auto). */
	defaultProvider?: string | null;
	/** Protocol-wide ceilings applied regardless of provider. */
	ceilings?: {
		maxConcurrentAttempts?: number;
		maxAttemptsPerTask?: number;
		hardTimeoutSeconds?: number;
	};
}

// ---------------------------------------------------------------------------
// Façade factory
// ---------------------------------------------------------------------------

export interface FaçadeOptions {
	/** Override for the registry (used in tests). */
	registry?: ProviderRegistry;
	/** Override for the config (used in tests). */
	config?: DispatchConfigShape;
	/** The EventBus from pi (for provider discovery). */
	eventBus?: unknown;
	/** Mock dispatch policy for test wiring (used in tests). */
	mockPolicy?: MockDispatchPolicy;
}

export interface DispatchFacade {
	/** The registry holding discovered providers. */
	registry: ProviderRegistry;
	/** Dispatched configuration. */
	config: DispatchConfigShape;
	/** The negotiateProvider function for Task 9 consumption. */
	negotiateProvider: typeof negotiateProvider;
	/** Event bus for (re)discovery — retained so dispatch can refresh providers lazily. */
	eventBus?: unknown;
	/** Re-emit discovery and register any newly-published providers. */
	discover?: () => void;
}

let facadeInstance: DispatchFacade | null = null;

/** Event channel providers listen on to publish themselves during discovery. */
const PROVIDER_DISCOVERY_CHANNEL = "subagent-dispatch-provider-discovered";

/**
 * Re-emit the discovery channel and register any providers pushed onto the
 * caller-owned envelope. Idempotent: duplicate ids are ignored (first wins).
 * Callers may invoke this repeatedly; each call re-collects from all
 * currently-registered listeners, making discovery load-order independent.
 */
function discoverProviders(
	registry: ProviderRegistry,
	eventBus?: unknown,
): void {
	if (!eventBus) return;
	const bus = eventBus as { emit: (channel: string, data: unknown) => void };
	const envelope: {
		providers: (DiscoveredProvider | Promise<DiscoveredProvider>)[];
	} = { providers: [] };
	bus.emit(PROVIDER_DISCOVERY_CHANNEL, { envelope });
	for (const entry of envelope.providers) {
		if (entry instanceof Promise) {
			void entry.then((resolved) => registerDiscovered(registry, resolved));
		} else {
			registerDiscovered(registry, entry);
		}
	}
}

export function createFacade(options: FaçadeOptions = {}): DispatchFacade {
	if (facadeInstance) {
		return facadeInstance;
	}

	const registry = options.registry ?? new ProviderRegistry();
	const config = options.config ?? {};
	const eventBus = options.eventBus;

	// Initial discovery (providers that loaded before the façade). Providers
	// that load after are picked up by the lazy re-discovery at dispatch time.
	discoverProviders(registry, eventBus);

	// Register the default fake provider unless the registry already has one
	// (from discovery or a test-supplied registry).
	if (!registry.get(FakeSubagentProvider.ID)) {
		registry.registerWithInstance(
			FakeSubagentProvider.DESCRIPTOR,
			new FakeSubagentProvider(),
		);
	}

	facadeInstance = {
		registry,
		config,
		negotiateProvider,
		eventBus,
		discover: () => discoverProviders(registry, eventBus),
	};

	return facadeInstance;
}

/**
 * Register a discovered provider (descriptor + optional instance) into the
 * registry, tolerating duplicates (later registrations lose to earlier ones
 * because ProviderRegistry rejects duplicate ids).
 */
function registerDiscovered(
	registry: ProviderRegistry,
	discovered: DiscoveredProvider,
): void {
	try {
		if (discovered.instance) {
			registry.registerWithInstance(discovered.descriptor, discovered.instance);
		} else {
			registry.register(discovered.descriptor);
		}
	} catch {
		// Duplicate provider id — first registration wins; ignore later ones.
	}
}

// ---------------------------------------------------------------------------
// Façade reset (for tests)
// ---------------------------------------------------------------------------

export function resetFacade(): void {
	if (facadeInstance) {
		facadeInstance.registry.clear();
		facadeInstance = null;
	}
}

// ---------------------------------------------------------------------------
// Extension registration — run_subagents tool
// ---------------------------------------------------------------------------

/**
 * Register the `run_subagents` tool with the pi ExtensionAPI.
 * This is the single registration point for the façade.
 */
export function registerFaçadeTools(
	pi: ExtensionAPI,
	facade: DispatchFacade,
	mockPolicy?: MockDispatchPolicy,
): void {
	const { registry, config } = facade;
	const providers = registry.getAll();
	const providerSummary = providers
		.map((p) => `${p.id} (${p.adapterVersion})`)
		.join("; ");

	// Default provider selection — falls back to auto when null.

	pi.registerTool({
		name: "run_subagents",
		label: "Subagents Dispatch",
		description:
			`Dispatch tasks via provider-neutral dispatch façade. ` +
			`Providers: ${providerSummary}.`,
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					id: Type.String({ description: "Unique task identifier" }),
					objective: Type.String({ description: "Task objective" }),
				}),
				{
					description: "Independent tasks to dispatch",
					minItems: 1,
					maxItems: config.ceilings?.maxConcurrentAttempts ?? 10,
				},
			),
		}),
		async execute(
			_toolCallId: string,
			params: unknown,
			_signal?: AbortSignal,
			_onUpdate?: (update: {
				content: { type: string; text: string }[];
				details?: unknown;
			}) => void,
			_ctx?: { cwd?: string; sessionManager?: unknown },
		): Promise<{
			content: { type: string; text: string }[];
			details: unknown;
			usage?: unknown;
		}> {
			const typedParams = params as {
				tasks: { id: string; objective: string }[];
			};

			const tasks = typedParams.tasks;
			if (tasks.length === 0) {
				throw new Error("Provide at least one task.");
			}

			// Lazy re-discovery: pick up providers that loaded after the façade's
			// initial discovery (load-order independence). Idempotent — duplicates
			// are ignored.
			facade.discover?.();

			// Negotiate provider
			const requirements: string[] = []; // no hard requirements for generic dispatch
			const liveProviders = registry.getAll();
			const { providerId, descriptor } = negotiateProvider(
				liveProviders,
				config.defaultProvider ?? null,
				requirements,
			);

			// Get the provider instance from the registry
			const providerInstance = registry.getInstance(providerId);
			if (!providerInstance) {
				throw new Error(`No provider instance found for "${providerId}"`);
			}

			// Batching expansion: one attempt per task
			const attempts: Array<{
				attemptId: string;
				planId: string;
				index: number;
				taskId: string;
				objective: string;
			}> = tasks.map((task, index) => ({
				attemptId: `attempt-${Date.now()}-${index}`,
				planId: `plan-${Date.now()}`,
				index,
				taskId: task.id,
				objective: task.objective,
			}));

			// Aggregate usage tracker
			const totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
			};
			const results: Array<{
				attemptId: string;
				taskId: string;
				status: "completed" | "failed" | "cancelled" | "interrupted";
				result?: unknown;
				error?: SerializedError;
			}> = [];

			// For each attempt: reserve → execute → normalize → export → release
			for (const attempt of attempts) {
				// Full ResolvedAttempt including taskInfo (F10)
				const attemptPlan: import("./contract.ts").ResolvedAttempt = {
					attemptId: attempt.attemptId,
					planId: attempt.planId,
					index: attempt.index,
					taskInfo: { taskId: attempt.taskId, objective: attempt.objective },
				};

				// Reserve before every physical launch (F1)
				const policy = mockPolicy;
				let reservation: import("./contract.ts").AttemptReservation;
				try {
					reservation = await policy!.reserveAttempt(attemptPlan);
				} catch {
					// Failed reservation prevents launch — record as failed but skip execute
					results.push({
						attemptId: attempt.attemptId,
						taskId: attempt.taskId,
						status: "failed",
						error: { message: "reservation failed" },
					});
					continue;
				}

				// Create AbortController for this attempt's lifecycle
				const controller = new AbortController();

				let outcome: AttemptOutcome;

				try {
					// The façade invokes exactly one provider.executeAttempt (F1)
					// Pass the full ResolvedAttempt including taskInfo (F10)
					const result = await (providerInstance as any).executeAttempt(
						attemptPlan,
						controller.signal,
					);

					// Normalize successful return into AttemptOutcome
					outcome = { status: "completed", result };
				} catch (error) {
					// Normalize throws into AttemptOutcome (F1)
					const serialized: SerializedError = {
						message: error instanceof Error ? error.message : String(error),
					};
					outcome = { status: "failed", error: serialized };
				}

				try {
					// Export artifact for successful outcomes (F1)
					if (outcome.status === "completed") {
						await policy!.exportArtifact(reservation, outcome.result);
						results.push({
							attemptId: attempt.attemptId,
							taskId: attempt.taskId,
							status: "completed",
							result: outcome.result,
						});

						totalUsage.totalTokens += outcome.result.usage?.totalTokens ?? 0;
					} else {
						results.push({
							attemptId: attempt.attemptId,
							taskId: attempt.taskId,
							status: outcome.status as "failed" | "cancelled" | "interrupted",
							error: outcome.error,
						});
					}
				} catch (exportError) {
					// If export fails, treat as failed but still release (F1)
					const serialized: SerializedError = {
						message:
							exportError instanceof Error
								? exportError.message
								: String(exportError),
					};
					results.push({
						attemptId: attempt.attemptId,
						taskId: attempt.taskId,
						status: "failed",
						error: serialized,
					});
				} finally {
					// releaseAttempt called exactly once in finally (F1)
					await policy!.releaseAttempt(reservation, outcome);
				}
			}

			return {
				content: [
					{
						type: "text",
						text: `Dispatched ${results.length} tasks via provider "${providerId}"`,
					},
				],
				details: {
					providerId,
					descriptor,
					results,
				},
				usage: totalUsage,
			};
		},
	});
}

// ---------------------------------------------------------------------------
// Default export — creates façade and registers tools in one call
// ---------------------------------------------------------------------------

export default function createSubagentDispatchFacade(
	pi: ExtensionAPI,
): DispatchFacade {
	const facade = createFacade({ eventBus: pi.events });
	registerFaçadeTools(pi, facade);
	return facade;
}

export { negotiateProvider, type ProviderDescriptor };
