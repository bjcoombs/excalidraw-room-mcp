import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildElements,
  bump,
  measureText,
  randomId,
  randomInteger,
  summarise,
  type Binding,
  type ExcalidrawElement,
} from "./elements.js";

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

test("repeating an id within one batch is rejected, and empty ids are rejected", () => {
  assert.throws(
    () => buildElements([{ type: "rectangle", id: "x" }, { type: "ellipse", id: "x" }], ctx()),
    /repeated within the batch: x/,
  );
  assert.throws(() => buildElements([{ type: "rectangle", id: "" }], ctx()), /must not be empty/);
});

test("arrow between two shapes with the same centre has finite points", () => {
  const { created } = buildElements(
    [
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 100 },
      { type: "rectangle", id: "b", x: 25, y: 25, width: 50, height: 50 },
      { type: "arrow", id: "ab", start: "a", end: "b" },
    ],
    ctx(),
  );
  const arrow = created.find((e) => e.id === "ab")!;
  assert.ok(Number.isFinite(arrow.x) && Number.isFinite(arrow.y));
  for (const [px, py] of arrow.points!) assert.ok(Number.isFinite(px) && Number.isFinite(py), `${px},${py}`);
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

// ---------------------------------------------------------------------------
// Characterization tests. These pin the exact numbers and strings the current
// implementation produces, so a change in the arithmetic, a default, or a
// message is visible as a test failure rather than a silently different canvas.
// ---------------------------------------------------------------------------

/** Run `fn`, return the message of the error it throws. */
const message = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new assert.AssertionError({ message: "expected a throw, got none" });
};

/** A scene element as a peer would send it, with only the fields under test set. */
const raw = (el: Partial<ExcalidrawElement> & { id: string; type: string }): ExcalidrawElement =>
  ({
    x: 0,
    y: 0,
    width: 0,
    height: 0,
    isDeleted: false,
    boundElements: null,
    version: 1,
    versionNonce: 1,
    ...el,
  }) as ExcalidrawElement;

test("randomId draws the requested number of characters from the id alphabet", () => {
  const id = randomId();
  assert.equal(id.length, 20);
  assert.match(id, /^[A-Za-z0-9_-]{20}$/);
  assert.equal(randomId(5).length, 5);
  assert.notEqual(randomId(), randomId());
});

test("randomInteger stays inside the 31-bit range", () => {
  for (let i = 0; i < 50; i++) {
    const n = randomInteger();
    assert.equal(Number.isInteger(n), true);
    assert.equal(n >= 0 && n < 2 ** 31, true, `${n}`);
  }
});

test("measureText scales the longest line by 0.6em and the line count by 1.25em", () => {
  assert.deepEqual(measureText("API", 20), { width: 36, height: 25 });
  assert.deepEqual(measureText("calls", 16), { width: 48, height: 20 });
  // Two lines: width follows the longer one, height follows the count.
  assert.deepEqual(measureText("ab\ncdef", 10), { width: 24, height: 25 });
  // Empty text still measures one column wide and one line high.
  assert.deepEqual(measureText("", 20), { width: 12, height: 25 });
});

test("base fields default to the Excalidraw defaults", () => {
  const [r] = buildElements([{ type: "rectangle" }], ctx()).created;
  assert.equal(r.x, 0);
  assert.equal(r.y, 0);
  assert.equal(r.width, 160);
  assert.equal(r.height, 80);
  assert.equal(r.angle, 0);
  assert.equal(r.strokeColor, "#1e1e1e");
  assert.equal(r.backgroundColor, "transparent");
  assert.equal(r.fillStyle, "solid");
  assert.equal(r.strokeWidth, 2);
  assert.equal(r.strokeStyle, "solid");
  assert.equal(r.roughness, 1);
  assert.equal(r.opacity, 100);
  assert.deepEqual(r.groupIds, []);
  assert.equal(r.frameId, null);
  assert.equal(r.seed !== undefined, true);
  assert.equal(r.version, 1);
  assert.equal(r.isDeleted, false);
  assert.equal(r.boundElements, null);
  assert.equal(r.link, null);
  assert.equal(r.locked, false);
  assert.match(r.id, /^[A-Za-z0-9_-]{20}$/);
});

