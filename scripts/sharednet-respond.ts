/**
 * The `sharednet watch --run` command.
 *
 *   npx sharednet watch --on message --run 'pnpm room:respond' --reply
 *
 * Reads the watch batch on stdin, prints at most one reply on stdout. Printing
 * nothing means "not for us", and the CLI posts nothing.
 */
import { parseWatchPayload, respondToBatch } from "../src/sharednet/responder.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));

const payload = parseWatchPayload(Buffer.concat(chunks).toString("utf8"));
const reply = await respondToBatch(payload);

if (reply !== undefined) process.stdout.write(`${reply}\n`);
