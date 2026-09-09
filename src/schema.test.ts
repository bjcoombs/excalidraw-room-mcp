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

type Tool = { name: string; inputSchema: unknown };

/** One `tools/list` round trip against the built server over stdio. */
async function listTools(): Promise<Tool[]> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "index.js")],
  });
  const client = new Client({ name: "schema-test", version: "0" });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools as Tool[];
  } finally {
    await client.close();
  }
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