test("base fields take spec overrides verbatim", () => {
  const [r] = buildElements(
    [
      {
        type: "ellipse",
        id: "e",
        x: 7,
        y: 9,
        width: 11,
        height: 13,
        strokeColor: "#ff0000",
        backgroundColor: "#ffcccc",
        fillStyle: "hachure",
        strokeWidth: 4,
        strokeStyle: "dashed",
        roughness: 0,
        opacity: 30,
      },
    ],
    ctx(),
  ).created;
  assert.equal(r.x, 7);
  assert.equal(r.y, 9);
  assert.equal(r.width, 11);
  assert.equal(r.height, 13);
  assert.equal(r.strokeColor, "#ff0000");
  assert.equal(r.backgroundColor, "#ffcccc");
  assert.equal(r.fillStyle, "hachure");
  assert.equal(r.strokeWidth, 4);
  assert.equal(r.strokeStyle, "dashed");
  assert.equal(r.roughness, 0);
  assert.equal(r.opacity, 30);
});

test("only rectangles are rounded, and only when not opted out", () => {
  const roundness = (spec: Parameters<typeof buildElements>[0][number]) =>
    buildElements([spec], ctx()).created[0].roundness;
  assert.deepEqual(roundness({ type: "rectangle" }), { type: 3 });
  assert.deepEqual(roundness({ type: "rectangle", rounded: true }), { type: 3 });
  assert.equal(roundness({ type: "rectangle", rounded: false }), null);
  assert.equal(roundness({ type: "ellipse" }), null);
  assert.equal(roundness({ type: "ellipse", rounded: true }), null);
  assert.equal(roundness({ type: "diamond" }), null);
  assert.equal(buildElements([{ type: "diamond", id: "d" }], ctx()).created[0].type, "diamond");
});

test("a shape label is centred on the shape at exact coordinates", () => {
  const { created } = buildElements(
    [{ type: "rectangle", id: "api", x: 10, y: 20, width: 200, height: 100, label: "API" }],
    ctx(),
  );
  const [rect, label] = created;
  assert.equal(created.length, 2);
  assert.equal(rect.x, 10);
  assert.equal(rect.y, 20);
  // measureText("API", 20) is 36x25, so the label sits at (10 + (200-36)/2, 20 + (100-25)/2).
  assert.equal(label.x, 92);
  assert.equal(label.y, 57.5);
  assert.equal(label.width, 36);
  assert.equal(label.height, 25);
  assert.equal(label.fontSize, 20);
  assert.equal(label.textAlign, "center");
  assert.equal(label.verticalAlign, "middle");
  assert.equal(label.containerId, "api");
  assert.equal(label.originalText, "API");
  assert.equal(label.lineHeight, 1.25);
  assert.equal(label.fontFamily, 5);
  assert.equal(label.autoResize, true);
  assert.equal(label.roundness, null);
  assert.deepEqual(rect.boundElements, [{ id: label.id, type: "text" }]);
});

test("a shape label honours the spec font size", () => {
  const [, label] = buildElements(
    [{ type: "rectangle", id: "r", x: 0, y: 0, width: 100, height: 40, label: "hi", fontSize: 10 }],
    ctx(),
  ).created;
  // measureText("hi", 10) is 12x13.
  assert.equal(label.width, 12);
  assert.equal(label.height, 13);
  assert.equal(label.x, 44);
  assert.equal(label.y, 13.5);
  assert.equal(label.fontSize, 10);
});

test("a standalone text element is left-aligned, top-aligned and unbound", () => {
  const [t] = buildElements([{ type: "text", id: "t", x: 5, y: 6, text: "hi" }], ctx()).created;
  assert.equal(t.type, "text");
  assert.equal(t.x, 5);
  assert.equal(t.y, 6);
  assert.equal(t.text, "hi");
  assert.equal(t.originalText, "hi");
  assert.equal(t.width, 24);
  assert.equal(t.height, 25);
  assert.equal(t.fontSize, 20);
  assert.equal(t.textAlign, "left");
  assert.equal(t.verticalAlign, "top");
  assert.equal(t.containerId, null);
  assert.equal(t.autoResize, true);
});

