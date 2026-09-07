/**
 * The evidence quarantine layer.
 *
 * Everything retrieved from the open web passes through here before the
 * verifier is allowed to read it. Three jobs:
 *
 * 1. Reduce a document to the plain text a verifier can reason over. Scripts,
 *    styles, and other executable or presentational content are removed
 *    outright rather than escaped: none of it is evidence, and leaving it in
 *    gives an injected page more surface to talk to the model with.
 * 2. Cap the size, so one page cannot consume the whole turn.
 * 3. Notice instruction-shaped content and label it.
 *
 * The labelling is a reporting aid, not the security control. A page that asks
 * the verifier to read a private key is harmless here because the verifier
 * holds no capability that could read one — detection is best-effort on top of
 * containment, never a substitute for it.
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

export interface QuarantinedContent extends HtmlExtraction {
  /** The quarantine saw text shaped like instructions aimed at a model. */
  readonly instructionLikeContent: boolean;
  /** Short, human-readable notes on what was seen. Safe to show a buyer. */
  readonly indicators: readonly string[];
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

/**
 * Patterns that read as an instruction aimed at whatever model is reading the
 * page, rather than as prose about the page's subject.
 *
 * Deliberately conservative: a page discussing prompt injection should not be
 * flagged for using the words, so the patterns look for the imperative forms
 * an attacker actually writes.
 */
const INSTRUCTION_PATTERNS: readonly { readonly pattern: RegExp; readonly note: string }[] = [
  {
    pattern: /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|your\s+)?(?:previous|prior|earlier|above|the)\s+(?:instruction|prompt|direction|task|rule)/i,
    note: "Text instructs the reader to ignore its previous instructions.",
  },
  {
    pattern: /\bsystem\s*(?:override|prompt|message)\s*[::]/i,
    note: "Text contains a block styled as a system override or system prompt.",
  },
  {
    pattern: /\b(?:instruction|note|message)\s+(?:for|to)\s+(?:the\s+)?(?:ai|assistant|agent|model|llm|chatbot)\b/i,
    note: "Text is addressed to an AI assistant rather than to a human reader.",
  },
  {
    pattern: /\b(?:you\s+must|please)\s+(?:now\s+)?(?:read|open|send|email|post|upload|exfiltrate|delete)\b[^.\n]{0,80}\b(?:file|key|token|credential|secret|password|\.ssh|id_rsa)\b/i,
    note: "Text asks the reader to access or transmit credentials or files.",
  },
  {
    pattern: /\b(?:do\s+not|don't|never)\s+(?:mention|reveal|disclose|tell|report)\b[^.\n]{0,60}\b(?:this|these|instruction|user|caller)\b/i,
    note: "Text asks the reader to conceal its own presence.",
  },
  {
    pattern: /\b(?:report|say|tell|answer|respond)\b[^.\n]{0,40}\binstead\b/i,
    note: "Text asks the reader to substitute a different answer.",
  },
];

/** Look for instruction-shaped content in untrusted text. */
export function detectInstructionLikeContent(text: string): {
  readonly detected: boolean;
  readonly indicators: readonly string[];
} {
  const indicators: string[] = [];
  for (const { pattern, note } of INSTRUCTION_PATTERNS) {
    if (pattern.test(text) && !indicators.includes(note)) indicators.push(note);
  }
  return { detected: indicators.length > 0, indicators };
}

/**
 * The full quarantine pass over one retrieved document.
 *
 * `isHtml` is false for plain text and JSON responses, which need capping but
 * not tag stripping.
 */
export function quarantine(
  body: string,
  maxLength: number,
  isHtml: boolean,
): QuarantinedContent {
  const extracted = isHtml
    ? extractText(body, maxLength)
    : {
        text: body.length > maxLength ? body.slice(0, maxLength) : body,
        title: undefined,
        truncated: body.length > maxLength,
      };

  const detection = detectInstructionLikeContent(extracted.text);
  return {
    ...extracted,
    instructionLikeContent: detection.detected,
    indicators: detection.indicators,
  };
}
