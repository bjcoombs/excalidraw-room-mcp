/**
 * Placement: the slot search, cluster growth, cluster separation and the room
 * radius that governs all three.
 *
 * Coordinates are asserted exactly, not by containment. The whole point of
 * server-side placement is that the number the tool reports is the number it
 * wrote, and a test that only asked "somewhere free" would pass for a layout
 * nobody could read.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { boxDistance, DEFAULT_NEARBY_RADIUS, type Box } from "./mentions.js";
import {
  AUTO_SIDES,
  BOTH_ANCHORS_TEXT,
  CLUSTER_CUSTOM_DATA_KEY,
  DEFAULT_GAP,
  NEW_CLUSTER_NEEDS_NEAR_TEXT,
  NO_ANCHOR_TEXT,
  OUTGROWN_TEXT,
  SIDE_WITH_CLUSTER_TEXT,
  SIDES,
  anchorMissingText,
  centreOf,
  clusterKey,
  clusterOf,
  contains,
  cornerDistance,
  elementBox,
  findAutoSlot,
  findClusterSlot,
  findNewClusterSlot,
  findSideSlot,
  footprintText,
  gridCandidates,
  integralBox,
  integralSize,
  intersects,
  isFiniteBox,
  isClear,
  isFree,
  nearRadius,
  padded,
  obstacleBoxes,
  place,
  placedText,
  placementLines,
  reservedElement,
  slotOn,
  specSize,
  union,
  unplaceableText,
  type PlacedSpec,
  type PlacementResult,
  type Side,
} from "./placement.js";
import { selectElements } from "./scene.js";
import type { ExcalidrawElement } from "./elements.js";

/** A rectangle in the scene, with only the fields a search reads. */
function rect(id: string, x: number, y: number, width: number, height: number, over: Partial<ExcalidrawElement> = {}): ExcalidrawElement {
  return {
    id,
    type: "rectangle",
    x,
    y,
    width,
    height,
    isDeleted: false,
    version: 1,
    versionNonce: 1,
    boundElements: null,
    ...over,
  };
}

function box(x: number, y: number, width: number, height: number): Box {
  return { x, y, width, height };
}

const SIZE = { width: 80, height: 40 };

/** Where a spec placed against this scene lands, refusals included. */
function placeIn(elements: readonly ExcalidrawElement[], spec: PlacedSpec, radius = DEFAULT_NEARBY_RADIUS): PlacementResult {
  const request = spec.place;
  assert.ok(request, "the spec under test has to ask to be placed");
  return place(request, spec, { elements, radius });
}

/** The scene with one more element where a placement put it. */
function withPlaced(elements: readonly ExcalidrawElement[], id: string, result: PlacementResult, size = SIZE): ExcalidrawElement[] {
  return [...elements, reservedElement(id, "rectangle", result.x, result.y, size)];
}

/** Every pair of live boxes, for the "nothing overlaps" assertion. */
function assertNoOverlap(elements: readonly ExcalidrawElement[]): void {
  const boxes = obstacleBoxes(elements);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      assert.ok(!intersects(boxes[i], boxes[j]), `${elements[i].id} overlaps ${elements[j].id}`);
    }
  }
}

// ---------------------------------------------------------------- geometry

test("boxes touching along an edge do not intersect, and an overlap of a pixel does", () => {
  assert.equal(intersects(box(0, 0, 100, 100), box(100, 0, 50, 50)), false, "touching right edge");
  assert.equal(intersects(box(0, 0, 100, 100), box(0, 100, 50, 50)), false, "touching bottom edge");
  assert.equal(intersects(box(0, 0, 100, 100), box(99, 99, 50, 50)), true, "one pixel of overlap");
  assert.equal(intersects(box(0, 0, 100, 100), box(-50, 50, 50, 10)), false, "touching left edge");
  assert.equal(intersects(box(0, 0, 100, 100), box(50, 50, 10, 10)), true, "wholly inside");
  // A shape dragged up and to the left is stored with negative extent; read
  // as given it would sit entirely on the wrong side of itself.
  assert.equal(intersects(box(0, 0, 100, 100), box(150, 150, -100, -100)), true, "negative extent normalised");
});

