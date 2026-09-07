import type { ModelStep } from "../src/verifier/model.js";
import { StaticSearchBackend, type SearchHit } from "../src/tools/search-backend.js";
import {
  SUBMIT_ADJUDICATION,
  SUBMIT_CHALLENGE_COMPLETE,
  SUBMIT_PLAN,
  SUBMIT_RESEARCH_COMPLETE,
} from "../src/verifier/prompts.js";
import type { AdjudicationSubmission } from "../src/evidence/schemas.js";

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
    url: "https://example.com/widget-price-change",
    title: "Widget X price increase",
    snippet: "From September, Widget X is listed at $89.",
  },
];

export function staticBackend(): StaticSearchBackend {
  return new StaticSearchBackend(CORPUS, 6);
}

/** Every host in the fixtures resolves to one public address. */
export const publicDns = async (): Promise<readonly string[]> => ["93.184.216.34"];

/** A page body the quarantine layer will reduce to plain text. */
export function pricingPage(price = "$79.00"): string {
  return `<html><head><title>Widget X pricing</title></head>
  <body><script>track()</script><p>Widget X is listed at ${price}.</p></body></html>`;
}

export const PLAN_STEP: ModelStep = {
  kind: "submit",
  submission: SUBMIT_PLAN,
  payload: {
    claims: [
      { text: "Widget X costs $79.", importance: "critical", freshness: "current" },
    ],
  },
};

export function searchStep(query: string, callId = "call-search"): ModelStep {
  return { kind: "tool_call", callId, toolName: "research.search", arguments: { query } };
}

export function fetchStep(url: string, callId = "call-fetch"): ModelStep {
  return { kind: "tool_call", callId, toolName: "research.fetch", arguments: { url } };
}

export const RESEARCH_DONE: ModelStep = {
  kind: "submit",
  submission: SUBMIT_RESEARCH_COMPLETE,
  payload: {},
};

export const CHALLENGE_DONE: ModelStep = {
  kind: "submit",
  submission: SUBMIT_CHALLENGE_COMPLETE,
  payload: {},
};

export function adjudication(
  overrides: Partial<AdjudicationSubmission> = {},
): AdjudicationSubmission {
  return {
    summary: "The price claim is supported by the manufacturer's listing.",
    adjudications: [
      {
        claimId: "k1",
        status: "supported",
        confidence: 0.9,
        rationale: "The retrieved pricing page lists $79.00.",
        evidence: [{ evidenceId: "e1", relation: "supports", note: "Page lists $79.00." }],
      },
    ],
    suspiciousInstructions: { detected: false, indicators: [] },
    ...overrides,
  };
}

export function adjudicateStep(submission = adjudication()): ModelStep {
  return { kind: "submit", submission: SUBMIT_ADJUDICATION, payload: submission };
}

/**
 * The full happy path: plan, search, fetch, finish research, challenge-search,
 * finish challenge, adjudicate.
 */
export function fullProtocolScript(final = adjudication()): ModelStep[] {
  return [
    PLAN_STEP,
    searchStep("Widget X price", "call-1"),
    fetchStep("https://example.org/widget-x-pricing", "call-2"),
    RESEARCH_DONE,
    searchStep("Widget X price increase", "call-3"),
    CHALLENGE_DONE,
    adjudicateStep(final),
  ];
}
