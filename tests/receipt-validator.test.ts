import { describe, expect, it } from "vitest";

import { EvidenceLedger } from "../src/evidence/ledger.js";
import { validateAdjudications } from "../src/evidence/validator.js";
import type { ClaimAdjudication, PlannedClaim } from "../src/evidence/schemas.js";

/**
 * The step where the host stops believing the model.
 *
 * A verifier that invents its own citations is worse than none, because its
 * output looks rigorous. These tests are the guard against that.
 */
describe("receipt validator", () => {
  const now = "2026-09-07T12:00:00.000Z";

  function ledgerWith(...ids: string[]): EvidenceLedger {
    const ledger = new EvidenceLedger();
    for (const _ of ids) {
      ledger.addEvidence(
        {
          url: "https://example.org/page",
          resolvedUrl: "https://example.org/page",
          extractedText: "text",
          sourceToolCallId: "call-1",
          origin: "independent",
          instructionLikeContent: false,
        },
        now,
      );
    }
    return ledger;
  }

  const plan: readonly PlannedClaim[] = [
    {
      claimId: "k1",
      text: "Widget X costs $79.",
      importance: "critical",
      freshness: "current",
      fromFocusClaims: false,
    },
  ];

  function adjudication(overrides: Partial<ClaimAdjudication> = {}): ClaimAdjudication {
    return {
      claimId: "k1",
      status: "supported",
      confidence: 0.9,
      rationale: "The page lists $79.",
      evidence: [{ evidenceId: "e1", relation: "supports", note: "lists $79" }],
      ...overrides,
    };
  }

  it("keeps a claim supported when its citation was really retrieved", () => {
    const { claims, report } = validateAdjudications(plan, [adjudication()], ledgerWith("e1"));

    expect(claims[0]?.status).toBe("supported");
    expect(claims[0]?.evidence).toHaveLength(1);
    expect(claims[0]?.adjusted).toBeUndefined();
    expect(report.fabricatedEvidenceIds).toEqual([]);
  });

  it("discards a citation to evidence that was never retrieved", () => {
    const { claims, report } = validateAdjudications(
      plan,
      [
        adjudication({
          evidence: [
            { evidenceId: "e1", relation: "supports", note: "real" },
            { evidenceId: "e99", relation: "supports", note: "invented" },
          ],
        }),
      ],
      ledgerWith("e1"),
    );

    expect(claims[0]?.evidence.map((entry) => entry.evidenceId)).toEqual(["e1"]);
    expect(report.fabricatedEvidenceIds).toEqual(["e99"]);
    // One real citation survived, so the status stands.
    expect(claims[0]?.status).toBe("supported");
  });

  it("downgrades a supported claim whose every citation was invented", () => {
    const { claims, report } = validateAdjudications(
      plan,
      [adjudication({ evidence: [{ evidenceId: "e99", relation: "supports", note: "invented" }] })],
      ledgerWith("e1"),
    );

    expect(claims[0]?.status).toBe("unverified");
    expect(claims[0]?.evidence).toEqual([]);
    expect(claims[0]?.confidence).toBeLessThanOrEqual(0.3);
    expect(claims[0]?.adjusted).toMatch(/no retrieved source/i);
    expect(report.downgradedClaimIds).toEqual(["k1"]);
  });

  it("downgrades a supported claim that cites no evidence at all", () => {
    const { claims } = validateAdjudications(
      plan,
      [adjudication({ evidence: [] })],
      ledgerWith("e1"),
    );

    expect(claims[0]?.status).toBe("unverified");
  });

  it("downgrades an unsupported contradiction to unverified, never the reverse", () => {
    const { claims } = validateAdjudications(
      plan,
      [
        adjudication({
          status: "contradicted",
          evidence: [{ evidenceId: "e99", relation: "contradicts", note: "invented" }],
        }),
      ],
      ledgerWith("e1"),
    );

    // Missing evidence must never become a finding against the candidate.
    expect(claims[0]?.status).toBe("unverified");
  });

  it("downgrades when the citation is real but points the wrong way", () => {
    // Real evidence, cited as supporting — but the claim was called contradicted.
    const { claims } = validateAdjudications(
      plan,
      [
        adjudication({
          status: "contradicted",
          evidence: [{ evidenceId: "e1", relation: "supports", note: "actually agrees" }],
        }),
      ],
      ledgerWith("e1"),
    );

    expect(claims[0]?.status).toBe("unverified");
    expect(claims[0]?.adjusted).toMatch(/contradicts the claim/i);
  });

  it("leaves unverified and not_falsifiable judgments alone", () => {
    const twoClaims: readonly PlannedClaim[] = [
      plan[0]!,
      { ...plan[0]!, claimId: "k2", text: "Widget X is the best." },
    ];

    const { claims, report } = validateAdjudications(
      twoClaims,
      [
        adjudication({ status: "unverified", evidence: [] }),
        adjudication({ claimId: "k2", status: "not_falsifiable", evidence: [] }),
      ],
      ledgerWith("e1"),
    );

    expect(claims.map((claim) => claim.status)).toEqual(["unverified", "not_falsifiable"]);
    expect(report.downgradedClaimIds).toEqual([]);
  });

  it("reports a planned claim the model never adjudicated as unverified", () => {
    const { claims, report } = validateAdjudications(plan, [], ledgerWith("e1"));

    expect(claims).toHaveLength(1);
    expect(claims[0]?.status).toBe("unverified");
    expect(claims[0]?.adjusted).toMatch(/no adjudication was returned/i);
    expect(report.unadjudicatedClaimIds).toEqual(["k1"]);
  });

  it("discards a judgment about a claim nobody planned", () => {
    const { claims, report } = validateAdjudications(
      plan,
      [adjudication(), adjudication({ claimId: "k-invented" })],
      ledgerWith("e1"),
    );

    // The receipt covers the plan, not whatever the model decided to answer.
    expect(claims).toHaveLength(1);
    expect(claims[0]?.claimId).toBe("k1");
    expect(report.unknownClaimIds).toEqual(["k-invented"]);
  });

  it("iterates the plan, so coverage gaps stay visible", () => {
    const threeClaims: readonly PlannedClaim[] = [
      plan[0]!,
      { ...plan[0]!, claimId: "k2", text: "Ships same day." },
      { ...plan[0]!, claimId: "k3", text: "Made in Portugal." },
    ];

    const { claims } = validateAdjudications(threeClaims, [adjudication()], ledgerWith("e1"));

    expect(claims).toHaveLength(3);
    expect(claims.map((claim) => claim.status)).toEqual([
      "supported",
      "unverified",
      "unverified",
    ]);
  });

  it("marks validation as completed so the receipt can say so honestly", () => {
    const { report } = validateAdjudications(plan, [adjudication()], ledgerWith("e1"));
    expect(report.completed).toBe(true);
  });

  /**
   * Independence, enforced rather than requested.
   *
   * The product is independent verification, so a claim cannot come back
   * `supported` because the candidate's own source agrees with the candidate.
   * The rule is deliberately asymmetric: that same source *refuting* the claim
   * is exactly the citation-mismatch finding the product exists to surface.
   */
  describe("independent support", () => {
    function mixedLedger(): EvidenceLedger {
      const ledger = new EvidenceLedger();
      ledger.registerCandidateCitations(["https://candidate.example/its-source"]);
      // e1: the candidate's own source.
      ledger.addEvidence(
        {
          url: "https://candidate.example/its-source",
          resolvedUrl: "https://candidate.example/its-source",
          extractedText: "The candidate's own page.",
          sourceToolCallId: "call-1",
          origin: "independent", // the ledger overrides this; the URL was supplied
          instructionLikeContent: false,
        },
        now,
      );
      // e2: something this execution found for itself.
      ledger.addEvidence(
        {
          url: "https://independent.example/page",
          resolvedUrl: "https://independent.example/page",
          extractedText: "An independently discovered page.",
          sourceToolCallId: "call-2",
          origin: "independent",
          instructionLikeContent: false,
        },
        now,
      );
      return ledger;
    }

    it("classifies a supplied URL as a candidate citation whatever the caller said", () => {
      const ledger = mixedLedger();
      expect(ledger.getEvidence("e1")?.origin).toBe("candidate_citation");
      expect(ledger.getEvidence("e2")?.origin).toBe("independent");
    });

    it("downgrades a claim supported only by the candidate's own source", () => {
      const { claims, report } = validateAdjudications(
        plan,
        [adjudication({ evidence: [{ evidenceId: "e1", relation: "supports", note: "its own" }] })],
        mixedLedger(),
      );

      expect(claims[0]?.status).toBe("unverified");
      expect(claims[0]?.adjusted).toMatch(/no independent supporting source/i);
      expect(report.candidateOnlySupportClaimIds).toEqual(["k1"]);
      // The source stays in the receipt: it was really retrieved, and the
      // reader should be able to see what the candidate was relying on.
      expect(claims[0]?.evidence).toHaveLength(1);
    });

    it("keeps a claim supported when an independent source backs it too", () => {
      const { claims, report } = validateAdjudications(
        plan,
        [
          adjudication({
            evidence: [
              { evidenceId: "e1", relation: "supports", note: "candidate's own" },
              { evidenceId: "e2", relation: "supports", note: "found independently" },
            ],
          }),
        ],
        mixedLedger(),
      );

      expect(claims[0]?.status).toBe("supported");
      expect(claims[0]?.adjusted).toBeUndefined();
      expect(report.candidateOnlySupportClaimIds).toEqual([]);
    });

    it("lets the candidate's own source contradict the candidate's claim", () => {
      const { claims } = validateAdjudications(
        plan,
        [
          adjudication({
            status: "contradicted",
            evidence: [
              { evidenceId: "e1", relation: "contradicts", note: "its own source says otherwise" },
            ],
          }),
        ],
        mixedLedger(),
      );

      // A citation that does not say what it was cited for is the finding, not
      // a technicality to discard.
      expect(claims[0]?.status).toBe("contradicted");
      expect(claims[0]?.adjusted).toBeUndefined();
    });

    it("rejects a fabricated id even when the real citations are candidate-supplied", () => {
      const { claims, report } = validateAdjudications(
        plan,
        [
          adjudication({
            evidence: [
              { evidenceId: "e1", relation: "supports", note: "candidate's own" },
              { evidenceId: "e99", relation: "supports", note: "invented" },
            ],
          }),
        ],
        mixedLedger(),
      );

      expect(report.fabricatedEvidenceIds).toEqual(["e99"]);
      // What is left is candidate-only, so the claim still cannot stand.
      expect(claims[0]?.status).toBe("unverified");
      expect(claims[0]?.evidence.map((entry) => entry.evidenceId)).toEqual(["e1"]);
    });

    it("does not invent a relation to an independent source the model never cited", () => {
      const { claims } = validateAdjudications(
        plan,
        [adjudication({ evidence: [{ evidenceId: "e1", relation: "supports", note: "its own" }] })],
        mixedLedger(),
      );

      // e2 was retrieved and is independent, but the model did not connect it
      // to this claim. Reading it as support would be the host inventing an
      // evidence relation, which is the thing this layer exists to prevent.
      expect(claims[0]?.status).toBe("unverified");
      expect(claims[0]?.evidence.map((entry) => entry.evidenceId)).not.toContain("e2");
    });
  });
});
