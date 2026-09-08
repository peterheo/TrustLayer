/**
 * Run TrustLayer as a seat in a SharedNet Room.
 *
 *   SHAREDNET_API_KEY=snk_… SHAREDNET_ROOM_ID=rom_… pnpm room:serve
 *
 * Registers this process as an Instance (printing the node id the hackathon
 * submission asks for), joins the room, and answers calls until stopped. An
 * existing `SHAREDNET_INSTANCE_TOKEN` is used as-is instead of registering.
 */
import { SharedNetClient } from "../src/sharednet/client.js";
import { runRoomService } from "../src/sharednet/room-service.js";
import { logger } from "../src/logging.js";

const roomId = process.env["SHAREDNET_ROOM_ID"]?.trim();
if (roomId === undefined || roomId === "") {
  console.error("SHAREDNET_ROOM_ID is required (rom_…). Join or create a room first.");
  process.exit(2);
}

const client = new SharedNetClient();

if (client.instanceToken === undefined) {
  const registration = await client.registerInstance({ reach: "public" });
  // This is the "SharedNet node ID" the Devpost submission asks for.
  console.log(`SharedNet node id: ${registration.instance.id}`);
}

await client.joinRoom(roomId).catch((error: unknown) => {
  // Already a member is the normal case on a restart.
  logger.info("join room returned an error, continuing", { roomId, error: String(error) });
});

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => controller.abort());
}

await runRoomService({ client, roomId, signal: controller.signal });
