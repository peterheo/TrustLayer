import { afterEach, describe, expect, it, vi } from "vitest";

import { verify } from "../src/api/verify.js";
import { METHOD_VERSION } from "../src/evidence/schemas.js";
import { verifierGrants } from "../src/sharedos/grants.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { ScriptedVerifierModel } from "../src/verifier/model.js";
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
 * The whole protocol, end to end: a real SharedOS turn, real tool calls
 * through the kernel, a real execution record, and a receipt built entirely
 * from trusted state.
 */
describe("verify() — evidence receipt", () => {
  const request = {
    task: "How much does Widget X cost?",
    candidateOutput: "Widget X costs $79.",
  };

  function host() {
    return createTrustLayerHost({ searchBackend: staticBackend(), resolveHost: publicDns });
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("runs the full protocol and returns a complete receipt", async () => {
    stubPages();
    const model = new ScriptedVerifierModel(fullProtocolScript());

    const receipt = await verify(request, { host: host(), model });

    expect(receipt.protocolStatus).toBe("complete");
    expect(receipt.overallStatus).toBe("supported");
    expect(receipt.methodVersion).toBe(METHOD_VERSION);
    expect(receipt.reportId).toMatch(/^rpt_[0-9a-f-]{36}$/);
    expect(receipt.claims).toHaveLength(1);
    expect(receipt.claims[0]?.status).toBe("supported");
  });

  it("carries no trust score of any kind", async () => {
    stubPages();
    const model = new ScriptedVerifierModel(fullProtocolScript());

    const receipt = await verify(request, { host: host(), model });

    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toMatch(/trustScore|trust_score/i);
    expect(Object.keys(receipt)).not.toContain("trustScore");
  });

  it("records evidence the tools actually retrieved, with host-generated provenance", async () => {
    stubPages();
    const model = new ScriptedVerifierModel(fullProtocolScript());

    const receipt = await verify(request, { host: host(), model });

    // Two retrievals: the research fetch, and the one the challenge phase
    // turned up and opened.
    expect(receipt.evidence).toHaveLength(2);
    const evidence = receipt.evidence[0]!;
    expect(evidence.evidenceId).toBe("e1");
    expect(evidence.resolvedUrl).toBe("https://example.org/widget-x-pricing");
    expect(evidence.domain).toBe("example.org");
    expect(evidence.origin).toBe("independent");
    // SHA-256 of the quarantined text, minted in the ledger.
    expect(evidence.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(evidence.retrievedAt)).toBeGreaterThan(0);
  });

  it("derives provenance from the SharedOS execution, not from the model", async () => {
    stubPages();
    const model = new ScriptedVerifierModel(fullProtocolScript());

    const receipt = await verify(request, { host: host(), model });

    expect(receipt.provenance.purpose).toBe("trust.verify");
    expect(receipt.provenance.sharedosStatus).toBe("succeeded");
    expect([...receipt.provenance.toolsUsed].sort()).toEqual(["research.fetch", "research.search"]);
    expect(receipt.provenance.executionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.provenance.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(receipt.provenance.traceId).not.toBe(receipt.provenance.executionId);
  });

  it("reports coverage over what was selected and what was actually investigated", async () => {
    stubPages();
    const model = new ScriptedVerifierModel(fullProtocolScript());

    const receipt = await verify(request, { host: host(), model });

    expect(receipt.coverage.claimsSelected).toBe(1);
    expect(receipt.coverage.claimsChecked).toBe(1);
    expect(receipt.coverage.criticalClaimsTotal).toBe(1);
    expect(receipt.coverage.criticalClaimsChecked).toBe(1);
    expect(receipt.coverage.sourcesFetched).toBe(2);
    expect(receipt.coverage.distinctDomains).toBe(2);
    // Discovery found more than retrieval used, which is the normal shape.
    expect(receipt.coverage.searchCandidates).toBeGreaterThanOrEqual(1);
  });

  it("leaves a SharedOS audit trail under the single purpose", async () => {
    stubPages();
    const model = new ScriptedVerifierModel(fullProtocolScript());
    const trustlayer = host();

    await verify(request, { host: trustlayer, model });

    const types = trustlayer.audit.events.map((event) => event.type);
    expect(types).toContain("authority.resolved");
    expect(types).toContain("tool.catalog.listed");
    expect(types).toContain("authorization.checked");
    expect(types).toContain("tool.invoked");
    expect(types).toContain("turn.ended");

    const purposes = new Set(
      trustlayer.audit.events.map((event) => (event as unknown as { purpose: string }).purpose),
    );
    expect([...purposes]).toEqual(["trust.verify"]);
  });

  it("skips the planning round-trip when the caller supplies focusClaims", async () => {
    stubPages();
    // No PLAN_STEP in this script: planning is host code when focus is given.
    const model = new ScriptedVerifierModel([
      searchStep("fare EUR 412", "call-1"),
      fetchStep("https://example.org/widget-x-pricing", "call-2"),
      RESEARCH_DONE,
      searchStep("fare changed", "call-3"),
      CHALLENGE_DONE,
      adjudicateStep(),
    ]);

    const receipt = await verify(
      { ...request, focusClaims: ["The quoted fare is EUR 412."] },
      { host: host(), model },
    );

    expect(receipt.claims).toHaveLength(1);
    expect(receipt.claims[0]?.claim).toBe("The quoted fare is EUR 412.");
    // A caller-named claim is treated as decision-critical.
    expect(receipt.claims[0]?.importance).toBe("critical");
    expect(receipt.protocolStatus).toBe("complete");
  });

  it("reports a SharedOS denial as a denial, never as a receipt", async () => {
    stubPages();
    const trustlayer = createTrustLayerHost({
      searchBackend: staticBackend(),
      resolveHost: publicDns,
      grants: verifierGrants({ withExecution: false }),
    });
    const model = new ScriptedVerifierModel(fullProtocolScript());

    await expect(verify(request, { host: trustlayer, model })).rejects.toMatchObject({
      code: "SHAREDOS_DENIED",
    });
  });

  it("rejects an oversized candidate output before spending a turn", async () => {
    const model = new ScriptedVerifierModel([]);

    await expect(
      verify({ task: "t", candidateOutput: "x".repeat(40_001) }, { host: host(), model }),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(model.observations).toHaveLength(0);
  });

  it("reports an unusable adjudication as a model failure", async () => {
    stubPages();
    const model = new ScriptedVerifierModel([
      PLAN_STEP,
      searchStep("Widget X price", "call-1"),
      fetchStep("https://example.org/widget-x-pricing", "call-2"),
      RESEARCH_DONE,
      searchStep("Widget X price increase", "call-3"),
      CHALLENGE_DONE,
      { kind: "submit", submission: "submit_adjudication", payload: { nonsense: true } },
    ]);

    await expect(verify(request, { host: host(), model })).rejects.toMatchObject({
      code: "MODEL_FAILURE",
    });
  });

  it("returns a receipt whose summary comes from the model but whose facts do not", async () => {
    stubPages();
    const model = new ScriptedVerifierModel(
      fullProtocolScript(adjudication({ summary: "A model-authored summary." })),
    );

    const receipt = await verify(request, { host: host(), model });

    expect(receipt.summary).toBe("A model-authored summary.");
    // Everything else is host-derived and unaffected by what the model wrote.
    expect(receipt.checks.evidenceReferencesValidated).toBe(true);
    expect(receipt.provenance.toolsUsed.length).toBeGreaterThan(0);
  });
});
