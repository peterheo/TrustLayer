import { describe, expect, it } from "vitest";

import {
  VerifierJudgmentSchema,
  VerifyRequestSchema,
} from "../src/verification/schemas.js";
import { judgment } from "./fixtures.js";

describe("VerifyRequestSchema", () => {
  const valid = { task: "How much is Widget X?", candidateOutput: "It costs $79." };

  it("accepts a minimal valid request and applies defaults", () => {
    const parsed = VerifyRequestSchema.parse(valid);
    expect(parsed.freshness).toBe("auto");
    expect(parsed.maxClaims).toBe(5);
    expect(parsed.sourceUrls).toBeUndefined();
  });

  it("rejects a missing task", () => {
    expect(VerifyRequestSchema.safeParse({ candidateOutput: "x" }).success).toBe(false);
    expect(VerifyRequestSchema.safeParse({ ...valid, task: "" }).success).toBe(false);
  });

  it("rejects a missing candidate output", () => {
    expect(VerifyRequestSchema.safeParse({ task: "x" }).success).toBe(false);
    expect(VerifyRequestSchema.safeParse({ ...valid, candidateOutput: "" }).success).toBe(false);
  });

  it("rejects an oversized candidate output", () => {
    expect(
      VerifyRequestSchema.safeParse({ ...valid, candidateOutput: "x".repeat(40_001) }).success,
    ).toBe(false);
    expect(
      VerifyRequestSchema.safeParse({ ...valid, candidateOutput: "x".repeat(40_000) }).success,
    ).toBe(true);
  });

  it("rejects an oversized task", () => {
    expect(VerifyRequestSchema.safeParse({ ...valid, task: "x".repeat(12_001) }).success).toBe(
      false,
    );
  });

  it("rejects more than ten source URLs", () => {
    const urls = Array.from({ length: 11 }, (_, index) => `https://example.com/${index}`);
    expect(VerifyRequestSchema.safeParse({ ...valid, sourceUrls: urls }).success).toBe(false);
    expect(VerifyRequestSchema.safeParse({ ...valid, sourceUrls: urls.slice(0, 10) }).success).toBe(
      true,
    );
  });

  it("rejects a malformed source URL", () => {
    expect(VerifyRequestSchema.safeParse({ ...valid, sourceUrls: ["not a url"] }).success).toBe(
      false,
    );
  });

  it("rejects an invalid freshness value", () => {
    expect(VerifyRequestSchema.safeParse({ ...valid, freshness: "yesterday" }).success).toBe(false);
  });

  it("rejects maxClaims outside its bounds", () => {
    expect(VerifyRequestSchema.safeParse({ ...valid, maxClaims: 0 }).success).toBe(false);
    expect(VerifyRequestSchema.safeParse({ ...valid, maxClaims: 9 }).success).toBe(false);
    expect(VerifyRequestSchema.safeParse({ ...valid, maxClaims: 2.5 }).success).toBe(false);
    expect(VerifyRequestSchema.safeParse({ ...valid, maxClaims: 8 }).success).toBe(true);
  });

  it("rejects unknown fields rather than ignoring them", () => {
    expect(VerifyRequestSchema.safeParse({ ...valid, grants: ["admin"] }).success).toBe(false);
  });
});

describe("VerifierJudgmentSchema", () => {
  it("accepts a well-formed judgment", () => {
    expect(VerifierJudgmentSchema.safeParse(judgment()).success).toBe(true);
  });

  it("has no field for a trust score, trace id, or tool list", () => {
    // The model cannot fabricate host-derived facts because the contract it
    // answers has nowhere to put them.
    const shape = VerifierJudgmentSchema.shape;
    expect(Object.keys(shape).sort()).toEqual(["claims", "security", "summary"]);
  });

  it("rejects host-derived fields smuggled into the judgment", () => {
    const smuggled = { ...judgment(), trustScore: 100, audit: { executionId: "forged" } };
    expect(VerifierJudgmentSchema.safeParse(smuggled).success).toBe(false);
  });

  it("rejects a claim that says it followed instructions from evidence", () => {
    const claimed = judgment();
    const tampered = {
      ...claimed,
      security: { ...claimed.security, instructionsFollowedFromEvidence: true },
    };
    expect(VerifierJudgmentSchema.safeParse(tampered).success).toBe(false);
  });

  it("rejects an unknown claim status", () => {
    const bad = judgment({
      claims: [
        {
          claim: "x",
          importance: 1,
          status: "definitely-true" as never,
          confidence: 1,
          rationale: "r",
          evidence: [],
        },
      ],
    });
    expect(VerifierJudgmentSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects more than the hard claim limit", () => {
    const many = Array.from({ length: 9 }, () => judgment().claims[0]!);
    expect(VerifierJudgmentSchema.safeParse(judgment({ claims: many })).success).toBe(false);
  });

  it("rejects an importance or confidence outside its range", () => {
    const base = judgment().claims[0]!;
    expect(
      VerifierJudgmentSchema.safeParse(judgment({ claims: [{ ...base, importance: 4 }] })).success,
    ).toBe(false);
    expect(
      VerifierJudgmentSchema.safeParse(judgment({ claims: [{ ...base, confidence: 1.5 }] })).success,
    ).toBe(false);
  });
});
