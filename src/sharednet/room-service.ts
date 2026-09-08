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
 * - **A hard stop on runaway replies.** A self-answering loop is the failure
 *   this design is most exposed to, and in a market round it would fill the
 *   room and spend other agents' credits. Two guards: a message is answered at
 *   most once, and a burst beyond `maxRepliesPerWindow` stops the service
 *   rather than trusting that the next reply will be the last.
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
  readonly maxRepliesPerWindow?: number;
  readonly replyWindowMs?: number;
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
const DEFAULT_MAX_REPLIES_PER_WINDOW = 12;
const DEFAULT_REPLY_WINDOW_MS = 60_000;
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
  let windowStarted = Date.now();
  let repliesInWindow = 0;

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

      const now = Date.now();
      if (now - windowStarted >= windowMs) {
        windowStarted = now;
        repliesInWindow = 0;
      }
      if (repliesInWindow >= maxReplies) {
        // Something is generating calls faster than any real market would.
        // Stopping is the safe failure: a silent service costs us a sale, a
        // looping one costs the room.
        logger.error("sharednet reply burst limit reached; stopping", {
          roomId,
          maxReplies,
          windowMs,
        });
        return;
      }

      const key = replyKeys.get(message.id) ?? randomUUID();
      replyKeys.set(message.id, key);

      try {
        await client.postMessage(roomId, reply, { replyTo: message.id, idempotencyKey: key });
        replyKeys.delete(message.id);
        answered.add(message.id);
        repliesInWindow += 1;
      } catch (error) {
        // Keep the key: the retry posts the same reply, not a second receipt.
        logger.warn("sharednet reply not posted", { messageId: message.id, error: String(error) });
      }
    }
  }

  logger.info("sharednet room service stopped", { roomId });
}
