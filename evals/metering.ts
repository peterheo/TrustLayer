import {
  ZERO_USAGE,
  reportsUsage,
  type ModelObservation,
  type ModelStep,
  type ModelTurnRequest,
  type ModelUsage,
  type UsageReporting,
  type VerifierModel,
  type VerifierModelSession,
} from "../src/verifier/model.js";

/**
 * Measuring what a verification actually spends.
 *
 * The benchmark's whole claim is verification value *per unit cost*, so the
 * cost side has to be measured rather than assumed. Two things are counted
 * here:
 *
 * - **Model calls**, by wrapping the model port. Counting rounds this way
 *   works for any provider, including the scripted models the selftest uses,
 *   because it counts what the driver asked for rather than what a vendor
 *   reports.
 * - **Tokens**, passed through from a provider that reports them. A provider
 *   that does not leaves them at zero; nothing invents them.
 *
 * Model instances are shared across cases, so per-case figures are deltas
 * between two snapshots rather than per-instance totals.
 */

export function subtractUsage(after: ModelUsage, before: ModelUsage): ModelUsage {
  return {
    calls: after.calls - before.calls,
    inputTokens: after.inputTokens - before.inputTokens,
    outputTokens: after.outputTokens - before.outputTokens,
  };
}

export function addUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    calls: left.calls + right.calls,
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
  };
}

/** The usage a model reports, or zeros if it reports none. */
export function usageOf(model: unknown): ModelUsage {
  return reportsUsage(model) ? model.usage : ZERO_USAGE;
}

/**
 * A verifier model that counts the rounds it was asked for.
 *
 * Transparent to the driver: it forwards every call unchanged, so the protocol
 * under measurement is the real one.
 */
export class MeteredVerifierModel implements VerifierModel, UsageReporting {
  readonly id: string;
  readonly #inner: VerifierModel;
  #calls = 0;

  constructor(inner: VerifierModel) {
    this.#inner = inner;
    this.id = `metered:${inner.id}`;
  }

  get usage(): ModelUsage {
    const inner = usageOf(this.#inner);
    // Calls are counted here rather than taken from the provider, so a
    // scripted model is measured the same way a real one is.
    return { ...inner, calls: this.#calls };
  }

  async start(request: ModelTurnRequest, signal: AbortSignal): Promise<VerifierModelSession> {
    const session = await this.#inner.start(request, signal);
    const count = (): void => {
      this.#calls += 1;
    };

    return {
      async next(observation: ModelObservation, innerSignal: AbortSignal): Promise<ModelStep> {
        count();
        return session.next(observation, innerSignal);
      },
    };
  }
}