test("a text element falls back to the label, then to the empty string", () => {
  const [withLabel] = buildElements([{ type: "text", label: "from label" }], ctx()).created;
  assert.equal(withLabel.text, "from label");
  const [empty] = buildElements([{ type: "text" }], ctx()).created;
  assert.equal(empty.text, "");
  assert.equal(empty.width, 12);
  assert.equal(empty.height, 25);
});

test("an arrow with only points keeps them relative to the first point", () => {
  const [a] = buildElements([{ type: "arrow", id: "p", points: [[50, 50], [0, 0], [100, 80]] }], ctx()).created;
  assert.equal(a.x, 50);
  assert.equal(a.y, 50);
  assert.deepEqual(a.points, [[0, 0], [-50, -50], [50, 30]]);
  // Extent spans the min and max of the relative points, not just the last one.
  assert.equal(a.width, 100);
  assert.equal(a.height, 80);
  assert.deepEqual(a.roundness, { type: 2 });
  assert.equal(a.lastCommittedPoint, null);
  assert.equal(a.startBinding, null);
  assert.equal(a.endBinding, null);
  assert.equal(a.startArrowhead, null);
  assert.equal(a.endArrowhead, "arrow");
  assert.equal(a.elbowed, false);
  assert.equal(a.boundElements, null);
});

test("arrowheads follow the spec, defaulting to a head at the arrow's end only", () => {
  const [arrow] = buildElements([{ type: "arrow", points: [[0, 0], [10, 0]] }], ctx()).created;
  assert.equal(arrow.startArrowhead, null);
  assert.equal(arrow.endArrowhead, "arrow");
  const [line] = buildElements([{ type: "line", points: [[0, 0], [10, 0]] }], ctx()).created;
  assert.equal(line.type, "line");
  assert.equal(line.startArrowhead, null);
  assert.equal(line.endArrowhead, null);
  assert.equal("elbowed" in line, false);
  const [custom] = buildElements(
    [{ type: "arrow", points: [[0, 0], [10, 0]], startArrowhead: "dot", endArrowhead: "triangle" }],
    ctx(),
  ).created;
  assert.equal(custom.startArrowhead, "dot");
  assert.equal(custom.endArrowhead, "triangle");
  const [headless] = buildElements([{ type: "line", points: [[0, 0], [10, 0]], endArrowhead: "bar" }], ctx()).created;
  assert.equal(headless.endArrowhead, "bar");
});

test("an arrow between two shapes stops a 4px gap outside each edge", () => {
  const { created } = buildElements(
    [
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 50 },
      { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 50 },
      { type: "arrow", id: "ab", start: "a", end: "b" },
    ],
    ctx(),
  );
  const arrow = created.find((e) => e.id === "ab")!;
  // Centres are (50,25) and (350,25); the edges are at x=100 and x=300, plus the gap.
  assert.equal(arrow.x, 104);
  assert.equal(arrow.y, 25);
  assert.deepEqual(arrow.points, [[0, 0], [192, 0]]);
  assert.equal(arrow.width, 192);
  assert.equal(arrow.height, 0);
  // The fixedPoint is the point on the bound element's outline the arrow leaves
  // from, as a ratio of that element's box: a's right edge halfway down, b's
  // left edge halfway down. 0.5 exactly is nudged to 0.5001 as upstream does.
  assert.deepEqual(arrow.startBinding, { elementId: "a", fixedPoint: [1, 0.5001], mode: "orbit" });
  assert.deepEqual(arrow.endBinding, { elementId: "b", fixedPoint: [0, 0.5001], mode: "orbit" });
});

