import {
  agentExecutionCapability,
  type Capability,
  type CapabilityGrant,
} from "@aicoo/sharedos";

import {
  RESEARCH_RESOURCE_NAMESPACE,
  TRUSTLAYER_NAMESPACE_ID,
  TRUSTLAYER_SERVICE,
  TRUST_VERIFY_PURPOSE,
  VERIFIER_AGENT,
} from "./identity.js";

/**
 * The complete authority of the verification agent.
 *
 * Three capabilities and nothing else. There is no files grant, no messaging
 * grant, no escalation grant, and no namespace outside `research` is ever
 * enabled — so the prompt-injection fixture in the tests does not fail because
 * a model declined to read `~/.ssh/id_rsa`, it fails because no tool that could
 * read a file exists in the verifier's catalogue at all.
 *
 * Every grant is constrained to the single purpose string, so authority issued
 * for verification cannot be spent under any other purpose.
 */

/** `sharedos.execution` / the verifier / `invoke` — permission to run a turn. */
export function verifierExecutionCapability(): Capability {
  return agentExecutionCapability(VERIFIER_AGENT, TRUSTLAYER_SERVICE);
}

/**
 * `research` / `["web"]` / `search`, exact.
 *
 * The query is not a resource selector — one search is the same authority as
 * any other — so a static requirement is the honest description and
 * `research.search` needs no `resolveRequirement`.
 */
export function researchSearchCapability(): Capability {
  return {
    resource: {
      namespace: RESEARCH_RESOURCE_NAMESPACE,
      path: ["web"],
      owner: TRUSTLAYER_SERVICE,
    },
    actions: ["search"],
    scope: "exact",
  };
}

/**
 * `research` / `["web"]` / `fetch`, descendants.
 *
 * `descendants` is what makes `["web", <hostname>]` reachable, and it is the
 * reason `research.fetch` must implement `resolveRequirement`: the broad
 * discovery ceiling would otherwise be the only thing ever checked, which
 * `docs/tools.md` calls out as a scope hole. Narrowing this grant to specific
 * hostnames is a one-line change here and needs no code change in the tool.
 */
export function researchFetchCapability(): Capability {
  return {
    resource: {
      namespace: RESEARCH_RESOURCE_NAMESPACE,
      path: ["web"],
      owner: TRUSTLAYER_SERVICE,
    },
    actions: ["fetch"],
    scope: "descendants",
  };
}

export interface VerifierGrantOptions {
  /** Overrides the issue instant; tests freeze it for deterministic ids. */
  readonly issuedAt?: string;
  /** Omit the execution grant to prove a turn is refused without it. */
  readonly withExecution?: boolean;
  /** Omit research authority to prove tools disappear from the catalogue. */
  readonly withResearch?: boolean;
  /** Narrow the purposes, to prove a wrong-purpose turn is refused. */
  readonly purposes?: readonly string[];
}

/**
 * The trusted grant set for the verifier.
 *
 * Built in host code from constants. Nothing in a request body, a message
 * payload, a search result, or a fetched page can reach this function — which
 * is the whole point of SharedOS's separation of authority from message text.
 */
export function verifierGrants(options: VerifierGrantOptions = {}): readonly CapabilityGrant[] {
  const issuedAt = options.issuedAt ?? new Date().toISOString();
  const purposes = [...(options.purposes ?? [TRUST_VERIFY_PURPOSE])];
  const withExecution = options.withExecution ?? true;
  const withResearch = options.withResearch ?? true;

  const base = {
    namespaceId: TRUSTLAYER_NAMESPACE_ID,
    subject: VERIFIER_AGENT,
    issuer: TRUSTLAYER_SERVICE,
    constraints: { purposes },
    issuedAt,
  } as const;

  const grants: CapabilityGrant[] = [];

  if (withExecution) {
    grants.push({
      ...base,
      id: "trustlayer-grant-execution",
      capabilities: [verifierExecutionCapability()],
    });
  }

  if (withResearch) {
    grants.push({
      ...base,
      id: "trustlayer-grant-research",
      capabilities: [researchSearchCapability(), researchFetchCapability()],
    });
  }

  return grants;
}

/** A `GrantSource` over a fixed, host-owned grant set. */
export class StaticGrantSource {
  readonly #grants: readonly CapabilityGrant[];

  constructor(grants: readonly CapabilityGrant[]) {
    this.#grants = grants;
  }

  async load(): Promise<readonly CapabilityGrant[]> {
    return this.#grants;
  }
}
