import { createHash, randomUUID } from "node:crypto";

import { TrustLayerError } from "../errors.js";
import { METHOD_VERSION } from "../evidence/schemas.js";

/**
 * A client for the SharedNet API.
 *
 * Written against the published contract at <https://www.sharednet.ai/api/docs>
 * and its OpenAPI document, read on 2026-09-08. Nothing here is invented: every
 * path, header and token prefix below appears in that document or in the
 * official `sharednet` CLI.
 *
 * The shape that matters for TrustLayer: SharedNet has Rooms, Instances,
 * Messages and Decisions, and **no services, offers, prices or credits**. So a
 * service call on SharedNet is a message in a Room, and the transcript is the
 * record of what was sold. Everything about how TrustLayer is invoked follows
 * from that, rather than from an endpoint that does not exist.
 */

export const SHAREDNET_DEFAULT_BASE_URL = "https://www.sharednet.ai";

/** Sent as `cli_version`, which the API requires. */
const CLI_VERSION = "trustlayer-0.1.0";

/**
 * A stable identity for this deployment's seat.
 *
 * Registering with the same `local_instance_key` returns **200 and the same
 * instance id** instead of minting a new one (verified against the live API on
 * 2026-09-08). That is what keeps the node id on a submission form true after a
 * restart or a redeploy — and it is why this is derived rather than random.
 *
 * The API requires 64 lowercase hex characters, which is the shape of the
 * HMAC the official CLI sends. `SHAREDNET_INSTANCE_KEY` overrides it outright;
 * otherwise it is a digest of the seed, so two deployments of the same product
 * can hold separate seats by setting `SHAREDNET_INSTANCE_SEED`.
 */
export function localInstanceKey(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicit = env["SHAREDNET_INSTANCE_KEY"]?.trim().toLowerCase();
  if (explicit !== undefined && /^[0-9a-f]{64}$/.test(explicit)) return explicit;

  const seed =
    env["SHAREDNET_INSTANCE_SEED"]?.trim() ??
    `trustlayer:${env["SHAREDOS_TENANT_ID"]?.trim() ?? "default"}`;

  return createHash("sha256").update(seed, "utf8").digest("hex");
}

/** The room message cap, from the API's published limits. */
export const MAX_MESSAGE_BYTES = 32_768;

/** Long-poll ceiling, from the same limits. */
export const MAX_WAIT_SECONDS = 25;

export interface SharedNetMessage {
  readonly id: string;
  readonly sequence: number;
  readonly content: string;
  readonly member_id?: string;
  readonly instance_id?: string;
  readonly created_at?: string;
  readonly reply_to_message_id?: string;
}

export interface MessagePage {
  readonly items: readonly SharedNetMessage[];
  readonly next_cursor?: string;
}

/**
 * What `POST /instances` really returns.
 *
 * Verified against the live API on 2026-09-08. Note `token`, not
 * `instance_token`: the published docs page names the credential differently
 * from the service, and the service is what counts. Ids are `i_…` and `p_…`
 * with ten characters, not the `ins_`/`pri_` the docs page shows.
 */
export interface InstanceRegistration {
  /** The node id another agent addresses, and the one the submission asks for. */
  readonly instance: {
    readonly id: string;
    readonly principal_id?: string;
    readonly reach?: string;
    readonly status?: string;
    readonly lease_expires_at?: string;
  };
  /** Returned once, never again. Held only in memory here. */
  readonly token: string;
  readonly heartbeat_after_seconds?: number;
}

export interface SharedNetClientOptions {
  readonly baseUrl?: string;
  /** Account key (`snk_…`), used only to mint an instance token. */
  readonly apiKey?: string;
  /** Instance token (`sni_…`) when one already exists. */
  readonly instanceToken?: string;
  readonly fetch?: typeof globalThis.fetch;
}

function requireOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new TrustLayerError("INVALID_INPUT", "SHAREDNET_BASE_URL is not a valid URL");
  }
  const localHttp = url.protocol === "http:" && url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !localHttp) {
    // The CLI enforces the same rule; a room transcript is not something to
    // send over plaintext because a base URL was mistyped.
    throw new TrustLayerError("INVALID_INPUT", "SharedNet requires HTTPS outside 127.0.0.1");
  }
  return url.origin;
}

export class SharedNetClient {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  #apiKey: string | undefined;
  #instanceToken: string | undefined;

  constructor(options: SharedNetClientOptions = {}) {
    this.#baseUrl = requireOrigin(
      options.baseUrl ?? process.env["SHAREDNET_BASE_URL"]?.trim() ?? SHAREDNET_DEFAULT_BASE_URL,
    );
    this.#apiKey = options.apiKey ?? process.env["SHAREDNET_API_KEY"]?.trim();
    this.#instanceToken = options.instanceToken ?? process.env["SHAREDNET_INSTANCE_TOKEN"]?.trim();
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  get instanceToken(): string | undefined {
    return this.#instanceToken;
  }

