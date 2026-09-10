import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultHandle, isValidHandle, MAX_HANDLE_LENGTH, uniqueHandle } from "./handle.js";

test("handle validation accepts lowercase letters, digits and hyphens up to 32 characters and refuses the rest", () => {
  assert.equal(isValidHandle("ben-claude"), true);
  assert.equal(isValidHandle("kt"), true);
  assert.equal(isValidHandle("a1-2b"), true);
  assert.equal(isValidHandle("-"), true);
  assert.equal(isValidHandle("a".repeat(MAX_HANDLE_LENGTH)), true);

  assert.equal(isValidHandle(""), false);
  assert.equal(isValidHandle("a".repeat(MAX_HANDLE_LENGTH + 1)), false);
  assert.equal(isValidHandle("Bad_Name"), false);
  assert.equal(isValidHandle("Ben"), false);
  assert.equal(isValidHandle("ben claude"), false);
  assert.equal(isValidHandle("ben.claude"), false);
  assert.equal(isValidHandle("ben\nclaude"), false);
});

test("the default handle is the os user followed by -claude", () => {
  assert.equal(defaultHandle("ben"), "ben-claude");
  assert.equal(defaultHandle("Ada.Lovelace"), "ada-lovelace-claude");
  assert.equal(defaultHandle(""), "agent-claude");
  const long = defaultHandle("z".repeat(64));
  assert.equal(long.length, MAX_HANDLE_LENGTH);
  assert.equal(isValidHandle(long), true);
  assert.ok(long.endsWith("-claude"));
  assert.ok(isValidHandle(defaultHandle()));
});

test("a clashing handle gets -2, then -3", () => {
  assert.equal(uniqueHandle("kt", []), "kt");
  assert.equal(uniqueHandle("kt", ["someone-else"]), "kt");
  assert.equal(uniqueHandle("kt", ["kt"]), "kt-2");
  assert.equal(uniqueHandle("kt", ["kt", "kt-2"]), "kt-3");
  assert.equal(uniqueHandle("kt", ["kt", "kt-2", "kt-3"]), "kt-4");
  const full = "a".repeat(MAX_HANDLE_LENGTH);
  const suffixed = uniqueHandle(full, [full]);
  assert.equal(suffixed, `${"a".repeat(MAX_HANDLE_LENGTH - 2)}-2`);
  assert.equal(isValidHandle(suffixed), true);
});
