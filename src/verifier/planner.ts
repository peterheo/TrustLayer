import {
  ClaimPlanSchema,
  type ClaimPlanDraft,
  type Importance,
  type PlannedClaim,
  type VerifyRequest,
} from "../evidence/schemas.js";

/**
 * Turning a request into a verification plan.
 *
 * Claim identifiers are assigned here, in host code, so the adjudication the
 * model returns can be matched against what was actually planned rather than
 * against whatever the model decided to call things.
 *
 * When the caller supplies `focusClaims`, planning is pure host code and the
 * model round-trip disappears entirely — that is what makes a one-claim
 * `trust.check` fast and cheap, and it also means the caller's own framing of
 * the claim is what gets checked.
 */

export const IMPORTANCE_WEIGHT: Record<Importance, number> = {
  critical: 3,
  material: 2,
  minor: 1,
};

function claimId(index: number): string {
  return `k${index + 1}`;
}

/**
 * Map the request's freshness hint onto a claim.
 *
 * `auto` means the caller has no opinion, and `current` is the conservative
 * default: assuming a fact is timeless is how stale prices get reported as
 * correct.
 */
function freshnessFor(request: VerifyRequest): PlannedClaim["freshness"] {
  return request.freshness === "auto" ? "current" : request.freshness;
}

/**
 * A plan built entirely from what the caller named.
 *
 * Caller-named claims are treated as `critical`: the caller singled them out,
 * which is a stronger signal of what matters than anything extraction could
 * infer.
 */
export function planFromFocusClaims(request: VerifyRequest): readonly PlannedClaim[] {
  const focus = request.focusClaims ?? [];
  return focus.slice(0, request.maxClaims).map((text, index) => ({
    claimId: claimId(index),
    text,
    importance: "critical" as const,
    freshness: freshnessFor(request),
    fromFocusClaims: true,
  }));
}

/** Whether planning can skip the model entirely. */
export function hasFocusClaims(request: VerifyRequest): boolean {
  return request.focusClaims !== undefined && request.focusClaims.length > 0;
}

/**
 * A plan built from the model's extraction.
 *
 * The model proposes text, importance and freshness; the host assigns the
 * identifiers and enforces the budget. Claims are ordered by importance before
 * trimming, so a budget cut never silently drops the decisive claim in favour
 * of a decorative one.
 */
export function planFromDraft(
  draft: ClaimPlanDraft,
  request: VerifyRequest,
): readonly PlannedClaim[] {
  return [...draft.claims]
    .sort((left, right) => IMPORTANCE_WEIGHT[right.importance] - IMPORTANCE_WEIGHT[left.importance])
    .slice(0, request.maxClaims)
    .map((claim, index) => ({
      claimId: claimId(index),
      text: claim.text,
      importance: claim.importance,
      freshness: claim.freshness,
      fromFocusClaims: false,
    }));
}

/** Parse a model plan submission, or throw for the driver to handle. */
export function parsePlanSubmission(payload: unknown): ClaimPlanDraft {
  return ClaimPlanSchema.parse(payload);
}