  async #request<T>(
    method: string,
    path: string,
    credential: string | undefined,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/v1${path}`, {
        method,
        headers: {
          ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new TrustLayerError("RESEARCH_UNAVAILABLE", "sharednet_unreachable");
    }

    if (response.status === 204) return undefined as T;

    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

    if (!response.ok) {
      const error = payload["error"] as { code?: unknown; request_id?: unknown } | undefined;
      const code = typeof error?.code === "string" ? error.code : `http_${response.status}`;
      // The request id makes an API-side failure traceable in support; the
      // token is never in the message, and neither is the body we sent.
      const requestId = typeof error?.request_id === "string" ? ` (${error.request_id})` : "";
      throw new TrustLayerError("SHAREDOS_FAILURE", `sharednet_${code}${requestId}`);
    }

    return payload as T;
  }

  /**
   * Register this process as an Instance and hold its token.
   *
   * The returned instance id is the "SharedNet node ID" the hackathon
   * submission asks for. The token is returned once by the API, so it is kept
   * in memory and never written to disk by this client.
   */
  async registerInstance(options: {
    readonly runtimeKind?: string;
    readonly reach?: "public" | "private";
    readonly agentId?: string;
    /**
     * Free-form metadata. **String values only** — the API rejects arrays and
     * nested objects with `validation_failed`, which is the kind of thing only
     * a real call tells you.
     */
    readonly metadata?: Record<string, string>;
    /** 64 lowercase hex characters. Defaults to this deployment's stable key. */
    readonly localInstanceKey?: string;
  } = {}): Promise<InstanceRegistration> {
    if (this.#apiKey === undefined || this.#apiKey === "") {
      throw new TrustLayerError("INVALID_INPUT", "SHAREDNET_API_KEY is required to register");
    }

    const registration = await this.#request<InstanceRegistration>(
      "POST",
      "/instances",
      this.#apiKey,
      {
        // Both are required; omitting either is a validation failure.
        runtime_kind: options.runtimeKind ?? "service",
        cli_version: CLI_VERSION,
        // Keeps the node id stable across restarts, so the id on the
        // submission form does not go stale the first time we redeploy.
        local_instance_key: options.localInstanceKey ?? localInstanceKey(),
        ...(options.agentId === undefined ? {} : { agent_id: options.agentId }),
        ...(options.reach === undefined ? {} : { reach: options.reach }),
        runtime_metadata: {
          product: "trustlayer",
          // Flat strings: the services are named here rather than listed,
          // because the API rejects an array.
          services: "trust.verify,trust.check",
          method_version: METHOD_VERSION,
          ...options.metadata,
        },
      },
    );

    // The service calls it `token`; the docs page calls it `instance_token`.
    // Accept either so a docs-shaped response is not silently tokenless.
    const token =
      registration.token ??
      (registration as unknown as { instance_token?: string }).instance_token;

    if (typeof token !== "string" || token === "") {
      throw new TrustLayerError("SHAREDOS_FAILURE", "sharednet_registration_without_token");
    }

    this.#instanceToken = token;
    return { ...registration, token };
  }

  #token(): string {
    if (this.#instanceToken === undefined || this.#instanceToken === "") {
      throw new TrustLayerError("INVALID_INPUT", "no SharedNet instance token");
    }
    return this.#instanceToken;
  }

  /** Renew the presence lease. The API expects this about every 30 seconds. */
  async heartbeat(): Promise<void> {
    await this.#request("POST", "/instances/current/heartbeat", this.#token(), {});
  }

  async joinRoom(roomId: string): Promise<unknown> {
    return this.#request("POST", `/rooms/${encodeURIComponent(roomId)}/join`, this.#token(), undefined, {
      "idempotency-key": randomUUID(),
    });
  }

  /** Who this token says we are, and the lease it currently holds. */
  async instanceCurrent(): Promise<unknown> {
    return this.#request("GET", "/instances/current", this.#token());
  }

  async listRooms(): Promise<unknown> {
    return this.#request("GET", "/rooms", this.#token());
  }

  /**
   * Long-poll one room for messages after `cursor`.
   *
   * Returns an empty page at the timeout, which is a normal quiet room rather
   * than an error.
   */
  async waitForMessages(
    roomId: string,
    cursor: number,
    timeoutSeconds = MAX_WAIT_SECONDS,
  ): Promise<MessagePage> {
    const timeout = Math.max(0, Math.min(MAX_WAIT_SECONDS, Math.floor(timeoutSeconds)));
    const query = `?after=${cursor}&timeout=${timeout}`;
    const page = await this.#request<MessagePage>(
      "GET",
      `/rooms/${encodeURIComponent(roomId)}/wait${query}`,
      this.#token(),
    );
    return { items: page.items ?? [], ...(page.next_cursor === undefined ? {} : { next_cursor: page.next_cursor }) };
  }

  /**
   * Post one message.
   *
   * The idempotency key is the caller's, so a retry after a failed response
   * cannot post a second copy of a receipt — which for a paid service is the
   * difference between one delivery and two.
   */
  async postMessage(
    roomId: string,
    content: string,
    options: { readonly replyTo?: string; readonly idempotencyKey?: string } = {},
  ): Promise<{ readonly message?: SharedNetMessage }> {
    if (Buffer.byteLength(content, "utf8") > MAX_MESSAGE_BYTES) {
      throw new TrustLayerError("INVALID_INPUT", "message exceeds the SharedNet size cap");
    }

    return this.#request(
      "POST",
      `/rooms/${encodeURIComponent(roomId)}/messages`,
      this.#token(),
      {
        content,
        ...(options.replyTo === undefined ? {} : { reply_to_message_id: options.replyTo }),
      },
      { "idempotency-key": options.idempotencyKey ?? randomUUID() },
    );
  }
}
