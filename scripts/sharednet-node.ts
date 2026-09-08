/**
 * Register this service as a SharedNet Instance and print what the submission
 * needs, plus the rooms this seat can already see.
 *
 *   SHAREDNET_API_KEY=snk_… pnpm node:id
 *
 * The instance id it prints is the "SharedNet node ID" the Devpost form asks
 * for. The instance token is returned once by the API and is held in memory
 * only — it is never printed and never written to disk.
 */
import { SharedNetClient } from "../src/sharednet/client.js";

const client = new SharedNetClient();

const registration = await client.registerInstance({
  reach: "public",
  metadata: { role: "verification-service", purpose: "trust.verify" },
});

console.log("SharedNet node id:", registration.instance.id);
console.log("reach:", registration.instance.reach ?? "(unset)");

const current = (await client.instanceCurrent()) as Record<string, unknown>;
console.log("\ninstances/current:", JSON.stringify(current, null, 2));

const rooms = (await client.listRooms()) as Record<string, unknown>;
console.log("\nrooms:", JSON.stringify(rooms, null, 2));
