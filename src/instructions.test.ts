import { test } from "node:test";
import assert from "node:assert/strict";
import { LISTEN_TIP, SERVER_INSTRUCTIONS } from "./instructions.js";
import { MENTION_SCOPE_RULE } from "./mentions.js";

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

test("instructions tell the agent to snapshot hand-drawn content and to check a layout for overlap", () => {
  const sentences = SERVER_INSTRUCTIONS.split(". ");
  assert.ok(
    sentences.some((s) => /snapshot_scene/.test(s) && /hand-drawn|strokes/.test(s)),
    SERVER_INSTRUCTIONS,
  );
  assert.ok(
    sentences.some((s) => /snapshot_scene/.test(s) && /overlap/.test(s)),
    SERVER_INSTRUCTIONS,
  );
});

test("instructions carry the scope rule verbatim, and it names the status not a note", () => {
  assert.ok(SERVER_INSTRUCTIONS.includes(MENTION_SCOPE_RULE), SERVER_INSTRUCTIONS);
  assert.ok(MENTION_SCOPE_RULE.includes('the status "out of scope"'), MENTION_SCOPE_RULE);
  assert.ok(!MENTION_SCOPE_RULE.includes("the note"), MENTION_SCOPE_RULE);
  // `note` was acknowledge_mention's free-text status until 0.7.0. Nothing the
  // model is told at initialize may still point at it.
  assert.ok(!SERVER_INSTRUCTIONS.includes("with the note"), SERVER_INSTRUCTIONS);
  assert.ok(SERVER_INSTRUCTIONS.includes('status "out of scope" or "see chat"'), SERVER_INSTRUCTIONS);
});
