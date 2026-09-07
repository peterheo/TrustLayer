import { describe, expect, it, vi } from "vitest";

import { ScriptedVerifierModel } from "../src/agent/model.js";
import { verify } from "../src/api/verify.js";
import { UnavailableSearchBackend } from "../src/research/search-backend.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { judgment, searchThenSubmit, staticBackend } from "./fixtures.js";
import type { VerifierJudgment } from "../src/verification/schemas.js";

/**
 * The verdict classes, end to end through a real turn.
 *
 * The model is scripted so these assert TrustLayer's behaviour rather than a
 * model's; what a real model decides is a separate, non-deterministic question.
 */
describe("verification behaviour", () => {
  const request = { task: "How much does Widget X cost?", candidateOutput: "Widget X costs $79." };

  async function run(final: VerifierJudgment) {
    const host = createTrustLayerHost({ searchBackend: staticBackend() });
    const model = new ScriptedVerifierModel(searchThenSubmit(final));
    const response = await verify(request, { host, model });
    return { host, response };
  }

  const base = judgment().claims[0]!;
  const realCitation = [{ sourceId: "src-1", relation: "supports" as const, note: "listed $79" }];

  it("reports a correct factual claim as supported", async () => {
    const { response } = await run(judgment());
    expect(response.verdict).toBe("supported");
    expect(response.trustScore).toBe(100);
  });

  it("reports a refuted factual claim as contradicted", async () => {
    const { response } = await run(
      judgment({
        summary: "The stated price is refuted by the manufacturer's page.",
        claims: [
          {
            ...base,
            claim: "Widget X costs $19.",
            status: "contradicted",
            evidence: [{ sourceId: "src-1", relation: "contradicts", note: "the page lists $79" }],
          },
        ],
      }),
    );

    expect(response.verdict).toBe("contradicted");
    expect(response.trustScore).toBe(0);
  });

  it("reports insufficient evidence as unverified rather than false", async () => {
    const { response } = await run(
      judgment({
        summary: "No source established the claim either way.",
        claims: [{ ...base, status: "unverified", evidence: [] }],
      }),
    );

    expect(response.verdict).toBe("unverified");
    expect(response.trustScore).toBe(40);
  });

  it("reports a partly-right answer as mixed", async () => {
    const { response } = await run(
      judgment({
        summary: "The price is right; the availability claim is not established.",
        claims: [
          { ...base, importance: 3, status: "supported", evidence: realCitation },
          { ...base, claim: "Widget X ships same day.", importance: 2, status: "unverified", evidence: [] },
        ],
      }),
    );

    expect(response.verdict).toBe("mixed");
  });

  it("surfaces a currency problem as an unverified claim with a stated reason", async () => {
    const { response } = await run(
      judgment({
        summary: "The price may be stale; the newest source predates the claim.",
        claims: [
          {
            ...base,
            status: "unverified",
            rationale: "The only pricing source is dated 2026-08-01 and may no longer be current.",
            evidence: realCitation,
          },
        ],
      }),
    );

    expect(response.verdict).toBe("unverified");
    expect(response.claims[0]?.rationale).toMatch(/current|stale|dated/i);
  });

  it("keeps a reported source conflict visible in the claim table", async () => {
    const { response } = await run(
      judgment({
        summary: "Reliable sources disagree on the price.",
        claims: [
          {
            ...base,
            status: "unverified",
            rationale: "One source lists $79 and another lists $89; the conflict is unresolved.",
            evidence: [
              { sourceId: "src-1", relation: "supports", note: "lists $79" },
              { sourceId: "src-2", relation: "contradicts", note: "lists $89" },
            ],
          },
        ],
      }),
    );

    expect(response.claims[0]?.evidence.map((entry) => entry.relation).sort()).toEqual([
      "contradicts",
      "supports",
    ]);
    expect(response.verdict).toBe("unverified");
  });

  it("excludes a non-falsifiable claim from the score", async () => {
    const { response } = await run(
      judgment({
        summary: "The remaining statement is an opinion.",
        claims: [
          { ...base, status: "supported", evidence: realCitation },
          { ...base, claim: "Widget X is the best widget.", status: "not_falsifiable", evidence: [] },
        ],
      }),
    );

    expect(response.trustScore).toBe(100);
    expect(response.verdict).toBe("supported");
  });

  it("represents a dead URL as absent evidence, not as a contradiction", async () => {
    vi.stubGlobal("fetch", async () => new Response("gone", { status: 404 }));

    const host = createTrustLayerHost({
      searchBackend: staticBackend(),
      resolveHost: async () => ["93.184.216.34"],
    });
    const model = new ScriptedVerifierModel([
      {
        kind: "tool_call",
        callId: "call-1",
        toolName: "research.fetch",
        arguments: { url: "https://example.com/missing-page" },
      },
      {
        kind: "final",
        output: judgment({
          summary: "The cited page is unavailable, so the claim is unverified.",
          claims: [
            {
              ...base,
              status: "unverified",
              rationale: "The candidate's source URL returned 404, so nothing confirms the price.",
              evidence: [],
            },
          ],
        }),
      },
    ]);

    const response = await verify(request, { host, model });

    expect(response.verdict).toBe("unverified");
    expect(response.claims[0]?.status).not.toBe("contradicted");
    // A failed fetch is not a tool "used" to produce the verdict.
    expect(response.audit.toolsUsed).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("surfaces a missing research backend rather than silently returning no evidence", async () => {
    const host = createTrustLayerHost({ searchBackend: new UnavailableSearchBackend() });
    const model = new ScriptedVerifierModel(searchThenSubmit(judgment()));

    await verify(request, { host, model });

    // The tool failed, so the model saw a failure and no evidence was ledgered.
    const observation = model.observations.at(-1);
    expect(observation).toMatchObject({ kind: "tool_result", ok: false });
    expect(observation).toMatchObject({
      payload: expect.objectContaining({ error: "research_unavailable" }),
    });
  });
});
