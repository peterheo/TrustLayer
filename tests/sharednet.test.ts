import { afterEach, describe, expect, it, vi } from "vitest";

import { SharedNetClient, MAX_MESSAGE_BYTES, localInstanceKey } from "../src/sharednet/client.js";
import {
  compactReceipt,
  parseCall,
  renderFailure,
  renderReceipt,
  usageReply,
} from "../src/sharednet/protocol.js";
import { parseWatchPayload, respondToBatch, respondToMessage } from "../src/sharednet/responder.js";
import { runRoomService } from "../src/sharednet/room-service.js";
import { verify } from "../src/api/verify.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { ScriptedVerifierModel } from "../src/verifier/model.js";
import type { EvidenceReceipt } from "../src/evidence/schemas.js";
import { fullProtocolScript, pricingPage, publicDns, staticBackend } from "./fixtures.js";

/**
 * TrustLayer as a SharedNet service.
 *
 * SharedNet has Rooms, messages and decisions — and no service registry, no
 * offers and no credits. So a call is a message and the transcript is the
 * record of the sale, which puts the weight on three things: recognising a
 * call, fitting a receipt into one message, and never answering twice.
 */
describe("sharednet call protocol", () => {
  const request = {
    task: "How much does Widget X cost?",
    candidate_output: "Widget X costs $79.",
  };

  describe("recognising a call", () => {
    it("answers a message that names the service", () => {
      const result = parseCall(
        `@trustlayer please check this\n\`\`\`json\n${JSON.stringify(request)}\n\`\`\``,
      );

      expect(result.kind).toBe("call");
      expect(result.kind === "call" && result.call.service).toBe("trust.verify");
      expect(result.kind === "call" && result.call.request["task"]).toBe(request.task);
    });

    it("routes trust.check to the cheaper service", () => {
      const result = parseCall(`trust.check ${JSON.stringify(request)}`);
      expect(result.kind === "call" && result.call.service).toBe("trust.check");
    });

    it("stays silent in a busy room when nobody addressed us", () => {
      // A service that replies to everything is noise, and noise does not sell.
      expect(parseCall("has anyone got the pricing page?").kind).toBe("ignore");
      expect(parseCall(JSON.stringify(request)).kind).toBe("ignore");
    });

    it("explains itself when addressed with an unusable request", () => {
      const result = parseCall("@trustlayer can you check this for me?");
      expect(result.kind).toBe("malformed");

      const reply = usageReply(result.kind === "malformed" ? result.failure : { service: "trust.verify", reason: "" });
      expect(reply).toContain("candidate_output");
      expect(reply).toContain("3 credits");
      // The offer says what it does, not what it guarantees.
      expect(reply).toContain("unverified, never as false");
    });

    it("accepts prose around the request, and a bare object", () => {
      expect(parseCall(`@trustlayer here you go: ${JSON.stringify(request)} thanks!`).kind).toBe(
        "call",
      );
      expect(
        parseCall(`trust.verify\n\`\`\`\n${JSON.stringify(request)}\n\`\`\``).kind,
      ).toBe("call");
    });

    it("requires both fields before spending a turn", () => {
      const result = parseCall(`@trustlayer ${JSON.stringify({ task: "only a task" })}`);
      expect(result.kind).toBe("malformed");
    });
  });

  describe("rendering a receipt into one message", () => {
    function receiptWith(overrides: Partial<EvidenceReceipt> = {}): EvidenceReceipt {
      return {
        reportId: "rpt_1",
        methodVersion: "trustlayer-evidence-v1",
        protocolStatus: "complete",
        overallStatus: "supported",
        summary: "The price claim holds.",
        claims: [
          {
            claimId: "k1",
            claim: "Widget X costs $79.",
            importance: "critical",
            status: "supported",
            confidence: 0.9,
            rationale: "The store page lists $79.00.",
            evidence: [{ evidenceId: "e1", relation: "supports", note: "lists $79.00" }],
            spans: [{ evidenceId: "e1", excerpt: "priced at $79.00", start: 10, end: 26 }],
          },
        ],
        evidence: [
          {
            evidenceId: "e1",
            url: "https://example.org/p",
            resolvedUrl: "https://example.org/p",
            domain: "example.org",
            retrievedAt: "2026-09-08T00:00:00.000Z",
            contentSha256: "a".repeat(64),
            origin: "independent",
          },
        ],
        coverage: {
          claimsSelected: 1,
          claimsChecked: 1,
          criticalClaimsTotal: 1,
          criticalClaimsChecked: 1,
          searchCandidates: 3,
          sourcesFetched: 1,
          distinctDomains: 1,
        },
        checks: {
          independentSearchPerformed: true,
          sourcesFetched: true,
          candidateCitationsChecked: false,
          contradictionSearchPerformed: true,
          contradictionSearchProducedCandidates: true,
          contradictionEvidenceFetched: true,
          evidenceReferencesValidated: true,
        },
        security: { suspiciousInstructionsDetected: false, indicators: [] },
        provenance: {
          purpose: "trust.verify",
          executionId: "exec-1",
          traceId: "trace-1",
          sharedosStatus: "succeeded",
          toolsUsed: ["research.search", "research.fetch"],
          startedAt: "2026-09-08T00:00:00.000Z",
          completedAt: "2026-09-08T00:00:01.000Z",
          durationMs: 1_000,
        },
        ...overrides,
      };
    }

    it("shows the verdict, the evidence and the execution to both readers", () => {
      const rendered = renderReceipt(receiptWith(), { service: "trust.verify" });

      expect(rendered).toContain("SUPPORTED");
      expect(rendered).toContain("https://example.org/p");
      expect(rendered).toContain("sha256 aaaaaaaaaaaaaaaa");
      expect(rendered).toContain('quoted from e1: "priced at $79.00"');
      expect(rendered).toContain("purpose trust.verify, execution exec-1");
      // And a machine-readable half for the agent that is paying.
      expect(rendered).toContain("```json");
      expect(JSON.parse(rendered.split("```json")[1]!.split("```")[0]!)).toMatchObject({
        overallStatus: "supported",
      });
    });

    it("fits the room's message cap by shedding detail in a fixed order", () => {
      // Fifty sources with long URLs will not fit alongside the JSON block.
      const evidence = Array.from({ length: 50 }, (_, index) => ({
        evidenceId: `e${index}`,
        url: `https://example.org/${"path".repeat(60)}/${index}`,
        resolvedUrl: `https://example.org/${"path".repeat(60)}/${index}`,
        domain: "example.org",
        retrievedAt: "2026-09-08T00:00:00.000Z",
        contentSha256: "b".repeat(64),
        origin: "independent" as const,
      }));

      const rendered = renderReceipt(receiptWith({ evidence }), {
        service: "trust.verify",
        maxBytes: 2_000,
      });

      expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(2_000);
      // What survives is what makes the answer checkable.
      expect(rendered).toContain("SUPPORTED");
      expect(rendered).toContain("execution exec-1");
    });

    it("never exceeds the real cap", () => {
      const rendered = renderReceipt(receiptWith(), { service: "trust.verify" });
      expect(Buffer.byteLength(rendered, "utf8")).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    });

    it("says plainly when there is no receipt", () => {
      const rendered = renderFailure("trust.verify", "MODEL_FAILURE", "The verifier failed.");
      expect(rendered).toContain("NO RECEIPT");
      // A failed call is not evidence either way, and is not charged for.
      expect(rendered).toContain("nothing here should be read as evidence");
      expect(rendered).toContain("Nothing is charged");
    });

    it("keeps provenance and digests in the machine-readable half", () => {
      const compact = compactReceipt(receiptWith());
      expect(compact["provenance"]).toMatchObject({ executionId: "exec-1" });
      expect((compact["evidence"] as { contentSha256: string }[])[0]?.contentSha256).toHaveLength(64);
    });
  });
});

