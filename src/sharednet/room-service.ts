import { randomUUID } from "node:crypto";

import type { VerifyOptions } from "../api/verify.js";
import { logger } from "../logging.js";
import { SharedNetClient, type SharedNetMessage } from "./client.js";
import { respondToMessage } from "./responder.js";

/**
 * Sitting in a Room and answering calls, without the CLI.
 *
 * The official CLI can do this (`sharednet watch --run … --reply`) and that is
 * the path to use on a laptop. This exists for the deployed service: a
 * container has no interactive session, no `~/.config/sharednet`, and no
 * reason to shell out to another runtime.
 *
 * Two things it is careful about, because they are what a paid service gets
 * wrong under load:
 *
 * - **Heartbeat.** The presence lease is 90 seconds and the API expects a
 *   heartbeat about every 30. A service that stops answering because its lease
 *   expired looks identical, from the room, to one that never worked.
 * - **Idempotency.** The reply to a given message always carries the same key,
 *   so a retry after a failed post cannot deliver a second copy of a receipt.
 * - **Runaway replies, without a self-inflicted outage.** A self-answering loop
 *   is the failure this design is most exposed to. But the Arena is explicit
 *   that once it opens "humans don't touch the keyboard", so a guard that
 *   stops the service is its own failure mode: a dozen malformed calls inside
 *   a minute is an ordinary market, and going quiet for the rest of the round
 *   costs every sale after it. So the rate guard *pauses* — the call is
 *   answered late, not dropped — and only an absolute ceiling across the whole
 *   run stops the service, at a number no real market reaches when each
 *   verification takes tens of seconds. A message is still answered at most
 *   once.
 */

