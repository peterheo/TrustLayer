import type {
  AgentTurnDecision,
  AgentTurnDriver,
  AgentTurnInput,
  AgentTurnRequest,
  AgentTurnSession,
  JsonObject,
} from "@aicoo/sharedos";

import {
  AdjudicationSubmissionSchema,
  type AdjudicationSubmission,
  type PlannedClaim,
  type VerifyRequest,
} from "../evidence/schemas.js";
import type { EvidenceLedger } from "../evidence/ledger.js";
import type { ModelObservation, ModelSubmissionSpec, VerifierModel } from "./model.js";
import { hasFocusClaims, parsePlanSubmission, planFromDraft, planFromFocusClaims } from "./planner.js";
import { ProtocolState, type Phase } from "./protocol.js";
import {
  ADJUDICATION_JSON_SCHEMA,
  PHASE_DONE_JSON_SCHEMA,
  PLAN_JSON_SCHEMA,
  SUBMIT_ADJUDICATION,
  SUBMIT_CHALLENGE_COMPLETE,
  SUBMIT_PLAN,
  SUBMIT_RESEARCH_COMPLETE,
  VERIFIER_SYSTEM_PROMPT,
  adjudicateInstruction,
  buildContextBrief,
  challengeInstruction,
  planInstruction,
  researchInstruction,
} from "./prompts.js";

/**
 * The verification protocol driver.
 *
 * Two things make this more than a wrapper around a model loop.
 *
 * First, it never invokes a tool itself. It returns a `tool_call` decision and
 * the SharedOS envelope performs the call, re-authorizing it against the
 * kernel; the driver only ever sees the `ToolResult` that comes back. That is
 * what puts every retrieval in the audit trail, and why a model reaching for a
 * tool it was not granted gets a refusal rather than an action.
 *
 * Second, it owns the protocol phases. Between SharedOS tool calls it loops
 * the model locally — asking for a plan, moving to research, forcing a
 * challenge round, then asking for adjudication — and records what actually
 * happened in each phase. The receipt's `checks` come from that record, so
 * "a contradiction search was performed" means a search tool call really did
 * succeed while the challenge phase was current, not that a model said so.
 */

/** A guard against a model that submits nothing useful in a loop. */
const MAX_LOCAL_STEPS_PER_DECISION = 6;

export interface VerifierDriverOptions {
  readonly model: VerifierModel;
  readonly request: VerifyRequest;
  readonly ledger: EvidenceLedger;
  readonly protocol: ProtocolState;
  /** Tool calls the driver may spend before it must adjudicate. */
  readonly toolCallBudget: number;
}

/** What the driver produced, read by the host after the turn. */
export interface DriverOutcome {
  plan: readonly PlannedClaim[];
  adjudication?: AdjudicationSubmission;
}

const SUBMISSION_SPECS: readonly ModelSubmissionSpec[] = [
  {
    name: SUBMIT_PLAN,
    description: "Submit the list of claims selected for verification.",
    schema: PLAN_JSON_SCHEMA as unknown as JsonObject,
  },
  {
    name: SUBMIT_RESEARCH_COMPLETE,
    description: "Signal that evidence gathering is finished.",
    schema: PHASE_DONE_JSON_SCHEMA as unknown as JsonObject,
  },
  {
    name: SUBMIT_CHALLENGE_COMPLETE,
    description: "Signal that the contradiction search is finished.",
    schema: PHASE_DONE_JSON_SCHEMA as unknown as JsonObject,
  },
  {
    name: SUBMIT_ADJUDICATION,
    description: "Submit the final per-claim judgments.",
    schema: ADJUDICATION_JSON_SCHEMA as unknown as JsonObject,
  },
];

