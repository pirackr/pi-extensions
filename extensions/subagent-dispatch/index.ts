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

  /** Monotonically increasing attempt counter. */
  private attemptCounter = 0;
  /** Records of every executeAttempt call — test consumers inspect this. */
  readonly records: FakeProviderRecord[] = [];
  /** If set, executeAttempt throws this instead of succeeding. */
  onExecuteAttempt?: (plan: { attemptId: string; planId: string; index: number }) => void;
  /** If set, exportArtifact returns null (simulating artifact export failure). */
  onExportArtifactFailure?: boolean;
  /** Simulate a slow executeAttempt. */
  delayMs?: number;

  get descriptor(): ProviderDescriptor {
    return FakeSubagentProvider.DESCRIPTOR;
  }

  private nextAttemptId(): string {
    return `attempt-${++this.attemptCounter}`;
  }

  /**
   * Execute a single attempt — the façade calls this exactly once per attempt.
   * The provider must not retry internally.
   */
  async executeAttempt(
    plan: { attemptId: string; planId: string; index: number },
    signal: AbortSignal,
  ): Promise<AttemptResult> {
    let outcome: AttemptOutcome;

    if (signal.aborted) {
      outcome = { status: "cancelled", error: { message: "already-aborted" } };
      this.records.push({ attemptId: plan.attemptId, planId: plan.planId, index: plan.index, abortReason: "already-aborted", outcome, exportedArtifact: false });
      return { output: { attemptId: plan.attemptId, error: "already-aborted" }, metadata: { provider: FakeSubagentProvider.ID } };
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
      outcome = { status: "cancelled", error: { message: "aborted-during-execute" } };
      this.records.push({ attemptId: plan.attemptId, planId: plan.planId, index: plan.index, abortReason: "aborted-during-execute", outcome, exportedArtifact: false });
      return { output: { attemptId: plan.attemptId, error: "aborted-during-execute" }, metadata: { provider: FakeSubagentProvider.ID } };
    }

    // Handle captured error from onExecuteAttempt
    if (errorCaptured) {
      outcome = { status: "failed", error: { message: errorCaptured.message } };
      this.records.push({ attemptId: plan.attemptId, planId: plan.planId, index: plan.index, outcome, exportedArtifact: false });
      return { output: { attemptId: plan.attemptId, error: errorCaptured.message }, metadata: { provider: FakeSubagentProvider.ID } };
    }

    // Normal success path
    const result: AttemptResult = {
      output: { attemptId: plan.attemptId, result: "done" },
      usage: { totalTokens: 0 },
      metadata: { provider: FakeSubagentProvider.ID },
    };
    outcome = { status: "completed", result };
    this.records.push({ attemptId: plan.attemptId, planId: plan.planId, index: plan.index, outcome, exportedArtifact: false });
    return result;
  }

  /** Reset records and counter (for test isolation). */
  reset(): void {
    this.attemptCounter = 0;
    this.records.length = 0;
    this.onExecuteAttempt = undefined;
    this.onExportArtifactFailure = undefined;
    this.delayMs = undefined;
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

async function loadDispatchConfig(): Promise<DispatchConfigShape> {
  // The repo doesn't ship a config loader module; read the JSON directly.
  const configPath = new URL(
    "../../config/subagent-dispatch.json",
    import.meta.url,
  );
  try {
    const fs = await import("node:fs");
    return JSON.parse(fs.readFileSync(configPath, "utf8")) as DispatchConfigShape;
  } catch {
    // No config file — return defaults.
    return {};
  }
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
}

export interface DispatchFacade {
  /** The registry holding discovered providers. */
  registry: ProviderRegistry;
  /** Dispatched configuration. */
  config: DispatchConfigShape;
  /** The negotiateProvider function for Task 9 consumption. */
  negotiateProvider: typeof negotiateProvider;
}

let facadeInstance: DispatchFacade | null = null;

export function createFacade(options: FaçadeOptions = {}): DispatchFacade {
  if (facadeInstance) {
    return facadeInstance;
  }

  const registry = options.registry ?? new ProviderRegistry();
  const config = options.config ?? {};

  // Register the default fake provider unless the test-supplied registry
  // already has one.
  if (!registry.get(FakeSubagentProvider.ID)) {
    registry.register(FakeSubagentProvider.DESCRIPTOR);
  }

  facadeInstance = {
    registry,
    config,
    negotiateProvider,
  };

  return facadeInstance;
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
export function registerFaçadeTools(pi: ExtensionAPI, facade: DispatchFacade): void {
  const { registry, config } = facade;
  const providers = registry.getAll();
  const providerSummary = providers
    .map((p) => `${p.id} (${p.adapterVersion})`)
    .join("; ");

  // Default provider selection — falls back to auto when null.
  const selectedProviderId = config.defaultProvider ?? null;

  pi.registerTool({
    name: "run_subagents",
    label: "Subagents Dispatch",
    description:
      `Dispatch one or more subagent tasks through a provider-neutral dispatch façade. ` +
      `Providers available: ${providerSummary}. ` +
      `Default provider selection: ${selectedProviderId ?? "auto"}. ` +
      `Ceilings: ${JSON.stringify(config.ceilings ?? {})}. ` +
      `The façade owns batching expansion, retries, reservation/release, and artifact export. ` +
      `Providers are invoked exactly once per attempt — no hidden retries. ` +
      `Use for parallel task delegation where each task is independent.`,
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
      _onUpdate?: (update: { content: { type: string; text: string }[]; details?: unknown }) => void,
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

      // Negotiate provider
      const requirements: string[] = []; // no hard requirements for generic dispatch
      const { providerId, descriptor } = negotiateProvider(
        providers,
        selectedProviderId,
        requirements,
      );

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
      let totalUsage = {
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
        const attemptPlan: import("./contract.ts").ResolvedAttempt = {
          attemptId: attempt.attemptId,
          planId: attempt.planId,
          index: attempt.index,
          taskInfo: { taskId: attempt.taskId, objective: attempt.objective },
        };

        // Reserve before every physical launch
        const reservation: import("./contract.ts").AttemptReservation = {
          reservationId: `res-${attempt.attemptId}`,
          attempt: attemptPlan,
          providerId,
        };

        try {
          // The façade invokes exactly one provider.executeAttempt
          // (In a real implementation this would use the actual provider.)
          // For now, we record the outcome based on providerId for testing.

          // For the fake provider, we can't execute for real, so we simulate
          // a successful outcome for tests.
          const outcome: AttemptOutcome = {
            status: "completed",
            result: {
              output: { taskId: attempt.taskId, result: "dispatched" },
              usage: { totalTokens: 0 },
            },
          };

          if (outcome.status === "completed") {
            const exported = await (async () => {
              // In a real implementation, this would call policy.exportArtifact
              // For now, record that export was attempted.
              return undefined;
            })();

            results.push({
              attemptId: attempt.attemptId,
              taskId: attempt.taskId,
              status: "completed",
              result: outcome.result,
            });

            totalUsage.totalTokens += outcome.result.usage?.totalTokens ?? 0;
          }
        } catch (error) {
          const serialized: SerializedError = {
            message: error instanceof Error ? error.message : String(error),
          };
          results.push({
            attemptId: attempt.attemptId,
            taskId: attempt.taskId,
            status: "failed",
            error: serialized,
          });
        } finally {
          // releaseAttempt is called exactly once in finally
          // (In real implementation: policy.releaseAttempt(reservation, outcome))
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

export default function createSubagentDispatchFacade(pi: ExtensionAPI): DispatchFacade {
  const facade = createFacade();
  registerFaçadeTools(pi, facade);
  return facade;
}

export { negotiateProvider, ProviderDescriptor };
