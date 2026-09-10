import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { ExcalidrawElement } from "./elements.js";
import { DEFAULT_NEARBY_RADIUS, formatMention, nearbyElements, type Mention } from "./mentions.js";
import { RoomClient, type RoomStatus } from "./room.js";
import { PACKAGE_VERSION } from "./version.js";
import {
  buildShowRoomPayload,
  CANVAS_RESOURCE_URI,
  CANVAS_RESOURCE_URI_PREFIX,
  canvasHtmlUrl,
  ensureJoined,
  formatShowRoomMention,
  NOT_IN_ROOM_TEXT,
  registerCanvasResource,
  SUMMARY_MENTION_LIMIT,
  SUMMARY_NEARBY_LIMIT,
  summariseShowRoom,
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

// The layout issue #34 reported: a wide diagram with the note written below it.
// https://github.com/bjcoombs/excalidraw-room-mcp/issues/34
const WIDE_DIAGRAM = element({ id: "diagram", x: 0, y: 0, width: 800, height: 300 });
const NOTE_BELOW = mention({ id: "note", text: "@claude add a cache here", x: 0, y: 460, width: 200, height: 25 });

function centreDistance(a: { x: number; y: number; width: number; height: number }, b: typeof a): number {
  return Math.hypot(a.x + a.width / 2 - (b.x + b.width / 2), a.y + a.height / 2 - (b.y + b.height / 2));
}

test("a wide shape above the note is nearby: the boxes are within the radius even though the centres are not", () => {
  // The geometry is the point of the test, so it is asserted rather than
  // asserted-by-comment: a centre-to-centre measure would call this 440 px
  // apart at the 250 px default and return an empty nearby list.
  assert.ok(WIDE_DIAGRAM.width >= 600, "a wide shape, where the two measures disagree");
  assert.equal(NOTE_BELOW.y - (WIDE_DIAGRAM.y + WIDE_DIAGRAM.height), 160);
  assert.ok(160 < DEFAULT_NEARBY_RADIUS, "the note's box is within the default radius of the shape's box");
  assert.ok(centreDistance(WIDE_DIAGRAM, NOTE_BELOW) > DEFAULT_NEARBY_RADIUS, "the centres are further apart than the radius");

  const noteEl = element({ id: "note", type: "text", text: NOTE_BELOW.text, x: NOTE_BELOW.x, y: NOTE_BELOW.y, width: NOTE_BELOW.width, height: NOTE_BELOW.height });
  const payload = buildShowRoomPayload(status(), [WIDE_DIAGRAM, noteEl], [NOTE_BELOW]);

  assert.deepEqual(payload.mentions[0].nearby, ["diagram"]);
});

test("show_room and list_mentions report the same nearby ids for the same scene", () => {
  // show_room goes through buildShowRoomPayload; list_mentions and
  // wait_for_mention call nearbyElements directly. The two must not drift.
  const els = [
    WIDE_DIAGRAM,
    element({ id: "note", type: "text", text: NOTE_BELOW.text, x: NOTE_BELOW.x, y: NOTE_BELOW.y, width: NOTE_BELOW.width, height: NOTE_BELOW.height }),
    element({ id: "label", type: "text", text: "cache", x: 40, y: 380, width: 60, height: 25 }),
    element({ id: "elsewhere", x: 4000, y: 4000, width: 100, height: 100 }),
  ];
  const mentions = [NOTE_BELOW];

  for (const radius of [0, 100, DEFAULT_NEARBY_RADIUS, 10_000]) {
    const fromShowRoom = buildShowRoomPayload(status(), els, mentions, radius).mentions[0].nearby;
    const fromListMentions = nearbyElements(els, NOTE_BELOW, radius).map((e) => e.id);
    assert.deepEqual(fromShowRoom, fromListMentions, `radius ${radius}`);
  }

  // And the default the two tools share is the same default.
  const fromShowRoom = buildShowRoomPayload(status(), els, mentions).mentions[0].nearby;
  assert.deepEqual(fromShowRoom, nearbyElements(els, NOTE_BELOW).map((e) => e.id));
  assert.ok(fromShowRoom.includes("diagram"));
  assert.ok(fromShowRoom.includes("label"));
  assert.ok(!fromShowRoom.includes("elsewhere"));
  // list_mentions renders those same ids as text.
  const rendered = formatMention(NOTE_BELOW, nearbyElements(els, NOTE_BELOW));
  for (const id of fromShowRoom) assert.ok(rendered.includes(id), `${id} named in the list_mentions text`);
});

test("the text summary of a 35-element room stays under 1500 characters and names the link and the count", () => {
  const els = Array.from({ length: 35 }, (_, i) => element({ id: `rect-${i}`, x: i * 40, y: 0, width: 30, height: 30 }));
  const summary = summariseShowRoom(buildShowRoomPayload(status(), els, []));

  assert.ok(summary.length < 1500, `summary was ${summary.length} characters`);
  assert.ok(summary.includes(LINK), "the room link is in the text");
  assert.match(summary, /elements: 35/);
  assert.match(summary, /peers: 1/);
  assert.match(summary, /connected: true/);
  assert.ok(!summary.includes("versionNonce"), "no element JSON leaks into the text");
});

test("the summary names every pending mention with the ids around it, and stays bounded when there are many", () => {
  const near = element({ id: "near-1", x: 30, y: 30, width: 40, height: 40 });
  const els = [near, element({ id: "text-1", type: "text", text: "@claude add a cache here", x: 20, y: 20, width: 200, height: 25 })];
  const summary = summariseShowRoom(buildShowRoomPayload(status(), els, [mention()]));

  assert.match(summary, /pending mentions: 1/);
  assert.ok(summary.includes('"@claude add a cache here"'), "the note's text is quoted");
  assert.match(summary, /mention text-1 v5 at \(20,20\):/);
  assert.match(summary, /nearby \(1\): near-1/);

  const many = Array.from({ length: SUMMARY_MENTION_LIMIT + 3 }, (_, i) => mention({ id: `m-${i}` }));
  const bounded = summariseShowRoom(buildShowRoomPayload(status(), els, many));
  assert.match(bounded, new RegExp(`pending mentions: ${many.length}`));
  assert.ok(bounded.includes("m-0"), "the first mentions are spelled out");
  assert.ok(!bounded.includes(`mention m-${SUMMARY_MENTION_LIMIT} `), "past the limit they are not");
  assert.match(bounded, /\+3 more pending; call list_mentions/);
});

test("a mention next to a crowd lists the first ids and counts the rest", () => {
  const crowd = Array.from({ length: SUMMARY_NEARBY_LIMIT + 4 }, (_, i) => `id-${i}`);
  const line = formatShowRoomMention({ id: "note", version: 2, text: "@claude here", x: 0, y: 0, width: 10, height: 10, containerId: null, nearby: crowd });

  assert.match(line, new RegExp(`nearby \\(${crowd.length}\\): id-0`));
  assert.match(line, /\+4 more/);
  assert.ok(!line.includes(`id-${SUMMARY_NEARBY_LIMIT}`), "past the limit the ids are counted, not listed");
});

test("a mention bound inside a shape says so, and one with nothing around it says none", () => {
  const inside = formatShowRoomMention({ id: "label", version: 1, text: "@claude rename", x: 5, y: 5, width: 10, height: 10, containerId: "box", nearby: [] });
  assert.match(inside, /^mention label v1 inside box:/);
  assert.match(inside, /nearby: none/);
});

test("the summary says where the elements are rather than pretending they are missing", () => {
  const summary = summariseShowRoom(buildShowRoomPayload(status(), [element()], []));
  assert.match(summary, /fetches them itself/, "the view is named as the thing that has the elements");
  assert.match(summary, /include: "json"/);
  assert.doesNotMatch(summary, /structured content/, "there is no structured channel to point at");
});

test("a disconnected room summarises without a link", () => {
  const summary = summariseShowRoom(buildShowRoomPayload(status({ connected: false, link: null, peers: [] }), [], []));
  assert.match(summary, /room: -/);
  assert.match(summary, /connected: false/);
  assert.match(summary, /peers: 0/);
  assert.match(summary, /elements: 0/);
  assert.match(summary, /pending mentions: 0/);
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
  assert.ok(calls[0].config.mimeType?.startsWith("text/html"));

  const result = await read(new URL(CANVAS_RESOURCE_URI));
  assert.equal(result.contents.length, 1);
  assert.equal(result.contents[0].uri, CANVAS_RESOURCE_URI);
  assert.ok(result.contents[0].mimeType?.startsWith("text/html"));

  const onDisk = await readFile(canvasHtmlUrl(), "utf8");
  assert.equal(result.contents[0].text, onDisk);
  assert.ok(onDisk.length > 0);
});

test("the canvas resource URI carries the package version, so a host cannot serve a stale view", () => {
  // A host may cache the view HTML by URI across extension versions: Claude
  // Desktop 1.49585.0 rendered the 0.5.1 view with 0.5.3 installed, having read
  // ui://excalidraw-room/canvas.html once and never again. The version makes
  // every release a distinct URI, so the read happens again.
  assert.equal(CANVAS_RESOURCE_URI_PREFIX, "ui://excalidraw-room/canvas-");
  assert.ok(CANVAS_RESOURCE_URI.startsWith(CANVAS_RESOURCE_URI_PREFIX), CANVAS_RESOURCE_URI);
  assert.ok(CANVAS_RESOURCE_URI.endsWith(".html"), CANVAS_RESOURCE_URI);
  assert.equal(CANVAS_RESOURCE_URI, `${CANVAS_RESOURCE_URI_PREFIX}${PACKAGE_VERSION}.html`);
  assert.notEqual(CANVAS_RESOURCE_URI, "ui://excalidraw-room/canvas.html", "the unversioned URI is the one hosts cached");
  assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+/, "a real version, not the 0.0.0 fallback shape only");
});

