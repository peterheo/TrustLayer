import { config } from "../config.js";
import { TrustLayerError } from "../errors.js";
import { checkUrlSyntax } from "../tools/url-policy.js";

/**
 * One query in, normalized results out.
 *
 * Provider responses are normalized at this boundary so nothing
 * provider-shaped reaches the tool, the ledger, or the model — and so the
 * provider's credentials never leave this module.
 */
export interface SearchHit {
  readonly url: string;
  readonly title?: string;
  readonly snippet?: string;
  readonly publishedAt?: string;
}

export interface SearchBackend {
  readonly id: string;
  search(query: string, signal: AbortSignal): Promise<readonly SearchHit[]>;
}

/** Drop anything the fetch policy would refuse anyway, before it becomes evidence. */
function keepUsableHits(hits: readonly SearchHit[], limit: number): readonly SearchHit[] {
  const seen = new Set<string>();
  const kept: SearchHit[] = [];
  for (const hit of hits) {
    if (kept.length >= limit) break;
    const verdict = checkUrlSyntax(hit.url);
    if (!verdict.allowed) continue;
    const key = verdict.url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ ...hit, url: key });
  }
  return kept;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Brave Search. Credentials stay in the header and are never returned or logged. */
export class BraveSearchBackend implements SearchBackend {
  readonly id = "brave";
  readonly #apiKey: string;
  readonly #limit: number;

  constructor(apiKey: string, limit: number) {
    this.#apiKey = apiKey;
    this.#limit = limit;
  }

  async search(query: string, signal: AbortSignal): Promise<readonly SearchHit[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(this.#limit));

    const response = await fetch(url, {
      signal,
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.#apiKey,
      },
    });
    if (!response.ok) {
      throw new TrustLayerError("RESEARCH_UNAVAILABLE", `brave search status ${response.status}`);
    }

    const body = (await response.json()) as { web?: { results?: readonly unknown[] } };
    const results = body.web?.results ?? [];
    const hits = results.flatMap((entry): SearchHit[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const href = asString(record["url"]);
      if (href === undefined) return [];
      const title = asString(record["title"]);
      const snippet = asString(record["description"]);
      const publishedAt = asString(record["age"]) ?? asString(record["page_age"]);
      return [
        {
          url: href,
          ...(title === undefined ? {} : { title }),
          ...(snippet === undefined ? {} : { snippet }),
          ...(publishedAt === undefined ? {} : { publishedAt }),
        },
      ];
    });
    return keepUsableHits(hits, this.#limit);
  }
}

/** Tavily. Same normalization contract as Brave. */
export class TavilySearchBackend implements SearchBackend {
  readonly id = "tavily";
  readonly #apiKey: string;
  readonly #limit: number;

  constructor(apiKey: string, limit: number) {
    this.#apiKey = apiKey;
    this.#limit = limit;
  }

  async search(query: string, signal: AbortSignal): Promise<readonly SearchHit[]> {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.#apiKey}`,
      },
      body: JSON.stringify({ query, max_results: this.#limit }),
    });
    if (!response.ok) {
      throw new TrustLayerError("RESEARCH_UNAVAILABLE", `tavily search status ${response.status}`);
    }

    const body = (await response.json()) as { results?: readonly unknown[] };
    const hits = (body.results ?? []).flatMap((entry): SearchHit[] => {
      if (typeof entry !== "object" || entry === null) return [];
      const record = entry as Record<string, unknown>;
      const href = asString(record["url"]);
      if (href === undefined) return [];
      const title = asString(record["title"]);
      const snippet = asString(record["content"]);
      const publishedAt = asString(record["published_date"]);
      return [
        {
          url: href,
          ...(title === undefined ? {} : { title }),
          ...(snippet === undefined ? {} : { snippet }),
          ...(publishedAt === undefined ? {} : { publishedAt }),
        },
      ];
    });
    return keepUsableHits(hits, this.#limit);
  }
}

/**
 * No provider configured.
 *
 * It fails loudly rather than returning an empty list: "no results" and "no
 * search backend" mean very different things to a verifier, and silently
 * conflating them would turn an outage into a wall of `unverified` claims that
 * look like real findings.
 */
export class UnavailableSearchBackend implements SearchBackend {
  readonly id = "none";

  async search(): Promise<readonly SearchHit[]> {
    throw new TrustLayerError("RESEARCH_UNAVAILABLE", "no search provider configured");
  }
}

/** A fixed corpus, for tests and the offline smoke run. */
export class StaticSearchBackend implements SearchBackend {
  readonly id = "static";
  readonly #corpus: readonly SearchHit[];
  readonly #limit: number;

  constructor(corpus: readonly SearchHit[], limit = 6) {
    this.#corpus = corpus;
    this.#limit = limit;
  }

  async search(query: string): Promise<readonly SearchHit[]> {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 2);
    const scored = this.#corpus
      .map((hit) => {
        const haystack = `${hit.title ?? ""} ${hit.snippet ?? ""} ${hit.url}`.toLowerCase();
        const score = terms.filter((term) => haystack.includes(term)).length;
        return { hit, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score);
    return keepUsableHits(
      scored.map((entry) => entry.hit),
      this.#limit,
    );
  }
}

export function createSearchBackend(): SearchBackend {
  const { provider, apiKey } = config.search;
  const limit = config.research.searchResultLimit;
  if (provider === "brave" && apiKey !== undefined) return new BraveSearchBackend(apiKey, limit);
  if (provider === "tavily" && apiKey !== undefined) return new TavilySearchBackend(apiKey, limit);
  return new UnavailableSearchBackend();
}
