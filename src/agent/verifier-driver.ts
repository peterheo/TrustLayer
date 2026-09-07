import type {
  AgentTurnDecision,
  AgentTurnDriver,
  AgentTurnInput,
  AgentTurnRequest,
  AgentTurnSession,
  JsonObject,
} from "@aicoo/sharedos";

import type { ModelObservation, ModelToolSpec, VerifierModel } from "./model.js";
import { VERIFIER_JUDGMENT_JSON_SCHEMA, VERIFIER_SYSTEM_PROMPT } from "./verifier-prompt.js";

/**
 * The adapter between a model's tool-use loop and SharedOS's turn protocol.
 *
 * The driver never invokes a tool itself. It returns a `tool_call` decision and
 * the SharedOS envelope performs the call, re-authorizing it against the
 * kernel; the driver only sees the `ToolResult` that comes back. That is what
 * puts every research call in the audit trail, and it is why a model asking for
 * a tool it was not granted produces a refusal rather than an action.
 *
 * The catalogue offered to the model is `request.tools` — the *effective*
 * catalogue SharedOS computed for this context. Tools the verifier has no
 * capability for are already absent from it.
 */
export function createVerifierDriver(model: VerifierModel): AgentTurnDriver {
  return {
    async open(request: AgentTurnRequest, signal: AbortSignal): Promise<AgentTurnSession> {
      const tools: ModelToolSpec[] = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));

      const task = readTaskFromMessage(request);

      const session = await model.start(
        {
          system: VERIFIER_SYSTEM_PROMPT,
          task,
          tools,
          outputSchema: VERIFIER_JUDGMENT_JSON_SCHEMA as unknown as JsonObject,
        },
        signal,
      );

      const traceId = request.context.traceId;

      return {
        async next(input: AgentTurnInput, turnSignal: AbortSignal): Promise<AgentTurnDecision> {
          const observation: ModelObservation =
            input.type === "start"
              ? { kind: "start" }
              : {
                  kind: "tool_result",
                  callId: input.result.callId,
                  toolName: input.result.tool,
                  ok: input.result.status === "succeeded",
                  payload:
                    input.result.status === "succeeded"
                      ? input.result.output
                      : { error: input.result.error.code, message: input.result.error.message },
                };

          let step;
          try {
            step = await session.next(observation, turnSignal);
          } catch {
            return {
              type: "fail",
              error: {
                code: "driver_failed",
                message: "The verification agent could not continue.",
                retryable: false,
              },
              metadata: { modelId: model.id },
            };
          }

          if (step.kind === "final") {
            // Handed over unvalidated on purpose: the host parses it through
            // VerifierJudgmentSchema after the turn, so a malformed judgment is
            // a MODEL_OUTPUT_INVALID with a real audit trail rather than a
            // driver-side throw that loses the execution record.
            return { type: "complete", output: step.output as never, metadata: { modelId: model.id } };
          }

          return {
            type: "tool_call",
            call: {
              id: step.callId,
              tool: step.toolName,
              arguments: step.arguments,
              traceId,
              requestedAt: new Date().toISOString(),
            },
          };
        },
      };
    },
  };
}

/**
 * The task text, read from the trusted message payload the host built.
 *
 * The payload is host-constructed in `api/verify.ts` from a validated request,
 * so this is not a place a caller can inject a different system prompt.
 */
function readTaskFromMessage(request: AgentTurnRequest): string {
  const payload = request.message.payload;
  if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
    const task = (payload as Record<string, unknown>)["task"];
    if (typeof task === "string") return task;
  }
  return "";
}