describe("sharednet responder", () => {
  function verifyOptions() {
    return {
      host: createTrustLayerHost({ searchBackend: staticBackend(), resolveHost: publicDns }),
      model: new ScriptedVerifierModel(fullProtocolScript()),
    };
  }

  function stubPages(): void {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(pricingPage(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const call = {
    id: "msg_1",
    sequence: 1,
    member_id: "mem_caller",
    content:
      '@trustlayer trust.verify ```json{"task":"How much does Widget X cost?",' +
      '"candidate_output":"Widget X costs $79."}```',
  };

  it("verifies a call and answers with a receipt", async () => {
    stubPages();
    const reply = await respondToMessage(call, { verifyOptions: verifyOptions() });

    expect(reply).toContain("TrustLayer trust.verify");
    expect(reply).toContain("trustlayer-evidence-v1");
    expect(reply).toContain("purpose trust.verify");
  });

  it("never answers its own receipt", async () => {
    const own = { ...call, member_id: "mem_us" };
    expect(await respondToMessage(own, { memberId: "mem_us" })).toBeUndefined();
  });

  it("answers nothing at all when nobody named us", async () => {
    const reply = await respondToMessage({ ...call, content: "morning everyone" });
    expect(reply).toBeUndefined();
  });

  it("handles a watch batch and joins what it answered", async () => {
    stubPages();
    const payload = parseWatchPayload(
      JSON.stringify({
        room_id: "rom_1",
        member_id: "mem_us",
        trigger: "message",
        messages: [{ id: "m0", sequence: 1, member_id: "mem_x", content: "chatter" }, call],
      }),
    );

    const reply = await respondToBatch(payload, { verifyOptions: verifyOptions() });

    expect(reply).toContain("TrustLayer trust.verify");
    // The chatter contributed nothing, so nothing about it appears.
    expect(reply).not.toContain("chatter");
  });

  it("survives a malformed watch payload", () => {
    expect(parseWatchPayload("not json")).toEqual({});
    expect(parseWatchPayload("[1,2]")).toEqual({});
  });
});

describe("sharednet client", () => {
  function stubFetch(handler: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: unknown, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return handler(String(url), init);
    }) as unknown as typeof globalThis.fetch;
    return { calls, fetchImpl };
  }

  function ok(body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("registers an instance with the account key and keeps the token", async () => {
    // The real response shape, verified against the live API on 2026-09-08.
    const { calls, fetchImpl } = stubFetch(() =>
      ok({
        instance: { id: "i_mwYPHdmxi0", principal_id: "p_mrg7wm7lcS", reach: "public" },
        token: "sni_token",
        heartbeat_after_seconds: 30,
      }),
    );
    const client = new SharedNetClient({ apiKey: "snk_key", fetch: fetchImpl });

    const registration = await client.registerInstance({ reach: "public" });

    expect(registration.instance.id).toBe("i_mwYPHdmxi0");
    expect(client.instanceToken).toBe("sni_token");
    expect(calls[0]?.url).toBe("https://www.sharednet.ai/api/v1/instances");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer snk_key");

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    // Both fields are required; the API rejects the request without either.
    expect(body["runtime_kind"]).toBe("service");
    expect(typeof body["cli_version"]).toBe("string");
    // Metadata values must be flat strings — an array is validation_failed.
    for (const value of Object.values(body["runtime_metadata"] as Record<string, unknown>)) {
      expect(typeof value).toBe("string");
    }
  });

  it("registers with a stable key, so a restart keeps the same node id", async () => {
    const { calls, fetchImpl } = stubFetch(() => ok({ instance: { id: "i_abc" }, token: "sni_t" }));
    const client = new SharedNetClient({ apiKey: "snk_key", fetch: fetchImpl });

    await client.registerInstance();

    // The API returns 200 and the existing instance for a key it has seen
    // before, which is what keeps a published node id true after a redeploy.
    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(body["local_instance_key"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("derives that key from the deployment, and lets it be set outright", () => {
    const a = localInstanceKey({ SHAREDOS_TENANT_ID: "tenant-a" });
    const b = localInstanceKey({ SHAREDOS_TENANT_ID: "tenant-b" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Same deployment, same seat; a different tenant is a different seat.
    expect(localInstanceKey({ SHAREDOS_TENANT_ID: "tenant-a" })).toBe(a);
    expect(b).not.toBe(a);

    const explicit = "f".repeat(64);
    expect(localInstanceKey({ SHAREDNET_INSTANCE_KEY: explicit })).toBe(explicit);
    // A malformed override is ignored rather than sent and rejected.
    expect(localInstanceKey({ SHAREDNET_INSTANCE_KEY: "nonsense" })).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts the docs-page spelling of the token as well as the live one", async () => {
    const { fetchImpl } = stubFetch(() =>
      ok({ instance: { id: "i_abc" }, instance_token: "sni_docs_shape" }),
    );
    const client = new SharedNetClient({ apiKey: "snk_key", fetch: fetchImpl });

    await client.registerInstance();

    expect(client.instanceToken).toBe("sni_docs_shape");
  });

  it("refuses a registration that came back without a token", async () => {
    const { fetchImpl } = stubFetch(() => ok({ instance: { id: "i_abc" } }));
    const client = new SharedNetClient({ apiKey: "snk_key", fetch: fetchImpl });

    await expect(client.registerInstance()).rejects.toMatchObject({
      detail: "sharednet_registration_without_token",
    });
  });

  it("long-polls with a cursor and the documented ceiling", async () => {
    const { calls, fetchImpl } = stubFetch(() => ok({ items: [{ id: "m", sequence: 4, content: "x" }] }));
    const client = new SharedNetClient({ instanceToken: "sni_token", fetch: fetchImpl });

    const page = await client.waitForMessages("rom_1", 3, 900);

    expect(page.items[0]?.sequence).toBe(4);
    // Clamped to the API's published maximum rather than sent as given.
    expect(calls[0]?.url).toContain("/rooms/rom_1/wait?after=3&timeout=25");
  });

  it("posts a reply with an idempotency key, so a retry cannot deliver twice", async () => {
    const { calls, fetchImpl } = stubFetch(() => ok({ message: { id: "msg_2" } }));
    const client = new SharedNetClient({ instanceToken: "sni_token", fetch: fetchImpl });

    await client.postMessage("rom_1", "receipt", { replyTo: "msg_1", idempotencyKey: "key-1" });

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("key-1");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      content: "receipt",
      reply_to_message_id: "msg_1",
    });
  });

  it("refuses to post more than a room will hold", async () => {
    const { fetchImpl } = stubFetch(() => ok({}));
    const client = new SharedNetClient({ instanceToken: "sni_token", fetch: fetchImpl });

    // The public message stays uninformative; the reason is in `detail`, which
    // is host-side only.
    await expect(
      client.postMessage("rom_1", "x".repeat(MAX_MESSAGE_BYTES + 1)),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", detail: expect.stringMatching(/size cap/i) });
  });

  it("reports an API error without echoing the body or the token", async () => {
    const { fetchImpl } = stubFetch(
      () =>
        new Response(JSON.stringify({ error: { code: "room_not_found", message: "…", request_id: "req_1" } }), {
          status: 404,
        }),
    );
    const client = new SharedNetClient({ instanceToken: "sni_secret", fetch: fetchImpl });

    // The request id travels in the host-side detail, so an API-side failure
    // is traceable in support without the body reaching the caller.
    await expect(client.listRooms()).rejects.toMatchObject({
      detail: "sharednet_room_not_found (req_1)",
    });
  });

  it("will not talk to a non-HTTPS origin", () => {
    // A room transcript is not something to send in plaintext because a base
    // URL was mistyped. 127.0.0.1 stays allowed for a local server.
    expect(() => new SharedNetClient({ baseUrl: "http://example.com" })).toThrow(
      /verification request was not valid/i,
    );
    try {
      new SharedNetClient({ baseUrl: "http://example.com" });
    } catch (error) {
      expect((error as { detail?: string }).detail).toMatch(/HTTPS/i);
    }
    expect(() => new SharedNetClient({ baseUrl: "http://127.0.0.1:3001" })).not.toThrow();
  });
});

describe("sharednet room service", () => {
  it("answers a call, replies to it, and does not answer it twice", async () => {
    const posted: { content: string; init: RequestInit }[] = [];
    let waits = 0;

    const controller = new AbortController();
    const fetchImpl = (async (url: unknown, init: RequestInit = {}) => {
      const target = String(url);
      if (target.includes("/heartbeat")) return new Response("{}", { status: 200 });
      if (target.includes("/wait")) {
        waits += 1;
        if (waits > 1) {
          controller.abort();
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "msg_1",
                sequence: 1,
                member_id: "mem_caller",
                content:
                  '@trustlayer ```json{"task":"How much does Widget X cost?",' +
                  '"candidate_output":"Widget X costs $79."}```',
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (target.includes("/messages")) {
        posted.push({ content: JSON.parse(String(init.body)).content as string, init });
        return new Response(JSON.stringify({ message: { id: "msg_2" } }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    vi.stubGlobal("fetch", async () =>
      new Response(pricingPage(), { status: 200, headers: { "content-type": "text/html" } }),
    );

    try {
      await runRoomService({
        client: new SharedNetClient({ instanceToken: "sni_token", fetch: fetchImpl }),
        roomId: "rom_1",
        memberId: "mem_us",
        signal: controller.signal,
        waitSeconds: 0,
        verifyOptions: {
          host: createTrustLayerHost({ searchBackend: staticBackend(), resolveHost: publicDns }),
          model: new ScriptedVerifierModel(fullProtocolScript()),
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(posted).toHaveLength(1);
    expect(posted[0]?.content).toContain("TrustLayer trust.verify");
    expect(JSON.parse(String(posted[0]?.init.body))["reply_to_message_id"]).toBe("msg_1");
  });
});

/**
 * Under `sharednet watch --run … --reply`, stdout is the reply the Room
 * receives. A diagnostic line on stdout would be published to a paying caller
 * as part of their receipt, so the logger must never use it.
 */
describe("stdout is the reply channel", () => {
  it("writes every log level to stderr", async () => {
    const { logger } = await import("../src/logging.js");
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    try {
      logger.debug("d");
      logger.info("i");
      logger.warn("w");
      logger.error("e");

      expect(out).not.toHaveBeenCalled();
      expect(err).toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });
});

/** The engine behind the room reply is the same one the HTTP surface uses. */
describe("one engine", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("produces the same receipt whichever way it was called", async () => {
    vi.stubGlobal("fetch", async () =>
      new Response(pricingPage(), { status: 200, headers: { "content-type": "text/html" } }),
    );

    const receipt = await verify(
      { task: "How much does Widget X cost?", candidateOutput: "Widget X costs $79." },
      {
        host: createTrustLayerHost({ searchBackend: staticBackend(), resolveHost: publicDns }),
        model: new ScriptedVerifierModel(fullProtocolScript()),
      },
    );

    const rendered = renderReceipt(receipt, { service: "trust.verify" });
    expect(rendered).toContain(receipt.reportId);
    expect(rendered).toContain(receipt.provenance.executionId);
  });
});
