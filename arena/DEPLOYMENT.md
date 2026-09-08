# Deploying TrustLayer and connecting it to the Arena

Everything below marked **verified** was read from the SharedOS site or the
published packages on 2026-09-08, with the source named. Everything marked
**unknown** is genuinely undocumented publicly — ask in the hackathon Discord
rather than guessing, and write the answer into `NOTES.md` when you have it.

---

## 1. The three planes, and which one does what

There are three separate things, and conflating them is the main way to waste a
day:

| Plane | What it is | Where it lives |
| --- | --- | --- |
| **SharedOS** | the capability kernel — grants, tools, turns, audit | in *your* process (`@aicoo/sharedos`) |
| **SharedOS Cloud** | tenant identity and the decision/audit record | organizer-hosted; your host pushes to it |
| **SharedNet / Aicoo** | agent-to-agent identity, routing, messaging | organizer-hosted (`https://www.aicoo.io`) |

**Verified** (sharedos.ai/cloud): Cloud is read-only with respect to your
system — *"The kernel decides here. We have no write path."*, *"Decision events
— pushed by your host after the fact"*, *"Nothing dials into your network —
your host always initiates"*, and credentials *"never leave your
infrastructure"*. So TrustLayer is deployed by **you**, anywhere that runs
Node; Cloud does not host it. Cloud is in *"design partner preview"*.

---

## 2. Entry steps (verified — sharedos.ai/weekly-hackathon)

1. **Join the Discord** — <https://discord.gg/cfyPXfZCe>. Required by the rules;
   event operations happen there.
2. **Register on Devpost** — <https://shared-os-hackathon.devpost.com/register>.
3. **Get Cloud access** — request a **tenant ID** and an **owner address** in
   `#arena-support`, then follow the quickstart.

Event: **September 9–11 2026**, Arena Night **September 11, 9–11 PM ET**.
Support: `#arena-support`, `coo@aicoo.io`.

### What the Devpost submission must contain (verified)

- project name, tagline, description, services offered;
- **your representative agent's SharedNet node ID**;
- service name, input/output, **price in Arena credits**, and call instructions;
- **the SharedOS purpose string and product-agent addresses for the audit trail**;
- repository link and the team lead's Discord username;
- optional demo video (≤2 min).

TrustLayer's answers to the last two are fixed and already true of the code:

```
purpose string:        trust.verify
product-agent address: agent:trustlayer-verifier   (actor)
owner/issuer address:  service:trustlayer          (until the organizers issue one)
services:              trust.verify (3 credits), trust.check (1 credit)
```

---

## 3. Deploying the service

TrustLayer is one stateless Node process. No database, no volume, no queue.

```bash
pnpm install
pnpm start           # listens on $PORT (default 8080)
```

or the image:

```bash
docker build -t trustlayer .
docker run -p 8080:8080 --env-file .env trustlayer
```

Any Node host works — Fly, Railway, Render, a VM. The service does no TLS
termination, no CORS and no rate limiting: those belong to the deployment edge,
which is what the SharedOS HTTP docs prescribe.

### Environment

| Variable | Meaning |
| --- | --- |
| `SHAREDOS_TENANT_ID` | the organizers' tenant id → `AccessContext.namespaceId` **and** every grant's `namespaceId` |
| `SHAREDOS_OWNER_ADDRESS` | the organizers' owner address → owner/issuer, as `service:<id>`, `agent:<id>`, `human:<userId>` or `group:<conversationId>` |
| `TRUSTLAYER_API_TOKEN` | bearer token callers must present. Unset = unauthenticated |
| `MODEL_PROVIDER`, `MODEL_NAME`, `MODEL_API_KEY` | the verifier's model |
| `SEARCH_PROVIDER`, `SEARCH_API_KEY` | `brave` or `tavily`, for real `research.search` |
| `PORT`, `HOST` | listener |

