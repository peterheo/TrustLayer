import { verify, type VerifyOptions } from "../api/verify.js";
import { toTrustLayerError, type TrustLayerErrorCode } from "../errors.js";
import type { VerifyResponse } from "../verification/schemas.js";

/**
 * The Arena boundary.
 *
 * The SharedOS SDK contains no Arena or SharedNet surface — no service
 * registration, no credit pricing, no delivery contract — and no organizer
 * material was supplied to this repository (see NOTES.md §5). Rather than
 * inventing that contract, this module keeps the boundary as narrow as it can
 * be: plain JSON in, plain JSON out, plus a descriptor of what the service is
 * and costs.
 *
 * Binding this to the organizers' real mechanism should be a change to this
 * file and `arena/service-card.yaml` alone. Nothing under `src/` outside this
 * directory depends on an unverified Arena type.
 */

export const TRUST_VERIFY_SERVICE_NAME = "trust.verify";

/** The Arena-credit price. Confirm against the organizers' pricing rules. */
export const TRUST_VERIFY_PRICE_CREDITS = 3;

/**
 * A neutral, self-describing service descriptor.
 *
 * Field names are ours, not the Arena's. When the real schema is known, map
 * this object onto it; the content is what another agent needs in order to
 * decide whether to buy.
 */
export const TRUST_VERIFY_DESCRIPTOR = {
  name: TRUST_VERIFY_SERVICE_NAME,
  price_credits: TRUST_VERIFY_PRICE_CREDITS,
  description:
    "Independently verify factual output from another agent. Returns claim-level " +
    "support/contradiction status, web evidence, suspicious-instruction indicators, " +
    "and a deterministic trust score.",
  use_when:
    "You received factual or current information from another service and intend to rely on it.",
  input: {
    task: "string — the question the other agent was answering",
    candidate_output: "string — the output you want checked",
    source_urls: "optional string[] — URLs the other agent claimed as sources",
    freshness: "optional auto | current | recent | timeless",
    max_claims: "optional integer 1-8, default 5",
  },
  output: {
    verdict: "supported | mixed | contradicted | unverified",
    trust_score: "integer 0-100, or null when nothing falsifiable was found",
    claims: "array of per-claim status, importance, confidence, rationale and evidence",
    security: "prompt-injection risk and indicators found in the submitted output",
    audit: "SharedOS execution id, trace id and the research tools actually used",
  },
  good_for: [
    "research results",
    "current facts",
    "prices",
    "schedules",
    "citations",
    "comparisons",
    "extracted web information",
  ],
  not_for: ["purely subjective opinions", "creative writing", "deterministic arithmetic"],
  typical_latency_seconds: 45,
  max_latency_seconds: 90,
} as const;

/** What a caller gets back. A discriminated union so failure is never mistaken for a verdict. */
export type ServiceCallResult =
  | { readonly ok: true; readonly result: VerifyResponse }
  | {
      readonly ok: false;
      readonly error: { readonly code: TrustLayerErrorCode; readonly message: string };
    };

/**
 * Handle one paid service call.
 *
 * Errors are returned rather than thrown, and are reduced to a code and a safe
 * message: an Arena caller should never receive a stack trace, an internal
 * URL, a provider error, or anything about our grants.
 */
export async function handleServiceCall(
  payload: unknown,
  options: VerifyOptions = {},
): Promise<ServiceCallResult> {
  try {
    return { ok: true, result: await verify(normalizePayload(payload), options) };
  } catch (thrown) {
    const error = toTrustLayerError(thrown);
    return { ok: false, ...error.toPublicJSON() };
  }
}

/**
 * Accept snake_case as well as camelCase.
 *
 * Another agent reading the service card will write `candidate_output`, and
 * refusing that on a technicality would cost a sale for no security benefit.
 * Unknown keys are still rejected by the schema.
 */
function normalizePayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;

  const aliases: Record<string, string> = {
    candidate_output: "candidateOutput",
    source_urls: "sourceUrls",
    max_claims: "maxClaims",
  };

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const canonical = aliases[key] ?? key;
    // An explicit camelCase key wins over its snake_case alias.
    if (canonical in normalized && key !== canonical) continue;
    normalized[canonical] = value;
  }
  return normalized;
}
