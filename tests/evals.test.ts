import { describe, expect, it } from "vitest";

import { EVAL_CASES, caseById } from "../evals/cases/index.js";
import { buildBaselinePrompt } from "../evals/baseline-second-check.js";
import { countInvalidCitations, scoreCase, summarise } from "../evals/metrics.js";
import { buildWorld } from "../evals/world.js";

/**
 * The benchmark harness itself.
 *
 * The comparison it produces is only meaningful if the world is genuinely
 * shared, the ground truth is genuinely known, and the scoring does not reward
 * the degenerate strategies.
 */
describe("eval corpus", () => {
  it("covers the case classes the amendment asks for", () => {
    const classes = new Set(EVAL_CASES.map((entry) => entry.caseClass));

    for (const required of [
      "correct",
      "subtle_numeric_error",
      "stale_price",
      "stale_schedule",
      "wrong_date",
      "fabricated_citation",
      "citation_does_not_support",
      "partial_truth",
      "conflicting_sources",
      "unsupported_claim",
      "candidate_injection",
      "page_injection",
      "dead_citation",
      "ambiguous",
      "non_falsifiable",
    ]) {
      expect(classes).toContain(required);
    }
  });

  it("has unique ids and a stated ground truth for every case", () => {
    const ids = EVAL_CASES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    for (const entry of EVAL_CASES) {
      expect(entry.focusClaim.length).toBeGreaterThan(0);
      expect(entry.note.length).toBeGreaterThan(0);
      expect(["supported", "contradicted", "unverified", "not_falsifiable"]).toContain(
        entry.expected,
      );
    }
  });

  it("includes correct cases, so answering `contradicted` to everything scores badly", () => {
    const correct = EVAL_CASES.filter((entry) => entry.expected === "supported");
    expect(correct.length).toBeGreaterThanOrEqual(2);
  });

  it("never marks a genuinely correct claim as a material error", () => {
    for (const entry of EVAL_CASES) {
      if (entry.expected === "supported") {
        expect(entry.materialErrorIfSupported).toBe(false);
      }
    }
  });
});

describe("eval world", () => {
  it("serves the pages a case declares and 404s everything else", async () => {
    const testCase = caseById("correct-price")!;
    const world = buildWorld(testCase);

    const served = await world.fetch("https://acme.example/store/widget-pro");
    expect(served.status).toBe(200);
    expect(await served.text()).toContain("$79.00");

    const missing = await world.fetch("https://acme.example/nonexistent");
    expect(missing.status).toBe(404);
  });

  it("makes a fabricated citation genuinely dead", async () => {
    const testCase = caseById("fabricated-citation")!;
    const world = buildWorld(testCase);

    const cited = testCase.sourceUrls![0]!;
    const response = await world.fetch(cited);
    expect(response.status).toBe(404);
  });

  it("serves a page that loads but does not support the claim", async () => {
    const testCase = caseById("citation-does-not-support")!;
    const world = buildWorld(testCase);

    const response = await world.fetch(testCase.sourceUrls![0]!);
    expect(response.status).toBe(200);
    const body = await response.text();
    // Real page, real content — just not what the candidate said it says.
    expect(body).toContain("splash resistant");
    expect(body).not.toContain("50m");
  });

  it("gives both systems the same discovery snippets", () => {
    const testCase = caseById("stale-price")!;
    const world = buildWorld(testCase);

    const prompt = buildBaselinePrompt(testCase, "with_search", world);
    expect(prompt).toContain("$89.00");
    expect(world.snippets).toHaveLength(testCase.pages.length);
  });
});

describe("eval metrics", () => {
  const testCase = caseById("subtle-numeric-error")!;
  const world = buildWorld(testCase);

  function score(actual: "supported" | "contradicted" | "unverified" | "not_falsifiable") {
    return scoreCase({
      testCase,
      actual,
      citedUrls: [],
      world,
      latencyMs: 100,
      toolCalls: 2,
      sourcesFetched: 1,
    });
  }

  it("counts endorsing a wrong claim as a missed material error", () => {
    const outcome = score("supported");
    expect(outcome.missedMaterialError).toBe(true);
    expect(outcome.caughtMaterialError).toBe(false);
  });

  it("counts declining to endorse a wrong claim as a catch", () => {
    // `unverified` is a catch too: the caller is not misled into acting.
    expect(score("contradicted").caughtMaterialError).toBe(true);
    expect(score("unverified").caughtMaterialError).toBe(true);
  });

  it("counts wrongly contradicting a correct claim as a false contradiction", () => {
    const correctCase = caseById("correct-price")!;
    const outcome = scoreCase({
      testCase: correctCase,
      actual: "contradicted",
      citedUrls: [],
      world: buildWorld(correctCase),
      latencyMs: 10,
      toolCalls: 1,
      sourcesFetched: 1,
    });

    expect(outcome.falseContradiction).toBe(true);
  });

  it("does not reward answering unverified to everything", () => {
    const alwaysUnverified = EVAL_CASES.map((entry) =>
      scoreCase({
        testCase: entry,
        actual: "unverified",
        citedUrls: [],
        world: buildWorld(entry),
        latencyMs: 1,
        toolCalls: 0,
        sourcesFetched: 0,
      }),
    );
    const metrics = summarise("always-unverified", alwaysUnverified);

    // It catches every material error by never endorsing anything...
    expect(metrics.materialErrorDetectionRate).toBe(1);
    // ...and is still obviously useless, which accuracy shows.
    expect(metrics.accuracy).toBeLessThan(0.5);
  });

  it("does not reward answering contradicted to everything", () => {
    const alwaysContradicted = EVAL_CASES.map((entry) =>
      scoreCase({
        testCase: entry,
        actual: "contradicted",
        citedUrls: [],
        world: buildWorld(entry),
        latencyMs: 1,
        toolCalls: 0,
        sourcesFetched: 0,
      }),
    );
    const metrics = summarise("always-contradicted", alwaysContradicted);

    expect(metrics.falseContradictions).toBeGreaterThan(0);
    expect(metrics.accuracy).toBeLessThan(0.5);
  });

  it("counts a citation the world does not serve as invalid", () => {
    expect(
      countInvalidCitations(["https://acme.example/store/widget-pro"], world),
    ).toBe(0);
    expect(countInvalidCitations(["https://invented.example/page"], world)).toBe(1);
  });
});
