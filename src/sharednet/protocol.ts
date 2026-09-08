import {
  TRUST_CHECK_PRICE_CREDITS,
  TRUST_CHECK_SERVICE_NAME,
  TRUST_VERIFY_PRICE_CREDITS,
  TRUST_VERIFY_SERVICE_NAME,
} from "../arena/adapter.js";
import { METHOD_VERSION, type EvidenceReceipt } from "../evidence/schemas.js";
import { MAX_MESSAGE_BYTES, type SharedNetMessage } from "./client.js";

/**
 * How a service call looks when the only primitive is a room message.
 *
 * SharedNet has Rooms, Instances, Messages and Decisions. It has no service
 * registry, no offers and no credits endpoint, so an Arena service call is a
 * message and the transcript is the record of what was sold. That constrains
 * the design in two useful ways:
 *
 * - **A call has to be recognisable.** We answer a message that names the
 *   service; everything else in a busy room is left alone. A service that
 *   replies to every message is noise, and noise does not get bought.
 * - **A reply has to be legible to both readers.** Another agent needs
 *   something it can parse; a human judge reading the transcript needs to see
 *   what was actually established. So the reply is prose *and* a JSON block,
 *   and it fits the 32 KB message cap by dropping detail in a fixed order
 *   rather than by being truncated mid-structure.
 */

export interface ParsedCall {
  readonly service: "trust.verify" | "trust.check";
  readonly request: Record<string, unknown>;
}

export interface ParseFailure {
  readonly service: "trust.verify" | "trust.check";
  readonly reason: string;
}

export type ParseResult =
  | { readonly kind: "call"; readonly call: ParsedCall }
  | { readonly kind: "malformed"; readonly failure: ParseFailure }
  | { readonly kind: "ignore" };

const ADDRESSED = /@?trustlayer\b|\btrust\.(verify|check)\b/i;

/** ```json … ``` first, then a bare object, so prose around it is fine. */
function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [fenced?.[1], text];

  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate rather than rejecting the message.
    }
  }
  return undefined;
}

/**
 * Decide whether a room message is a call for us, and for which service.
 *
 * Deliberately liberal about *how* the request is written and strict about
 * whether it was addressed to us at all.
 */
export function parseCall(content: string): ParseResult {
  if (!ADDRESSED.test(content)) return { kind: "ignore" };

  const service = /\btrust\.check\b/i.test(content)
    ? TRUST_CHECK_SERVICE_NAME
    : TRUST_VERIFY_SERVICE_NAME;

  const payload = extractJsonObject(content);
  if (payload === undefined) {
    return {
      kind: "malformed",
      failure: { service, reason: "no JSON request object was found in the message" },
    };
  }

  // The adapter already accepts snake_case and validates the rest, so the
  // only check here is that the two required fields are present at all.
  const task = payload["task"] ?? payload["question"];
  const candidate = payload["candidate_output"] ?? payload["candidateOutput"] ?? payload["output"];

  if (typeof task !== "string" || typeof candidate !== "string") {
    return {
      kind: "malformed",
      failure: { service, reason: "the request needs a `task` and a `candidate_output` string" },
    };
  }

  return {
    kind: "call",
    call: {
      service,
      request: { ...payload, task, candidate_output: candidate },
    },
  };
}

/** What to say when someone addresses us but the request is unusable. */
export function usageReply(failure: ParseFailure): string {
  const price =
    failure.service === TRUST_CHECK_SERVICE_NAME
      ? TRUST_CHECK_PRICE_CREDITS
      : TRUST_VERIFY_PRICE_CREDITS;

  return [
    `TrustLayer — ${failure.service} (${price} credit${price === 1 ? "" : "s"})`,
    "",
    `I could not read that as a call: ${failure.reason}.`,
    "",
    "Send a message naming the service with a JSON request in it, like:",
    "",
    "```json",
    JSON.stringify(
      {
        service: failure.service,
        task: "How much does Widget X cost?",
        candidate_output: "Widget X costs $79.",
        source_urls: ["https://vendor.example/widget-x"],
        focus_claims: ["Widget X costs $79."],
      },
      null,
      2,
    ),
    "```",
    "",
    "You get back an evidence receipt: every claim checked, every source actually",
    "retrieved with its timestamp and content digest, and the SharedOS execution",
    "that produced them. Absence of evidence comes back as unverified, never as false.",
  ].join("\n");
}

const CHECK_LABELS: Record<string, string> = {
  independentSearchPerformed: "independent search",
  sourcesFetched: "sources fetched",
  candidateCitationsChecked: "your citations checked",
  contradictionSearchPerformed: "contradiction search",
  contradictionEvidenceFetched: "contradiction evidence read",
  evidenceReferencesValidated: "citations validated",
};

function checksLine(receipt: EvidenceReceipt): string {
  return Object.entries(receipt.checks)
    .map(([key, value]) => `${value ? "yes" : "no"} ${CHECK_LABELS[key] ?? key}`)
    .join(" · ");
}

function claimLines(receipt: EvidenceReceipt): string[] {
  return receipt.claims.flatMap((claim, index) => {
    const lines = [
      `${index + 1}. [${claim.status}] ${claim.claim}`,
      `   ${claim.rationale}`,
    ];
    if (claim.evidence.length > 0) {
      lines.push(
        `   evidence: ${claim.evidence
          .map((reference) => `${reference.evidenceId} (${reference.relation})`)
          .join(", ")}`,
      );
    }
    for (const span of claim.spans ?? []) {
      lines.push(`   quoted from ${span.evidenceId}: "${span.excerpt}"`);
    }
    if (claim.adjusted !== undefined) lines.push(`   note: ${claim.adjusted}`);
    return lines;
  });
}

