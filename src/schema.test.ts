/**
 * Guards the shape of the emitted tool input schemas against the Anthropic
 * API's constraint on `items`: it accepts an object or a boolean, never the
 * draft-07 tuple form (an array of per-position schemas). A zod tuple emits
 * that array, and the API then rejects the whole tool list at session start,
 * so a single tuple anywhere makes every tool unavailable.
 *
 * The schemas are read from a real `tools/list` over stdio rather than from
 * the zod objects, because it is the SDK's conversion - not the zod source -
 * that the API sees.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

type Tool = { name: string; description?: string; inputSchema: unknown };

type ToolResult = { isError?: boolean; content?: { type: string; text?: string }[] };

/** One connected client against the built server over stdio, for the body of `use`. */
async function use<T>(body: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "index.js")],
  });
  const client = new Client({ name: "schema-test", version: "0" });
  await client.connect(transport);
  try {
    return await body(client);
  } finally {
    await client.close();
  }
}

/** One `tools/list` round trip against the built server over stdio. */
async function listTools(): Promise<Tool[]> {
  return use(async (client) => (await client.listTools()).tools as Tool[]);
}

/** The concatenated text of a tool result. */
function resultText(result: ToolResult): string {
  return (result.content ?? []).map((c) => c.text ?? "").join("");
}

/** Every value stored under a key named `items`, at any depth. */
function collectItems(node: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) {
    for (const entry of node) collectItems(entry, out);
    return out;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (key === "items") out.push(value);
      collectItems(value, out);
    }
  }
  return out;
}

const tools = await listTools();

test("tools/list emits no array-valued items in any input schema", () => {
  assert.ok(tools.length > 0, "expected at least one tool");
  for (const tool of tools) {
    for (const items of collectItems(tool.inputSchema)) {
      assert.ok(
        !Array.isArray(items),
        `${tool.name}: items is a tuple-form array, which the Anthropic API rejects: ${JSON.stringify(items)}`,
      );
      assert.ok(
        typeof items === "object" || typeof items === "boolean",
        `${tool.name}: items must be an object or a boolean, got ${typeof items}`,
      );
    }
  }
});

test("add_elements describes a point as a two-number array with object-form items", () => {
  const addElements = tools.find((t) => t.name === "add_elements");
  assert.ok(addElements, "add_elements is not in tools/list");
  const schema = addElements.inputSchema as {
    properties: { elements: { items: { properties: { points: Record<string, unknown> } } } };
  };
  const points = schema.properties.elements.items.properties.points;
  assert.equal(points.type, "array");
  const pointSchema = points.items as Record<string, unknown>;
  assert.equal(pointSchema.type, "array");
  assert.deepEqual(pointSchema.items, { type: "number" });
  assert.equal(pointSchema.minItems, 2);
  assert.equal(pointSchema.maxItems, 2);
});

test("snapshot_scene takes only the six selector and size arguments, none of them required", () => {
  const snapshot = tools.find((t) => t.name === "snapshot_scene");
  assert.ok(snapshot, "snapshot_scene is not in tools/list");
  const schema = snapshot.inputSchema as { properties: Record<string, unknown>; required?: string[] };
  assert.deepEqual(Object.keys(schema.properties).sort(), [
    "bbox",
    "ids",
    "maxHeight",
    "maxWidth",
    "near",
    "scale",
  ]);
  assert.deepEqual(schema.required ?? [], []);
  // The description is what makes the model reach for the tool at the right
  // moment, so the two cases it exists for are pinned here.
  assert.match(snapshot.description ?? "", /hand-drawn/);
  assert.match(snapshot.description ?? "", /overlap/);
});

test("acknowledge_mention takes id, keep, reply and status, and refuses anything else by name", async () => {
  const ack = tools.find((t) => t.name === "acknowledge_mention");
  assert.ok(ack, "acknowledge_mention is not in tools/list");
  const schema = ack.inputSchema as {
    properties: Record<string, { enum?: string[] }>;
    required?: string[];
    additionalProperties?: boolean;
  };
  assert.deepEqual(Object.keys(schema.properties).sort(), ["id", "keep", "reply", "status"]);
  assert.deepEqual(schema.properties.status.enum, ["out of scope", "see chat"]);
  assert.deepEqual(schema.required ?? [], ["id"]);
  // Strict, so `note` - the free-text status this tool took until 0.7.0 - is
  // refused by name rather than silently dropped.
  // https://github.com/bjcoombs/excalidraw-room-mcp/issues/77
  assert.equal(schema.additionalProperties, false);

  // The description is what the model reads before it picks the argument, so
  // it names the status and no longer names the argument that is gone.
  assert.match(ack.description ?? "", /status/);
  assert.ok(!/note/.test(ack.description ?? ""), ack.description);

  // Over stdio, both refusals come back as tool results the model can read,
  // not as protocol errors, and each names what it refused.
  const refusals = await use(async (client) => ({
    note: (await client.callTool({ name: "acknowledge_mention", arguments: { id: "m", note: "x" } })) as ToolResult,
    status: (await client.callTool({
      name: "acknowledge_mention",
      arguments: { id: "m", status: "declined" },
    })) as ToolResult,
  }));
  assert.equal(refusals.note.isError, true, resultText(refusals.note));
  assert.match(resultText(refusals.note), /note/);
  assert.equal(refusals.status.isError, true, resultText(refusals.status));
  assert.match(resultText(refusals.status), /status/);
});
