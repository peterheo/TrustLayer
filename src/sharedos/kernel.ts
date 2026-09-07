import {
  CapabilityAuthorizer,
  InMemoryGrantUsageStore,
  SharedOSKernel,
  type AuditEvent,
  type CapabilityGrant,
  type ToolHandler,
} from "@aicoo/sharedos";

import { EvidenceLedgerRegistry } from "../evidence/ledger.js";
import { createSearchBackend, type SearchBackend } from "../tools/search-backend.js";
import { createResearchFetchTool } from "../tools/research-fetch.js";
import { createResearchSearchTool } from "../tools/research-search.js";
import { StaticGrantSource, verifierGrants } from "./grants.js";

/**
 * The TrustLayer host.
 *
 * Authority reaches the kernel only through its trusted `GrantSource`, which
 * is built from constants in `grants.ts`. Nothing a caller sends — not the
 * request body, not the candidate output, not a fetched page — can add a
 * capability, because none of that is on the path between here and the grant
 * source.
 *
 * Only the two research tools are registered. There is no file provider, no
 * repo provider, no message transport, and no escalation tool, so the file,
 * repo, messaging, and escalation planes do not exist for this kernel at all.
 */

/** Audit records kept in memory so a demo can show the trail without a database. */
export class RecordingAuditSink {
  readonly events: AuditEvent[] = [];

  async record(event: AuditEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }
}

export interface TrustLayerHost {
  readonly kernel: SharedOSKernel;
  readonly ledgers: EvidenceLedgerRegistry;
  readonly audit: RecordingAuditSink;
  readonly searchBackend: SearchBackend;
  readonly tools: readonly ToolHandler[];
}

export interface CreateHostOptions {
  /** Overrides the default grant set, to exercise missing or narrowed authority. */
  readonly grants?: readonly CapabilityGrant[];
  /** Overrides the search provider, so tests need no network or API key. */
  readonly searchBackend?: SearchBackend;
  /** Overrides DNS resolution inside `research.fetch`, to keep tests hermetic. */
  readonly resolveHost?: (hostname: string) => Promise<readonly string[]>;
}

export function createTrustLayerHost(options: CreateHostOptions = {}): TrustLayerHost {
  const ledgers = new EvidenceLedgerRegistry();
  const audit = new RecordingAuditSink();
  const searchBackend = options.searchBackend ?? createSearchBackend();

  const kernel = new SharedOSKernel({
    grantSource: new StaticGrantSource(options.grants ?? verifierGrants()),
    authorizer: new CapabilityAuthorizer({ usageStore: new InMemoryGrantUsageStore() }),
    audit,
    // A provider that throws must not take the turn's error message with it.
    onProviderError: () => undefined,
    onAuditError: () => undefined,
  });

  const tools: ToolHandler[] = [
    createResearchSearchTool(searchBackend, ledgers),
    createResearchFetchTool(
      ledgers,
      options.resolveHost === undefined ? {} : { resolve: options.resolveHost },
    ),
  ];
  for (const tool of tools) kernel.registerTool(tool);

  return { kernel, ledgers, audit, searchBackend, tools };
}
