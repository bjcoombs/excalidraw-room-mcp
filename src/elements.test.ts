import { test } from "node:test";
import assert from "node:assert/strict";
import { buildElements, bump, summarise, type ExcalidrawElement } from "./elements.js";

const REQUIRED = [
  "id", "type", "x", "y", "width", "height", "angle", "strokeColor", "backgroundColor",
  "fillStyle", "strokeWidth", "strokeStyle", "roughness", "opacity", "groupIds", "frameId",
  "index", "roundness", "seed", "version", "versionNonce", "isDeleted", "boundElements",
  "updated", "link", "locked",
];

const ctx = () => ({ existing: new Map<string, ExcalidrawElement>(), lastIndex: null });

test("shape with label produces a bound text element and complete fields", () => {
  const { created } = buildElements(
    [{ type: "rectangle", id: "api", x: 10, y: 20, width: 200, height: 100, label: "API" }],
    ctx(),
  );
  assert.equal(created.length, 2);
  const [rect, label] = created;
  for (const key of REQUIRED) assert.ok(key in rect, `rectangle missing ${key}`);
  assert.equal(rect.id, "api");
  assert.deepEqual(rect.boundElements, [{ id: label.id, type: "text" }]);
  assert.equal(label.containerId, "api");
  assert.equal(label.text, "API");
  assert.ok(label.x > rect.x && label.x < rect.x + rect.width, "label sits inside the shape");
  assert.ok(rect.index !== null && label.index !== null && rect.index! < label.index!, "indices ascend");
});

test("arrow between two shapes is bound at both ends and back-referenced", () => {
  const { created } = buildElements(
    [
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 50 },
      { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 50 },
      { type: "arrow", id: "ab", start: "a", end: "b", label: "calls" },
    ],
    ctx(),
  );
  const byId = new Map(created.map((e) => [e.id, e]));
  const arrow = byId.get("ab")!;
  assert.equal(arrow.startBinding?.elementId, "a");
  assert.equal(arrow.endBinding?.elementId, "b");
  assert.equal(arrow.points!.length, 2);
  // starts just outside a's right edge (x=100), ends just outside b's left edge (x=300)
  assert.ok(arrow.x > 100 && arrow.x <= 105, `arrow.x=${arrow.x}`);
  const endX = arrow.x + arrow.points![1][0];
  assert.ok(endX >= 295 && endX < 300, `endX=${endX}`);
  assert.ok(byId.get("a")!.boundElements!.some((b) => b.id === "ab"));
  assert.ok(byId.get("b")!.boundElements!.some((b) => b.id === "ab"));
  assert.ok(arrow.boundElements!.some((b) => b.type === "text"));
});

test("arrow to a pre-existing element reports that element as updated", () => {
  const existing = buildElements([{ type: "ellipse", id: "db", x: 500, y: 0 }], ctx()).created;
  const { created, updated } = buildElements(
    [{ type: "rectangle", id: "svc", x: 0, y: 0 }, { type: "arrow", start: "svc", end: "db" }],
    { existing: new Map(existing.map((e) => [e.id, e])), lastIndex: existing[0].index as string },
  );
  assert.equal(created.length, 2);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].id, "db");
  assert.equal(updated[0].version, 2);
  assert.ok(created.every((e) => (e.index as string) > (existing[0].index as string)));
});

test("freedraw stores points relative to its origin", () => {
  const { created } = buildElements(
    [{ type: "freedraw", points: [[10, 10], [20, 15], [30, 40]] }],
    ctx(),
  );
  const fd = created[0];
  assert.equal(fd.x, 10);
  assert.equal(fd.y, 10);
  assert.deepEqual(fd.points, [[0, 0], [10, 5], [20, 30]]);
  assert.equal(fd.width, 20);
  assert.equal(fd.height, 30);
});

test("re-using an existing id is rejected", () => {
  const existing = buildElements([{ type: "rectangle", id: "api" }], ctx()).created;
  assert.throws(
    () => buildElements([{ type: "rectangle", id: "api" }], { existing: new Map(existing.map((e) => [e.id, e])), lastIndex: null }),
    /already in the scene: api/,
  );
});

test("unknown binding target throws", () => {
  assert.throws(() => buildElements([{ type: "arrow", start: "nope", end: "nope2" }], ctx()), /not found/);
});

test("bump increments version and changes nonce", () => {
  const [el] = buildElements([{ type: "text", text: "hi" }], ctx()).created;
  const next = bump(el);
  assert.equal(next.version, el.version + 1);
  assert.notEqual(next.versionNonce, el.versionNonce);
});

test("summary folds labels into their container and samples freehand paths", () => {
  const { created } = buildElements(
    [
      { type: "rectangle", id: "r", x: 0, y: 0, width: 100, height: 50, label: "Box" },
      { type: "freedraw", id: "f", points: Array.from({ length: 50 }, (_, i) => [i * 2, i] as [number, number]) },
    ],
    ctx(),
  );
  const s = summarise(created);
  const lines = s.split("\n");
  assert.equal(lines.length, 2, s);
  assert.match(lines[0], /^r rectangle @\(0,0\) 100x50 "Box"$/);
  assert.match(lines[1], /^f freedraw 50 pts: \(0,0\) -> .* -> \(98,49\)$/);
});
