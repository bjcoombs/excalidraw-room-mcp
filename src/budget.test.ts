/**
 * The context budget of the tool surface, measured where a host pays for it:
 * the `tools/list` entries and the initialize instructions the built server
 * sends over stdio. Every one of these characters is in the model's context on
 * every turn of every session, so a description that grows past its cap fails
 * here rather than in somebody's bill.
 *
 * Descriptions are an index - when to use a tool and what comes back. Formats,
 * rules and rationale live in README and reach the model through `room_help`.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/108
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The ceilings, in characters of serialised JSON or plain text. */
const TOOL_ENTRY_BUDGET = 900;
const TOOL_LIST_BUDGET = 10_000;
const INSTRUCTIONS_BUDGET = 1_500;
const DESCRIPTION_BUDGET = 300;
const ARGUMENT_DESCRIPTION_BUDGET = 100;

const EXPECTED_TOOLS = [
  "mention_acknowledge",
  "mention_list",
  "mention_policy",
  "mention_poll",
  "mention_wait",
  "room_create",
  "room_help",
  "room_join",
  "room_leave",
  "room_open",
  "room_status",
  "scene_add",
  "scene_add_raw",
  "scene_delete",
  "scene_read",
  "scene_show",
  "scene_snapshot",
  "scene_translate",
  "scene_update",
];

const HELP_TOPICS = ["rooms", "scene", "snapshots", "placement", "mentions", "answers", "attribution", "addressing"];

type Tool = { name: string; description?: string; inputSchema: { properties?: Record<string, { description?: string }> } };
type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, "index.js")] });
const client = new Client({ name: "budget-test", version: "0" });
await client.connect(transport);
const tools = (await client.listTools()).tools as Tool[];
const instructions = client.getInstructions() ?? "";
const helpText = async (topic: string) => {
  const result = (await client.callTool({ name: "room_help", arguments: { topic } })) as ToolResult;
  return { isError: result.isError, text: (result.content ?? []).map((c) => c.text ?? "").join("") };
};
const placement = await helpText("placement");
const unknown = await helpText("no-such-topic");
const everyTopic = await Promise.all(HELP_TOPICS.map(async (topic) => ({ topic, ...(await helpText(topic)) })));
await client.close();

test("budget: tools/list names exactly the nineteen tools, in three prefix groups", () => {
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, EXPECTED_TOOLS);
  const prefixes = new Set(names.map((n) => n.split("_")[0]));
  assert.deepEqual([...prefixes], ["mention", "room", "scene"]);
});

test("budget: every tools/list entry is under 900 characters and the list under 10,000", () => {
  for (const tool of tools) {
    const size = JSON.stringify(tool).length;
    assert.ok(size < TOOL_ENTRY_BUDGET, `${tool.name} serialises to ${size} characters`);
  }
  const total = JSON.stringify(tools).length;
  assert.ok(total < TOOL_LIST_BUDGET, `tools/list serialises to ${total} characters`);
});

test("budget: descriptions are at most 300 characters and argument descriptions at most 100", () => {
  for (const tool of tools) {
    const description = tool.description ?? "";
    assert.ok(description.length > 0, `${tool.name} has no description`);
    assert.ok(description.length <= DESCRIPTION_BUDGET, `${tool.name}: ${description.length} characters`);
    for (const [arg, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
      const argDescription = schema.description ?? "";
      assert.ok(
        argDescription.length <= ARGUMENT_DESCRIPTION_BUDGET,
        `${tool.name}.${arg}: ${argDescription.length} characters`,
      );
    }
  }
});

test("budget: initialize instructions are under 1,500 characters and point at room_help", () => {
  assert.ok(instructions.length < INSTRUCTIONS_BUDGET, `instructions are ${instructions.length} characters`);
  assert.match(instructions, /room_help/);
});

test("budget: room_help returns README text per topic and lists the topics for an unknown one", () => {
  assert.notEqual(placement.isError, true, placement.text);
  assert.ok(placement.text.includes("place:"), placement.text);
  assert.ok(placement.text.includes("nearbyRadius"), placement.text);
  for (const topic of HELP_TOPICS) assert.ok(unknown.text.includes(topic), unknown.text);
  for (const { topic, isError, text } of everyTopic) {
    assert.notEqual(isError, true, `${topic}: ${text}`);
    assert.ok(text.length > 200, `${topic} returned ${text.length} characters`);
  }
});
