import { describe, expect, it } from "vitest";

import { ScriptedVerifierModel } from "../src/agent/model.js";
import {
  TRUST_VERIFY_DESCRIPTOR,
  TRUST_VERIFY_PRICE_CREDITS,
  handleServiceCall,
} from "../src/arena/adapter.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { judgment, searchThenSubmit, staticBackend } from "./fixtures.js";

describe("Arena service adapter", () => {
  function host() {
    return createTrustLayerHost({ searchBackend: staticBackend() });
  }

  it("accepts the snake_case field names another agent reads off the service card", async () => {
    const model = new ScriptedVerifierModel(searchThenSubmit(judgment()));

    const outcome = await handleServiceCall(
      {
        task: "How much does Widget X cost?",
        candidate_output: "Widget X costs $79.",
        max_claims: 3,
      },
      { host: host(), model },
    );

    expect(outcome.ok).toBe(true);
    expect(outcome.ok === true && outcome.result.verdict).toBe("supported");
  });

  it("accepts camelCase too", async () => {
    const model = new ScriptedVerifierModel(searchThenSubmit(judgment()));

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
    // A safe, fixed message: no stack, no field paths, no internals.
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

  it("exposes a price and a machine-readable descriptor", () => {
    expect(TRUST_VERIFY_PRICE_CREDITS).toBe(3);
    expect(TRUST_VERIFY_DESCRIPTOR.name).toBe("trust.verify");
    expect(TRUST_VERIFY_DESCRIPTOR.price_credits).toBe(3);
    expect(TRUST_VERIFY_DESCRIPTOR.use_when.length).toBeGreaterThan(0);
    expect(TRUST_VERIFY_DESCRIPTOR.not_for.length).toBeGreaterThan(0);
    // The card must stay honest about latency against the Arena's 5-minute cap.
    expect(TRUST_VERIFY_DESCRIPTOR.max_latency_seconds).toBeLessThan(300);
  });

  it("never returns grants or policy internals in a successful response", async () => {
    const model = new ScriptedVerifierModel(searchThenSubmit(judgment()));

    const outcome = await handleServiceCall(
      { task: "t", candidate_output: "Widget X costs $79." },
      { host: host(), model },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const serialized = JSON.stringify(outcome.result);
    expect(serialized).not.toMatch(/grant/i);
    expect(serialized).not.toMatch(/capabilit/i);
    expect(serialized).not.toMatch(/apiKey|api_key|token|secret/i);
    // The audit block carries correlation only.
    expect(Object.keys(outcome.result.audit).sort()).toEqual([
      "completedAt",
      "durationMs",
      "executionId",
      "sharedosStatus",
      "startedAt",
      "toolsUsed",
      "traceId",
    ]);
  });
});
