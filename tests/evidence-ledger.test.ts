import { describe, expect, it } from "vitest";

import { EvidenceLedger, EvidenceLedgerRegistry } from "../src/evidence/ledger.js";
import { sha256 } from "../src/evidence/digest.js";

/**
 * The ledger is the boundary between "a search suggested this" and "we
 * retrieved this". Everything the receipt claims about provenance rests on it.
 */
describe("evidence ledger", () => {
  const now = "2026-09-07T12:00:00.000Z";

  function evidenceInput(url = "https://example.org/page") {
    return {
      url,
      resolvedUrl: url,
      title: "A page",
      extractedText: "Widget X costs $79.",
      sourceToolCallId: "call-1",
      origin: "independent" as const,
      instructionLikeContent: false,
    };
  }

  describe("search candidates are not evidence", () => {
    it("records a candidate without creating evidence", () => {
      const ledger = new EvidenceLedger();

      const candidate = ledger.addSearchCandidate(
        { url: "https://example.org/page", query: "widget x price", phase: "discover" },
        now,
      );

      expect(candidate.candidateId).toBe("c1");
      expect(ledger.candidateCount).toBe(1);
      // Discovery produced nothing citable.
      expect(ledger.evidenceCount).toBe(0);
      expect(ledger.hasEvidence("c1")).toBe(false);
      expect(ledger.hasEvidence("e1")).toBe(false);
    });

    it("uses separate identifier spaces for candidates and evidence", () => {
      const ledger = new EvidenceLedger();
      ledger.addSearchCandidate({ url: "https://a.example/1", query: "q", phase: "discover" }, now);
      const record = ledger.addEvidence(evidenceInput(), now);

      expect(record.evidenceId).toBe("e1");
      // A candidate ID can never be mistaken for an evidence ID.
      expect(ledger.hasEvidence("c1")).toBe(false);
    });

    it("does not double-count a URL discovered twice", () => {
      const ledger = new EvidenceLedger();
      const first = ledger.addSearchCandidate(
        { url: "https://example.org/page", query: "one", phase: "discover" },
        now,
      );
      const second = ledger.addSearchCandidate(
        { url: "https://example.org/page", query: "two", phase: "challenge" },
        now,
      );

      expect(second.candidateId).toBe(first.candidateId);
      expect(ledger.candidateCount).toBe(1);
    });
  });

  describe("evidence provenance is host-generated", () => {
    it("mints identity, timestamp, domain and digest itself", () => {
      const ledger = new EvidenceLedger();

      const record = ledger.addEvidence(evidenceInput(), now);

      expect(record.evidenceId).toBe("e1");
      expect(record.retrievedAt).toBe(now);
      expect(record.domain).toBe("example.org");
      expect(record.contentSha256).toBe(sha256("Widget X costs $79."));
      expect(record.sourceToolCallId).toBe("call-1");
    });

    it("digests the exact text the verifier read", () => {
      const ledger = new EvidenceLedger();
      const record = ledger.addEvidence(
        { ...evidenceInput(), extractedText: "different text" },
        now,
      );

      expect(record.contentSha256).toBe(sha256("different text"));
      expect(record.contentSha256).not.toBe(sha256("Widget X costs $79."));
    });

    it("takes the domain from the resolved URL, after redirects", () => {
      const ledger = new EvidenceLedger();
      const record = ledger.addEvidence(
        {
          ...evidenceInput("https://short.example/abc"),
          resolvedUrl: "https://docs.example.org/real-page",
        },
        now,
      );

      expect(record.url).toBe("https://short.example/abc");
      expect(record.resolvedUrl).toBe("https://docs.example.org/real-page");
      expect(record.domain).toBe("docs.example.org");
    });

    it("links a fetch back to the candidate that proposed it", () => {
      const ledger = new EvidenceLedger();
      ledger.addSearchCandidate(
        { url: "https://example.org/page", query: "q", phase: "discover" },
        now,
      );

      const record = ledger.addEvidence(evidenceInput("https://example.org/page"), now);

      expect(record.searchCandidateId).toBe("c1");
    });

    it("leaves the candidate link unset for a URL nothing discovered", () => {
      const ledger = new EvidenceLedger();
      const record = ledger.addEvidence(evidenceInput("https://direct.example/page"), now);

      expect(record.searchCandidateId).toBeUndefined();
    });
  });

  describe("candidate citations", () => {
    it("distinguishes a caller-supplied source from an independently found one", () => {
      const ledger = new EvidenceLedger();
      ledger.registerCandidateCitations(["https://candidate.example/cited"]);

      expect(ledger.isCandidateCitation("https://candidate.example/cited")).toBe(true);
      expect(ledger.isCandidateCitation("https://example.org/found")).toBe(false);
      expect(ledger.candidateCitationCount).toBe(1);
    });

    it("counts only candidate citations that were actually fetched", () => {
      const ledger = new EvidenceLedger();
      ledger.registerCandidateCitations(["https://candidate.example/a", "https://candidate.example/b"]);

      ledger.addEvidence(
        { ...evidenceInput("https://candidate.example/a"), origin: "candidate_citation" },
        now,
      );

      expect(ledger.candidateCitationCount).toBe(2);
      expect(ledger.fetchedCandidateCitations()).toHaveLength(1);
    });
  });

  describe("phase attribution", () => {
    it("tags candidates with the phase the driver was in", () => {
      const ledger = new EvidenceLedger();

      ledger.setPhase("discover");
      ledger.addSearchCandidate({ url: "https://a.example/1", query: "q", phase: ledger.phase }, now);
      ledger.setPhase("challenge");
      ledger.addSearchCandidate({ url: "https://b.example/2", query: "q", phase: ledger.phase }, now);

      expect(ledger.candidatesFromPhase("discover")).toHaveLength(1);
      expect(ledger.candidatesFromPhase("challenge")).toHaveLength(1);
    });
  });

  it("counts distinct domains for coverage", () => {
    const ledger = new EvidenceLedger();
    ledger.addEvidence(evidenceInput("https://a.example/1"), now);
    ledger.addEvidence(evidenceInput("https://a.example/2"), now);
    ledger.addEvidence(evidenceInput("https://b.example/1"), now);

    expect(ledger.evidenceCount).toBe(3);
    expect(ledger.distinctDomains()).toBe(2);
  });
});

