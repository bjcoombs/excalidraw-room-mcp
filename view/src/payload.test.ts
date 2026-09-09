/**
 * The view's side of the show_room contract. Compiled for Node by
 * tsconfig.view-test.json (this module touches no DOM and no React) and run by
 * `npm test` alongside the server's tests; src/view.test.ts pins the other end.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { boundsChanged, sceneBounds } from "./bounds.js";
import { envelopeShape, parsePayload, parseResult, resultText, roomLink, sceneSignature } from "./payload.js";

const LINK = "https://excalidraw.com/#room=0123456789abcdef0123,AbCdEfGhIjKlMnOpQrStUv";

function payload(over: Record<string, unknown> = {}) {
  return {
    link: LINK,
    connected: true,
    peers: [{ socketId: "sock-1", username: "Ada" }],
    elements: [{ id: "rect-1", type: "rectangle", version: 3, versionNonce: 42 }],
    mentions: [{ id: "note", version: 5, text: "@claude here", x: 0, y: 150, width: 200, height: 25, containerId: null, nearby: ["rect-1"] }],
    ...over,
  };
}

test("parsePayload reads the payload from structuredContent, whatever the text says", () => {
  const result = {
    content: [{ type: "text", text: "room: " + LINK + "\nconnected: true\npeers: 1\nelements: 1\npending mentions: 1" }],
    structuredContent: payload(),
  };
  const parsed = parsePayload(result);
  assert.ok(parsed, "the structured channel is a payload");
  assert.equal(parsed!.link, LINK);
  assert.equal(parsed!.connected, true);
  assert.equal(parsed!.elements.length, 1);
  assert.equal(parsed!.elements[0].id, "rect-1");
  assert.equal(parsed!.peers.length, 1);
  assert.equal(parsed!.mentions[0].nearby[0], "rect-1");
});

test("parsePayload falls back to the JSON text when there is no structuredContent", () => {
  const parsed = parsePayload({ content: [{ type: "text", text: JSON.stringify(payload()) }] });
  assert.ok(parsed, "include: json still renders");
  assert.equal(parsed!.link, LINK);
  assert.equal(parsed!.elements.length, 1);
  assert.equal(parsed!.mentions.length, 1);
});

test("parsePayload prefers structuredContent over the text when both are payloads", () => {
  const parsed = parsePayload({
    content: [{ type: "text", text: JSON.stringify(payload({ elements: [] })) }],
    structuredContent: payload(),
  });
  assert.equal(parsed!.elements.length, 1, "the structured channel wins");
});

test("parsePayload returns null for the pre-join refusal and for anything that is not a payload", () => {
  assert.equal(parsePayload(undefined), null);
  assert.equal(parsePayload({}), null);
  assert.equal(parsePayload({ content: [] }), null);
  assert.equal(
    parsePayload({ content: [{ type: "text", text: "Not in a room. Call create_room or join_room first." }], isError: true }),
    null,
    "a plain-text refusal is no payload, not a crash",
  );
  assert.equal(parsePayload({ structuredContent: { link: LINK } }), null, "no elements array is no payload");
  assert.equal(parsePayload({ structuredContent: "elements" }), null);
});

// Hosts differ in what a callServerTool result looks like by the time it
// reaches the iframe. Each shape below is one of those envelopes; the seed path
// (`ontoolresult`) delivers the first of them.
const SUMMARY = "room: " + LINK + "\nconnected: true\npeers: 1\nelements: 1\npending mentions: 1";

function summaryResult(over: Record<string, unknown> = {}) {
  return { content: [{ type: "text", text: SUMMARY }], ...over };
}

test("parsePayload reads the payload out of every envelope a host may wrap it in", () => {
  const structured = summaryResult({ structuredContent: payload() });
  const shapes: Record<string, unknown> = {
    "the result itself": structured,
    "result.result": { result: structured },
    "result.toolResult": { toolResult: structured },
    "structuredContent one level up": { structuredContent: payload(), content: [{ type: "text", text: SUMMARY }] },
    "result.result.structuredContent": { result: { structuredContent: payload() } },
    "result.toolResult.structuredContent": { toolResult: { structuredContent: payload() } },
    "a wrapper around result.toolResult": { result: { toolResult: structured } },
    "the bare payload": payload(),
    "a JSON text item": { content: [{ type: "text", text: JSON.stringify(payload()) }] },
    "a JSON text item nested in result": { result: { content: [{ type: "text", text: JSON.stringify(payload()) }] } },
    "a JSON string result": JSON.stringify(structured),
    "a JSON string in result.result": { result: JSON.stringify(structured) },
  };
  for (const [name, result] of Object.entries(shapes)) {
    const parsed = parsePayload(result);
    assert.ok(parsed, name + " is a payload");
    assert.equal(parsed!.link, LINK, name);
    assert.equal(parsed!.elements.length, 1, name);
    assert.equal(parsed!.elements[0].id, "rect-1", name);
  }
});

test("parseResult names the channel the payload came from", () => {
  assert.equal(parseResult(summaryResult({ structuredContent: payload() })).source, "structured");
  assert.equal(parseResult({ result: { structuredContent: payload() } }).source, "structured");
  assert.equal(parseResult(payload()).source, "structured", "a bare payload is not the text channel");
  assert.equal(parseResult({ content: [{ type: "text", text: JSON.stringify(payload()) }] }).source, "text");
  assert.equal(parseResult(summaryResult()).source, null);
  assert.equal(parseResult(summaryResult()).payload, null);
});

test("parsePayload returns null for a summary-only result, at any nesting", () => {
  assert.equal(parsePayload(summaryResult()), null, "the default summary text is not the payload");
  assert.equal(parsePayload({ result: summaryResult() }), null);
  assert.equal(parsePayload({ toolResult: summaryResult() }), null);
  assert.equal(parsePayload("not json at all"), null);
  assert.equal(parsePayload(JSON.stringify(summaryResult())), null);
});

test("parsePayload survives an envelope that points at itself", () => {
  const loop: Record<string, unknown> = { content: [{ type: "text", text: SUMMARY }] };
  loop.result = loop;
  assert.equal(parsePayload(loop), null, "a cycle terminates rather than hanging");
});

test("envelopeShape names the keys of a result the parser could not read", () => {
  assert.equal(envelopeShape(undefined), "undefined");
  assert.equal(envelopeShape(null), "null");
  assert.equal(envelopeShape("summary text"), "string");
  assert.equal(envelopeShape(summaryResult()), "{content}");
  assert.equal(envelopeShape({ result: summaryResult() }), "{result} result{content}");
  assert.equal(envelopeShape({ toolResult: { content: [], isError: false } }), "{toolResult} toolResult{content,isError}");
  assert.equal(envelopeShape({ result: "{}" }), "{result} result:string");
});

test("resultText finds the summary a host nested, for the note under the header", () => {
  assert.equal(resultText(summaryResult()), SUMMARY);
  assert.equal(resultText({ result: summaryResult() }), SUMMARY);
  assert.equal(resultText({ content: [] }), null);
  assert.equal(resultText(undefined), null);
});

test("parsePayload defaults the fields a host may have dropped, and keeps elements verbatim", () => {
  const parsed = parsePayload({ structuredContent: { elements: [{ id: "a" }] } });
  assert.deepEqual(parsed, { link: null, connected: false, peers: [], elements: [{ id: "a" }], mentions: [] });
});

test("roomLink only trusts an excalidraw.com room URL", () => {
  assert.equal(roomLink(LINK), LINK);
  assert.equal(roomLink(null), null);
  assert.equal(roomLink("javascript:alert(1)"), null);
  assert.equal(roomLink("https://example.com/#room=abc,def"), null);
});

test("sceneSignature moves when an element's version or nonce moves", () => {
  const els = [{ id: "a", version: 1, versionNonce: 7 }];
  assert.equal(sceneSignature(els), sceneSignature([{ id: "a", version: 1, versionNonce: 7 }]));
  assert.notEqual(sceneSignature(els), sceneSignature([{ id: "a", version: 2, versionNonce: 7 }]));
  assert.notEqual(sceneSignature(els), sceneSignature([{ id: "a", version: 1, versionNonce: 8 }]));
  assert.notEqual(sceneSignature(els), sceneSignature([]));
});

// The bounds helpers drive fit-to-content: app.tsx refits only when these say
// the extent moved. https://github.com/bjcoombs/excalidraw-room-mcp/issues/31
function el(over: Record<string, unknown> = {}) {
  return { id: "a", x: 0, y: 0, width: 100, height: 50, ...over };
}

test("sceneBounds encloses every element and is null for an empty scene", () => {
  assert.equal(sceneBounds([]), null);
  assert.deepEqual(sceneBounds([el()]), { minX: 0, minY: 0, maxX: 100, maxY: 50 });
  assert.deepEqual(sceneBounds([el(), el({ id: "b", x: 300, y: -20, width: 200, height: 100 })]), { minX: 0, minY: -20, maxX: 500, maxY: 80 });
});

test("sceneBounds covers the reported case: a wide diagram with a note far below", () => {
  const bounds = sceneBounds([el({ id: "diagram", width: 1200, height: 700 }), el({ id: "note", y: 900, width: 200, height: 25 })]);
  assert.deepEqual(bounds, { minX: 0, minY: 0, maxX: 1200, maxY: 925 }, "the note 200 px below the diagram is inside the box");
});

test("sceneBounds skips deleted elements and elements with unusable geometry", () => {
  assert.deepEqual(sceneBounds([el(), el({ id: "gone", x: 9000, y: 9000, isDeleted: true })]), { minX: 0, minY: 0, maxX: 100, maxY: 50 });
  assert.deepEqual(sceneBounds([el(), el({ id: "bad", x: Number.NaN, y: 0 })]), { minX: 0, minY: 0, maxX: 100, maxY: 50 });
  const point = sceneBounds([el({ width: undefined, height: undefined })]);
  assert.deepEqual(point, { minX: 0, minY: 0, maxX: 0, maxY: 0 }, "a point element is a zero-size box");
  assert.equal(sceneBounds([el({ x: "0" })]), null, "a non-numeric coordinate is no element");
});

test("sceneBounds normalises a negative width or height", () => {
  assert.deepEqual(sceneBounds([el({ x: 100, y: 50, width: -100, height: -50 })]), { minX: 0, minY: 0, maxX: 100, maxY: 50 });
});

test("boundsChanged is true when the scene appears, disappears, or grows", () => {
  const box = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  assert.equal(boundsChanged(null, box), true, "first paint fits");
  assert.equal(boundsChanged(box, null), true);
  assert.equal(boundsChanged(null, null), false);
  assert.equal(boundsChanged(box, { ...box, maxY: 850 }), true, "an element 800 px below refits");
  assert.equal(boundsChanged(box, { ...box, minX: -400 }), true);
});

test("boundsChanged is false for an edit inside the existing bounds", () => {
  const box = { minX: 0, minY: 0, maxX: 1200, maxY: 700 };
  assert.equal(boundsChanged(box, { ...box }), false, "the viewport is left where the reader put it");
  assert.equal(boundsChanged(box, { ...box, maxX: 1200.4 }), false, "sub-pixel drift is not a refit");
  assert.equal(boundsChanged(box, { ...box, maxX: 1204 }), true);
  assert.equal(boundsChanged(box, { ...box, maxX: 1204 }, 10), false, "the tolerance is the caller's");
});

test("sceneBounds grows for a mention highlight at the edge of the scene", () => {
  // highlights.ts draws a box HIGHLIGHT_PADDING outside the mention it wraps,
  // so app.tsx measures the drawn list rather than the scene elements: a
  // highlight on the outermost element is what decides the fitted viewport.
  const HIGHLIGHT_PADDING = 8;
  const note = el({ id: "note", x: 0, y: 900, width: 200, height: 25 });
  const scene = [el({ id: "diagram", width: 1200, height: 700 }), note];
  const highlight = el({
    id: "mention-highlight-note",
    x: note.x - HIGHLIGHT_PADDING,
    y: note.y - HIGHLIGHT_PADDING,
    width: note.width + HIGHLIGHT_PADDING * 2,
    height: note.height + HIGHLIGHT_PADDING * 2,
  });
  const withoutHighlight = sceneBounds(scene);
  const withHighlight = sceneBounds([...scene, highlight]);
  assert.deepEqual(withoutHighlight, { minX: 0, minY: 0, maxX: 1200, maxY: 925 });
  assert.deepEqual(withHighlight, { minX: -8, minY: 0, maxX: 1200, maxY: 933 }, "the highlight extends the box it is drawn around");
  assert.equal(boundsChanged(withoutHighlight, withHighlight), true, "measuring the wrong list would skip this refit");
});
