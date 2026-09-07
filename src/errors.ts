/**
 * The service's stable error vocabulary.
 *
 * Callers see a code and a short, deliberately uninformative message. Stack
 * traces, provider errors, URLs, grant state, and credentials never cross this
 * boundary — the `cause` stays host-side for logs, keyed by execution id.
 */

export type TrustLayerErrorCode =
  | "INVALID_INPUT"
  | "VERIFICATION_TIMEOUT"
  | "MODEL_FAILURE"
  | "MODEL_OUTPUT_INVALID"
  | "RESEARCH_UNAVAILABLE"
  | "SHAREDOS_DENIED"
  | "SHAREDOS_FAILURE"
  | "INTERNAL_ERROR";

/** What each code tells the calling agent. Safe to return verbatim. */
const PUBLIC_MESSAGES: Record<TrustLayerErrorCode, string> = {
  INVALID_INPUT: "The verification request was not valid.",
  VERIFICATION_TIMEOUT: "Verification did not finish within its time budget.",
  MODEL_FAILURE: "The verification agent could not complete its turn.",
  MODEL_OUTPUT_INVALID: "The verification agent returned an unusable judgment.",
  RESEARCH_UNAVAILABLE: "No research backend is available to gather evidence.",
  SHAREDOS_DENIED: "SharedOS denied the verification turn.",
  SHAREDOS_FAILURE: "The verification turn failed inside SharedOS.",
  INTERNAL_ERROR: "Verification failed for an internal reason.",
};

export class TrustLayerError extends Error {
  readonly code: TrustLayerErrorCode;
  /** Host-side only. Never serialized to a caller. */
  readonly detail: string | undefined;

  constructor(code: TrustLayerErrorCode, detail?: string, options?: { cause?: unknown }) {
    super(PUBLIC_MESSAGES[code], options);
    this.name = "TrustLayerError";
    this.code = code;
    this.detail = detail;
  }

  /** The only shape a caller ever sees. */
  toPublicJSON(): { error: { code: TrustLayerErrorCode; message: string } } {
    return { error: { code: this.code, message: PUBLIC_MESSAGES[this.code] } };
  }
}

export function publicMessageFor(code: TrustLayerErrorCode): string {
  return PUBLIC_MESSAGES[code];
}

/**
 * Coerce anything thrown into the vocabulary without letting its message
 * escape. An unrecognized throw becomes INTERNAL_ERROR and keeps its cause for
 * host-side logging only.
 */
export function toTrustLayerError(thrown: unknown): TrustLayerError {
  if (thrown instanceof TrustLayerError) return thrown;
  const detail = thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : String(thrown);
  return new TrustLayerError("INTERNAL_ERROR", detail, { cause: thrown });
}
