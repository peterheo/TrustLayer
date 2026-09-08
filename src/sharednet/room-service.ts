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
}

const HEARTBEAT_INTERVAL_MS = 30_000;

export async function runRoomService(options: RoomServiceOptions): Promise<void> {
  const { client, roomId } = options;
  let cursor = 0;
  let lastHeartbeat = 0;
  const replyKeys = new Map<string, string>();

  logger.info("sharednet room service started", { roomId });

  while (options.signal?.aborted !== true) {
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
      continue;
    }

    for (const message of messages) {
      cursor = Math.max(cursor, message.sequence ?? cursor);

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

      const key = replyKeys.get(message.id) ?? randomUUID();
      replyKeys.set(message.id, key);

      try {
        await client.postMessage(roomId, reply, { replyTo: message.id, idempotencyKey: key });
        replyKeys.delete(message.id);
      } catch (error) {
        // Keep the key: the retry posts the same reply, not a second receipt.
        logger.warn("sharednet reply not posted", { messageId: message.id, error: String(error) });
      }
    }
  }

  logger.info("sharednet room service stopped", { roomId });
}
