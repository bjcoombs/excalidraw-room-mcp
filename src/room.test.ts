import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_AGENT_REPLY_DEPTH } from "./mentions.js";
import { RoomClient } from "./room.js";

const KEY = "CGRLjH7340vVPvMRyjFIrg"; // 22 chars, the shape excalidraw.com produces

test("parseLink accepts a full collaboration URL and a bare id,key pair", () => {
  const url = `https://excalidraw.com/#room=44370699de248c2fed0a,${KEY}`;
  assert.deepEqual(RoomClient.parseLink(url), { roomId: "44370699de248c2fed0a", roomKey: KEY });
  assert.deepEqual(RoomClient.parseLink(`  44370699de248c2fed0a,${KEY} `), {
    roomId: "44370699de248c2fed0a",
    roomKey: KEY,
  });
});

test("parseLink rejects share links, missing keys, and wrong key lengths", () => {
  assert.throws(() => RoomClient.parseLink("https://excalidraw.com/#json=abc,def"), /not a collaboration link/);
  assert.throws(() => RoomClient.parseLink("https://excalidraw.com/#room=abc"), /not a collaboration link/);
  assert.throws(() => RoomClient.parseLink("https://excalidraw.com/#room=abc,tooshort"), /invalid room key length/);
});

test("createLink produces a link parseLink accepts", async () => {
  const link = await RoomClient.createLink();
  const { roomId, roomKey } = RoomClient.parseLink(link);
  assert.match(roomId, /^[0-9a-f]{20}$/);
  assert.equal(roomKey.length, 22);
});

test("a client that has not joined reports disconnected and refuses commits", async () => {
  const room = new RoomClient();
  const s = room.status();
  assert.equal(s.connected, false);
  assert.equal(s.link, null);
  assert.equal(s.elementCount, 0);
  assert.equal(room.lastIndex(), null);
  await assert.rejects(room.commit([]), /not in a room/);
  room.leave(); // safe when never joined
});

test("a room takes its agent-reply bound on join, defaults to one hop, and refuses a depth outside the range", async () => {
  const room = new RoomClient();
  // The default before any join, and what room_status therefore reports for a
  // room joined without the argument.
  assert.equal(room.agentReplyDepth, DEFAULT_AGENT_REPLY_DEPTH);
  assert.equal(room.status().agentReplyDepth, DEFAULT_AGENT_REPLY_DEPTH);

  // Refused before the socket is opened, so an out-of-range depth never
  // reaches the relay and the client is left exactly as it was.
  const link = `https://excalidraw.com/#room=44370699de248c2fed0a,${KEY}`;
  for (const bad of [6, -1, 1.5]) {
    await assert.rejects(room.join(link, { agentReplyDepth: bad }), /agentReplyDepth/);
  }
  assert.equal(room.status().connected, false);
  assert.equal(room.agentReplyDepth, DEFAULT_AGENT_REPLY_DEPTH, "and the bound is untouched");
});
