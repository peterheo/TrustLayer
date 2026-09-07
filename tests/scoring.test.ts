import { describe, expect, it } from "vitest";

import type { ClaimJudgment } from "../src/verification/schemas.js";
import { computeTrustScore, deriveVerdict, scoreJudgment } from "../src/verification/scoring.js";

function claim(
  status: ClaimJudgment["status"],
  importance: 1 | 2 | 3,
  text = "a claim",
): ClaimJudgment {
  return {
    claim: text,
    importance,
    status,
    confidence: 0.8,
    rationale: "because",
    evidence: [],
  };
}

/**
 * The score is the product's most load-bearing number, so it is pinned to
 * exact values rather than ranges. If a rule changes, these fail loudly.
 */
describe("trust score", () => {
  it("is 100 when every claim is supported", () => {
    expect(computeTrustScore([claim("supported", 3), claim("supported", 1)])).toBe(100);
  });

  it("is 0 when every claim is contradicted", () => {
    expect(computeTrustScore([claim("contradicted", 3), claim("contradicted", 2)])).toBe(0);
  });

  it("weights claims by importance rather than counting them", () => {
    // (3*1 + 1*0) / 4 = 0.75
    expect(computeTrustScore([claim("supported", 3), claim("contradicted", 1)])).toBe(75);
    // (1*1 + 3*0) / 4 = 0.25 — the same two statuses, importance reversed.
    expect(computeTrustScore([claim("supported", 1), claim("contradicted", 3)])).toBe(25);
  });

  it("scores unverified claims at 0.4 rather than 0", () => {
    // Lack of evidence is not disproof, and the score says so.
    expect(computeTrustScore([claim("unverified", 1)])).toBe(40);
    // (2*1 + 2*0.4) / 4 = 0.7
    expect(computeTrustScore([claim("supported", 2), claim("unverified", 2)])).toBe(70);
  });

  it("excludes not_falsifiable claims from the calculation", () => {
    expect(computeTrustScore([claim("supported", 3), claim("not_falsifiable", 3)])).toBe(100);
    expect(computeTrustScore([claim("contradicted", 1), claim("not_falsifiable", 3)])).toBe(0);
  });

  it("is null when nothing falsifiable was checked", () => {
    expect(computeTrustScore([])).toBeNull();
    expect(computeTrustScore([claim("not_falsifiable", 3)])).toBeNull();
  });
});

describe("verdict", () => {
  it("is supported when every claim is supported", () => {
    const claims = [claim("supported", 3), claim("supported", 2)];
    expect(deriveVerdict(claims, computeTrustScore(claims))).toBe("supported");
  });

  it("is contradicted when a decision-critical claim is contradicted", () => {
    // Even alongside plenty of supported minor claims.
    const claims = [
      claim("contradicted", 3),
      claim("supported", 1),
      claim("supported", 1),
      claim("supported", 1),
    ];
    expect(deriveVerdict(claims, computeTrustScore(claims))).toBe("contradicted");
  });

  it("is contradicted when contradictions dominate the weighted result", () => {
    const claims = [claim("contradicted", 2), claim("contradicted", 2), claim("supported", 1)];
    expect(deriveVerdict(claims, computeTrustScore(claims))).toBe("contradicted");
  });

  it("is mixed when real support coexists with a material problem", () => {
    const claims = [claim("supported", 3), claim("contradicted", 1)];
    expect(deriveVerdict(claims, computeTrustScore(claims))).toBe("mixed");
  });

  it("is mixed when a material claim could not be established", () => {
    const claims = [claim("supported", 3), claim("unverified", 2)];
    expect(deriveVerdict(claims, computeTrustScore(claims))).toBe("mixed");
  });

  it("is unverified when nothing was established or refuted", () => {
    const claims = [claim("unverified", 3), claim("unverified", 2)];
    expect(deriveVerdict(claims, computeTrustScore(claims))).toBe("unverified");
  });

  it("is unverified when there are no falsifiable claims", () => {
    const claims = [claim("not_falsifiable", 3)];
    const score = computeTrustScore(claims);
    expect(score).toBeNull();
    expect(deriveVerdict(claims, score)).toBe("unverified");
  });

  it("never reports supported while a decision-critical claim is unverified", () => {
    const claims = [claim("unverified", 3), claim("supported", 1)];
    expect(deriveVerdict(claims, computeTrustScore(claims))).not.toBe("supported");
  });

  it("is deterministic for the same claim table", () => {
    const claims = [claim("supported", 3), claim("unverified", 2), claim("contradicted", 1)];
    const first = scoreJudgment(claims);
    const second = scoreJudgment(claims);
    expect(first).toEqual(second);
  });

  it("reports how many claims drove the score", () => {
    const result = scoreJudgment([
      claim("supported", 3),
      claim("not_falsifiable", 2),
      claim("unverified", 1),
    ]);
    expect(result.falsifiableCount).toBe(2);
  });
});