test("a box is grown outwards to whole pixels, never rounded inwards", () => {
  assert.deepEqual(integralBox(box(10.4, -3.2, 20.3, 5.5)), { x: 10, y: -4, width: 21, height: 7 });
  assert.deepEqual(integralBox(box(10, 20, 30, 40)), { x: 10, y: 20, width: 30, height: 40 });
  assert.deepEqual(integralSize({ width: 12.1, height: 0.2 }), { width: 13, height: 1 });
  assert.deepEqual(elementBox(rect("a", 1.5, 2.5, 10.5, 10.5)), { x: 1, y: 2, width: 11, height: 11 });
});

test("obstacles are the live elements with finite boxes, and nothing else", () => {
  const scene = [
    rect("live", 0, 0, 10, 10),
    rect("gone", 20, 0, 10, 10, { isDeleted: true }),
    rect("broken", Number.NaN, 0, 10, 10),
  ];
  assert.deepEqual(obstacleBoxes(scene), [{ x: 0, y: 0, width: 10, height: 10 }]);
  assert.equal(isFiniteBox(box(0, 0, 1, 1)), true);
  assert.equal(isFiniteBox(box(Number.NaN, 0, 1, 1)), false);
  assert.equal(isFiniteBox(box(0, Number.POSITIVE_INFINITY, 1, 1)), false);
  assert.equal(isFiniteBox(box(0, 0, Number.NaN, 1)), false);
  assert.equal(isFiniteBox(box(0, 0, 1, Number.NaN)), false);
  assert.equal(isFree(box(0, 0, 5, 5), [box(0, 0, 10, 10)]), false);
  assert.equal(isFree(box(20, 20, 5, 5), [box(0, 0, 10, 10)]), true);
  // Clearance is the box plus the gap on all four sides, so a neighbour
  // closer than the gap blocks the slot even though nothing overlaps.
  assert.deepEqual(padded(box(0, 0, 10, 10), 5), { x: -5, y: -5, width: 20, height: 20 });
  assert.equal(isClear(box(0, 0, 10, 10), [box(15, 0, 5, 5)], 10), false, "a neighbour 5 px to the right of a 10 px gap");
  assert.equal(isClear(box(0, 0, 10, 10), [box(-10, 0, 5, 5)], 10), false, "and one 5 px to the left");
  assert.equal(isClear(box(0, 0, 10, 10), [box(0, 15, 5, 5)], 10), false, "and one below");
  assert.equal(isClear(box(0, 0, 10, 10), [box(0, -10, 5, 5)], 10), false, "and one above");
  assert.equal(isClear(box(0, 0, 10, 10), [box(20, 0, 5, 5)], 10), true, "exactly the gap away is clear");
  assert.equal(isClear(box(0, 0, 10, 10), [box(15, 0, 5, 5)], 0), true, "with no gap asked for, only overlap blocks");
});

test("a union is the smallest box holding every member, and containment is strict about edges", () => {
  assert.deepEqual(union([box(0, 0, 10, 10)]), { x: 0, y: 0, width: 10, height: 10 });
  assert.deepEqual(union([box(0, 0, 10, 10), box(-5, 20, 5, 5)]), { x: -5, y: 0, width: 15, height: 25 });
  assert.deepEqual(union([box(0, 0, 10, 10), box(2, 2, 2, 2)]), { x: 0, y: 0, width: 10, height: 10 });
  assert.deepEqual(union([box(10, 10, 10, 10), box(30, 40, 10, 10)]), { x: 10, y: 10, width: 30, height: 40 });
  assert.deepEqual(centreOf(box(0, 0, 10, 20)), [5, 10]);
  assert.deepEqual(centreOf(box(-10, -10, 4, 4)), [-8, -8]);
  assert.equal(contains(box(0, 0, 10, 10), box(0, 0, 10, 10)), true, "the same box is contained");
  assert.equal(contains(box(0, 0, 10, 10), box(1, 1, 9, 9)), true);
  assert.equal(contains(box(0, 0, 10, 10), box(1, 1, 10, 9)), false, "over the right edge");
  assert.equal(contains(box(0, 0, 10, 10), box(1, 1, 9, 10)), false, "over the bottom edge");
  assert.equal(contains(box(0, 0, 10, 10), box(-1, 0, 5, 5)), false, "over the left edge");
  assert.equal(contains(box(0, 0, 10, 10), box(0, -1, 5, 5)), false, "over the top edge");
});

