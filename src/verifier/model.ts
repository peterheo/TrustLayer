import type { JsonObject } from "@aicoo/sharedos";

import { config } from "../config.js";
import { TrustLayerError } from "../errors.js";

/**
 * The model provider port.
 *
 * SharedOS does not own the model and TrustLayer does not couple to one
 * vendor. Everything provider-specific lives behind this interface, so the
 * protocol driver, the tool boundary, the evidence ledger, the validator and
 * the receipt are all testable without a network or an API key.
 *
 * The model can do exactly two things: ask for a SharedOS research tool, or
 * submit a structured artefact for the current phase. It cannot end the turn,
 * set protocol state, or produce provenance.
 */

/** A tool as the model sees it. Carries no capability information. */
export interface ModelToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

/** A structured artefact the driver accepts for a phase. */
export interface ModelSubmissionSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: JsonObject;
}

export interface ModelTurnRequest {
  readonly system: string;
  /** The untrusted brief: the task and the output under verification. */
  readonly context: string;
  readonly tools: readonly ModelToolSpec[];
  readonly submissions: readonly ModelSubmissionSpec[];
}

export type ModelObservation =
  | { readonly kind: "instruction"; readonly text: string }
  | {
      readonly kind: "tool_result";
      readonly callId: string;
      readonly toolName: string;
      readonly ok: boolean;
      readonly payload: unknown;
    };

export type ModelStep =
  | {
      readonly kind: "tool_call";
      readonly callId: string;
      readonly toolName: string;
      readonly arguments: JsonObject;
    }
  | { readonly kind: "submit"; readonly submission: string; readonly payload: unknown };

export interface VerifierModelSession {
  next(observation: ModelObservation, signal: AbortSignal): Promise<ModelStep>;
}

/**
 * What a run cost, where the provider reports it.
 *
 * Measured, never estimated: `calls` counts requests actually issued and the
 * token counts come from the provider's own accounting. A provider that does
 * not report usage leaves the token fields at zero rather than guessing, and
 * anything downstream that turns tokens into money has to supply the rate
 * itself — a price hard-coded here would be a number nobody measured.
 */
export interface ModelUsage {
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export const ZERO_USAGE: ModelUsage = { calls: 0, inputTokens: 0, outputTokens: 0 };

/** Implemented by models that can report what they spent. */
export interface UsageReporting {
  readonly usage: ModelUsage;
}

export function reportsUsage(value: unknown): value is UsageReporting {
  return (
    typeof value === "object" &&
    value !== null &&
    "usage" in value &&
    typeof (value as { usage: unknown }).usage === "object"
  );
}

export interface VerifierModel {
  readonly id: string;
  start(request: ModelTurnRequest, signal: AbortSignal): Promise<VerifierModelSession>;
}

/**
 * A model that replays a fixed script.
 *
 * This is what the tests and offline demos run on. It makes tool visibility,
 * phase accounting, evidence validation and receipt assembly deterministic,
 * and — more usefully — it lets a test script a model that *misbehaves*:
 * citing evidence that was never retrieved, skipping the challenge phase, or
 * reaching for a tool it was never granted. A real model cannot be relied upon
 * to do any of those on command.
 */
export class ScriptedVerifierModel implements VerifierModel {
  readonly id = "scripted";
  readonly #script: readonly ModelStep[];
  /** Everything the driver handed back, for assertions. */
  readonly observations: ModelObservation[] = [];
  /** The catalogue the model was offered, for tool-visibility assertions. */
  offeredTools: readonly string[] = [];
  offeredSubmissions: readonly string[] = [];

  constructor(script: readonly ModelStep[]) {
    this.#script = script;
  }

