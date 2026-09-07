import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

/**
 * What `research.fetch` is allowed to talk to.
 *
 * SharedOS's threat model names SSRF and connector escape as host
 * responsibilities: the kernel authorizes *that* a fetch may happen, and this
 * module decides *where*. Both checks run — a hostname that passes here is
 * still re-authorized by the kernel through `resolveRequirement`.
 *
 * The rule is deny-by-default: a destination is refused unless it is a public
 * unicast address reached over http(s) with no credentials attached.
 */

export type UrlRejectionReason =
  | "invalid_url"
  | "unsupported_scheme"
  | "embedded_credentials"
  | "missing_hostname"
  | "loopback"
  | "private"
  | "link_local"
  | "metadata_service"
  | "reserved"
  | "unspecified"
  | "dns_resolution_failed";

export type UrlPolicyVerdict =
  | { readonly allowed: true; readonly url: URL; readonly hostname: string }
  | { readonly allowed: false; readonly reason: UrlRejectionReason };

/** Cloud metadata endpoints, refused by name as well as by address. */
const METADATA_HOSTNAMES = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
]);

const METADATA_ADDRESSES = new Set([
  "169.254.169.254", // AWS / GCP / Azure / OpenStack IMDS
  "169.254.170.2", // ECS task metadata
  "fd00:ec2::254", // AWS IMDS over IPv6
]);

function parseIPv4(address: string): readonly number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number.parseInt(part, 10);
    if (value > 255) return undefined;
    octets.push(value);
  }
  return octets;
}

function classifyIPv4(address: string): UrlRejectionReason | undefined {
  const octets = parseIPv4(address);
  if (octets === undefined) return "reserved";
  const [a = 0, b = 0] = octets;

  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link_local";
  if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT, RFC 6598
  if (a === 192 && b === 0) return "reserved"; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return "reserved"; // benchmarking
  if (a === 198 && b === 51) return "reserved"; // TEST-NET-2
  if (a === 203 && b === 0) return "reserved"; // TEST-NET-3
  if (a >= 224) return "reserved"; // multicast, future use, broadcast
  return undefined;
}

function normalizeIPv6(address: string): string {
  return address.toLowerCase().replace(/^\[|\]$/g, "");
}

/**
 * Expand an IPv6 address to its eight 16-bit groups.
 *
 * Needed because the same address has several spellings and the dangerous ones
 * do not always arrive in the spelling you expect: `new URL()` rewrites
 * `::ffff:127.0.0.1` as `::ffff:7f00:1`, so a check that only understood the
 * dotted form would wave loopback straight through.
 */
function expandIPv6(address: string): readonly number[] | undefined {
  let working = address;

  // A trailing dotted quad contributes the final two groups.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(working);
  if (dotted?.[1] !== undefined) {
    const octets = parseIPv4(dotted[1]);
    if (octets === undefined) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    const high = ((a << 8) | b).toString(16);
    const low = ((c << 8) | d).toString(16);
    working = `${working.slice(0, dotted.index)}${high}:${low}`;
  }

  const halves = working.split("::");
  if (halves.length > 2) return undefined;

  const parse = (part: string): number[] | undefined => {
    if (part === "") return [];
    const groups: number[] = [];
    for (const chunk of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(chunk)) return undefined;
      groups.push(Number.parseInt(chunk, 16));
    }
    return groups;
  };

  const head = parse(halves[0] ?? "");
  if (head === undefined) return undefined;

  if (halves.length === 1) return head.length === 8 ? head : undefined;

  const tail = parse(halves[1] ?? "");
  if (tail === undefined) return undefined;

  const gap = 8 - head.length - tail.length;
  if (gap < 0) return undefined;
  return [...head, ...Array<number>(gap).fill(0), ...tail];
}

/** The dotted IPv4 address embedded in a v4-mapped or v4-compatible v6 address. */
function embeddedIPv4(groups: readonly number[]): string | undefined {
  const leadingZero = groups.slice(0, 5).every((group) => group === 0);
  if (!leadingZero) return undefined;

  const sixth = groups[5];
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, deprecated but routable
  // through some stacks) both need judging by the IPv4 rules.
  if (sixth !== 0xffff && sixth !== 0) return undefined;

  const high = groups[6] ?? 0;
  const low = groups[7] ?? 0;
  if (sixth === 0 && high === 0 && low <= 1) return undefined; // :: and ::1

  return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
}