test("the distance that decides a radius is to the furthest corner, so half in is out", () => {
  // A 6x8 box with the point at its centre: the corners are 5 away.
  assert.equal(cornerDistance([3, 4], box(0, 0, 6, 8)), 5);
  assert.equal(cornerDistance([0, 0], box(0, 0, 3, 4)), 5);
  assert.equal(cornerDistance([0, 0], box(-3, -4, 3, 4)), 5);
  // Nearest-edge distance would call this 0; the far corner is what a mention
  // reading the cluster would have to reach.
  assert.equal(cornerDistance([0, 0], box(-3, -4, 6, 8)), 5);
});

test("the size a slot reserves is the size the element will be built at", () => {
  assert.deepEqual(specSize({ type: "rectangle" }), { width: 160, height: 80 });
  assert.deepEqual(specSize({ type: "rectangle", width: 60, height: 40 }), { width: 60, height: 40 });
  // Text is measured, and the measurement is the box the canvas will show.
  assert.deepEqual(specSize({ type: "text", text: "abc" }), { width: 36, height: 25 });
  assert.deepEqual(specSize({ type: "text", text: "abc", fontSize: 40 }), { width: 72, height: 50 });
  assert.deepEqual(specSize({ type: "text", label: "abc" }), { width: 36, height: 25 });
  assert.deepEqual(specSize({ type: "text" }), { width: 12, height: 25 });
  assert.deepEqual(specSize({ type: "text", text: "abc", width: 5, height: 6 }), { width: 5, height: 6 });
  // A labelled shape is grown to fit its label, so the slot has to be too.
  assert.deepEqual(specSize({ type: "rectangle", width: 20, height: 10, label: "a long label here" }), { width: 214, height: 35 });
  assert.deepEqual(specSize({ type: "rectangle", label: "ab" }), { width: 160, height: 80 });
});

// ------------------------------------------------------------------ sides

test("placement finds a free slot on each side without intersecting live elements", () => {
  const anchor = rect("k", 0, 0, 100, 100);
  const expected: Record<string, Box> = {
    right: box(120, 0, 80, 40),
    left: box(-100, 0, 80, 40),
    below: box(0, 120, 80, 40),
    above: box(0, -60, 80, 40),
  };
  for (const [side, slot] of Object.entries(expected)) {
    // The slot is exactly one gap clear of the anchor on that side.
    assert.deepEqual(slotOn(side as "right", elementBox(anchor), SIZE, DEFAULT_GAP), slot, side);
    const result = placeIn([anchor], { type: "rectangle", width: 80, height: 40, place: { near: "k", side: side as Side } });
    assert.deepEqual([result.x, result.y], [slot.x, slot.y], side);
    assert.equal(boxDistance(slot, elementBox(anchor)), DEFAULT_GAP, `${side} is a gap clear of the anchor`);
    assertNoOverlap(withPlaced([anchor], side, result));
  }

  // A second element asking for the same side steps outward until it is free,
  // which is what makes two agents placing in sequence non-overlapping.
  const scene = [anchor, rect("taken", 120, 0, 80, 40)];
  const second = placeIn(scene, { type: "rectangle", width: 80, height: 40, place: { near: "k", side: "right" } });
  assert.deepEqual([second.x, second.y], [220, 0], "stepped past the element already there, a gap clear of it");
  assert.equal(boxDistance(box(220, 0, 80, 40), box(120, 0, 80, 40)), DEFAULT_GAP, "and left the gap between them");
  assertNoOverlap(withPlaced(scene, "second", second));

  // The step is the gap, and the gap is the caller's when it names one.
  const wide = placeIn([anchor], { type: "rectangle", width: 80, height: 40, place: { near: "k", side: "right", gap: 50 } });
  assert.deepEqual([wide.x, wide.y], [150, 0]);
  const stepped = findSideSlot("right", elementBox(anchor), SIZE, 50, [elementBox(anchor), box(150, 0, 80, 40)]);
  assert.deepEqual(stepped, box(300, 0, 80, 40), "a 50 px gap steps by 50 and leaves 50 either side");

  // The caller's own x and y are not read: place is the alternative to them.
  const ignored = placeIn([anchor], { type: "rectangle", x: 999, y: 999, width: 80, height: 40, place: { near: "k", side: "below" } });
  assert.deepEqual([ignored.x, ignored.y], [0, 120]);
});

