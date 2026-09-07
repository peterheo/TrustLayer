import { z } from "zod";

/**
 * Two schemas with two very different jobs.
 *
 * `VerifyRequestSchema` validates an untrusted caller's payload and caps its
 * size, so one agent cannot spend the whole turn budget by pasting a book.
 *
 * `VerifierJudgmentSchema` is what the *model* is allowed to say. It is
 * deliberately narrower than the API response: there is no trust score, no
 * execution id, no trace id, no tool list, and no timing. Those are
 * host-derived facts, and the way to stop a model fabricating them is to leave
 * them out of its output contract entirely rather than to strip them later.
 */

export const MAX_CLAIMS_HARD_LIMIT = 8;
export const DEFAULT_MAX_CLAIMS = 5;

export const FreshnessSchema = z.enum(["auto", "current", "recent", "timeless"]);
export type Freshness = z.infer<typeof FreshnessSchema>;

export const VerifyRequestSchema = z
  .object({
    /** The question the candidate output was supposed to answer. */
    task: z.string().min(1).max(12_000),
    /** The output being verified. Untrusted data, never instructions. */
    candidateOutput: z.string().min(1).max(40_000),
    /** Sources the candidate claims to have used. Checked, never trusted. */
    sourceUrls: z.array(z.string().url()).max(10).optional(),
    freshness: FreshnessSchema.default("auto"),
    maxClaims: z.number().int().min(1).max(MAX_CLAIMS_HARD_LIMIT).default(DEFAULT_MAX_CLAIMS),
  })
  .strict();

export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

export const ClaimStatusSchema = z.enum([
  "supported",
  "contradicted",
  "unverified",
  "not_falsifiable",
]);
export type ClaimStatus = z.infer<typeof ClaimStatusSchema>;

export const EvidenceReferenceSchema = z
  .object({
    /** Must be a source ID a research tool actually minted. Validated post-turn. */
    sourceId: z.string().min(1).max(64),
    relation: z.enum(["supports", "contradicts"]),
    note: z.string().max(1_000),
  })
  .strict();

export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

export const ClaimJudgmentSchema = z
  .object({
    claim: z.string().min(1).max(2_000),
    /** 1 = minor, 2 = material, 3 = decision-critical. */
    importance: z.number().int().min(1).max(3),
    status: ClaimStatusSchema,
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).max(2_000),
    evidence: z.array(EvidenceReferenceSchema).max(10),
  })
  .strict();

export type ClaimJudgment = z.infer<typeof ClaimJudgmentSchema>;

export const SecurityAssessmentSchema = z
  .object({
    promptInjectionRisk: z.enum(["none", "low", "medium", "high"]),
    indicators: z.array(z.string().max(500)).max(20),
    /**
     * A literal `false`. The verifier asserts it did not act on instructions
     * found in evidence; a model that tries to report `true` fails validation,
     * and the host's own answer to this question is the tool catalogue, which
     * never contained a tool such instructions could have used.
     */
    instructionsFollowedFromEvidence: z.literal(false),
  })
  .strict();

export type SecurityAssessment = z.infer<typeof SecurityAssessmentSchema>;

export const VerifierJudgmentSchema = z
  .object({
    summary: z.string().min(1).max(4_000),
    claims: z.array(ClaimJudgmentSchema).max(MAX_CLAIMS_HARD_LIMIT),
    security: SecurityAssessmentSchema,
  })
  .strict();

export type VerifierJudgment = z.infer<typeof VerifierJudgmentSchema>;

export type Verdict = "supported" | "mixed" | "contradicted" | "unverified";

/** Correlation the buyer may see. Grants and policy internals are not here. */
export interface VerifyAudit {
  readonly executionId: string;
  readonly traceId: string;
  readonly toolsUsed: readonly string[];
  readonly sharedosStatus: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly durationMs?: number;
}

export interface VerifyResponse {
  readonly verdict: Verdict;
  /** 0-100, or null when nothing falsifiable was found. */
  readonly trustScore: number | null;
  readonly summary: string;
  readonly claims: readonly ClaimJudgment[];
  readonly security: SecurityAssessment;
  readonly audit: VerifyAudit;
}
