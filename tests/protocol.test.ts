import { afterEach, describe, expect, it, vi } from "vitest";

import { verify } from "../src/api/verify.js";
import { deriveOverallStatus, deriveProtocolStatus } from "../src/evidence/receipt.js";
import { ProtocolState } from "../src/verifier/protocol.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { ScriptedVerifierModel } from "../src/verifier/model.js";
import type { ReceiptChecks, ReceiptClaim } from "../src/evidence/schemas.js";
import {
  CHALLENGE_DONE,
  PLAN_STEP,
  RESEARCH_DONE,
  adjudicateStep,
  adjudication,
  fetchStep,
  fullProtocolScript,
  pricingPage,
  publicDns,
  searchStep,
  staticBackend,
} from "./fixtures.js";

/**
 * Protocol completion is host-derived.
 *
 * The receipt says a contradiction search happened. These tests exist to prove
 * that statement tracks observed tool calls rather than the model's word, by
 * scripting models that skip phases and checking the receipt notices.
 */
describe("protocol state", () => {
  it("counts a contradiction search only when a search succeeded in the challenge phase", () => {
    const protocol = new ProtocolState();

    protocol.enter("discover");
    protocol.recordToolResult("research.search", true);
    // A search happened, but not in the challenge phase.
    expect(protocol.independentSearchPerformed).toBe(true);
    expect(protocol.contradictionSearchPerformed).toBe(false);

    protocol.enter("challenge");
    expect(protocol.contradictionSearchPerformed).toBe(false);

    protocol.recordToolResult("research.search", true);
    expect(protocol.contradictionSearchPerformed).toBe(true);
  });

  it("does not count a challenge search that failed", () => {
    const protocol = new ProtocolState();
    protocol.enter("challenge");
    protocol.recordToolResult("research.search", false);

    expect(protocol.contradictionSearchPerformed).toBe(false);
  });

  it("does not count a fetch as a search", () => {
    const protocol = new ProtocolState();
    protocol.enter("challenge");
    protocol.recordToolResult("research.fetch", true);

    expect(protocol.contradictionSearchPerformed).toBe(false);
    expect(protocol.sourcesFetched).toBe(true);
  });

  /**
   * Searching for refutation and never opening what came back is a search, not
   * a check. The two are tracked apart so the receipt can say which happened.
   */
  describe("challenge completion", () => {
    it("is incomplete while leads found by the challenge search sit unopened", () => {
      const protocol = new ProtocolState();
      protocol.enter("challenge");
      protocol.recordToolResult("research.search", true, 3);

      expect(protocol.contradictionSearchPerformed).toBe(true);
      expect(protocol.challengeSearchProducedCandidates).toBe(true);
      expect(protocol.challengeEvidenceFetched).toBe(false);
      expect(protocol.challengeComplete).toBe(false);
    });

    it("is complete once one of those leads is retrieved", () => {
      const protocol = new ProtocolState();
      protocol.enter("challenge");
      protocol.recordToolResult("research.search", true, 3);
      protocol.recordToolResult("research.fetch", true);

      expect(protocol.challengeEvidenceFetched).toBe(true);
      expect(protocol.challengeComplete).toBe(true);
    });

    it("is complete when the challenge search honestly found nothing to open", () => {
      const protocol = new ProtocolState();
      protocol.enter("challenge");
      protocol.recordToolResult("research.search", true, 0);

      // Nothing to retrieve is a finished challenge, not a skipped one.
      expect(protocol.challengeSearchProducedCandidates).toBe(false);
      expect(protocol.challengeComplete).toBe(true);
    });

    it("is incomplete when the challenge search failed", () => {
      const protocol = new ProtocolState();
      protocol.enter("challenge");
      protocol.recordToolResult("research.search", false, 0);

      expect(protocol.challengeComplete).toBe(false);
    });

    it("does not count a fetch made before the challenge phase", () => {
      const protocol = new ProtocolState();
      protocol.enter("discover");
      protocol.recordToolResult("research.search", true, 2);
      protocol.recordToolResult("research.fetch", true);
      protocol.enter("challenge");
      protocol.recordToolResult("research.search", true, 2);

      // The research fetch belongs to research. The challenge still owes one.
      expect(protocol.sourcesFetched).toBe(true);
      expect(protocol.challengeEvidenceFetched).toBe(false);
      expect(protocol.challengeComplete).toBe(false);
    });
  });
});