test("auto picks the nearest free side", () => {
  const anchor = rect("k", 0, 0, 100, 100);
  const anchorBox = elementBox(anchor);

  // Right is free at a gap of 20; below is blocked out to 220, so right wins
  // on distance rather than on the order the sides are tried in.
  const blockedBelow = [anchor, rect("b", 0, 120, 200, 200)];
  const right = findAutoSlot(anchorBox, SIZE, DEFAULT_GAP, obstacleBoxes(blockedBelow));
  assert.equal(right.side, "right");
  assert.deepEqual(right.slot, box(120, 0, 80, 40));

  // With below blocked and right blocked further out than above, above wins.
  const blockedBoth = [anchor, rect("b", 0, 120, 200, 200), rect("r", 120, -200, 400, 400)];
  const above = findAutoSlot(anchorBox, SIZE, DEFAULT_GAP, obstacleBoxes(blockedBoth));
  assert.equal(above.side, "above");
  assert.deepEqual(above.slot, box(0, -60, 80, 40));

  // Nothing in the way: every side is one gap out, and the tie goes to the
  // first of AUTO_SIDES, which is below - a diagram grows downwards.
  const free = findAutoSlot(anchorBox, SIZE, DEFAULT_GAP, obstacleBoxes([anchor]));
  assert.equal(free.side, AUTO_SIDES[0]);
  assert.equal(free.side, "below");
  assert.deepEqual(free.slot, box(0, 120, 80, 40));

  // auto is the default: no side named is the same request.
  const byDefault = placeIn([anchor], { type: "rectangle", width: 80, height: 40, place: { near: "k" } });
  const named = placeIn([anchor], { type: "rectangle", width: 80, height: 40, place: { near: "k", side: "auto" } });
  assert.deepEqual([byDefault.x, byDefault.y], [0, 120]);
  assert.deepEqual([named.x, named.y], [0, 120]);
  assert.deepEqual(SIDES, ["above", "below", "left", "right", "auto"]);
  assert.deepEqual(AUTO_SIDES, ["below", "right", "above", "left"]);

  // Four sequential auto placements take four different sides and overlap
  // nothing, which is the case the tie-break order exists for.
  let scene: ExcalidrawElement[] = [anchor];
  const taken: string[] = [];
  for (let i = 0; i < 4; i++) {
    const slot = findAutoSlot(anchorBox, SIZE, DEFAULT_GAP, obstacleBoxes(scene));
    taken.push(slot.side);
    scene = [...scene, reservedElement(`a${i}`, "rectangle", slot.slot.x, slot.slot.y, SIZE)];
  }
  assert.deepEqual(taken, ["below", "right", "above", "left"]);
  assertNoOverlap(scene);
});

// --------------------------------------------------------------- clusters

