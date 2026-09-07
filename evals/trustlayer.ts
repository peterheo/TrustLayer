import { verify } from "../src/api/verify.js";
import type { ClaimStatus, EvidenceReceipt } from "../src/evidence/schemas.js";
import { toolInvocationCount } from "../src/sharedos/audit.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import type { ModelUsage, VerifierModel } from "../src/verifier/model.js";
import { subtractUsage, usageOf } from "./metering.js";
import type { EvalCase } from "./cases/index.js";
import type { EvalWorld } from "./world.js";

/**
 * Running one case through the real TrustLayer protocol.
 *
 * The case's focus claim is passed as `focusClaims`, so both systems are
 * judged on exactly the same proposition. A fresh host per case keeps ledgers,
 * audit sinks and protocol state isolated.
 */

export interface TrustLayerRunResult {
  readonly status: ClaimStatus;
  readonly receipt?: EvidenceReceipt;
  readonly latencyMs: number;
  /** Tool calls the kernel actually recorded, not distinct tool names. */
  readonly toolCalls: number;
  readonly sourcesFetched: number;
  /** Model rounds and tokens this case cost. */
  readonly usage: ModelUsage;
  readonly errorCode?: string;
}

export async function runTrustLayer(
  testCase: EvalCase,
  world: EvalWorld,
  model: VerifierModel,
  signal: AbortSignal,
): Promise<TrustLayerRunResult> {
  const host = createTrustLayerHost({
    searchBackend: world.backend,
    resolveHost: world.resolveHost,
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = world.fetch;
  const started = Date.now();
  // Models are reused across cases; this case's spend is the delta.
  const usageBefore = usageOf(model);

  try {
    const receipt = await verify(
      {
        task: testCase.task,
        candidateOutput: testCase.candidateOutput,
        focusClaims: [testCase.focusClaim],
        maxClaims: 1,
        ...(testCase.sourceUrls === undefined ? {} : { sourceUrls: [...testCase.sourceUrls] }),
      },
      { host, model, signal },
    );

    return {
      status: receipt.claims[0]?.status ?? "unverified",
      receipt,
      latencyMs: Date.now() - started,
      // From the kernel's audit sink. `provenance.toolsUsed` is a list of
      // distinct names — never more than two — and using its length as a call
      // count would understate TrustLayer's spend against a cheaper baseline.
      toolCalls: toolInvocationCount(host.audit.events),
      sourcesFetched: receipt.coverage.sourcesFetched,
      usage: subtractUsage(usageOf(model), usageBefore),
    };
  } catch (thrown) {
    const code =
      typeof thrown === "object" && thrown !== null && "code" in thrown
        ? String((thrown as { code: unknown }).code)
        : "INTERNAL_ERROR";
    return {
      // A failed run is not a verdict. Scored as `unverified`, which is what
      // the caller would actually be left with.
      status: "unverified",
      latencyMs: Date.now() - started,
      // A failed run still spent whatever it spent before failing, and the
      // cost comparison has to carry that rather than write it off.
      toolCalls: toolInvocationCount(host.audit.events),
      sourcesFetched: 0,
      usage: subtractUsage(usageOf(model), usageBefore),
      errorCode: code,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
