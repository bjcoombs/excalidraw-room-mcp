/**
 * The view's side of the show_room contract. Compiled for Node by
 * tsconfig.view-test.json (this module touches no DOM and no React) and run by
 * `npm test` alongside the server's tests; src/view.test.ts pins the other end.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parsePayload, roomLink, sceneSignature } from "./payload.js";

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
