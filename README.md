# TrustLayer

**Independent evidence receipts for agent claims, built on
[SharedOS](https://github.com/Aicoo-Team/SharedOS).**

> Don't take an agent's word for it. Get the evidence.

An agent receives factual work from another agent or service and sends it to
TrustLayer before acting on it. TrustLayer picks the claims that matter,
searches for sources, **fetches** them, looks for evidence that would
contradict them, and returns an **Evidence Receipt**: which claims hold, which
are contradicted, which could not be established, and every source actually
retrieved — with resolved URLs, retrieval timestamps, content digests, and the
SharedOS execution that produced them.

There is no trust score. A single number reads as "this answer is 87% likely to
be true", which is the one thing evidence retrieval cannot establish. What the
receipt carries instead is inspectable: claim statuses, coverage, which
protocol phases really ran, and the evidence itself.

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
pnpm smoke            # one real trust.verify turn, the receipt, and the SharedOS audit trail
pnpm demo:injection   # the security demo (see below)
```

## The services

| | `trust.verify` | `trust.check` |
| --- | --- | --- |
| **Price** | 3 Arena credits | 1 Arena credit |
| **Scope** | up to 3 consequential claims (hard max 5) | one named claim |
| **Input** | `task`, `candidate_output`, optional `focus_claims`, `source_urls`, `freshness`, `max_claims` | `task`, `candidate_output`, `focus_claims` |
| **Output** | an Evidence Receipt | the same Evidence Receipt |
| **Latency** | typically ~60s, hard-bounded at 90s | typically ~25s, bounded at 45s |

Both are the same engine and the same protocol; `trust.check` is cheaper
because naming the claim removes the extraction round-trip, not because it
checks less carefully. Full description:
[`arena/service-card.yaml`](arena/service-card.yaml). Selling guidance:
[`arena/representative-agent.md`](arena/representative-agent.md).

```ts
import { handleServiceCall } from "trustlayer";

const outcome = await handleServiceCall({
  task: "How much does Widget X cost?",
  candidate_output: "Widget X costs $79.",
  source_urls: ["https://vendor.example/widget-x"],
});
// -> { ok: true, receipt: { overallStatus: "supported", protocolStatus: "complete", ... } }
```

## The protocol

```
PLAN -> DISCOVER -> FETCH -> CHALLENGE -> ADJUDICATE -> VALIDATE -> RECEIPT
```

| Phase | What happens | Who owns it |
| --- | --- | --- |
| PLAN | up to 3 claims selected, or taken verbatim from `focusClaims` | host assigns IDs; model proposes text |
| DISCOVER | `research.search` returns **candidates**, never evidence | model chooses queries |
| FETCH | `research.fetch` retrieves a page and mints an `EvidenceRecord` | trusted tool code |
| CHALLENGE | a second search aimed at refuting the claim, not confirming it | model, observed by the host |
| ADJUDICATE | one status per claim, citing evidence IDs | model |
| VALIDATE | every citation looked up in the ledger | host |
| RECEIPT | assembled from validated state and the execution record | host |

**A snippet is a reason to fetch a page, not a reason to believe one.** Search
results live in their own ID space, are labelled as not-evidence in the tool
description and in every payload, and cannot back a claim. A run that only
searched reports `checks.sourcesFetched: false`,
`protocolStatus: "partial"`, and downgrades the snippet-backed claim.

## Architecture

```
                    SharedNet / Arena
                           |
                           | paid service invocation
                           v
             src/arena/adapter.ts   handleServiceCall() / handleCheckCall()
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
     |   StandardRuntime -> verifier driver -> model     |
     |                                                   |
     |   effective catalogue: research.search            |
     |                        research.fetch             |
     +--------------------------------------------------+
                           |
                           v
        evidence ledger  +  the model's adjudication
                           |
                           v
        host-side: citation validation against the ledger,
        protocol-completion accounting, coverage, and
        provenance read off the real ExecutionResult
                           |
                           v
                    EvidenceReceipt
```

### What the host owns, and what the model owns

The model produces exactly this: which claims to check, which searches to run,
which pages to fetch, one status per claim with a rationale and cited evidence
IDs, and a prose summary. It has no field for a report ID, a timestamp, a
digest, a protocol flag, a tool list, or an execution ID — those do not exist
in its output schema, so there is nowhere to fabricate them.

Everything the receipt presents as fact is produced elsewhere:

- **The evidence ledger** is the sole writer of evidence identity, resolved
  URLs, domains, retrieval timestamps, SHA-256 digests of the exact quarantined
  text the verifier read, and the originating SharedOS tool call ID. It also
  records whether a fetch was of a caller-supplied citation or an
  independently discovered source, so a candidate's own source can never be
  presented as independent verification.
- **Citations are validated** against that ledger. Invented IDs are discarded;
  a `supported` or `contradicted` claim with no surviving citation of the right
  relation is downgraded to `unverified` — never to `contradicted`, because
  missing evidence is not disproof. Validation iterates the *plan*, so a claim
  the model quietly dropped shows up as a coverage gap instead of vanishing.
- **Protocol completion is observed, not asserted.**
  `contradictionSearchPerformed` is true only when a search tool call really
  succeeded while the challenge phase was current. A test scripts a model whose
  summary claims an exhaustive contradiction search after skipping it; the
  receipt still reports `false`.
- **Provenance** is read off the SharedOS `ExecutionResult` and its event
  stream, and the service inspects `result.status` rather than assuming an
  absent exception means success.

### The receipt

```jsonc
{
  "reportId": "rpt_…",
  "methodVersion": "trustlayer-evidence-v1",
  "protocolStatus": "complete",          // complete | partial | failed
  "overallStatus": "supported",          // supported | mixed | contradicted | unverified
  "summary": "…",                        // the model's prose, and nothing else from it
  "claims": [{
    "claimId": "k1", "claim": "Widget X costs $79.",
    "importance": "critical", "status": "supported", "confidence": 0.9,
    "rationale": "…",
    "evidence": [{ "evidenceId": "e1", "relation": "supports", "note": "…" }]
    // "adjusted": present whenever the host changed the model's status
  }],
  "evidence": [{
    "evidenceId": "e1",
    "url": "https://vendor.example/widget-x",
    "resolvedUrl": "https://vendor.example/widget-x/",
    "domain": "vendor.example",
    "retrievedAt": "2026-09-07T21:17:00.041Z",
    "contentSha256": "…",
    "origin": "independent"              // independent | candidate_citation
  }],
  "coverage": { "claimsSelected": 1, "claimsChecked": 1, "criticalClaimsTotal": 1,
                "criticalClaimsChecked": 1, "searchCandidates": 4,
                "sourcesFetched": 1, "distinctDomains": 1 },
  "checks":   { "independentSearchPerformed": true, "sourcesFetched": true,
                "candidateCitationsChecked": true, "contradictionSearchPerformed": true,
                "evidenceReferencesValidated": true },
  "security": { "suspiciousInstructionsDetected": false, "indicators": [] },
  "provenance": { "purpose": "trust.verify", "executionId": "…", "traceId": "…",
                  "sharedosStatus": "succeeded",
                  "toolsUsed": ["research.search", "research.fetch"],
                  "startedAt": "…", "completedAt": "…", "durationMs": 74 }
}
```

`methodVersion` names the verification procedure, not the package release. It
changes only when verification semantics materially change.

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

**The prompt-injection story.** The fixture asks the verifier to read
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

**Evidence quarantine.** Everything fetched is untrusted. Before the verifier
sees a page it passes through `src/security/evidence-quarantine.ts`: scripts
and styles removed rather than escaped, HTML reduced to bounded plain text,
size capped, and instruction-shaped content flagged into the receipt. Retrieved
content is evidence, never authority — the flag is a supporting signal, and the
capability boundary is the guarantee.

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
immediately before invocation. A URL the policy refuses throws there, and the
kernel refuses the call as `tool_requirement_resolution_failed` before the tool
body runs.

## Tests

```
pnpm test        # 177 tests
pnpm typecheck
```

| File | Covers |
| --- | --- |
| `integration.test.ts` | end-to-end receipt, provenance derivation, denial and model-failure handling |
| `verification-behaviour.test.ts` | supported / contradicted / unverified / mixed / not-falsifiable, stale facts, conflicting sources, focus claims |
| `evidence-ledger.test.ts` | candidates are not evidence, host-minted provenance, candidate-citation origin, per-execution isolation |
| `receipt-validator.test.ts` | fabricated IDs discarded, downgrades, wrong-relation citations, unadjudicated claims |
| `citation-validation.test.ts` | caller-supplied sources fetched and labelled, dead citations, `candidateCitationsChecked` |
| `protocol.test.ts` | phase accounting, `protocolStatus`, `overallStatus`, checks that a model's summary cannot influence |
| `permissions.test.ts` | the three gates; forbidden tools refused; missing execution grant; wrong purpose; exact fetch authorization |
| `research-tools.test.ts` | search-vs-fetch boundary, redirect revalidation, sanitization, dead URLs, headers |
| `url-policy.test.ts` | SSRF: schemes, credentials, every private range, metadata, IPv4-in-IPv6, DNS rebinding |
| `injection.test.ts` | quarantine behaviour, injection from candidate output and from a fetched page |
| `arena.test.ts` | both service entry points, payload aliasing, error shape, descriptors advertise no trust score |
| `evals.test.ts` | the benchmark corpus, world, and metrics — including that degenerate strategies score badly |

The suite is hermetic: the model is scripted and DNS and `fetch` are injected,
so no test touches the network. That is also what lets the tests script a model
that *misbehaves* — citing a source that was never returned, claiming a
contradiction search it skipped, or reaching for a tool it was never granted —
which a real model cannot be relied on to do on command.

## Benchmark

The obvious alternative to TrustLayer is "ask another model to double-check the
answer", so [`evals/`](evals) implements that baseline fairly rather than as a
straw man: same case, same claim, and a `+search` mode given the identical
discovery snippets TrustLayer saw.

```bash
pnpm eval             # every case against TrustLayer and both baselines
pnpm eval --selftest  # exercise the harness with stub models — NOT a benchmark
pnpm eval --case stale-price
```

16 seeded cases carry known ground truth across the classes the requirements
list — correct facts, subtle and numeric errors, stale information, fabricated
citations, citation/source mismatch, unsupported claims, partial truths,
conflicting sources, dead citations, prompt injection, and non-falsifiable
claims — served from a closed per-case web both systems share. Metrics track
material-error detection and false-contradiction rate separately, so answering
`unverified` or `contradicted` to everything scores badly; tests assert both
degenerate strategies fail.

**No benchmark has been run.** `pnpm eval` refuses to start without
`MODEL_API_KEY` rather than emitting numbers that would look like results, and
`--selftest` labels its output as not a benchmark.

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
Turn bounds (8 steps, 8 tool calls, 90s) and research limits (6 results, 8s
fetch timeout, 1 MiB, 3 redirects, 20 000 characters of extracted text) are
configurable there too.

Provider-native web browsing is deliberately not enabled: it would fetch
outside the SharedOS tool boundary, so none of it would reach the audit trail
or the evidence ledger.

## Project status

The verifier is complete and tested end to end against the real SharedOS
kernel. **The Arena binding is not**, because the SharedOS SDK contains no
Arena or SharedNet surface and no organizer material was supplied to this
repository. `handleServiceCall()` and `handleCheckCall()` are plain JSON in,
plain JSON out, and `arena/service-card.yaml` holds the semantic content in
neutral field names; binding both to the organizers' real mechanism should
touch those two files only. No live benchmark has been run, for want of model
credentials.

[`NOTES.md`](NOTES.md) records everything verified against the SDK — exact
contract shapes, the event vocabulary, the version pin and why — plus every
deviation from the implementation brief and the reason for it. Read it before
changing the SharedOS layer.

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
    audit.ts               tools used and refusals, from the execution record
  verifier/
    protocol.ts            the phase state machine and what it observed
    driver.ts              model loop <-> SharedOS turn protocol
    planner.ts             claim selection, focusClaims, host-assigned IDs
    prompts.ts             system prompt, instructions, submission schemas
    model.ts               VerifierModel port: Anthropic + scripted
  evidence/
    schemas.ts             request, plan, adjudication, and receipt contracts
    ledger.ts              per-execution evidence ledger + registry
    validator.ts           citation validation and downgrades
    receipt.ts             coverage, checks, statuses, the receipt itself
    digest.ts              SHA-256 and identifier minting
  tools/
    research-search.ts     discovery only; mints candidates
    research-fetch.ts      resolveRequirement + fetch hardening; mints evidence
    url-policy.ts          the SSRF policy
    search-backend.ts      Brave / Tavily / static / unavailable
  security/
    evidence-quarantine.ts HTML -> bounded text, instruction detection
  config.ts                environment, limits, secrets

tests/                     the suite above
evals/                     cases, closed world, baseline, metrics, runner
arena/                     service cards and the representative-agent brief
scripts/                   smoke and injection demos
```

## License

Unlicensed hackathon project.