function classifyIPv6(rawAddress: string): UrlRejectionReason | undefined {
  const address = normalizeIPv6(rawAddress);

  const groups = expandIPv6(address);
  if (groups === undefined) return "reserved";

  // Judged on the expanded groups rather than on the string, so the fully
  // written-out spellings (`0:0:0:0:0:0:0:1`) are caught alongside `::1`.
  if (groups.slice(0, 7).every((group) => group === 0)) {
    const last = groups[7] ?? 0;
    if (last === 0) return "unspecified";
    if (last === 1) return "loopback";
  }

  // Judge an embedded IPv4 address by the IPv4 rules, through `classifyAddress`
  // so the metadata list applies to it too.
  const embedded = embeddedIPv4(groups);
  if (embedded !== undefined) return classifyAddress(embedded);

  const first = groups[0] ?? 0;
  if ((first & 0xfe00) === 0xfc00) return "private"; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return "link_local"; // fe80::/10
  if ((first & 0xff00) === 0xff00) return "reserved"; // ff00::/8 multicast
  if (first === 0x2001 && groups[1] === 0x0db8) return "reserved"; // documentation
  if (first === 0x0064 && groups[1] === 0xff9b) return "reserved"; // NAT64
  return undefined;
}

/** Judge one literal IP address. Exported so redirect checks reuse it exactly. */
export function classifyAddress(address: string): UrlRejectionReason | undefined {
  if (METADATA_ADDRESSES.has(normalizeIPv6(address))) return "metadata_service";
  const version = isIP(address);
  if (version === 4) return classifyIPv4(address);
  if (version === 6) return classifyIPv6(address);
  return "reserved";
}

/**
 * The syntactic half of the policy: scheme, credentials, and any literal
 * address in the host position. No DNS, so this is cheap and total.
 */
export function checkUrlSyntax(candidate: string): UrlPolicyVerdict {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { allowed: false, reason: "invalid_url" };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { allowed: false, reason: "unsupported_scheme" };
  }

  // A URL like https://user:pass@host/ would send those credentials onward.
  if (url.username !== "" || url.password !== "") {
    return { allowed: false, reason: "embedded_credentials" };
  }

  const hostname = normalizeIPv6(url.hostname);
  if (hostname === "") return { allowed: false, reason: "missing_hostname" };

  const lowered = hostname.toLowerCase();
  if (lowered === "localhost" || lowered.endsWith(".localhost")) {
    return { allowed: false, reason: "loopback" };
  }
  if (METADATA_HOSTNAMES.has(lowered)) {
    return { allowed: false, reason: "metadata_service" };
  }
  // Names that resolve inside the host only.
  if (lowered.endsWith(".internal") || lowered.endsWith(".local")) {
    return { allowed: false, reason: "private" };
  }

  if (isIP(hostname) !== 0) {
    const rejection = classifyAddress(hostname);
    if (rejection !== undefined) return { allowed: false, reason: rejection };
  }

  return { allowed: true, url, hostname: lowered };
}

/**
 * The full policy: syntax, then DNS, then every resolved address.
 *
 * Resolving before connecting is what stops a public name that points at a
 * private address. Every address the name resolves to must pass, not merely
 * the first — a name with one public and one loopback answer is refused.
 */
export async function checkUrl(
  candidate: string,
  options: { readonly resolve?: (hostname: string) => Promise<readonly string[]> } = {},
): Promise<UrlPolicyVerdict> {
  const syntax = checkUrlSyntax(candidate);
  if (!syntax.allowed) return syntax;

  // A literal address was already judged; there is nothing to resolve.
  if (isIP(syntax.hostname) !== 0) return syntax;

  const resolver = options.resolve ?? defaultResolve;
  let addresses: readonly string[];
  try {
    addresses = await resolver(syntax.hostname);
  } catch {
    return { allowed: false, reason: "dns_resolution_failed" };
  }

  if (addresses.length === 0) return { allowed: false, reason: "dns_resolution_failed" };

  for (const address of addresses) {
    const rejection = classifyAddress(address);
    if (rejection !== undefined) return { allowed: false, reason: rejection };
  }

  return syntax;
}

async function defaultResolve(hostname: string): Promise<readonly string[]> {
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
}
