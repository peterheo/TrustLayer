import { randomUUID } from "node:crypto";

import { TrustLayerError } from "../errors.js";

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

export interface InstanceRegistration {
  /** The node id another agent addresses, and the one the submission asks for. */
  readonly instance: { readonly id: string; readonly reach?: string };
  /** Returned once, never again. Held only in memory here. */
  readonly instance_token: string;
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
      const error = payload["error"] as { code?: unknown } | undefined;
      const code = typeof error?.code === "string" ? error.code : `http_${response.status}`;
      // The token is never in the message, and neither is the body we sent.
      throw new TrustLayerError("SHAREDOS_FAILURE", `sharednet_${code}`);
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
    readonly metadata?: Record<string, unknown>;
  } = {}): Promise<InstanceRegistration> {
    if (this.#apiKey === undefined || this.#apiKey === "") {
      throw new TrustLayerError("INVALID_INPUT", "SHAREDNET_API_KEY is required to register");
    }

    const registration = await this.#request<InstanceRegistration>(
      "POST",
      "/instances",
      this.#apiKey,
      {
        runtime_kind: options.runtimeKind ?? "service",
        cli_version: "trustlayer",
        ...(options.agentId === undefined ? {} : { agent_id: options.agentId }),
        ...(options.reach === undefined ? {} : { reach: options.reach }),
        runtime_metadata: {
          product: "trustlayer",
          services: ["trust.verify", "trust.check"],
          ...options.metadata,
        },
      },
    );

    this.#instanceToken = registration.instance_token;
    return registration;
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
