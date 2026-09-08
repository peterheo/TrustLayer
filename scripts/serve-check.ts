/**
 * Boots the real HTTP service and calls it over the wire, offline.
 *
 * Proves the deployable path end to end — server, routing, auth, receipt —
 * without a model provider or a network.
 */
import { serve } from "../src/api/http.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { StaticSearchBackend } from "../src/tools/search-backend.js";
import { ScriptedVerifierModel } from "../src/verifier/model.js";
import {
  SUBMIT_ADJUDICATION,
  SUBMIT_CHALLENGE_COMPLETE,
  SUBMIT_PLAN,
  SUBMIT_RESEARCH_COMPLETE,
} from "../src/verifier/prompts.js";

const PAGES: Record<string, string> = {
  "https://acme.example/store/widget-pro":
    "<html><head><title>Widget Pro</title></head><body><p>The Acme Widget Pro is priced at $79.00.</p></body></html>",
  "https://reviews.example/widget-pro":
    "<html><head><title>Review</title></head><body><p>At $79 the Widget Pro undercuts competitors.</p></body></html>",
};

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : String((input as { url?: unknown }).url ?? "");
  // Our own server is on localhost; everything else is served from the corpus.
  if (url.startsWith("http://127.0.0.1")) return realFetch(input as string, init);
  const body = PAGES[url];
  if (body === undefined) return new Response("Not Found", { status: 404 });
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}) as typeof globalThis.fetch;

const host = createTrustLayerHost({
  searchBackend: new StaticSearchBackend([
    { url: "https://acme.example/store/widget-pro", title: "Widget Pro", snippet: "$79.00" },
    { url: "https://reviews.example/widget-pro", title: "Review", snippet: "undercuts" },
  ]),
  resolveHost: async () => ["93.184.216.34"],
});

const model = new ScriptedVerifierModel([
  {
    kind: "submit",
    submission: SUBMIT_PLAN,
    payload: {
      claims: [{ text: "The Acme Widget Pro costs $79.", importance: "critical", freshness: "current" }],
    },
  },
  { kind: "tool_call", callId: "s1", toolName: "research.search", arguments: { query: "Widget Pro price" } },
  { kind: "tool_call", callId: "f1", toolName: "research.fetch", arguments: { url: "https://acme.example/store/widget-pro" } },
  { kind: "submit", submission: SUBMIT_RESEARCH_COMPLETE, payload: {} },
  { kind: "tool_call", callId: "s2", toolName: "research.search", arguments: { query: "Widget Pro price wrong" } },
  { kind: "tool_call", callId: "f2", toolName: "research.fetch", arguments: { url: "https://reviews.example/widget-pro" } },
  { kind: "submit", submission: SUBMIT_CHALLENGE_COMPLETE, payload: {} },
  {
    kind: "submit",
    submission: SUBMIT_ADJUDICATION,
    payload: {
      summary: "The manufacturer's page lists $79.00.",
      adjudications: [
        {
          claimId: "k1",
          status: "supported",
          confidence: 0.9,
          rationale: "The store page lists $79.00.",
          evidence: [
            { evidenceId: "e1", relation: "supports", note: "store page", quote: "priced at $79.00" },
          ],
        },
      ],
      suspiciousInstructions: { detected: false, indicators: [] },
    },
  },
]);

const server = await serve({ port: 8123, hostname: "127.0.0.1", token: "demo-token", verifyOptions: { host, model } });

const base = "http://127.0.0.1:8123";
const health = await (await realFetch(`${base}/health`)).json();
console.log("\n=== GET /health ===");
console.log(health);

const services = await (await realFetch(`${base}/v1/services`)).json();
console.log("\n=== GET /v1/services ===");
console.log((services as { services: { name: string; price_credits: number }[] }).services.map((s) => `${s.name} (${s.price_credits} credits)`));

const unauthorized = await realFetch(`${base}/v1/trust.verify`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ task: "t", candidate_output: "o" }),
});
console.log("\n=== POST without token ===");
console.log(unauthorized.status, await unauthorized.json());

const response = await realFetch(`${base}/v1/trust.verify`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer demo-token" },
  body: JSON.stringify({
    task: "How much does the Acme Widget Pro cost?",
    candidate_output: "The Acme Widget Pro costs $79.",
  }),
});

console.log("\n=== POST /v1/trust.verify ===");
console.log(response.status);
const payload = (await response.json()) as { ok: boolean; receipt: Record<string, unknown> };
const receipt = payload.receipt;
console.log({
  overallStatus: receipt["overallStatus"],
  protocolStatus: receipt["protocolStatus"],
  methodVersion: receipt["methodVersion"],
  claims: (receipt["claims"] as unknown[]).length,
  evidence: (receipt["evidence"] as unknown[]).length,
  spans: ((receipt["claims"] as { spans?: unknown[] }[])[0]?.spans ?? []).length,
  provenance: receipt["provenance"],
});

await server.close();
