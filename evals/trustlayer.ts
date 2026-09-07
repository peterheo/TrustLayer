import { verify } from "../src/api/verify.js";
import type { ClaimStatus, EvidenceReceipt } from "../src/evidence/schemas.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import type { VerifierModel } from "../src/verifier/model.js";
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
  readonly toolCalls: number;
  readonly sourcesFetched: number;
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
      toolCalls: receipt.provenance.toolsUsed.length,
      sourcesFetched: receipt.coverage.sourcesFetched,
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
      toolCalls: 0,
      sourcesFetched: 0,
      errorCode: code,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
}
