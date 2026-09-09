import { test } from "node:test";
import assert from "node:assert/strict";
import type { Mention } from "./mentions.js";
import { buildPollPayload, POLL_TEXT_LIMIT, pollText, type PollState } from "./poll.js";
import type { RoomStatus } from "./room.js";

function status(over: Partial<RoomStatus> = {}): RoomStatus {
  return {
    connected: true,
    roomId: "room1",
    link: "https://excalidraw.com/#room=room1,0123456789abcdefghijkl",
    peers: [{ socketId: "sock-1", username: "Ada" }],
    elementCount: 3,
    deletedCount: 0,
    sceneVersion: 120,
    lastRemoteUpdate: "2026-01-01T00:00:00.000Z",
    source: "peer",
    ...over,
  };
}

function mention(id: string, text: string): Mention {
  return { id, version: 4, text, x: 0, y: 0, width: 100, height: 25, containerId: null };
}

function state(over: Partial<PollState> = {}): PollState {
  return { status: status(), pending: [], ...over };
}

test("payload reports connection, scene version, peers and pending mentions", () => {
  const s = state({ pending: [mention("n1", "@claude label this")] });
  const payload = buildPollPayload(s, undefined);
  assert.deepEqual(payload, {
    connected: true,
    sceneVersion: 120,
    peerCount: 1,
    peers: ["Ada"],
    pendingCount: 1,
    pendingMentions: [{ id: "n1", text: "@claude label this" }],
    changedSince: true,
  });
});

test("a peer with no username is named by its socket id", () => {
  const payload = buildPollPayload(state({ status: status({ peers: [{ socketId: "sock-1", username: null }] }) }));
  assert.deepEqual(payload.peers, ["sock-1"]);
});

test("changedSince is false when sinceVersion matches and true when the scene moved on", () => {
  assert.equal(buildPollPayload(state(), 120).changedSince, false);
  assert.equal(buildPollPayload(state(), 119).changedSince, true);
  assert.equal(buildPollPayload(state(), 121).changedSince, true);
});

test("changedSince is true with no sinceVersion to compare against", () => {
  assert.equal(buildPollPayload(state()).changedSince, true);
});

test("a disconnected room still reports a parseable payload", () => {
  const payload = buildPollPayload(
    state({ status: status({ connected: false, peers: [], sceneVersion: 0 }) }),
    0,
  );
  assert.deepEqual(payload, {
    connected: false,
    sceneVersion: 0,
    peerCount: 0,
    peers: [],
    pendingCount: 0,
    pendingMentions: [],
    changedSince: false,
  });
});

test("text stays under the limit with ten pending mentions and eight peers", () => {
  const pending = Array.from({ length: 10 }, (_, i) =>
    mention(`element-id-${i}-abcdefghij`, `@claude please redraw the whole left hand column, note ${i}`),
  );
  const peers = Array.from({ length: 8 }, (_, i) => ({ socketId: `sock-${i}`, username: `Collaborator ${i}` }));
  const payload = buildPollPayload(state({ status: status({ peers }), pending }), 3);
  const out = pollText(payload);
  assert.ok(out.length < POLL_TEXT_LIMIT, `expected under ${POLL_TEXT_LIMIT} characters, got ${out.length}`);
  const parsed = JSON.parse(out);
  assert.equal(parsed.peerCount, 8);
  assert.equal(parsed.pendingCount, 10);
  assert.ok(parsed.pendingMentions.length >= 1);
  assert.equal(parsed.changedSince, true);
  for (const m of parsed.pendingMentions) assert.equal(typeof m.id, "string");
});

test("mention text is kept whole when it fits and shortened when it does not", () => {
  const short = buildPollPayload(state({ pending: [mention("n1", "@claude tidy this")] }));
  assert.equal(short.pendingMentions[0].text, "@claude tidy this");
  const long = buildPollPayload(
    state({ pending: Array.from({ length: 6 }, (_, i) => mention(`n${i}`, "@claude ".padEnd(120, "x"))) }),
  );
  assert.ok(long.pendingMentions[0].text.length < 120);
  assert.ok(pollText(long).length < POLL_TEXT_LIMIT);
});

test("newlines in mention text collapse to one line", () => {
  const payload = buildPollPayload(state({ pending: [mention("n1", "@claude one\n  two\tthree")] }));
  assert.equal(payload.pendingMentions[0].text, "@claude one two three");
});
