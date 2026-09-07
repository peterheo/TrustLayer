import type { ClaimJudgment, Verdict } from "./schemas.js";

/**
 * The trust score is computed here, in host code, from claim judgments.
 *
 * Asking a model for "a trust score from 0-100" produces a number with no
 * defined meaning that moves between runs on identical input. Deriving it from
 * the claim table instead makes it reproducible, explainable ("which claim
 * moved it?"), and testable.
 */

export const STATUS_VALUE = {
  supported: 1,
  unverified: 0.4,
  contradicted: 0,
} as const;

/** `not_falsifiable` claims are excluded from the score entirely. */
export function isFalsifiable(claim: ClaimJudgment): boolean {
  return claim.status !== "not_falsifiable";
}

export interface ScoreResult {
  readonly trustScore: number | null;
  readonly verdict: Verdict;
  /** How many claims actually drove the score. */
  readonly falsifiableCount: number;
}

/**
 * Importance-weighted support, 0-100.
 *
 * `null` when nothing falsifiable was checked — which is a real answer, not a
 * zero. A zero would say "everything was contradicted"; null says "there was
 * nothing here to check", and the verdict is `unverified` to match.
 */
export function computeTrustScore(claims: readonly ClaimJudgment[]): number | null {
  const falsifiable = claims.filter(isFalsifiable);
  if (falsifiable.length === 0) return null;

  let weighted = 0;
  let totalWeight = 0;
  for (const claim of falsifiable) {
    const value = STATUS_VALUE[claim.status as keyof typeof STATUS_VALUE];
    weighted += claim.importance * value;
    totalWeight += claim.importance;
  }

  if (totalWeight === 0) return null;
  return Math.round((weighted / totalWeight) * 100);
}

/**
 * The overall verdict.
 *
 * Deterministic and ordered: the first rule that matches wins, so the same
 * claim table always yields the same verdict.
 */
export function deriveVerdict(claims: readonly ClaimJudgment[], trustScore: number | null): Verdict {
  const falsifiable = claims.filter(isFalsifiable);
  if (falsifiable.length === 0 || trustScore === null) return "unverified";

  const critical = falsifiable.filter((claim) => claim.importance === 3);
  const contradicted = falsifiable.filter((claim) => claim.status === "contradicted");
  const supported = falsifiable.filter((claim) => claim.status === "supported");
  const material = falsifiable.filter((claim) => claim.importance >= 2);

  // A contradicted decision-critical claim decides the verdict on its own: the
  // caller was about to rely on something that is wrong.
  if (critical.some((claim) => claim.status === "contradicted")) return "contradicted";

  // Contradictions dominating the weighted result is the other way to land here.
  if (contradicted.length > 0 && trustScore < 35) return "contradicted";

  // `supported` requires the decision-critical claims to be positively
  // established, not merely un-contradicted.
  const allCriticalSupported = critical.every((claim) => claim.status === "supported");
  const noMaterialProblem = material.every((claim) => claim.status === "supported");
  if (allCriticalSupported && noMaterialProblem && contradicted.length === 0 && trustScore >= 80) {
    return "supported";
  }

  // Nothing was established and nothing was refuted.
  if (supported.length === 0 && contradicted.length === 0) return "unverified";

  // Real support coexisting with material doubt or contradiction.
  if (supported.length > 0) return "mixed";

  return "unverified";
}

export function scoreJudgment(claims: readonly ClaimJudgment[]): ScoreResult {
  const trustScore = computeTrustScore(claims);
  return {
    trustScore,
    verdict: deriveVerdict(claims, trustScore),
    falsifiableCount: claims.filter(isFalsifiable).length,
  };
}
