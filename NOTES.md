# NOTES.md — Verified SharedOS facts and deviations from the implementation brief

Everything here was verified against the real SDK (`@aicoo/sharedos@0.1.0-alpha.4`,
inspected at runtime and from source at <https://github.com/Aicoo-Team/SharedOS>).
Where this file and the brief disagree, **this file is right** — the brief was
written ahead of inspection and explicitly says to defer to the installed
contracts.

## 1. What was NOT found in this environment

The brief's §1/§31 assume organizer-provided material. None of it is present:

| Expected | Status |
| --- | --- |
| `962776136bbdeab07ee5ab402914aa47994ca233.webarchive` | **Absent.** Searched the whole filesystem. |
| Organizer starter repository | **Absent.** Repo contained only a one-line `README.md`. |
| SharedOS Cloud / Arena credentials | **Absent.** No `SHAREDOS_*` or `ARENA_*` env vars. |
| Model / search provider credentials | **Absent.** No `MODEL_API_KEY`, `SEARCH_API_KEY`. |

Consequences are handled in §5 below rather than by inventing APIs.

## 2. Package and version pin

- Meta-package `@aicoo/sharedos` re-exports `-contracts`, `-core`, `-http`,
  `-os`, `-runtime`, and `SharedOSClient` from `-client`.
- npm dist-tags: `latest` = `0.1.0-alpha.2`, `next` = `0.1.0-alpha.4`.
  Repo `main` is `0.1.0-alpha.4`.
- **Pinned to `0.1.0-alpha.4` exactly** (no `^`), including
  `@aicoo/sharedos-testkit@0.1.0-alpha.4`, so the SDK and the testkit cannot
  skew. `latest` would have pinned an *older* build than the repo's `main`.
- Requires Node `>=20.11`, ESM-only, Zod `^3.24.1` (Zod 3, not 4).

## 3. Verified contract shapes

These are the real field names. The brief's pseudo-schemas were close but not
exact; the code follows these.

```
AccessContext   { namespaceId, actor, authority, owner, purpose, traceId,
                  enabledToolNamespaces: string[], now }
ResourceRef     { namespace, path: string[], owner? }
Capability      { resource: ResourceRef, actions: string[], scope: "exact" | "descendants" }
CapabilityGrant { id, namespaceId, subject, issuer, capabilities: Capability[],
                  constraints, issuedAt, revokedAt?, parentGrantId?, metadata? }
CapabilityConstraints { purposes?, notBefore?, expiresAt?, maxUses?, delegationDepth? }
Address         = { kind:"human", userId } | { kind:"agent", agentId }
                | { kind:"group", conversationId } | { kind:"service", serviceId }
ExecutionRequest{ version:"1", executionId, agent, context, message, tools,
                  state?, options?: { maxSteps?, maxToolCalls?, timeoutMs? }, metadata? }
ExecutionResult = { version, executionId, traceId, events[], startedAt, completedAt,
                    metadata?, status:"succeeded", output }
                | { ..., status:"denied"|"failed"|"cancelled", error: ProtocolError }
                | { ..., status:"escalated", escalation }
ExecutionEvent  { version:"1", eventId, executionId, traceId, sequence, type, data, occurredAt }
ToolDefinition  { name, description, namespace, source, readWrite:"read"|"write",
                  inputSchema, outputSchema?, requiredCapability:{resource,action},
                  annotations?, metadata? }
ToolResult      { callId, tool, completedAt, metadata? } & (succeeded|denied|failed)
```

Notes that mattered while coding:

- `Capability.actions` is an **array**, and the literal `"*"` is the only
  wildcard action.
- `ToolDefinition.requiredCapability.action` is **singular**, while
  `Capability.actions` is plural. They are different types.
- `AccessContext.enabledToolNamespaces` is the second gate and is **off by
  default** — a namespace absent from this list yields no tools even with a
  matching grant.
- Grants carry `namespaceId` and it must equal the context's `namespaceId`, or
  the grant is rejected with scope mismatch `namespace`.

## 4. Verified execution/audit vocabulary

Event `type` values actually emitted (extracted from the runtime and core
builds), which is what the `audit` block in our response is derived from:

```
turn.started, authority.resolved, tool.catalog.listed, tool.requested,
tool.invoked, tool.completed, runtime.event, escalation.asked,
escalation.requested, turn.completed, turn.denied, turn.failed,
turn.cancelled, turn.escalated, turn.ended
```

Authorization reason codes: `allowed`, `invalid_context`, `invalid_request`,
`no_matching_grant`, `grant_exhausted`, `delegation_chain_invalid`,
`authority_unavailable`, `delegation_chain_unverified`,
`usage_store_unavailable`, `host_policy_denied`, `host_policy_unavailable`.
Tool-level refusals include `tool_unavailable`, `permission_denied`,
`tool_execution_failed`, `tool_requirement_resolution_failed`,
`tool_call_limit_exceeded`.

**`turn.completed` is emitted even when the model's work was useless**, so the
service inspects `result.status` rather than assuming success — as the brief's
§19 step 6 requires.

## 5. The Arena boundary — deliberately not invented

`grep -ri "arena|sharednet|hackathon"` over the entire SharedOS repo (docs,
packages, examples, ADRs) returns **nothing**. The Arena, SharedNet service
registration, Arena-credit pricing, and "SharedOS Cloud" are organizer-side
surfaces that are not part of the published SDK, and no organizer material was
supplied to this environment.

Per brief rule 1 ("do not invent SharedOS Cloud APIs, Arena APIs,
service-registration formats, or grant fields") the Arena integration is
therefore built as a **thin, documented boundary** rather than a guess:

- `src/arena/adapter.ts` exposes `handleServiceCall(payload)` — plain JSON in,
  plain JSON out — plus `TRUST_VERIFY_DESCRIPTOR`, the price/IO description in
  a neutral shape.
- `arena/service-card.yaml` carries the semantic content the brief specifies.
  The *field names* will need to be remapped to the organizers' actual schema;
  that is a file edit, not a code change.
- Nothing in `src/` depends on an unverified Arena type.

**Open item for whoever has organizer access:** bind `handleServiceCall` to the
real registration/delivery mechanism and confirm the credit price. Everything
behind that function is complete and tested.

## 6. Deviations from the brief, with reasons

1. **Embedded integration, not the HTTP boundary.** `docs/host-integration.md`
   recommends embedded for products, and the brief's §5 agrees. `SharedOSExecutor`
   runs in-process against our own kernel. `createSharedOSHandler` is available
   if the organizers require the remote boundary; see §5 above.
2. **Our own `GrantSource`/kernel wiring instead of `createTestKernel`.**
   The testkit is a dev dependency used only by tests. Production authority
   comes from `src/sharedos/grants.ts` through a real `GrantSource`, because a
   product must own its trusted grant store.
3. **`research` namespace path shape.** `research.search` is authorized against
   `{ namespace: "research", path: ["web"], action: "search" }` with a static
   requirement (the query is not a resource selector). `research.fetch`
   declares a discovery ceiling of `{ path: ["web"], scope: "descendants" }`
   and implements `resolveRequirement` to re-derive
   `{ path: ["web", <validated hostname>], action: "fetch" }` per call. This is
   the pattern `docs/tools.md` prescribes; omitting it is called out there as
   "a scope hole for anything that [takes a resource argument]".
4. **Trust score excluded from the model's output schema entirely**, per §12.
   The model cannot emit a score, an audit id, or tool usage — those fields do
   not exist in `VerifierJudgmentSchema`, so there is nothing to strip.
5. **Model provider.** No credentials were supplied, so the driver is written
   against a `VerifierModel` port with an Anthropic implementation and a
   scripted implementation. The full test suite runs on the scripted model, so
   correctness is verifiable without a key. See README "Running for real".

## 7. Timing

The brief quotes an Arena date of "Wednesday, September 11" from the archive.
The archive is absent and that date is unverifiable here. **Confirm deadlines
against the live Devpost page and organizer Discord.** No code depends on it.
