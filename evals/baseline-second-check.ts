import { TrustLayerError } from "../src/errors.js";
import type { ClaimStatus } from "../src/evidence/schemas.js";
import { ZERO_USAGE, type ModelUsage, type UsageReporting } from "../src/verifier/model.js";
import { subtractUsage, usageOf } from "./metering.js";
import type { EvalCase } from "./cases/index.js";
import type { EvalWorld } from "./world.js";

/**
 * The competitor: what a customer agent could obviously do itself.
 *
 * "Just ask another model to double-check it." This is the alternative
 * TrustLayer has to beat to be worth three credits, so it is implemented
 * properly rather than as a straw man:
 *
 * - It gets the same claim, stated the same way.
 * - It is told the same four statuses and what they mean.
 * - In `with_search` mode it gets the same discovery results TrustLayer's
 *   first search would return.
 *
 * What it does not get is the protocol: no forced retrieval, no contradiction
 * round, no evidence ledger, no provenance validation. That is the variable
 * under test.
 */

export type BaselineMode = "plain" | "with_search";

export interface BaselineVerdict {
  readonly status: ClaimStatus;
  readonly confidence: number;
  readonly rationale: string;
  /** URLs the baseline offered as support, if any. Checked against the world. */
  readonly citedUrls: readonly string[];
}

export interface BaselineResult {
  readonly verdict: BaselineVerdict;
  readonly modelCalls: number;
  /** Tokens this case cost, where the provider reports them. */
  readonly usage: ModelUsage;
  readonly latencyMs: number;
}

/** The port a baseline model implements. Kept tiny on purpose. */
export interface BaselineModel {
  readonly id: string;
  judge(prompt: string, signal: AbortSignal): Promise<BaselineVerdict>;
}

const BASELINE_SYSTEM = `You are asked to check whether a claim made by another agent is correct.
Answer with one of:
  supported       - you are confident the claim is correct
  contradicted    - you are confident the claim is wrong
  unverified      - you cannot establish it either way
  not_falsifiable - the claim is subjective or otherwise not checkable
Give a confidence between 0 and 1, a short rationale, and any URLs you are relying on.
Do not invent sources.`;

export function buildBaselinePrompt(
  testCase: EvalCase,
  mode: BaselineMode,
  world: EvalWorld,
): string {
  const sections = [
    `Original task: ${testCase.task}`,
    "",
    "Another agent produced this output:",
    testCase.candidateOutput,
    "",
    `Check this specific claim: ${testCase.focusClaim}`,
  ];

  if (testCase.sourceUrls !== undefined && testCase.sourceUrls.length > 0) {
    sections.push("", "The agent cited these sources:", ...testCase.sourceUrls.map((u) => `- ${u}`));
  }

  if (mode === "with_search") {
    sections.push(
      "",
      "Web search results for this claim:",
      ...world.snippets.map((hit) => `- ${hit.title} (${hit.url}): ${hit.snippet}`),
    );
  }

  return sections.join("\n");
}

export async function runBaseline(
  testCase: EvalCase,
  mode: BaselineMode,
  world: EvalWorld,
  model: BaselineModel,
  signal: AbortSignal,
): Promise<BaselineResult> {
  const started = Date.now();
  // Models are reused across cases, so this case's cost is the delta.
  const before = usageOf(model);
  const verdict = await model.judge(buildBaselinePrompt(testCase, mode, world), signal);
  const spent = subtractUsage(usageOf(model), before);

  return {
    verdict,
    // One call by construction: that economy is the baseline's advantage, and
    // the comparison is only honest if it is counted in the baseline's favour.
    modelCalls: 1,
    usage: { ...spent, calls: 1 },
    latencyMs: Date.now() - started,
  };
}

interface AnthropicBlock {
  readonly type: string;
  readonly name?: string;
  readonly input?: unknown;
}

/** The realistic implementation: one model call, structured output. */
export class AnthropicBaselineModel implements BaselineModel, UsageReporting {
  readonly id: string;
  #usage: ModelUsage = ZERO_USAGE;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.id = `anthropic:${model}`;
  }

  get usage(): ModelUsage {
    return this.#usage;
  }

  #record(usage: unknown): void {
    const record =
      typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : {};
    const input = typeof record["input_tokens"] === "number" ? record["input_tokens"] : 0;
    const output = typeof record["output_tokens"] === "number" ? record["output_tokens"] : 0;
    this.#usage = {
      calls: this.#usage.calls + 1,
      inputTokens: this.#usage.inputTokens + input,
      outputTokens: this.#usage.outputTokens + output,
    };
  }

  async judge(prompt: string, signal: AbortSignal): Promise<BaselineVerdict> {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1_024,
        system: BASELINE_SYSTEM,
        tools: [
          {
            name: "submit_verdict",
            description: "Submit your verdict on the claim.",
            input_schema: {
              type: "object",
              additionalProperties: false,
              required: ["status", "confidence", "rationale", "citedUrls"],
              properties: {
                status: {
                  type: "string",
                  enum: ["supported", "contradicted", "unverified", "not_falsifiable"],
                },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                rationale: { type: "string" },
                citedUrls: { type: "array", items: { type: "string" } },
              },
            },
          },
        ],
        tool_choice: { type: "tool", name: "submit_verdict" },
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      throw new TrustLayerError("MODEL_FAILURE", `baseline anthropic status ${response.status}`);
    }

    const body = (await response.json()) as {
      content?: readonly AnthropicBlock[];
      usage?: unknown;
    };
    this.#record(body.usage);
    const block = (body.content ?? []).find((entry) => entry.type === "tool_use");
    const input = block?.input as Partial<BaselineVerdict> | undefined;

    if (input?.status === undefined) {
      throw new TrustLayerError("MODEL_OUTPUT_INVALID", "baseline returned no verdict");
    }

    return {
      status: input.status,
      confidence: typeof input.confidence === "number" ? input.confidence : 0.5,
      rationale: typeof input.rationale === "string" ? input.rationale : "",
      citedUrls: Array.isArray(input.citedUrls) ? input.citedUrls.map(String) : [],
    };
  }
}

/**
 * A fixed-answer baseline, for exercising the harness without a model.
 *
 * This produces no benchmark result and must never be reported as one — it
 * exists so `pnpm eval --selftest` can prove the plumbing and the metrics work.
 */
export class StubBaselineModel implements BaselineModel {
  readonly id = "stub";

  constructor(private readonly answers: ReadonlyMap<string, BaselineVerdict>) {}

  #next: string[] = [];

  async judge(prompt: string): Promise<BaselineVerdict> {
    this.#next.push(prompt);
    for (const [key, verdict] of this.answers) {
      if (prompt.includes(key)) return verdict;
    }
    return {
      status: "unverified",
      confidence: 0.5,
      rationale: "stub default",
      citedUrls: [],
    };
  }
}
