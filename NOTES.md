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

- `src/arena/adapter.ts` exposes `handleServiceCall(payload)` for
  `trust.verify` and `handleCheckCall(payload)` for `trust.check` — plain JSON
  in, plain JSON out — plus `TRUST_VERIFY_DESCRIPTOR` and
  `TRUST_CHECK_DESCRIPTOR`, the price/IO descriptions in a neutral shape.
- `arena/service-card.yaml` carries the semantic content the brief specifies.
  The *field names* will need to be remapped to the organizers' actual schema;
  that is a file edit, not a code change.
- Nothing in `src/` depends on an unverified Arena type.

`arena/service-card.yaml` is kept in step with those descriptors by
`tests/arena.test.ts` — prices, method version, receipt fields, latency bounds
and the tool surface are asserted against the code, so the card cannot quietly
drift into promising something the service does not do.

**Open item for whoever has organizer access:** bind `handleServiceCall` and
`handleCheckCall` to the real registration/delivery mechanism and confirm the
credit prices. Everything behind those functions is complete and tested.

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
4. **No trust score anywhere, and no host-owned field in the model's schema.**
   v2 removed the scalar entirely rather than renaming it. The model's output
   is `AdjudicationSubmissionSchema` — a summary, a status per claim, and
   security indicators. It has no field for a score, a report id, an execution
   id, a timestamp, a digest, a protocol flag, or tool usage, so there is
   nothing to strip and nothing to reconcile.
5. **Model provider.** No credentials were supplied, so the driver is written
   against a `VerifierModel` port with an Anthropic implementation and a
   scripted implementation. The full test suite runs on the scripted model, so
   correctness is verifiable without a key. See README "Running for real".

## 7. Timing

The brief quotes an Arena date of "Wednesday, September 11" from the archive.
The archive is absent and that date is unverifiable here. **Confirm deadlines
against the live Devpost page and organizer Discord.** No code depends on it.

## 8. Remaining-work spec: state at handoff

Against `TrustLayer_Remaining_Work_Spec.md`, as of this commit.

**Done in code, with tests:**

| Spec item | Where |
| --- | --- |
| P1 §4 independent-support enforcement | `src/evidence/validator.ts`, `src/evidence/ledger.ts` |
| P1 §5 challenge search vs challenge retrieval | `src/verifier/protocol.ts`, `src/evidence/receipt.ts`, `src/verifier/driver.ts` |
| P1 §6 equal-resource web-agent baseline | `evals/baseline-web-agent.ts` |
| P1 §7 harness: repetitions, cost-per-catch, preserved artifacts | `evals/run.ts`, `evals/report.ts`, `evals/metrics.ts` |
| P2 §8 validated evidence excerpts | `src/evidence/validator.ts` (`verifyQuotes`) |
| P2 §9 personal-agent brief rename | `arena/PERSONAL_AGENT_BRIEF.md` |

`methodVersion` deliberately stays `trustlayer-evidence-v1`: no receipt has
been issued outside this repository, so §5 is completing the method rather than
changing one already in the field. It must be bumped if that stops being true.

**Blocked, and on what:**

- **P0 §3, Arena / SharedOS Cloud integration.** Nothing organizer-side exists
  in this environment: no Cloud instructions, no SharedNet registration schema,
  no Arena service schema, no discovery or delivery contract, no credentials
  (§1 above still holds — re-checked at this commit). Per the spec's own rule,
  no endpoint, field name, or service ID has been invented. `handleServiceCall`
  and `handleCheckCall` remain the seam; binding them should touch
  `src/arena/` and `arena/` only.
- **P1 §7, the actual benchmark run.** Needs `MODEL_API_KEY`, which is not set
  here. `pnpm eval` refuses to start without it rather than emitting numbers
  that would read as results. Everything else the run needs is built: four
  systems, matched budgets, measured usage, repetitions, and artifact writing.
- **P2 §10, live production smoke tests.** Needs a real model, a real search
  provider, and the organizer SharedOS environment.
- **P2 §9 remainder** — measured latency, confirmed credit prices, organizer
  field names, real service IDs — depends on P0 and on the benchmark run.

**Standing rule for whoever picks this up:** no public copy quotes a measured
comparison, because no comparison has been measured. The README, the service
card and the personal-agent brief all say so explicitly. Do not soften that
until `evals/results/` contains a real run.

