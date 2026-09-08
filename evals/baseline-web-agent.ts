import { config } from "../src/config.js";
import { TrustLayerError } from "../src/errors.js";
import type { ClaimStatus } from "../src/evidence/schemas.js";
import { quarantine } from "../src/security/evidence-quarantine.js";
import { ZERO_USAGE, type ModelUsage, type UsageReporting } from "../src/verifier/model.js";
import type { BaselineVerdict } from "./baseline-second-check.js";
import type { EvalCase } from "./cases/index.js";
import { subtractUsage, usageOf } from "./metering.js";
import type { EvalWorld } from "./world.js";

/**
 * The real competitor: the same model, with search and fetch, doing the job
 * itself.
 *
 * "Why not just point a capable model at the web and ask it to check the
 * answer?" is the objection TrustLayer has to survive, and a benchmark that
 * only compares against a model answering from memory does not test it. So
 * this baseline gets the same case, the same claim, the same closed web, the
 * same model, and a comparable budget.
 *
 * What it does not get is the protocol: no evidence ledger, no host-minted
 * provenance, no citation validation, no independence rule, no forced
 * contradiction round, no protocol accounting. It reads pages and answers,
 * which is exactly what a competent agent would do unaided. That difference —
 * not the model, not the tools, not the budget — is the variable under test.
 *
 * Its prompt is written to be good. Handicapping the alternative would make
 * the comparison worthless to us and dishonest to everyone else.
 */

export const WEB_AGENT_SYSTEM = `You are checking whether a claim made by another agent is correct.

You can search the web and fetch pages. Use them: check the claim against what
sources actually say rather than from memory, and look for evidence that would
show the claim is wrong as well as evidence that would confirm it.

Answer with one of:
  supported       - the sources establish the claim is correct
  contradicted    - the sources establish the claim is wrong
  unverified      - you could not establish it either way
  not_falsifiable - the claim is subjective or otherwise not checkable

Give a confidence between 0 and 1, a short rationale, and the URLs you relied
on. Do not invent sources. Absence of evidence is not disproof.`;

/** What the baseline agent decided to do next. */
export type WebAgentStep =
  | { readonly kind: "search"; readonly query: string }
  | { readonly kind: "fetch"; readonly url: string }
  | { readonly kind: "verdict"; readonly verdict: BaselineVerdict };

export interface WebAgentSession {
  next(observation: string, signal: AbortSignal): Promise<WebAgentStep>;
}

export interface WebAgentModel {
  readonly id: string;
  start(system: string, context: string, signal: AbortSignal): Promise<WebAgentSession>;
}

export interface WebAgentLimits {
  readonly maxToolCalls: number;
  readonly maxModelCalls: number;
  readonly maxTextLength: number;
}

/**
 * Budgets, defaulted to what TrustLayer gets for a one-claim run and
 * overridable from the environment.
 *
 * TrustLayer's driver spends at most `TURN_MAX_TOOL_CALLS - 1` tool calls, so
 * the baseline gets the same ceiling. Model rounds default slightly above what
 * TrustLayer's protocol uses for one claim, because the baseline has to decide
 * its own next step where TrustLayer is driven through fixed phases — and if
 * either side should have the benefit of the doubt, it is the one we are
 * trying to beat. Actual usage is measured and reported either way.
 */
export function webAgentLimits(
  env: Record<string, string | undefined> = process.env,
): WebAgentLimits {
  const number = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    maxToolCalls: number(
      env["EVAL_WEB_BASELINE_MAX_TOOL_CALLS"],
      Math.max(1, config.turn.maxToolCalls - 1),
    ),
    maxModelCalls: number(env["EVAL_WEB_BASELINE_MAX_MODEL_CALLS"], 8),
    maxTextLength: config.research.fetchMaxTextLength,
  };
}

export interface WebAgentResult {
  readonly verdict: BaselineVerdict;
  readonly modelCalls: number;
  readonly toolCalls: number;
  readonly sourcesFetched: number;
  readonly usage: ModelUsage;
  readonly latencyMs: number;
  /** Set when the agent ran out of budget before answering. */
  readonly stopReason?: "tool_calls" | "model_calls";
}

export function buildWebAgentContext(testCase: EvalCase): string {
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

  return sections.join("\n");
}

/**
 * Run one case against the web-agent baseline.
 *
 * Search and fetch are served from the same `EvalWorld` TrustLayer sees, so
 * neither system can get lucky with a different web, and nothing here touches
 * the network. Retrieved HTML goes through the same text extraction, so the
 * baseline reads what TrustLayer would read — the comparison is about the
 * protocol, not about who got better text.
 */
