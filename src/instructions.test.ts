import { test } from "node:test";
import assert from "node:assert/strict";
import { HELP_TOPIC_NAMES } from "./help.js";
import { LISTEN_TIP, SERVER_INSTRUCTIONS } from "./instructions.js";
import { MENTION_SCOPE_RULE, MENTION_SCOPE_RULE_ANSWERING, STATE_REQUESTS_LINE } from "./mentions.js";

test("instructions name the listen loop and both of its tools", () => {
  assert.match(SERVER_INSTRUCTIONS, /mention_wait/);
  assert.match(SERVER_INSTRUCTIONS, /mention_acknowledge/);
  assert.match(SERVER_INSTRUCTIONS, /room_create/);
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
  assert.match(LISTEN_TIP, /mention_wait/);
  assert.match(LISTEN_TIP, /600/);
  assert.match(LISTEN_TIP, /@claude/);
});

test("instructions point a person at the browser after a room is opened", () => {
  assert.match(SERVER_INSTRUCTIONS, /room_open/);
});

test("instructions tell the model to state each mention's request before it draws", () => {
  assert.ok(SERVER_INSTRUCTIONS.includes(STATE_REQUESTS_LINE), SERVER_INSTRUCTIONS);
  assert.equal(
    STATE_REQUESTS_LINE,
    "Before changing anything, say in one line per mention what it asks and what you will draw.",
  );
});

test("instructions carry the starting scope rule verbatim and leave the answering form to the results", () => {
  assert.ok(SERVER_INSTRUCTIONS.includes(MENTION_SCOPE_RULE), SERVER_INSTRUCTIONS);
  assert.ok(MENTION_SCOPE_RULE.includes('the status "out of scope"'), MENTION_SCOPE_RULE);
  // Answering is off when a session starts; mention_policy's result and every
  // mention result carry the answering form once a person turns it on.
  assert.ok(!SERVER_INSTRUCTIONS.includes(MENTION_SCOPE_RULE_ANSWERING), SERVER_INSTRUCTIONS);
  assert.match(SERVER_INSTRUCTIONS, /mention_policy/);
});

test("instructions point at room_help, name every topic, and stay under 1,500 characters", () => {
  assert.match(SERVER_INSTRUCTIONS, /room_help/);
  for (const topic of HELP_TOPIC_NAMES) assert.ok(SERVER_INSTRUCTIONS.includes(topic), topic);
  assert.ok(SERVER_INSTRUCTIONS.length < 1500, `${SERVER_INSTRUCTIONS.length} characters`);
});
