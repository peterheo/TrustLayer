/**
 * Offline smoke test.
 *
 * Runs one real `trust.verify` turn on the SharedOS kernel with a scripted
 * model and a fixed corpus, then prints the response and the SharedOS audit
 * trail. No API key, no network.
 *
 *   pnpm smoke
 */
import { handleServiceCall } from "../src/arena/adapter.js";
import { ScriptedVerifierModel } from "../src/agent/model.js";
import { StaticSearchBackend } from "../src/research/search-backend.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";

const corpus = [
  {
    url: "https://example.org/widget-x-pricing",
    title: "Widget X official pricing",
    snippet: "Widget X is listed at $79.00 on the manufacturer's store page.",
    publishedAt: "2026-08-01",
  },
  {
    url: "https://example.net/widget-review",
    title: "Widget X hands-on review",
    snippet: "At $79 the Widget X undercuts most of its competitors.",
  },
];

const host = createTrustLayerHost({ searchBackend: new StaticSearchBackend(corpus) });

const model = new ScriptedVerifierModel([
  {
    kind: "tool_call",
    callId: "call-1",
    toolName: "research.search",
    arguments: { query: "Widget X price" },
  },
  {
    kind: "final",
    output: {
      summary: "The price claim is supported by the manufacturer's listing.",
      claims: [
        {
          claim: "Widget X costs $79.",
          importance: 3,
          status: "supported",
          confidence: 0.9,
          rationale: "The official pricing page lists $79.00.",
          evidence: [
            { sourceId: "src-1", relation: "supports", note: "Official pricing page lists $79.00." },
          ],
        },
      ],
      security: {
        promptInjectionRisk: "none",
        indicators: [],
        instructionsFollowedFromEvidence: false,
      },
    },
  },
]);

const outcome = await handleServiceCall(
  {
    task: "How much does Widget X cost?",
    candidate_output: "Widget X costs $79.",
  },
  { host, model },
);

console.log("\n=== trust.verify response ===");
console.log(JSON.stringify(outcome, null, 2));

console.log("\n=== tool catalogue offered to the verifier ===");
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

if (!outcome.ok) process.exitCode = 1;
