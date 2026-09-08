import { afterEach, describe, expect, it, vi } from "vitest";

import { verify } from "../src/api/verify.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { ScriptedVerifierModel } from "../src/verifier/model.js";
import {
  CHALLENGE_DONE,
  PLAN_STEP,
  RESEARCH_DONE,
  adjudicateStep,
  adjudication,
  fetchStep,
  pricingPage,
  publicDns,
  searchStep,
  staticBackend,
} from "./fixtures.js";

/**
 * Candidate-supplied citations.
 *
 * A URL existing is not the same as a citation being valid, and a source the
 * candidate handed us is not independent verification. The receipt has to be
 * able to tell the difference, so the ledger records the origin of every
 * fetch.
 */
describe("candidate citation validation", () => {
  const CANDIDATE_URL = "https://candidate.example/its-own-source";

  const request = {
    task: "How much does Widget X cost?",
    candidateOutput: "Widget X costs $79, according to our source.",
    sourceUrls: [CANDIDATE_URL],
  };

  function host() {
    return createTrustLayerHost({ searchBackend: staticBackend(), resolveHost: publicDns });
  }

  function stubPages(): void {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(pricingPage(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks a fetched candidate URL as a candidate citation, not independent evidence", async () => {
    stubPages();
    const model = new ScriptedVerifierModel([
      PLAN_STEP,
      fetchStep(CANDIDATE_URL, "call-1"),
      RESEARCH_DONE,
      searchStep("Widget X price", "call-2"),
      CHALLENGE_DONE,
      adjudicateStep(),
    ]);

    const receipt = await verify(request, { host: host(), model });

    expect(receipt.evidence).toHaveLength(1);
    expect(receipt.evidence[0]?.origin).toBe("candidate_citation");
    expect(receipt.checks.candidateCitationsChecked).toBe(true);
  });

  it("marks an independently discovered source as independent", async () => {
    stubPages();
    const model = new ScriptedVerifierModel([
      PLAN_STEP,
      searchStep("Widget X price", "call-1"),
      fetchStep("https://example.org/widget-x-pricing", "call-2"),
      RESEARCH_DONE,
      searchStep("Widget X price change", "call-3"),
      CHALLENGE_DONE,
      adjudicateStep(),
    ]);

    const receipt = await verify(request, { host: host(), model });

    expect(receipt.evidence[0]?.origin).toBe("independent");
    // The model ignored the caller's own source, so the host went and got it.
    expect(receipt.evidence.map((entry) => entry.origin)).toContain("candidate_citation");
    expect(receipt.checks.candidateCitationsChecked).toBe(true);
  });

  /**
   * Checking the sources a candidate cited is the host's job.
   *
   * Leaving it to the model made `candidateCitationsChecked` a report on the
   * model's willingness rather than on what was retrieved, and a candidate
   * that cites a page which does not support its claim is one of the failure
   * modes the product exists to catch — so the host chases them itself when
   * research ends with any still unchecked.
   */
  describe("the host chases unchecked citations itself", () => {
    it("retrieves a citation the model declined to look at", async () => {
      stubPages();
      const model = new ScriptedVerifierModel([
        PLAN_STEP,
        searchStep("Widget X price", "call-1"),
        RESEARCH_DONE,
        searchStep("Widget X price change", "call-2"),
        CHALLENGE_DONE,
        adjudicateStep(),
      ]);

      const receipt = await verify(request, { host: host(), model });

      const candidate = receipt.evidence.find((entry) => entry.origin === "candidate_citation");
      expect(candidate?.url).toBe(CANDIDATE_URL);
      expect(receipt.checks.candidateCitationsChecked).toBe(true);
      // Retrieved through the same tool boundary as any other fetch.
      expect(receipt.provenance.toolsUsed).toContain("research.fetch");
    });

    it("leaves room for the challenge phase to search and to fetch", async () => {
      stubPages();
      const model = new ScriptedVerifierModel([
        PLAN_STEP,
        searchStep("Widget X price", "call-1"),
        RESEARCH_DONE,
        searchStep("Widget X price change", "call-2"),
        fetchStep("https://example.com/widget-price-change", "call-3"),
        CHALLENGE_DONE,
        adjudicateStep(
          adjudication({
            adjudications: [
              {
                claimId: "k1",
                status: "supported",
                confidence: 0.9,
                rationale: "An independently retrieved page supports the price.",
                evidence: [{ evidenceId: "e2", relation: "supports", note: "independent" }],
              },
            ],
          }),
        ),
      ]);

      const receipt = await verify(request, { host: host(), model });

      // Forcing a citation check must not cost the challenge round: a receipt
      // that checked the candidate's sources but skipped contradiction hunting
      // would be a worse trade than the one it replaced.
      expect(receipt.checks.contradictionSearchPerformed).toBe(true);
      expect(receipt.checks.contradictionEvidenceFetched).toBe(true);
      expect(receipt.protocolStatus).toBe("complete");
    });

    it("does not re-fetch a citation the model already checked", async () => {
      stubPages();
      const model = new ScriptedVerifierModel([
        PLAN_STEP,
        fetchStep(CANDIDATE_URL, "call-1"),
        RESEARCH_DONE,
        searchStep("Widget X price", "call-2"),
        CHALLENGE_DONE,
        adjudicateStep(),
      ]);

      const receipt = await verify(request, { host: host(), model });

      expect(receipt.evidence).toHaveLength(1);
      expect(receipt.evidence[0]?.origin).toBe("candidate_citation");
    });

    it("reports a dead citation honestly rather than as a check that passed", async () => {
      vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));

      const model = new ScriptedVerifierModel([
        PLAN_STEP,
        searchStep("Widget X price", "call-1"),
        RESEARCH_DONE,
        searchStep("Widget X price change", "call-2"),
        CHALLENGE_DONE,
        adjudicateStep(),
      ]);

      const receipt = await verify(request, { host: host(), model });

      // The host tried, the URL is dead, and nothing became evidence. The
      // check reports what was retrieved, not what was attempted.
      expect(receipt.evidence).toHaveLength(0);
      expect(receipt.checks.candidateCitationsChecked).toBe(false);
    });

    it("bounds how many citations one caller can make the host fetch", async () => {
      stubPages();
      const model = new ScriptedVerifierModel([
        PLAN_STEP,
        searchStep("Widget X price", "call-1"),
        RESEARCH_DONE,
        searchStep("Widget X price change", "call-2"),
        CHALLENGE_DONE,
        adjudicateStep(),
      ]);

      const receipt = await verify(
        {
          ...request,
          sourceUrls: [
            "https://candidate.example/one",
            "https://candidate.example/two",
            "https://candidate.example/three",
            "https://candidate.example/four",
            "https://candidate.example/five",
          ],
        },
        { host: host(), model },
      );

      // Exactly three: the cap, not the caller's five, and not zero.
      expect(receipt.evidence).toHaveLength(3);
      expect(receipt.evidence.every((entry) => entry.origin === "candidate_citation")).toBe(true);
      expect(receipt.checks.contradictionSearchPerformed).toBe(true);
    });
  });

  it("distinguishes both origins within one receipt", async () => {
    stubPages();
    const model = new ScriptedVerifierModel([
      PLAN_STEP,
      fetchStep(CANDIDATE_URL, "call-1"),
      searchStep("Widget X price", "call-2"),
      fetchStep("https://example.org/widget-x-pricing", "call-3"),
      RESEARCH_DONE,
      searchStep("Widget X price change", "call-4"),
      CHALLENGE_DONE,
      adjudicateStep(
        adjudication({
          adjudications: [
            {
              claimId: "k1",
              status: "supported",
              confidence: 0.85,
              rationale: "The candidate's own source and an independent page both list $79.",
              evidence: [
                { evidenceId: "e1", relation: "supports", note: "candidate's own source" },
                { evidenceId: "e2", relation: "supports", note: "independently found" },
              ],
            },
          ],
        }),
      ),
    ]);

    const receipt = await verify(request, { host: host(), model });

    const origins = receipt.evidence.map((entry) => entry.origin);
    expect(origins).toContain("candidate_citation");
    expect(origins).toContain("independent");
    expect(receipt.checks.candidateCitationsChecked).toBe(true);
  });

  it("reports candidateCitationsChecked false when the caller supplied none", async () => {
    stubPages();
    const model = new ScriptedVerifierModel([
      PLAN_STEP,
      searchStep("Widget X price", "call-1"),
      fetchStep("https://example.org/widget-x-pricing", "call-2"),
      RESEARCH_DONE,
      searchStep("Widget X price change", "call-3"),
      CHALLENGE_DONE,
      adjudicateStep(),
    ]);

    const receipt = await verify(
      { task: request.task, candidateOutput: request.candidateOutput },
      { host: host(), model },
    );

    // Nothing to check is reported as such, never as a check that passed.
    expect(receipt.checks.candidateCitationsChecked).toBe(false);
  });

  it("does not let a dead candidate citation become evidence", async () => {
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));

    const model = new ScriptedVerifierModel([
      PLAN_STEP,
      fetchStep(CANDIDATE_URL, "call-1"),
      RESEARCH_DONE,
      searchStep("Widget X price", "call-2"),
      CHALLENGE_DONE,
      adjudicateStep(),
    ]);

    const receipt = await verify(request, { host: host(), model });

    expect(receipt.evidence).toHaveLength(0);
    expect(receipt.checks.candidateCitationsChecked).toBe(false);
    // The claim cited e1, which never came into existence.
    expect(receipt.claims[0]?.status).toBe("unverified");
    expect(receipt.claims[0]?.adjusted).toMatch(/no retrieved source/i);
  });

  /**
   * Independence has to survive the whole pipeline, not just the validator.
   *
   * TrustLayer is sold as verification that does not take the candidate's word
   * for anything — including which sources are worth believing.
   */
  describe("independence end to end", () => {
    it("will not call a claim supported on the candidate's own source alone", async () => {
      stubPages();
      const model = new ScriptedVerifierModel([
        PLAN_STEP,
        fetchStep(CANDIDATE_URL, "call-1"),
        RESEARCH_DONE,
        searchStep("Widget X price", "call-2"),
        CHALLENGE_DONE,
        adjudicateStep(),
      ]);

      const receipt = await verify(request, { host: host(), model });

      expect(receipt.claims[0]?.status).toBe("unverified");
      expect(receipt.claims[0]?.adjusted).toMatch(/no independent supporting source/i);
      expect(receipt.overallStatus).toBe("unverified");
      // The candidate's source is still shown — it was really retrieved.
      expect(receipt.evidence[0]?.origin).toBe("candidate_citation");
    });

    it("calls it supported once an independent source backs it too", async () => {
      stubPages();
      const model = new ScriptedVerifierModel([
        PLAN_STEP,
        fetchStep(CANDIDATE_URL, "call-1"),
        searchStep("Widget X price", "call-2"),
        fetchStep("https://example.org/widget-x-pricing", "call-3"),
        RESEARCH_DONE,
        searchStep("Widget X price increase", "call-4"),
        CHALLENGE_DONE,
        adjudicateStep(
          adjudication({
            adjudications: [
              {
                claimId: "k1",
                status: "supported",
                confidence: 0.9,
                rationale: "Both the candidate's source and an independent page list $79.",
                evidence: [
                  { evidenceId: "e1", relation: "supports", note: "candidate's own" },
                  { evidenceId: "e2", relation: "supports", note: "independent" },
                ],
              },
            ],
          }),
        ),
      ]);

      const receipt = await verify(request, { host: host(), model });

      expect(receipt.claims[0]?.status).toBe("supported");
      expect(receipt.claims[0]?.adjusted).toBeUndefined();
    });

    it("still counts a rediscovered candidate URL as the candidate's source", async () => {
      stubPages();
      const model = new ScriptedVerifierModel([
        PLAN_STEP,
        searchStep("Widget X price", "call-1"),
        // Same source, found through search this time, and spelled with a
        // different case and a trailing slash. Canonical matching decides.
        fetchStep("https://EXAMPLE.org/widget-x-pricing/", "call-2"),
        RESEARCH_DONE,
        searchStep("Widget X price increase", "call-3"),
        CHALLENGE_DONE,
        adjudicateStep(),
      ]);

      const receipt = await verify(
        { ...request, sourceUrls: ["https://example.org/widget-x-pricing"] },
        { host: host(), model },
      );

      const rediscovered = receipt.evidence.find((entry) =>
        entry.url.toLowerCase().includes("widget-x-pricing"),
      );
      expect(rediscovered?.origin).toBe("candidate_citation");
      // And so it cannot launder itself into independent support.
      expect(receipt.claims[0]?.status).toBe("unverified");
    });
  });
});
