import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SERVICE_DESCRIPTORS,
  TRUST_CHECK_DESCRIPTOR,
  TRUST_CHECK_PRICE_CREDITS,
  TRUST_VERIFY_DESCRIPTOR,
  TRUST_VERIFY_PRICE_CREDITS,
  handleCheckCall,
  handleServiceCall,
} from "../src/arena/adapter.js";
import { METHOD_VERSION } from "../src/evidence/schemas.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { ScriptedVerifierModel } from "../src/verifier/model.js";
import {
  CHALLENGE_DONE,
  RESEARCH_DONE,
  adjudicateStep,
  fetchStep,
  fullProtocolScript,
  pricingPage,
  publicDns,
  searchStep,
  staticBackend,
} from "./fixtures.js";

describe("Arena service adapter", () => {
  function host() {
    return createTrustLayerHost({ searchBackend: staticBackend(), resolveHost: publicDns });
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

  describe("trust.verify", () => {
    it("accepts the snake_case names another agent reads off the service card", async () => {
      stubPages();
      const model = new ScriptedVerifierModel(fullProtocolScript());

      const outcome = await handleServiceCall(
        {
          task: "How much does Widget X cost?",
          candidate_output: "Widget X costs $79.",
          max_claims: 3,
        },
        { host: host(), model },
      );

      expect(outcome.ok).toBe(true);
      expect(outcome.ok === true && outcome.receipt.overallStatus).toBe("supported");
    });

    it("accepts camelCase too", async () => {
      stubPages();
      const model = new ScriptedVerifierModel(fullProtocolScript());

      const outcome = await handleServiceCall(
        { task: "t", candidateOutput: "Widget X costs $79.", maxClaims: 3 },
        { host: host(), model },
      );

      expect(outcome.ok).toBe(true);
    });

    it("returns errors rather than throwing, with no internal detail", async () => {
      const model = new ScriptedVerifierModel([]);

      const outcome = await handleServiceCall({ task: "" }, { host: host(), model });

      expect(outcome.ok).toBe(false);
      if (outcome.ok) return;
      expect(outcome.error.code).toBe("INVALID_INPUT");
      expect(outcome.error.message).toBe("The verification request was not valid.");
      expect(Object.keys(outcome.error).sort()).toEqual(["code", "message"]);
    });

    it("rejects an unknown field rather than ignoring it", async () => {
      const model = new ScriptedVerifierModel([]);

      const outcome = await handleServiceCall(
        { task: "t", candidate_output: "c", grants: ["files:*"] },
        { host: host(), model },
      );

      expect(outcome.ok).toBe(false);
      expect(outcome.ok === false && outcome.error.code).toBe("INVALID_INPUT");
    });

    it("never returns grants, capabilities or credentials in a receipt", async () => {
      stubPages();
      const model = new ScriptedVerifierModel(fullProtocolScript());

      const outcome = await handleServiceCall(
        { task: "t", candidate_output: "Widget X costs $79." },
        { host: host(), model },
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const serialized = JSON.stringify(outcome.receipt);
      expect(serialized).not.toMatch(/grant/i);
      expect(serialized).not.toMatch(/capabilit/i);
      expect(serialized).not.toMatch(/apiKey|api_key|token|secret/i);
    });
  });

  describe("trust.check", () => {
    it("runs the same protocol clamped to a single claim", async () => {
      stubPages();
      // No plan step: a focus claim means planning is host code.
      const model = new ScriptedVerifierModel([
        searchStep("fare 412", "call-1"),
        fetchStep("https://example.org/widget-x-pricing", "call-2"),
        RESEARCH_DONE,
        searchStep("fare changed", "call-3"),
        CHALLENGE_DONE,
        adjudicateStep(),
      ]);

      const outcome = await handleCheckCall(
        {
          task: "Decide whether to purchase this travel service.",
          candidate_output: "The quoted fare is EUR 412 including taxes.",
          focus_claims: ["The quoted fare is EUR 412."],
        },
        { host: host(), model },
      );

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(outcome.receipt.claims).toHaveLength(1);
      expect(outcome.receipt.claims[0]?.claim).toBe("The quoted fare is EUR 412.");
      // The same receipt shape as trust.verify: portable across both services.
      expect(outcome.receipt.methodVersion).toBe(METHOD_VERSION);
      expect(outcome.receipt.protocolStatus).toBe("complete");
    });

    it("keeps only the first focus claim when several are supplied", async () => {
      stubPages();
      const model = new ScriptedVerifierModel([
        searchStep("q", "call-1"),
        fetchStep("https://example.org/widget-x-pricing", "call-2"),
        RESEARCH_DONE,
        searchStep("q2", "call-3"),
        CHALLENGE_DONE,
        adjudicateStep(),
      ]);

      const outcome = await handleCheckCall(
        {
          task: "t",
          candidate_output: "c",
          focus_claims: ["The fare is EUR 412.", "The flight is direct.", "Bags are included."],
        },
        { host: host(), model },
      );

      expect(outcome.ok).toBe(true);
      expect(outcome.ok === true && outcome.receipt.claims).toHaveLength(1);
      expect(outcome.ok === true && outcome.receipt.claims[0]?.claim).toBe("The fare is EUR 412.");
    });

    it("still works when the caller names no focus claim", async () => {
      stubPages();
      const model = new ScriptedVerifierModel(fullProtocolScript());

      const outcome = await handleCheckCall(
        { task: "t", candidate_output: "Widget X costs $79." },
        { host: host(), model },
      );

      expect(outcome.ok).toBe(true);
      expect(outcome.ok === true && outcome.receipt.claims).toHaveLength(1);
    });
  });

  describe("descriptors", () => {
    it("prices both services and describes when each applies", () => {
      expect(TRUST_VERIFY_PRICE_CREDITS).toBe(3);
      expect(TRUST_CHECK_PRICE_CREDITS).toBe(1);
      expect(TRUST_VERIFY_DESCRIPTOR.name).toBe("trust.verify");
      expect(TRUST_CHECK_DESCRIPTOR.name).toBe("trust.check");
      expect(SERVICE_DESCRIPTORS).toHaveLength(2);
    });

    it("states latency honestly against the Arena's five-minute ceiling", () => {
      for (const descriptor of SERVICE_DESCRIPTORS) {
        expect(descriptor.max_latency_seconds).toBeLessThan(300);
        expect(descriptor.typical_latency_seconds).toBeLessThanOrEqual(
          descriptor.max_latency_seconds,
        );
      }
    });

    it("claims only what the protocol can actually establish", () => {
      const guarantees = TRUST_VERIFY_DESCRIPTOR.guarantees.join(" ").toLowerCase();
      // Guarantees are about procedure and provenance, never about truth.
      expect(guarantees).not.toMatch(/guarantee[sd]? (that )?(the )?(claim|answer|fact) is true/);
      expect(guarantees).toMatch(/actually retrieved/);

      const limitations = TRUST_VERIFY_DESCRIPTOR.limitations.join(" ").toLowerCase();
      expect(limitations).toMatch(/does not establish that a claim is true/);
      expect(limitations).toMatch(/best-effort/);
    });

    it("advertises no trust score", () => {
      expect(JSON.stringify(SERVICE_DESCRIPTORS)).not.toMatch(/trust[_ ]?score/i);
    });
  });
});