  async start(request: ModelTurnRequest): Promise<VerifierModelSession> {
    this.offeredTools = request.tools.map((tool) => tool.name);
    this.offeredSubmissions = request.submissions.map((submission) => submission.name);

    let index = 0;
    const script = this.#script;
    const observations = this.observations;

    return {
      async next(observation: ModelObservation): Promise<ModelStep> {
        observations.push(observation);
        const step = script[index];
        index += 1;
        if (step === undefined) {
          throw new TrustLayerError("MODEL_FAILURE", "scripted model ran out of steps");
        }
        return step;
      },
    };
  }
}

interface AnthropicContentBlock {
  readonly type: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
  readonly text?: string;
}

interface AnthropicMessage {
  readonly role: "user" | "assistant";
  readonly content: unknown;
}

/**
 * Anthropic Messages API.
 *
 * Research tools and phase submissions are both presented as tools, which
 * keeps every artefact schema-constrained rather than parsed out of prose.
 *
 * Provider-native web search is deliberately not enabled: it would retrieve
 * outside the SharedOS tool boundary, so nothing it found would appear in the
 * audit trail or acquire an evidence ID — which would make it useless as
 * evidence and invisible to the receipt.
 */
export class AnthropicVerifierModel implements VerifierModel, UsageReporting {
  readonly id = "anthropic";
  readonly #apiKey: string;
  readonly #model: string;
  /** Cumulative across every session this instance has started. */
  #usage: ModelUsage = ZERO_USAGE;

  constructor(apiKey: string, model: string) {
    this.#apiKey = apiKey;
    this.#model = model;
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

  async start(request: ModelTurnRequest): Promise<VerifierModelSession> {
    const apiKey = this.#apiKey;
    const model = this.#model;
    const record = (usage: unknown): void => {
      this.#record(usage);
    };
    const messages: AnthropicMessage[] = [];

    // Wire names cannot contain dots; map back so SharedOS sees real names.
    const wireToReal = new Map(
      request.tools.map((tool) => [tool.name.replaceAll(".", "_"), tool.name]),
    );
    const submissionNames = new Set(request.submissions.map((entry) => entry.name));

    const tools = [
      ...request.tools.map((tool) => ({
        name: tool.name.replaceAll(".", "_"),
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
      ...request.submissions.map((submission) => ({
        name: submission.name,
        description: submission.description,
        input_schema: submission.schema,
      })),
    ];

    let first = true;

    return {
      async next(observation: ModelObservation, signal: AbortSignal): Promise<ModelStep> {
        if (observation.kind === "instruction") {
          const text = first ? `${request.context}\n\n${observation.text}` : observation.text;
          first = false;
          messages.push({ role: "user", content: text });
        } else {
          messages.push({
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: observation.callId,
                is_error: !observation.ok,
                content: JSON.stringify(observation.payload).slice(0, 100_000),
              },
            ],
          });
        }

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
            max_tokens: 4_096,
            system: request.system,
            tools,
            messages,
          }),
        });

        if (!response.ok) {
          throw new TrustLayerError("MODEL_FAILURE", `anthropic status ${response.status}`);
        }

        const body = (await response.json()) as {
          content?: readonly AnthropicContentBlock[];
          usage?: unknown;
        };
        record(body.usage);
        const content = body.content ?? [];
        messages.push({ role: "assistant", content });

        const toolUse = content.find((block) => block.type === "tool_use");
        if (toolUse?.name === undefined || toolUse.id === undefined) {
          throw new TrustLayerError("MODEL_OUTPUT_INVALID", "model produced no tool call");
        }

        if (submissionNames.has(toolUse.name)) {
          return { kind: "submit", submission: toolUse.name, payload: toolUse.input };
        }

        const args =
          typeof toolUse.input === "object" &&
          toolUse.input !== null &&
          !Array.isArray(toolUse.input)
            ? (toolUse.input as JsonObject)
            : {};
        return {
          kind: "tool_call",
          callId: toolUse.id,
          toolName: wireToReal.get(toolUse.name) ?? toolUse.name,
          arguments: args,
        };
      },
    };
  }
}

export function createVerifierModel(): VerifierModel {
  if (config.model.provider === "anthropic") {
    if (config.model.apiKey === undefined) {
      throw new TrustLayerError("MODEL_FAILURE", "MODEL_PROVIDER=anthropic without MODEL_API_KEY");
    }
    return new AnthropicVerifierModel(config.model.apiKey, config.model.name);
  }
  throw new TrustLayerError(
    "MODEL_FAILURE",
    "no model provider configured; set MODEL_PROVIDER=anthropic or supply a model explicitly",
  );
}
