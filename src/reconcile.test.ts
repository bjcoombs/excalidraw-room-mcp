import { test } from "node:test";
import assert from "node:assert/strict";
import { orderByIndex, reconcile, sceneVersion, shouldDiscardRemote } from "./reconcile.js";

const el = (id: string, version: number, versionNonce: number, index: string | null = null) => ({
  id,
  version,
  versionNonce,
  index,
});

test("higher version wins regardless of side", () => {
  assert.equal(shouldDiscardRemote(el("a", 3, 1), el("a", 2, 999)), true);
  assert.equal(shouldDiscardRemote(el("a", 2, 1), el("a", 3, 999)), false);
});

test("equal version: lower nonce wins, local on exact tie", () => {
  assert.equal(shouldDiscardRemote(el("a", 2, 5), el("a", 2, 9)), true);
  assert.equal(shouldDiscardRemote(el("a", 2, 9), el("a", 2, 5)), false);
  assert.equal(shouldDiscardRemote(el("a", 2, 5), el("a", 2, 5)), true);
});

test("reconcile merges by id, keeps local-only elements, orders by index", () => {
  const local = [el("a", 1, 1, "a1"), el("b", 5, 1, "a2"), el("z", 1, 1, "a0")];
  const remote = [el("a", 2, 1, "a1"), el("b", 4, 1, "a2"), el("c", 1, 1, "a3")];
  const out = reconcile(local, remote);
  assert.deepEqual(
    out.map((e) => `${e.id}:${e.version}`),
    ["z:1", "a:2", "b:5", "c:1"],
  );
});

test("orderByIndex puts null indices last", () => {
  const out = orderByIndex([el("n", 1, 1, null), el("a", 1, 1, "a0")]);
  assert.deepEqual(out.map((e) => e.id), ["a", "n"]);
});

test("sceneVersion sums versions", () => {
  assert.equal(sceneVersion([el("a", 2, 0), el("b", 3, 0)]), 5);
});

test("a remote element with no local counterpart is never discarded", () => {
  assert.equal(shouldDiscardRemote(undefined, el("a", 1, 1)), false);
  assert.equal(shouldDiscardRemote(undefined, el("a", 99, 0)), false);
});

test("equal indices keep the order they arrived in", () => {
  // Two elements a peer never indexed, and two it gave the same index.
  assert.deepEqual(orderByIndex([el("n1", 1, 1, null), el("n2", 1, 1, null)]).map((e) => e.id), ["n1", "n2"]);
  assert.deepEqual(orderByIndex([el("s1", 1, 1, "a0"), el("s2", 1, 1, "a0")]).map((e) => e.id), ["s1", "s2"]);
});

test("an id repeated on either side is merged once, first occurrence winning", () => {
  // A relay that re-sends an element inside one payload must not double it.
  assert.deepEqual(
    reconcile([], [el("d", 1, 1, "a0"), el("d", 9, 1, "a0")]).map((e) => `${e.id}:${e.version}`),
    ["d:1"],
  );
  assert.deepEqual(
    reconcile([el("e", 1, 1, "a0"), el("e", 9, 1, "a0")], []).map((e) => `${e.id}:${e.version}`),
    ["e:1"],
  );
});
