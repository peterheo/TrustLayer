import {
  SharedOSExecutor,
  StandardRuntime,
  type AgentTurnDriver,
  type ExecutionRequest,
  type ExecutionResult,
  type JsonObject,
} from "@aicoo/sharedos";

import { config } from "../config.js";
import { TRUST_VERIFY_PURPOSE, VERIFIER_AGENT } from "./identity.js";
import type { TrustLayerHost } from "./kernel.js";
import { createVerificationContext } from "./context.js";

/**
 * Run one bounded verification turn.
 *
 * `SharedOSExecutor` is the non-replaceable security envelope: it admits the
 * turn against the execution capability, computes the effective tool
 * catalogue, and re-authorizes every tool call the runtime makes. The bounds
 * are set far below the Arena's five-minute ceiling so a slow verification
 * fails usefully instead of hanging.
 */

export interface RunTurnOptions {
  readonly host: TrustLayerHost;
  readonly driver: AgentTurnDriver;
  readonly executionId: string;
  readonly traceId: string;
  /** The host-built, trusted message payload handed to the verifier. */
  readonly payload: JsonObject;
  readonly signal?: AbortSignal;
  /** Overrides used by tests to prove a gate is real. */
  readonly purpose?: string;
  readonly enabledToolNamespaces?: readonly string[];
  readonly now?: string;
}

export async function runVerificationTurn(options: RunTurnOptions): Promise<ExecutionResult> {
  const { host, driver, executionId, traceId, payload } = options;

  const context = createVerificationContext({
    traceId,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    ...(options.enabledToolNamespaces === undefined
      ? {}
      : { enabledToolNamespaces: options.enabledToolNamespaces }),
  });

  // The effective catalogue for this context: registration AND namespace
  // enablement AND a matching capability. Anything missing one of the three is
  // simply not in this list, and therefore never reaches the model.
  const tools = await host.kernel.listTools(context);

  const request: ExecutionRequest = {
    version: "1",
    executionId,
    agent: VERIFIER_AGENT,
    context,
    message: {
      version: "1",
      id: `message-${executionId}`,
      sender: context.owner,
      receiver: VERIFIER_AGENT,
      purpose: context.purpose,
      payload,
      traceId,
      createdAt: context.now,
    },
    tools: [...tools],
    options: {
      maxSteps: config.turn.maxSteps,
      maxToolCalls: config.turn.maxToolCalls,
      timeoutMs: config.turn.timeoutMs,
    },
    metadata: { service: TRUST_VERIFY_PURPOSE },
  };

  const executor = new SharedOSExecutor(host.kernel, new StandardRuntime(driver), {
    onTurnError: () => undefined,
  });

  return executor.execute(request, {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
}
