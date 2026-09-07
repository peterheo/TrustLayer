import type { ExecutionResult } from "@aicoo/sharedos";

import { TRUST_VERIFY_PURPOSE } from "../sharedos/identity.js";
import { toolsUsedFrom } from "../sharedos/audit.js";
import type { ProtocolState } from "../verifier/protocol.js";
import { newReportId } from "./digest.js";
import type { EvidenceLedger } from "./ledger.js";
import {
  METHOD_VERSION,
  type EvidenceReceipt,
  type OverallStatus,
  type PlannedClaim,
  type ProtocolStatus,
  type ReceiptChecks,
  type ReceiptClaim,
  type ReceiptCoverage,
  type ReceiptEvidence,
  type ReceiptSecurity,
} from "./schemas.js";
import type { ValidationReport } from "./validator.js";

/**
 * Assembling the deliverable.
 *
 * Everything here is derived from trusted state: the plan the host built, the
 * claims the validator approved, the ledger's own record of what was
 * retrieved, the protocol's record of which phases ran, and the SharedOS
 * execution result. The model contributes the summary text and its indicator
 * notes; it contributes nothing that the receipt presents as fact.
 */

/**
 * The overall status.
 *
 * Ordered rules over the claim table, most severe first. There is deliberately
 * no scalar: a number like 87 reads as "87% likely true", which is exactly the
 * claim TrustLayer refuses to make. What the caller gets instead is which
 * claims held, which did not, and what was actually retrieved.
 */
export function deriveOverallStatus(claims: readonly ReceiptClaim[]): OverallStatus {
  const falsifiable = claims.filter((claim) => claim.status !== "not_falsifiable");
  if (falsifiable.length === 0) return "unverified";

  const contradicted = falsifiable.filter((claim) => claim.status === "contradicted");
  const supported = falsifiable.filter((claim) => claim.status === "supported");

  // A contradicted claim the caller was going to act on decides this alone.
  const criticalContradicted = contradicted.some((claim) => claim.importance === "critical");
  if (criticalContradicted) return "contradicted";
  if (contradicted.length > 0 && contradicted.length >= supported.length) return "contradicted";
  if (contradicted.length > 0) return "mixed";

  if (supported.length === 0) return "unverified";
  if (supported.length === falsifiable.length) return "supported";
  return "mixed";
}

/**
 * Whether the protocol actually ran.
 *
 * `complete` requires that the plan was made, an independent search ran, at
 * least one source was retrieved, the challenge phase ran a real search, and
 * adjudication and validation both finished. Anything less is `partial`, and
 * a receipt with no usable adjudication is `failed`. An incomplete run is
 * never dressed up as a confident verdict.
 */
export function deriveProtocolStatus(
  protocol: ProtocolState,
  checks: ReceiptChecks,
  adjudicated: boolean,
): ProtocolStatus {
  if (!adjudicated) return "failed";

  const required =
    protocol.completed("plan") &&
    protocol.completed("adjudicate") &&
    checks.independentSearchPerformed &&
    checks.sourcesFetched &&
    checks.contradictionSearchPerformed &&
    checks.evidenceReferencesValidated;

  if (!required) return "partial";
  return protocol.failures.length > 0 ? "partial" : "complete";
}

/**
 * The protocol checks.
 *
 * Every field is computed from observed state. `candidateCitationsChecked` is
 * true only when the caller actually supplied citations and at least one was
 * retrieved — a run with nothing to check reports false rather than claiming
 * credit for work it did not do.
 */
export function deriveChecks(
  protocol: ProtocolState,
  ledger: EvidenceLedger,
  validation: ValidationReport,
): ReceiptChecks {
  return {
    independentSearchPerformed: protocol.independentSearchPerformed,
    sourcesFetched: protocol.sourcesFetched,
    candidateCitationsChecked:
      ledger.candidateCitationCount > 0 && ledger.fetchedCandidateCitations().length > 0,
    contradictionSearchPerformed: protocol.contradictionSearchPerformed,
    evidenceReferencesValidated: validation.completed,
  };
}

