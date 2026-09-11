/**
 * Persistence retry, the dirty flag, and the result lines that report them
 * (issue #113). A commit whose scene reached the peers but not the stored
 * copy used to come back as `updated 12 element(s) (not persisted: ...)`,
 * with nothing scheduled to try again.
 *
 * The client is driven with `joinOffline` and fake Firestore calls, so every
 * path here is the real one minus the relay and the network.
 */
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { ExcalidrawElement } from "./elements.js";
import { SceneConflictError, type StoredScene } from "./firebase.js";
import { commitLine, persistedLine, RoomClient, type RoomDeps } from "./room.js";

const LINK = "https://excalidraw.com/#room=44370699de248c2fed0a,CGRLjH7340vVPvMRyjFIrg";
const CONFLICT = "scene changed underneath us: 400 FAILED_PRECONDITION";

function note(id: string): ExcalidrawElement {
  return {
    id,
    type: "text",
    x: 0,
    y: 0,
    width: 100,
    height: 25,
    text: "hello",
    version: 2,
    versionNonce: 7,
    isDeleted: false,
    boundElements: null,
  } as unknown as ExcalidrawElement;
}

/** A room whose saves fail while `state.fail` is true, counting what it did. */
function fakeRoom(state: { fail: boolean }, extra: RoomDeps = {}) {
  const seen = { saves: 0, loads: 0, delays: [] as number[] };
  const room = new RoomClient({
    saveScene: async () => {
      seen.saves++;
      if (state.fail) throw new SceneConflictError(CONFLICT);
      return "2026-09-11T10:00:00.000000Z";
    },
    loadScene: async (): Promise<StoredScene | null> => {
      seen.loads++;
      return null;
    },
    delay: async (ms: number) => {
      seen.delays.push(ms);
    },
    schedule: () => {},
    ...extra,
  });
  room.joinOffline(LINK);
  return { room, seen };
}

/** Let the pending promise chain of a fired timer run out. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

test("persist retries on repeated conflict and succeeds on the third attempt", async () => {
  const seen = { saves: 0, loads: 0, delays: [] as number[] };
  const room = new RoomClient({
    saveScene: async () => {
      seen.saves++;
      if (seen.saves < 3) throw new SceneConflictError(CONFLICT);
      return "2026-09-11T10:00:00.000000Z";
    },
    loadScene: async () => {
      seen.loads++;
      return null;
    },
    delay: async (ms: number) => {
      seen.delays.push(ms);
    },
    schedule: () => {},
  });
  room.joinOffline(LINK);

  const result = await room.commit([note("n1")]);
  assert.equal(result.persisted, true);
  assert.equal(result.error, undefined);
  assert.equal(seen.saves, 3, "two conflicts then a write that stuck");
  assert.deepEqual(seen.delays, [250, 500], "250 ms, doubling");
  assert.equal(seen.loads, 2, "the newer scene is read back before each retry");
  assert.equal(room.status().persistPendingSince, null, "nothing is owed");
});

test("commit after exhausted retries returns persisted false and a later background persist clears dirty", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const state = { fail: true };
    // The default schedule, so the 2 s background wait is the one shipped.
    const { room, seen } = fakeRoom(state, { schedule: undefined });

    const result = await room.commit([note("n1")]);
    assert.equal(result.persisted, false);
    assert.match(result.error ?? "", /scene changed underneath us/);
    assert.equal(seen.saves, 5, "five attempts");
    assert.deepEqual(seen.delays, [250, 500, 1000, 2000]);
    const pending = room.status().persistPendingSince;
    assert.ok(pending, "the scene is marked dirty");
    assert.ok(!Number.isNaN(Date.parse(pending!)), `${pending} is a time`);

    state.fail = false;
    mock.timers.tick(1999);
    await settle();
    assert.equal(seen.saves, 5, "nothing before the 2 s wait is up");

    mock.timers.tick(1);
    await settle();
    assert.equal(seen.saves, 6, "the background attempt ran");
    assert.equal(room.status().persistPendingSince, null, "and cleared the flag");
  } finally {
    mock.timers.reset();
  }
});

test("leave persists a dirty scene", async () => {
  const state = { fail: true };
  const { room, seen } = fakeRoom(state);

  assert.equal((await room.commit([note("n1")])).persisted, false);
  assert.equal(seen.saves, 5);
  assert.ok(room.status().persistPendingSince, "dirty going in");

  state.fail = false;
  room.leave();
  assert.ok(room.pendingPersist, "leave started the final attempt");
  await room.pendingPersist;
  assert.equal(seen.saves, 6, "one final persist");
  assert.equal(room.status().persistPendingSince, null, "and the scene is no longer owed");

  // A clean scene has nothing to flush, so leaving does not write.
  const clean = fakeRoom({ fail: false });
  assert.equal((await clean.room.commit([note("n2")])).persisted, true);
  clean.room.leave();
  assert.equal(clean.room.pendingPersist, null);
  assert.equal(clean.seen.saves, 1);
});

test("update_elements result leads with NOT PERSISTED when commit did not persist", async () => {
  const { room } = fakeRoom({ fail: true });
  const failed = await room.commit([note("n1")]);
  assert.equal(failed.persisted, false);

  const line = commitLine(`updated ${12} element(s)`, failed);
  assert.ok(
    line.startsWith("NOT PERSISTED (retrying in background): updated 12 element(s); "),
    line,
  );
  assert.match(line, /scene changed underneath us/);
  // The success form is the line as it always was.
  assert.equal(commitLine("updated 12 element(s)", { persisted: true }), "updated 12 element(s)");
});

test("room_status reports pending persistence", async () => {
  const state = { fail: false };
  const { room } = fakeRoom(state);
  assert.equal((await room.commit([note("n1")])).persisted, true);
  assert.equal(persistedLine(room.status()), "persisted: yes");

  state.fail = true;
  assert.equal((await room.commit([note("n2")])).persisted, false);
  const line = persistedLine(room.status());
  assert.match(line, /^persisted: pending since \d{4}-\d\d-\d\dT[\d:.]+Z$/);
  assert.equal(line, `persisted: pending since ${room.status().persistPendingSince}`);
});

test("add_elements, add_raw_elements and delete_elements results lead with NOT PERSISTED when commit did not persist", async () => {
  const { room } = fakeRoom({ fail: true });
  const failed = await room.commit([note("n1")]);
  assert.equal(failed.persisted, false);

  for (const base of ["added 3 element(s)", "deleted 2 element(s)"]) {
    const line = commitLine(base, failed);
    assert.ok(line.startsWith(`NOT PERSISTED (retrying in background): ${base}; `), line);
    assert.match(line, /scene changed underneath us/);
    assert.equal(commitLine(base, { persisted: true }), base);
  }
});
