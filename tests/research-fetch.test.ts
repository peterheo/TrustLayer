import { afterEach, describe, expect, it, vi } from "vitest";

import { EvidenceLedgerRegistry } from "../src/research/evidence-ledger.js";
import { createResearchFetchTool } from "../src/tools/research-fetch.js";
import { createVerificationContext } from "../src/sharedos/context.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import type { ToolCall } from "@aicoo/sharedos";

/**
 * `research.fetch` under the kernel, with the network stubbed.
 *
 * The point of these tests is the boundary rather than the HTTP: what the tool
 * refuses, what the kernel refuses on its behalf, and what reaches the ledger.
 */
describe("research.fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function call(url: string): ToolCall {
    return {
      id: "call-fetch",
      tool: "research.fetch",
      arguments: { url },
      traceId: "trace-fetch",
      requestedAt: "2026-09-07T00:00:00.000Z",
    };
  }

  /** Every hostname in these tests resolves to one public address. */
  const publicDns = async () => ["93.184.216.34"];

  function fetchTool(ledgers: EvidenceLedgerRegistry) {
    return createResearchFetchTool(ledgers, { resolve: publicDns });
  }

  function htmlResponse(body: string): Response {
    // `Response.url` is read-only here, so the tool falls back to the
    // requested URL, which is what a real redirect-free fetch would report.
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  it("returns sanitized page text as evidence and records it in the ledger", async () => {
    vi.stubGlobal("fetch", async () =>
      htmlResponse(
        `<html><head><title>Widget X pricing</title></head>
         <body><script>alert('x')</script><style>p{color:red}</style>
         <p>Widget X costs $79.</p><p>In stock.</p></body></html>`,
      ),
    );

    const ledgers = new EvidenceLedgerRegistry();
    const ledger = ledgers.open("trace-fetch");
    const tool = fetchTool(ledgers);
    const context = createVerificationContext({ traceId: "trace-fetch" });

    const result = await tool.invoke(context, call("https://example.com/p"), AbortSignal.timeout(5_000));

    expect(result.status).toBe("succeeded");
    const output = (result as { output: Record<string, unknown> }).output;
    expect(output["title"]).toBe("Widget X pricing");
    expect(String(output["text"])).toContain("Widget X costs $79.");
    // Script and style content is removed, not merely escaped.
    expect(String(output["text"])).not.toContain("alert");
    expect(String(output["text"])).not.toContain("color:red");

    expect(ledger.size).toBe(1);
    expect(ledger.get("src-1")?.via).toBe("research.fetch");
  });

  it("re-validates every redirect hop and refuses a public-to-metadata redirect", async () => {
    let hop = 0;
    vi.stubGlobal("fetch", async () => {
      hop += 1;
      if (hop === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      throw new Error("the second hop must never be attempted");
    });

    const ledgers = new EvidenceLedgerRegistry();
    ledgers.open("trace-fetch");
    const tool = fetchTool(ledgers);
    const context = createVerificationContext({ traceId: "trace-fetch" });

    const result = await tool.invoke(
      context,
      call("https://example.com/redirect"),
      AbortSignal.timeout(5_000),
    );

    expect(result.status).toBe("failed");
    expect((result as { error: { code: string } }).error.code).toBe(
      "url_rejected_metadata_service",
    );
    expect(hop).toBe(1);
  });

  it("refuses a public-to-loopback redirect", async () => {
    let hop = 0;
    vi.stubGlobal("fetch", async () => {
      hop += 1;
      if (hop === 1) {
        return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
      }
      throw new Error("the second hop must never be attempted");
    });

    const ledgers = new EvidenceLedgerRegistry();
    ledgers.open("trace-fetch");
    const tool = fetchTool(ledgers);
    const context = createVerificationContext({ traceId: "trace-fetch" });

    const result = await tool.invoke(
      context,
      call("https://example.com/redirect"),
      AbortSignal.timeout(5_000),
    );

    expect(result.status).toBe("failed");
    expect((result as { error: { code: string } }).error.code).toBe("url_rejected_loopback");
  });

  it("resolves its required capability to the hostname the arguments select", () => {
    const ledgers = new EvidenceLedgerRegistry();
    const tool = fetchTool(ledgers);
    const context = createVerificationContext({ traceId: "trace-fetch" });

    const requirement = tool.resolveRequirement?.(context, call("https://example.com/page"));

    expect(requirement).toMatchObject({
      resource: { namespace: "research", path: ["web", "example.com"] },
      action: "fetch",
    });
    // The declared discovery ceiling is broader than the resolved requirement.
    expect(tool.definition.requiredCapability.resource.path).toEqual(["web"]);
  });

  it("refuses to resolve a requirement for a URL the policy rejects", () => {
    const ledgers = new EvidenceLedgerRegistry();
    const tool = fetchTool(ledgers);
    const context = createVerificationContext({ traceId: "trace-fetch" });

    expect(() => tool.resolveRequirement?.(context, call("http://127.0.0.1/admin"))).toThrow();
  });

  it("is refused by the kernel before the tool body runs, for a rejected URL", async () => {
    // A network call here would mean the refusal happened too late.
    vi.stubGlobal("fetch", async () => {
      throw new Error("no request may be made for a rejected URL");
    });

    const host = createTrustLayerHost();
    const context = createVerificationContext({ traceId: "trace-fetch" });

    const result = await host.kernel.invokeTool(context, call("http://169.254.169.254/latest/"));

    expect(result.status).not.toBe("succeeded");
    expect((result as { error: { code: string } }).error.code).toBe(
      "tool_requirement_resolution_failed",
    );
  });

  it("rejects a non-text response rather than treating bytes as evidence", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response("binary", { status: 200, headers: { "content-type": "image/png" } }),
    );

    const ledgers = new EvidenceLedgerRegistry();
    const ledger = ledgers.open("trace-fetch");
    const tool = fetchTool(ledgers);
    const context = createVerificationContext({ traceId: "trace-fetch" });

    const result = await tool.invoke(
      context,
      call("https://example.com/image.png"),
      AbortSignal.timeout(5_000),
    );

    expect(result.status).toBe("failed");
    expect((result as { error: { code: string } }).error.code).toBe("unsupported_content_type");
    expect(ledger.size).toBe(0);
  });

  it("sends no cookies, no referrer, and no caller headers", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_url: unknown, init: RequestInit) => {
      seen.push(init);
      return htmlResponse("<p>ok</p>");
    });

    const ledgers = new EvidenceLedgerRegistry();
    ledgers.open("trace-fetch");
    const tool = fetchTool(ledgers);
    const context = createVerificationContext({ traceId: "trace-fetch" });

    await tool.invoke(context, call("https://example.com/p"), AbortSignal.timeout(5_000));

    expect(seen[0]?.credentials).toBe("omit");
    expect(seen[0]?.referrerPolicy).toBe("no-referrer");
    expect(seen[0]?.redirect).toBe("manual");
    const headers = seen[0]?.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["Accept", "User-Agent"]);
  });
});
