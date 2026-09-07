import { afterEach, describe, expect, it, vi } from "vitest";

import { verify } from "../src/api/verify.js";
import { visibleToolsFrom } from "../src/sharedos/audit.js";
import { runVerificationTurn } from "../src/sharedos/executor.js";
import { verifierGrants } from "../src/sharedos/grants.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { createVerifierDriver } from "../src/verifier/driver.js";
import { ScriptedVerifierModel, type ModelStep } from "../src/verifier/model.js";
import { ProtocolState } from "../src/verifier/protocol.js";
import { VerifyRequestSchema } from "../src/evidence/schemas.js";
import {
  CHALLENGE_DONE,
  PLAN_STEP,
  RESEARCH_DONE,
  adjudicateStep,
  fetchStep,
  fullProtocolScript,
  pricingPage,
  publicDns,
  searchStep,
  staticBackend,
} from "./fixtures.js";

/**
 * The three gates: registration, namespace enablement, and a matching
 * capability. Each is load-bearing, and the verifier's catalogue contains
 * nothing beyond research.
 */
describe("SharedOS permission boundary", () => {
  const request = VerifyRequestSchema.parse({
    task: "How much does Widget X cost?",
    candidateOutput: "Widget X costs $79.",
  });

  interface RunOverrides {
    grants?: ReturnType<typeof verifierGrants>;
    purpose?: string;
    enabledToolNamespaces?: readonly string[];
    script?: readonly ModelStep[];
  }

  async function runWith(overrides: RunOverrides) {
    const host = createTrustLayerHost({
      searchBackend: staticBackend(),
      resolveHost: publicDns,
      ...(overrides.grants === undefined ? {} : { grants: overrides.grants }),
    });
    const model = new ScriptedVerifierModel(overrides.script ?? [PLAN_STEP, adjudicateStep()]);
    const ledger = host.ledgers.open("trace-perm");
    const protocol = new ProtocolState();

    const driver = createVerifierDriver({
      model,
      request,
      ledger,
      protocol,
      toolCallBudget: 6,
    });

    const result = await runVerificationTurn({
      host,
      driver,
      executionId: "exec-perm",
      traceId: "trace-perm",
      payload: { service: "trust.verify" },
      ...(overrides.purpose === undefined ? {} : { purpose: overrides.purpose }),
      ...(overrides.enabledToolNamespaces === undefined
        ? {}
        : { enabledToolNamespaces: overrides.enabledToolNamespaces }),
    });

    return { host, model, result, protocol };
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers exactly the two research tools and nothing else", async () => {
    const { model, result } = await runWith({});

    expect([...model.offeredTools].sort()).toEqual(["research.fetch", "research.search"]);
    expect([...visibleToolsFrom(result.events)].sort()).toEqual([
      "research.fetch",
      "research.search",
    ]);
  });

  it("offers no files, repo, messaging, or escalation tool", async () => {
    const { model } = await runWith({});

    for (const prefix of ["files.", "repo.", "messages.", "sharedos."]) {
      expect(model.offeredTools.some((name) => name.startsWith(prefix))).toBe(false);
    }
  });

  it("hides research tools when the namespace is not enabled", async () => {
    // Registration and capability both hold; only the namespace gate is shut.
    const { model } = await runWith({ enabledToolNamespaces: [] });

    expect(model.offeredTools).toEqual([]);
  });

  it("hides research tools when the research grant is absent", async () => {
    // Registration and namespace both hold; only the capability is missing.
    const { model } = await runWith({ grants: verifierGrants({ withResearch: false }) });

    expect(model.offeredTools).toEqual([]);
  });

  it("denies the turn when the execution grant is absent", async () => {
    const { result } = await runWith({ grants: verifierGrants({ withExecution: false }) });

    expect(result.status).toBe("denied");
  });

  it("denies the turn when the purpose does not match the grant", async () => {
    // The grants are constrained to trust.verify; this turn claims another.
    const { result } = await runWith({ purpose: "some.other.purpose" });

    expect(result.status).toBe("denied");
  });

  it("refuses a tool the verifier was never granted, rather than running it", async () => {
    const { result, model } = await runWith({
      script: [
        PLAN_STEP,
        {
          kind: "tool_call",
          callId: "call-evil",
          toolName: "files.read",
          arguments: { path: ["home", "user", ".ssh", "id_rsa"] },
        },
        adjudicateStep(),
      ],
    });

    expect(result.status).toBe("succeeded");
    // The call came back as a refusal, and the model saw the refusal.
    expect(model.observations.at(-1)).toMatchObject({ kind: "tool_result", ok: false });

    const completed = result.events.filter((event) => event.type === "tool.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.data).toMatchObject({ tool: "files.read" });
    expect((completed[0]?.data as { status: string }).status).not.toBe("succeeded");
  });

  it("keeps a refused tool out of the receipt's provenance", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(pricingPage(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );

    const host = createTrustLayerHost({ searchBackend: staticBackend(), resolveHost: publicDns });
    const model = new ScriptedVerifierModel([
      PLAN_STEP,
      { kind: "tool_call", callId: "call-evil", toolName: "files.read", arguments: { path: ["etc"] } },
      searchStep("Widget X price", "call-1"),
      fetchStep("https://example.org/widget-x-pricing", "call-2"),
      RESEARCH_DONE,
      searchStep("Widget X price change", "call-3"),
      CHALLENGE_DONE,
      adjudicateStep(),
    ]);

    const receipt = await verify(request, { host, model });

    expect([...receipt.provenance.toolsUsed].sort()).toEqual(["research.fetch", "research.search"]);
    expect(receipt.provenance.toolsUsed).not.toContain("files.read");
  });

  it("re-authorizes each research call against the grant that permits it", async () => {
    const { host } = await runWith({
      script: [PLAN_STEP, searchStep("Widget X price", "call-1"), adjudicateStep()],
    });

    const checks = host.audit.events.filter((event) => event.type === "authorization.checked");
    const resources = checks.map(
      (event) => (event as unknown as { resource: { namespace: string; path: string[] } }).resource,
    );

    expect(resources).toContainEqual(expect.objectContaining({ namespace: "sharedos.execution" }));
    expect(resources).toContainEqual(
      expect.objectContaining({ namespace: "research", path: ["web"] }),
    );
  });

  it("authorizes a fetch against the exact hostname the arguments select", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(pricingPage(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );

    const { host } = await runWith({
      script: [
        PLAN_STEP,
        fetchStep("https://example.org/widget-x-pricing", "call-1"),
        adjudicateStep(),
      ],
    });

    const resources = host.audit.events
      .filter((event) => event.type === "authorization.checked")
      .map(
        (event) =>
          (event as unknown as { resource: { namespace: string; path: string[] } }).resource,
      );

    // Not the broad ["web"] ceiling — the exact destination.
    expect(resources).toContainEqual(
      expect.objectContaining({ namespace: "research", path: ["web", "example.org"] }),
    );
  });

  it("runs the whole protocol under one purpose", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(pricingPage(), {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );

    const host = createTrustLayerHost({ searchBackend: staticBackend(), resolveHost: publicDns });
    const model = new ScriptedVerifierModel(fullProtocolScript());

    await verify(request, { host, model });

    const purposes = new Set(
      host.audit.events.map((event) => (event as unknown as { purpose: string }).purpose),
    );
    expect([...purposes]).toEqual(["trust.verify"]);
  });
});