test("canvasHtmlUrl points at dist/view/canvas.html next to the compiled server", () => {
  assert.match(canvasHtmlUrl().pathname, /\/view\/canvas\.html$/);
});

/**
 * A RoomClient as ensureJoined sees it: connection state and a join that
 * records its argument. No socket, so the join path is exercised in a unit
 * test rather than only against a live relay.
 */
function fakeRoom(over: { connected?: boolean; roomId?: string | null; fail?: string } = {}) {
  const joins: string[] = [];
  const room = {
    connected: over.connected ?? false,
    roomId: over.roomId ?? null,
    joins,
    get isConnected() {
      return room.connected;
    },
    status: () => status({ connected: room.connected, roomId: room.roomId }),
    join: async (link: string) => {
      joins.push(link);
      if (over.fail) throw new Error(over.fail);
      room.connected = true;
      room.roomId = RoomClient.parseLink(link).roomId;
      return room.status();
    },
  };
  return room;
}

test("ensureJoined leaves the room alone when no link is passed", async () => {
  const room = fakeRoom();
  assert.deepEqual(await ensureJoined(room, undefined), { joined: false, error: null });
  assert.deepEqual(room.joins, [], "the model's own show_room calls must not join anything");
});

test("ensureJoined joins the link when the process is in no room", async () => {
  const room = fakeRoom();
  assert.deepEqual(await ensureJoined(room, LINK), { joined: true, error: null });
  assert.deepEqual(room.joins, [LINK]);
  assert.equal(room.isConnected, true);
});

