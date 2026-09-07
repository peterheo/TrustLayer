import { randomUUID } from "node:crypto";
import type { AccessContext } from "@aicoo/sharedos";

import {
  RESEARCH_TOOL_NAMESPACE,
  TRUSTLAYER_NAMESPACE_ID,
  TRUSTLAYER_SERVICE,
  TRUST_VERIFY_PURPOSE,
  VERIFIER_AGENT,
} from "./identity.js";

/**
 * The trusted context one verification turn runs under.
 *
 * Built entirely from host constants and freshly minted identifiers. In
 * particular the caller does not get to supply `purpose`, `actor`, `owner`, or
 * `enabledToolNamespaces` — SharedOS is explicit that a remote request body
 * does not define its own authority, and this function is where that rule is
 * kept.
 *
 * `enabledToolNamespaces` lists exactly one namespace. Every other family of
 * tools — files, repo, messages, sharedos — stays off, which is the second of
 * the three gates and the reason a malicious instruction cannot reach a
 * filesystem or a mailbox even in principle.
 */
export interface TurnIdentifiers {
  readonly executionId: string;
  readonly traceId: string;
}

export function newTurnIdentifiers(): TurnIdentifiers {
  return { executionId: randomUUID(), traceId: randomUUID() };
}

export interface CreateContextOptions {
  readonly traceId: string;
  /** Overrides the instant; tests freeze it. */
  readonly now?: string;
  /** Overrides the purpose, to prove a wrong-purpose turn is refused. */
  readonly purpose?: string;
  /** Overrides namespace enablement, to prove the gate is real. */
  readonly enabledToolNamespaces?: readonly string[];
}

export function createVerificationContext(options: CreateContextOptions): AccessContext {
  return {
    namespaceId: TRUSTLAYER_NAMESPACE_ID,
    actor: VERIFIER_AGENT,
    authority: TRUSTLAYER_SERVICE,
    owner: TRUSTLAYER_SERVICE,
    purpose: options.purpose ?? TRUST_VERIFY_PURPOSE,
    traceId: options.traceId,
    enabledToolNamespaces: [...(options.enabledToolNamespaces ?? [RESEARCH_TOOL_NAMESPACE])],
    now: options.now ?? new Date().toISOString(),
  };
}