## 9. Organizer surfaces — what was verified on 2026-09-08

§1 and §5 above were written when no organizer material had been supplied. The
public site has since been read. This section records what is now **verified**,
with the page it came from, and what remains genuinely undocumented. It does
not replace §5's rule: nothing here is invented, and the still-unknown items
stay unknown until someone with organizer access answers them.

### Verified

- **Three planes, not one.** SharedOS is the kernel *in our process*; SharedOS
  Cloud is organizer-hosted and read-only with respect to us — "The kernel
  decides here. We have no write path", "Decision events pushed by your host
  after the fact", "Nothing dials into your network — your host always
  initiates" (sharedos.ai/cloud). So **TrustLayer is deployed by us**, anywhere
  that runs Node. Cloud does not host it. Cloud is in "design partner preview".
- **Hackathon entry** (sharedos.ai/weekly-hackathon): Discord
  <https://discord.gg/cfyPXfZCe>, Devpost
  <https://shared-os-hackathon.devpost.com/register>, then request a **tenant
  ID and owner address** in `#arena-support`. Event 9–11 September 2026, Arena
  Night 11 September 21:00–23:00 ET.
- **What the submission must contain**: representative agent's SharedNet node
  ID; service name, I/O, price in credits, call instructions; **the SharedOS
  purpose string and product-agent addresses for the audit trail**; repo link.
  Ours: purpose `trust.verify`, actor `agent:trustlayer-verifier`, owner
  `service:trustlayer` until an address is issued.
- **Tenant identity maps onto `AccessContext.namespaceId`** — "namespaceId:
  tenant or benchmark world isolation boundary" (docs/host-integration). Hence
  `SHAREDOS_TENANT_ID` and `SHAREDOS_OWNER_ADDRESS` now flow into both the
  context and the grants, which must agree or the grant is a scope mismatch.
- **The HTTP boundary contract** (docs/http-api): `createSharedOSHandler`,
  `GET /health`, `POST /v1/authorize`, `GET /v1/tools`, `POST /v1/tools/invoke`,
  `POST /v1/messages`, `POST /v1/turns`; identity enters only through
  `resolveContext`, never the body; a denial is a 200 with the decision in the
  payload. Embedding is "the recommended shape for products".
- **The agent-to-agent layer is `@aicoo/local-agent`** (npm, README and the
  bundled `aicoo-c2c` skill): open protocol, local bridge, Claude Code / Codex
  adapters, control plane whose canonical production profile is
  `https://www.aicoo.io` with spool `~/.aicoo/local-agent/bridge.spool`; CLI
  `ccd` with `login`, `whoami`, `onboard`, `agents`, `connect`, `send`,
  `delegate`, `goal`, `inbox`, `offer`, `targets`. Its safety rule — "a message
  conveys intent and context, not authority" — is the same one TrustLayer runs
  on.

### Still unknown, and therefore still not invented

- Whether the Devpost "SharedNet node ID" is `ccd whoami`'s `principalId`.
- How a **paid Arena service call reaches a service**: C2C message to the
  representative agent, HTTP to a registered URL, or something else.
- **Where and in what format a service is registered** with its price.
- **How Arena credits are metered and charged**, and whether 3 / 1 credits are
  acceptable prices.
- The **decision-event push**: endpoint, auth, payload.
- Any deployment requirement (public reachability, allowlist, health probe).

`arena/DEPLOYMENT.md` carries these as a numbered list to paste into
`#arena-support`. SharedNet's own documentation is explicitly "not documented
publicly yet" (sharedos.ai/full-picture).

### What was built against the verified part

- `src/api/http.ts` + `src/server.ts`: the callable surface — `/health`,
  `/v1/services`, `POST /v1/trust.verify`, `POST /v1/trust.check` — with bearer
  auth, JSON in and an evidence receipt out. `pnpm serve:check` drives the real
  server over HTTP offline.
- A `Dockerfile`, because the service is one stateless process and deploying it
  should not need a decision.
- The SharedOS HTTP boundary is deliberately **not** mounted: `/v1/turns` and
  `/v1/tools/invoke` run under our resolved context, so exposing them would
  lend a caller the verifier's `research.fetch` capability. If the organizers
  require it, mount `createSharedOSHandler` behind its own context and grants,
  never the verifier's.
