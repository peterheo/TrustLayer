import { createHash, randomUUID } from "node:crypto";

/**
 * Identity and digests for evidence, all minted in trusted code.
 *
 * These exist so a receipt says something checkable. An evidence ID the model
 * invented resolves to nothing in the ledger; a digest the model invented
 * would not match the text the tool actually stored.
 */

/** SHA-256 of the text the verifier read, hex encoded. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** A per-report identifier for the receipt itself. */
export function newReportId(): string {
  return `rpt_${randomUUID()}`;
}

/**
 * Sequential, per-execution identifiers.
 *
 * Short and predictable so a model can cite them reliably — `e1`, `c3` — while
 * validity comes from membership in the ledger rather than from the shape of
 * the string. A guessed `e9` simply is not there.
 */
export class IdSequence {
  #next = 0;

  constructor(private readonly prefix: string) {}

  mint(): string {
    this.#next += 1;
    return `${this.prefix}${this.#next}`;
  }

  get issued(): number {
    return this.#next;
  }
}

/** The registrable domain-ish host of a URL, for coverage and display. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