test("a bound arrow carries the upstream binding keys elementId, fixedPoint and mode", () => {
  const { created } = buildElements(
    [
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 50 },
      { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 50 },
      { type: "arrow", id: "ar", start: "a", end: "b" },
    ],
    ctx(),
  );
  const arrow = created.find((e) => e.id === "ar")!;
  for (const end of ["startBinding", "endBinding"] as const) {
    const binding = arrow[end] as Binding | null;
    assert.ok(binding, `arrow has no ${end}`);
    // The exact key set upstream's FixedPointBinding carries: nothing wider,
    // and no leftover focus or gap.
    assert.deepEqual(Object.keys(binding!).sort(), ["elementId", "fixedPoint", "mode"]);
    assert.equal(binding!.mode, "orbit");
    assert.equal(binding!.fixedPoint.length, 2);
    for (const ratio of binding!.fixedPoint) {
      assert.equal(typeof ratio, "number");
      assert.ok(Number.isFinite(ratio), `fixedPoint ratio ${ratio} is not finite`);
    }
  }
  const start = arrow.startBinding as Binding;
  const finish = arrow.endBinding as Binding;
  assert.equal(start.elementId, "a");
  assert.equal(finish.elementId, "b");
  // a is left of b at the same height, so the ratios follow the geometry: the
  // arrow leaves a's right edge and arrives at b's left edge, both halfway down.
  assert.ok(start.fixedPoint[0] >= 0.9, `start x ratio ${start.fixedPoint[0]}`);
  assert.ok(finish.fixedPoint[0] <= 0.1, `end x ratio ${finish.fixedPoint[0]}`);
  for (const ratio of [start.fixedPoint[1], finish.fixedPoint[1]]) {
    assert.ok(Math.abs(ratio - 0.5) <= 0.1, `y ratio ${ratio} is not near the middle`);
  }
  for (const ratio of [...start.fixedPoint, ...finish.fixedPoint]) {
    assert.ok(ratio >= -0.1 && ratio <= 1.1, `ratio ${ratio} is outside the element box`);
  }
});

test("a vertical arrow leaves through the horizontal edges", () => {
  const { created } = buildElements(
    [
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 50 },
      { type: "rectangle", id: "b", x: 0, y: 300, width: 100, height: 50 },
      { type: "arrow", id: "ab", start: "a", end: "b" },
    ],
    ctx(),
  );
  const arrow = created.find((e) => e.id === "ab")!;
  // Centres are (50,25) and (50,325): straight down, out of a at y=50+4 and into b at y=300-4.
  assert.equal(arrow.x, 50);
  assert.equal(arrow.y, 54);
  assert.deepEqual(arrow.points, [[0, 0], [0, 242]]);
  assert.equal(arrow.width, 0);
  assert.equal(arrow.height, 242);
});

test("a diagonal arrow exits on the axis it reaches first", () => {
  const { created } = buildElements(
    [
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 100 },
      { type: "rectangle", id: "b", x: 200, y: 400, width: 100, height: 100 },
      { type: "arrow", id: "ab", start: "a", end: "b" },
    ],
    ctx(),
  );
  const arrow = created.find((e) => e.id === "ab")!;
  assert.equal(arrow.x, 76.78885438199983);
  assert.equal(arrow.y, 103.57770876399967);
  assert.deepEqual(arrow.points, [[0, 0], [146.42229123600032, 292.84458247200064]]);
});

test("a zero-width shape still yields a finite edge point", () => {
  const { created } = buildElements(
    [
      { type: "rectangle", id: "a", x: 0, y: 0, width: 0, height: 100 },
      { type: "rectangle", id: "b", x: -50, y: 300, width: 100, height: 100 },
      { type: "arrow", id: "ab", start: "a", end: "b" },
    ],
    ctx(),
  );
  const arrow = created.find((e) => e.id === "ab")!;
  assert.equal(arrow.x, 0);
  assert.equal(arrow.y, 104);
  assert.deepEqual(arrow.points, [[0, 0], [0, 192]]);
});

test("bound arrow waypoints are kept and aimed at from both ends", () => {
  const { created } = buildElements(
    [
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 100 },
      { type: "rectangle", id: "b", x: 400, y: 0, width: 100, height: 100 },
      // The first and last supplied points are replaced by the computed edge points.
      { type: "arrow", id: "ab", start: "a", end: "b", points: [[0, 0], [200, -100], [300, -40], [999, 999]] },
    ],
    ctx(),
  );
  const arrow = created.find((e) => e.id === "ab")!;
  assert.equal(arrow.x, 102.82842712474618);
  assert.equal(arrow.y, -2.82842712474619);
  assert.deepEqual(arrow.points, [
    [0, 0],
    [97.17157287525382, -97.17157287525382],
    [197.17157287525382, -37.17157287525381],
    [293.74160117240365, 20.770444103036084],
  ]);
  assert.equal(arrow.width, 293.74160117240365);
  assert.equal(arrow.height, 117.9420169782899);
});

