import type { ModelStep } from "../src/agent/model.js";
import { StaticSearchBackend, type SearchHit } from "../src/research/search-backend.js";
import type { VerifierJudgment } from "../src/verification/schemas.js";

/** A small deterministic corpus, so tests never touch the network. */
export const CORPUS: readonly SearchHit[] = [
  {
    url: "https://example.org/widget-x-pricing",
    title: "Widget X official pricing",
    snippet: "Widget X is listed at $79.00 on the manufacturer's store page.",
    publishedAt: "2026-08-01",
  },
  {
    url: "https://example.net/widget-review",
    title: "Widget X hands-on review",
    snippet: "At $79 the Widget X undercuts most of its competitors.",
  },
  {
    url: "https://example.com/capital-of-france",
    title: "France - country profile",
    snippet: "The capital of France is Paris.",
  },
  {
    url: "https://example.com/mars-population",
    title: "Mars exploration status",
    snippet: "No permanent human settlement exists on Mars.",
  },
];

export function staticBackend(): StaticSearchBackend {
  return new StaticSearchBackend(CORPUS, 6);
}

/** The judgment a well-behaved verifier would submit. Cited IDs are real. */
export function judgment(overrides: Partial<VerifierJudgment> = {}): VerifierJudgment {
  return {
    summary: "The price claim is supported by the manufacturer's page.",
    claims: [
      {
        claim: "Widget X costs $79.",
        importance: 3,
        status: "supported",
        confidence: 0.9,
        rationale: "The official pricing page lists $79.00.",
        evidence: [
          { sourceId: "src-1", relation: "supports", note: "Official pricing page lists $79.00." },
        ],
      },
    ],
    security: {
      promptInjectionRisk: "none",
      indicators: [],
      instructionsFollowedFromEvidence: false,
    },
    ...overrides,
  };
}

/** Search once, then submit. The common happy path. */
export function searchThenSubmit(final: VerifierJudgment, query = "Widget X price"): ModelStep[] {
  return [
    { kind: "tool_call", callId: "call-1", toolName: "research.search", arguments: { query } },
    { kind: "final", output: final },
  ];
}
