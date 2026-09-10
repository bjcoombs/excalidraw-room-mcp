import assert from "node:assert/strict";
import test from "node:test";
import type { ShowRoomMention } from "./payload.js";
import { canvasElements, HIGHLIGHT_ID_PREFIX, HIGHLIGHT_PADDING, highlightBoxes } from "./scene.js";

function mention(over: Partial<ShowRoomMention> = {}): ShowRoomMention {
  return { id: "text-1", version: 5, text: "@claude add a box here", x: 20, y: 40, width: 200, height: 25, containerId: null, nearby: [], ...over };
}

test("a pending mention element is highlighted on the canvas", () => {
  const note = mention();
  const boxes = highlightBoxes([note]);
  assert.equal(boxes.length, 1);
  const [box] = boxes;
  assert.equal(box.id, `${HIGHLIGHT_ID_PREFIX}${note.id}`);
  assert.equal(box.type, "rectangle");
  assert.equal(box.strokeStyle, "dashed");
  // The box wraps the note on every side rather than sitting on its edge.
  assert.equal(box.x, note.x - HIGHLIGHT_PADDING);
  assert.equal(box.y, note.y - HIGHLIGHT_PADDING);
  assert.equal(box.width, note.width + HIGHLIGHT_PADDING * 2);
  assert.equal(box.height, note.height + HIGHLIGHT_PADDING * 2);
  // The highlight is a box and not a copy of the note: nothing here carries text.
  assert.ok(!JSON.stringify(box).includes("add a box here"));
  // And it reaches the canvas on top of the room's own elements.
  const drawn = canvasElements([{ id: note.id }], boxes as unknown as { id: string }[]);
  assert.deepEqual(
    drawn.map((e) => e.id),
    [note.id, `${HIGHLIGHT_ID_PREFIX}${note.id}`],
  );
});

test("a room with no pending mentions draws no highlights", () => {
  assert.deepEqual(highlightBoxes([]), []);
});
