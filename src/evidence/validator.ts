import type { EvidenceLedger } from "./ledger.js";
import type {
  ClaimAdjudication,
  EvidenceReference,
  PlannedClaim,
  ReceiptClaim,
  ReceiptEvidenceSpan,
} from "./schemas.js";

/**
 * Provenance validation: the step where the host stops believing the model.
 *
 * The model may assert that a claim is supported and cite `e7` as the reason.
 * That assertion is worth exactly as much as `e7` being a source this
 * execution actually retrieved. So every citation is looked up in the ledger,
 * and a judgment whose support does not survive that lookup does not survive
 * either.
 *
 * Downgrades always move toward `unverified`, never toward `contradicted`:
 * evidence that turns out not to exist is missing evidence, and missing
 * evidence is not disproof.
 *
 * Independence is enforced here too. TrustLayer is sold as independent
 * verification, so a claim cannot end up `supported` on the strength of a
 * source the candidate handed us: that is the candidate agreeing with itself,
 * and a prompt asking the model to bear it in mind is not an enforcement
 * mechanism. Contradiction is deliberately not held to the same rule — a
 * candidate's own cited source refuting its claim is among the most damning
 * evidence there is, and refusing to count it would protect the error.
 */

export interface ValidationReport {
  /** Evidence IDs the model cited that the ledger never minted. */
  readonly fabricatedEvidenceIds: readonly string[];
  /** Adjudications whose claimId matched no planned claim. */
  readonly unknownClaimIds: readonly string[];
  /** Claim IDs downgraded for want of surviving evidence. */
  readonly downgradedClaimIds: readonly string[];
  /** Claims that had support, but only from the candidate's own sources. */
  readonly candidateOnlySupportClaimIds: readonly string[];
  /** Planned claims the model never adjudicated at all. */
  readonly unadjudicatedClaimIds: readonly string[];
  /** True when validation ran to completion over every planned claim. */
  readonly completed: boolean;
}

export interface ValidationResult {
  readonly claims: readonly ReceiptClaim[];
  readonly report: ValidationReport;
}

/**
 * A citation counts only if it points at evidence the ledger holds.
 *
 * The proposed `quote` is dropped here whatever happens to it: an unverified
 * quote must never reach the receipt, and a verified one reaches it as a span
 * with host-computed offsets instead.
 */
function keepRealCitations(
  references: readonly EvidenceReference[],
  ledger: EvidenceLedger,
  fabricated: Set<string>,
): EvidenceReference[] {
  const kept: EvidenceReference[] = [];
  for (const reference of references) {
    if (ledger.hasEvidence(reference.evidenceId)) {
      const { quote: _quote, ...withoutQuote } = reference;
      kept.push(withoutQuote);
    } else {
      fabricated.add(reference.evidenceId);
    }
  }
  return kept;
}

/**
 * Prove the quotes, or drop them.
 *
 * A span is produced only when the proposed passage appears verbatim in the
 * exact quarantined text that was retrieved — the same text the content digest
 * covers. Nothing here approximates, normalises whitespace, or searches other
 * sources for a match: a quote attributed to the wrong page is as wrong as one
 * that was never written.
 */
export function verifyQuotes(
  references: readonly EvidenceReference[],
  ledger: EvidenceLedger,
): readonly ReceiptEvidenceSpan[] {
  const spans: ReceiptEvidenceSpan[] = [];

  for (const reference of references) {
    const quote = reference.quote;
    if (quote === undefined || quote.length === 0) continue;

    const record = ledger.getEvidence(reference.evidenceId);
    if (record === undefined) continue;

    const start = record.extractedText.indexOf(quote);
    if (start < 0) continue;

    spans.push({
      evidenceId: reference.evidenceId,
      excerpt: quote,
      start,
      end: start + quote.length,
    });
  }

  return spans;
}

/**
 * Whether a set of surviving citations contains real independent support.
 *
 * "Independent" is the ledger's own classification of how the source came to
 * be retrieved, not a property the model can assert: a URL the caller supplied
 * stays a candidate citation even when a later search rediscovers it.
 */
export function hasIndependentSupport(
  references: readonly EvidenceReference[],
  ledger: EvidenceLedger,
): boolean {
  return references.some((reference) => {
    if (reference.relation !== "supports") return false;
    return ledger.getEvidence(reference.evidenceId)?.origin === "independent";
  });
}

