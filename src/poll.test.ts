import { test } from "node:test";
import assert from "node:assert/strict";
import type { Mention } from "./mentions.js";
import { MENTION_SCOPE_RULE, UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "./mentions.js";
import { buildPollPayload, pollBody, POLL_TEXT_LIMIT, pollText, type PollState } from "./poll.js";
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
  const out = pollBody(payload);
  assert.ok(out.length < POLL_TEXT_LIMIT, `expected under ${POLL_TEXT_LIMIT} characters, got ${out.length}`);
  const parsed = JSON.parse(out.split("\n")[0]);
  assert.equal(parsed.peerCount, 8);
  assert.equal(parsed.pendingCount, 10);
  assert.equal(parsed.changedSince, true);
  assert.ok(payload.pendingMentions.length >= 1);
  for (const m of payload.pendingMentions) assert.equal(typeof m.id, "string");
});

test("mention text is kept whole when it fits and shortened when it does not", () => {
  const short = buildPollPayload(state({ pending: [mention("n1", "@claude tidy this")] }));
  assert.equal(short.pendingMentions[0].text, "@claude tidy this");
  const long = buildPollPayload(
    state({ pending: Array.from({ length: 6 }, (_, i) => mention(`n${i}`, "@claude ".padEnd(120, "x"))) }),
  );
  assert.ok(long.pendingMentions[0].text.length < 120);
  assert.ok(pollBody(long).length < POLL_TEXT_LIMIT);
});

test("newlines in mention text collapse to one line", () => {
  const payload = buildPollPayload(state({ pending: [mention("n1", "@claude one\n  two\tthree")] }));
  assert.equal(payload.pendingMentions[0].text, "@claude one two three");
});

test("peer names are sacrificed before mention text", () => {
  const peers = Array.from({ length: 6 }, (_, i) => ({ socketId: `sock-${i}`, username: `Collaborator number ${i}` }));
  const note = "@claude move the queue box above the worker";
  const payload = buildPollPayload(state({ status: status({ peers }), pending: [mention("n1", note)] }));
  assert.equal(payload.pendingMentions[0].text, note);
  assert.ok(payload.peers.length < 6);
  assert.equal(payload.peerCount, 6);
  assert.ok(pollBody(payload).length <= POLL_TEXT_LIMIT);
});

test("poll_room prints one line per unacknowledged mention as `mention <id> - <text>`", () => {
  const pending = [mention("n1", "@claude add a box here"), mention("n2", "@claude look in my calendar")];
  const payload = buildPollPayload(state({ pending }));
  const out = pollText(payload);
  const lines = out.split("\n");

  // One line per mention, id then a hyphen then the words. Nothing about who
  // announced it: the widget's button counts what is pending and asks nobody.
  assert.ok(lines.includes("mention n1 - @claude add a box here"), out);
  assert.ok(lines.includes("mention n2 - @claude look in my calendar"), out);
  assert.equal(payload.pendingCount, 2);
  assert.ok(!out.includes("announced"), out);

  // The words are a person's, so they sit inside the block and the rule follows.
  const open = lines.indexOf(UNTRUSTED_OPEN);
  const close = lines.indexOf(UNTRUSTED_CLOSE);
  assert.ok(open >= 0 && close > open, out);
  for (const [i, line] of lines.entries()) {
    if (line.startsWith("mention ")) assert.ok(i > open && i < close, `mention line ${i} outside the block`);
  }
  assert.ok(out.includes(MENTION_SCOPE_RULE), out);
});
