import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { METHOD_VERSION } from "../src/evidence/schemas.js";
import type { CaseOutcome, CostRates, SystemMetrics } from "./metrics.js";

/**
 * Preserving a benchmark run.
 *
 * A number quoted in a README with no run behind it is a marketing claim. This
 * writes the run down instead — commit, model, method version, budgets,
 * pricing assumptions, every system's metrics and every per-case outcome — so
 * anyone can see what was measured, on what, and reproduce or dispute it.
 *
 * Selftest runs are written too when asked for, but stamped as selftests, so a
 * harness exercise can never be mistaken for a result.
 */

export interface RunConditions {
  readonly selftest: boolean;
  readonly provider: string;
  readonly model: string;
  readonly searchProvider: string;
  readonly cases: number;
  readonly repetitions: number;
  readonly webAgentBudget: { readonly maxToolCalls: number; readonly maxModelCalls: number };
  readonly rates: CostRates | undefined;
}

export interface BenchmarkReport {
  readonly generatedAt: string;
  readonly commit: string;
  readonly methodVersion: string;
  readonly conditions: RunConditions;
  readonly systems: readonly SystemMetrics[];
  readonly outcomes: Readonly<Record<string, readonly CaseOutcome[]>>;
}

/** The commit the run was made from, or `unknown` outside a work tree. */
export function currentCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function buildReport(
  conditions: RunConditions,
  systems: readonly SystemMetrics[],
  outcomes: Readonly<Record<string, readonly CaseOutcome[]>>,
  now = new Date(),
): BenchmarkReport {
  return {
    generatedAt: now.toISOString(),
    commit: currentCommit(),
    methodVersion: METHOD_VERSION,
    conditions,
    systems,
    outcomes,
  };
}

function metricRows(report: BenchmarkReport): string {
  const systems = report.systems;
  const header = `| metric | ${systems.map((system) => system.system).join(" | ")} |`;
  const divider = `| --- | ${systems.map(() => "---").join(" | ")} |`;

  const row = (label: string, value: (system: SystemMetrics) => string): string =>
    `| ${label} | ${systems.map(value).join(" | ")} |`;

  const ratio = (value: number): string => value.toFixed(3);
  const money = (value: number | null): string => (value === null ? "n/a" : value.toFixed(4));

  return [
    header,
    divider,
    row("cases", (s) => String(s.cases)),
    row("correct", (s) => `${s.correct}/${s.cases}`),
    row("material errors caught", (s) => `${s.materialErrorsCaught}/${s.materialErrorsPresent}`),
    row("material error detection", (s) => ratio(s.materialErrorDetectionRate)),
    row("false contradictions", (s) => String(s.falseContradictions)),
    row("false contradiction rate", (s) => ratio(s.falseContradictionRate)),
    row("stale info caught", (s) => `${s.staleDetected}/${s.staleTotal}`),
    row("stale detection", (s) => ratio(s.staleDetectionRate)),
    row("citation mismatch caught", (s) => `${s.citationMismatchDetected}/${s.citationMismatchTotal}`),
    row("citation mismatch detection", (s) => ratio(s.citationMismatchDetectionRate)),
    row("unsupported recognised", (s) => `${s.unsupportedRecognised}/${s.unsupportedTotal}`),
    row("valid citation rate", (s) =>
      s.validCitationRate === null ? "n/a" : ratio(s.validCitationRate),
    ),
    row("median latency ms", (s) => String(s.medianLatencyMs)),
    row("tool calls", (s) => String(s.totalToolCalls)),
    row("model calls", (s) => String(s.totalModelCalls)),
    row("input tokens", (s) => String(s.totalInputTokens)),
    row("output tokens", (s) => String(s.totalOutputTokens)),
    row("estimated cost usd", (s) => money(s.estimatedCostUsd)),
    row("cost per error caught", (s) => money(s.costPerMaterialErrorCaughtUsd)),
    row("errors", (s) => String(s.errors)),
  ].join("\n");
}

