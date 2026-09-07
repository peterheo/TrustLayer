import { describe, expect, it } from "vitest";

import { verify } from "../src/api/verify.js";
import { ScriptedVerifierModel } from "../src/agent/model.js";
import { TrustLayerError } from "../src/errors.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { verifierGrants } from "../src/sharedos/grants.js";
import { judgment, searchThenSubmit, staticBackend } from "./fixtures.js";

/**
 * End-to-end: a real SharedOS turn, a real tool call through the kernel, a
 * real execution record, and a host-computed score.
 */
describe("verify()", () => {
  const request = {
    task: "How much does Widget X cost?",
    candidateOutput: "Widget X costs $79.",
  };

  it("runs a bounded SharedOS turn and returns a host-scored verdict", async () => {
    const host = createTrustLayerHost({ searchBackend: staticBackend() });
    const model = new ScriptedVerifierModel(searchThenSubmit(judgment()));

    const response = await verify(request, { host, model });

    expect(response.verdict).toBe("supported");
    expect(response.trustScore).toBe(100);
    expect(response.claims).toHaveLength(1);
    expect(response.claims[0]?.status).toBe("supported");
  });

  it("derives audit metadata from the execution, not from the model", async () => {
    const host = createTrustLayerHost({ searchBackend: staticBackend() });
    const model = new ScriptedVerifierModel(searchThenSubmit(judgment()));

    const response = await verify(request, { host, model });

    expect(response.audit.sharedosStatus).toBe("succeeded");
    expect(response.audit.toolsUsed).toEqual(["research.search"]);
    expect(response.audit.executionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.audit.traceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(response.audit.traceId).not.toBe(response.audit.executionId);
    expect(response.audit.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("leaves an ordered SharedOS audit trail for the turn", async () => {
    const host = createTrustLayerHost({ searchBackend: staticBackend() });
    const model = new ScriptedVerifierModel(searchThenSubmit(judgment()));

    await verify(request, { host, model });

    // The kernel's audit sink holds the authorization record.
    const auditTypes = host.audit.events.map((event) => event.type);
    expect(auditTypes).toContain("authority.resolved");
    expect(auditTypes).toContain("tool.catalog.listed");
    expect(auditTypes).toContain("authorization.checked");
    expect(auditTypes).toContain("tool.invoked");
    expect(auditTypes).toContain("turn.ended");

    // Every authorization that was checked was allowed: the verifier asked
    // for nothing it had not been granted.
    const decisions = host.audit.events
      .filter((event) => event.type === "authorization.checked")
      .map((event) => (event as unknown as { outcome: string }).outcome);
    expect(decisions.length).toBeGreaterThan(0);
    expect(new Set(decisions)).toEqual(new Set(["allowed"]));
  });

  it("runs under the single purpose string on every audited event", async () => {
    const host = createTrustLayerHost({ searchBackend: staticBackend() });
    const model = new ScriptedVerifierModel(searchThenSubmit(judgment()));

    await verify(request, { host, model });

    const purposes = new Set(
      host.audit.events.map((event) => (event as unknown as { purpose: string }).purpose),
    );
    expect([...purposes]).toEqual(["trust.verify"]);
  });

  it("reports a SharedOS denial as a denial, never as a verification", async () => {
    // No execution grant: the turn is refused at admission.
    const host = createTrustLayerHost({
      searchBackend: staticBackend(),
      grants: verifierGrants({ withExecution: false }),
    });
    const model = new ScriptedVerifierModel(searchThenSubmit(judgment()));

    await expect(verify(request, { host, model })).rejects.toMatchObject({
      code: "SHAREDOS_DENIED",
    });
  });

  it("rejects an oversized candidate output before spending a turn", async () => {
    const host = createTrustLayerHost({ searchBackend: staticBackend() });
    const model = new ScriptedVerifierModel([]);

    await expect(
      verify({ task: "t", candidateOutput: "x".repeat(40_001) }, { host, model }),
    ).rejects.toBeInstanceOf(TrustLayerError);
    // Nothing was executed, so the model was never opened.
    expect(model.observations).toHaveLength(0);
  });

  it("reports an unusable model judgment as MODEL_OUTPUT_INVALID", async () => {
    const host = createTrustLayerHost({ searchBackend: staticBackend() });
    const model = new ScriptedVerifierModel([
      { kind: "final", output: { summary: "no claims field" } },
    ]);

    await expect(verify(request, { host, model })).rejects.toMatchObject({
      code: "MODEL_OUTPUT_INVALID",
    });
  });
});
