import { describe, expect, it } from "vitest";

import { ScriptedVerifierModel } from "../src/agent/model.js";
import { verify } from "../src/api/verify.js";
import { EvidenceLedger, EvidenceLedgerRegistry } from "../src/research/evidence-ledger.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { capClaims, normalizeJudgment } from "../src/verification/normalize.js";
import type { ClaimJudgment } from "../src/verification/schemas.js";
import { judgment, searchThenSubmit, staticBackend } from "./fixtures.js";

function ledgerWith(...sourceIds: string[]): EvidenceLedger {
  const ledger = new EvidenceLedger();
  for (const sourceId of sourceIds) {
    ledger.record({
      sourceId,
      url: `https://example.com/${sourceId}`,
      retrievedAt: "2026-09-07T00:00:00.000Z",
      via: "research.search",
    });
  }
  return ledger;
}

/**
 * A fact-checker that invents citations is worse than none, because its output
 * looks rigorous. These tests are the guard against that.
 */
describe("evidence validation", () => {
  it("keeps a claim supported when its citation is real", () => {
    const { judgment: result, report } = normalizeJudgment(judgment(), ledgerWith("src-1"));

    expect(result.claims[0]?.status).toBe("supported");
    expect(result.claims[0]?.evidence).toHaveLength(1);
    expect(report.fabricatedSourceIds).toEqual([]);
  });

  it("drops a citation the tools never returned", () => {
    const fabricated = judgment({
      claims: [
        {
          ...judgment().claims[0]!,
          evidence: [
            { sourceId: "src-1", relation: "supports", note: "real" },
            { sourceId: "src-99", relation: "supports", note: "invented" },
          ],
        },
      ],
    });

    const { judgment: result, report } = normalizeJudgment(fabricated, ledgerWith("src-1"));

    expect(result.claims[0]?.evidence.map((reference) => reference.sourceId)).toEqual(["src-1"]);
    expect(report.fabricatedSourceIds).toEqual(["src-99"]);
    // Still supported: one real citation survived.
    expect(result.claims[0]?.status).toBe("supported");
  });

  it("downgrades a supported claim whose every citation was invented", () => {
    const fabricated = judgment({
      claims: [
        {
          ...judgment().claims[0]!,
          evidence: [{ sourceId: "src-99", relation: "supports", note: "invented" }],
        },
      ],
    });

    const { judgment: result, report } = normalizeJudgment(fabricated, ledgerWith("src-1"));

    expect(result.claims[0]?.status).toBe("unverified");
    expect(result.claims[0]?.evidence).toEqual([]);
    expect(result.claims[0]?.confidence).toBeLessThanOrEqual(0.3);
    expect(report.downgradedClaims).toEqual(["Widget X costs $79."]);
  });

  it("downgrades an unsupported contradiction to unverified, never the reverse", () => {
    const fabricated = judgment({
      claims: [
        {
          ...judgment().claims[0]!,
          status: "contradicted",
          evidence: [{ sourceId: "src-99", relation: "contradicts", note: "invented" }],
        },
      ],
    });

    const { judgment: result } = normalizeJudgment(fabricated, ledgerWith("src-1"));

    // Missing evidence must not become a finding against the candidate.
    expect(result.claims[0]?.status).toBe("unverified");
  });

  it("leaves unverified and not_falsifiable claims alone", () => {
    const base = judgment().claims[0]!;
    const mixed = judgment({
      claims: [
        { ...base, status: "unverified", evidence: [] },
        { ...base, status: "not_falsifiable", evidence: [] },
      ],
    });

    const { judgment: result, report } = normalizeJudgment(mixed, ledgerWith("src-1"));

    expect(result.claims.map((claim) => claim.status)).toEqual([
      "unverified",
      "not_falsifiable",
    ]);
    expect(report.downgradedClaims).toEqual([]);
  });

  it("reports fabricated citations as a security indicator", () => {
    const fabricated = judgment({
      claims: [
        {
          ...judgment().claims[0]!,
          evidence: [{ sourceId: "src-99", relation: "supports", note: "invented" }],
        },
      ],
    });

    const { judgment: result } = normalizeJudgment(fabricated, ledgerWith("src-1"));

    expect(result.security.indicators.join(" ")).toMatch(/no research tool returned/i);
  });

  it("end to end: a fabricated citation cannot produce a supported verdict", async () => {
    const host = createTrustLayerHost({ searchBackend: staticBackend() });
    const model = new ScriptedVerifierModel(
      searchThenSubmit(
        judgment({
          claims: [
            {
              ...judgment().claims[0]!,
              evidence: [
                { sourceId: "src-9000", relation: "supports", note: "a source never returned" },
              ],
            },
          ],
        }),
      ),
    );

    const response = await verify(
      { task: "How much is Widget X?", candidateOutput: "Widget X costs $79." },
      { host, model },
    );

    expect(response.claims[0]?.status).toBe("unverified");
    expect(response.verdict).toBe("unverified");
    expect(response.trustScore).toBe(40);
  });
});

describe("evidence ledger isolation", () => {
  it("keeps one execution's evidence out of another's", () => {
    const registry = new EvidenceLedgerRegistry();
    const first = registry.open("trace-a");
    const second = registry.open("trace-b");

    first.record({
      sourceId: first.nextSourceId(),
      url: "https://example.com/a",
      retrievedAt: "2026-09-07T00:00:00.000Z",
      via: "research.search",
    });

    expect(first.has("src-1")).toBe(true);
    expect(second.has("src-1")).toBe(false);
  });

  it("hands an unknown trace a detached ledger that validates nothing", () => {
    const registry = new EvidenceLedgerRegistry();
    registry.open("trace-a");

    expect(registry.for("trace-unknown").size).toBe(0);
    expect(registry.for("trace-unknown").has("src-1")).toBe(false);
  });

  it("closes a ledger when its execution ends", () => {
    const registry = new EvidenceLedgerRegistry();
    const ledger = registry.open("trace-a");
    ledger.record({
      sourceId: ledger.nextSourceId(),
      url: "https://example.com/a",
      retrievedAt: "2026-09-07T00:00:00.000Z",
      via: "research.search",
    });

    registry.close("trace-a");

    expect(registry.for("trace-a").has("src-1")).toBe(false);
  });
});

describe("claim capping", () => {
  function claim(importance: 1 | 2 | 3, status: ClaimJudgment["status"]): ClaimJudgment {
    return {
      claim: `${status}-${importance}`,
      importance,
      status,
      confidence: 0.5,
      rationale: "r",
      evidence: [],
    };
  }

  it("keeps the most decision-relevant claims when trimming", () => {
    const capped = capClaims(
      [
        claim(1, "supported"),
        claim(3, "contradicted"),
        claim(2, "unverified"),
        claim(1, "supported"),
      ],
      2,
    );

    expect(capped.map((entry) => entry.claim)).toEqual(["contradicted-3", "unverified-2"]);
  });

  it("leaves a table already within budget untouched", () => {
    const claims = [claim(1, "supported"), claim(2, "unverified")];
    expect(capClaims(claims, 5)).toEqual(claims);
  });
});
