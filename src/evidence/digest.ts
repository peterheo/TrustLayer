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

/**
 * A URL reduced to what identifies the source.
 *
 * Used only for deciding whether two URLs name the same source — chiefly
 * whether a fetched page is one the candidate supplied. Scheme and host are
 * lower-cased, a default port and a fragment are dropped, and a bare trailing
 * slash is ignored. Query strings are kept: `?id=7` usually is a different
 * page. Anything unparseable falls back to a trimmed string compare rather
 * than throwing, because failing closed here would mean treating a
 * candidate's own source as independent.
 */
export function canonicalUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return raw.trim().toLowerCase();
  }

  parsed.hash = "";
  const path = parsed.pathname.endsWith("/") && parsed.pathname !== "/"
    ? parsed.pathname.slice(0, -1)
    : parsed.pathname;

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port === "" ? "" : `:${parsed.port}`;
  const normalizedPath = path === "/" ? "" : path;

  return `${parsed.protocol.toLowerCase()}//${host}${port}${normalizedPath}${parsed.search}`;
}
