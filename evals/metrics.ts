import type { ClaimStatus } from "../src/evidence/schemas.js";
import type { EvalCase } from "./cases/index.js";
import type { EvalWorld } from "./world.js";

/**
 * Scoring, defined so the numbers mean something.
 *
 * The headline metric is deliberately not "accuracy". A verifier that answers
 * `unverified` to everything is useless but never wrong, and one that answers
 * `contradicted` to everything catches every error while destroying every
 * correct answer. So the two are tracked separately: did it catch the material
 * errors, and did it manufacture problems that were not there.
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
  readonly validCitationRate: number | null;
  readonly medianLatencyMs: number;
  readonly totalToolCalls: number;
  readonly totalSourcesFetched: number;
  readonly errors: number;
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
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
  };
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

export function summarise(system: string, outcomes: readonly CaseOutcome[]): SystemMetrics {
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
    validCitationRate:
      totalCitations === 0 ? null : rate(totalCitations - invalidCitations, totalCitations),
    medianLatencyMs: median(outcomes.map((outcome) => outcome.latencyMs)),
    totalToolCalls: outcomes.reduce((sum, outcome) => sum + outcome.toolCalls, 0),
    totalSourcesFetched: outcomes.reduce((sum, outcome) => sum + outcome.sourcesFetched, 0),
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
    [
      "valid citation rate",
      ...all.map((m) => (m.validCitationRate === null ? "n/a" : m.validCitationRate.toFixed(3))),
    ],
    ["median latency ms", ...all.map((m) => String(m.medianLatencyMs))],
    ["tool calls (total)", ...all.map((m) => String(m.totalToolCalls))],
    ["sources fetched", ...all.map((m) => String(m.totalSourcesFetched))],
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
