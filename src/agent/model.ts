import type { JsonObject } from "@aicoo/sharedos";

import { config } from "../config.js";
import { TrustLayerError } from "../errors.js";

/**
 * The model provider port.
 *
 * SharedOS does not own the model, and TrustLayer does not couple to one
 * vendor. Everything provider-specific lives behind this interface, so the
 * verifier driver, the tool boundary, the evidence ledger, and the scoring are
 * all testable without a network or an API key.
 */

/** A tool as the model sees it: name, description, schema. No capability data. */
export interface ModelToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
}

export interface ModelTurnRequest {
  readonly system: string;
  readonly task: string;
  readonly tools: readonly ModelToolSpec[];
  /** The schema the final answer must satisfy. */
  readonly outputSchema: JsonObject;
}

export type ModelObservation =
  | { readonly kind: "start" }
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
  | { readonly kind: "final"; readonly output: unknown };

export interface VerifierModelSession {
  next(observation: ModelObservation, signal: AbortSignal): Promise<ModelStep>;
}

export interface VerifierModel {
  readonly id: string;
  start(request: ModelTurnRequest, signal: AbortSignal): Promise<VerifierModelSession>;
}

/**
 * A model that replays a fixed script.
 *
 * This is what the test suite runs on. It makes tool visibility, evidence
 * validation, scoring, and the injection fixtures deterministic, and it lets a
 * test script a model that misbehaves — citing a source that was never
 * returned, or reaching for a tool it was never granted — which a real model
 * cannot be relied upon to do on command.
 */
export class ScriptedVerifierModel implements VerifierModel {
  readonly id = "scripted";
  readonly #script: readonly ModelStep[];
  /** Every observation the driver handed back, for assertions. */
  readonly observations: ModelObservation[] = [];
  /** The catalogue the model was offered, for tool-visibility assertions. */
  offeredTools: readonly string[] = [];

  constructor(script: readonly ModelStep[]) {
    this.#script = script;
  }

  async start(request: ModelTurnRequest): Promise<VerifierModelSession> {
    this.offeredTools = request.tools.map((tool) => tool.name);
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

const SUBMIT_TOOL = "submit_judgment";

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
 * Structured output is obtained by giving the model a `submit_judgment` tool
 * whose input schema is the judgment schema, alongside the SharedOS research
 * tools. Calling that tool is how the model ends its turn, which keeps the
 * final answer schema-constrained instead of parsed out of prose.
 *
 * Provider-native web search is deliberately not enabled: it would fetch
 * outside the SharedOS tool boundary, so none of it would appear in the audit
 * trail or the evidence ledger.
 */
export class AnthropicVerifierModel implements VerifierModel {
  readonly id = "anthropic";
  readonly #apiKey: string;
  readonly #model: string;

  constructor(apiKey: string, model: string) {
    this.#apiKey = apiKey;
    this.#model = model;
  }

  async start(request: ModelTurnRequest): Promise<VerifierModelSession> {
    const apiKey = this.#apiKey;
    const model = this.#model;
    const messages: AnthropicMessage[] = [];

    const tools = [
      ...request.tools.map((tool) => ({
        name: tool.name.replaceAll(".", "_"),
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
      {
        name: SUBMIT_TOOL,
        description:
          "Submit the final verification judgment. Call this exactly once, when finished.",
        input_schema: request.outputSchema,
      },
    ];
    // The wire names cannot contain dots; map back so SharedOS sees real names.
    const wireToReal = new Map(request.tools.map((tool) => [tool.name.replaceAll(".", "_"), tool.name]));

    return {
      async next(observation: ModelObservation, signal: AbortSignal): Promise<ModelStep> {
        if (observation.kind === "start") {
          messages.push({ role: "user", content: request.task });
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

        const body = (await response.json()) as { content?: readonly AnthropicContentBlock[] };
        const content = body.content ?? [];
        messages.push({ role: "assistant", content });

        const toolUse = content.find((block) => block.type === "tool_use");
        if (toolUse === undefined || toolUse.name === undefined || toolUse.id === undefined) {
          throw new TrustLayerError("MODEL_OUTPUT_INVALID", "model produced no tool call");
        }

        if (toolUse.name === SUBMIT_TOOL) {
          return { kind: "final", output: toolUse.input };
        }

        const realName = wireToReal.get(toolUse.name) ?? toolUse.name;
        const args =
          typeof toolUse.input === "object" && toolUse.input !== null && !Array.isArray(toolUse.input)
            ? (toolUse.input as JsonObject)
            : {};
        return { kind: "tool_call", callId: toolUse.id, toolName: realName, arguments: args };
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
