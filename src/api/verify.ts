import { buildVerifierTask } from "../agent/verifier-prompt.js";
import { createVerifierDriver } from "../agent/verifier-driver.js";
import { createVerifierModel, type VerifierModel } from "../agent/model.js";
import { config } from "../config.js";
import { TrustLayerError, toTrustLayerError } from "../errors.js";
import { logger } from "../logging.js";
import { deriveAudit, refusedCallsFrom } from "../sharedos/audit.js";
import { newTurnIdentifiers } from "../sharedos/context.js";
import { runVerificationTurn } from "../sharedos/executor.js";
import { createTrustLayerHost, type TrustLayerHost } from "../sharedos/kernel.js";
import { capClaims, normalizeJudgment } from "../verification/normalize.js";
import {
  VerifierJudgmentSchema,
  VerifyRequestSchema,
  type VerifyRequest,
  type VerifyResponse,
} from "../verification/schemas.js";
import { scoreJudgment } from "../verification/scoring.js";

/**
 * The service entry point: raw JSON in, `VerifyResponse` out.
 *
 * The order of operations is the product. Validate the caller's payload; mint
 * host-side identifiers; open an evidence ledger; run one bounded SharedOS
 * turn under `trust.verify`; check the SharedOS *status* rather than assuming
 * success; parse the model's judgment through its narrow schema; validate
 * every citation against evidence the tools actually returned; only then
 * compute the score and verdict; and derive the audit block from the real
 * execution record.
 */

export interface VerifyOptions {
  /** Overrides the shared process host; tests pass an isolated one. */
  readonly host?: TrustLayerHost;
  /** Inject a model, chiefly so tests can script one. */
  readonly model?: VerifierModel;
  readonly signal?: AbortSignal;
}

let sharedHost: TrustLayerHost | undefined;

/**
 * One kernel for the process, built on first use.
 *
 * Tool registration and grant wiring are per-host, not per-call, and the audit
 * sink is only useful if it outlives a single request. Concurrency is safe
 * because everything request-scoped — the context, the identifiers, the
 * evidence ledger — is keyed by trace id rather than held on the host.
 */
export function defaultHost(): TrustLayerHost {
  sharedHost ??= createTrustLayerHost();
  return sharedHost;
}

export async function verify(
  rawRequest: unknown,
  options: VerifyOptions = {},
): Promise<VerifyResponse> {
  // 1. Validate caller input before anything is spent on it.
  const parsed = VerifyRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    throw new TrustLayerError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "invalid request");
  }
  const request: VerifyRequest = parsed.data;

  const host = options.host ?? defaultHost();
  const model = options.model ?? createVerifierModel();

  // 2. Host-side identifiers. The model never authors these.
  const { executionId, traceId } = newTurnIdentifiers();

  // 3. A ledger scoped to this execution, so concurrent turns cannot validate
  //    each other's citations.
  const ledger = host.ledgers.open(traceId);

  const startedAt = Date.now();

  try {
    // 4-5. One bounded turn, purpose `trust.verify`.
    const result = await runVerificationTurn({
      host,
      driver: createVerifierDriver(model),
      executionId,
      traceId,
      payload: { task: buildVerifierTask(request), maxClaims: request.maxClaims },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const audit = deriveAudit(result);

    // 6. A SharedOS denial is not a verification. Inspect the status, never
    //    infer success from the absence of a thrown error.
    if (result.status !== "succeeded") {
      logger.warn("verification turn did not succeed", {
        executionId,
        traceId,
        sharedosStatus: result.status,
        refusedCalls: refusedCallsFrom(result.events),
      });
      const failureCode =
        "error" in result && result.error !== undefined ? result.error.code : undefined;
      throw statusToError(result.status, failureCode);
    }

    // 7. The model's output, through its own narrow schema.
    const judged = VerifierJudgmentSchema.safeParse(result.output);
    if (!judged.success) {
      logger.warn("verifier judgment failed validation", {
        executionId,
        traceId,
        issue: judged.error.issues[0]?.message,
      });
      throw new TrustLayerError("MODEL_OUTPUT_INVALID", judged.error.issues[0]?.message);
    }

    // 8-9. Citations checked against evidence the tools actually returned;
    //      claims that lose their support are downgraded, never promoted.
    const { judgment, report } = normalizeJudgment(judged.data, ledger);
    const claims = capClaims(judgment.claims, request.maxClaims);

    // 10-11. Score and verdict, computed here rather than asked of the model.
    const { trustScore, verdict } = scoreJudgment(claims);

    const response: VerifyResponse = {
      verdict,
      trustScore,
      summary: judgment.summary,
      claims,
      security: judgment.security,
      // 12. Audit from the real execution record.
      audit,
    };

    logger.info("verification complete", {
      executionId,
      traceId,
      sharedosStatus: result.status,
      durationMs: Date.now() - startedAt,
      modelProvider: model.id,
      modelName: config.model.name,
      claimCount: claims.length,
      toolCallCount: audit.toolsUsed.length,
      evidenceCount: ledger.size,
      fabricatedCitations: report.fabricatedSourceIds.length,
      downgradedClaims: report.downgradedClaims.length,
      verdict,
      trustScore,
    });

    return response;
  } catch (thrown) {
    const error = toTrustLayerError(thrown);
    logger.error("verification failed", {
      executionId,
      traceId,
      durationMs: Date.now() - startedAt,
      errorCode: error.code,
      detail: error.detail,
    });
    throw error;
  } finally {
    host.ledgers.close(traceId);
  }
}

function statusToError(status: string, code: string | undefined): TrustLayerError {
  if (status === "denied") return new TrustLayerError("SHAREDOS_DENIED", code);
  if (status === "cancelled") return new TrustLayerError("VERIFICATION_TIMEOUT", code);
  if (status === "escalated") {
    // The verifier holds no escalation grant, so this should be unreachable;
    // treated as a failure rather than silently returned as a verification.
    return new TrustLayerError("SHAREDOS_FAILURE", "turn escalated unexpectedly");
  }
  if (code === "driver_failed") return new TrustLayerError("MODEL_FAILURE", code);
  return new TrustLayerError("SHAREDOS_FAILURE", code);
}
