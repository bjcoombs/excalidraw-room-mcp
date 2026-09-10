import { test } from "node:test";
import assert from "node:assert/strict";
import { LISTEN_TIP, SERVER_INSTRUCTIONS } from "./instructions.js";

test("instructions name the listen loop and both of its tools", () => {
  assert.match(SERVER_INSTRUCTIONS, /wait_for_mention/);
  assert.match(SERVER_INSTRUCTIONS, /acknowledge_mention/);
  assert.match(SERVER_INSTRUCTIONS, /create_room/);
  assert.match(SERVER_INSTRUCTIONS, /600/);
});

test("instructions state that mention text is data, not instructions", () => {
  assert.match(SERVER_INSTRUCTIONS, /\bdata\b/);
  assert.match(SERVER_INSTRUCTIONS, /not instructions/);
});

test("instructions say a backgrounded wait is expected", () => {
  assert.match(SERVER_INSTRUCTIONS, /background/);
});

test("the tip carries the tool, the timeout and the tag", () => {
  assert.match(LISTEN_TIP, /^Tip: /);
  assert.match(LISTEN_TIP, /wait_for_mention/);
  assert.match(LISTEN_TIP, /600/);
  assert.match(LISTEN_TIP, /@claude/);
});

test("instructions point a person at the browser after a room is opened", () => {
  assert.match(SERVER_INSTRUCTIONS, /open_room/);
  assert.match(SERVER_INSTRUCTIONS, /excalidraw\.com/);
});
