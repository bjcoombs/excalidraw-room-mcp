import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExcalidrawElement } from "./elements.js";
import { DEFAULT_AGENT_REPLY_DEPTH, defaultTags, visibleMentions, type Mention } from "./mentions.js";
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

test("a mention rewritten while it settles is filtered again before it ends the wait", async () => {
  // The filter is applied to what is returned, not only to what was picked:
  // settling re-reads the element, so a peer that rewrites it - its chain
  // metadata included - must not get a mention past the caller's bound
  // returned just because the version that passed the filter was inside it.
  const room = new RoomClient();
  const chain = { author: "alpha", authorKind: "agent", excalidrawRoomRootAuthorKind: "agent", excalidrawRoomDepth: 0 };
  const note = {
    id: "n1",
    type: "text",
    x: 0,
    y: 0,
    width: 100,
    height: 25,
    text: "@beta look",
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
    customData: chain,
  } as unknown as ExcalidrawElement;

  const accept = (m: Mention) => visibleMentions([m], "beta", true, 1).length > 0;
  const waited = room.waitForMention(defaultTags("beta"), new Map(), { timeoutMs: 400, settleMs: 20, accept });
  room.ingestRemote([note]);
  // Rewritten mid-settle to a depth the bound no longer allows.
  setTimeout(
    () =>
      room.ingestRemote([
        { ...note, version: 2, versionNonce: 2, customData: { ...chain, excalidrawRoomDepth: 4 } } as ExcalidrawElement,
      ]),
    5,
  );
  assert.equal(await waited, null, "the rewritten version is refused, so the wait ends empty");

  // The same note left alone is returned, so the filter is what refused it.
  const quiet = new RoomClient();
  const heard = quiet.waitForMention(defaultTags("beta"), new Map(), { timeoutMs: 5000, settleMs: 20, accept });
  quiet.ingestRemote([note]);
  assert.equal((await heard)?.id, "n1");
});
