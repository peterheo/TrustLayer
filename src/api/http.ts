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
import {
  TRUSTLAYER_NAMESPACE_ID,
  TRUST_VERIFY_PURPOSE,
  VERIFIER_AGENT,
} from "../sharedos/identity.js";
import { createVerificationContext, newTurnIdentifiers } from "../sharedos/context.js";
import type { TrustLayerHost } from "../sharedos/kernel.js";
import { defaultHost, type VerifyOptions } from "./verify.js";

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

/**
 * Whether this deployment can actually sell.
 *
 * A service that answers `status: ok` while every call fails is the worst
 * shape a deployment can take on a night when nobody is allowed to touch the
 * keyboard: it looks alive, it is monitored as alive, and it earns nothing.
 * So readiness is computed from what the verifier actually needs, and named.
 */
export interface Readiness {
  readonly ready: boolean;
  readonly modelProvider: string;
  readonly searchProvider: string;
  readonly blockers: readonly string[];
}

export function readiness(): Readiness {
  const blockers: string[] = [];

  // `createVerifierModel` throws for anything but a configured provider, so
  // without this the turn never opens and every call is a MODEL_FAILURE.
  if (config.model.provider !== "anthropic") {
    blockers.push("no model provider: set MODEL_PROVIDER=anthropic (with MODEL_NAME)");
  } else if (config.model.apiKey === undefined) {
    blockers.push("MODEL_API_KEY is not set, so no verification turn can start");
  }

  // Without a backend `research.search` refuses every call. The protocol can
  // still run on caller-supplied citations, but nothing independent will ever
  // be found — and independent support is what a supported verdict requires.
  if (config.search.provider === "none" || config.search.apiKey === undefined) {
    blockers.push(
      "no search backend: set SEARCH_PROVIDER=brave|tavily and SEARCH_API_KEY, " +
        "or every claim comes back unverified for want of independent evidence",
    );
  }

  return {
    ready: blockers.length === 0,
    modelProvider: config.model.provider,
    searchProvider: config.search.provider,
    blockers,
  };
}

/**
 * The verifier's authority, as the kernel computes it.
 *
 * Every other claim this service makes about least privilege is prose. This
 * one is not: `kernel.reach` derives the answer from the grants themselves at
 * the moment it is asked, and the SDK is explicit that it is never stored —
 * a cached reach would keep advertising a revoked grant. So a caller deciding
 * whether to trust TrustLayer with their agent's output does not have to take
 * our word for what it can do; they can read it, and what is absent from the
 * list is absent from the service.
 *
 * Reading it consumes no authority and starts no turn.
 */
export async function authority(host: TrustLayerHost): Promise<Record<string, unknown>> {
  const { traceId } = newTurnIdentifiers();
  const context = createVerificationContext({ traceId });

  const [reach, tools] = await Promise.all([
    host.kernel.reach(context),
    host.kernel.listTools(context),
  ]);

  return {
    purpose: TRUST_VERIFY_PURPOSE,
    tenant: TRUSTLAYER_NAMESPACE_ID,
    actor: VERIFIER_AGENT,
    // The effective catalogue for this context: what the verifier could call,
    // after grants and namespace enablement have both been applied.
    tools: tools.map((tool) => tool.name),
    reach,
    note:
      "Computed by the SharedOS kernel from the grants themselves, not asserted by " +
      "this service. Anything absent here is authority the verifier does not hold.",
  };
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

    // Liveness: the process is up. Always 200 so a restart policy does not
    // kill a service that is merely unconfigured.
    if (path === "/health" && request.method === "GET") {
      const state = readiness();
      return json({
        status: state.ready ? "ok" : "degraded",
        service: "trustlayer",
        methodVersion: METHOD_VERSION,
        purpose: TRUST_VERIFY_PURPOSE,
        tenant: TRUSTLAYER_NAMESPACE_ID,
        services: SERVICE_DESCRIPTORS.map((descriptor) => descriptor.name),
        verifier: state,
      });
    }

    // Readiness: can this deployment serve a call? 503 when it cannot, so the
    // answer is visible to anything that checks rather than only to whoever
    // reads a log line.
    if (path === "/health/ready" && request.method === "GET") {
      const state = readiness();
      return json({ ready: state.ready, blockers: state.blockers }, state.ready ? 200 : 503);
    }

    // The least-privilege claim, checkable rather than advertised.
    if (path === "/v1/authority" && request.method === "GET") {
      return json(await authority(options.verifyOptions?.host ?? defaultHost()));
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

  const state = readiness();
  if (!state.ready) {
    // Loud, at error level, naming each thing: a deployment that cannot verify
    // should not be discoverable only by a caller getting a failure.
    logger.error("this deployment cannot answer a verification call", {
      blockers: state.blockers,
      modelProvider: state.modelProvider,
      searchProvider: state.searchProvider,
    });
  }

  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      ),
  };
}