export function deriveCoverage(
  plan: readonly PlannedClaim[],
  claims: readonly ReceiptClaim[],
  ledger: EvidenceLedger,
): ReceiptCoverage {
  // "Checked" means the claim ended with real evidence behind it, not merely
  // that the model returned a row for it.
  const checked = claims.filter((claim) => claim.evidence.length > 0);
  const critical = plan.filter((claim) => claim.importance === "critical");
  const criticalChecked = checked.filter((claim) => claim.importance === "critical");

  return {
    claimsSelected: plan.length,
    claimsChecked: checked.length,
    criticalClaimsTotal: critical.length,
    criticalClaimsChecked: criticalChecked.length,
    searchCandidates: ledger.candidateCount,
    sourcesFetched: ledger.evidenceCount,
    distinctDomains: ledger.distinctDomains(),
  };
}

/** Only evidence that was actually retrieved appears. Text is not included. */
export function evidenceForReceipt(ledger: EvidenceLedger): readonly ReceiptEvidence[] {
  return ledger.listEvidence().map((record) => ({
    evidenceId: record.evidenceId,
    url: record.url,
    resolvedUrl: record.resolvedUrl,
    domain: record.domain,
    ...(record.title === undefined ? {} : { title: record.title }),
    retrievedAt: record.retrievedAt,
    contentSha256: record.contentSha256,
    origin: record.origin,
  }));
}

/**
 * The security block.
 *
 * Combines what the quarantine layer saw in retrieved pages with what the
 * model reported about the candidate output. Both are observations; neither is
 * the guarantee. The guarantee is that the verifier held no capability the
 * instructions could have used, and that is visible in `provenance.toolsUsed`.
 */
export function deriveSecurity(
  ledger: EvidenceLedger,
  modelDetected: boolean,
  modelIndicators: readonly string[],
  validation: ValidationReport,
): ReceiptSecurity {
  const indicators: string[] = [...modelIndicators];

  const flagged = ledger.listEvidence().filter((record) => record.instructionLikeContent);
  for (const record of flagged) {
    indicators.push(
      `Retrieved page ${record.evidenceId} (${record.domain}) contains instruction-like content.`,
    );
  }

  if (validation.fabricatedEvidenceIds.length > 0) {
    indicators.push(
      `The verifier cited ${validation.fabricatedEvidenceIds.length} evidence ID(s) that were ` +
        `never retrieved in this execution; those citations were discarded.`,
    );
  }

  return {
    suspiciousInstructionsDetected: modelDetected || flagged.length > 0,
    indicators: indicators.slice(0, 20),
  };
}

export interface BuildReceiptInput {
  readonly plan: readonly PlannedClaim[];
  readonly claims: readonly ReceiptClaim[];
  readonly validation: ValidationReport;
  readonly ledger: EvidenceLedger;
  readonly protocol: ProtocolState;
  readonly execution: ExecutionResult;
  readonly summary: string;
  readonly modelDetectedInstructions: boolean;
  readonly modelIndicators: readonly string[];
  readonly adjudicated: boolean;
}

export function buildReceipt(input: BuildReceiptInput): EvidenceReceipt {
  const { execution, ledger, protocol, plan, claims, validation } = input;

  const checks = deriveChecks(protocol, ledger, validation);
  const protocolStatus = deriveProtocolStatus(protocol, checks, input.adjudicated);

  const started = Date.parse(execution.startedAt);
  const completed = Date.parse(execution.completedAt);

  return {
    reportId: newReportId(),
    methodVersion: METHOD_VERSION,
    protocolStatus,
    overallStatus: deriveOverallStatus(claims),
    summary: input.summary,
    claims,
    evidence: evidenceForReceipt(ledger),
    coverage: deriveCoverage(plan, claims, ledger),
    checks,
    security: deriveSecurity(
      ledger,
      input.modelDetectedInstructions,
      input.modelIndicators,
      validation,
    ),
    provenance: {
      purpose: TRUST_VERIFY_PURPOSE,
      executionId: execution.executionId,
      traceId: execution.traceId,
      sharedosStatus: execution.status,
      toolsUsed: toolsUsedFrom(execution.events),
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      durationMs:
        Number.isFinite(started) && Number.isFinite(completed) ? completed - started : 0,
    },
    ...(protocol.failures.length > 0 ? { incompletePhases: [...protocol.failures] } : {}),
  };
}