The tenant id and owner address must be the ones the organizers issue: a grant
whose `namespaceId` differs from the context's is rejected as a scope mismatch,
which is the failure you will see if they drift apart.

### The callable surface

```
GET  /health              liveness, method version, tenant, service names
GET  /v1/services         the descriptors: name, price, input, output, guarantees
POST /v1/trust.verify     task + candidate_output (+ focus_claims, source_urls) -> receipt
POST /v1/trust.check      one claim -> the same receipt
```

```bash
curl -s "$BASE/v1/trust.verify" \
  -H "authorization: Bearer $TRUSTLAYER_API_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"task":"How much does Widget X cost?",
       "candidate_output":"Widget X costs $79.",
       "source_urls":["https://vendor.example/widget-x"]}'
```

`pnpm serve:check` boots the real server and drives it over HTTP with a
scripted model, offline — proof the deployable path works without a key.

**The SharedOS HTTP boundary (`/v1/turns`, `/v1/tools/invoke`) is deliberately
not mounted.** Those run against our kernel under our resolved context, so
exposing them would hand any caller holding the token our `research.fetch`
capability — a fetch proxy with our egress and our budget. The whole product is
a least-privilege argument; opening that door to sell it would be
self-defeating. A caller who wants the execution record gets it in the
receipt's `provenance`, derived from the real turn. If the organizers require
the raw boundary, mount `createSharedOSHandler` behind its own context and
grants — not the verifier's.

---

## 4. The representative agent (SharedNet node)

**Verified** (sharedos.ai/weekly-hackathon): *"Bring the agent you already work
with"*, *"Do not build a special event bot"*, one SharedNet node ID per team.

**Verified** (`@aicoo/local-agent` on npm, README + `skills/codex/aicoo-c2c`):
this is the agent-to-agent layer — an open protocol, a local bridge, and
runtime adapters for Claude Code and Codex, talking to a control plane whose
canonical production profile is `https://www.aicoo.io` with the spool at
`~/.aicoo/local-agent/bridge.spool`. Its model is *"a message conveys intent
and context, not authority"*, which is the same rule TrustLayer runs on.

```bash
npm i -g @aicoo/local-agent@latest
ccd login                 # against the production control plane
ccd whoami                # your principal id
ccd onboard               # register this machine's bridge + sessions
ccd agents --json         # discovery: who else is reachable
ccd connect request --to <principalId>    # ask for a communication grant
ccd send --comm-session <id> --text "..." # message another agent
```

**Unknown:** whether the `principalId` from `ccd whoami` *is* the "SharedNet
node ID" the Devpost form asks for, and whether an Arena service call arrives
as a C2C message to this agent or through some other channel. Ask before
Arena Night — it decides how the service actually gets invoked.

---

## 5. What to ask in `#arena-support`

Copy this list; the answers unblock everything that is still stubbed.

1. Our **tenant ID** and **owner address** for SharedOS Cloud, and whether the
   owner address should be a `service:` or `agent:` address.
2. Is the **SharedNet node ID** on the Devpost form the `principalId` from
   `ccd whoami`, or something issued separately?
3. **How does a paid service call reach us?** A C2C message to our
   representative agent, an HTTP call to a URL we register, or something else?
   If HTTP: what does the request body look like, and what authentication do
   callers present?
4. **Where do we register the service** (name, price, input/output), and in
   what format? Is there a manifest, a form, or a Discord post?
5. **How are Arena credits charged and reported** — do we meter anything, or is
   it counted organizer-side? Are 3 credits (`trust.verify`) and 1 credit
   (`trust.check`) acceptable prices?
6. **Where do decision events go?** Cloud is described as receiving them pushed
   by our host after the fact — what endpoint, what auth, what payload?
7. Any **deployment requirement** we are missing: must the service be publicly
   reachable, is there an allowlist, is there a required health endpoint?

Write every answer into `NOTES.md` with the date and who said it. Until then:
no endpoint, field name, price or service ID in this repository is invented —
which is why several of them are still blank.
