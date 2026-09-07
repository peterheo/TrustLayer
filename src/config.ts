/**
 * Configuration is read from the environment once, at module load, and the
 * resulting object is the only thing the rest of the service reads. Secrets
 * live here and nowhere else: nothing in this module is logged, put into a
 * prompt, or copied into a response.
 */

function optional(name: string): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === "" ? undefined : trimmed;
}

function integer(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type ModelProvider = "anthropic" | "scripted";
export type SearchProvider = "brave" | "tavily" | "none";

export interface TrustLayerConfig {
  readonly model: {
    readonly provider: ModelProvider;
    readonly name: string;
    readonly apiKey: string | undefined;
  };
  readonly search: {
    readonly provider: SearchProvider;
    readonly apiKey: string | undefined;
  };
  /** Bounds for one verification turn. Kept far below the Arena's 5-minute ceiling. */
  readonly turn: {
    readonly maxSteps: number;
    readonly maxToolCalls: number;
    readonly timeoutMs: number;
  };
  /** Limits applied by the research tools themselves. */
  readonly research: {
    readonly searchResultLimit: number;
    readonly fetchTimeoutMs: number;
    readonly fetchMaxBytes: number;
    readonly fetchMaxRedirects: number;
    readonly fetchMaxTextLength: number;
  };
  readonly logLevel: "debug" | "info" | "warn" | "error";
}

function readModelProvider(): ModelProvider {
  return optional("MODEL_PROVIDER") === "anthropic" ? "anthropic" : "scripted";
}

function readSearchProvider(): SearchProvider {
  const raw = optional("SEARCH_PROVIDER");
  return raw === "brave" || raw === "tavily" ? raw : "none";
}

function readLogLevel(): TrustLayerConfig["logLevel"] {
  const raw = optional("LOG_LEVEL");
  return raw === "debug" || raw === "warn" || raw === "error" ? raw : "info";
}

export function loadConfig(): TrustLayerConfig {
  return {
    model: {
      provider: readModelProvider(),
      name: optional("MODEL_NAME") ?? "claude-sonnet-5",
      apiKey: optional("MODEL_API_KEY"),
    },
    search: {
      provider: readSearchProvider(),
      apiKey: optional("SEARCH_API_KEY"),
    },
    turn: {
      maxSteps: integer("TURN_MAX_STEPS", 8),
      maxToolCalls: integer("TURN_MAX_TOOL_CALLS", 8),
      timeoutMs: integer("TURN_TIMEOUT_MS", 90_000),
    },
    research: {
      searchResultLimit: integer("RESEARCH_SEARCH_LIMIT", 6),
      fetchTimeoutMs: integer("RESEARCH_FETCH_TIMEOUT_MS", 8_000),
      fetchMaxBytes: integer("RESEARCH_FETCH_MAX_BYTES", 1_048_576),
      fetchMaxRedirects: integer("RESEARCH_FETCH_MAX_REDIRECTS", 3),
      fetchMaxTextLength: integer("RESEARCH_FETCH_MAX_TEXT", 20_000),
    },
    logLevel: readLogLevel(),
  };
}

export const config = loadConfig();