/**
 * Validate one adjudication against the plan and the ledger.
 *
 * A `supported` claim needs at least one surviving citation whose relation is
 * `supports`, and at least one of those must be independent evidence; a
 * `contradicted` claim needs one whose relation is `contradicts`, from either
 * origin. A model that cites a real source but with the wrong relation has not
 * established what it says it has, so that is a downgrade too.
 */
function validateOne(
  planned: PlannedClaim,
  adjudication: ClaimAdjudication | undefined,
  ledger: EvidenceLedger,
  fabricated: Set<string>,
  downgraded: string[],
  candidateOnly: string[],
): ReceiptClaim {
  if (adjudication === undefined) {
    return {
      claimId: planned.claimId,
      claim: planned.text,
      importance: planned.importance,
      status: "unverified",
      confidence: 0,
      rationale: "The verifier did not return a judgment for this claim.",
      evidence: [],
      adjusted: "No adjudication was returned for this planned claim.",
    };
  }

  const evidence = keepRealCitations(adjudication.evidence, ledger, fabricated);
  // Quotes are checked against the citations that survived, so a quote cannot
  // ride into the receipt on a fabricated evidence id.
  const spans = verifyQuotes(
    adjudication.evidence.filter((reference) => ledger.hasEvidence(reference.evidenceId)),
    ledger,
  );

  const base: ReceiptClaim = {
    claimId: planned.claimId,
    claim: planned.text,
    importance: planned.importance,
    status: adjudication.status,
    confidence: adjudication.confidence,
    rationale: adjudication.rationale,
    evidence,
    ...(spans.length === 0 ? {} : { spans }),
  };

  if (adjudication.status === "supported" || adjudication.status === "contradicted") {
    const needed = adjudication.status === "supported" ? "supports" : "contradicts";
    const hasUsableEvidence = evidence.some((reference) => reference.relation === needed);

    if (!hasUsableEvidence) {
      downgraded.push(planned.claimId);
      return {
        ...base,
        status: "unverified",
        confidence: Math.min(adjudication.confidence, 0.3),
        evidence,
        adjusted:
          `Reported as ${adjudication.status}, but no retrieved source in this execution ` +
          `${needed} the claim. Downgraded to unverified.`,
      };
    }

    // Support has to come from somewhere other than the thing under test.
    // The candidate's own source stays in the receipt — it is a real
    // retrieval and the reader should see it — but it cannot carry the
    // verdict on its own.
    if (adjudication.status === "supported" && !hasIndependentSupport(evidence, ledger)) {
      downgraded.push(planned.claimId);
      candidateOnly.push(planned.claimId);
      return {
        ...base,
        status: "unverified",
        confidence: Math.min(adjudication.confidence, 0.3),
        evidence,
        adjusted:
          "Candidate-supplied evidence supports this claim, but no independent supporting " +
          "source was retrieved. Downgraded to unverified.",
      };
    }
  }

  return base;
}

/**
 * Validate every planned claim.
 *
 * Iteration is over the *plan*, not over what the model returned, so a claim
 * the model quietly dropped shows up as unverified rather than disappearing
 * from the receipt. Coverage that is missing should look missing.
 */
export function validateAdjudications(
  plan: readonly PlannedClaim[],
  adjudications: readonly ClaimAdjudication[],
  ledger: EvidenceLedger,
): ValidationResult {
  const byClaimId = new Map(adjudications.map((entry) => [entry.claimId, entry]));
  const plannedIds = new Set(plan.map((claim) => claim.claimId));

  const fabricated = new Set<string>();
  const downgraded: string[] = [];
  const candidateOnly: string[] = [];
  const unadjudicated: string[] = [];

  const claims = plan.map((planned) => {
    const adjudication = byClaimId.get(planned.claimId);
    if (adjudication === undefined) unadjudicated.push(planned.claimId);
    return validateOne(planned, adjudication, ledger, fabricated, downgraded, candidateOnly);
  });

  // Judgments about claims nobody planned are discarded rather than reported:
  // the caller asked about the plan, and an invented claim is not coverage.
  const unknownClaimIds = adjudications
    .map((entry) => entry.claimId)
    .filter((claimId) => !plannedIds.has(claimId));

  return {
    claims,
    report: {
      fabricatedEvidenceIds: [...fabricated],
      unknownClaimIds,
      downgradedClaimIds: downgraded,
      candidateOnlySupportClaimIds: candidateOnly,
      unadjudicatedClaimIds: unadjudicated,
      completed: true,
    },
  };
}
