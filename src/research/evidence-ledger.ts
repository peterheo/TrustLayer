import type { EvidenceRecord } from "./evidence.js";

/**
 * Everything the research tools actually returned during one execution.
 *
 * This is the record a claim's citations are checked against. It is written
 * only by trusted tool code and read only by host code after the turn ends;
 * the model can neither add to it nor see it as anything but the evidence it
 * was handed.
 */
export class EvidenceLedger {
  readonly #records = new Map<string, EvidenceRecord>();
  #counter = 0;

  /** Mint the next citation token. Sequential, so a model can cite it reliably. */
  nextSourceId(): string {
    this.#counter += 1;
    return `src-${this.#counter}`;
  }

  record(entry: EvidenceRecord): EvidenceRecord {
    this.#records.set(entry.sourceId, entry);
    return entry;
  }

  recordAll(entries: readonly EvidenceRecord[]): readonly EvidenceRecord[] {
    for (const entry of entries) this.record(entry);
    return entries;
  }

  has(sourceId: string): boolean {
    return this.#records.has(sourceId);
  }

  get(sourceId: string): EvidenceRecord | undefined {
    return this.#records.get(sourceId);
  }

  all(): readonly EvidenceRecord[] {
    return [...this.#records.values()];
  }

  get size(): number {
    return this.#records.size;
  }
}

/**
 * Ledgers keyed by execution id.
 *
 * Tools are registered once on a long-lived kernel but serve concurrent turns,
 * so a single shared ledger would let one caller's evidence validate another
 * caller's citations. The tool handlers resolve their ledger from the trusted
 * `AccessContext.traceId` on every call, never from arguments.
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
   * A detached ledger means nothing recorded into it can ever validate a
   * citation, which is the correct failure direction: evidence with no home is
   * evidence that cannot support a claim.
   */
  for(traceId: string): EvidenceLedger {
    return this.#byTrace.get(traceId) ?? new EvidenceLedger();
  }

  close(traceId: string): void {
    this.#byTrace.delete(traceId);
  }
}