describe("protocol status", () => {
  const allChecks: ReceiptChecks = {
    independentSearchPerformed: true,
    sourcesFetched: true,
    candidateCitationsChecked: false,
    contradictionSearchPerformed: true,
    contradictionSearchProducedCandidates: true,
    contradictionEvidenceFetched: true,
    evidenceReferencesValidated: true,
  };

  function completedProtocol(): ProtocolState {
    const protocol = new ProtocolState();
    protocol.complete("plan");
    protocol.complete("adjudicate");
    return protocol;
  }

  it("is complete when every required phase ran", () => {
    expect(deriveProtocolStatus(completedProtocol(), allChecks, true)).toBe("complete");
  });

  it("is failed when no adjudication was produced", () => {
    expect(deriveProtocolStatus(completedProtocol(), allChecks, false)).toBe("failed");
  });

  it("is partial when the contradiction search did not happen", () => {
    expect(
      deriveProtocolStatus(
        completedProtocol(),
        { ...allChecks, contradictionSearchPerformed: false },
        true,
      ),
    ).toBe("partial");
  });

  it("is partial when nothing was fetched", () => {
    expect(
      deriveProtocolStatus(completedProtocol(), { ...allChecks, sourcesFetched: false }, true),
    ).toBe("partial");
  });

  it("is partial when a phase recorded a failure", () => {
    const protocol = completedProtocol();
    protocol.fail("discover", "search provider timed out");

    expect(deriveProtocolStatus(protocol, allChecks, true)).toBe("partial");
  });
});

describe("overall status", () => {
  function claim(
    status: ReceiptClaim["status"],
    importance: ReceiptClaim["importance"] = "material",
  ): ReceiptClaim {
    return {
      claimId: "k",
      claim: "a claim",
      importance,
      status,
      confidence: 0.8,
      rationale: "r",
      evidence: [],
    };
  }

  it("is supported only when every falsifiable claim held", () => {
    expect(deriveOverallStatus([claim("supported"), claim("supported")])).toBe("supported");
  });

  it("is contradicted when a critical claim was refuted", () => {
    expect(
      deriveOverallStatus([claim("contradicted", "critical"), claim("supported"), claim("supported")]),
    ).toBe("contradicted");
  });

  it("is mixed when support and contradiction coexist without a critical failure", () => {
    expect(
      deriveOverallStatus([claim("supported"), claim("supported"), claim("contradicted", "minor")]),
    ).toBe("mixed");
  });

  it("is mixed when some claims held and others could not be established", () => {
    expect(deriveOverallStatus([claim("supported"), claim("unverified")])).toBe("mixed");
  });

  it("is unverified when nothing was established either way", () => {
    expect(deriveOverallStatus([claim("unverified"), claim("unverified")])).toBe("unverified");
  });

  it("is unverified when every claim was non-falsifiable", () => {
    expect(deriveOverallStatus([claim("not_falsifiable"), claim("not_falsifiable")])).toBe(
      "unverified",
    );
  });

  it("ignores non-falsifiable claims when judging the rest", () => {
    expect(deriveOverallStatus([claim("supported"), claim("not_falsifiable")])).toBe("supported");
  });
});