test("an arrow bound at the start only replaces its first point", () => {
  const { created } = buildElements(
    [
      { type: "rectangle", id: "a", x: 0, y: 0, width: 100, height: 50 },
      { type: "arrow", id: "ar", start: "a", points: [[999, 999], [300, 25]] },
    ],
    ctx(),
  );
  const arrow = created.find((e) => e.id === "ar")!;
  assert.equal(arrow.x, 104);
  assert.equal(arrow.y, 25);
  assert.deepEqual(arrow.points, [[0, 0], [196, 0]]);
  assert.deepEqual(arrow.startBinding, { elementId: "a", fixedPoint: [1, 0.5001], mode: "orbit" });
  assert.equal(arrow.endBinding, null);
});

test("an arrow bound at the end only replaces its last point", () => {
  const { created } = buildElements(
    [
      { type: "rectangle", id: "b", x: 300, y: 0, width: 100, height: 50 },
      { type: "arrow", id: "ar", end: "b", points: [[0, 25], [100, 60], [999, 999]] },
    ],
    ctx(),
  );
  const arrow = created.find((e) => e.id === "ar")!;
  assert.equal(arrow.x, 0);
  assert.equal(arrow.y, 25);
  assert.deepEqual(arrow.points, [[0, 0], [100, 35], [296, 0]]);
  assert.equal(arrow.startBinding, null);
  assert.deepEqual(arrow.endBinding, { elementId: "b", fixedPoint: [0, 0.5001], mode: "orbit" });
});

test("an arrow label sits on the midpoint of the middle segment", () => {
  const { created } = buildElements([{ type: "arrow", id: "q", points: [[10, 20], [110, 80]], label: "calls" }], ctx());
  assert.equal(created.length, 2);
  const [arrow, label] = created;
  // Segment midpoint is (60,50); measureText("calls", 16) is 48x20.
  assert.equal(label.x, 36);
  assert.equal(label.y, 40);
  assert.equal(label.width, 48);
  assert.equal(label.height, 20);
  assert.equal(label.fontSize, 16);
  assert.equal(label.text, "calls");
  assert.equal(label.textAlign, "center");
  assert.equal(label.verticalAlign, "middle");
  assert.equal(label.containerId, "q");
  assert.deepEqual(arrow.boundElements, [{ id: label.id, type: "text" }]);
});

test("an arrow label on a polyline uses the segment either side of the midpoint", () => {
  const { created } = buildElements(
    [{ type: "arrow", id: "q", points: [[0, 0], [40, 60], [100, 100]], label: "hi", fontSize: 10 }],
    ctx(),
  );
  const label = created[1];
  // Midpoint index is 1, so the segment is (0,0)-(40,60), centre (20,30); "hi" at 10px is 12x13.
  assert.equal(label.x, 14);
  assert.equal(label.y, 23.5);
  assert.equal(label.width, 12);
  assert.equal(label.height, 13);
});

test("a line can carry a label too", () => {
  const { created } = buildElements([{ type: "line", id: "l", points: [[0, 0], [100, 0]], label: "lbl" }], ctx());
  assert.equal(created.length, 2);
  const [line, label] = created;
  assert.equal(line.type, "line");
  assert.equal(label.x, 35.5);
  assert.equal(label.y, -10);
  assert.equal(label.width, 29);
  assert.equal(label.height, 20);
  assert.deepEqual(line.boundElements, [{ id: label.id, type: "text" }]);
});

test("freedraw records pressures, the last point and the full extent", () => {
  const [fd] = buildElements([{ type: "freedraw", id: "f", points: [[50, 50], [0, 0], [100, 80]] }], ctx()).created;
  assert.equal(fd.x, 50);
  assert.equal(fd.y, 50);
  assert.deepEqual(fd.points, [[0, 0], [-50, -50], [50, 30]]);
  assert.equal(fd.width, 100);
  assert.equal(fd.height, 80);
  assert.deepEqual(fd.pressures, []);
  assert.equal(fd.simulatePressure, true);
  assert.deepEqual(fd.lastCommittedPoint, [50, 30]);
});

test("specs without ids are all built, and get generated ids", () => {
  const { created } = buildElements([{ type: "rectangle" }, { type: "ellipse" }], ctx());
  assert.equal(created.length, 2);
  assert.notEqual(created[0].id, created[1].id);
});