test("ensureJoined leaves a process already in that room connected as it was", async () => {
  const room = fakeRoom({ connected: true, roomId: "0123456789abcdef0123" });
  assert.deepEqual(await ensureJoined(room, LINK), { joined: false, error: null });
  assert.deepEqual(room.joins, [], "a poll every two seconds must not rejoin the room it is in");
});

test("ensureJoined moves a process connected to a different room", async () => {
  const room = fakeRoom({ connected: true, roomId: "ffffffffffffffffffff" });
  assert.deepEqual(await ensureJoined(room, LINK), { joined: true, error: null });
  assert.deepEqual(room.joins, [LINK]);
  assert.equal(room.status().roomId, "0123456789abcdef0123");
});

test("ensureJoined reports a link it cannot parse without throwing", async () => {
  const room = fakeRoom();
  const result = await ensureJoined(room, "https://excalidraw.com/#json=abc,def");
  assert.equal(result.joined, false);
  assert.match(result.error ?? "", /not a collaboration link/);
  assert.deepEqual(room.joins, []);
});

test("ensureJoined reports a relay failure so show_room can say why", async () => {
  const room = fakeRoom({ fail: "relay connection failed: boom" });
  const result = await ensureJoined(room, LINK);
  assert.equal(result.joined, false);
  assert.match(result.error ?? "", /relay connection failed/);
  assert.equal(room.isConnected, false);
});

test("NOT_IN_ROOM_TEXT is the string view/src/payload.ts mirrors", () => {
  // The view detects this reply to tell "no room link yet" from an envelope it
  // cannot parse. The two builds share no module, so the literal is pinned in
  // both places and here.
  assert.equal(NOT_IN_ROOM_TEXT, "Not in a room. Call create_room or join_room first.");
});

test("the summary's first line is the room link the view learns from", () => {
  const summary = summariseShowRoom(buildShowRoomPayload(status(), [], []));
  assert.equal(summary.split("\n")[0], `room: ${LINK}`);
});
