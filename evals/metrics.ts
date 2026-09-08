import type { ClaimStatus } from "../src/evidence/schemas.js";
import type { ModelUsage } from "../src/verifier/model.js";
import type { CaseClass, EvalCase } from "./cases/index.js";
import type { EvalWorld } from "./world.js";

/**
 * Scoring, defined so the numbers mean something.
 *
 * The headline metric is deliberately not "accuracy". A verifier that answers
 * `unverified` to everything is useless but never wrong, and one that answers
 * `contradicted` to everything catches every error while destroying every
 * correct answer. So the two are tracked separately: did it catch the material
 * errors, and did it manufacture problems that were not there.
 *
 * Two failure modes get their own detection rates because they are the ones a
 * plain second opinion is structurally worst at, and so the ones the product
 * thesis rests on: a fact that has gone stale since the model learned it, and
 * a citation that does not say what it is cited for. Both look fine to a model
 * reasoning from memory and are only caught by retrieval.
 *
 * Cost is measured rather than assumed — tool calls from the kernel's own
 * audit record, model rounds from the model port, tokens from the provider.
 * Money is only reported when someone supplies the rates; this file will not
 * invent a price.
 */

export interface CaseOutcome {
  readonly caseId: string;
  readonly caseClass: string;
  readonly expected: ClaimStatus;
  readonly actual: ClaimStatus;
  readonly correct: boolean;
  /** A material error the system failed to catch — the expensive kind of miss. */
  readonly missedMaterialError: boolean;
  /** The system caught a material error. */
  readonly caughtMaterialError: boolean;
  /** The system called a correct claim contradicted. */
  readonly falseContradiction: boolean;
  /** URLs cited that this world does not actually serve. */
  readonly invalidCitations: number;
  readonly citations: number;
  readonly latencyMs: number;
  readonly toolCalls: number;
  readonly sourcesFetched: number;
  /** Model rounds and tokens this case cost. */
  readonly usage: ModelUsage;
  readonly errorCode?: string;
}

export interface SystemMetrics {
  readonly system: string;
  readonly cases: number;
  readonly correct: number;
  readonly accuracy: number;
  /** Of the cases where a material error existed, how many were caught. */
  readonly materialErrorsPresent: number;
  readonly materialErrorsCaught: number;
  readonly materialErrorDetectionRate: number;
  /** Of the cases where the claim was fine, how many were wrongly contradicted. */
  readonly falseContradictions: number;
  readonly falseContradictionRate: number;
  /** Claims correctly reported as unverified when nothing established them. */
  readonly unsupportedRecognised: number;
  readonly unsupportedTotal: number;
  /** Stale facts the system declined to endorse. */
  readonly staleDetected: number;
  readonly staleTotal: number;
  readonly staleDetectionRate: number;
  /** Fabricated, dead, or non-supporting citations the system declined to endorse. */
  readonly citationMismatchDetected: number;
  readonly citationMismatchTotal: number;
  readonly citationMismatchDetectionRate: number;
  readonly validCitationRate: number | null;
  readonly medianLatencyMs: number;
  readonly totalToolCalls: number;
  readonly totalSourcesFetched: number;
  readonly totalModelCalls: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  /** Null unless token rates were supplied; never guessed. */
  readonly estimatedCostUsd: number | null;
  /**
   * What one caught material error cost.
   *
   * The comparison the product thesis actually rests on: not who is more
   * accurate, but what each system charges for the failures it catches. Null
   * when there is no price or nothing was caught.
   */
  readonly costPerMaterialErrorCaughtUsd: number | null;
  readonly errors: number;
}

/**
 * The case classes whose whole point is that the claim was once true, or that
 * a source exists but does not say what it is cited for.
 */
export const STALE_CLASSES: ReadonlySet<CaseClass> = new Set<CaseClass>([
  "stale_price",
  "stale_schedule",
]);

export const CITATION_MISMATCH_CLASSES: ReadonlySet<CaseClass> = new Set<CaseClass>([
  "fabricated_citation",
  "citation_does_not_support",
  "dead_citation",
]);

/**
 * Token prices, in USD per million tokens.
 *
 * Supplied by whoever runs the benchmark, because a price hard-coded here
 * would go stale silently and turn a measured comparison into a stale one.
 */
export interface CostRates {
  readonly inputUsdPerMillionTokens: number;
  readonly outputUsdPerMillionTokens: number;
}

function positiveNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/** Rates from the environment, or undefined so cost is reported as `n/a`. */
export function costRatesFromEnv(
  env: Record<string, string | undefined> = process.env,
): CostRates | undefined {
  const input = positiveNumber(env["MODEL_INPUT_USD_PER_MTOK"]);
  const output = positiveNumber(env["MODEL_OUTPUT_USD_PER_MTOK"]);
  if (input === undefined || output === undefined) return undefined;
  return { inputUsdPerMillionTokens: input, outputUsdPerMillionTokens: output };
}