export function createVerifierDriver(
  options: VerifierDriverOptions,
): AgentTurnDriver & { readonly outcome: DriverOutcome } {
  const { model, request, ledger, protocol } = options;
  const outcome: DriverOutcome = { plan: [] };

  const driver: AgentTurnDriver & { readonly outcome: DriverOutcome } = {
    outcome,

    async open(turnRequest: AgentTurnRequest, signal: AbortSignal): Promise<AgentTurnSession> {
      const session = await model.start(
        {
          system: VERIFIER_SYSTEM_PROMPT,
          context: buildContextBrief(request),
          tools: turnRequest.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
          submissions: SUBMISSION_SPECS,
        },
        signal,
      );

      const traceId = turnRequest.context.traceId;
      const candidateUrls = request.sourceUrls ?? [];
      let toolCallsSpent = 0;

      /** Move the protocol on, and tell both the ledger and the model. */
      function enterPhase(phase: Phase): void {
        protocol.enter(phase);
        // The ledger attributes subsequent tool calls to this phase, which is
        // what makes challenge-phase discovery provable after the fact.
        ledger.setPhase(phase);
      }

      function instructionFor(phase: Phase): string {
        switch (phase) {
          case "plan":
            return planInstruction(request);
          case "discover":
          case "fetch":
            return researchInstruction(outcome.plan, candidateUrls);
          case "challenge":
            return challengeInstruction(outcome.plan);
          default:
            return adjudicateInstruction(outcome.plan);
        }
      }

      /**
       * Start the turn.
       *
       * With `focusClaims` the plan is host-built and the PLAN phase costs no
       * model call at all — the caller already said what matters.
       */
      function openingObservation(): ModelObservation {
        if (hasFocusClaims(request)) {
          outcome.plan = planFromFocusClaims(request);
          protocol.complete("plan");
          enterPhase("discover");
          return { kind: "instruction", text: researchInstruction(outcome.plan, candidateUrls) };
        }
        enterPhase("plan");
        return { kind: "instruction", text: planInstruction(request) };
      }

      let pending: ModelObservation | undefined;

      return {
        async next(input: AgentTurnInput, turnSignal: AbortSignal): Promise<AgentTurnDecision> {
          let observation: ModelObservation;

          if (input.type === "start") {
            observation = openingObservation();
          } else {
            const succeeded = input.result.status === "succeeded";
            protocol.recordToolResult(input.result.tool, succeeded);
            observation = {
              kind: "tool_result",
              callId: input.result.callId,
              toolName: input.result.tool,
              ok: succeeded,
              payload: succeeded
                ? input.result.output
                : { error: input.result.error.code, message: input.result.error.message },
            };
          }

          if (pending !== undefined) {
            observation = pending;
            pending = undefined;
          }

          // Loop the model locally across phase transitions; only a tool call
          // or the end of the protocol returns to SharedOS.
          for (let step = 0; step < MAX_LOCAL_STEPS_PER_DECISION; step += 1) {
            let decision;
            try {
              decision = await session.next(observation, turnSignal);
            } catch {
              protocol.fail(protocol.phase, "the model could not continue");
              return {
                type: "fail",
                error: {
                  code: "driver_failed",
                  message: "The verification agent could not continue.",
                  retryable: false,
                },
                metadata: { modelId: model.id, phase: protocol.phase },
              };
            }

            if (decision.kind === "tool_call") {
              toolCallsSpent += 1;
              // Out of budget: stop researching and adjudicate on what we have,
              // which yields a `partial` receipt rather than a hung turn.
              if (toolCallsSpent > options.toolCallBudget) {
                protocol.fail(protocol.phase, "tool call budget exhausted");
                enterPhase("adjudicate");
                observation = { kind: "instruction", text: adjudicateInstruction(outcome.plan) };
                continue;
              }
              return {
                type: "tool_call",
                call: {
                  id: decision.callId,
                  tool: decision.toolName,
                  arguments: decision.arguments,
                  traceId,
                  requestedAt: new Date().toISOString(),
                },
              };
            }

            const advanced = handleSubmission(decision.submission, decision.payload);
            if (advanced.type === "complete") return advanced.decision;
            observation = { kind: "instruction", text: advanced.instruction };
          }

          // The model submitted nothing actionable for several rounds.
          protocol.fail(protocol.phase, "the model did not progress the protocol");
          return {
            type: "complete",
            output: { plan: outcome.plan.length, stalled: true } as never,
            metadata: { modelId: model.id, phase: protocol.phase, stalled: true },
          };
        },
      };

      type Advance =
        | { readonly type: "instruction"; readonly instruction: string }
        | { readonly type: "complete"; readonly decision: AgentTurnDecision };

      /** Apply a phase submission and decide what the model is asked next. */
      function handleSubmission(submission: string, payload: unknown): Advance {
        switch (submission) {
          case SUBMIT_PLAN: {
            if (protocol.completed("plan")) {
              return { type: "instruction", instruction: instructionFor(protocol.phase) };
            }
            try {
              outcome.plan = planFromDraft(parsePlanSubmission(payload), request);
            } catch {
              protocol.fail("plan", "the plan submission was not valid");
              return { type: "instruction", instruction: planInstruction(request) };
            }
            protocol.complete("plan");
            enterPhase("discover");
            return {
              type: "instruction",
              instruction: researchInstruction(outcome.plan, candidateUrls),
            };
          }

          case SUBMIT_RESEARCH_COMPLETE: {
            protocol.complete("discover");
            if (protocol.activityIn("fetch").fetchCalls > 0 || protocol.totalFetchesSucceeded > 0) {
              protocol.complete("fetch");
            }
            enterPhase("challenge");
            return { type: "instruction", instruction: challengeInstruction(outcome.plan) };
          }

          case SUBMIT_CHALLENGE_COMPLETE: {
            protocol.complete("challenge");
            enterPhase("adjudicate");
            return { type: "instruction", instruction: adjudicateInstruction(outcome.plan) };
          }

          case SUBMIT_ADJUDICATION: {
            const parsed = AdjudicationSubmissionSchema.safeParse(payload);
            if (!parsed.success) {
              protocol.fail("adjudicate", "the adjudication submission was not valid");
              return {
                type: "complete",
                decision: {
                  type: "fail",
                  error: {
                    code: "adjudication_invalid",
                    message: "The verifier returned an unusable adjudication.",
                    retryable: false,
                  },
                  metadata: { modelId: model.id },
                },
              };
            }
            outcome.adjudication = parsed.data;
            protocol.complete("adjudicate");
            return {
              type: "complete",
              decision: {
                type: "complete",
                // The turn output is a marker; the real artefacts are read off
                // the driver's own state and the ledger, neither of which the
                // model can write to.
                output: { adjudicated: parsed.data.adjudications.length } as never,
                metadata: { modelId: model.id },
              },
            };
          }

          default:
            return { type: "instruction", instruction: instructionFor(protocol.phase) };
        }
      }
    },
  };

  return driver;
}
