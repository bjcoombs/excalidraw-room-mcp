import assert from "node:assert/strict";
import test from "node:test";
import {
  browserLaunchSuppressed,
  browserOpenCommand,
  launchBrowser,
  NO_OPEN_ENV,
  openRoom,
  type SpawnLike,
} from "./open.js";
import { RoomClient, type RoomStatus } from "./room.js";
import { NOT_IN_ROOM_TEXT } from "./view.js";

const LINK = "https://excalidraw.com/#room=0123456789abcdef0123,AbCdEfGhIjKlMnOpQrStUv";
const OTHER_LINK = "https://excalidraw.com/#room=ffffffffffffffffffff,AbCdEfGhIjKlMnOpQrStUv";

/** Records what was spawned without starting anything. */
function fakeSpawn() {
  const calls: { command: string; args: readonly string[]; options: { detached: boolean; stdio: string } }[] = [];
  let unrefs = 0;
  const spawn: SpawnLike = (command, args, options) => {
    calls.push({ command, args, options });
    return {
      unref: () => {
        unrefs += 1;
      },
      on: () => undefined,
    };
  };
  return { spawn, calls, get unrefs() { return unrefs; } };
}

function status(over: Partial<RoomStatus> = {}): RoomStatus {
  return {
    connected: true,
    roomId: "0123456789abcdef0123",
    link: LINK,
    handle: "kt",
    nearbyRadius: 250,
    agentReplyDepth: 1,
    peers: [{ socketId: "sock-1", username: "Ada", kind: "browser" }],
    elementCount: 4,
    deletedCount: 0,
    sceneVersion: 7,
    lastRemoteUpdate: null,
    source: "peer",
    ...over,
  };
}

/** A RoomClient as openRoom sees it: state, and a join that records its link. */
function fakeRoom(over: { connected?: boolean; roomId?: string | null; link?: string | null; fail?: string } = {}) {
  const joins: string[] = [];
  const room = {
    connected: over.connected ?? false,
    roomId: over.roomId ?? null,
    link: over.link ?? (over.connected ? LINK : null),
    joins,
    get isConnected() {
      return room.connected;
    },
    status: () => status({ connected: room.connected, roomId: room.roomId, link: room.link }),
    join: async (link: string) => {
      joins.push(link);
      if (over.fail) throw new Error(over.fail);
      room.connected = true;
      room.roomId = RoomClient.parseLink(link).roomId;
      room.link = link;
      return room.status();
    },
  };
  return room;
}

test("the opener is the platform's own: open, xdg-open, or cmd /c start", () => {
  assert.deepEqual(browserOpenCommand("darwin", LINK), { command: "open", args: [LINK] });
  assert.deepEqual(browserOpenCommand("linux", LINK), { command: "xdg-open", args: [LINK] });
  assert.deepEqual(browserOpenCommand("win32", LINK), { command: "cmd", args: ["/c", "start", "", LINK] });
  // start reads its first quoted argument as the window title, so the empty
  // string in front of the URL is what keeps the URL from being consumed as one.
  assert.equal(browserOpenCommand("win32", LINK).args[2], "");
});

test("an unrecognised platform falls back to the freedesktop opener", () => {
  assert.deepEqual(browserOpenCommand("freebsd", LINK), { command: "xdg-open", args: [LINK] });
});

test("the launch is detached with stdio ignored, and unreferenced", () => {
  // stdout is the MCP transport: a child that inherits it would corrupt the
  // protocol stream, and a referenced child would hold the server open.
  const fake = fakeSpawn();
  const result = launchBrowser(LINK, { platform: "darwin", spawn: fake.spawn });

  assert.equal(result.launched, true);
  assert.equal(result.error, null);
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].command, "open");
  assert.deepEqual(fake.calls[0].options, { detached: true, stdio: "ignore" });
  assert.equal(fake.unrefs, 1);
});

test("a spawn that throws is reported rather than propagated", () => {
  const result = launchBrowser(LINK, {
    platform: "linux",
    spawn: () => {
      throw new Error("ENOENT xdg-open");
    },
  });
  assert.equal(result.launched, false);
  assert.match(result.error ?? "", /ENOENT xdg-open/);
});

