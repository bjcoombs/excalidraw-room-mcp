import { test } from "node:test";
import assert from "node:assert/strict";
import { buildElements, bump, type ExcalidrawElement } from "./elements.js";
import { findMentions, formatMention, nearbyElements } from "./mentions.js";
import { RoomClient } from "./room.js";

const ctx = () => ({ existing: new Map<string, ExcalidrawElement>(), lastIndex: null });

function scene(): ExcalidrawElement[] {
  return buildElements(
    [
      { type: "rectangle", id: "api", x: 0, y: 0, width: 160, height: 80, label: "API" },
      { type: "ellipse", id: "db", x: 400, y: 0, width: 160, height: 80, label: "Postgres" },
      { type: "arrow", id: "api-db", start: "api", end: "db" },
      { type: "text", id: "note", x: 20, y: 120, text: "@Claude add a cache between these" },
      { type: "text", id: "far", x: 3000, y: 3000, text: "unrelated @claude far away" },
      { type: "text", id: "plain", x: 30, y: 200, text: "just a label" },
    ],
    ctx(),
  ).created;
}

test("findMentions is case-insensitive, skips deleted and handled versions", () => {
  const els = scene();
  const found = findMentions(els);
  assert.deepEqual(found.map((m) => m.id).sort(), ["far", "note"]);

  const handled = new Map([["note", found.find((m) => m.id === "note")!.version]]);
  assert.deepEqual(findMentions(els, "@claude", handled).map((m) => m.id), ["far"]);

  // an edit bumps the version, so it is pending again
  const edited = els.map((e) => (e.id === "note" ? bump({ ...e, text: "@claude actually a queue" }) : e));
  assert.deepEqual(findMentions(edited, "@claude", handled).map((m) => m.id).sort(), ["far", "note"]);

  const deleted = els.map((e) => (e.id === "note" ? { ...e, isDeleted: true } : e));
  assert.deepEqual(findMentions(deleted).map((m) => m.id), ["far"]);
});

test("nearbyElements returns what sits around the mention, with bound labels, not the far corner", () => {
  const els = scene();
  const note = findMentions(els).find((m) => m.id === "note")!;
  const near = nearbyElements(els, note);
  const ids = near.map((e) => e.id).sort();
  assert.ok(ids.includes("api"), "api rectangle is within radius");
  assert.ok(ids.includes("api-db"), "arrow is within radius");
  assert.ok(ids.includes("plain"), "other text nearby is included");
  assert.ok(!ids.includes("far"), "far text excluded");
  assert.ok(!ids.includes("note"), "the mention itself is excluded");
  const apiLabel = els.find((e) => e.type === "text" && e.containerId === "api")!;
  assert.ok(ids.includes(apiLabel.id), "bound label of a nearby shape travels with it");
});

test("formatMention renders the text, where it is, and a summary of neighbours", () => {
  const els = scene();
  const note = findMentions(els).find((m) => m.id === "note")!;
  const out = formatMention(note, nearbyElements(els, note));
  assert.match(out, /^mention note v1 at \(20,120\):\n"@Claude add a cache between these"\n\nnearby \(\d+\):\n/);
  assert.match(out, /^api rectangle @\(0,0\) 160x80 "API"$/m);
});

test("waitForMention resolves when a mention arrives from a peer and settles, and times out otherwise", async () => {
  const room = new RoomClient();
  const handled = new Map<string, number>();

  const none = await room.waitForMention("@claude", handled, { timeoutMs: 50, settleMs: 5 });
  assert.equal(none, null);

  const waiting = room.waitForMention("@claude", handled, { timeoutMs: 2000, settleMs: 20 });
  const [first] = buildElements([{ type: "text", id: "m", x: 0, y: 0, text: "@claude" }], ctx()).created;
  setTimeout(() => room.ingestRemote([first]), 10);
  // simulate typing: a newer version lands before the settle window closes
  const second = bump({ ...first, text: "@claude rename this" });
  setTimeout(() => room.ingestRemote([second]), 20);
  const got = await waiting;
  assert.ok(got, "resolved");
  assert.equal(got!.id, "m");
  assert.equal(got!.text, "@claude rename this");
  assert.equal(got!.version, second.version);

  // once handled at that version it is not returned again
  handled.set("m", got!.version);
  const again = await room.waitForMention("@claude", handled, { timeoutMs: 50, settleMs: 5 });
  assert.equal(again, null);
});
