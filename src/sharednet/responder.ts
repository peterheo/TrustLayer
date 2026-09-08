import { handleCheckCall, handleServiceCall, TRUST_CHECK_SERVICE_NAME } from "../arena/adapter.js";
import type { VerifyOptions } from "../api/verify.js";
import { logger } from "../logging.js";
import type { SharedNetMessage } from "./client.js";
import {
  isOwnMessage,
  parseCall,
  renderFailure,
  renderReceipt,
  usageReply,
} from "./protocol.js";

/**
 * Answering a batch of room messages.
 *
 * This is the whole service, seen from SharedNet: messages in, at most one
 * message out. It is shared by both ways of running in a Room — the official
 * `sharednet watch --run … --reply` contract, and our own long-poll loop — so
 * the behaviour cannot drift between them.
 *
 * Silence is a valid answer. A room during Arena Night is busy, and a service
 * that replies to everything is noise; we answer when we are named and stay
 * quiet otherwise.
 */

export interface WatchPayload {
  readonly room_id?: string;
  readonly member_id?: string;
  readonly trigger?: string;
  readonly messages?: readonly SharedNetMessage[];
}

export interface RespondOptions {
  /** Our own member id, so our receipts never trigger another receipt. */
  readonly memberId?: string;
  readonly verifyOptions?: VerifyOptions;
}

/**
 * Answer one message, or decline to.
 *
 * Returns `undefined` when the message was not addressed to us — the caller
 * posts nothing at all rather than posting an empty message.
 */
export async function respondToMessage(
  message: SharedNetMessage,
  options: RespondOptions = {},
): Promise<string | undefined> {
  if (isOwnMessage(message, options.memberId)) return undefined;

  const parsed = parseCall(message.content ?? "");
  if (parsed.kind === "ignore") return undefined;
  if (parsed.kind === "malformed") return usageReply(parsed.failure);

  const { service, request } = parsed.call;
  const started = Date.now();

  const outcome =
    service === TRUST_CHECK_SERVICE_NAME
      ? await handleCheckCall(request, options.verifyOptions ?? {})
      : await handleServiceCall(request, options.verifyOptions ?? {});

  logger.info("sharednet call answered", {
    service,
    messageId: message.id,
    ok: outcome.ok,
    durationMs: Date.now() - started,
    ...(outcome.ok
      ? {
          reportId: outcome.receipt.reportId,
          overallStatus: outcome.receipt.overallStatus,
          protocolStatus: outcome.receipt.protocolStatus,
        }
      : { errorCode: outcome.error.code }),
  });

  return outcome.ok
    ? renderReceipt(outcome.receipt, { service })
    : renderFailure(service, outcome.error.code, outcome.error.message);
}

/**
 * Answer a `sharednet watch` batch.
 *
 * The CLI hands us `{room_id, member_id, trigger, messages}` on stdin and posts
 * whatever we print to stdout as one reply. Several messages can arrive in one
 * batch, so the calls are answered in order and joined — one reply per batch is
 * what the transport gives us.
 */
export async function respondToBatch(
  payload: WatchPayload,
  options: RespondOptions = {},
): Promise<string | undefined> {
  const memberId = options.memberId ?? payload.member_id;
  const replies: string[] = [];

  for (const message of payload.messages ?? []) {
    const reply = await respondToMessage(message, {
      ...options,
      ...(memberId === undefined ? {} : { memberId }),
    });
    if (reply !== undefined) replies.push(reply);
  }

  if (replies.length === 0) return undefined;
  return replies.join("\n\n---\n\n");
}

/** Parse the watch payload without trusting its shape. */
export function parseWatchPayload(raw: string): WatchPayload {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    return parsed as WatchPayload;
  } catch {
    return {};
  }
}