test("a cluster is the anchor's group, its frame, its tagged members, or the anchor alone", () => {
  const alone = rect("solo", 0, 0, 10, 10);
  assert.equal(CLUSTER_CUSTOM_DATA_KEY, "excalidrawRoomCluster", "the stamp survives an excalidraw.com round trip under this key");
  assert.equal(clusterKey(alone), "solo");
  assert.deepEqual(clusterOf([alone], alone).members.map((e) => e.id), ["solo"]);

  const grouped = [rect("g1", 0, 0, 10, 10, { groupIds: ["grp"] }), rect("g2", 40, 0, 10, 10, { groupIds: ["grp"] }), rect("other", 80, 0, 10, 10)];
  assert.equal(clusterKey(grouped[0]), "grp");
  assert.deepEqual(clusterOf(grouped, grouped[0]).members.map((e) => e.id), ["g1", "g2"]);

  const framed = [
    rect("frame", 0, 0, 200, 200, { type: "frame" }),
    rect("f1", 10, 10, 10, 10, { frameId: "frame" }),
    rect("f2", 40, 10, 10, 10, { frameId: "frame" }),
    rect("out", 400, 0, 10, 10),
  ];
  assert.equal(clusterKey(framed[1]), "frame");
  assert.deepEqual(clusterOf(framed, framed[1]).members.map((e) => e.id), ["frame", "f1", "f2"], "the frame and everything in it");

  // The stamp the server writes when it places into a cluster is what makes
  // the cluster findable through any of its members on the next call.
  const tagged = [
    rect("k", 0, 0, 10, 10),
    rect("n1", 40, 0, 10, 10, { customData: { [CLUSTER_CUSTOM_DATA_KEY]: "k" } }),
    rect("n2", 80, 0, 10, 10, { customData: { [CLUSTER_CUSTOM_DATA_KEY]: "k" } }),
    rect("elsewhere", 400, 0, 10, 10, { customData: { [CLUSTER_CUSTOM_DATA_KEY]: "z" } }),
    rect("gone", 40, 40, 10, 10, { isDeleted: true, customData: { [CLUSTER_CUSTOM_DATA_KEY]: "k" } }),
  ];
  assert.equal(clusterKey(tagged[1]), "k", "a member's key is the cluster, not its own id");
  assert.deepEqual(clusterOf(tagged, tagged[0]).members.map((e) => e.id), ["k", "n1", "n2"]);
  assert.deepEqual(clusterOf(tagged, tagged[1]).members.map((e) => e.id), ["k", "n1", "n2"], "reached through a member");
  // A member whose cluster has lost everything else is still a cluster of
  // one: the anchor is always in its own cluster.
  assert.deepEqual(clusterOf(tagged, tagged[3]).members.map((e) => e.id), ["elsewhere"]);
  // An empty or non-string stamp is no stamp.
  assert.equal(clusterKey(rect("x", 0, 0, 1, 1, { customData: { [CLUSTER_CUSTOM_DATA_KEY]: "" } })), "x");
  assert.equal(clusterKey(rect("x", 0, 0, 1, 1, { customData: { [CLUSTER_CUSTOM_DATA_KEY]: 7 } })), "x");
  assert.equal(clusterKey(rect("x", 0, 0, 1, 1, { customData: {} })), "x");
});

test("candidate slots are a gap grid from the footprint's top-left, ordered row by row", () => {
  const grid = gridCandidates(box(0, 0, 40, 20), { width: 20, height: 20 }, 20, 0);
  // The grid starts at the footprint's own corner and runs right and down:
  // a cluster never grows up or left, so the space above and to the left of
  // its anchor stays free.
  assert.deepEqual(grid[0], { x: 0, y: 0, width: 20, height: 20 });
  assert.deepEqual(grid[1], { x: 20, y: 0, width: 20, height: 20 });
  assert.equal(grid.length, 3 * 2);
  assert.deepEqual(grid[grid.length - 1], { x: 40, y: 20, width: 20, height: 20 });
  assert.ok(
    grid.every((c) => c.x >= 0 && c.y >= 0),
    "no candidate is above or left of the footprint",
  );
  // Reach widens the grid to the right and downwards.
  assert.equal(gridCandidates(box(0, 0, 40, 20), { width: 20, height: 20 }, 20, 40).length, 5 * 4);
  assert.deepEqual(gridCandidates(box(10, 10, 0, 0), { width: 20, height: 20 }, 20, 0), [{ x: 10, y: 10, width: 20, height: 20 }]);
});

