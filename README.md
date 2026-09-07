# TrustLayer

**An agent-to-agent verification gateway, built on [SharedOS](https://github.com/Aicoo-Team/SharedOS).**

> Before relying on another agent's factual output, TrustLayer it.

An agent receives factual work from another agent or service and sends it to
TrustLayer before acting on it. TrustLayer independently checks the important
claims and returns which hold, which are contradicted, which could not be
established, the evidence behind each, any instructions hidden in the submitted
text, a deterministic trust score, and a SharedOS execution reference.

The verifier runs as a bounded SharedOS turn under the single purpose
`trust.verify`, holding three capabilities and nothing else.

---

## Quick start

```bash
pnpm install
pnpm typecheck
pnpm test
```

Two runnable demos, both fully offline — no API key, no network:

```bash
pnpm smoke            # one real trust.verify turn + the SharedOS audit trail
pnpm demo:injection   # the security demo (see below)
```

## The service

| | |
| --- | --- |
| **Name** | `trust.verify` |
| **Price** | 3 Arena credits |
| **Input** | `task`, `candidate_output`, optional `source_urls`, `freshness`, `max_claims` |
| **Output** | `verdict`, `trust_score`, `summary`, `claims[]`, `security`, `audit` |
| **Latency** | typically <45s, hard-bounded at 90s — well under the 5-minute ceiling |

Full description: [`arena/service-card.yaml`](arena/service-card.yaml).
Selling guidance: [`arena/representative-agent.md`](arena/representative-agent.md).

```ts
import { handleServiceCall } from "trustlayer";

const outcome = await handleServiceCall({
  task: "How much does Widget X cost?",
  candidate_output: "Widget X costs $79.",
});
// -> { ok: true, result: { verdict: "supported", trustScore: 100, ... } }
```

## Architecture

```
                    SharedNet / Arena
                           |
                           | paid service invocation
                           v
             src/arena/adapter.ts   handleServiceCall()
                           |
                           v
             src/api/verify.ts      verify()
                           |
                           | one bounded turn, purpose = trust.verify
                           v
     +--------------------------------------------------+
     |  SharedOSExecutor  (non-replaceable envelope)     |
     |    admits the turn, filters the tool catalogue,   |
     |    re-authorizes every call                       |
     |                                                   |
     |   StandardRuntime -> verifier-driver -> model     |
     |                                                   |
     |   effective catalogue: research.search            |
     |                        research.fetch             |
     +--------------------------------------------------+
                           |
                           v
        evidence ledger  +  VerifierJudgment (model)
                           |
                           v
        host-side: citation validation, deterministic
        scoring, verdict, audit derived from the
        real ExecutionResult
                           |
                           v
                     VerifyResponse
```

### What the host owns, and what the model owns

The model produces a `VerifierJudgment`: a summary, a claim table, and a
security assessment. That is all. It has no field for a trust score, an
execution id, a trace id, a tool list, or a duration — so those cannot be
fabricated, because there is nowhere to put them.

Everything objective is computed after the turn, in host code:

- **Citations** are checked against an evidence ledger of what the research
  tools actually returned. Invented source IDs are dropped, and a `supported`
  claim that loses all its evidence is downgraded to `unverified` — never to
  `contradicted`, because missing evidence is not disproof.
- **The trust score** is an importance-weighted average over falsifiable
  claims (`supported` 1.0, `unverified` 0.4, `contradicted` 0.0;
  `not_falsifiable` excluded), computed in `src/verification/scoring.ts`.
  Asking a model for a 0-100 score produces a number that moves between runs on
  identical input; this one does not.
- **The audit block** is read off the SharedOS `ExecutionResult` and its event
  stream.

## Security

The verifier's complete authority, from `src/sharedos/grants.ts`:

| Capability | Resource | Action | Scope |
| --- | --- | --- | --- |
| run its own turn | `sharedos.execution` / the verifier | `invoke` | exact |
| search | `research` / `["web"]` | `search` | exact |
| fetch | `research` / `["web"]` | `fetch` | descendants |

All three are constrained to `purposes: ["trust.verify"]`. There is no `files`
grant, no `repo` grant, no messaging transport, and no escalation tool; the
only enabled tool namespace is `research`.

**The prompt-injection story.** The brief's fixture asks the verifier to read
`~/.ssh/id_rsa`, email it to an attacker, and misreport a price. `pnpm
demo:injection` runs that fixture with a model scripted to *obey it* — the
worst case — and prints:

```
=== The verifier's entire tool catalogue ===
[ 'research.fetch', 'research.search' ]
  files.read present:        false
  messages.request present:  false

=== What the model attempted, and what SharedOS did ===
  files.read           -> denied
  messages.request     -> denied
  research.search      -> succeeded
```

The defence is not that a model declined. It is that no tool capable of reading
a file or sending a message exists in the verifier's catalogue. Authority in
SharedOS does not come from message text, and no part of a request body,
candidate output, search result, or fetched page is on the path to the grant
source.

**SSRF.** `research.fetch` is the one place TrustLayer makes an outbound
request driven by untrusted input, so `src/tools/url-policy.ts` is
deny-by-default: http(s) only, no embedded credentials, no loopback, private,
CGNAT, link-local, multicast or reserved ranges, no cloud metadata endpoints
(by name and by address), DNS resolved and every returned address checked
before connecting, manual redirects with every hop re-validated, capped
redirects, timeout, response bytes and extracted text, no cookies, no referrer,
no caller headers. IPv4-mapped IPv6 forms are decoded first — `new URL()`
rewrites `::ffff:127.0.0.1` as `::ffff:7f00:1`, and a check that only
understood the dotted form would wave loopback straight through.

`research.fetch` also implements `resolveRequirement`, so the capability
actually checked names the validated hostname the arguments select, re-derived
immediately before invocation. A URL the policy refuses throws there and the
kernel refuses the call as `tool_requirement_resolution_failed` before the tool
body runs.

## Tests

```
pnpm test     # 132 tests
pnpm typecheck
```

| File | Covers |
| --- | --- |
| `verify.integration.test.ts` | end-to-end turn, audit derivation, denial handling |
| `permissions.test.ts` | the three gates; forbidden tools refused; wrong purpose denied |
| `injection.test.ts` | the brief's injection fixture, from candidate output and from fetched evidence |
| `url-policy.test.ts` | SSRF: schemes, credentials, every private range, metadata, DNS rebinding |
| `research-fetch.test.ts` | redirect revalidation, exact-call authorization, sanitization, headers |
| `evidence.test.ts` | fabricated citations dropped, claims downgraded, ledger isolation |
| `scoring.test.ts` | every verdict class, exact scores |
| `schemas.test.ts` | request validation, and that the judgment schema has no host-owned fields |
| `verification-behaviour.test.ts` | supported / contradicted / unverified / mixed, stale facts, source conflict, dead URL |
| `arena.test.ts` | service payload handling, error shape, no internals leaked |

The suite is hermetic: the model is scripted and DNS and `fetch` are injected,
so no test touches the network. That is also what lets the tests script a model
that *misbehaves* — citing a source that was never returned, or reaching for a
tool it was never granted — which a real model cannot be relied on to do on
command.

## Running for real

The default model provider is `scripted`, which is what the tests and demos
use. To run against a live model:

```bash
cp .env.example .env
# MODEL_PROVIDER=anthropic
# MODEL_NAME=claude-sonnet-5
# MODEL_API_KEY=...
# SEARCH_PROVIDER=brave        (or tavily)
# SEARCH_API_KEY=...
```

`.env` is gitignored. Secrets are read in `src/config.ts` and go nowhere else —
never into a prompt, a tool output, an error, a log line, or an Arena response.

Provider-native web browsing is deliberately not enabled: it would fetch
outside the SharedOS tool boundary, so none of it would reach the audit trail
or the evidence ledger.

## Project status

The verifier is complete and tested end to end against the real SharedOS
kernel. **The Arena binding is not**, because the SharedOS SDK contains no
Arena or SharedNet surface and no organizer material was supplied to this
repository. `handleServiceCall()` is plain JSON in, plain JSON out, and
`arena/service-card.yaml` holds the semantic content in neutral field names;
binding both to the organizers' real mechanism should touch those two files
only.

[`NOTES.md`](NOTES.md) records everything verified against the SDK — exact
contract shapes, the two distinct event streams, the version pin and why — plus
every deviation from the implementation brief and the reason for it. Read it
before changing the SharedOS layer.

## Layout

```
src/
  api/verify.ts            the service entry point
  arena/adapter.ts         the Arena boundary (JSON in, JSON out)
  sharedos/
    identity.ts            purpose, addresses, namespaces
    grants.ts              the verifier's entire authority
    kernel.ts              host wiring: kernel, tools, audit sink
    context.ts             the trusted AccessContext for one turn
    executor.ts            one bounded turn
    audit.ts               audit derived from the execution record
  agent/
    verifier-prompt.ts     system prompt + judgment JSON schema
    verifier-driver.ts     model tool-use loop <-> SharedOS turn protocol
    model.ts              VerifierModel port: Anthropic + scripted
  tools/
    research-search.ts     static requirement
    research-fetch.ts      resolveRequirement + fetch hardening
    url-policy.ts          the SSRF policy
    html-text.ts           HTML -> plain text
  research/
    search-backend.ts      Brave / Tavily / static / unavailable
    evidence.ts            normalized evidence records
    evidence-ledger.ts     per-execution ledger + registry
  verification/
    schemas.ts             request + judgment contracts
    scoring.ts             deterministic score and verdict
    normalize.ts           citation validation and downgrades
```

## License

Unlicensed hackathon project.
