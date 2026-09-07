import { StaticSearchBackend, type SearchHit } from "../src/tools/search-backend.js";
import type { EvalCase } from "./cases/index.js";

/**
 * A tiny, closed web per case.
 *
 * Both systems under comparison see exactly the same world: the same pages are
 * discoverable, the same bodies are returned, and the same URLs are dead. That
 * is what makes the comparison about the *procedure* rather than about who got
 * luckier with a live search engine.
 */

export interface EvalWorld {
  readonly backend: StaticSearchBackend;
  /** A `fetch` replacement to install for the duration of one case. */
  readonly fetch: typeof globalThis.fetch;
  /** Hostnames all resolve to one public address; nothing touches real DNS. */
  readonly resolveHost: (hostname: string) => Promise<readonly string[]>;
  /** Every page body the world would serve, for the retrieval-free baseline. */
  readonly snippets: readonly SearchHit[];
}

export function buildWorld(testCase: EvalCase): EvalWorld {
  const hits: SearchHit[] = testCase.pages.map((page) => ({
    url: page.url,
    title: page.title,
    snippet: page.snippet,
  }));

  const bodies = new Map(
    testCase.pages
      .filter((page) => page.body !== undefined)
      .map((page) => [page.url, page.body as string]),
  );

  const worldFetch = (async (input: unknown) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : String((input as { url?: unknown }).url ?? "");
    const body = bodies.get(url);
    if (body === undefined) {
      // A URL the world does not serve is genuinely dead, which several cases
      // depend on: a fabricated citation must 404 rather than quietly succeed.
      return new Response("Not Found", { status: 404 });
    }
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }) as typeof globalThis.fetch;

  return {
    backend: new StaticSearchBackend(hits, 6),
    fetch: worldFetch,
    resolveHost: async () => ["93.184.216.34"],
    snippets: hits,
  };
}
