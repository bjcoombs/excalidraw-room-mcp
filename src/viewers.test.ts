import assert from "node:assert/strict";
import test from "node:test";
import type { ExcalidrawElement } from "./elements.js";
import { RoomClient, type RoomStatus } from "./room.js";
import { buildShowRoomPayload } from "./view.js";
import {
  MAX_VIEWERS,
  resolveShowRoom,
  VIEWER_IDLE_MS,
  ViewerPool,
  viewersLine,
  type ViewerClient,
} from "./viewers.js";

const KEY = "AbCdEfGhIjKlMnOpQrStUv";
const ROOM_A = "0123456789abcdef0123";
const ROOM_B = "ffffffffffffffffffff";
const LA = `https://excalidraw.com/#room=${ROOM_A},${KEY}`;
const LB = `https://excalidraw.com/#room=${ROOM_B},${KEY}`;

/** A link for a room named by a single hex digit repeated, for the bound tests. */
function linkFor(digit: string): string {
  return `https://excalidraw.com/#room=${digit.repeat(20)},${KEY}`;
}

function element(id: string): ExcalidrawElement {
  return {
    id,
    type: "rectangle",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    boundElements: null,
  } as ExcalidrawElement;
}

/**
 * A RoomClient as the pool uses one: it records the links it was joined to and
 * with which options, holds one element named after its room, and says whether
 * it has been left.
 */
function fakeClient(over: { connected?: boolean; roomId?: string | null } = {}) {
  const joins: { link: string; opts?: { viewer?: boolean } }[] = [];
  const client = {
    joins,
    leaves: 0,
    connected: over.connected ?? false,
    roomId: over.roomId ?? null,
    get isConnected() {
      return client.connected;
    },
    status: (): RoomStatus => ({
      connected: client.connected,
      roomId: client.roomId,
      link: client.roomId ? `https://excalidraw.com/#room=${client.roomId},${KEY}` : null,
      handle: null,
      nearbyRadius: 250,
      agentReplyDepth: 1,
      peers: [],
      elementCount: 1,
      deletedCount: 0,
      sceneVersion: 1,
      lastRemoteUpdate: null,
      source: "peer",
      persistPendingSince: null,
    }),
    getElements: () => (client.roomId ? [element(`el-${client.roomId}`)] : []),
    join: async (link: string, opts?: { viewer?: boolean }) => {
      joins.push({ link, opts });
      client.roomId = RoomClient.parseLink(link).roomId;
      client.connected = true;
      return client.status();
    },
    leave: () => {
      client.leaves += 1;
      client.connected = false;
    },
  };
  return client;
}

/** Timers the test fires by hand, so an idle viewer can be aged without waiting. */
function fakeTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>();
  let next = 0;
  return {
    pending,
    setTimer: (fn: () => void, ms: number) => {
      const handle = next++;
      pending.set(handle, { fn, ms });
      return handle;
    },
    clearTimer: (handle: unknown) => {
      if (typeof handle === "number") pending.delete(handle);
    },
    /** Fire every timer that is still armed. */
    fire: () => {
      for (const [handle, timer] of [...pending]) {
        pending.delete(handle);
        timer.fn();
      }
    },
  };
}

/** A pool over fake clients, with the clients it built in creation order. */
function pool(over: { max?: number; idleMs?: number; timers?: ReturnType<typeof fakeTimers> } = {}) {
  const made: ReturnType<typeof fakeClient>[] = [];
  const timers = over.timers ?? fakeTimers();
  const p = new ViewerPool({
    create: () => {
      const client = fakeClient();
      made.push(client);
      return client as unknown as ViewerClient;
    },
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    max: over.max,
    idleMs: over.idleMs,
  });
  return { p, made, timers };
}

test("show_room with another room link is served by a viewer and leaves the current room unchanged", async () => {
  const current = fakeClient({ connected: true, roomId: ROOM_A });
  const { p, made } = pool();

  const target = await resolveShowRoom(current as unknown as ViewerClient, p, LB);

  assert.equal(target.viewer, true, "the other room is answered from a viewer");
  assert.equal(target.error, null);
  assert.equal(made.length, 1, "one viewer client was built");
  assert.deepEqual(made[0].joins, [{ link: LB, opts: { viewer: true } }], "the viewer joined B, with no handle");

  // The result the tool builds carries B's link and B's elements.
  const payload = buildShowRoomPayload(target.client.status(), target.client.getElements(), []);
  assert.equal(payload.link, LB);
  assert.deepEqual(payload.elements.map((e) => e.id), [`el-${ROOM_B}`]);

  // And the process is still in A: nothing joined, nothing left.
  assert.deepEqual(current.joins, [], "the current room was never re-joined");
  assert.equal(current.leaves, 0);
  assert.equal(current.status().roomId, ROOM_A);
  assert.equal(current.isConnected, true);
  assert.deepEqual(p.roomIds(), [ROOM_B]);
});

