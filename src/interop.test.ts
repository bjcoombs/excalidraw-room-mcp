/**
 * Known-answer tests against a scene excalidraw.com itself wrote.
 *
 * The other unit tests check this code against this code. These check it
 * against the real thing: a Firestore document persisted by the web app for a
 * disposable test room (tests/fixtures/scene-from-excalidraw-com.json). If
 * upstream changes its encryption, element shape, or index scheme, these fail
 * before a user does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptJson, generateRoomKey } from "./crypto.js";
import { buildElements, summarise, type ExcalidrawElement } from "./elements.js";
import { orderByIndex, reconcile } from "./reconcile.js";
import { RoomClient } from "./room.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(path.join(here, "..", "tests", "fixtures", "scene-from-excalidraw-com.json"), "utf8"),
) as { roomId: string; roomKey: string; sceneVersion: number; iv: string; ciphertext: string };

async function load(): Promise<ExcalidrawElement[]> {
  return decryptJson<ExcalidrawElement[]>(
    fixture.roomKey,
    Buffer.from(fixture.iv, "base64"),
    Buffer.from(fixture.ciphertext, "base64"),
  );
}

test("decrypts a scene encrypted by excalidraw.com with the key from its link", async () => {
  const link = `https://excalidraw.com/#room=${fixture.roomId},${fixture.roomKey}`;
  assert.equal(RoomClient.parseLink(link).roomKey, fixture.roomKey);
  const els = await load();
  assert.equal(els.length, 21);
  assert.deepEqual(new Set(els.map((e) => e.type)), new Set(["freedraw", "rectangle", "text", "ellipse", "arrow"]));
  // sceneVersion upstream is the sum of element versions
  assert.equal(els.reduce((n, e) => n + e.version, 0), fixture.sceneVersion);
  await assert.rejects(
    decryptJson(await generateRoomKey(), Buffer.from(fixture.iv, "base64"), Buffer.from(fixture.ciphertext, "base64")),
  );
});

test("every field the web app writes is one our builders also emit", async () => {
  const els = await load();
  const ours = buildElements(
    [
      { type: "rectangle", id: "r", label: "L" },
      { type: "ellipse", id: "e" },
      { type: "arrow", id: "a", start: "r", end: "e", label: "x" },
      { type: "freedraw", id: "f", points: [[0, 0], [1, 1]] },
    ],
    { existing: new Map(), lastIndex: null },
  ).created;
  const oursByType = new Map(ours.map((e) => [e.type, new Set(Object.keys(e))]));
  // Fields upstream writes that we deliberately do not: documented, not accidental.
  const allowed: Record<string, string[]> = {
    freedraw: ["strokeOptions"], // pen-style options added upstream after 0.18; the app defaults them when absent
    text: ["labelPosition"], // placement hint for bound labels; the app derives it when absent
  };
  // Note: upstream arrow bindings are now {elementId, mode: "orbit", fixedPoint: [x, y]}.
  // We emit the legacy {elementId, focus, gap, fixedPoint: null} shape, which the app
  // accepts and normalises (this fixture's arrow started life as our shape). The check
  // below compares top-level keys, so a change in the binding's inner shape is tolerated
  // by design; a new top-level field on the arrow is not.
  for (const el of els) {
    const mine = oursByType.get(el.type);
    if (!mine) continue;
    const missing = Object.keys(el).filter((k) => !mine.has(k) && !(allowed[el.type] ?? []).includes(k));
    assert.deepEqual(missing, [], `${el.type} ${el.id} has fields we never emit: ${missing.join(", ")}`);
  }
});

test("a freehand stroke drawn by a person is summarised as a legible path", async () => {
  const els = await load();
  const strokes = els.filter((e) => e.type === "freedraw" && (e.points?.length ?? 0) > 10);
  assert.ok(strokes.length >= 2, "fixture has at least two real pen strokes");
  const summary = summarise(els);
  for (const s of strokes) {
    const line = summary.split("\n").find((l) => l.startsWith(s.id));
    assert.ok(line, `no summary line for ${s.id}`);
    assert.match(line!, new RegExp(`^${s.id} freedraw ${s.points!.length} pts: \\(-?\\d+,-?\\d+\\)( -> \\(-?\\d+,-?\\d+\\)){7}$`));
  }
  // bound labels fold into their container rather than appearing as separate lines
  assert.match(summary, /^api rectangle @\(100,100\) 180x90 "API"/m);
  assert.doesNotMatch(summary, /^\S+ text /m);
});

test("the web app's fractional indices are already ordered and reconcile is a no-op on a settled scene", async () => {
  const els = await load();
  const indices = els.map((e) => e.index as string);
  assert.deepEqual(orderByIndex(els).map((e) => e.index), [...indices].sort());
  assert.equal(new Set(indices).size, indices.length, "indices are unique");
  const merged = reconcile(els, els);
  assert.deepEqual(merged.map((e) => `${e.id}:${e.version}`), orderByIndex(els).map((e) => `${e.id}:${e.version}`));
});