test("cluster placement stays inside the footprint and within the radius of its centre", () => {
  const radius = 300;
  const anchor = rect("k", 0, 0, 100, 100);
  let scene: ExcalidrawElement[] = [anchor];
  const size = { width: 60, height: 40 };
  const ids: string[] = [];
  const taken: [number, number][] = [];
  let last: PlacementResult | null = null;

  for (let i = 1; i <= 12; i++) {
    const id = `n${i}`;
    const result = placeIn(scene, { type: "rectangle", width: 60, height: 40, place: { cluster: "k" } }, radius);
    assert.equal(result.refusal, undefined, `n${i} was refused`);
    assert.equal(result.clusterKey, "k", "the member is stamped with the cluster it joined");
    assert.equal(result.outgrown, false, `n${i} still fits inside the radius`);
    scene = [...scene, reservedElement(id, "rectangle", result.x, result.y, size)].map((el) =>
      el.id === id ? { ...el, customData: { [CLUSTER_CUSTOM_DATA_KEY]: "k" } } : el,
    );
    ids.push(id);
    taken.push([result.x, result.y]);
    last = result;
  }

  // The candidate nearest the footprint's centre wins, and a tie goes to the
  // lower and further right of the two, so the cluster grows as a disc down
  // and to the right of its anchor rather than as a line.
  assert.deepEqual(taken.slice(0, 4), [
    [20, 120],
    [100, 120],
    [120, 60],
    [120, 0],
  ]);
  assert.deepEqual(last?.footprint, { x: 0, y: 0, width: 260, height: 280 });

  assertNoOverlap(scene);
  assert.ok(last?.footprint, "a cluster placement reports the footprint");
  const footprint = last.footprint;
  const centre = centreOf(footprint);
  for (const id of ids) {
    const member = scene.find((e) => e.id === id);
    assert.ok(member, id);
    assert.ok(contains(footprint, elementBox(member)), `${id} is inside the reported footprint`);
    assert.ok(cornerDistance(centre, elementBox(member)) <= radius, `${id} is within the radius of the centre`);
  }
  // The cluster is compact rather than a streak: twelve 60x40 nodes around a
  // 100x100 anchor fit well inside the radius.
  assert.ok(footprint.width <= 2 * radius && footprint.height <= 2 * radius, `${footprint.width}x${footprint.height}`);

  // The cluster grew down and right of its anchor and nowhere else, so a note
  // written against the anchor's left or top still lands beside it rather than
  // out past the cluster.
  for (const id of ids) {
    const member = scene.find((e) => e.id === id);
    assert.ok(member, id);
    assert.ok(elementBox(member).x >= 0 && elementBox(member).y >= 0, `${id} grew above or left of the anchor`);
  }
  const note = placeIn(scene, { type: "text", text: "@claude here", place: { near: "k", side: "left" } }, radius);
  assert.deepEqual([note.x, note.y], [-164, 0], "a 144 px note one gap left of the anchor");
  assert.equal(boxDistance(box(note.x, note.y, 144, 25), elementBox(anchor)), DEFAULT_GAP);

  // A gap inside the footprint is filled before the footprint grows, and the
  // reported footprint is then unchanged.
  const wide = [rect("a", 0, 0, 100, 100), rect("b", 400, 0, 100, 100)].map((el) => ({
    ...el,
    customData: { [CLUSTER_CUSTOM_DATA_KEY]: "a" },
  }));
  const inside = placeIn(wide, { type: "rectangle", width: 60, height: 40, place: { cluster: "a" } }, radius);
  assert.deepEqual([inside.x, inside.y], [120, 0], "the first free slot inside the footprint, row by row");
  assert.deepEqual(inside.footprint, { x: 0, y: 0, width: 500, height: 100 }, "the footprint did not have to grow");
  assert.equal(inside.outgrown, false);
  assertNoOverlap(withPlaced(wide, "inside", inside, { width: 60, height: 40 }));
});

test("a cluster that no longer fits inside the radius is still placed, and says so", () => {
  // A radius of 0 cannot hold any member, so the first extension outgrows it.
  const anchor = rect("k", 0, 0, 100, 100);
  const outgrown = placeIn([anchor], { type: "rectangle", width: 60, height: 40, place: { cluster: "k" } }, 0);
  assert.equal(outgrown.outgrown, true);
  // Still the free candidate nearest the centre, not the last one tried.
  assert.deepEqual([outgrown.x, outgrown.y], [20, 120]);
  assert.deepEqual(outgrown.footprint, { x: 0, y: 0, width: 100, height: 160 });
  assert.ok(outgrown.footprint, "the footprint is still reported");
  assert.ok(isFree(box(outgrown.x, outgrown.y, 60, 40), obstacleBoxes([anchor])), "and it still does not overlap");
  assert.deepEqual(placementLines("n1", outgrown), [
    `placed n1 at x=${outgrown.x} y=${outgrown.y}`,
    footprintText(outgrown.footprint),
    OUTGROWN_TEXT,
  ]);

  // With every candidate around the footprint blocked, the search leaves the
  // grid and takes the first free slot below the cluster.
  const walled = findClusterSlot([box(0, 0, 100, 100)], { width: 100, height: 100 }, 20, 0, [box(-300, -300, 700, 700)]);
  assert.deepEqual(walled.slot, box(0, 420, 100, 100), "a gap clear of the wall it had to leave");
  assert.equal(walled.outgrown, true);
  assert.deepEqual(walled.footprint, { x: 0, y: 0, width: 100, height: 520 });
});

