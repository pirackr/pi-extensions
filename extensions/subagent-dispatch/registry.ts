/**
 * Provider registry — load-order-independent discovery via EventBus.
 *
 * Because `pi.events` (bus.emit) is synchronous and returns void, provider
 * listeners append their descriptors (or promises) directly to the caller-owned
 * collection envelope. The caller then awaits any promises and collects
 * descriptors. The bus stores no registry or mutable policy state.
 */

import type { ProviderDescriptor } from "./contract.ts";

// ---------------------------------------------------------------------------
// EventBus — synchronous, no internal state
// ---------------------------------------------------------------------------

interface EventBus {
  /**
   * Emit an event, passing an envelope that listeners can synchronously
   * append descriptors or promises to.
   *
   * @param event  event name (e.g. "subagent-dispatch-provider-discovered")
   * @param data   payload carrying the envelope
   */
  emit(event: string, data: Record<string, unknown>): void;
}

// ---------------------------------------------------------------------------
// Registry — in-memory store of discovered providers
// ---------------------------------------------------------------------------

class ProviderRegistry {
  private descriptors = new Map<string, ProviderDescriptor>();

  /** Register a provider descriptor directly. Used by the façade's own
   * provider or by tests. */
  register(descriptor: ProviderDescriptor): void {
    if (this.descriptors.has(descriptor.id)) {
      throw new Error(
        `Duplicate provider id: "${descriptor.id}". Providers must have unique IDs.`,
      );
    }
    this.descriptors.set(descriptor.id, descriptor);
  }

  /** Get all descriptors (load-order independent). */
  getAll(): ReadonlyArray<ProviderDescriptor> {
    return Array.from(this.descriptors.values());
  }

  /** Get a specific provider by id. */
  get(id: string): ProviderDescriptor | undefined {
    return this.descriptors.get(id);
  }

  /** Remove all entries (for test teardown). */
  clear(): void {
    this.descriptors.clear();
  }

  /** Count registered providers. */
  get size(): number {
    return this.descriptors.size;
  }
}

// ---------------------------------------------------------------------------
// EventBus-based collection helper
// ---------------------------------------------------------------------------

/**
 * Collect provider descriptors from an EventBus emit.
 *
 * The EventBus emits an event carrying an envelope object. Listeners
 * synchronously push descriptors or promises onto that envelope. This
 * function awaits any promises and returns the collected descriptors.
 *
 * @param bus        the pi events bus
 * @param eventName  the event name to emit and collect from
 * @returns          array of descriptors (may include duplicates — caller dedupes)
 */
export async function collectProviderDescriptors(
  bus: EventBus,
  eventName: string,
): Promise<ReadonlyArray<ProviderDescriptor>> {
  const envelope: {
    descriptors: (ProviderDescriptor | Promise<ProviderDescriptor>)[];
  } = { descriptors: [] };
  bus.emit(eventName, { envelope });
  const results: ProviderDescriptor[] = [];
  for (const entry of envelope.descriptors) {
    if (entry instanceof Promise) {
      results.push(await entry);
    } else {
      results.push(entry);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export { ProviderRegistry };