export function estimateCostUsd(
  usage: ModelUsage,
  rates: CostRates | undefined,
): number | null {
  if (rates === undefined) return null;
  const cost =
    (usage.inputTokens * rates.inputUsdPerMillionTokens) / 1_000_000 +
    (usage.outputTokens * rates.outputUsdPerMillionTokens) / 1_000_000;
  return Number(cost.toFixed(4));
}

/** A citation is valid only if the world would actually serve that URL. */
export function countInvalidCitations(
  citedUrls: readonly string[],
  world: EvalWorld,
): number {
  const served = new Set(
    world.snippets.map((hit) => hit.url),
  );
  return citedUrls.filter((url) => !served.has(url)).length;
}

export interface ScoreInput {
  readonly testCase: EvalCase;
  readonly actual: ClaimStatus;
  readonly citedUrls: readonly string[];
  readonly world: EvalWorld;
  readonly latencyMs: number;
  readonly toolCalls: number;
  readonly sourcesFetched: number;
  /** Model rounds and tokens this case cost. */
  readonly usage: ModelUsage;
  readonly errorCode?: string;
}

export function scoreCase(input: ScoreInput): CaseOutcome {
  const { testCase, actual } = input;
  const correct = actual === testCase.expected;

  // A material error exists when reporting `supported` would mislead the caller.
  const materialErrorPresent = testCase.materialErrorIfSupported;
  // Catching it means *not* endorsing the claim.
  const caught = materialErrorPresent && actual !== "supported";
  const missed = materialErrorPresent && actual === "supported";

  // A false contradiction is calling a genuinely fine claim wrong.
  const falseContradiction = !materialErrorPresent && actual === "contradicted" && testCase.expected !== "contradicted";

  return {
    caseId: testCase.id,
    caseClass: testCase.caseClass,
    expected: testCase.expected,
    actual,
    correct,
    missedMaterialError: missed,
    caughtMaterialError: caught,
    falseContradiction,
    invalidCitations: countInvalidCitations(input.citedUrls, input.world),
    citations: input.citedUrls.length,
    latencyMs: input.latencyMs,
    toolCalls: input.toolCalls,
    sourcesFetched: input.sourcesFetched,
    usage: input.usage,
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  };
}

/** Cost divided by catches, or null when either is missing. */
function costPerCatch(cost: number | null, caught: number): number | null {
  if (cost === null || caught === 0) return null;
  return Number((cost / caught).toFixed(4));
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? 0);
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(3));
}

/** Detection means declining to endorse the claim, which is what a caller acts on. */
function detectionIn(
  outcomes: readonly CaseOutcome[],
  classes: ReadonlySet<CaseClass>,
): { detected: number; total: number } {
  const relevant = outcomes.filter((outcome) => classes.has(outcome.caseClass as CaseClass));
  return {
    detected: relevant.filter((outcome) => outcome.actual !== "supported").length,
    total: relevant.length,
  };
}