test("a new cluster is separated by more than the radius", () => {
  const radius = 300;
  // A cluster of three around k, and a bystander inside the cluster's
  // neighbourhood that the new cluster also has to clear.
  const members = [
    rect("k", 0, 0, 100, 100),
    rect("n1", 0, 120, 60, 40, { customData: { [CLUSTER_CUSTOM_DATA_KEY]: "k" } }),
    rect("n2", 120, 0, 60, 40, { customData: { [CLUSTER_CUSTOM_DATA_KEY]: "k" } }),
  ];
  const scene = [...members, rect("bystander", 0, 300, 60, 40)];
  const result = placeIn(scene, { type: "rectangle", width: 100, height: 100, place: { near: "k", side: "below", newCluster: true } }, radius);
  assert.equal(result.refusal, undefined);
  const slot = box(result.x, result.y, 100, 100);
  for (const el of scene) {
    const gap = boxDistance(slot, elementBox(el));
    assert.ok(gap > radius, `${el.id} is only ${Math.round(gap)} px from the new cluster`);
  }
  assertNoOverlap(withPlaced(scene, "q", result, { width: 100, height: 100 }));
  // The scan starts a gap plus a radius plus the element's own size clear of
  // the whole cluster's footprint - not just of the anchor - and steps on
  // until the bystander inside the cluster's neighbourhood is cleared too.
  assert.deepEqual([result.x, result.y], [0, 660]);

  // The separation set is the cluster plus what sits inside the radius of it,
  // which is exactly what a mention on the cluster would read.
  const memberBoxes = members.map(elementBox);
  const footprint = union(memberBoxes);
  const separated = findNewClusterSlot("right", footprint, { width: 100, height: 100 }, 20, radius, obstacleBoxes(scene), [
    ...memberBoxes,
    elementBox(scene[3]),
  ]);
  assert.deepEqual(separated, box(600, 0, 100, 100));
  for (const el of scene) {
    assert.ok(boxDistance(separated, elementBox(el)) > radius, el.id);
  }

  // Without a side, a new cluster goes below, as auto does.
  const below = placeIn(members, { type: "rectangle", width: 100, height: 100, place: { near: "k", newCluster: true } }, radius);
  assert.deepEqual([below.x, below.y], [0, 580], "160 of footprint, then 20 + 300 + 100 clear of it");
  // A smaller radius brings the new cluster in.
  const near = placeIn(members, { type: "rectangle", width: 100, height: 100, place: { near: "k", side: "below", newCluster: true } }, 100);
  assert.deepEqual([near.x, near.y], [0, 380]);
});

// -------------------------------------------------------------- the radius

test("the room radius is the default for near queries", () => {
  // Two shapes 200 px apart: inside a 300 px room, outside a 150 px one.
  const scene = [rect("anchor", 0, 0, 100, 100), rect("neighbour", 300, 0, 100, 100)];
  assert.equal(boxDistance(elementBox(scene[0]), elementBox(scene[1])), 200);

  const reached = (roomRadius: number, requested?: number): string[] =>
    selectElements(scene, { near: { id: "anchor", radius: nearRadius(roomRadius, requested) } }).elements.map((e) => e.id);

  assert.deepEqual(reached(300), ["anchor", "neighbour"], "a 300 px room reaches the neighbour");
  assert.deepEqual(reached(150), ["anchor"], "a 150 px room does not");
  // A radius the caller names still wins over the room's.
  assert.deepEqual(reached(150, 300), ["anchor", "neighbour"]);
  assert.deepEqual(reached(300, 10), ["anchor"]);
  assert.equal(nearRadius(150), 150);
  assert.equal(nearRadius(150, 0), 0, "a radius of zero is a radius, not an absent one");
  assert.equal(nearRadius(), DEFAULT_NEARBY_RADIUS, "with no room to ask, the built-in default");
  assert.equal(DEFAULT_NEARBY_RADIUS, 250);

  // The same number governs placement: a new cluster clears the room radius,
  // so a wider room pushes it further out.
  const anchor = [rect("k", 0, 0, 100, 100)];
  const spec: PlacedSpec = { type: "rectangle", width: 100, height: 100, place: { near: "k", side: "below", newCluster: true } };
  assert.equal(placeIn(anchor, spec, 150).y, 370);
  assert.equal(placeIn(anchor, spec, 300).y, 520);
});

