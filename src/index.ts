/**
 * TrustLayer — independent evidence receipts for agent claims.
 *
 * Don't take an agent's word for it. Get the evidence.
 */

export { verify, defaultHost, type VerifyOptions } from "./api/verify.js";

export {
  handleServiceCall,
  handleCheckCall,
  SERVICE_DESCRIPTORS,
  TRUST_CHECK_DESCRIPTOR,
  TRUST_CHECK_PRICE_CREDITS,
  TRUST_CHECK_SERVICE_NAME,
  TRUST_VERIFY_DESCRIPTOR,
  TRUST_VERIFY_PRICE_CREDITS,
  TRUST_VERIFY_SERVICE_NAME,
  type ServiceCallResult,
} from "./arena/adapter.js";

export { TrustLayerError, type TrustLayerErrorCode } from "./errors.js";

export {
  METHOD_VERSION,
  VerifyRequestSchema,
  type ClaimAdjudication,
  type ClaimStatus,
  type EvidenceReceipt,
  type EvidenceRecord,
  type Importance,
  type OverallStatus,
  type PlannedClaim,
  type ProtocolStatus,
  type ReceiptChecks,
  type ReceiptClaim,
  type ReceiptCoverage,
  type ReceiptEvidence,
  type ReceiptProvenance,
  type SearchCandidate,
  type VerifyRequest,
} from "./evidence/schemas.js";

export { EvidenceLedger, EvidenceLedgerRegistry } from "./evidence/ledger.js";
export { validateAdjudications, type ValidationReport } from "./evidence/validator.js";
export {
  buildReceipt,
  deriveChecks,
  deriveCoverage,
  deriveOverallStatus,
  deriveProtocolStatus,
} from "./evidence/receipt.js";
export { sha256 } from "./evidence/digest.js";

export { ProtocolState, PHASES, type Phase } from "./verifier/protocol.js";
export { planFromFocusClaims, planFromDraft } from "./verifier/planner.js";
export {
  AnthropicVerifierModel,
  ScriptedVerifierModel,
  createVerifierModel,
  type ModelStep,
  type VerifierModel,
} from "./verifier/model.js";

export { createTrustLayerHost, type TrustLayerHost } from "./sharedos/kernel.js";
export {
  TRUST_VERIFY_PURPOSE,
  RESEARCH_FETCH_TOOL,
  RESEARCH_SEARCH_TOOL,
  VERIFIER_AGENT,
} from "./sharedos/identity.js";
export { verifierGrants } from "./sharedos/grants.js";

export {
  StaticSearchBackend,
  type SearchBackend,
  type SearchHit,
} from "./tools/search-backend.js";
export { checkUrl, checkUrlSyntax } from "./tools/url-policy.js";
export { quarantine, detectInstructionLikeContent } from "./security/evidence-quarantine.js";
