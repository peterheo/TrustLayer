import type { AgentAddress, ServiceAddress } from "@aicoo/sharedos";

/**
 * The single purpose string the whole workflow runs under. Every grant is
 * constrained to it and every access context declares it, so an audit reader
 * can select this service's turns by purpose alone.
 */
export const TRUST_VERIFY_PURPOSE = "trust.verify";

/** The SharedOS world this service's grants and contexts live in. */
export const TRUSTLAYER_NAMESPACE_ID = "trustlayer";

/** The agent that performs verification. It is the only actor we ever admit. */
export const VERIFIER_AGENT: AgentAddress = {
  kind: "agent",
  agentId: "trustlayer-verifier",
};

/**
 * TrustLayer itself, as the owner and issuer of the verifier's authority.
 *
 * A service rather than a human: the research plane belongs to the service, not
 * to any operator, and nothing here should read as one person's delegated access.
 */
export const TRUSTLAYER_SERVICE: ServiceAddress = {
  kind: "service",
  serviceId: "trustlayer",
};

/** The tool namespace holding the verifier's only capability: research. */
export const RESEARCH_TOOL_NAMESPACE = "research";

/** The resource plane the research tools authorize against. */
export const RESEARCH_RESOURCE_NAMESPACE = "research";

/** Fully-qualified tool names, used for catalogue assertions and audit reads. */
export const RESEARCH_SEARCH_TOOL = "research.search";
export const RESEARCH_FETCH_TOOL = "research.fetch";
