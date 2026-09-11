import assert from "node:assert/strict";
import test from "node:test";
import { paintRefusal, roomIdOf, sameRoom, WAITING_FOR_LINK_TEXT } from "./link.js";
import { linkFromSummary, type ShowRoomPayload } from "./payload.js";

const KEY = "AbCdEfGhIjKlMnOpQrStUv";
const ROOM_A = "0123456789abcdef0123";
const ROOM_B = "ffffffffffffffffffff";
const LA = `https://excalidraw.com/#room=${ROOM_A},${KEY}`;
const LB = `https://excalidraw.com/#room=${ROOM_B},${KEY}`;

function payload(link: string | null): ShowRoomPayload {
  return { link, connected: true, peers: [], elements: [{ id: "el-1", version: 1, versionNonce: 2 }], mentions: [] };
}

/**
 * The widget's link handling, as app.tsx runs it: the seed names the room, and
 * every later payload is measured against it. Returns what reached the canvas
 * and what the status bar was left saying.
 */
function widget() {
  let seeded: string | null = null;
  let painted: ShowRoomPayload | null = null;
  let note: string | null = null;
  return {
    get painted(): ShowRoomPayload | null {
      return painted;
    },
    get note(): string | null {
      return note;
    },
    /** A seed result, which in the real widget is a summary naming the room. */
    seed(summary: string) {
      seeded = linkFromSummary(summary);
    },
    /** A poll's payload. */
    receive(next: ShowRoomPayload) {
      const refusal = paintRefusal(seeded, next.link);
      if (refusal) note = refusal;
      else painted = next;
    },
  };
}

test("a payload for another room is not painted and the status names the mismatch", () => {
  const view = widget();
  view.seed(`room: ${LA}\nconnected: true`);

  view.receive(payload(LA));
  assert.equal(view.painted?.link, LA, "its own room is painted");

  view.receive(payload(LB));

  assert.equal(view.painted?.link, LA, "the canvas still holds room A");
  assert.ok(view.note?.includes("another room"), view.note ?? "no note");
  assert.ok(view.note?.includes(ROOM_A), view.note ?? "no note");
  assert.ok(view.note?.includes(ROOM_B), view.note ?? "no note");
  assert.ok(!view.note?.includes(KEY), "the room key of a room this canvas is not for stays out of the bar");
});

test("a widget with no link paints nothing and waits for a room link", () => {
  const view = widget();

  view.receive(payload(LA));

  const beforeAnyLink = view.painted;
  assert.equal(beforeAnyLink, null, "nothing reaches the canvas before a room link does");
  assert.equal(view.note, WAITING_FOR_LINK_TEXT);
  assert.ok(WAITING_FOR_LINK_TEXT.startsWith("Waiting for a room link"));

  // Once the seed names the room, that room paints.
  view.seed(`room: ${LA}`);
  view.receive(payload(LA));
  assert.equal(view.painted?.link, LA);
});

test("a payload with no link at all is refused rather than painted", () => {
  const refusal = paintRefusal(LA, null);
  assert.ok(refusal?.includes("no room"), refusal ?? "it was painted");
  assert.equal(paintRefusal(LA, LA), null, "its own room is not refused");
});

test("the same room in a link with a different key is still the same room", () => {
  assert.equal(roomIdOf(LA), ROOM_A);
  assert.equal(roomIdOf(null), null);
  assert.equal(roomIdOf("https://excalidraw.com/#json=abc,def"), null);
  assert.ok(sameRoom(LA, `https://excalidraw.com/#room=${ROOM_A},zzzzzzzzzzzzzzzzzzzzzz`));
  assert.ok(!sameRoom(LA, LB));
  assert.ok(!sameRoom(null, null), "two unknown rooms are not the same room");
});
