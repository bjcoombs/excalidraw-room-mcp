/**
 * The bundled agents' frontmatter is a contract, not a comment: a subagent can
 * call exactly the tools listed there and nothing else, so the answerer's
 * narrow grant is what stops it drawing anything but an answer on the note it
 * was given. These tests assert the grant exactly, so widening one is a test
 * change a reviewer sees rather than a silent one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { bundledAgentPaths } from "./install-agent.js";

interface Frontmatter {
  name: string;
  description: string;
  model: string;
  tools: string[];
}

/** Read the `key: value` block between the opening and closing `---` lines. */
function frontmatter(file: string): Frontmatter {
  const text = readFileSync(file, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, `${file} should open with a frontmatter block`);
  const fields = new Map<string, string>();
  for (const line of match[1].split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const tools = (fields.get("tools") ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  return {
    name: fields.get("name") ?? "",
    description: fields.get("description") ?? "",
    model: fields.get("model") ?? "",
    tools,
  };
}

function agent(name: string): Frontmatter {
  const file = bundledAgentPaths().find((p) => path.basename(p) === `${name}.md`);
  assert.ok(file, `${name} should be a bundled agent`);
  return frontmatter(file);
}

const room = (tool: string) => `mcp__excalidraw-room__${tool}`;

test("each bundled agent names itself after its file and picks a model", () => {
  for (const file of bundledAgentPaths()) {
    const fm = frontmatter(file);
    assert.equal(fm.name, path.basename(file, ".md"));
    assert.equal(fm.model, "sonnet");
    assert.ok(fm.description.length > 0, `${fm.name} needs a description for the lead to route on`);
  }
});

test("canvas-answerer is granted exactly the read, acknowledge and web-lookup tools", () => {
  assert.deepEqual(agent("canvas-answerer").tools, [
    room("room_status"),
    room("scene_read"),
    room("mention_acknowledge"),
    "WebSearch",
    "WebFetch",
  ]);
});

test("canvas-answerer holds no tool that could change the canvas or the connection", () => {
  const granted = new Set(agent("canvas-answerer").tools);
  for (const tool of [
    room("scene_add"),
    room("scene_add_raw"),
    room("scene_update"),
    room("scene_translate"),
    room("scene_delete"),
    room("room_create"),
    room("room_join"),
    room("room_leave"),
    room("mention_policy"),
    "Agent",
    "Bash",
    "Read",
    "Write",
    "Edit",
    "Glob",
    "Grep",
  ]) {
    assert.equal(granted.has(tool), false, `canvas-answerer must not be granted ${tool}`);
  }
});

test("canvas-listener keeps its canvas tools and gains Agent to spawn answerers", () => {
  const granted = new Set(agent("canvas-listener").tools);
  for (const tool of [
    "room_status",
    "scene_read",
    "mention_wait",
    "mention_list",
    "mention_acknowledge",
    "scene_add",
    "scene_update",
    "scene_delete",
    "scene_snapshot",
  ]) {
    assert.ok(granted.has(room(tool)), `canvas-listener should still be granted ${tool}`);
  }
  assert.ok(granted.has("Agent"), "canvas-listener spawns canvas-answerer, so it needs Agent");
});

test("canvas-listener's Agent grant is restricted to canvas-answerer in words", () => {
  const file = bundledAgentPaths().find((p) => path.basename(p) === "canvas-listener.md");
  assert.ok(file);
  const body = readFileSync(file, "utf8");
  // There is no per-agent spawn allowlist, so the restriction is an
  // instruction. If the sentence goes, the restriction goes with it.
  assert.match(body, /canvas-answerer/);
  assert.match(body, /spawn/i);
});
