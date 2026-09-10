import { test } from "node:test";
import assert from "node:assert/strict";
import { buildElements, stampAuthor, type ExcalidrawElement } from "./elements.js";
import { forcedLine, protectedBy, refusalLines } from "./guard.js";

const ctx = () => ({ existing: new Map<string, ExcalidrawElement>(), lastIndex: null });

/** One rectangle, unattributed - the shape a browser broadcasts. */
function drawn(id: string): ExcalidrawElement {
  return buildElements([{ type: "rectangle", id, x: 0, y: 0, width: 100, height: 50 }], ctx()).created[0];
}

/** The same rectangle stamped as `handle`'s work, the way every agent write is. */
function by(id: string, handle: string): ExcalidrawElement {
  return stampAuthor(drawn(id), handle);
}

test("edits to a present agent element are refused unless forced", () => {
  const el = by("ra", "alpha");
  const present = ["alpha"];

  // Guarded for beta, who is not the author.
  assert.equal(protectedBy(el, present, "beta"), "alpha");
  // Never guarded against its own author, even though alpha is in the peer list.
  assert.equal(protectedBy(el, present, "alpha"), null);

  const refusals = [{ id: "ra", owner: "alpha" }];
  const refused = refusalLines(refusals);
  assert.match(refused, /refused/);
  assert.equal(refused, "refused ra (owned by alpha)");

  // force does not change the verdict, it changes what the caller does with it:
  // the same refusal is reported as a forced edit naming the owner.
  const forced = forcedLine(refusals);
  assert.match(forced, /forced/);
  assert.match(forced, /alpha/);
});

test("edits to a departed agent element are allowed", () => {
  const el = by("ra", "alpha");
  // alpha wrote it, then left: the remaining peers are beta and a browser.
  assert.equal(protectedBy(el, ["beta"], "beta"), null);
  assert.equal(protectedBy(el, [], "beta"), null);
  // Present again means protected again, so the empty case is not a stub.
  assert.equal(protectedBy(el, ["beta", "alpha"], "beta"), "alpha");
});

test("person-drawn elements are never protected", () => {
  const el = drawn("hp");
  assert.equal(el.customData, undefined);
  assert.equal(protectedBy(el, ["alpha", "beta"], "beta"), null);
  // An author outside the handle grammar is not an author either: customData
  // arrives from peers unsanitised, so a forged value reads as a person's work
  // rather than protecting anything.
  const forged = { ...el, customData: { author: "Alpha Smith <x>" } } as ExcalidrawElement;
  assert.equal(protectedBy(forged, ["alpha", "beta"], "beta"), null);
});

test("refusal lines list every id in the order asked for", () => {
  assert.equal(
    refusalLines([
      { id: "b", owner: "alpha" },
      { id: "a", owner: "gamma" },
    ]),
    "refused b (owned by alpha)\nrefused a (owned by gamma)",
  );
  assert.equal(refusalLines([]), "");
});

test("a forced edit names each owner once", () => {
  assert.equal(
    forcedLine([
      { id: "a", owner: "beta" },
      { id: "b", owner: "alpha" },
      { id: "c", owner: "alpha" },
    ]),
    "forced 3 edit(s) to elements owned by alpha, beta",
  );
});
