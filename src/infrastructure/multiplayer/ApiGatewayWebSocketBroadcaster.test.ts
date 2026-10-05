import assert from "node:assert/strict";
import test from "node:test";

import { PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";

import { ApiGatewayWebSocketBroadcaster } from "./ApiGatewayWebSocketBroadcaster.ts";

const event = { type: "SCOREBOARD_UPDATED" as const, roomId: "room-1", serverTime: 1, version: 2, scoreboard: [] };

test("posts the JSON event to the connection", async () => {
  const commands: PostToConnectionCommand[] = [];
  const broadcaster = new ApiGatewayWebSocketBroadcaster({ send: async (command) => { commands.push(command); return {}; } });
  assert.equal(await broadcaster.send("conn-1", event), "delivered");
  assert.equal(commands[0].input.ConnectionId, "conn-1");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(commands[0].input.Data as Uint8Array)), event);
});

test("410 Gone is reported as a stale connection; other failures propagate", async () => {
  const gone = new ApiGatewayWebSocketBroadcaster({ send: async () => { throw Object.assign(new Error("gone"), { name: "GoneException" }); } });
  assert.equal(await gone.send("conn-1", event), "gone");
  const gone410 = new ApiGatewayWebSocketBroadcaster({ send: async () => { throw Object.assign(new Error("x"), { $metadata: { httpStatusCode: 410 } }); } });
  assert.equal(await gone410.send("conn-1", event), "gone");
  const throttled = new ApiGatewayWebSocketBroadcaster({ send: async () => { throw Object.assign(new Error("slow"), { name: "LimitExceededException" }); } });
  await assert.rejects(throttled.send("conn-1", event), /slow/);
});
