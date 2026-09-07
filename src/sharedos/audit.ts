import type { ExecutionEvent, ExecutionResult } from "@aicoo/sharedos";

import type { VerifyAudit } from "../verification/schemas.js";

/**
 * Audit metadata, derived from the execution SharedOS actually performed.
 *
 * Every field here is read off `ExecutionResult` and its ordered event list.
 * None of it is model output. The model's judgment schema has no place to put
 * a trace id or a tool name, so there is nothing to accidentally trust.
 *
 * SharedOS has two event streams and they are not interchangeable:
 *
 * - `ExecutionResult.events` — the turn's own record. Observed types:
 *   `turn.started` (carrying `visibleTools`), `tool.requested`,
 *   `tool.completed`, and one terminal `turn.completed` / `turn.denied` /
 *   `turn.failed` / `turn.cancelled` / `turn.escalated`.
 * - The kernel's `AuditSink` — the authorization record. Observed types:
 *   `authority.resolved`, `tool.catalog.listed`, `authorization.checked`,
 *   `tool.invoked`, `turn.ended`, each flat and carrying `purpose`.
 *
 * This module reads the first. `tool.invoked` is *not* in it, which is why
 * tool usage is derived from `tool.completed`.
 */

/** Types observed on `ExecutionResult.events`. */
export const EXECUTION_EVENT_TYPES = {
  turnStarted: "turn.started",
  toolRequested: "tool.requested",
  toolCompleted: "tool.completed",
  turnCompleted: "turn.completed",
  turnDenied: "turn.denied",
  turnFailed: "turn.failed",
  turnCancelled: "turn.cancelled",
  turnEscalated: "turn.escalated",
} as const;

/** Types observed on the kernel's `AuditSink`. */
export const AUDIT_EVENT_TYPES = {
  authorityResolved: "authority.resolved",
  toolCatalogListed: "tool.catalog.listed",
  authorizationChecked: "authorization.checked",
  toolInvoked: "tool.invoked",
  turnEnded: "turn.ended",
} as const;

function dataOf(event: ExecutionEvent): Record<string, unknown> | undefined {
  const data = event.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
  return data as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * The tools this verification actually used, in first-use order.
 *
 * Read from `tool.completed` with a succeeded status: a call the kernel
 * refused is not a tool this verification used, and listing it would overstate
 * the work behind the verdict.
 */
export function toolsUsedFrom(events: readonly ExecutionEvent[]): readonly string[] {
  const used: string[] = [];
  for (const event of events) {
    if (event.type !== EXECUTION_EVENT_TYPES.toolCompleted) continue;
    const data = dataOf(event);
    if (data === undefined || data["status"] !== "succeeded") continue;
    const tool = stringField(data, "tool");
    if (tool !== undefined && !used.includes(tool)) used.push(tool);
  }
  return used;
}

/** The catalogue the turn was actually offered, as SharedOS filtered it. */
export function visibleToolsFrom(events: readonly ExecutionEvent[]): readonly string[] {
  for (const event of events) {
    if (event.type !== EXECUTION_EVENT_TYPES.turnStarted) continue;
    const data = dataOf(event);
    const visible = data?.["visibleTools"];
    if (Array.isArray(visible)) return visible.filter((name): name is string => typeof name === "string");
  }
  return [];
}

/**
 * Calls that did not succeed, for host-side logs.
 *
 * Not returned to the buyer: a refused call is a fact about our policy, and
 * the response exposes correlation identifiers rather than policy internals.
 */
export function refusedCallsFrom(
  events: readonly ExecutionEvent[],
): readonly { tool: string; status: string; reasonCode: string }[] {
  const refused: { tool: string; status: string; reasonCode: string }[] = [];
  for (const event of events) {
    if (event.type !== EXECUTION_EVENT_TYPES.toolCompleted) continue;
    const data = dataOf(event);
    if (data === undefined) continue;
    const status = stringField(data, "status") ?? "unknown";
    if (status === "succeeded") continue;
    const tool = stringField(data, "tool");
    if (tool === undefined) continue;

    const error = data["error"];
    const reasonCode =
      typeof error === "object" && error !== null && !Array.isArray(error)
        ? String((error as Record<string, unknown>)["code"] ?? "unknown")
        : (stringField(data, "reasonCode") ?? "unknown");
    refused.push({ tool, status, reasonCode });
  }
  return refused;
}

export function deriveAudit(result: ExecutionResult): VerifyAudit {
  const startedAt = result.startedAt;
  const completedAt = result.completedAt;
  const started = Date.parse(startedAt);
  const completed = Date.parse(completedAt);
  const durationMs =
    Number.isFinite(started) && Number.isFinite(completed) ? completed - started : undefined;

  return {
    executionId: result.executionId,
    traceId: result.traceId,
    toolsUsed: toolsUsedFrom(result.events),
    sharedosStatus: result.status,
    startedAt,
    completedAt,
    ...(durationMs === undefined ? {} : { durationMs }),
  };
}
