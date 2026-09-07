/**
 * Offline smoke test.
 *
 * Runs one real `trust.verify` execution on the SharedOS kernel with a scripted
 * model and a fixed corpus, then prints the evidence receipt and the SharedOS
 * audit trail. No API key, no network.
 *
 *   pnpm smoke
 */
import { handleServiceCall } from "../src/arena/adapter.js";
import { StaticSearchBackend } from "../src/tools/search-backend.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { ScriptedVerifierModel } from "../src/verifier/model.js";
import {
  SUBMIT_ADJUDICATION,
  SUBMIT_CHALLENGE_COMPLETE,
  SUBMIT_PLAN,
  SUBMIT_RESEARCH_COMPLETE,
} from "../src/verifier/prompts.js";

const PAGES: Record<string, string> = {
  "https://acme.example/store/widget-pro": `<html><head><title>Widget Pro — Acme Store</title></head>
    <body><script>track()</script><p>The Acme Widget Pro is priced at $79.00 including a two-year warranty.</p></body></html>`,
  "https://reviews.example/widget-pro": `<html><head><title>Widget Pro review</title></head>
    <body><p>At $79 the Widget Pro undercuts most competitors. Price checked September 2026.</p></body></html>`,
};

const originalFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : String((input as { url?: unknown }).url ?? "");
  const body = PAGES[url];
  if (body === undefined) return new Response("Not Found", { status: 404 });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}) as typeof globalThis.fetch;

const host = createTrustLayerHost({
  searchBackend: new StaticSearchBackend([
    {
      url: "https://acme.example/store/widget-pro",
      title: "Widget Pro — Acme Store",
      snippet: "Widget Pro is $79.00.",
    },
    {
      url: "https://reviews.example/widget-pro",
      title: "Widget Pro review",
      snippet: "At $79 the Widget Pro undercuts most competitors.",
    },
  ]),
  resolveHost: async () => ["93.184.216.34"],
});

const model = new ScriptedVerifierModel([
  {
    kind: "submit",
    submission: SUBMIT_PLAN,
    payload: {
      claims: [
        { text: "The Acme Widget Pro costs $79.", importance: "critical", freshness: "current" },
      ],
    },
  },
  { kind: "tool_call", callId: "s1", toolName: "research.search", arguments: { query: "Acme Widget Pro price" } },
  {
    kind: "tool_call",
    callId: "f1",
    toolName: "research.fetch",
    arguments: { url: "https://acme.example/store/widget-pro" },
  },
  { kind: "submit", submission: SUBMIT_RESEARCH_COMPLETE, payload: {} },
  {
    kind: "tool_call",
    callId: "s2",
    toolName: "research.search",
    arguments: { query: "Acme Widget Pro price increase 2026" },
  },
  {
    kind: "tool_call",
    callId: "f2",
    toolName: "research.fetch",
    arguments: { url: "https://reviews.example/widget-pro" },
  },
  { kind: "submit", submission: SUBMIT_CHALLENGE_COMPLETE, payload: {} },
  {
    kind: "submit",
    submission: SUBMIT_ADJUDICATION,
    payload: {
      summary:
        "Two independently retrieved sources list the Widget Pro at $79.00, and a search for a " +
        "price change found none.",
      adjudications: [
        {
          claimId: "k1",
          status: "supported",
          confidence: 0.9,
          rationale: "The Acme store page and an independent review both state $79.00.",
          evidence: [
            { evidenceId: "e1", relation: "supports", note: "Acme store page lists $79.00." },
            { evidenceId: "e2", relation: "supports", note: "Review confirms $79 as of Sept 2026." },
          ],
        },
      ],
      suspiciousInstructions: { detected: false, indicators: [] },
    },
  },
]);

const outcome = await handleServiceCall(
  {
    task: "How much does the Acme Widget Pro cost?",
    candidate_output: "The Acme Widget Pro costs $79.",
  },
  { host, model },
);

globalThis.fetch = originalFetch;

console.log("\n=== Evidence receipt ===");
console.log(JSON.stringify(outcome, null, 2));

console.log("\n=== Tool catalogue offered to the verifier ===");
console.log(model.offeredTools);

console.log("\n=== SharedOS audit trail ===");
for (const event of host.audit.events) {
  const record = event as unknown as {
    type: string;
    outcome?: string;
    purpose: string;
    tool?: string;
    resource?: { namespace: string; path: string[] };
  };
  const target =
    record.tool ??
    (record.resource === undefined
      ? ""
      : `${record.resource.namespace}/${record.resource.path.join("/")}`);
  console.log(
    `  ${record.type.padEnd(24)} ${(record.outcome ?? "").padEnd(10)} ${record.purpose.padEnd(14)} ${target}`,
  );
}

if (outcome.ok) {
  console.log("\n=== What the receipt establishes ===");
  console.log(`  protocol status:   ${outcome.receipt.protocolStatus}`);
  console.log(`  overall status:    ${outcome.receipt.overallStatus}`);
  console.log(`  method version:    ${outcome.receipt.methodVersion}`);
  console.log(`  sources retrieved: ${outcome.receipt.coverage.sourcesFetched}`);
  console.log(`  distinct domains:  ${outcome.receipt.coverage.distinctDomains}`);
  console.log("  checks:");
  for (const [name, value] of Object.entries(outcome.receipt.checks)) {
    console.log(`    ${name.padEnd(30)} ${value}`);
  }
} else {
  console.log(`\ncall failed: ${outcome.error.code}`);
  process.exitCode = 1;
}