test(`${NO_OPEN_ENV} suppresses the launch when set, and not when off or unset`, () => {
  assert.equal(browserLaunchSuppressed({}), false);
  assert.equal(browserLaunchSuppressed({ [NO_OPEN_ENV]: "" }), false);
  assert.equal(browserLaunchSuppressed({ [NO_OPEN_ENV]: "0" }), false);
  assert.equal(browserLaunchSuppressed({ [NO_OPEN_ENV]: "1" }), true);
  assert.equal(browserLaunchSuppressed({ [NO_OPEN_ENV]: "true" }), true);
});

test("open_room returns the link with the room's state and opens the browser once", async () => {
  const fake = fakeSpawn();
  const room = fakeRoom({ connected: true, roomId: "0123456789abcdef0123" });
  const result = await openRoom(room, undefined, { platform: "darwin", env: {}, spawn: fake.spawn });

  assert.equal(result.isError, false);
  assert.ok(result.text.includes(LINK), "the link is in the text");
  assert.match(result.text, /connected: true/);
  assert.match(result.text, /peers: 1/);
  assert.match(result.text, /elements: 4/);
  assert.match(result.text, /Opened in the default browser/);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(room.joins, [], "a room already joined is not rejoined");
});

test(`with ${NO_OPEN_ENV} set the link comes back and nothing is launched`, async () => {
  const fake = fakeSpawn();
  const room = fakeRoom({ connected: true, roomId: "0123456789abcdef0123" });
  const result = await openRoom(room, undefined, { platform: "darwin", env: { [NO_OPEN_ENV]: "1" }, spawn: fake.spawn });

  assert.equal(result.isError, false);
  assert.ok(result.text.includes(LINK));
  assert.match(result.text, new RegExp(`browser not opened: ${NO_OPEN_ENV} is set`));
  assert.deepEqual(fake.calls, [], "nothing is spawned under the opt-out");
});

test("a link joins the room first, then opens it", async () => {
  const fake = fakeSpawn();
  const room = fakeRoom();
  const result = await openRoom(room, LINK, { platform: "linux", env: {}, spawn: fake.spawn });

  assert.deepEqual(room.joins, [LINK]);
  assert.equal(result.isError, false);
  assert.equal(fake.calls[0].command, "xdg-open");
  assert.deepEqual(fake.calls[0].args, [LINK]);
});

test("a link for a room the process is not in moves it there before opening", async () => {
  const fake = fakeSpawn();
  const room = fakeRoom({ connected: true, roomId: "0123456789abcdef0123", link: LINK });
  const result = await openRoom(room, OTHER_LINK, { platform: "darwin", env: {}, spawn: fake.spawn });

  assert.deepEqual(room.joins, [OTHER_LINK]);
  assert.ok(result.text.includes(OTHER_LINK), "the link opened is the room now joined");
  assert.deepEqual(fake.calls[0].args, [OTHER_LINK]);
});

test("in no room and with no link, open_room gives show_room's refusal and launches nothing", async () => {
  const fake = fakeSpawn();
  const room = fakeRoom();
  const result = await openRoom(room, undefined, { platform: "darwin", env: {}, spawn: fake.spawn });

  assert.equal(result.isError, true);
  assert.equal(result.text, NOT_IN_ROOM_TEXT);
  assert.deepEqual(fake.calls, []);
});

test("a link that cannot be joined is reported with the refusal, and nothing is launched", async () => {
  const fake = fakeSpawn();
  const room = fakeRoom({ fail: "relay connection failed: boom" });
  const result = await openRoom(room, LINK, { platform: "darwin", env: {}, spawn: fake.spawn });

  assert.equal(result.isError, true);
  assert.ok(result.text.startsWith(NOT_IN_ROOM_TEXT));
  assert.match(result.text, /relay connection failed/);
  assert.deepEqual(fake.calls, []);
});

test("a failed launch still hands back the link", async () => {
  const room = fakeRoom({ connected: true, roomId: "0123456789abcdef0123" });
  const result = await openRoom(room, undefined, {
    platform: "linux",
    env: {},
    spawn: () => {
      throw new Error("ENOENT xdg-open");
    },
  });

  assert.equal(result.isError, false, "the link is useful even when the opener is missing");
  assert.ok(result.text.includes(LINK));
  assert.match(result.text, /browser not opened: ENOENT xdg-open/);
});
