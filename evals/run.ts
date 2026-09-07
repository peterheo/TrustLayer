/**
 * The benchmark runner.
 *
 *   pnpm eval             run every case against TrustLayer and both baselines
 *   pnpm eval --selftest  exercise the harness with stub models (NOT a benchmark)
 *   pnpm eval --case <id> run one case
 *
 * A real comparison needs a real model on both sides. Without `MODEL_API_KEY`
 * this refuses to run rather than printing numbers that would look like
 * results — a fabricated benchmark is worse than no benchmark, and the
 * personal-agent brief is required to state that none has been run.
 */
import { config } from "../src/config.js";
import { AnthropicVerifierModel, ScriptedVerifierModel } from "../src/verifier/model.js";
import {
  SUBMIT_ADJUDICATION,
  SUBMIT_CHALLENGE_COMPLETE,
  SUBMIT_RESEARCH_COMPLETE,
} from "../src/verifier/prompts.js";
import { EVAL_CASES, caseById, type EvalCase } from "./cases/index.js";
import {
  AnthropicBaselineModel,
  StubBaselineModel,
  runBaseline,
  type BaselineMode,
  type BaselineModel,
} from "./baseline-second-check.js";
import { formatMetrics, scoreCase, summarise, type CaseOutcome } from "./metrics.js";
import { runTrustLayer } from "./trustlayer.js";
import { buildWorld } from "./world.js";
import type { VerifierModel } from "../src/verifier/model.js";

const args = process.argv.slice(2);
const selftest = args.includes("--selftest");
const caseArg = args.indexOf("--case");
const selected: readonly EvalCase[] =
  caseArg >= 0 && args[caseArg + 1] !== undefined
    ? [caseById(args[caseArg + 1]!)].filter((entry): entry is EvalCase => entry !== undefined)
    : EVAL_CASES;

if (selected.length === 0) {
  console.error("No matching cases.");
  process.exit(1);
}

/**
 * A scripted verifier that walks the real protocol against the case's world.
 *
 * Used only by `--selftest`. It fetches the first page the world serves and
 * adjudicates from it, which exercises every host-side mechanism — ledger,
 * validator, protocol accounting, receipt — without a model provider.
 */
function selftestVerifier(testCase: EvalCase): VerifierModel {
  // Prefer the candidate's own cited URL. In the fabricated- and dead-citation
  // cases that URL 404s, so no evidence is minted and the validator has to
  // downgrade the `supported` claim below — which is the mechanism selftest
  // most needs to exercise.
  const cited = testCase.sourceUrls?.[0];
  const firstServed = testCase.pages.find((page) => page.body !== undefined);
  const url = cited ?? firstServed?.url ?? testCase.pages[0]?.url ?? "https://example.org/none";

  return new ScriptedVerifierModel([
    { kind: "tool_call", callId: "s1", toolName: "research.search", arguments: { query: testCase.focusClaim } },
    { kind: "tool_call", callId: "f1", toolName: "research.fetch", arguments: { url } },
    { kind: "submit", submission: SUBMIT_RESEARCH_COMPLETE, payload: {} },
    { kind: "tool_call", callId: "s2", toolName: "research.search", arguments: { query: `${testCase.focusClaim} incorrect` } },
    { kind: "submit", submission: SUBMIT_CHALLENGE_COMPLETE, payload: {} },
    {
      kind: "submit",
      submission: SUBMIT_ADJUDICATION,
      payload: {
        summary: "Selftest adjudication.",
        // Always claims support, citing e1. Where nothing was retrieved the
        // validator downgrades it — which is exactly what selftest checks.
        adjudications: [
          {
            claimId: "k1",
            status: "supported",
            confidence: 0.8,
            rationale: "Selftest.",
            evidence: [{ evidenceId: "e1", relation: "supports", note: "selftest" }],
          },
        ],
        suspiciousInstructions: { detected: false, indicators: [] },
      },
    },
  ]);
}

function requireModels(): { verifier: VerifierModel; baseline: BaselineModel } {
  if (config.model.provider !== "anthropic" || config.model.apiKey === undefined) {
    console.error(
      [
        "",
        "This benchmark needs a real model on both sides to mean anything.",
        "",
        "  MODEL_PROVIDER=anthropic MODEL_NAME=<model> MODEL_API_KEY=<key> pnpm eval",
        "",
        "To check the harness itself without a model provider, run:",
        "",
        "  pnpm eval --selftest",
        "",
        "which exercises the plumbing and metrics with stub models. Its output is",
        "NOT a benchmark result and must never be quoted as one.",
        "",
      ].join("\n"),
    );
    process.exit(2);
  }
  return {
    verifier: new AnthropicVerifierModel(config.model.apiKey, config.model.name),
    baseline: new AnthropicBaselineModel(config.model.apiKey, config.model.name),
  };
}

async function main(): Promise<void> {
  const signal = AbortSignal.timeout(30 * 60_000);

  const trustlayerOutcomes: CaseOutcome[] = [];
  const baselineOutcomes = new Map<BaselineMode, CaseOutcome[]>([
    ["plain", []],
    ["with_search", []],
  ]);

  const models = selftest ? undefined : requireModels();
  const stubBaseline = new StubBaselineModel(new Map());

  for (const testCase of selected) {
    const world = buildWorld(testCase);

    const verifierModel = selftest ? selftestVerifier(testCase) : models!.verifier;
    const result = await runTrustLayer(testCase, world, verifierModel, signal);

    trustlayerOutcomes.push(
      scoreCase({
        testCase,
        actual: result.status,
        // TrustLayer's citations are the evidence it actually retrieved, so
        // by construction they exist. The metric proves that rather than
        // assuming it.
        citedUrls: (result.receipt?.evidence ?? []).map((entry) => entry.url),
        world,
        latencyMs: result.latencyMs,
        toolCalls: result.toolCalls,
        sourcesFetched: result.sourcesFetched,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
      }),
    );

    for (const mode of ["plain", "with_search"] as const) {
      const baselineModel = selftest ? stubBaseline : models!.baseline;
      const baseline = await runBaseline(testCase, mode, world, baselineModel, signal);
      baselineOutcomes.get(mode)!.push(
        scoreCase({
          testCase,
          actual: baseline.verdict.status,
          citedUrls: baseline.verdict.citedUrls,
          world,
          latencyMs: baseline.latencyMs,
          toolCalls: mode === "with_search" ? 1 : 0,
          sourcesFetched: 0,
        }),
      );
    }

    process.stdout.write(
      `${testCase.id.padEnd(28)} expected=${testCase.expected.padEnd(16)} trustlayer=${result.status}\n`,
    );
  }

  const metrics = [
    summarise("trustlayer", trustlayerOutcomes),
    summarise("baseline(plain)", baselineOutcomes.get("plain")!),
    summarise("baseline(+search)", baselineOutcomes.get("with_search")!),
  ];

  console.log(`\n${formatMetrics(metrics)}\n`);

  if (selftest) {
    console.log(
      [
        "SELFTEST ONLY — these numbers are not a benchmark result.",
        "Both systems ran on stub models. The run proves the harness, the world",
        "fixtures, the scoring and the receipt plumbing work end to end; it says",
        "nothing whatsoever about how TrustLayer compares to a real second check.",
        "",
        "Run with MODEL_API_KEY set to produce a real comparison.",
      ].join("\n"),
    );
  } else {
    console.log(
      [
        `Model: ${config.model.name}. Cases: ${selected.length}.`,
        "Report these numbers as they are. If TrustLayer does not beat the baseline,",
        "that is a finding about the product, not a reason to re-run until it does.",
      ].join("\n"),
    );
  }
}

await main();