// -------------------------------------------------------------- refusals

test("place refuses what it cannot honour, naming the argument", () => {
  // The words matter as much as the refusal: they are what the caller reads
  // to find the argument to change.
  assert.match(BOTH_ANCHORS_TEXT, /near or cluster, not both/);
  assert.match(NO_ANCHOR_TEXT, /near: <id> or cluster: <id>/);
  assert.match(NEW_CLUSTER_NEEDS_NEAR_TEXT, /newCluster needs near: <id>/);
  assert.match(SIDE_WITH_CLUSTER_TEXT, /side has no effect with cluster/);
  const scene = [rect("k", 0, 0, 100, 100), rect("gone", 200, 0, 10, 10, { isDeleted: true })];
  const refusalFor = (spec: PlacedSpec): string | undefined => placeIn(scene, spec).refusal;

  assert.equal(refusalFor({ type: "rectangle", place: { near: "k", cluster: "k" } }), BOTH_ANCHORS_TEXT);
  assert.equal(refusalFor({ type: "rectangle", place: {} }), NO_ANCHOR_TEXT);
  assert.equal(refusalFor({ type: "rectangle", place: { cluster: "k", newCluster: true } }), NEW_CLUSTER_NEEDS_NEAR_TEXT);
  assert.equal(refusalFor({ type: "rectangle", place: { cluster: "k", side: "left" } }), SIDE_WITH_CLUSTER_TEXT);
  assert.equal(refusalFor({ type: "rectangle", place: { near: "nope" } }), anchorMissingText("nope"));
  assert.equal(refusalFor({ type: "rectangle", place: { near: "gone" } }), anchorMissingText("gone"), "a deleted anchor is not an anchor");
  for (const type of ["arrow", "line", "freedraw"] as const) {
    assert.equal(refusalFor({ type, place: { near: "k" } }), unplaceableText(type), type);
  }
  assert.match(anchorMissingText("z"), /place anchor not found: z/);
  assert.match(unplaceableText("arrow"), /arrow/);
  // A refusal places nothing, so the coordinates carry no meaning.
  assert.deepEqual(placeIn(scene, { type: "rectangle", place: {} }), { x: 0, y: 0, refusal: NO_ANCHOR_TEXT });
});

test("what a placement reports is the coordinates it wrote, and the cluster box", () => {
  assert.equal(placedText("n1", { x: 40, y: -20 }), "placed n1 at x=40 y=-20");
  assert.equal(footprintText(box(1, 2, 3, 4)), "footprint x=1 y=2 width=3 height=4");
  assert.deepEqual(placementLines("n1", { x: 1, y: 2 }), ["placed n1 at x=1 y=2"]);
  assert.deepEqual(placementLines("n1", { x: 1, y: 2, footprint: box(0, 0, 9, 9), outgrown: false }), [
    "placed n1 at x=1 y=2",
    "footprint x=0 y=0 width=9 height=9",
  ]);
  assert.deepEqual(placementLines("n1", { x: 1, y: 2, outgrown: true }), ["placed n1 at x=1 y=2", OUTGROWN_TEXT]);
  assert.equal(OUTGROWN_TEXT, "cluster outgrown the radius");
});

test("a slot taken earlier in the same call is an obstacle for the next spec", () => {
  const anchor = rect("k", 0, 0, 100, 100);
  const first = placeIn([anchor], { type: "rectangle", width: 80, height: 40, place: { near: "k", side: "right" } });
  const reserved = reservedElement("first", "rectangle", first.x, first.y, SIZE);
  assert.deepEqual(elementBox(reserved), { x: 120, y: 0, width: 80, height: 40 });
  assert.equal(reserved.isDeleted, false, "a reservation is live, or the search would ignore it");
  assert.equal(reserved.type, "rectangle");
  const second = placeIn([anchor, reserved], { type: "rectangle", width: 80, height: 40, place: { near: "k", side: "right" } });
  assert.deepEqual([second.x, second.y], [220, 0]);
  // And it can be the next spec's anchor.
  const third = placeIn([anchor, reserved], { type: "rectangle", width: 80, height: 40, place: { near: "first", side: "below" } });
  assert.deepEqual([third.x, third.y], [120, 60]);
});
