import { METHOD_VERSION } from "../evidence/schemas.js";
import {
  SERVICE_DESCRIPTORS,
  TRUST_CHECK_SERVICE_NAME,
  TRUST_VERIFY_SERVICE_NAME,
  handleCheckCall,
  handleServiceCall,
  type ServiceCallResult,
} from "../arena/adapter.js";
import { config } from "../config.js";
import { logger } from "../logging.js";
import { TRUSTLAYER_NAMESPACE_ID, TRUST_VERIFY_PURPOSE } from "../sharedos/identity.js";
import type { VerifyOptions } from "./verify.js";

/**
 * The callable surface: what another agent talks to.
 *
 * Deliberately small. Two service endpoints, a descriptor endpoint so a caller
 * can find out what it is buying, and a health probe. The SharedOS HTTP
 * boundary (`/v1/turns`, `/v1/tools/invoke`) is *not* mounted here, and that is
 * a decision rather than an omission: those endpoints run against our kernel
 * under our resolved context, so exposing them would hand any caller holding
 * the token our `research.fetch` capability — a fetch proxy with our egress and
 * our budget. The whole product is a least-privilege argument; opening that
 * door to sell it would be self-defeating.
 *
 * A caller that wants the SharedOS execution record gets it where it belongs:
 * in the receipt's `provenance` block, derived from the real turn.
 */

export interface HttpServiceOptions {
  /**
   * Bearer token callers must present.
   *
   * From `TRUSTLAYER_API_TOKEN`. Unset means unauthenticated, which is fine for
   * a local demo and is logged loudly at startup so it cannot be the state of a
   * deployment by accident.
   */
  readonly token?: string;
  /** Injected by tests and demos so no model or network is needed. */
  readonly verifyOptions?: VerifyOptions;
}

function json(body: unknown, status = 200): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errorResponse(code: string, message: string, status: number): Response {
  return json({ ok: false, error: { code, message } }, status);
}

/** A service result maps onto a status code without leaking anything internal. */
function statusFor(result: ServiceCallResult): number {
  if (result.ok) return 200;
  switch (result.error.code) {
    case "INVALID_INPUT":
      return 400;
    case "VERIFICATION_TIMEOUT":
      return 504;
    case "RESEARCH_UNAVAILABLE":
      return 503;
    default:
      return 502;
  }
}

async function readJson(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") return {};
  return JSON.parse(text) as unknown;
}

/**
 * One fetch-standard handler, mountable on any Node/Bun/Deno/edge server.
 *
 * Every route is explicit; anything else is a 404 rather than a surprise.
 */
export function createHttpService(options: HttpServiceOptions = {}) {
  const token = options.token;

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/health" && request.method === "GET") {
      return json({
        status: "ok",
        service: "trustlayer",
        methodVersion: METHOD_VERSION,
        purpose: TRUST_VERIFY_PURPOSE,
        tenant: TRUSTLAYER_NAMESPACE_ID,
        services: SERVICE_DESCRIPTORS.map((descriptor) => descriptor.name),
      });
    }

    // Discovery: what the services are, what they cost, what they return.
    if ((path === "/" || path === "/v1/services") && request.method === "GET") {
      return json({ methodVersion: METHOD_VERSION, services: SERVICE_DESCRIPTORS });
    }

    const isVerify = path === `/v1/${TRUST_VERIFY_SERVICE_NAME}`;
    const isCheck = path === `/v1/${TRUST_CHECK_SERVICE_NAME}`;

    if (!isVerify && !isCheck) {
      return errorResponse("not_found", "Unknown path.", 404);
    }

    if (request.method !== "POST") {
      return errorResponse("method_not_allowed", "Use POST.", 405);
    }

    // Transport authentication is not authority — it only decides who may ask.
    // What the verifier may do is decided by its grants, inside the turn.
    if (token !== undefined) {
      const presented = request.headers.get("authorization") ?? "";
      if (presented !== `Bearer ${token}`) {
        return errorResponse("unauthorized", "A valid bearer token is required.", 401);
      }
    }

    let payload: unknown;
    try {
      payload = await readJson(request);
    } catch {
      return errorResponse("invalid_json", "The request body is not JSON.", 400);
    }

    const result = isVerify
      ? await handleServiceCall(payload, options.verifyOptions ?? {})
      : await handleCheckCall(payload, options.verifyOptions ?? {});

    return json(result, statusFor(result));
  };
}

export interface ServeOptions extends HttpServiceOptions {
  readonly port?: number;
  readonly hostname?: string;
}

/**
 * Start the service on Node's built-in server.
 *
 * Kept in one function so deploying is `pnpm start` and nothing else. There is
 * no CORS handling, no rate limiting and no TLS termination here — those belong
 * to the deployment edge, exactly as the SharedOS HTTP docs say.
 */
export async function serve(options: ServeOptions = {}): Promise<{ close: () => Promise<void> }> {
  const { createServer } = await import("node:http");

  const port = options.port ?? Number.parseInt(process.env["PORT"] ?? "8080", 10);
  const hostname = options.hostname ?? process.env["HOST"] ?? "0.0.0.0";
  const token = options.token ?? process.env["TRUSTLAYER_API_TOKEN"]?.trim();

  const handle = createHttpService({
    ...(token === undefined || token === "" ? {} : { token }),
    ...(options.verifyOptions === undefined ? {} : { verifyOptions: options.verifyOptions }),
  });

  const server = createServer((incoming, outgoing) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = Buffer.concat(chunks);
      const request = new Request(`http://${incoming.headers.host ?? "localhost"}${incoming.url ?? "/"}`, {
        method: incoming.method ?? "GET",
        headers: Object.entries(incoming.headers).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, Array.isArray(value) ? value.join(", ") : value] as [string, string]],
        ),
        ...(incoming.method === "GET" || incoming.method === "HEAD" ? {} : { body }),
      });

      void handle(request)
        .then(async (response) => {
          outgoing.writeHead(response.status, Object.fromEntries(response.headers.entries()));
          outgoing.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch(() => {
          outgoing.writeHead(500, { "content-type": "application/json" });
          outgoing.end(`{"ok":false,"error":{"code":"internal_error","message":"Request failed."}}\n`);
        });
    });
  });

  await new Promise<void>((resolve) => server.listen(port, hostname, resolve));

  logger.info("trustlayer listening", {
    port,
    hostname,
    tenant: TRUSTLAYER_NAMESPACE_ID,
    methodVersion: METHOD_VERSION,
    modelProvider: config.model.provider,
    searchProvider: config.search.provider,
    authenticated: token !== undefined && token !== "",
  });

  if (token === undefined || token === "") {
    logger.warn("no TRUSTLAYER_API_TOKEN set: the service endpoints are unauthenticated", {});
  }

  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}