describe("ledger registry isolation", () => {
  const now = "2026-09-07T12:00:00.000Z";

  it("keeps one execution's evidence out of another's", () => {
    const registry = new EvidenceLedgerRegistry();
    const first = registry.open("trace-a");
    const second = registry.open("trace-b");

    first.addEvidence(
      {
        url: "https://example.org/a",
        resolvedUrl: "https://example.org/a",
        extractedText: "text",
        sourceToolCallId: "call-1",
        origin: "independent",
        instructionLikeContent: false,
      },
      now,
    );

    expect(first.hasEvidence("e1")).toBe(true);
    // e1 exists in one execution and means nothing in the other.
    expect(second.hasEvidence("e1")).toBe(false);
  });

  it("hands an unknown trace a detached ledger that validates nothing", () => {
    const registry = new EvidenceLedgerRegistry();
    registry.open("trace-a");

    expect(registry.for("trace-unknown").hasEvidence("e1")).toBe(false);
    expect(registry.for("trace-unknown").evidenceCount).toBe(0);
  });

  it("closes a ledger when its execution ends", () => {
    const registry = new EvidenceLedgerRegistry();
    const ledger = registry.open("trace-a");
    ledger.addEvidence(
      {
        url: "https://example.org/a",
        resolvedUrl: "https://example.org/a",
        extractedText: "text",
        sourceToolCallId: "call-1",
        origin: "independent",
        instructionLikeContent: false,
      },
      now,
    );

    registry.close("trace-a");

    expect(registry.for("trace-a").hasEvidence("e1")).toBe(false);
  });
});