test("build errors name every offending id and read exactly as written", () => {
  const existing = buildElements([{ type: "rectangle", id: "a" }, { type: "rectangle", id: "b" }], ctx()).created;
  const withExisting = { existing: new Map(existing.map((e) => [e.id, e])), lastIndex: null };
  assert.equal(
    message(() => buildElements([{ type: "rectangle", id: "a" }, { type: "ellipse", id: "b" }], withExisting)),
    "element id(s) already in the scene: a, b. Use update_elements to change them.",
  );
  assert.equal(
    message(() =>
      buildElements(
        [
          { type: "rectangle", id: "x" },
          { type: "rectangle", id: "x" },
          { type: "ellipse", id: "y" },
          { type: "ellipse", id: "y" },
        ],
        ctx(),
      ),
    ),
    "element id(s) repeated within the batch: x, y",
  );
  assert.equal(message(() => buildElements([{ type: "rectangle", id: "" }], ctx())), "element id must not be empty");
});

test("binding and geometry errors name the element and the type", () => {
  assert.equal(
    message(() => buildElements([{ type: "arrow", start: "nope", points: [[0, 0], [1, 1]] }], ctx())),
    "start element not found: nope",
  );
  assert.equal(
    message(() => buildElements([{ type: "arrow", end: "gone", points: [[0, 0], [1, 1]] }], ctx())),
    "end element not found: gone",
  );
  assert.equal(
    message(() => buildElements([{ type: "arrow", points: [[0, 0]] }], ctx())),
    "arrow needs at least two points, or start and end element ids",
  );
  assert.equal(
    message(() => buildElements([{ type: "line" }], ctx())),
    "line needs at least two points, or start and end element ids",
  );
  assert.equal(
    message(() => buildElements([{ type: "freedraw", points: [[0, 0]] }], ctx())),
    "freedraw needs at least two points",
  );
  assert.equal(
    message(() => buildElements([{ type: "blob" } as unknown as { type: "rectangle" }], ctx())),
    "unsupported element type: blob",
  );
});

test("summary of a shape, an arrow and a line reads as one line each", () => {
  const s = summarise([
    raw({ id: "a", type: "rectangle", x: 0.4, y: 0.6, width: 100.2, height: 50.5 }),
    raw({
      id: "ab",
      type: "arrow",
      x: 10,
      y: 20,
      points: [[0, 0], [30, 40]],
      startBinding: { elementId: "a", fixedPoint: [1, 0.5001], mode: "orbit" },
      endBinding: { elementId: "b", fixedPoint: [0, 0.5001], mode: "orbit" },
    }),
    raw({ id: "l", type: "line", x: 1, y: 2, points: [[0, 0], [5, 5], [10, 0]] }),
  ]);
  assert.equal(
    s,
    ["a rectangle @(0,1) 100x51", "ab arrow 2 pts: (10,20) -> (40,60) from a to b", "l line 3 pts: (1,2) -> (6,7) -> (11,2)"].join(
      "\n",
    ),
  );
});

test("summary omits bindings that are not set and points that are missing", () => {
  const s = summarise([raw({ id: "ab", type: "arrow", x: 10, y: 20 })]);
  assert.equal(s, "ab arrow 0 pts: ");
});

test("summary folds a bound label into its container and drops the label's own line", () => {
  const s = summarise([
    raw({ id: "r", type: "rectangle", width: 100, height: 50 }),
    raw({ id: "t", type: "text", containerId: "r", text: "Box" }),
  ]);
  assert.equal(s, 'r rectangle @(0,0) 100x50 "Box"');
});

test("summary shows an empty label for a bound text with no text", () => {
  const s = summarise([
    raw({ id: "r", type: "rectangle", width: 100, height: 50 }),
    raw({ id: "t", type: "text", containerId: "r" }),
  ]);
  assert.equal(s, 'r rectangle @(0,0) 100x50 ""');
});

test("summary ignores a deleted label and its container keeps no label", () => {
  const s = summarise([
    raw({ id: "r", type: "rectangle", width: 100, height: 50 }),
    raw({ id: "t", type: "text", containerId: "r", text: "Box", isDeleted: true }),
  ]);
  assert.equal(s, "r rectangle @(0,0) 100x50");
});

