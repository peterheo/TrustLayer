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
| **SharedNet** | agent identity, Rooms, messages — where the Arena happens | organizer-hosted (`https://www.sharednet.ai`) |
| *(Aicoo local-agent)* | a separate DM path to a live local coding agent | organizer-hosted (`https://www.aicoo.io`) |

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

**What "on SharedOS" means here.** SharedOS is not a host: the kernel is a
library that runs inside TrustLayer's own process — *"Your app runs the kernel.
Cloud shows what it decided"* — and Cloud is a read-only decision console that
your host pushes to, in design-partner preview. So there is nothing to upload
to SharedOS. TrustLayer already *runs on* SharedOS: every verification is a
real bounded turn under the purpose `trust.verify`, with the audit trail and
the execution and trace ids in each receipt's `provenance`. Deploying means
putting this process somewhere it stays up.

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
GET  /health              liveness: method version, tenant, service names, and
                          whether the verifier can actually answer a call
GET  /health/ready        readiness: 200 when it can serve, 503 with the reasons when it cannot
GET  /v1/authority        what the verifier may do, computed by the kernel from its grants
GET  /v1/services         the descriptors: name, price, input, output, guarantees
POST /v1/trust.verify     task + candidate_output (+ focus_claims, source_urls) -> receipt
POST /v1/trust.check      one claim -> the same receipt
```

**Check `/health/ready` before the round opens.** A deployment with no model
provider or no search backend starts, listens, and answers `/health` — and
fails every call. That is the worst state to be in on a night when nobody may
touch the keyboard, so readiness names each blocker instead of reporting `ok`:

```json
{ "ready": false,
  "blockers": ["no model provider: set MODEL_PROVIDER=anthropic (with MODEL_NAME)",
               "no search backend: set SEARCH_PROVIDER=brave|tavily and SEARCH_API_KEY, …"] }
```

The same list is logged at error level on startup. Liveness stays `200` on
purpose: an unconfigured service should be visible, not restart-looped.

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

## 4. SharedNet — the network the Arena runs on

**Verified on 2026-09-08.** SharedNet is a real, documented, live API:

- site <https://www.sharednet.ai>, API docs <https://www.sharednet.ai/api/docs>,
  OpenAPI at `/api/v1/openapi.json`, CLI `npx sharednet` (npm package
  `sharednet`, repo `Aicoo-Team/SharedNet`);
- `GET /api/v1` answers publicly with the protocol version, capabilities and
  limits — no key needed to look.

### What it has, and what it does not

```
identity.principal   agents         instances.lease   instances.reach
rooms                rooms.members  rooms.messages    rooms.invites
rooms.wait           rooms.inbox    decisions.*       network
```

That is the complete capability list the live API reports. There is **no
service registry, no offers, no prices and no credits endpoint**. So on the
network as it actually exists:

> **A service call is a message in a Room, and the transcript is the record of
> what was sold.**

Everything in `src/sharednet/` follows from that, and nothing in it is invented:
every path, header and token prefix appears in the published docs or in the
official CLI.

### The contract

| | |
| --- | --- |
| Base | `https://www.sharednet.ai`, paths under `/api/v1` |
| Auth | `authorization: Bearer …` — account key `snk_…`, instance token `sni_…`, invite `rit_…` |
| Register | `POST /instances` with the account key → the node id (`i_…`) and a one-time token |
| Presence | `POST /instances/current/heartbeat`, every 30s; the lease is 90s |
| Rooms | `POST /rooms`, `POST /rooms/{id}/join`, `GET /rooms` (`Idempotency-Key` on writes) |
| Read | `GET /rooms/{id}/wait?after=<sequence>&timeout=<0-25>` long-poll, `GET /inbox` |
| Write | `POST /rooms/{id}/messages` `{content, reply_to_message_id?}`, **32,768 byte cap** |
| Limits | 600 bearer req/min, page size ≤100 |

### What the live API actually does (verified 2026-09-08, against the real service)

The docs page and the service disagree in three places. The service wins:

- the credential comes back as **`token`**, not `instance_token`;
- ids are **`i_…` and `p_…`** with ten characters, not `ins_`/`pri_`;
- `runtime_kind` **and** `cli_version` are both required, `runtime_metadata`
  values must be **flat strings** (an array or a nested object is
  `validation_failed`), and unknown top-level fields are rejected.

Registering with the same 64-hex `local_instance_key` returns **200 and the
same instance id** rather than minting a new one, so the node id survives a
restart or a redeploy. `src/sharednet/client.ts` derives that key from the
deployment; `SHAREDNET_INSTANCE_KEY` (64 hex chars) or `SHAREDNET_INSTANCE_SEED`
override it.

### Getting the node id the submission asks for

```bash
npx sharednet login            # binds this machine to your account
npx sharednet whoami           # your principal and current instance
```

or headless, which is what the deployed service does:

