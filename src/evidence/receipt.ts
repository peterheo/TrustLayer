import type { ExecutionResult } from "@aicoo/sharedos";

import { TRUST_VERIFY_PURPOSE } from "../sharedos/identity.js";
import { refusedCallsFrom, toolsUsedFrom } from "../sharedos/audit.js";
import type { ProtocolState } from "../verifier/protocol.js";
import { canonicalSha256, canonicalUrl, newReportId, sha256 } from "./digest.js";
import type { EvidenceLedger } from "./ledger.js";
import {
  METHOD_VERSION,
  type EvidenceReceipt,
  type ReceiptCounts,
  type ReceiptInput,
  type VerifyRequest,
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
 * least one source was retrieved, the challenge phase ran a real search *and
 * retrieved something it turned up* (or honestly found nothing to retrieve),
 * and adjudication and validation both finished. Anything less is `partial`,
 * and a receipt with no usable adjudication is `failed`. An incomplete run is
 * never dressed up as a confident verdict.
 */
export function deriveProtocolStatus(
  protocol: ProtocolState,
  checks: ReceiptChecks,
  adjudicated: boolean,
): ProtocolStatus {
  if (!adjudicated) return "failed";

  // A challenge that found leads and never opened one is not a completed
  // challenge, so `complete` needs the retrieval too — unless the search
  // honestly turned up nothing to retrieve.
  const challengeComplete = checks.contradictionSearchProducedCandidates
    ? checks.contradictionEvidenceFetched
    : checks.contradictionSearchPerformed;

  const required =
    protocol.completed("plan") &&
    protocol.completed("adjudicate") &&
    checks.independentSearchPerformed &&
    checks.sourcesFetched &&
    checks.contradictionSearchPerformed &&
    challengeComplete &&
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
    contradictionSearchProducedCandidates: protocol.challengeSearchProducedCandidates,
    // Cross-checked against the ledger: the phase stamped on a record is
    // written when the fetch happens, so this cannot be true unless a page was
    // really retrieved while the challenge phase was current.
    contradictionEvidenceFetched:
      protocol.challengeEvidenceFetched && ledger.evidenceFromPhase("challenge").length > 0,
    evidenceReferencesValidated: validation.completed,
  };
}

/** Arithmetic over the validated table, so the shape of the answer is readable. */
export function deriveCounts(claims: readonly ReceiptClaim[]): ReceiptCounts {
  const of = (status: string): number => claims.filter((claim) => claim.status === status).length;
  return {
    supported: of("supported"),
    contradicted: of("contradicted"),
    unverified: of("unverified"),
    notFalsifiable: of("not_falsifiable"),
  };
}

/**
 * Retrievals that were not a new source.
 *
 * Counted two ways, because a source can repeat under either: the same
 * canonical URL fetched twice, and two different URLs that returned
 * byte-identical text — a mirror, a syndication, or the same page behind a
 * redirect. Either way it is one source, and a claim resting on "two" of them
 * is resting on one.
 */
export function countDuplicateSources(ledger: EvidenceLedger): number {
  const seenUrls = new Set<string>();
  const seenDigests = new Set<string>();
  let duplicates = 0;

  for (const record of ledger.listEvidence()) {
    const url = canonicalUrl(record.resolvedUrl);
    const repeated = seenUrls.has(url) || seenDigests.has(record.contentSha256);
    if (repeated) duplicates += 1;
    seenUrls.add(url);
    seenDigests.add(record.contentSha256);
  }

  return duplicates;
}

/** What was submitted, pinned so a receipt cannot be re-pointed at other input. */
export function deriveInput(request: VerifyRequest): ReceiptInput {
  return {
    candidateOutputSha256: sha256(request.candidateOutput),
    requestSha256: canonicalSha256(request),
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
    duplicateSources: countDuplicateSources(ledger),
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
  /** The validated request, so the receipt can pin what was submitted. */
  readonly request: VerifyRequest;
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

  const receipt: Omit<EvidenceReceipt, "receiptSha256"> = {
    reportId: newReportId(),
    methodVersion: METHOD_VERSION,
    input: deriveInput(input.request),
    protocolStatus,
    overallStatus: deriveOverallStatus(claims),
    summary: input.summary,
    counts: deriveCounts(claims),
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
      permissionDenials: refusedCallsFrom(execution.events).length,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      durationMs:
        Number.isFinite(started) && Number.isFinite(completed) ? completed - started : 0,
    },
    ...(protocol.failures.length > 0 ? { incompletePhases: [...protocol.failures] } : {}),
  };

  // Computed last, over everything above it.
  return { ...receipt, receiptSha256: canonicalSha256(receipt) };
}

/**
 * Recompute a receipt's digest and compare.
 *
 * Exported because a claim a holder cannot check is worth little: this is the
 * same arithmetic the issuer did, over the same canonical bytes.
 */
export function verifyReceiptDigest(receipt: EvidenceReceipt): boolean {
  const { receiptSha256, ...rest } = receipt;
  return canonicalSha256(rest) === receiptSha256;
}