export async function runWebAgentBaseline(
  testCase: EvalCase,
  world: EvalWorld,
  model: WebAgentModel,
  signal: AbortSignal,
  limits: WebAgentLimits = webAgentLimits(),
): Promise<WebAgentResult> {
  const started = Date.now();
  const usageBefore = usageOf(model);

  const session = await model.start(WEB_AGENT_SYSTEM, buildWebAgentContext(testCase), signal);

  let toolCalls = 0;
  let modelCalls = 0;
  let sourcesFetched = 0;
  let stopReason: WebAgentResult["stopReason"];

  let observation =
    "Check the claim. Use search and fetch as you see fit, then submit your verdict.";

  const finish = (verdict: BaselineVerdict): WebAgentResult => ({
    verdict,
    modelCalls,
    toolCalls,
    sourcesFetched,
    usage: { ...subtractUsage(usageOf(model), usageBefore), calls: modelCalls },
    latencyMs: Date.now() - started,
    ...(stopReason === undefined ? {} : { stopReason }),
  });

  /** No verdict is scored as `unverified`, which is what a caller would be left with. */
  const gaveUp = (reason: string): BaselineVerdict => ({
    status: "unverified" as ClaimStatus,
    confidence: 0,
    rationale: reason,
    citedUrls: [],
  });

  for (;;) {
    if (modelCalls >= limits.maxModelCalls) {
      stopReason = "model_calls";
      return finish(gaveUp("The baseline reached its model-call budget without answering."));
    }

    modelCalls += 1;
    const step = await session.next(observation, signal);

    if (step.kind === "verdict") return finish(step.verdict);

    if (toolCalls >= limits.maxToolCalls) {
      // Out of tool budget: tell it so and let it answer on what it has.
      stopReason = "tool_calls";
      observation =
        "You have used your entire search and fetch budget. Submit your verdict now, " +
        "based on what you already have.";
      continue;
    }

    toolCalls += 1;

    if (step.kind === "search") {
      const hits = await world.backend.search(step.query);
      observation =
        hits.length === 0
          ? `Search for "${step.query}" returned no results.`
          : [
              `Search results for "${step.query}":`,
              ...hits.map((hit) => `- ${hit.title ?? hit.url} (${hit.url}): ${hit.snippet ?? ""}`),
            ].join("\n");
      continue;
    }

    // fetch
    let response: Response;
    try {
      response = await world.fetch(step.url);
    } catch {
      observation = `Fetching ${step.url} failed.`;
      continue;
    }

    if (!response.ok) {
      observation = `Fetching ${step.url} returned HTTP ${response.status}. It is not available.`;
      continue;
    }

    const body = await response.text();
    const cleaned = quarantine(body, limits.maxTextLength, true);
    sourcesFetched += 1;
    observation = [
      `Contents of ${step.url}:`,
      cleaned.text,
      "",
      "Continue, or submit your verdict.",
    ].join("\n");
  }
}

interface AnthropicBlock {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
}

const TOOLS = [
  {
    name: "search",
    description: "Search the web for sources relevant to a query.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { query: { type: "string" } },
    },
  },
  {
    name: "fetch",
    description: "Fetch one public web page and read its text.",
    input_schema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: { url: { type: "string" } },
    },
  },
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
] as const;

/** The realistic implementation: a tool-using loop on the same provider. */
export class AnthropicWebAgentModel implements WebAgentModel, UsageReporting {
  readonly id: string;
  #usage: ModelUsage = ZERO_USAGE;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.id = `anthropic-web-agent:${model}`;
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

  async start(system: string, context: string, _signal: AbortSignal): Promise<WebAgentSession> {
    const apiKey = this.apiKey;
    const model = this.model;
    const record = (usage: unknown): void => {
      this.#record(usage);
    };

    const messages: { role: "user" | "assistant"; content: unknown }[] = [];
    let pendingToolUseId: string | undefined;
    let first = true;

    return {
      async next(observation: string, signal: AbortSignal): Promise<WebAgentStep> {
        if (pendingToolUseId === undefined) {
          messages.push({
            role: "user",
            content: first ? `${context}\n\n${observation}` : observation,
          });
        } else {
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: pendingToolUseId,
                content: observation.slice(0, 100_000),
              },
            ],
          });
          pendingToolUseId = undefined;
        }
        first = false;

        const response = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 2_048,
            system,
            tools: TOOLS,
            messages,
          }),
        });

        if (!response.ok) {
          throw new TrustLayerError("MODEL_FAILURE", `web baseline status ${response.status}`);
        }

        const body = (await response.json()) as {
          content?: readonly AnthropicBlock[];
          usage?: unknown;
        };
        record(body.usage);
        const content = body.content ?? [];
        messages.push({ role: "assistant", content });

        const toolUse = content.find((block) => block.type === "tool_use");
        if (toolUse?.name === undefined) {
          throw new TrustLayerError("MODEL_OUTPUT_INVALID", "web baseline produced no tool call");
        }

        const input =
          typeof toolUse.input === "object" && toolUse.input !== null
            ? (toolUse.input as Record<string, unknown>)
            : {};

        if (toolUse.name === "submit_verdict") {
          const status = input["status"];
          if (typeof status !== "string") {
            throw new TrustLayerError("MODEL_OUTPUT_INVALID", "web baseline returned no status");
          }
          return {
            kind: "verdict",
            verdict: {
              status: status as ClaimStatus,
              confidence: typeof input["confidence"] === "number" ? input["confidence"] : 0.5,
              rationale: typeof input["rationale"] === "string" ? input["rationale"] : "",
              citedUrls: Array.isArray(input["citedUrls"]) ? input["citedUrls"].map(String) : [],
            },
          };
        }

        pendingToolUseId = toolUse.id;
        if (toolUse.name === "search") {
          return { kind: "search", query: String(input["query"] ?? "") };
        }
        return { kind: "fetch", url: String(input["url"] ?? "") };
      },
    };
  }
}

/**
 * A scripted web agent, for exercising the harness without a provider.
 *
 * Produces no benchmark result and must never be reported as one.
 */
export class ScriptedWebAgentModel implements WebAgentModel {
  readonly id = "scripted-web-agent";
  /** Everything the loop handed back, for assertions. */
  readonly observations: string[] = [];

  constructor(private readonly script: readonly WebAgentStep[]) {}

  async start(_system: string, context: string): Promise<WebAgentSession> {
    this.observations.push(context);
    const script = this.script;
    const seen = this.observations;
    let index = 0;

    return {
      async next(observation: string): Promise<WebAgentStep> {
        seen.push(observation);
        const step = script[index];
        index += 1;
        // Running off the end means the script never answered; the loop's own
        // budget rules then decide what happens.
        return (
          step ?? {
            kind: "search",
            query: "still looking",
          }
        );
      },
    };
  }
}
