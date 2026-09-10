import { afterEach, describe, expect, it, vi } from "vitest";

import { verify } from "../src/api/verify.js";
import { canonicalJson, canonicalSha256, sha256 } from "../src/evidence/digest.js";
import { EvidenceLedger } from "../src/evidence/ledger.js";
import { countDuplicateSources, deriveCounts, verifyReceiptDigest } from "../src/evidence/receipt.js";
import { createTrustLayerHost } from "../src/sharedos/kernel.js";
import { ScriptedVerifierModel } from "../src/verifier/model.js";
import type { ReceiptClaim } from "../src/evidence/schemas.js";
import { fullProtocolScript, pricingPage, publicDns, staticBackend } from "./fixtures.js";

/**
 * What a receipt holder can check for themselves.
 *
 * A receipt is a portable artifact: it gets forwarded, quoted and argued over
 * by people who were not there when it was issued. So it pins what was
 * submitted, counts its own claims, and carries a digest anyone can recompute.
 */
describe("receipt integrity", () => {
  const request = {
    task: "How much does Widget X cost?",
    candidateOutput: "Widget X costs $79.",
  };

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

  describe("canonical form", () => {
    it("does not depend on the order fields were built in", () => {
      // A hash that moves when a refactor reorders a literal would invalidate
      // every receipt already issued.
      expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
      expect(canonicalSha256({ x: [1, { q: 1, p: 2 }] })).toBe(
        canonicalSha256({ x: [1, { p: 2, q: 1 }] }),
      );
    });

    it("distinguishes values that really differ", () => {
      expect(canonicalSha256({ a: 1 })).not.toBe(canonicalSha256({ a: 2 }));
      expect(canonicalSha256({ a: "1" })).not.toBe(canonicalSha256({ a: 1 }));
    });
  });

  it("pins the exact output that was verified", async () => {
    stubPages();
    const receipt = await verify(request, {
      host: host(),
      model: new ScriptedVerifierModel(fullProtocolScript()),
    });

    expect(receipt.input.candidateOutputSha256).toBe(sha256(request.candidateOutput));
    expect(receipt.input.requestSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("carries a digest the holder can recompute", async () => {
    stubPages();
    const receipt = await verify(request, {
      host: host(),
      model: new ScriptedVerifierModel(fullProtocolScript()),
    });

    expect(receipt.receiptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(verifyReceiptDigest(receipt)).toBe(true);
  });

  it("notices a receipt that was edited after it was issued", async () => {
    stubPages();
    const receipt = await verify(request, {
      host: host(),
      model: new ScriptedVerifierModel(fullProtocolScript()),
    });

    // The upgrade someone would most want to make to a receipt they were handed.
    const tampered = { ...receipt, overallStatus: "supported" as const, claims: [] };
    expect(verifyReceiptDigest(tampered)).toBe(false);
  });

  it("counts the claim table rather than restating the prose", () => {
    const claim = (status: ReceiptClaim["status"]): ReceiptClaim => ({
      claimId: "k",
      claim: "c",
      importance: "material",
      status,
      confidence: 0.5,
      rationale: "r",
      evidence: [],
    });
    const claims = [
      claim("supported"),
      claim("supported"),
      claim("contradicted"),
      claim("not_falsifiable"),
    ];

    expect(deriveCounts(claims)).toEqual({
      supported: 2,
      contradicted: 1,
      unverified: 0,
      notFalsifiable: 1,
    });
  });

  describe("duplicate sources", () => {
    const now = "2026-09-10T00:00:00.000Z";

    function ledgerWith(pages: readonly { url: string; text: string }[]): EvidenceLedger {
      const ledger = new EvidenceLedger();
      for (const page of pages) {
        ledger.addEvidence(
          {
            url: page.url,
            resolvedUrl: page.url,
            extractedText: page.text,
            sourceToolCallId: "call-1",
            origin: "independent",
            instructionLikeContent: false,
          },
          now,
        );
      }
      return ledger;
    }

    it("counts nothing when every source is its own", () => {
      const ledger = ledgerWith([
        { url: "https://a.example/p", text: "one" },
        { url: "https://b.example/p", text: "two" },
      ]);
      expect(countDuplicateSources(ledger)).toBe(0);
    });

    it("counts the same page fetched twice", () => {
      // Two evidence ids, one source: a claim "backed by two sources" here is
      // backed by one, which is the overstatement this product exists to catch.
      const ledger = ledgerWith([
        { url: "https://a.example/p", text: "one" },
        { url: "https://A.example/p/", text: "one" },
      ]);
      expect(countDuplicateSources(ledger)).toBe(1);
    });

    it("counts two URLs that returned byte-identical text", () => {
      // A mirror or a syndication is still one source.
      const ledger = ledgerWith([
        { url: "https://a.example/p", text: "identical body" },
        { url: "https://mirror.example/p", text: "identical body" },
      ]);
      expect(countDuplicateSources(ledger)).toBe(1);
    });

    it("reports the count in the receipt", async () => {
      stubPages();
      const receipt = await verify(request, {
        host: host(),
        model: new ScriptedVerifierModel(fullProtocolScript()),
      });

      // The fixture serves the same page for both fetches, so the second
      // retrieval is not a second source, and the receipt says so.
      expect(receipt.coverage.sourcesFetched).toBe(2);
      expect(receipt.coverage.duplicateSources).toBe(1);
    });
  });

  it("reports how many tool calls SharedOS refused", async () => {
    stubPages();
    const receipt = await verify(request, {
      host: host(),
      model: new ScriptedVerifierModel(fullProtocolScript()),
    });

    // Nothing reached for authority it did not hold in this run.
    expect(receipt.provenance.permissionDenials).toBe(0);
  });
});
