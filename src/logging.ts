import { config } from "./config.js";

/**
 * Structured logs, correlated by `executionId` and `traceId`.
 *
 * What is deliberately never logged: candidate output, fetched page bodies,
 * search results, grants, and anything from `config.model` or `config.search`
 * beyond a provider name. A verification service handles other agents' work
 * product; keeping it out of the logs is part of the offering.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

function emit(level: LogLevel, message: string, fields: LogFields = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[config.logLevel]) return;
  const line = JSON.stringify({
    level,
    message,
    service: "trust.verify",
    timestamp: new Date().toISOString(),
    ...fields,
  });
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};
