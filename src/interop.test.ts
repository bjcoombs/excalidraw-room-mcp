/**
 * Known-answer tests against a scene excalidraw.com itself wrote.
 *
 * The other unit tests check this code against this code. These check it
 * against the real thing: a Firestore document persisted by the web app for a
 * disposable test room (tests/fixtures/scene-from-excalidraw-com.json,
 * captured from a live excalidraw.com collaboration room). If upstream
 * changes its encryption, element shape, binding shape, or index scheme,
 * these fail before a user does.
 *
 * Upstream pinned at excalidraw/excalidraw
 * 854d00c31b7105290396fe34294fc2a0331ea469 (master, 2026-09-09). The
 * assertions below were read off these files at that commit:
 *
 *   packages/excalidraw/data/encryption.ts  AES-GCM, 12-byte IV, A128GCM
 *                                           jwk `k` as the room key
 *   excalidraw-app/collab/Portal.tsx        what the web app encrypts and
 *                                           emits on the wire
 *   packages/element/src/types.ts           FixedPointBinding / BindMode,
 *                                           the arrow binding shape
 *   packages/excalidraw/data/reconcile.ts   the version/versionNonce rule
 *
 * Re-pin the SHA and re-read those four files when these fail; do not relax
 * an assertion to make it pass.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decryptJson, generateRoomKey, IV_LENGTH_BYTES } from "./crypto.js";
import { buildElements, summarise, type Binding, type ExcalidrawElement } from "./elements.js";
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
  // This check compares top-level keys only, so it tolerates a change inside a
  // binding object by design; the binding's inner shape is pinned field by field
  // in "upstream persists arrow bindings as the fixed-point orbit shape" below,
  // and ours is compared against the fixture's in "server-built bindings share
  // the key set of the fixture bindings".
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
    assert.match(line!, new RegExp(`^${s.id} freedraw ${s.points!.length} pts: \\(-?\\d+,-?\\d+\\)( -> \\(-?\\d+,-?\\d+\\)){7} by person$`));
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

test("the wire parameters upstream encrypts with are the ones we decrypt with", async () => {
  // packages/excalidraw/data/encryption.ts: IV_LENGTH_BYTES = 12, AES-GCM,
  // ENCRYPTION_KEY_BITS = 128, key exported as the `k` of an A128GCM jwk.
  assert.equal(IV_LENGTH_BYTES, 12);
  assert.equal(Buffer.from(fixture.iv, "base64").length, 12, "the web app's IV is 12 bytes");
  // 128 raw key bits, base64url with no padding, is 22 characters.
  assert.match(fixture.roomKey, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(Buffer.from(fixture.roomKey, "base64url").length, 16);
  // A 12-byte IV means the 16-byte GCM tag is appended to the ciphertext, not
  // carried separately: the payload is longer than the plaintext it holds.
  const bytes = Buffer.from(fixture.ciphertext, "base64");
  const plaintext = Buffer.from(JSON.stringify(await load()), "utf8");
  assert.ok(bytes.length > plaintext.length, "ciphertext carries the appended GCM tag");
  // Truncating the tag must fail the decrypt, not return partial plaintext.
  await assert.rejects(
    decryptJson(fixture.roomKey, Buffer.from(fixture.iv, "base64"), bytes.subarray(0, bytes.length - 1)),
  );
});

test("upstream persists arrow bindings as the fixed-point orbit shape", async () => {
  const els = await load();
  const byId = new Map(els.map((e) => [e.id, e]));
  const arrows = els.filter((e) => e.type === "arrow");
  assert.ok(arrows.length >= 2, "fixture has at least two bound arrows");

  let checked = 0;
  for (const arrow of arrows) {
    for (const end of ["startBinding", "endBinding"] as const) {
      // The declared Binding type here is the legacy shape we emit; the fixture
      // carries what upstream writes, so read it as an open record.
      const binding = arrow[end] as unknown as Record<string, unknown> | null | undefined;
      assert.ok(binding, `${arrow.id} has no ${end}`);
      checked += 1;

      // packages/element/src/types.ts @ 854d00c:
      //   FixedPointBinding = { elementId; fixedPoint: [number, number]; mode: BindMode }
      // Exact key set, so a field added upstream shows up here as a failure.
      assert.deepEqual(
        Object.keys(binding!).sort(),
        ["elementId", "fixedPoint", "mode"],
        `${arrow.id}.${end} is not the fixed-point binding shape`,
      );

      // elementId points at a bindable element that is actually in the scene.
      const target = byId.get(binding!.elementId as string);
      assert.equal(typeof binding!.elementId, "string");
      assert.ok(target, `${arrow.id}.${end}.elementId is a dangling reference`);
      assert.ok(
        ["rectangle", "ellipse", "diamond", "image", "frame", "text", "embeddable"].includes(target!.type),
        `${arrow.id}.${end} binds to a non-bindable ${target!.type}`,
      );

      // fixedPoint is a ratio pair in the 0.0-1.0 range, multiplied by the bound
      // element's width/height to get an element-local point.
      const fixedPoint = binding!.fixedPoint;
      assert.ok(Array.isArray(fixedPoint), `${arrow.id}.${end}.fixedPoint is not an array`);
      assert.equal((fixedPoint as unknown[]).length, 2);
      for (const n of fixedPoint as number[]) {
        assert.equal(typeof n, "number");
        assert.ok(Number.isFinite(n), `${arrow.id}.${end}.fixedPoint has a non-finite ratio`);
        assert.ok(n >= 0 && n <= 1, `${arrow.id}.${end}.fixedPoint ratio ${n} is outside 0..1`);
      }

      // BindMode = "inside" | "orbit" | "skip"; this fixture was drawn with the
      // default, "orbit" (arrow stops outside the shape).
      assert.ok(
        ["inside", "orbit", "skip"].includes(binding!.mode as string),
        `${arrow.id}.${end}.mode is not a BindMode`,
      );
      assert.equal(binding!.mode, "orbit", `${arrow.id}.${end} is no longer the default orbit mode`);

      // focus/gap were the whole of the pre-fixedPoint PointBinding and were
      // removed upstream in c141960ada4869ee6a3bb8a665e75c0c18ad7f19
      // ("feat: Non-elbow arrow snapping and behavior changes", #9670,
      // 2025-11-25). We no longer emit them either (src/elements.ts writes the
      // fixed-point shape), so their reappearance in a persisted scene would
      // mean upstream reverted.
      assert.equal("focus" in binding!, false, `${arrow.id}.${end} carries the removed focus field`);
      assert.equal("gap" in binding!, false, `${arrow.id}.${end} carries the removed gap field`);
    }
  }
  assert.equal(checked, arrows.length * 2, "every arrow in the fixture is bound at both ends");
});

test("a bound arrow is referenced back from the shapes it binds to", async () => {
  const els = await load();
  const byId = new Map(els.map((e) => [e.id, e]));

  for (const arrow of els.filter((e) => e.type === "arrow")) {
    for (const end of ["startBinding", "endBinding"] as const) {
      const binding = arrow[end] as unknown as Record<string, unknown> | null | undefined;
      if (!binding) continue;
      const shape = byId.get(binding.elementId as string)!;
      // The binding is bidirectional: the shape lists the arrow in boundElements.
      // Upstream writes the pair in either key order, so match on the values.
      const refs = (shape.boundElements ?? []).map((r) => `${r.type}:${r.id}`);
      assert.ok(
        refs.includes(`arrow:${arrow.id}`),
        `${shape.id}.boundElements is missing arrow:${arrow.id} (has ${refs.join(", ") || "nothing"})`,
      );
      // ...and every entry is the {id, type} pair shape, nothing wider.
      for (const ref of shape.boundElements ?? []) {
        assert.deepEqual(Object.keys(ref).sort(), ["id", "type"]);
        assert.equal(typeof ref.id, "string");
        assert.ok(byId.has(ref.id), `${shape.id}.boundElements references missing ${ref.id}`);
      }
    }
  }
});

test("reconcile resolves a version tie the way upstream's rule says", async () => {
  // packages/excalidraw/data/reconcile.ts: the remote element wins unless the
  // local one is newer, and a version tie is broken by the lower versionNonce
  // so every peer converges on the same element without talking to the others.
  const els = await load();
  const arrow = els.find((e) => e.type === "arrow")!;
  const rest = els.filter((e) => e.id !== arrow.id);

  const higherNonce = { ...arrow, versionNonce: arrow.versionNonce + 1 };
  const lowerNonce = { ...arrow, versionNonce: arrow.versionNonce - 1 };
  const pick = (local: ExcalidrawElement, remote: ExcalidrawElement) =>
    reconcile([...rest, local], [...rest, remote]).find((e) => e.id === arrow.id)!.versionNonce;
  assert.equal(pick(lowerNonce, higherNonce), lowerNonce.versionNonce, "lower local nonce wins the tie");
  assert.equal(pick(higherNonce, lowerNonce), lowerNonce.versionNonce, "lower remote nonce wins the tie");

  // A higher version wins regardless of nonce.
  const newerRemote = { ...arrow, version: arrow.version + 1, versionNonce: arrow.versionNonce + 1000 };
  assert.equal(pick(arrow, newerRemote), newerRemote.versionNonce);
  const newerLocal = { ...arrow, version: arrow.version + 1, versionNonce: arrow.versionNonce + 1000 };
  assert.equal(pick(newerLocal, arrow), newerLocal.versionNonce);
});

test("server-built bindings share the key set of the fixture bindings", async () => {
  // The fixture is the reference: whatever key set excalidraw.com persisted for
  // its own bound arrows is the key set our writer has to produce.
  const els = await load();
  const fixtureKeySets = els
    .filter((e) => e.type === "arrow")
    .flatMap((a) => [a.startBinding, a.endBinding])
    .filter((b) => b !== null && b !== undefined)
    .map((b) => Object.keys(b!).sort().join(","));
  assert.ok(fixtureKeySets.length >= 2, "fixture has bound arrows to compare against");
  assert.equal(new Set(fixtureKeySets).size, 1, "the fixture's bindings do not agree on a key set");
  const expected = fixtureKeySets[0];

  const ours = buildElements(
    [
      { type: "rectangle", id: "r", x: 0, y: 0, width: 100, height: 50 },
      { type: "rectangle", id: "e", x: 300, y: 0, width: 100, height: 50 },
      { type: "arrow", id: "a", start: "r", end: "e" },
    ],
    { existing: new Map(), lastIndex: null },
  ).created;
  const arrow = ours.find((el) => el.id === "a")!;
  for (const end of ["startBinding", "endBinding"] as const) {
    const binding = arrow[end] as Binding | null;
    assert.ok(binding, `our arrow has no ${end}`);
    assert.equal(
      Object.keys(binding!).sort().join(","),
      expected,
      `our ${end} is not the key set upstream persists`,
    );
    assert.equal(binding!.mode, "orbit");
    assert.ok(Array.isArray(binding!.fixedPoint) && binding!.fixedPoint.length === 2);
  }
});
