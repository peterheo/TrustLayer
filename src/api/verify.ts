import { config } from "../config.js";
import { TrustLayerError, toTrustLayerError } from "../errors.js";
import { buildReceipt } from "../evidence/receipt.js";
import {
  VerifyRequestSchema,
  type EvidenceReceipt,
  type VerifyRequest,
} from "../evidence/schemas.js";
import { validateAdjudications } from "../evidence/validator.js";
import { logger } from "../logging.js";
import { refusedCallsFrom } from "../sharedos/audit.js";
import { newTurnIdentifiers } from "../sharedos/context.js";
import { runVerificationTurn } from "../sharedos/executor.js";
import { createTrustLayerHost, type TrustLayerHost } from "../sharedos/kernel.js";
import { createVerifierDriver } from "../verifier/driver.js";
import { createVerifierModel, type VerifierModel } from "../verifier/model.js";
import { ProtocolState } from "../verifier/protocol.js";

/**
 * The service entry point: raw JSON in, an `EvidenceReceipt` out.
 *
 * The order of operations is the product:
 *
 *   validate the caller's payload
 *   mint host-side identifiers
 *   open an evidence ledger and register the caller's own citations
 *   run one bounded SharedOS turn under `trust.verify`, driven through
 *     PLAN -> DISCOVER -> FETCH -> CHALLENGE -> ADJUDICATE
 *   check the SharedOS *status* rather than assuming success
 *   VALIDATE every citation against evidence the ledger actually holds
 *   build the RECEIPT from trusted state only
 *
 * What the model contributed by the end is: which claims to check, which
 * searches to run, which pages to fetch, a judgment per claim, and some prose.
 * Everything the receipt presents as fact came from somewhere else.
 */

export interface VerifyOptions {
  /** Overrides the shared process host; tests pass an isolated one. */
  readonly host?: TrustLayerHost;
  /** Inject a model, chiefly so tests and demos can script one. */
  readonly model?: VerifierModel;
  readonly signal?: AbortSignal;
}

let sharedHost: TrustLayerHost | undefined;

/**
 * One kernel for the process, built on first use.
 *
 * Tool registration and grant wiring are per-host, not per-call. Concurrency
 * is safe because everything request-scoped — context, identifiers, evidence
 * ledger, protocol state — is created per call and keyed by trace id.
 */
export function defaultHost(): TrustLayerHost {
  sharedHost ??= createTrustLayerHost();
  return sharedHost;
}

export async function verify(
  rawRequest: unknown,
  options: VerifyOptions = {},
): Promise<EvidenceReceipt> {
  const parsed = VerifyRequestSchema.safeParse(rawRequest);
  if (!parsed.success) {
    throw new TrustLayerError("INVALID_INPUT", parsed.error.issues[0]?.message ?? "invalid request");
  }
  const request: VerifyRequest = parsed.data;

  const host = options.host ?? defaultHost();
  const model = options.model ?? createVerifierModel();

  // Host-side identifiers. The model never authors these.
  const { executionId, traceId } = newTurnIdentifiers();

  // A ledger scoped to this execution, so concurrent verifications cannot
  // validate each other's citations.
  const ledger = host.ledgers.open(traceId);
  // Registered before the turn: a fetch of one of these is a candidate
  // citation being checked, not independent evidence being gathered.
  ledger.registerCandidateCitations(request.sourceUrls ?? []);

  const protocol = new ProtocolState();
  const startedAt = Date.now();

  try {
    const driver = createVerifierDriver({
      model,
      request,
      ledger,
      protocol,
      // Leave one call of headroom below the SharedOS ceiling so the driver
      // can force adjudication rather than being cut off mid-protocol.
      toolCallBudget: Math.max(1, config.turn.maxToolCalls - 1),
    });

    const execution = await runVerificationTurn({
      host,
      driver,
      executionId,
      traceId,
      payload: { service: "trust.verify", maxClaims: request.maxClaims },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    // A SharedOS denial is not a verification. Inspect the status; never infer
    // success from the absence of a thrown error.
    if (execution.status !== "succeeded") {
      logger.warn("verification turn did not succeed", {
        executionId,
        traceId,
        sharedosStatus: execution.status,
        phase: protocol.phase,
        refusedCalls: refusedCallsFrom(execution.events),
      });
      const failureCode =
        "error" in execution && execution.error !== undefined ? execution.error.code : undefined;
      throw statusToError(execution.status, failureCode);
    }

    const { plan, adjudication } = driver.outcome;

    if (plan.length === 0) {
      throw new TrustLayerError("MODEL_OUTPUT_INVALID", "no verification plan was produced");
    }

    // VALIDATE. Runs over the plan, so a claim the model dropped shows up as
    // unverified rather than vanishing from the receipt.
    protocol.enter("validate");
    const { claims, report } = validateAdjudications(
      plan,
      adjudication?.adjudications ?? [],
      ledger,
    );
    protocol.complete("validate");

    // RECEIPT.
    protocol.enter("receipt");
    const receipt = buildReceipt({
      plan,
      claims,
      validation: report,
      ledger,
      protocol,
      execution,
      summary: adjudication?.summary ?? "The verifier did not return a summary.",
      modelDetectedInstructions: adjudication?.suspiciousInstructions.detected ?? false,
      modelIndicators: adjudication?.suspiciousInstructions.indicators ?? [],
      adjudicated: adjudication !== undefined,
    });
    protocol.complete("receipt");

    logger.info("verification complete", {
      executionId,
      traceId,
      reportId: receipt.reportId,
      methodVersion: receipt.methodVersion,
      sharedosStatus: execution.status,
      durationMs: Date.now() - startedAt,
      modelProvider: model.id,
      modelName: config.model.name,
      protocolStatus: receipt.protocolStatus,
      overallStatus: receipt.overallStatus,
      claimsSelected: receipt.coverage.claimsSelected,
      claimsChecked: receipt.coverage.claimsChecked,
      sourcesFetched: receipt.coverage.sourcesFetched,
      toolCallCount: protocol.totalToolCalls,
      fabricatedCitations: report.fabricatedEvidenceIds.length,
      downgradedClaims: report.downgradedClaimIds.length,
    });

    return receipt;
  } catch (thrown) {
    const error = toTrustLayerError(thrown);
    logger.error("verification failed", {
      executionId,
      traceId,
      durationMs: Date.now() - startedAt,
      phase: protocol.phase,
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
    // The verifier holds no escalation grant, so this should be unreachable.
    return new TrustLayerError("SHAREDOS_FAILURE", "turn escalated unexpectedly");
  }
  if (code === "driver_failed" || code === "adjudication_invalid") {
    return new TrustLayerError("MODEL_FAILURE", code);
  }
  return new TrustLayerError("SHAREDOS_FAILURE", code);
}