test("summary drops deleted elements entirely", () => {
  const s = summarise([
    raw({ id: "gone", type: "rectangle", width: 10, height: 10, isDeleted: true }),
    raw({ id: "here", type: "ellipse", width: 20, height: 20 }),
  ]);
  assert.equal(s, "here ellipse @(0,0) 20x20");
});

test("summary keeps a bound text whose container is not in the scene", () => {
  const s = summarise([raw({ id: "t", type: "text", containerId: "missing", text: "orphan", width: 40, height: 25 })]);
  assert.equal(s, 't text @(0,0) 40x25 "orphan"');
});

test("summary only treats text elements as labels", () => {
  const s = summarise([
    raw({ id: "r", type: "rectangle", width: 100, height: 50 }),
    // A non-text element carrying a containerId is a normal element, not a label.
    raw({ id: "odd", type: "ellipse", width: 10, height: 10, containerId: "r", text: "ghost" }),
  ]);
  assert.equal(s, ["r rectangle @(0,0) 100x50", "odd ellipse @(0,0) 10x10"].join("\n"));
});

test("summary quotes a standalone text element, empty text included", () => {
  const s = summarise([
    raw({ id: "t1", type: "text", width: 24, height: 25, text: "hi" }),
    raw({ id: "t2", type: "text", width: 12, height: 25 }),
  ]);
  assert.equal(s, ['t1 text @(0,0) 24x25 "hi"', 't2 text @(0,0) 12x25 ""'].join("\n"));
});

test("summary reports colours only when they differ from the defaults", () => {
  const s = summarise([
    raw({ id: "d", type: "rectangle", width: 10, height: 10, strokeColor: "#1e1e1e", backgroundColor: "transparent" }),
    raw({ id: "c", type: "rectangle", width: 10, height: 10, strokeColor: "#ff0000", backgroundColor: "#ffcccc" }),
  ]);
  assert.equal(s, ["d rectangle @(0,0) 10x10", "c rectangle @(0,0) 10x10 stroke=#ff0000 fill=#ffcccc"].join("\n"));
});

test("summary samples a long path down to eight points and keeps the count", () => {
  const points = Array.from({ length: 20 }, (_, i) => [i, i * 2] as [number, number]);
  const s = summarise([raw({ id: "f", type: "freedraw", x: 0, y: 0, points })]);
  assert.equal(s, "f freedraw 20 pts: (0,0) -> (3,6) -> (5,10) -> (8,16) -> (11,22) -> (14,28) -> (16,32) -> (19,38)");
});

test("summary of a path at or below eight points is not resampled", () => {
  const s = summarise([raw({ id: "p", type: "arrow", x: 0, y: 0, points: [[0, 0], [10, 10], [20, 0]] })]);
  assert.equal(s, "p arrow 3 pts: (0,0) -> (10,10) -> (20,0)");
});

test("text spec carries link through", () => {
  const { created } = buildElements(
    [{ type: "text", id: "lk1", x: 0, y: 0, text: "repo", link: "https://example.com/repo" }],
    ctx(),
  );
  assert.equal(created[0].link, "https://example.com/repo");
});

test("shape spec carries link through and its bound label does not", () => {
  const { created } = buildElements(
    [{ type: "rectangle", id: "box", x: 0, y: 0, width: 100, height: 50, label: "API", link: "https://example.com/api" }],
    ctx(),
  );
  const [shape, label] = created;
  assert.equal(shape.link, "https://example.com/api");
  assert.equal(label.link, null);
});

test("arrow and freedraw specs carry link through", () => {
  const { created } = buildElements(
    [
      { type: "arrow", id: "ar", points: [[0, 0], [50, 0]], link: "https://example.com/arrow" },
      { type: "freedraw", id: "fd", points: [[0, 0], [5, 5]], link: "https://example.com/draw" },
    ],
    ctx(),
  );
  assert.equal(created[0].link, "https://example.com/arrow");
  assert.equal(created[1].link, "https://example.com/draw");
});

test("link defaults to null when the spec omits it", () => {
  const { created } = buildElements(
    [
      { type: "text", id: "t2", x: 0, y: 0, text: "plain" },
      { type: "ellipse", id: "e2", x: 0, y: 0 },
    ],
    ctx(),
  );
  assert.equal(created[0].link, null);
  assert.equal(created[1].link, null);
});