function perCaseRows(report: BenchmarkReport): string {
  const systems = Object.keys(report.outcomes);
  const first = report.outcomes[systems[0] ?? ""] ?? [];
  const byCase = new Map<string, Record<string, string>>();

  for (const system of systems) {
    for (const outcome of report.outcomes[system] ?? []) {
      const row = byCase.get(outcome.caseId) ?? {};
      // With repetitions, a case shows every answer it gave.
      row[system] = row[system] === undefined ? outcome.actual : `${row[system]}, ${outcome.actual}`;
      byCase.set(outcome.caseId, row);
    }
  }

  const expectedByCase = new Map(first.map((outcome) => [outcome.caseId, outcome.expected]));

  return [
    `| case | expected | ${systems.join(" | ")} |`,
    `| --- | --- | ${systems.map(() => "---").join(" | ")} |`,
    ...[...byCase.entries()].map(
      ([caseId, row]) =>
        `| ${caseId} | ${expectedByCase.get(caseId) ?? "?"} | ` +
        `${systems.map((system) => row[system] ?? "-").join(" | ")} |`,
    ),
  ].join("\n");
}

export function renderMarkdown(report: BenchmarkReport): string {
  const { conditions } = report;

  const preamble = conditions.selftest
    ? [
        "> **THIS IS NOT A BENCHMARK RESULT.**",
        ">",
        "> Every system in this run used a stub model. It exercises the harness,",
        "> the budgets, the metering and the scoring. It says nothing about how",
        "> TrustLayer compares to anything, and must never be quoted as if it did.",
        "",
      ]
    : [];

  const pricing =
    conditions.rates === undefined
      ? "No token rates were supplied, so cost columns read n/a."
      : `Priced at $${conditions.rates.inputUsdPerMillionTokens}/Mtok input and ` +
        `$${conditions.rates.outputUsdPerMillionTokens}/Mtok output, as supplied by the runner.`;

  const repetitionNote =
    conditions.repetitions === 1
      ? "**Single-run benchmark** — one run per case per system, so per-case results carry run-to-run variance."
      : `${conditions.repetitions} runs per case per system.`;

  return [
    `# TrustLayer benchmark — ${report.generatedAt}`,
    "",
    ...preamble,
    "## Conditions",
    "",
    `- commit: \`${report.commit}\``,
    `- method version: \`${report.methodVersion}\``,
    `- model: \`${conditions.provider}\` / \`${conditions.model}\``,
    `- search backend: \`${conditions.searchProvider}\` (cases serve their own closed web)`,
    `- cases: ${conditions.cases}`,
    `- ${repetitionNote}`,
    `- web-agent baseline budget: ${conditions.webAgentBudget.maxToolCalls} tool calls, ` +
      `${conditions.webAgentBudget.maxModelCalls} model calls`,
    `- ${pricing}`,
    "",
    "## Results",
    "",
    metricRows(report),
    "",
    "## Per case",
    "",
    perCaseRows(report),
    "",
    "## Reading this",
    "",
    "The primary comparison is TrustLayer against `baseline(web-agent)`: the same",
    "model, with search and fetch over the same closed web and a comparable budget.",
    "Raw accuracy is not the measure — a system that answers `unverified` to",
    "everything never errs and is useless. What matters is the high-value failure",
    "modes (stale information, citation mismatch, fabricated evidence, unsupported",
    "assertions) caught without an unacceptable rise in false contradictions or cost.",
    "",
  ].join("\n");
}

export interface WrittenReport {
  readonly jsonPath: string;
  readonly markdownPath: string;
}

/** Write both artifacts under `evals/results/`, named by timestamp and commit. */
export function writeReport(report: BenchmarkReport, directory?: string): WrittenReport {
  const target =
    directory ?? join(dirname(fileURLToPath(import.meta.url)), "results");
  mkdirSync(target, { recursive: true });

  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const shortCommit = report.commit.slice(0, 12);
  const base = `${stamp}-${shortCommit}${report.conditions.selftest ? "-selftest" : ""}`;

  const jsonPath = join(target, `${base}.json`);
  const markdownPath = join(target, `${base}.md`);

  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderMarkdown(report), "utf8");

  return { jsonPath, markdownPath };
}