export interface RoomServiceOptions {
  readonly client: SharedNetClient;
  readonly roomId: string;
  /** Our member id in this room, when known, so our own posts are skipped. */
  readonly memberId?: string;
  readonly verifyOptions?: VerifyOptions;
  /** Stop the loop. */
  readonly signal?: AbortSignal;
  /** Overridden by tests; production uses the API's own ceiling. */
  readonly waitSeconds?: number;
  /** Replies allowed inside one window before the service stops. Default 12. */
  /** Replies per window before the loop pauses for the rest of it. Default 30. */
  readonly maxRepliesPerWindow?: number;
  readonly replyWindowMs?: number;
  /** Replies in one run before the service stops for good. Default 400. */
  readonly maxRepliesPerRun?: number;
  /** Pause after an empty poll. Guards against a server that never blocks. */
  readonly idleDelayMs?: number;
  /**
   * Where to start reading.
   *
   * `"head"` (the default) begins at the room as it is now. A restart must not
   * replay history: every past call would be answered again, and in a market
   * round that means delivering — and charging for — receipts nobody asked for
   * a second time. `"beginning"` is for a deliberate backfill.
   */
  readonly startFrom?: "head" | "beginning";
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_REPLIES_PER_WINDOW = 30;
const DEFAULT_REPLY_WINDOW_MS = 60_000;
/**
 * The point past which this is not a busy market.
 *
 * A real receipt takes tens of seconds and the loop answers one call at a
 * time, so a two-hour round cannot approach this. A loop of failures reaches
 * it in minutes.
 */
const DEFAULT_MAX_REPLIES_PER_RUN = 400;
const DEFAULT_IDLE_DELAY_MS = 500;

/**
 * Hand the event loop a macrotask.
 *
 * The poll is supposed to block for up to 25 seconds, but a server that
 * answers instantly turns this into a loop that only ever awaits resolved
 * promises — which starves the timer queue, so nothing else runs: not a
 * heartbeat timer, not the listener behind an abort signal. It spins at full
 * speed against the API until the process is killed. One real timer per
 * iteration costs nothing and makes that impossible.
 */
function yieldToEventLoop(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function runRoomService(options: RoomServiceOptions): Promise<void> {
  const { client, roomId } = options;
  let cursor = 0;
  if ((options.startFrom ?? "head") === "head") {
    cursor = await client.headSequence(roomId).catch(() => 0);
  }
  let lastHeartbeat = 0;
  const replyKeys = new Map<string, string>();
  /** Messages already answered, so a re-read cannot produce a second reply. */
  const answered = new Set<string>();
  const maxReplies = options.maxRepliesPerWindow ?? DEFAULT_MAX_REPLIES_PER_WINDOW;
  const windowMs = options.replyWindowMs ?? DEFAULT_REPLY_WINDOW_MS;
  const maxRepliesPerRun = options.maxRepliesPerRun ?? DEFAULT_MAX_REPLIES_PER_RUN;
  let windowStarted = Date.now();
  let repliesInWindow = 0;
  let repliesTotal = 0;

  logger.info("sharednet room service started", { roomId, startingAfterSequence: cursor });

  const idleDelayMs = options.idleDelayMs ?? DEFAULT_IDLE_DELAY_MS;
  /** Read through a call so the check is re-evaluated, not narrowed away. */
  const stopped = (): boolean => options.signal?.aborted === true;

  while (!stopped()) {
    const now = Date.now();
    if (now - lastHeartbeat >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeat = now;
      // A failed heartbeat is worth reporting but not worth dropping the room
      // for: the next one may well succeed, and the lease has slack.
      await client.heartbeat().catch((error: unknown) => {
        logger.warn("sharednet heartbeat failed", { roomId, error: String(error) });
      });
    }

    let messages: readonly SharedNetMessage[] = [];
    try {
      const page = await client.waitForMessages(roomId, cursor, options.waitSeconds);
      messages = page.items;
    } catch (error) {
      logger.warn("sharednet wait failed", { roomId, error: String(error) });
      await yieldToEventLoop(idleDelayMs);
      continue;
    }

    // Yield every iteration; pause when the poll came back empty without
    // having blocked, so a non-blocking server cannot be hammered.
    await yieldToEventLoop(messages.length === 0 ? idleDelayMs : 0);
    if (stopped()) break;

    for (const message of messages) {
      cursor = Math.max(cursor, message.sequence ?? cursor);

      // Answered once, ever. A message re-read after a failed post is retried
      // through `replyKeys`, not answered again.
      if (answered.has(message.id)) continue;

      let reply: string | undefined;
      try {
        reply = await respondToMessage(message, {
          ...(options.memberId === undefined ? {} : { memberId: options.memberId }),
          ...(options.verifyOptions === undefined ? {} : { verifyOptions: options.verifyOptions }),
        });
      } catch (error) {
        // A thrown verification is still a call we were asked to answer; the
        // responder turns expected failures into text, so this is a bug path.
        logger.error("sharednet responder threw", { messageId: message.id, error: String(error) });
        continue;
      }

      if (reply === undefined) continue;

      if (repliesTotal >= maxRepliesPerRun) {
        // Far past anything a market does. Whatever this is, it is not selling.
        logger.error("sharednet reply ceiling reached; stopping", {
          roomId,
          maxRepliesPerRun,
          repliesTotal,
        });
        return;
      }

      if (Date.now() - windowStarted >= windowMs) {
        windowStarted = Date.now();
        repliesInWindow = 0;
      }
      if (repliesInWindow >= maxReplies) {
        // Slow down rather than shut down: the caller waits, and the next
        // window sells again. Going quiet for the rest of a round would cost
        // more than the burst it was meant to contain.
        const remaining = Math.max(0, windowMs - (Date.now() - windowStarted));
        logger.warn("sharednet reply rate limit reached; pausing", {
          roomId,
          maxReplies,
          windowMs,
          pauseMs: remaining,
        });
        await yieldToEventLoop(remaining);
        if (stopped()) return;
        windowStarted = Date.now();
        repliesInWindow = 0;
      }

      const key = replyKeys.get(message.id) ?? randomUUID();
      replyKeys.set(message.id, key);

      try {
        await client.postMessage(roomId, reply, { replyTo: message.id, idempotencyKey: key });
        replyKeys.delete(message.id);
        answered.add(message.id);
        repliesInWindow += 1;
        repliesTotal += 1;
      } catch (error) {
        // Keep the key: the retry posts the same reply, not a second receipt.
        logger.warn("sharednet reply not posted", { messageId: message.id, error: String(error) });
      }
    }
  }

  logger.info("sharednet room service stopped", { roomId });
}
