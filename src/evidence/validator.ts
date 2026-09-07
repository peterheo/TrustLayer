import type { EvidenceLedger } from "./ledger.js";
import type {
  ClaimAdjudication,
  EvidenceReference,
  PlannedClaim,
  ReceiptClaim,
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
 */

export interface ValidationReport {
  /** Evidence IDs the model cited that the ledger never minted. */
  readonly fabricatedEvidenceIds: readonly string[];
  /** Adjudications whose claimId matched no planned claim. */
  readonly unknownClaimIds: readonly string[];
  /** Claim IDs downgraded for want of surviving evidence. */
  readonly downgradedClaimIds: readonly string[];
  /** Planned claims the model never adjudicated at all. */
  readonly unadjudicatedClaimIds: readonly string[];
  /** True when validation ran to completion over every planned claim. */
  readonly completed: boolean;
}

export interface ValidationResult {
  readonly claims: readonly ReceiptClaim[];
  readonly report: ValidationReport;
}

/** A citation counts only if it points at evidence the ledger holds. */
function keepRealCitations(
  references: readonly EvidenceReference[],
  ledger: EvidenceLedger,
  fabricated: Set<string>,
): EvidenceReference[] {
  const kept: EvidenceReference[] = [];
  for (const reference of references) {
    if (ledger.hasEvidence(reference.evidenceId)) {
      kept.push(reference);
    } else {
      fabricated.add(reference.evidenceId);
    }
  }
  return kept;
}

/**
 * Validate one adjudication against the plan and the ledger.
 *
 * A `supported` claim needs at least one surviving citation whose relation is
 * `supports`; a `contradicted` claim needs one whose relation is `contradicts`.
 * A model that cites a real source but with the wrong relation has not
 * established what it says it has, so that is a downgrade too.
 */
function validateOne(
  planned: PlannedClaim,
  adjudication: ClaimAdjudication | undefined,
  ledger: EvidenceLedger,
  fabricated: Set<string>,
  downgraded: string[],
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

  const base: ReceiptClaim = {
    claimId: planned.claimId,
    claim: planned.text,
    importance: planned.importance,
    status: adjudication.status,
    confidence: adjudication.confidence,
    rationale: adjudication.rationale,
    evidence,
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
  const unadjudicated: string[] = [];

  const claims = plan.map((planned) => {
    const adjudication = byClaimId.get(planned.claimId);
    if (adjudication === undefined) unadjudicated.push(planned.claimId);
    return validateOne(planned, adjudication, ledger, fabricated, downgraded);
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
      unadjudicatedClaimIds: unadjudicated,
      completed: true,
    },
  };
}