```bash
SHAREDNET_API_KEY=snk_… pnpm node:id         # prints the node id and the rooms this seat sees
SHAREDNET_API_KEY=snk_… SHAREDNET_ROOM_ID=rom_… pnpm room:serve
```

The account key comes from the developers console on sharednet.ai; keep it in
`.env`, which is gitignored. The instance id printed is what goes on the Devpost
form, and it is stable — running either command again returns the same one.

### Answering calls in a Room

Two supported ways, same behaviour — they share `respondToMessage`, so they
cannot drift apart.

**With the official CLI** (best on a laptop):

```bash
npx sharednet join '<invite>'          # or: npx sharednet join rom_…
npx sharednet watch --on message --run 'pnpm room:respond' --reply
```

The CLI hands the batch to the command on stdin and posts whatever the command
prints on stdout as the reply. Printing nothing means "not for us", and nothing
is posted. (This is why every TrustLayer log line goes to stderr: on this path
stdout is a paying caller's receipt.)

**Headless** (what the container runs):

```bash
SHAREDNET_API_KEY=snk_… SHAREDNET_ROOM_ID=rom_… pnpm room:serve
```

Registers, joins, heartbeats, long-polls, and replies — with a stable
idempotency key per incoming message, so a retry after a failed post cannot
deliver a second copy of a receipt.

### Four things a live room taught us

Verified by running it, not by reading docs (`NOTES.md` §12 has the detail):

- the sender is `sender.member_id` / `sender_instance_id`, **not**
  `member_id` — check the wrong one and the service answers itself forever;
- every reply carries a marker that `parseCall` refuses, so an echo, a second
  instance, or a quoted receipt cannot restart the loop;
- the loop answers a message once, yields through a real timer each pass so a
  non-blocking poll cannot spin uninterruptibly, **pauses** through a burst
  rather than stopping (the Arena is hands-off once it opens, so a guard that
  shuts the service off is its own outage), and stops for good only past an
  absolute ceiling no real market reaches;
- it starts at the room's **head**, so a restart does not replay — and
  re-charge for — every call in the history.

### How another agent calls TrustLayer

Name the service and include a JSON request. Prose around it is fine:

```
@trustlayer trust.verify
```json
{ "task": "How much does the Acme Widget Pro cost?",
  "candidate_output": "The Acme Widget Pro costs $79.",
  "source_urls": ["https://acme.example/store/widget-pro"] }
```
```

`trust.check` in the message routes to the one-claim service instead. The reply
is the receipt: verdict, per-claim status with verified quotes, every source
retrieved with its digest, the host-derived checks, and the SharedOS execution
ids — plus a compact JSON block for the agent that is paying. It is rendered to
fit the 32 KB cap, shedding the JSON block, then the evidence list, then the
claim detail — never the verdict, the coverage or the execution ids.

A message that does not name us gets no reply at all.

### Running it unattended on the night

The rules are explicit: *"once the Arena opens, humans don't touch the
keyboard."* So the service has to survive two hours alone. What that means
here:

- `pnpm room:serve` heartbeats every 30s against the 90s lease, retries a
  failed poll, and keeps a stable node id across restarts;
- a busy minute pauses the loop, it does not stop it;
- a failed verification answers honestly ("NO RECEIPT … nothing is charged")
  instead of going silent, so a caller is never left waiting;
- a restart starts at the room's head, so nothing is re-answered or re-charged.

Start it before the round opens, watch stderr, and leave it alone.

### Credits

There is no credits endpoint on SharedNet, and Devpost says each agent is given
**100 Arena credits to spend in Round 2**. So settlement is organizer-side and
the transcript is the evidence. TrustLayer therefore states its price in every
reply and in its usage message, and says explicitly that a call which produced
no receipt is not charged for. Do not invent a metering API.

## 5. What still has to come from the organizers

Most of what was unknown a day ago is now answered by the live API. What is
left is genuinely organizer-side — no endpoint exists for any of it:

1. Our **tenant ID** and **owner address** for SharedOS Cloud
   (`SHAREDOS_TENANT_ID`, `SHAREDOS_OWNER_ADDRESS`).
2. **Which Room** is the Arena, and how to get in — an invite (`rit_…`) or a
   room id (`rom_…`).
3. **How credits are settled.** SharedNet has no credits API and each agent gets
   100 to spend; is it counted from the transcript, self-reported, or tracked in
   a spreadsheet? Are 3 credits (`trust.verify`) and 1 credit (`trust.check`)
   acceptable?
4. Whether a **service listing** is registered anywhere beyond the Devpost form.
5. **Where decision events go** — Cloud is described as receiving them pushed by
   our host after the fact; what endpoint, what auth, what payload?

Questions 1 and 2 are the only true blockers: without a room we cannot be
called, and without a tenant our audit trail is under our own namespace rather
than theirs. Everything else has a defensible default already in the code.

Write every answer into `NOTES.md` with the date and who said it.
