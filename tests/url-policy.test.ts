import { describe, expect, it } from "vitest";

import { checkUrl, checkUrlSyntax, classifyAddress } from "../src/tools/url-policy.js";

/**
 * `research.fetch` is the one place TrustLayer makes an outbound request on
 * behalf of untrusted input, so the destination policy is deny-by-default and
 * tested as such.
 */
describe("URL policy", () => {
  describe("schemes and credentials", () => {
    it.each([
      ["file:///etc/passwd", "unsupported_scheme"],
      ["ftp://example.com/x", "unsupported_scheme"],
      ["gopher://example.com/", "unsupported_scheme"],
      ["data:text/html,hello", "unsupported_scheme"],
      ["javascript:alert(1)", "unsupported_scheme"],
      ["not a url", "invalid_url"],
    ])("rejects %s", (candidate, reason) => {
      const verdict = checkUrlSyntax(candidate);
      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed === false && verdict.reason).toBe(reason);
    });

    it("rejects credential-bearing URLs", () => {
      const verdict = checkUrlSyntax("https://user:secret@example.com/page");
      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed === false && verdict.reason).toBe("embedded_credentials");
    });

    it("allows an ordinary public https URL", () => {
      const verdict = checkUrlSyntax("https://example.com/article?id=1");
      expect(verdict.allowed).toBe(true);
      expect(verdict.allowed === true && verdict.hostname).toBe("example.com");
    });
  });

  describe("loopback, private, and link-local destinations", () => {
    it.each([
      ["http://localhost/admin", "loopback"],
      ["http://sub.localhost/admin", "loopback"],
      ["http://127.0.0.1/admin", "loopback"],
      ["http://127.1.2.3/admin", "loopback"],
      ["http://[::1]/admin", "loopback"],
      ["http://0.0.0.0/", "unspecified"],
      ["http://10.0.0.5/internal", "private"],
      ["http://172.16.4.9/internal", "private"],
      ["http://172.31.255.255/internal", "private"],
      ["http://192.168.1.1/router", "private"],
      ["http://100.64.0.1/cgnat", "private"],
      ["http://169.254.1.1/", "link_local"],
      ["http://[fe80::1]/", "link_local"],
      ["http://[fc00::1]/", "private"],
      ["http://[fd12:3456::1]/", "private"],
      ["http://224.0.0.1/", "reserved"],
      ["http://internal.service.internal/", "private"],
      ["http://printer.local/", "private"],
    ])("rejects %s as %s", (candidate, reason) => {
      const verdict = checkUrlSyntax(candidate);
      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed === false && verdict.reason).toBe(reason);
    });

    it("rejects 172.32.x.x as public rather than private", () => {
      // Just outside the 172.16/12 block: this one must be allowed, or the
      // range check is wrong in the direction that blocks real sites.
      expect(checkUrlSyntax("http://172.32.0.1/").allowed).toBe(true);
    });
  });

  describe("cloud metadata services", () => {
    it.each([
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://169.254.170.2/v2/credentials",
      "http://[fd00:ec2::254]/latest/meta-data/",
    ])("rejects %s", (candidate) => {
      const verdict = checkUrlSyntax(candidate);
      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed === false && verdict.reason).toMatch(
        /metadata_service|link_local|private/,
      );
    });
  });

  describe("IPv4-in-IPv6 forms", () => {
    it.each([
      ["::ffff:127.0.0.1", "loopback"],
      ["::ffff:10.0.0.1", "private"],
      ["::ffff:169.254.169.254", "metadata_service"],
    ])("classifies %s as %s", (address, reason) => {
      expect(classifyAddress(address)).toBe(reason);
    });

    it("classifies fully expanded and hex spellings, not just the compressed ones", () => {
      // A resolver may hand back any of these spellings, so they are judged on
      // the expanded groups rather than on the string.
      expect(classifyAddress("0:0:0:0:0:0:0:1")).toBe("loopback");
      expect(classifyAddress("0:0:0:0:0:0:0:0")).toBe("unspecified");
      expect(classifyAddress("::ffff:7f00:1")).toBe("loopback");
      expect(classifyAddress("::ffff:a9fe:a9fe")).toBe("metadata_service");
      expect(classifyAddress("fe80:0:0:0:0:0:0:1")).toBe("link_local");
    });

    it("still allows ordinary public IPv6 addresses", () => {
      expect(classifyAddress("2606:4700:4700::1111")).toBeUndefined();
      expect(classifyAddress("2001:4860:4860::8888")).toBeUndefined();
    });

    it("rejects an IPv4-mapped loopback written as a URL host", () => {
      const verdict = checkUrlSyntax("http://[::ffff:127.0.0.1]/admin");
      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed === false && verdict.reason).toBe("loopback");
    });
  });

  describe("DNS resolution", () => {
    it("rejects a public name that resolves to a private address", async () => {
      const verdict = await checkUrl("https://rebind.example.com/", {
        resolve: async () => ["10.0.0.7"],
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed === false && verdict.reason).toBe("private");
    });

    it("rejects a name where only one of several answers is private", async () => {
      const verdict = await checkUrl("https://mixed.example.com/", {
        resolve: async () => ["93.184.216.34", "127.0.0.1"],
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed === false && verdict.reason).toBe("loopback");
    });

    it("rejects a name that resolves to the metadata service", async () => {
      const verdict = await checkUrl("https://harmless.example.com/", {
        resolve: async () => ["169.254.169.254"],
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed === false && verdict.reason).toBe("metadata_service");
    });

    it("rejects a name that does not resolve", async () => {
      const verdict = await checkUrl("https://nxdomain.example.com/", {
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.allowed === false && verdict.reason).toBe("dns_resolution_failed");
    });

    it("allows a name that resolves entirely to public addresses", async () => {
      const verdict = await checkUrl("https://example.com/page", {
        resolve: async () => ["93.184.216.34"],
      });
      expect(verdict.allowed).toBe(true);
    });
  });
});
