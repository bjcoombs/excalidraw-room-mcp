import { test } from "node:test";
import assert from "node:assert/strict";
import { buildElements, summarise, type ExcalidrawElement } from "./elements.js";
import { reconcile } from "./reconcile.js";
import { selectElements, unknownIdsText } from "./scene.js";

const ctx = () => ({ existing: new Map<string, ExcalidrawElement>(), lastIndex: null });

function scene(): ExcalidrawElement[] {
  return buildElements(
    [
      { type: "rectangle", id: "hub", x: 0, y: 0, width: 100, height: 50 },
      { type: "rectangle", id: "near1", x: 150, y: 0, width: 100, height: 50 },
      { type: "rectangle", id: "far1", x: 2000, y: 2000, width: 100, height: 50 },
      { type: "arrow", id: "hub-near1", start: "hub", end: "near1" },
    ],
    ctx(),
  ).created;
}

test("no filter returns the scene unchanged, in order", () => {
  const els = scene();
  const { elements, unknownIds } = selectElements(els);
  assert.deepEqual(elements.map((e) => e.id), ["hub", "near1", "far1", "hub-near1"]);
  assert.deepEqual(unknownIds, []);
  assert.notEqual(elements, els);
});

test("ids returns only those elements and names unknown ids", () => {
  const { elements, unknownIds } = selectElements(scene(), { ids: ["hub", "nope"] });
  assert.deepEqual(elements.map((e) => e.id), ["hub"]);
  assert.deepEqual(unknownIds, ["nope"]);
});

test("ids preserves scene order, not the order asked for", () => {
  const { elements } = selectElements(scene(), { ids: ["far1", "hub"] });
  assert.deepEqual(elements.map((e) => e.id), ["hub", "far1"]);
});

test("near returns the anchor plus elements within the radius", () => {
  const { elements, unknownIds } = selectElements(scene(), { near: { id: "hub", radius: 300 } });
  const ids = elements.map((e) => e.id);
  assert.ok(ids.includes("hub"));
  assert.ok(ids.includes("near1"));
  assert.ok(!ids.includes("far1"));
  assert.deepEqual(unknownIds, []);
});

test("near with a small radius returns the anchor alone", () => {
  const { elements } = selectElements(scene(), { near: { id: "far1", radius: 10 } });
  assert.deepEqual(elements.map((e) => e.id), ["far1"]);
});

test("an unknown near id yields no elements and names the id", () => {
  const { elements, unknownIds } = selectElements(scene(), { near: { id: "ghost", radius: 300 } });
  assert.deepEqual(elements, []);
  assert.deepEqual(unknownIds, ["ghost"]);
});

test("ids and near intersect", () => {
  const { elements } = selectElements(scene(), {
    ids: ["near1", "far1"],
    near: { id: "hub", radius: 300 },
  });
  assert.deepEqual(elements.map((e) => e.id), ["near1"]);
});

test("deleted elements are dropped from a near selection but kept by id", () => {
  const els = scene();
  els.find((e) => e.id === "near1")!.isDeleted = true;
  const ids = selectElements(els, { near: { id: "hub", radius: 300 } }).elements.map((e) => e.id);
  assert.ok(ids.includes("hub"));
  assert.ok(!ids.includes("near1"));
  assert.deepEqual(selectElements(els, { ids: ["near1"] }).elements.map((e) => e.id), ["near1"]);
});

test("unknownIdsText names every id", () => {
  assert.equal(unknownIdsText(["a", "b"]), "unknown id(s): a, b");
});

test("legacy focus and gap bindings load without error", () => {
  // A scene written before upstream replaced the focus/gap pair with fixedPoint
  // still carries the older binding object. Every read path here must load it
  // without throwing and without losing the arrow or the ids it binds.
  const els = scene();
  const legacy = els.map((el) =>
    el.id === "hub-near1"
      ? {
          ...el,
          startBinding: { elementId: "hub", focus: 0, gap: 4, fixedPoint: null },
          endBinding: { elementId: "near1", focus: 0.3, gap: 8, fixedPoint: null },
        }
      : el,
  );

  const { elements, unknownIds } = selectElements(legacy, { ids: ["hub-near1"] });
  assert.deepEqual(unknownIds, []);
  assert.deepEqual(elements.map((e) => e.id), ["hub-near1"]);

  const near = selectElements(legacy, { near: { id: "hub", radius: 100 } });
  assert.deepEqual(near.unknownIds, []);

  const merged = reconcile(legacy, legacy);
  const arrow = merged.find((e) => e.id === "hub-near1")!;
  assert.equal(arrow.startBinding!.elementId, "hub");
  assert.equal(arrow.endBinding!.elementId, "near1");
  assert.match(summarise(merged), /^hub-near1 arrow .* from hub to near1 by person$/m);
});
