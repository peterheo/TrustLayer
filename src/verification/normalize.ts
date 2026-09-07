import type { EvidenceLedger } from "../research/evidence-ledger.js";
import type { ClaimJudgment, VerifierJudgment } from "./schemas.js";

/**
 * Check the model's citations against what the research tools actually
 * returned, and downgrade anything that does not survive.
 *
 * A fact-checker that invents its own citations is worse than no fact-checker,
 * because its output looks rigorous. So every `sourceId` the model wrote is
 * looked up in the ledger; ones that were never minted are dropped, and a
 * claim whose support disappears with them cannot stay `supported`.
 */

export interface NormalizationReport {
  /** Source IDs the model cited that no tool ever returned. */
  readonly fabricatedSourceIds: readonly string[];
  /** Claims moved from `supported` to `unverified` for lack of real evidence. */
  readonly downgradedClaims: readonly string[];
}

export interface NormalizedJudgment {
  readonly judgment: VerifierJudgment;
  readonly report: NormalizationReport;
}

function normalizeClaim(
  claim: ClaimJudgment,
  ledger: EvidenceLedger,
  fabricated: Set<string>,
  downgraded: string[],
): ClaimJudgment {
  const keptEvidence = claim.evidence.filter((reference) => {
    const known = ledger.has(reference.sourceId);
    if (!known) fabricated.add(reference.sourceId);
    return known;
  });

  // A `supported` or `contradicted` verdict is a claim about evidence. With no
  // surviving evidence there is nothing behind it, so it becomes `unverified`
  // — never `contradicted`, which would turn missing evidence into a finding.
  const needsEvidence = claim.status === "supported" || claim.status === "contradicted";
  if (needsEvidence && keptEvidence.length === 0) {
    downgraded.push(claim.claim);
    return {
      ...claim,
      status: "unverified",
      evidence: keptEvidence,
      confidence: Math.min(claim.confidence, 0.3),
      rationale:
        `${claim.rationale} [TrustLayer: downgraded to unverified — the cited evidence ` +
        `was not returned by any research tool during this execution.]`,
    };
  }

  return { ...claim, evidence: keptEvidence };
}

export function normalizeJudgment(
  judgment: VerifierJudgment,
  ledger: EvidenceLedger,
): NormalizedJudgment {
  const fabricated = new Set<string>();
  const downgraded: string[] = [];

  const claims = judgment.claims.map((claim) =>
    normalizeClaim(claim, ledger, fabricated, downgraded),
  );

  // Fabricated citations are themselves a signal worth reporting: the caller
  // asked whether they could rely on this output, and "its sources do not
  // exist" is part of the answer.
  const indicators = [...judgment.security.indicators];
  if (fabricated.size > 0) {
    indicators.push(
      `The verifier cited ${fabricated.size} source ID(s) that no research tool returned; ` +
        `those citations were discarded.`,
    );
  }

  return {
    judgment: {
      ...judgment,
      claims,
      security: { ...judgment.security, indicators: indicators.slice(0, 20) },
    },
    report: {
      fabricatedSourceIds: [...fabricated],
      downgradedClaims: downgraded,
    },
  };
}

/**
 * Enforce the caller's claim budget after the fact.
 *
 * The prompt asks for at most `maxClaims`; this makes it true regardless. The
 * most decision-relevant claims are kept, so trimming never silently discards
 * the one finding the caller most needed.
 */
export function capClaims(claims: readonly ClaimJudgment[], maxClaims: number): ClaimJudgment[] {
  if (claims.length <= maxClaims) return [...claims];
  const severity: Record<ClaimJudgment["status"], number> = {
    contradicted: 0,
    unverified: 1,
    supported: 2,
    not_falsifiable: 3,
  };
  return [...claims]
    .sort((left, right) => {
      if (left.importance !== right.importance) return right.importance - left.importance;
      return severity[left.status] - severity[right.status];
    })
    .slice(0, maxClaims);
}
