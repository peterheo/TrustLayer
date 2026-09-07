import { describe, expect, it } from "vitest";

import { ScriptedVerifierModel } from "../src/agent/model.js";
import { createVerifierDriver } from "../src/agent/verifier-driver.js";
import { verify } from "../src/api/verify.js";
import { visibleToolsFrom } from "../src/sharedos/audit.js";
import { runVerificationTurn } from "../src/sharedos/executor.js";
import { verifierGrants } from "../src/sharedos/grants.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { judgment, searchThenSubmit, staticBackend } from "./fixtures.js";

/**
 * The three gates: registration, namespace enablement, and a matching
 * capability. These tests assert that each one is load-bearing, and that the
 * verifier's catalogue contains nothing beyond research.
 */
describe("SharedOS permission boundary", () => {
  const payload = { task: "verify something" };

  interface RunOverrides {
    grants?: ReturnType<typeof verifierGrants>;
    purpose?: string;
    enabledToolNamespaces?: readonly string[];
    script?: ConstructorParameters<typeof ScriptedVerifierModel>[0];
  }

  async function runWith(overrides: RunOverrides) {
    const host = createTrustLayerHost({
      searchBackend: staticBackend(),
      ...(overrides.grants === undefined ? {} : { grants: overrides.grants }),
    });
    const model = new ScriptedVerifierModel(
      overrides.script ?? [{ kind: "final", output: judgment() }],
    );
    host.ledgers.open("trace-perm");
    const result = await runVerificationTurn({
      host,
      driver: createVerifierDriver(model),
      executionId: "exec-perm",
      traceId: "trace-perm",
      payload,
      ...(overrides.purpose === undefined ? {} : { purpose: overrides.purpose }),
      ...(overrides.enabledToolNamespaces === undefined
        ? {}
        : { enabledToolNamespaces: overrides.enabledToolNamespaces }),
    });
    return { host, model, result };
  }

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

    const forbiddenPrefixes = ["files.", "repo.", "messages.", "sharedos."];
    for (const name of model.offeredTools) {
      for (const prefix of forbiddenPrefixes) {
        expect(name.startsWith(prefix)).toBe(false);
      }
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
    // The model guesses at a file tool that is not in its catalogue.
    const { result, model } = await runWith({
      script: [
        {
          kind: "tool_call",
          callId: "call-evil",
          toolName: "files.read",
          arguments: { path: ["home", "user", ".ssh", "id_rsa"] },
        },
        { kind: "final", output: judgment() },
      ],
    });

    expect(result.status).toBe("succeeded");
    // The call came back as a refusal, and the model saw the refusal.
    const observation = model.observations.at(-1);
    expect(observation).toMatchObject({ kind: "tool_result", ok: false });

    const completed = result.events.filter((event) => event.type === "tool.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.data).toMatchObject({ tool: "files.read" });
    expect((completed[0]?.data as { status: string }).status).not.toBe("succeeded");
  });

  it("keeps a refused tool out of the audit block's toolsUsed", async () => {
    const host = createTrustLayerHost({ searchBackend: staticBackend() });
    const model = new ScriptedVerifierModel([
      {
        kind: "tool_call",
        callId: "call-evil",
        toolName: "files.read",
        arguments: { path: ["etc", "passwd"] },
      },
      { kind: "final", output: judgment({ claims: [] }) },
    ]);

    const response = await verify(
      { task: "t", candidateOutput: "c" },
      { host, model },
    );

    expect(response.audit.toolsUsed).toEqual([]);
  });

  it("re-authorizes each research call against the grant that permits it", async () => {
    const host = createTrustLayerHost({ searchBackend: staticBackend() });
    const model = new ScriptedVerifierModel(searchThenSubmit(judgment()));

    await verify({ task: "t", candidateOutput: "Widget X costs $79." }, { host, model });

    const checks = host.audit.events.filter((event) => event.type === "authorization.checked");
    const resources = checks.map(
      (event) => (event as unknown as { resource: { namespace: string; path: string[] } }).resource,
    );
    // One check admitting the turn, one authorizing the search.
    expect(resources).toContainEqual(
      expect.objectContaining({ namespace: "sharedos.execution" }),
    );
    expect(resources).toContainEqual(
      expect.objectContaining({ namespace: "research", path: ["web"] }),
    );
  });
});
