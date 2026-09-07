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
});

describe("protocol status", () => {
  const allChecks: ReceiptChecks = {
    independentSearchPerformed: true,
    sourcesFetched: true,
    candidateCitationsChecked: false,
    contradictionSearchPerformed: true,
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
});
