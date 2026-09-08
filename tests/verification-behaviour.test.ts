import { afterEach, describe, expect, it, vi } from "vitest";

import { verify } from "../src/api/verify.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import type { AdjudicationSubmission } from "../src/evidence/schemas.js";
import { ScriptedVerifierModel, type ModelStep } from "../src/verifier/model.js";
import { SUBMIT_PLAN } from "../src/verifier/prompts.js";
import {
  CHALLENGE_DONE,
  RESEARCH_DONE,
  adjudicateStep,
  fetchStep,
  publicDns,
  searchStep,
  staticBackend,
} from "./fixtures.js";

/**
 * What a receipt says about the claims themselves.
 *
 * The other suites check the machinery — that a citation was really retrieved,
 * that a phase really ran. This one checks the outcome an agent reads: given
 * evidence that supports, refutes, misses, or disagrees with the candidate
 * output, does the receipt say the right thing about it, and does it decline
 * to overstate when the evidence does not settle the question.
 *
 * Every run below uses a scripted model, so the assertions are about
 * TrustLayer's behaviour rather than about a model's mood on the day.
 */
describe("verification behaviour", () => {
  const PRICING = "https://example.org/widget-x-pricing";
  const REVIEW = "https://example.net/widget-review";
  const PRICE_CHANGE = "https://example.com/widget-price-change";

  /** Pages the stubbed network serves, by URL. Anything else 404s. */
  const PAGES: Record<string, string> = {
    [PRICING]: page("Widget X pricing", "Widget X is listed at $79.00."),
    [REVIEW]: page("Widget X review", "At $79 the Widget X undercuts its competitors."),
    [PRICE_CHANGE]: page(
      "Widget X price increase",
      "From 1 September 2026, Widget X is listed at $89.00. The $79 price ended in August.",
    ),
  };

  function page(title: string, body: string): string {
    return `<html><head><title>${title}</title></head><body><p>${body}</p></body></html>`;
  }

  function host() {
    return createTrustLayerHost({ searchBackend: staticBackend(), resolveHost: publicDns });
  }

  function stubNetwork(): void {
    vi.stubGlobal("fetch", async (input: unknown) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : String((input as { url?: unknown }).url);
      const body = PAGES[url];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A plan submitted by the model, rather than named by the caller. */
  function planStep(
    ...claims: ReadonlyArray<{ text: string; importance: "critical" | "material" | "minor" }>
  ): ModelStep {
    return {
      kind: "submit",
      submission: SUBMIT_PLAN,
      payload: {
        claims: claims.map((claim) => ({ ...claim, freshness: "current" as const })),
      },
    };
  }

  function judgment(
    adjudications: AdjudicationSubmission["adjudications"],
    summary = "Judgment recorded.",
  ): AdjudicationSubmission {
    return { summary, adjudications, suspiciousInstructions: { detected: false, indicators: [] } };
  }

  /**
   * plan -> discover -> fetch -> challenge -> adjudicate.
   *
   * The challenge phase both searches and retrieves: a challenge that finds
   * leads and opens none of them is reported as an incomplete protocol, so a
   * script that means to run the whole protocol has to fetch there too.
   */
  function script(
    plan: ModelStep,
    fetches: readonly string[],
    final: AdjudicationSubmission,
    challengeFetches: readonly string[] = [PRICE_CHANGE],
  ): ModelStep[] {
    return [
      plan,
      searchStep("Widget X price", "call-search"),
      ...fetches.map((url, index) => fetchStep(url, `call-fetch-${index + 1}`)),
      RESEARCH_DONE,
      searchStep("Widget X price wrong OR increase OR discontinued", "call-challenge"),
      ...challengeFetches.map((url, index) => fetchStep(url, `call-challenge-fetch-${index + 1}`)),
      CHALLENGE_DONE,
      adjudicateStep(final),
    ];
  }

  it("reports a claim the retrieved source confirms as supported", async () => {
    stubNetwork();
    const model = new ScriptedVerifierModel(
      script(
        planStep({ text: "Widget X costs $79.", importance: "critical" }),
        [PRICING],
        judgment([
          {
            claimId: "k1",
            status: "supported",
            confidence: 0.9,
            rationale: "The manufacturer's page lists $79.00.",
            evidence: [{ evidenceId: "e1", relation: "supports", note: "Lists $79.00." }],
          },
        ]),
      ),
    );

    const receipt = await verify(
      { task: "How much does Widget X cost?", candidateOutput: "Widget X costs $79." },
      { host: host(), model },
    );

    expect(receipt.claims[0]?.status).toBe("supported");
    expect(receipt.claims[0]?.adjusted).toBeUndefined();
    expect(receipt.overallStatus).toBe("supported");
    expect(receipt.protocolStatus).toBe("complete");
    expect(receipt.coverage.criticalClaimsChecked).toBe(1);
  });

  it("reports a claim the retrieved source refutes as contradicted", async () => {
    stubNetwork();
    const model = new ScriptedVerifierModel(
      script(
        planStep({ text: "Widget X costs $59.", importance: "critical" }),
        [PRICING],
        judgment([
          {
            claimId: "k1",
            status: "contradicted",
            confidence: 0.9,
            rationale: "The manufacturer's page lists $79.00, not $59.",
            evidence: [{ evidenceId: "e1", relation: "contradicts", note: "Lists $79.00." }],
          },
        ]),
      ),
    );

    const receipt = await verify(
      { task: "How much does Widget X cost?", candidateOutput: "Widget X costs $59." },
      { host: host(), model },
    );

    expect(receipt.claims[0]?.status).toBe("contradicted");
    expect(receipt.claims[0]?.evidence[0]?.relation).toBe("contradicts");
    expect(receipt.overallStatus).toBe("contradicted");
  });

  it("reports a claim nothing retrieved speaks to as unverified, not as false", async () => {
    stubNetwork();
    const model = new ScriptedVerifierModel(
      script(
        planStep({ text: "Widget X ships from a warehouse in Utrecht.", importance: "material" }),
        [PRICING],
        judgment([
          {
            claimId: "k1",
            status: "unverified",
            confidence: 0.2,
            rationale: "Nothing retrieved mentions where Widget X ships from.",
            evidence: [],
          },
        ]),
      ),
    );

    const receipt = await verify(
      {
        task: "Where does Widget X ship from?",
        candidateOutput: "Widget X ships from a warehouse in Utrecht.",
      },
      { host: host(), model },
    );

    expect(receipt.claims[0]?.status).toBe("unverified");
    expect(receipt.overallStatus).toBe("unverified");
    // Absence of evidence is never disproof, and the receipt says so by
    // leaving the claim unverified while still reporting what was retrieved.
    expect(receipt.evidence.length).toBeGreaterThan(0);
    expect(receipt.coverage.claimsChecked).toBe(0);
  });

  it("reports a response whose claims disagree with each other as mixed", async () => {
    stubNetwork();
    const model = new ScriptedVerifierModel(
      script(
        planStep(
          { text: "Widget X costs $79.", importance: "material" },
          { text: "Widget X undercuts its competitors.", importance: "material" },
          { text: "Widget X was released in 2019.", importance: "material" },
        ),
        [PRICING, REVIEW],
        judgment([
          {
            claimId: "k1",
            status: "supported",
            confidence: 0.9,
            rationale: "The pricing page lists $79.00.",
            evidence: [{ evidenceId: "e1", relation: "supports", note: "Lists $79.00." }],
          },
          {
            claimId: "k2",
            status: "supported",
            confidence: 0.7,
            rationale: "The review says it undercuts most competitors.",
            evidence: [{ evidenceId: "e2", relation: "supports", note: "Review says so." }],
          },
          {
            claimId: "k3",
            status: "contradicted",
            confidence: 0.8,
            rationale: "The review dates the product to a later year.",
            evidence: [{ evidenceId: "e2", relation: "contradicts", note: "Dates disagree." }],
          },
        ]),
      ),
    );

    const receipt = await verify(
      {
        task: "Tell me about Widget X.",
        candidateOutput: "Widget X costs $79, undercuts competitors, and was released in 2019.",
        maxClaims: 3,
      },
      { host: host(), model },
    );

    expect(receipt.claims.map((claim) => claim.status)).toEqual([
      "supported",
      "supported",
      "contradicted",
    ]);
    expect(receipt.overallStatus).toBe("mixed");
    expect(receipt.coverage.claimsSelected).toBe(3);
    expect(receipt.coverage.claimsChecked).toBe(3);
  });

  it("keeps a non-falsifiable claim out of the overall judgment", async () => {
    stubNetwork();
    const model = new ScriptedVerifierModel(
      script(
        planStep({ text: "Widget X is the most elegant gadget of its generation.", importance: "minor" }),
        [REVIEW],
        judgment([
          {
            claimId: "k1",
            status: "not_falsifiable",
            confidence: 0.9,
            rationale: "An aesthetic judgment, not a checkable fact.",
            evidence: [],
          },
        ]),
      ),
    );

    const receipt = await verify(
      {
        task: "Is Widget X any good?",
        candidateOutput: "Widget X is the most elegant gadget of its generation.",
      },
      { host: host(), model },
    );

    expect(receipt.claims[0]?.status).toBe("not_falsifiable");
    expect(receipt.claims[0]?.adjusted).toBeUndefined();
    // Nothing falsifiable was in play, so there is nothing to call supported.
    expect(receipt.overallStatus).toBe("unverified");
  });

  it("catches a fact that was true and has since gone stale", async () => {
    stubNetwork();
    const model = new ScriptedVerifierModel(
      script(
        planStep({ text: "Widget X costs $79 today.", importance: "critical" }),
        [PRICE_CHANGE],
        judgment(
          [
            {
              claimId: "k1",
              status: "contradicted",
              confidence: 0.85,
              rationale: "The $79 price ended in August; the current listing is $89.00.",
              evidence: [
                { evidenceId: "e1", relation: "contradicts", note: "Now listed at $89.00." },
              ],
            },
          ],
          "The price quoted was correct until September and is now out of date.",
        ),
        // The price-change page was already retrieved during research; the
        // challenge phase goes looking somewhere else.
        [REVIEW],
      ),
    );

    const receipt = await verify(
      {
        task: "How much does Widget X cost today?",
        candidateOutput: "Widget X costs $79 today.",
        freshness: "current",
      },
      { host: host(), model },
    );

    expect(receipt.claims[0]?.status).toBe("contradicted");
    expect(receipt.overallStatus).toBe("contradicted");
    // The receipt pins what was read and when, so a stale finding is auditable
    // rather than a matter of the verifier's word.
    expect(receipt.evidence[0]?.domain).toBe("example.com");
    expect(Date.parse(receipt.evidence[0]?.retrievedAt ?? "")).not.toBeNaN();
    expect(receipt.evidence[0]?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports genuinely conflicting sources as unverified, and keeps both", async () => {
    stubNetwork();
    const model = new ScriptedVerifierModel(
      script(
        planStep({ text: "Widget X costs $79.", importance: "critical" }),
        [PRICING],
        judgment(
          [
            {
              claimId: "k1",
              status: "unverified",
              confidence: 0.4,
              rationale:
                "The store page lists $79.00 while a second source lists $89.00; the sources " +
                "disagree and neither settles the current price.",
              evidence: [
                { evidenceId: "e1", relation: "supports", note: "Store page lists $79.00." },
                { evidenceId: "e2", relation: "contradicts", note: "Second source lists $89.00." },
              ],
            },
          ],
          "Two retrieved sources disagree about the price.",
        ),
      ),
    );

    const receipt = await verify(
      { task: "How much does Widget X cost?", candidateOutput: "Widget X costs $79." },
      { host: host(), model },
    );

    expect(receipt.claims[0]?.status).toBe("unverified");
    expect(receipt.overallStatus).toBe("unverified");
    // Both sides of the conflict stay in the receipt, so the caller can look.
    expect(receipt.claims[0]?.evidence.map((reference) => reference.relation)).toEqual([
      "supports",
      "contradicts",
    ]);
    expect(receipt.evidence).toHaveLength(2);
    expect(receipt.coverage.distinctDomains).toBe(2);
  });

  it("checks the caller's own focus claim instead of extracting its own", async () => {
    stubNetwork();
    const model = new ScriptedVerifierModel([
      searchStep("Widget X price", "call-search"),
      fetchStep(PRICING, "call-fetch-1"),
      RESEARCH_DONE,
      searchStep("Widget X price increase", "call-challenge"),
      CHALLENGE_DONE,
      adjudicateStep(
        judgment([
          {
            claimId: "k1",
            status: "supported",
            confidence: 0.9,
            rationale: "The pricing page lists $79.00.",
            evidence: [{ evidenceId: "e1", relation: "supports", note: "Lists $79.00." }],
          },
        ]),
      ),
    ]);

    const receipt = await verify(
      {
        task: "Can I afford two of these?",
        candidateOutput: "Widget X costs $79 and ships in three days.",
        focusClaims: ["Widget X costs $79."],
      },
      { host: host(), model },
    );

    // Only the named claim was verified — the shipping claim was never planned.
    expect(receipt.coverage.claimsSelected).toBe(1);
    expect(receipt.claims[0]?.claim).toBe("Widget X costs $79.");
    expect(receipt.claims[0]?.importance).toBe("critical");
    expect(receipt.overallStatus).toBe("supported");
  });
});
