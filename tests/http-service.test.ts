import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpService, readiness } from "../src/api/http.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { ScriptedVerifierModel } from "../src/verifier/model.js";
import {
  fullProtocolScript,
  pricingPage,
  publicDns,
  staticBackend,
} from "./fixtures.js";

/**
 * The surface another agent actually talks to.
 *
 * The rule this suite exists to hold: transport authentication decides who may
 * ask, and nothing else. What the verifier may do is decided by its grants,
 * inside the turn — so the HTTP layer must never become a way to borrow the
 * verifier's capabilities.
 */
describe("http service", () => {
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

  const body = {
    task: "How much does Widget X cost?",
    candidate_output: "Widget X costs $79.",
  };

  function post(path: string, init: RequestInit = {}): Request {
    return new Request(`http://trustlayer.test${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    });
  }

  it("answers a health probe without authentication", async () => {
    const handle = createHttpService({ token: "secret" });
    const response = await handle(new Request("http://trustlayer.test/health"));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as Record<string, unknown>;
    expect(payload["methodVersion"]).toBe("trustlayer-evidence-v1");
    expect(payload["services"]).toEqual(["trust.verify", "trust.check"]);
  });

  /**
   * A deployment that reports `ok` while every call fails is the worst shape
   * this can take on a night when nobody may touch the keyboard: monitored as
   * alive, earning nothing. Readiness has to be able to say no.
   */
  describe("readiness", () => {
    it("names what is missing rather than claiming to be fine", () => {
      const state = readiness();

      // In this test environment there is no model and no search backend.
      expect(state.ready).toBe(false);
      expect(state.blockers.join(" ")).toMatch(/MODEL_PROVIDER|MODEL_API_KEY/);
      expect(state.blockers.join(" ")).toMatch(/SEARCH_PROVIDER/);
    });

    it("reports degraded on the liveness probe, not ok", async () => {
      const handle = createHttpService();
      const payload = (await (await handle(new Request("http://trustlayer.test/health"))).json()) as {
        status: string;
        verifier: { ready: boolean; blockers: string[] };
      };

      expect(payload.status).toBe("degraded");
      expect(payload.verifier.ready).toBe(false);
      expect(payload.verifier.blockers.length).toBeGreaterThan(0);
    });

    it("fails the readiness probe with 503 so a checker can see it", async () => {
      const handle = createHttpService();
      const response = await handle(new Request("http://trustlayer.test/health/ready"));

      // Liveness stays 200 — an unconfigured service should not be restarted
      // in a loop — but readiness says no out loud.
      expect(response.status).toBe(503);
      expect((await response.json()) as { ready: boolean }).toMatchObject({ ready: false });
    });
  });

  it("publishes what a caller is buying", async () => {
    const handle = createHttpService();
    const response = await handle(new Request("http://trustlayer.test/v1/services"));

    const payload = (await response.json()) as { services: { name: string; price_credits: number }[] };
    expect(payload.services.map((service) => service.name)).toEqual([
      "trust.verify",
      "trust.check",
    ]);
    expect(payload.services[0]?.price_credits).toBe(3);
    // No trust score is advertised anywhere, including here.
    expect(JSON.stringify(payload)).not.toMatch(/trust[_ ]?score/i);
  });

  /**
   * The one claim in this product that a caller should not have to take on
   * trust. `kernel.reach` derives it from the grants when asked, and the SDK
   * never stores it — so a revoked grant stops advertising itself.
   */
  describe("authority", () => {
    it("publishes exactly the three capabilities the verifier holds", async () => {
      const handle = createHttpService({ verifyOptions: verifyOptions() });
      const response = await handle(new Request("http://trustlayer.test/v1/authority"));

      expect(response.status).toBe(200);
      const payload = (await response.json()) as {
        purpose: string;
        tools: string[];
        reach: { status: string; reach: { namespace: string; actions: string[] }[] };
      };

      expect(payload.purpose).toBe("trust.verify");
      expect([...payload.tools].sort()).toEqual(["research.fetch", "research.search"]);
      expect(payload.reach.status).toBe("computed");

      const namespaces = payload.reach.reach.map((entry) => entry.namespace).sort();
      expect(namespaces).toEqual(["research", "research", "sharedos.execution"]);
    });

    it("shows the absence of everything the verifier is not granted", async () => {
      const handle = createHttpService({ verifyOptions: verifyOptions() });
      const body = await (
        await handle(new Request("http://trustlayer.test/v1/authority"))
      ).text();

      // Absence is the proof: a namespace missing from a kernel-computed reach
      // is authority the service does not hold.
      for (const namespace of ["files", "messages", "repo", "calendar", "sharedos.escalate"]) {
        expect(body).not.toContain(`"${namespace}"`);
      }
    });

    it("needs no token, because it grants nothing", async () => {
      const handle = createHttpService({ token: "secret", verifyOptions: verifyOptions() });
      const response = await handle(new Request("http://trustlayer.test/v1/authority"));

      expect(response.status).toBe(200);
    });
  });

  it("returns an evidence receipt for a verify call", async () => {
    stubPages();
    const handle = createHttpService({ verifyOptions: verifyOptions() });

    const response = await handle(post("/v1/trust.verify"));

    expect(response.status).toBe(200);
    const payload = (await response.json()) as { ok: boolean; receipt: Record<string, unknown> };
    expect(payload.ok).toBe(true);
    expect(payload.receipt["methodVersion"]).toBe("trustlayer-evidence-v1");
    expect((payload.receipt["provenance"] as Record<string, unknown>)["purpose"]).toBe(
      "trust.verify",
    );
  });

  it("runs trust.check on the same engine", async () => {
    stubPages();
    const handle = createHttpService({ verifyOptions: verifyOptions() });

    const response = await handle(post("/v1/trust.check"));

    const payload = (await response.json()) as { ok: boolean; receipt: { claims: unknown[] } };
    expect(payload.ok).toBe(true);
    expect(payload.receipt.claims).toHaveLength(1);
  });

  it("refuses a caller without the bearer token", async () => {
    const handle = createHttpService({ token: "secret", verifyOptions: verifyOptions() });

    const response = await handle(post("/v1/trust.verify"));

    expect(response.status).toBe(401);
    const payload = (await response.json()) as { error: { code: string } };
    expect(payload.error.code).toBe("unauthorized");
  });

  it("accepts the caller that presents it", async () => {
    stubPages();
    const handle = createHttpService({ token: "secret", verifyOptions: verifyOptions() });

    const response = await handle(
      post("/v1/trust.verify", {
        headers: { "content-type": "application/json", authorization: "Bearer secret" },
      }),
    );

    expect(response.status).toBe(200);
  });

  it("rejects a malformed body before spending a turn", async () => {
    const handle = createHttpService({ verifyOptions: verifyOptions() });

    const response = await handle(
      new Request("http://trustlayer.test/v1/trust.verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_json");
  });

  it("maps an invalid request to 400 without leaking internals", async () => {
    const handle = createHttpService({ verifyOptions: verifyOptions() });

    const response = await handle(
      new Request("http://trustlayer.test/v1/trust.verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ task: "" }),
      }),
    );

    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).not.toMatch(/grant|capability|stack|at Object|src\//i);
  });

  /**
   * The point of the whole product: holding the token buys verification, not
   * the verifier's capabilities. If the SharedOS boundary were mounted here, a
   * caller could drive research.fetch directly — our egress, our budget.
   */
  it("exposes no route that would lend a caller the verifier's tools", async () => {
    const handle = createHttpService({ token: "secret", verifyOptions: verifyOptions() });

    for (const path of [
      "/v1/turns",
      "/v1/tools/invoke",
      "/v1/tools",
      "/v1/resources/invoke",
      "/v1/messages",
      "/v1/authorize",
    ]) {
      const response = await handle(
        new Request(`http://trustlayer.test${path}`, {
          method: "POST",
          headers: { authorization: "Bearer secret", "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(response.status).toBe(404);
    }
  });

  it("rejects the wrong method rather than guessing", async () => {
    const handle = createHttpService();
    const response = await handle(new Request("http://trustlayer.test/v1/trust.verify"));

    expect(response.status).toBe(405);
  });
});
