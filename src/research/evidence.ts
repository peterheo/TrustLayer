/**
 * The normalized shape every research tool returns.
 *
 * `sourceId` is minted here, in trusted code, and is the only citation token
 * the model is ever allowed to use. A model that writes a `sourceId` this
 * module did not mint is citing something that was never retrieved, and the
 * ledger rejects it.
 */
export interface EvidenceRecord {
  readonly sourceId: string;
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly text?: string;
  readonly publishedAt?: string;
  readonly retrievedAt: string;
  /** Which tool produced this record. Host-derived; used for audit reads. */
  readonly via: "research.search" | "research.fetch";
}

/**
 * What the model sees.
 *
 * A type alias rather than an interface so it carries an implicit index
 * signature and is assignable to the SDK's `JsonValue` without a cast.
 */
export type EvidenceView = {
  readonly sourceId: string;
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly text?: string;
  readonly publishedAt?: string;
  readonly retrievedAt: string;
};

export function toEvidenceView(record: EvidenceRecord): EvidenceView {
  return {
    sourceId: record.sourceId,
    url: record.url,
    ...(record.title === undefined ? {} : { title: record.title }),
    ...(record.snippet === undefined ? {} : { snippet: record.snippet }),
    ...(record.text === undefined ? {} : { text: record.text }),
    ...(record.publishedAt === undefined ? {} : { publishedAt: record.publishedAt }),
    retrievedAt: record.retrievedAt,
  };
}
