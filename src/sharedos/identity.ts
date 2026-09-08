import type { Address, AgentAddress, ServiceAddress } from "@aicoo/sharedos";

/**
 * The single purpose string the whole workflow runs under. Every grant is
 * constrained to it and every access context declares it, so an audit reader
 * can select this service's turns by purpose alone.
 */
export const TRUST_VERIFY_PURPOSE = "trust.verify";

/**
 * The SharedOS world this service's grants and contexts live in.
 *
 * In SharedOS this is the tenant isolation boundary, so when the organizers
 * issue a tenant id it goes here — set `SHAREDOS_TENANT_ID` and both the
 * access context and every grant move with it, because they read the same
 * constant. They must match: a grant whose `namespaceId` differs from the
 * context's is rejected as a scope mismatch.
 */
export const TRUSTLAYER_NAMESPACE_ID = process.env["SHAREDOS_TENANT_ID"]?.trim() || "trustlayer";

/** The agent that performs verification. It is the only actor we ever admit. */
export const VERIFIER_AGENT: AgentAddress = {
  kind: "agent",
  agentId: "trustlayer-verifier",
};

/** The identity used when the organizers have not issued an owner address. */
const DEFAULT_TRUSTLAYER_SERVICE: ServiceAddress = {
  kind: "service",
  serviceId: "trustlayer",
};

/**
 * TrustLayer itself, as the owner and issuer of the verifier's authority.
 *
 * A service rather than a human by default: the research plane belongs to the
 * service, not to any operator, and nothing here should read as one person's
 * delegated access.
 *
 * The organizers issue an owner address alongside the tenant id. When
 * `SHAREDOS_OWNER_ADDRESS` is set it is parsed here — `service:<id>`,
 * `agent:<id>`, `human:<userId>` or `group:<conversationId>` — and used as the
 * owner and issuer, so grants are issued under the identity the Cloud expects
 * rather than one we made up.
 */
export const TRUSTLAYER_SERVICE: Address = parseOwnerAddress(
  process.env["SHAREDOS_OWNER_ADDRESS"],
);

/**
 * Parse an organizer-supplied owner address.
 *
 * Deliberately strict about the four address kinds the SDK defines, and
 * deliberately falls back to our own service identity rather than guessing at
 * a shape: an owner we invented is at worst wrong in an obvious way, while a
 * malformed one would fail deep inside authorization.
 */
export function parseOwnerAddress(raw: string | undefined): Address {
  const value = raw?.trim();
  if (value === undefined || value === "") return DEFAULT_TRUSTLAYER_SERVICE;

  const separator = value.indexOf(":");
  if (separator <= 0) return DEFAULT_TRUSTLAYER_SERVICE;

  const kind = value.slice(0, separator).trim().toLowerCase();
  const id = value.slice(separator + 1).trim();
  if (id === "") return DEFAULT_TRUSTLAYER_SERVICE;

  switch (kind) {
    case "service":
      return { kind: "service", serviceId: id };
    case "agent":
      return { kind: "agent", agentId: id };
    case "human":
    case "user":
      return { kind: "human", userId: id };
    case "group":
      return { kind: "group", conversationId: id };
    default:
      return DEFAULT_TRUSTLAYER_SERVICE;
  }
}

/** The tool namespace holding the verifier's only capability: research. */
export const RESEARCH_TOOL_NAMESPACE = "research";

/** The resource plane the research tools authorize against. */
export const RESEARCH_RESOURCE_NAMESPACE = "research";

/** Fully-qualified tool names, used for catalogue assertions and audit reads. */
export const RESEARCH_SEARCH_TOOL = "research.search";
export const RESEARCH_FETCH_TOOL = "research.fetch";