function evidenceLines(receipt: EvidenceReceipt): string[] {
  return receipt.evidence.map(
    (record) =>
      `  ${record.evidenceId} ${record.resolvedUrl} — ${record.domain}, ` +
      `retrieved ${record.retrievedAt}, sha256 ${record.contentSha256.slice(0, 16)}…` +
      `${record.origin === "candidate_citation" ? " (your citation)" : ""}`,
  );
}

/** The machine-readable half: the receipt without the parts a room cannot hold. */
export function compactReceipt(receipt: EvidenceReceipt): Record<string, unknown> {
  return {
    reportId: receipt.reportId,
    methodVersion: receipt.methodVersion,
    protocolStatus: receipt.protocolStatus,
    overallStatus: receipt.overallStatus,
    claims: receipt.claims.map((claim) => ({
      claimId: claim.claimId,
      claim: claim.claim,
      importance: claim.importance,
      status: claim.status,
      evidence: claim.evidence.map((reference) => reference.evidenceId),
      ...(claim.adjusted === undefined ? {} : { adjusted: claim.adjusted }),
    })),
    evidence: receipt.evidence.map((record) => ({
      evidenceId: record.evidenceId,
      url: record.resolvedUrl,
      domain: record.domain,
      retrievedAt: record.retrievedAt,
      contentSha256: record.contentSha256,
      origin: record.origin,
    })),
    coverage: receipt.coverage,
    checks: receipt.checks,
    security: receipt.security,
    provenance: receipt.provenance,
  };
}

export interface RenderOptions {
  readonly service: "trust.verify" | "trust.check";
  /** The cap to fit inside. Defaults to SharedNet's message limit. */
  readonly maxBytes?: number;
}

/**
 * Render a receipt as one room message.
 *
 * Fitting the cap sheds detail in a deliberate order: the JSON block goes
 * first, then the evidence list, then the claim detail. What never goes is the
 * verdict, the coverage, and the SharedOS execution ids — the parts that make
 * the answer checkable rather than merely readable.
 */
export function renderReceipt(receipt: EvidenceReceipt, options: RenderOptions): string {
  const max = options.maxBytes ?? MAX_MESSAGE_BYTES;
  const price =
    options.service === TRUST_CHECK_SERVICE_NAME
      ? TRUST_CHECK_PRICE_CREDITS
      : TRUST_VERIFY_PRICE_CREDITS;

  const header = [
    `TrustLayer ${options.service} — ${receipt.overallStatus.toUpperCase()}` +
      ` (protocol ${receipt.protocolStatus})`,
    `${receipt.reportId} · ${METHOD_VERSION} · ${price} credit${price === 1 ? "" : "s"}`,
    "",
    receipt.summary,
    "",
    `Claims checked ${receipt.coverage.claimsChecked}/${receipt.coverage.claimsSelected}` +
      ` · sources retrieved ${receipt.coverage.sourcesFetched}` +
      ` across ${receipt.coverage.distinctDomains} domain(s)`,
    checksLine(receipt),
  ];

  const security = receipt.security.suspiciousInstructionsDetected
    ? ["", `Security: instruction-like content detected — ${receipt.security.indicators.length} indicator(s).`]
    : [];

  const provenance = [
    "",
    `SharedOS: purpose ${receipt.provenance.purpose}, execution ${receipt.provenance.executionId},` +
      ` trace ${receipt.provenance.traceId}, status ${receipt.provenance.sharedosStatus}`,
    `Tools used: ${receipt.provenance.toolsUsed.join(", ") || "none"}`,
  ];

  const build = (parts: {
    claims: boolean;
    evidence: boolean;
    json: boolean;
  }): string =>
    [
      ...header,
      ...security,
      ...(parts.claims ? ["", "Claims:", ...claimLines(receipt)] : []),
      ...(parts.evidence && receipt.evidence.length > 0
        ? ["", `Evidence retrieved (${receipt.evidence.length}):`, ...evidenceLines(receipt)]
        : []),
      ...provenance,
      ...(parts.json
        ? ["", "```json", JSON.stringify(compactReceipt(receipt)), "```"]
        : []),
    ].join("\n");

  for (const parts of [
    { claims: true, evidence: true, json: true },
    { claims: true, evidence: true, json: false },
    { claims: true, evidence: false, json: false },
    { claims: false, evidence: false, json: false },
  ]) {
    const rendered = build(parts);
    if (Buffer.byteLength(rendered, "utf8") <= max) return rendered;
  }

  // Even the verdict alone is too long for the cap: keep it valid UTF-8.
  return Buffer.from(build({ claims: false, evidence: false, json: false }), "utf8")
    .subarray(0, max - 3)
    .toString("utf8")
    .concat("…");
}

/** What to say when the verification itself failed. Honest, and never internal. */
export function renderFailure(
  service: "trust.verify" | "trust.check",
  code: string,
  message: string,
): string {
  return [
    `TrustLayer ${service} — NO RECEIPT`,
    "",
    `The verification did not complete (${code}): ${message}`,
    "",
    "No receipt means no verification: nothing here should be read as evidence",
    "for or against the claim. Nothing is charged for a call that produced no receipt.",
  ].join("\n");
}

/** A message we posted ourselves, which must never trigger another reply. */
export function isOwnMessage(message: SharedNetMessage, memberId?: string): boolean {
  if (memberId === undefined) return false;
  return message.member_id === memberId;
}