test("alternating viewer links reuse two viewers rather than rejoining", async () => {
  const current = fakeClient({ connected: true, roomId: ROOM_A });
  const { p, made } = pool();

  // Room A is this process's own room, so it is never viewed; B and C are.
  const LC = linkFor("c");
  for (let i = 0; i < 4; i++) {
    await resolveShowRoom(current as unknown as ViewerClient, p, LB);
    await resolveShowRoom(current as unknown as ViewerClient, p, LC);
  }

  assert.equal(made.length, 2, "two clients for two rooms, however many polls");
  assert.equal(made[0].joins.length, 1, "the B viewer joined once");
  assert.equal(made[1].joins.length, 1, "the C viewer joined once");
  assert.equal(made[0].leaves, 0, "and neither left in between");
  assert.equal(made[1].leaves, 0);
  assert.equal(p.size, 2);
});

test("an idle viewer is closed and dropped from room_status", async () => {
  const timers = fakeTimers();
  const { p, made } = pool({ timers });

  await p.view(LB);
  assert.equal(viewersLine(p), `viewers: ${ROOM_B}`, "room_status names the room while it is watched");
  assert.equal(timers.pending.size, 1);
  assert.equal([...timers.pending.values()][0].ms, VIEWER_IDLE_MS, "the idle deadline is the pool's");

  timers.fire();

  assert.equal(made[0].leaves, 1, "the idle viewer left the room");
  assert.deepEqual(p.roomIds(), []);
  assert.equal(viewersLine(p), "viewers: -");
  assert.equal(timers.pending.size, 0, "and it left no timer behind");
});

test("the viewer pool evicts the least recently polled beyond eight", async () => {
  const { p, made } = pool();
  const ids = ["1", "2", "3", "4", "5", "6", "7", "8"];

  for (const id of ids) await p.view(linkFor(id));
  assert.equal(p.size, MAX_VIEWERS);
  assert.equal(MAX_VIEWERS, 8);

  // Poll the oldest again, so the second one is now the least recently polled.
  await p.view(linkFor("1"));
  await p.view(linkFor("9"));

  assert.equal(p.size, MAX_VIEWERS, "the pool is still bounded");
  assert.equal(made[1].leaves, 1, "the least recently polled viewer was closed");
  assert.equal(made[0].leaves, 0, "the one polled again was kept");
  const watched = p.roomIds();
  assert.ok(!watched.includes("2".repeat(20)), watched.join(", "));
  assert.ok(watched.includes("1".repeat(20)));
  assert.ok(watched.includes("9".repeat(20)));
  assert.equal(made.length, 9, "the evicted room is the only one that would rejoin");
});

test("show_room without a link, and with the current room's own link, stays on the current room", async () => {
  const current = fakeClient({ connected: true, roomId: ROOM_A });
  const { p, made } = pool();

  for (const link of [undefined, LA]) {
    const target = await resolveShowRoom(current as unknown as ViewerClient, p, link);
    assert.equal(target.viewer, false, `link ${String(link)}`);
    assert.equal(target.client, current as unknown as ViewerClient);
    assert.equal(target.error, null);
  }
  assert.equal(made.length, 0, "no viewer is opened for the room the process is in");
  assert.deepEqual(current.joins, []);
});

test("a process in no room renders a link from a viewer rather than joining it", async () => {
  const current = fakeClient();
  const { p, made } = pool();

  const target = await resolveShowRoom(current as unknown as ViewerClient, p, LB);

  assert.equal(target.viewer, true);
  assert.equal(made.length, 1);
  assert.deepEqual(current.joins, [], "rendering never moves the process into a room");
});

test("a link the pool cannot parse or join is reported rather than thrown", async () => {
  const current = fakeClient({ connected: true, roomId: ROOM_A });
  const { p } = pool();

  const unparsable = await resolveShowRoom(current as unknown as ViewerClient, p, "https://excalidraw.com/#json=abc,def");
  assert.equal(unparsable.viewer, false);
  assert.match(unparsable.error ?? "", /link not viewed: .*not a collaboration link/);

  const failing = new ViewerPool({
    create: () =>
      ({
        join: async () => {
          throw new Error("relay connection failed: boom");
        },
      }) as unknown as ViewerClient,
  });
  const unreachable = await resolveShowRoom(current as unknown as ViewerClient, failing, LB);
  assert.equal(unreachable.viewer, false);
  assert.equal(unreachable.client, current as unknown as ViewerClient);
  assert.match(unreachable.error ?? "", /link not viewed: relay connection failed/);
  assert.deepEqual(failing.roomIds(), [], "a room that could not be joined is not held");
});

test("viewersLine lists every watched room, and a dash when there are none", async () => {
  const { p } = pool();
  assert.equal(viewersLine(p), "viewers: -");
  await p.view(LB);
  await p.view(linkFor("c"));
  assert.equal(viewersLine(p), `viewers: ${ROOM_B}, ${"c".repeat(20)}`);
});

test("the viewer for a room this process then joins is closed, so the room holds one client", async () => {
  const { p, made } = pool();
  await p.view(LB);
  assert.deepEqual(p.roomIds(), [ROOM_B]);

  // What create_room and join_room do once they are in the room.
  p.closeRoom(ROOM_B);

  assert.equal(made[0].leaves, 1);
  assert.deepEqual(p.roomIds(), []);
  p.closeRoom(ROOM_A);
  assert.deepEqual(p.roomIds(), [], "closing a room that is not held does nothing");
});

test("closeAll leaves every room and empties the pool", async () => {
  const { p, made } = pool();
  await p.view(LB);
  await p.view(linkFor("c"));
  p.closeAll();
  assert.deepEqual(p.roomIds(), []);
  for (const client of made) assert.equal(client.leaves, 1);
});
