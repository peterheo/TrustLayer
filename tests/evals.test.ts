import { describe, expect, it } from "vitest";

import { EVAL_CASES, caseById, type EvalCase } from "../evals/cases/index.js";
import { buildBaselinePrompt } from "../evals/baseline-second-check.js";
import { MeteredVerifierModel } from "../evals/metering.js";
import {
  costRatesFromEnv,
  countInvalidCitations,
  estimateCostUsd,
  scoreCase,
  summarise,
} from "../evals/metrics.js";
import { runTrustLayer } from "../evals/trustlayer.js";
import { buildWorld } from "../evals/world.js";
import { ScriptedVerifierModel, type ModelStep } from "../src/verifier/model.js";
import {
  SUBMIT_ADJUDICATION,
  SUBMIT_CHALLENGE_COMPLETE,
  SUBMIT_RESEARCH_COMPLETE,
} from "../src/verifier/prompts.js";

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
  const USAGE = { calls: 3, inputTokens: 1_000, outputTokens: 200 };

  function score(actual: "supported" | "contradicted" | "unverified" | "not_falsifiable") {
    return scoreCase({
      testCase,
      actual,
      citedUrls: [],
      world,
      latencyMs: 100,
      toolCalls: 2,
      sourcesFetched: 1,
      usage: USAGE,
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
      usage: USAGE,
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
        usage: USAGE,
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
        usage: USAGE,
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

  /**
   * The two failure modes a plain second opinion is structurally worst at get
   * their own rates, because burying them in overall accuracy would hide the
   * only differences the product thesis actually rests on.
   */
  describe("detection rates by failure mode", () => {
    function scoreAll(actual: "supported" | "unverified"): ReturnType<typeof summarise> {
      return summarise(
        actual,
        EVAL_CASES.map((entry) =>
          scoreCase({
            testCase: entry,
            actual,
            citedUrls: [],
            world: buildWorld(entry),
            latencyMs: 1,
            toolCalls: 0,
            sourcesFetched: 0,
            usage: USAGE,
          }),
        ),
      );
    }

    it("counts every stale and citation-mismatch case in the denominators", () => {
      const metrics = scoreAll("unverified");
      expect(metrics.staleTotal).toBe(2);
      expect(metrics.citationMismatchTotal).toBe(3);
    });

    it("scores endorsing a stale fact or a bad citation as a miss", () => {
      const metrics = scoreAll("supported");
      expect(metrics.staleDetected).toBe(0);
      expect(metrics.staleDetectionRate).toBe(0);
      expect(metrics.citationMismatchDetected).toBe(0);
      expect(metrics.citationMismatchDetectionRate).toBe(0);
    });

    it("scores declining to endorse either as a catch", () => {
      const metrics = scoreAll("unverified");
      expect(metrics.staleDetectionRate).toBe(1);
      expect(metrics.citationMismatchDetectionRate).toBe(1);
    });
  });

  describe("cost accounting", () => {
    const outcome = () =>
      scoreCase({
        testCase,
        actual: "supported",
        citedUrls: [],
        world,
        latencyMs: 5,
        toolCalls: 3,
        sourcesFetched: 1,
        usage: { calls: 6, inputTokens: 10_000, outputTokens: 2_000 },
      });

    it("totals model rounds and tokens across cases", () => {
      const metrics = summarise("system", [outcome(), outcome()]);
      expect(metrics.totalModelCalls).toBe(12);
      expect(metrics.totalInputTokens).toBe(20_000);
      expect(metrics.totalOutputTokens).toBe(4_000);
    });

    it("reports no cost at all when nobody supplied a price", () => {
      expect(summarise("system", [outcome()]).estimatedCostUsd).toBeNull();
      expect(estimateCostUsd({ calls: 1, inputTokens: 1_000, outputTokens: 1_000 }, undefined))
        .toBeNull();
    });

    it("prices a run from supplied rates rather than a built-in guess", () => {
      const rates = { inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 };
      // 10k in at $3/Mtok + 2k out at $15/Mtok = 0.03 + 0.03
      expect(summarise("system", [outcome()], rates).estimatedCostUsd).toBeCloseTo(0.06, 4);
    });

    it("ignores a half-configured or nonsensical rate pair", () => {
      expect(costRatesFromEnv({ MODEL_INPUT_USD_PER_MTOK: "3" })).toBeUndefined();
      expect(
        costRatesFromEnv({ MODEL_INPUT_USD_PER_MTOK: "3", MODEL_OUTPUT_USD_PER_MTOK: "cheap" }),
      ).toBeUndefined();
      expect(
        costRatesFromEnv({ MODEL_INPUT_USD_PER_MTOK: "3", MODEL_OUTPUT_USD_PER_MTOK: "15" }),
      ).toEqual({ inputUsdPerMillionTokens: 3, outputUsdPerMillionTokens: 15 });
    });
  });
});

/**
 * What a run costs has to be measured, not assumed — the benchmark's claim is
 * verification value per unit cost, and a cost figure that flatters TrustLayer
 * would make the whole comparison worthless.
 */
describe("eval cost measurement", () => {
  const testCase = caseById("correct-price")! as EvalCase;

  function script(testCase: EvalCase): ModelStep[] {
    const url = testCase.pages[0]!.url;
    return [
      { kind: "tool_call", callId: "s1", toolName: "research.search", arguments: { query: "price" } },
      { kind: "tool_call", callId: "f1", toolName: "research.fetch", arguments: { url } },
      { kind: "submit", submission: SUBMIT_RESEARCH_COMPLETE, payload: {} },
      { kind: "tool_call", callId: "s2", toolName: "research.search", arguments: { query: "price wrong" } },
      { kind: "submit", submission: SUBMIT_CHALLENGE_COMPLETE, payload: {} },
      {
        kind: "submit",
        submission: SUBMIT_ADJUDICATION,
        payload: {
          summary: "Checked.",
          adjudications: [
            {
              claimId: "k1",
              status: "supported",
              confidence: 0.9,
              rationale: "The store page lists the price.",
              evidence: [{ evidenceId: "e1", relation: "supports", note: "listed" }],
            },
          ],
          suspiciousInstructions: { detected: false, indicators: [] },
        },
      },
    ];
  }

  it("counts tool calls, not distinct tool names", async () => {
    const world = buildWorld(testCase);
    const model = new ScriptedVerifierModel(script(testCase));

    const result = await runTrustLayer(testCase, world, model, AbortSignal.timeout(20_000));

    // Three calls across two tools. Reading the count off `toolsUsed` would
    // have said 2 and understated the spend by a third.
    expect(result.toolCalls).toBe(3);
    expect(result.receipt?.provenance.toolsUsed).toHaveLength(2);
  });

  it("counts every model round the protocol actually took", async () => {
    const world = buildWorld(testCase);
    const model = new MeteredVerifierModel(new ScriptedVerifierModel(script(testCase)));

    const result = await runTrustLayer(testCase, world, model, AbortSignal.timeout(20_000));

    // One round per step in the script: the protocol is not one model call.
    expect(result.usage.calls).toBe(script(testCase).length);
    expect(result.usage.calls).toBeGreaterThan(result.toolCalls);
  });

  it("reports zero tokens rather than inventing them for a provider that reports none", async () => {
    const world = buildWorld(testCase);
    const model = new MeteredVerifierModel(new ScriptedVerifierModel(script(testCase)));

    const result = await runTrustLayer(testCase, world, model, AbortSignal.timeout(20_000));

    expect(result.usage.inputTokens).toBe(0);
    expect(result.usage.outputTokens).toBe(0);
  });
});
