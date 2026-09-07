/**
 * Reduce an HTML document to the plain text a verifier can reason over.
 *
 * Scripts, styles, and other executable or presentational content are removed
 * outright rather than escaped: none of it is evidence, and leaving it in
 * gives an injected page more surface to talk to the model with.
 */

const DROPPED_ELEMENTS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "form",
  "nav",
  "footer",
];

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    const known = ENTITIES[entity.toLowerCase()];
    if (known !== undefined) return known;
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

export interface HtmlExtraction {
  readonly text: string;
  readonly title: string | undefined;
  /** Truncated because it exceeded the cap, rather than because the page was short. */
  readonly truncated: boolean;
}

export function extractText(html: string, maxLength: number): HtmlExtraction {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title =
    titleMatch?.[1] === undefined
      ? undefined
      : decodeEntities(titleMatch[1]).replace(/\s+/g, " ").trim() || undefined;

  let working = html;
  for (const element of DROPPED_ELEMENTS) {
    working = working.replace(
      new RegExp(`<${element}\\b[^>]*>[\\s\\S]*?<\\/${element}\\s*>`, "gi"),
      " ",
    );
    // Unclosed or self-closing forms of the same element.
    working = working.replace(new RegExp(`<${element}\\b[^>]*\\/?>`, "gi"), " ");
  }

  working = working.replace(/<!--[\s\S]*?-->/g, " ");
  // Keep block boundaries as line breaks so sentences do not run together.
  working = working.replace(/<\/(p|div|section|article|li|tr|h[1-6]|br)\s*>/gi, "\n");
  working = working.replace(/<br\b[^>]*\/?>/gi, "\n");
  working = working.replace(/<[^>]+>/g, " ");

  const text = decodeEntities(working)
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n\s*/g, "\n\n")
    .trim();

  return {
    text: text.length > maxLength ? text.slice(0, maxLength) : text,
    title,
    truncated: text.length > maxLength,
  };
}