describe("protocol completion end to end", () => {
  const request = { task: "How much does Widget X cost?", candidateOutput: "Widget X costs $79." };

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

  it("reports every check true when the protocol really ran", async () => {
    stubPages();
    const model = new ScriptedVerifierModel(fullProtocolScript());

    const receipt = await verify(request, { host: host(), model });

    expect(receipt.checks.independentSearchPerformed).toBe(true);
    expect(receipt.checks.sourcesFetched).toBe(true);
    expect(receipt.checks.contradictionSearchPerformed).toBe(true);
    expect(receipt.checks.contradictionSearchProducedCandidates).toBe(true);
    expect(receipt.checks.contradictionEvidenceFetched).toBe(true);
    expect(receipt.checks.evidenceReferencesValidated).toBe(true);
    // Nothing was supplied to check, so this stays honestly false.
    expect(receipt.checks.candidateCitationsChecked).toBe(false);
    expect(receipt.protocolStatus).toBe("complete");
  });

  it("reports contradictionSearchPerformed false when the model skipped the challenge search", async () => {
    stubPages();
    // The model goes straight through the challenge phase without searching.
    const model = new ScriptedVerifierModel([
      PLAN_STEP,
      searchStep("Widget X price", "call-1"),
      fetchStep("https://example.org/widget-x-pricing", "call-2"),
      RESEARCH_DONE,
      CHALLENGE_DONE,
      adjudicateStep(),
    ]);

    const receipt = await verify(request, { host: host(), model });

    expect(receipt.checks.contradictionSearchPerformed).toBe(false);
    expect(receipt.protocolStatus).toBe("partial");
  });

  it("reports sourcesFetched false when the model only searched", async () => {
    const model = new ScriptedVerifierModel([
      PLAN_STEP,
      searchStep("Widget X price", "call-1"),
      RESEARCH_DONE,
      searchStep("Widget X price change", "call-2"),
      CHALLENGE_DONE,
      // Claims support with no fetched evidence: validation will downgrade it.
      adjudicateStep(),
    ]);

    const receipt = await verify(request, { host: host(), model });

    expect(receipt.checks.sourcesFetched).toBe(false);
    expect(receipt.protocolStatus).toBe("partial");
    // The snippet-only claim did not survive: search is discovery, not evidence.
    expect(receipt.claims[0]?.status).toBe("unverified");
    expect(receipt.overallStatus).toBe("unverified");
  });

  it("cannot be talked into a check by the model's own summary", async () => {
    stubPages();
    const model = new ScriptedVerifierModel([
      PLAN_STEP,
      searchStep("Widget X price", "call-1"),
      fetchStep("https://example.org/widget-x-pricing", "call-2"),
      RESEARCH_DONE,
      CHALLENGE_DONE,
      adjudicateStep(
        adjudication({
          summary:
            "I performed an exhaustive contradiction search across many independent sources.",
        }),
      ),
    ]);

    const receipt = await verify(request, { host: host(), model });

    // The prose says one thing; the observed tool calls say another, and the
    // receipt reports the tool calls.
    expect(receipt.summary).toMatch(/exhaustive contradiction search/);
    expect(receipt.checks.contradictionSearchPerformed).toBe(false);
    expect(receipt.protocolStatus).toBe("partial");
  });

  /**
   * The difference between looking for a contradiction and checking for one.
   *
   * A search that returns three plausible refutations and is never opened
   * tells the caller nothing, so the receipt distinguishes the two and the
   * protocol only counts as complete when the retrieval happened — or when
   * there was honestly nothing to retrieve.
   */
  describe("challenge evidence", () => {
    it("is partial when the challenge search found leads and opened none", async () => {
      stubPages();
      const model = new ScriptedVerifierModel([
        PLAN_STEP,
        searchStep("Widget X price", "call-1"),
        fetchStep("https://example.org/widget-x-pricing", "call-2"),
        RESEARCH_DONE,
        searchStep("Widget X price increase", "call-3"),
        CHALLENGE_DONE,
        adjudicateStep(),
      ]);

      const receipt = await verify(request, { host: host(), model });

      expect(receipt.checks.contradictionSearchPerformed).toBe(true);
      expect(receipt.checks.contradictionSearchProducedCandidates).toBe(true);
      expect(receipt.checks.contradictionEvidenceFetched).toBe(false);
      expect(receipt.protocolStatus).toBe("partial");
    });

    it("is complete when the challenge search genuinely turned up nothing", async () => {
      stubPages();
      const model = new ScriptedVerifierModel([
        PLAN_STEP,
        searchStep("Widget X price", "call-1"),
        fetchStep("https://example.org/widget-x-pricing", "call-2"),
        RESEARCH_DONE,
        // Nothing in the corpus matches, so the search succeeds with no leads.
        searchStep("quokka husbandry regulations", "call-3"),
        CHALLENGE_DONE,
        adjudicateStep(),
      ]);

      const receipt = await verify(request, { host: host(), model });

      expect(receipt.checks.contradictionSearchPerformed).toBe(true);
      expect(receipt.checks.contradictionSearchProducedCandidates).toBe(false);
      expect(receipt.checks.contradictionEvidenceFetched).toBe(false);
      // Looking and finding nothing is a finished challenge.
      expect(receipt.protocolStatus).toBe("complete");
    });

    it("is partial when the challenge search itself failed", async () => {
      stubPages();
      const failing = {
        id: "failing-on-challenge",
        async search(query: string) {
          if (query.includes("increase")) throw new Error("backend down");
          return staticBackend().search(query);
        },
      };
      const failingHost = createTrustLayerHost({
        searchBackend: failing,
        resolveHost: publicDns,
      });

      const model = new ScriptedVerifierModel([
        PLAN_STEP,
        searchStep("Widget X price", "call-1"),
        fetchStep("https://example.org/widget-x-pricing", "call-2"),
        RESEARCH_DONE,
        searchStep("Widget X price increase", "call-3"),
        CHALLENGE_DONE,
        adjudicateStep(),
      ]);

      const receipt = await verify(request, { host: failingHost, model });

      expect(receipt.checks.contradictionSearchPerformed).toBe(false);
      expect(receipt.protocolStatus).toBe("partial");
    });

    it("does not let a candidate-citation fetch stand in for challenge evidence", async () => {
      stubPages();
      const model = new ScriptedVerifierModel([
        PLAN_STEP,
        searchStep("Widget X price", "call-1"),
        fetchStep("https://example.org/widget-x-pricing", "call-2"),
        RESEARCH_DONE,
        searchStep("Widget X price increase", "call-3"),
        CHALLENGE_DONE,
        adjudicateStep(),
      ]);

      // The host chases the supplied citation during research, before the
      // challenge phase — so it cannot be mistaken for contradiction evidence.
      const receipt = await verify(
        { ...request, sourceUrls: ["https://candidate.example/its-source"] },
        { host: host(), model },
      );

      expect(receipt.checks.candidateCitationsChecked).toBe(true);
      expect(receipt.checks.contradictionEvidenceFetched).toBe(false);
      expect(receipt.protocolStatus).toBe("partial");
    });

    it("cannot be talked into challenge evidence by the model's own summary", async () => {
      stubPages();
      const model = new ScriptedVerifierModel([
        PLAN_STEP,
        searchStep("Widget X price", "call-1"),
        fetchStep("https://example.org/widget-x-pricing", "call-2"),
        RESEARCH_DONE,
        searchStep("Widget X price increase", "call-3"),
        CHALLENGE_DONE,
        adjudicateStep(
          adjudication({
            summary:
              "I retrieved and read three sources that might have contradicted the claim, " +
              "and none of them did.",
          }),
        ),
      ]);

      const receipt = await verify(request, { host: host(), model });

      expect(receipt.checks.contradictionEvidenceFetched).toBe(false);
      expect(receipt.protocolStatus).toBe("partial");
    });
  });
});