export function summarise(
  system: string,
  outcomes: readonly CaseOutcome[],
  rates?: CostRates,
): SystemMetrics {
  const materialPresent = outcomes.filter(
    (outcome) => outcome.caughtMaterialError || outcome.missedMaterialError,
  );
  const caught = outcomes.filter((outcome) => outcome.caughtMaterialError);
  const noMaterialError = outcomes.filter(
    (outcome) => !outcome.caughtMaterialError && !outcome.missedMaterialError,
  );
  const unsupportedCases = outcomes.filter((outcome) => outcome.expected === "unverified");
  const totalCitations = outcomes.reduce((sum, outcome) => sum + outcome.citations, 0);
  const invalidCitations = outcomes.reduce((sum, outcome) => sum + outcome.invalidCitations, 0);

  const stale = detectionIn(outcomes, STALE_CLASSES);
  const citationMismatch = detectionIn(outcomes, CITATION_MISMATCH_CLASSES);

  const usage: ModelUsage = outcomes.reduce<ModelUsage>(
    (total, outcome) => ({
      calls: total.calls + outcome.usage.calls,
      inputTokens: total.inputTokens + outcome.usage.inputTokens,
      outputTokens: total.outputTokens + outcome.usage.outputTokens,
    }),
    { calls: 0, inputTokens: 0, outputTokens: 0 },
  );

  return {
    system,
    cases: outcomes.length,
    correct: outcomes.filter((outcome) => outcome.correct).length,
    accuracy: rate(outcomes.filter((outcome) => outcome.correct).length, outcomes.length),
    materialErrorsPresent: materialPresent.length,
    materialErrorsCaught: caught.length,
    materialErrorDetectionRate: rate(caught.length, materialPresent.length),
    falseContradictions: outcomes.filter((outcome) => outcome.falseContradiction).length,
    falseContradictionRate: rate(
      outcomes.filter((outcome) => outcome.falseContradiction).length,
      noMaterialError.length,
    ),
    unsupportedRecognised: unsupportedCases.filter((outcome) => outcome.correct).length,
    unsupportedTotal: unsupportedCases.length,
    staleDetected: stale.detected,
    staleTotal: stale.total,
    staleDetectionRate: rate(stale.detected, stale.total),
    citationMismatchDetected: citationMismatch.detected,
    citationMismatchTotal: citationMismatch.total,
    citationMismatchDetectionRate: rate(citationMismatch.detected, citationMismatch.total),
    validCitationRate:
      totalCitations === 0 ? null : rate(totalCitations - invalidCitations, totalCitations),
    medianLatencyMs: median(outcomes.map((outcome) => outcome.latencyMs)),
    totalToolCalls: outcomes.reduce((sum, outcome) => sum + outcome.toolCalls, 0),
    totalSourcesFetched: outcomes.reduce((sum, outcome) => sum + outcome.sourcesFetched, 0),
    totalModelCalls: usage.calls,
    totalInputTokens: usage.inputTokens,
    totalOutputTokens: usage.outputTokens,
    estimatedCostUsd: estimateCostUsd(usage, rates),
    costPerMaterialErrorCaughtUsd: costPerCatch(estimateCostUsd(usage, rates), caught.length),
    errors: outcomes.filter((outcome) => outcome.errorCode !== undefined).length,
  };
}

/** A compact table for the terminal. */
export function formatMetrics(all: readonly SystemMetrics[]): string {
  const rows = [
    ["metric", ...all.map((m) => m.system)],
    ["cases", ...all.map((m) => String(m.cases))],
    ["correct", ...all.map((m) => `${m.correct}/${m.cases}`)],
    ["accuracy", ...all.map((m) => m.accuracy.toFixed(3))],
    [
      "material errors caught",
      ...all.map((m) => `${m.materialErrorsCaught}/${m.materialErrorsPresent}`),
    ],
    ["  detection rate", ...all.map((m) => m.materialErrorDetectionRate.toFixed(3))],
    ["false contradictions", ...all.map((m) => String(m.falseContradictions))],
    ["  rate", ...all.map((m) => m.falseContradictionRate.toFixed(3))],
    [
      "unsupported recognised",
      ...all.map((m) => `${m.unsupportedRecognised}/${m.unsupportedTotal}`),
    ],
    ["stale info caught", ...all.map((m) => `${m.staleDetected}/${m.staleTotal}`)],
    ["  detection rate", ...all.map((m) => m.staleDetectionRate.toFixed(3))],
    [
      "citation mismatch caught",
      ...all.map((m) => `${m.citationMismatchDetected}/${m.citationMismatchTotal}`),
    ],
    ["  detection rate", ...all.map((m) => m.citationMismatchDetectionRate.toFixed(3))],
    [
      "valid citation rate",
      ...all.map((m) => (m.validCitationRate === null ? "n/a" : m.validCitationRate.toFixed(3))),
    ],
    ["median latency ms", ...all.map((m) => String(m.medianLatencyMs))],
    ["tool calls (total)", ...all.map((m) => String(m.totalToolCalls))],
    ["sources fetched", ...all.map((m) => String(m.totalSourcesFetched))],
    ["model calls (total)", ...all.map((m) => String(m.totalModelCalls))],
    [
      "tokens in/out",
      ...all.map((m) =>
        m.totalInputTokens === 0 && m.totalOutputTokens === 0
          ? "not reported"
          : `${m.totalInputTokens}/${m.totalOutputTokens}`,
      ),
    ],
    [
      "estimated cost usd",
      ...all.map((m) => (m.estimatedCostUsd === null ? "n/a" : m.estimatedCostUsd.toFixed(4))),
    ],
    [
      "cost per error caught",
      ...all.map((m) =>
        m.costPerMaterialErrorCaughtUsd === null
          ? "n/a"
          : m.costPerMaterialErrorCaughtUsd.toFixed(4),
      ),
    ],
    ["errors", ...all.map((m) => String(m.errors))],
  ];

  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? "").length)),
  );

  return rows
    .map((row, index) => {
      const line = row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");
      return index === 0 ? `${line}\n${widths.map((w) => "-".repeat(w)).join("  ")}` : line;
    })
    .join("\n");
}
