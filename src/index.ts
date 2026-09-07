/**
 * TrustLayer — an agent-to-agent verification gateway.
 *
 * Before relying on another agent's factual output, TrustLayer it.
 */

export { verify, defaultHost, type VerifyOptions } from "./api/verify.js";
export {
  handleServiceCall,
  TRUST_VERIFY_DESCRIPTOR,
  TRUST_VERIFY_PRICE_CREDITS,
  TRUST_VERIFY_SERVICE_NAME,
  type ServiceCallResult,
} from "./arena/adapter.js";

export { TrustLayerError, type TrustLayerErrorCode } from "./errors.js";

export {
  VerifyRequestSchema,
  VerifierJudgmentSchema,
  type ClaimJudgment,
  type SecurityAssessment,
  type Verdict,
  type VerifyAudit,
  type VerifyRequest,
  type VerifyResponse,
} from "./verification/schemas.js";

export { computeTrustScore, deriveVerdict, scoreJudgment } from "./verification/scoring.js";

export { createTrustLayerHost, type TrustLayerHost } from "./sharedos/kernel.js";
export {
  TRUST_VERIFY_PURPOSE,
  RESEARCH_FETCH_TOOL,
  RESEARCH_SEARCH_TOOL,
  VERIFIER_AGENT,
} from "./sharedos/identity.js";
export { verifierGrants } from "./sharedos/grants.js";

export {
  AnthropicVerifierModel,
  ScriptedVerifierModel,
  createVerifierModel,
  type VerifierModel,
} from "./agent/model.js";

export { StaticSearchBackend, type SearchBackend, type SearchHit } from "./research/search-backend.js";
export { checkUrl, checkUrlSyntax } from "./tools/url-policy.js";
