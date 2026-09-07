import { IdSequence, domainOf, sha256 } from "./digest.js";
import type {
  EvidenceOrigin,
  EvidenceRecord,
  SearchCandidate,
} from "./schemas.js";

/**
 * The evidence ledger: everything discovery proposed and everything retrieval
 * actually produced, for one verification execution.
 *
 * This is core product infrastructure rather than a helper. It is the only
 * writer of evidence identity, the only place a retrieval timestamp or content
 * digest is produced, and the sole authority the receipt validator consults
 * when deciding whether a citation refers to anything real.
 */

export interface AddCandidateInput {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly query: string;
  readonly phase: string;
}

export interface AddEvidenceInput {
  readonly url: string;
  readonly resolvedUrl: string;
  readonly title?: string;
  readonly extractedText: string;
  readonly sourceToolCallId: string;
  readonly origin: EvidenceOrigin;
  readonly instructionLikeContent: boolean;
}

export class EvidenceLedger {
  readonly #candidates = new Map<string, SearchCandidate>();
  readonly #candidatesByUrl = new Map<string, string>();
  readonly #evidence = new Map<string, EvidenceRecord>();
  readonly #candidateIds = new IdSequence("c");
  readonly #evidenceIds = new IdSequence("e");
  readonly #candidateCitationUrls = new Set<string>();
  #phase = "discover";

  /**
   * The protocol phase tool calls are currently attributed to.
   *
   * Set by the driver before it hands a call to SharedOS, never by the model
   * and never from tool arguments — which is what lets the receipt state that
   * a contradiction search really happened rather than take the model's word.
   */
  setPhase(phase: string): void {
    this.#phase = phase;
  }

  get phase(): string {
    return this.#phase;
  }

  /**
   * URLs the caller supplied as the candidate's own citations.
   *
   * Registered by the host from the validated request, so a fetch of one of
   * them is recorded as `candidate_citation` rather than counting as
   * independently discovered evidence.
   */
  registerCandidateCitations(urls: readonly string[]): void {
    for (const url of urls) this.#candidateCitationUrls.add(url);
  }

  isCandidateCitation(url: string): boolean {
    return this.#candidateCitationUrls.has(url);
  }

  get candidateCitationCount(): number {
    return this.#candidateCitationUrls.size;
  }

  /** Candidate-supplied citations that were actually fetched. */
  fetchedCandidateCitations(): readonly EvidenceRecord[] {
    return this.listEvidence().filter((record) => record.origin === "candidate_citation");
  }

  /**
   * Record a source discovery proposed.
   *
   * Returns the existing candidate when the same URL is proposed twice, so
   * repeated searches do not inflate the discovery count.
   */
  addSearchCandidate(input: AddCandidateInput, now: string): SearchCandidate {
    const existingId = this.#candidatesByUrl.get(input.url);
    const existing = existingId === undefined ? undefined : this.#candidates.get(existingId);
    if (existing !== undefined) return existing;

    const candidate: SearchCandidate = {
      candidateId: this.#candidateIds.mint(),
      url: input.url,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.snippet === undefined ? {} : { snippet: input.snippet }),
      query: input.query,
      discoveredAt: now,
      phase: input.phase,
    };
    this.#candidates.set(candidate.candidateId, candidate);
    this.#candidatesByUrl.set(candidate.url, candidate.candidateId);
    return candidate;
  }

  /**
   * Record a source that was actually retrieved.
   *
   * The identifier, timestamp, domain and digest are minted here; the caller
   * supplies only what it genuinely observed. When the fetched URL matches a
   * previously discovered candidate, the link is recorded so the receipt can
   * show that retrieval followed discovery.
   */
  addEvidence(input: AddEvidenceInput, now: string): EvidenceRecord {
    const candidateId =
      this.#candidatesByUrl.get(input.url) ?? this.#candidatesByUrl.get(input.resolvedUrl);

    const record: EvidenceRecord = {
      evidenceId: this.#evidenceIds.mint(),
      url: input.url,
      resolvedUrl: input.resolvedUrl,
      domain: domainOf(input.resolvedUrl) || domainOf(input.url),
      ...(input.title === undefined ? {} : { title: input.title }),
      retrievedAt: now,
      extractedText: input.extractedText,
      contentSha256: sha256(input.extractedText),
      sourceToolCallId: input.sourceToolCallId,
      ...(candidateId === undefined ? {} : { searchCandidateId: candidateId }),
      origin: input.origin,
      instructionLikeContent: input.instructionLikeContent,
    };
    this.#evidence.set(record.evidenceId, record);
    return record;
  }

  getEvidence(evidenceId: string): EvidenceRecord | undefined {
    return this.#evidence.get(evidenceId);
  }

  hasEvidence(evidenceId: string): boolean {
    return this.#evidence.has(evidenceId);
  }

  listEvidence(): readonly EvidenceRecord[] {
    return [...this.#evidence.values()];
  }

  listSearchCandidates(): readonly SearchCandidate[] {
    return [...this.#candidates.values()];
  }

  /** Candidates proposed by searches made during one protocol phase. */
  candidatesFromPhase(phase: string): readonly SearchCandidate[] {
    return this.listSearchCandidates().filter((candidate) => candidate.phase === phase);
  }

  get evidenceCount(): number {
    return this.#evidence.size;
  }

  get candidateCount(): number {
    return this.#candidates.size;
  }

  distinctDomains(): number {
    return new Set(this.listEvidence().map((record) => record.domain)).size;
  }
}

/**
 * Ledgers keyed by SharedOS trace id.
 *
 * Tools are registered once on a long-lived kernel but serve concurrent
 * verifications, so a shared ledger would let one caller's retrieval validate
 * another caller's citations. Handlers resolve their ledger from the trusted
 * `AccessContext.traceId`, never from arguments.
 */
export class EvidenceLedgerRegistry {
  readonly #byTrace = new Map<string, EvidenceLedger>();

  open(traceId: string): EvidenceLedger {
    const ledger = new EvidenceLedger();
    this.#byTrace.set(traceId, ledger);
    return ledger;
  }

  /**
   * The ledger for a trace, or a detached one when the trace is unknown.
   *
   * A detached ledger validates nothing, which is the correct direction to
   * fail: evidence with no home cannot support a claim.
   */
  for(traceId: string): EvidenceLedger {
    return this.#byTrace.get(traceId) ?? new EvidenceLedger();
  }

  close(traceId: string): void {
    this.#byTrace.delete(traceId);
  }
}
