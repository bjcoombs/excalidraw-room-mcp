import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ExcalidrawElement } from "./elements.js";
import type { Mention } from "./mentions.js";
import type { RoomStatus } from "./room.js";
import {
  buildShowRoomPayload,
  CANVAS_RESOURCE_URI,
  canvasHtmlUrl,
  NOT_IN_ROOM_TEXT,
  registerCanvasResource,
} from "./view.js";

const LINK = "https://excalidraw.com/#room=0123456789abcdef0123,AbCdEfGhIjKlMnOpQrStUv";

function status(over: Partial<RoomStatus> = {}): RoomStatus {
  return {
    connected: true,
    roomId: "0123456789abcdef0123",
    link: LINK,
    peers: [{ socketId: "sock-1", username: "Ada" }],
    elementCount: 2,
    deletedCount: 0,
    sceneVersion: 7,
    lastRemoteUpdate: null,
    source: "peer",
    ...over,
  };
}

function element(over: Partial<ExcalidrawElement> = {}): ExcalidrawElement {
  return {
    id: "rect-1",
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    version: 3,
    versionNonce: 42,
    isDeleted: false,
    boundElements: null,
    ...over,
  } as ExcalidrawElement;
}

function mention(over: Partial<Mention> = {}): Mention {
  return { id: "text-1", version: 5, text: "@claude add a cache here", x: 20, y: 20, width: 200, height: 25, containerId: null, ...over };
}

test("buildShowRoomPayload carries link, connection state, peers, elements and mentions", () => {
  const els = [element(), element({ id: "text-1", type: "text", text: "@claude add a cache here", x: 20, y: 20, width: 200, height: 25 })];
  const payload = buildShowRoomPayload(status(), els, [mention()]);

  assert.equal(payload.link, LINK);
  assert.equal(payload.connected, true);
  assert.deepEqual(payload.peers, [{ socketId: "sock-1", username: "Ada" }]);
  assert.ok(Array.isArray(payload.elements));
  assert.equal(payload.elements.length, 2);
  assert.equal(payload.elements[0].id, "rect-1");
  assert.ok(Array.isArray(payload.mentions));
  assert.equal(payload.mentions.length, 1);
});

test("buildShowRoomPayload lists the ids of the elements around each mention", () => {
  const near = element({ id: "near-1", x: 30, y: 30, width: 40, height: 40 });
  const far = element({ id: "far-1", x: 5000, y: 5000, width: 10, height: 10 });
  const text = element({ id: "text-1", type: "text", text: "@claude add a cache here", x: 20, y: 20, width: 200, height: 25 });
  const payload = buildShowRoomPayload(status(), [near, far, text], [mention()]);

  const [m] = payload.mentions;
  assert.equal(m.id, "text-1");
  assert.equal(m.version, 5);
  assert.equal(m.text, "@claude add a cache here");
  assert.equal(typeof m.x, "number");
  assert.equal(typeof m.y, "number");
  assert.ok(m.nearby.includes("near-1"));
  assert.ok(!m.nearby.includes("far-1"));
  assert.ok(!m.nearby.includes("text-1"));
});

test("buildShowRoomPayload round-trips element JSON unchanged", () => {
  const el = element({ index: "a1", strokeColor: "#1e1e1e" } as Partial<ExcalidrawElement>);
  const payload = buildShowRoomPayload(status(), [el], []);
  assert.deepEqual(JSON.parse(JSON.stringify(payload.elements[0])), JSON.parse(JSON.stringify(el)));
});

test("buildShowRoomPayload reports a disconnected room with a null link", () => {
  const payload = buildShowRoomPayload(status({ connected: false, link: null, peers: [] }), [], []);
  assert.equal(payload.connected, false);
  assert.equal(payload.link, null);
  assert.deepEqual(payload.peers, []);
  assert.deepEqual(payload.elements, []);
  assert.deepEqual(payload.mentions, []);
});

test("the show_room result body is JSON with exactly the five documented keys", () => {
  const parsed = JSON.parse(JSON.stringify(buildShowRoomPayload(status(), [element()], [])));
  assert.deepEqual(Object.keys(parsed).sort(), ["connected", "elements", "link", "mentions", "peers"]);
});

test("show_room's pre-join message names the room and the tools that open one", () => {
  assert.match(NOT_IN_ROOM_TEXT, /room/);
  for (const forbidden of ["not found", "unknown tool", "-32602"]) {
    assert.ok(!NOT_IN_ROOM_TEXT.toLowerCase().includes(forbidden), `must not contain ${forbidden}`);
  }
  assert.match(NOT_IN_ROOM_TEXT, /create_room/);
  assert.match(NOT_IN_ROOM_TEXT, /join_room/);
});

test("registerCanvasResource serves canvas.html at the URI show_room's _meta points to", async () => {
  const calls: { name: string; uri: string; config: { mimeType?: string } }[] = [];
  let read!: (uri: URL) => Promise<{ contents: { uri: string; mimeType?: string; text?: string }[] }>;
  registerCanvasResource(
    {
      registerResource: (name: string, uri: string, config: { mimeType?: string }, cb: unknown) => {
        calls.push({ name, uri, config });
        read = cb as typeof read;
        return {} as never;
      },
    } as never,
    canvasHtmlUrl(),
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].uri, CANVAS_RESOURCE_URI);
  assert.equal(CANVAS_RESOURCE_URI, "ui://excalidraw-room/canvas.html");
  assert.ok(calls[0].config.mimeType?.startsWith("text/html"));

  const result = await read(new URL(CANVAS_RESOURCE_URI));
  assert.equal(result.contents.length, 1);
  assert.equal(result.contents[0].uri, CANVAS_RESOURCE_URI);
  assert.ok(result.contents[0].mimeType?.startsWith("text/html"));

  const onDisk = await readFile(canvasHtmlUrl(), "utf8");
  assert.equal(result.contents[0].text, onDisk);
  assert.ok(onDisk.length > 0);
});

test("canvasHtmlUrl points at dist/view/canvas.html next to the compiled server", () => {
  assert.match(canvasHtmlUrl().pathname, /\/view\/canvas\.html$/);
});
