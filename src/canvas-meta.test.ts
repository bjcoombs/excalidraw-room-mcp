/**
 * A host renders the in-chat canvas for any tool whose `_meta.ui.resourceUri`
 * names the view - both in `tools/list` and on the result it hands back - so a
 * second tool carrying it is a second widget in the transcript. `show_room` is
 * the tool that renders the room; create_room and join_room answer with text.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/64
 *
 * Driven over stdio against the built server rather than read off the source,
 * because what a host sees is the wire, and the result half of the contract has
 * no representation in the registration at all. Nothing here needs the network:
 * `show_room` in a process that has joined nothing still answers, and
 * `join_room` with a link that is not one is refused before any socket opens.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** The tools that used to carry the canvas metadata, and the one that still does. */
const CANVAS_TOOL = "show_room";
const TEXT_TOOLS = ["create_room", "join_room"];

/** `_meta.ui.resourceUri`, whatever level it sits at, or undefined when there is none. */
function uiResourceUri(meta: unknown): unknown {
  if (!meta || typeof meta !== "object") return undefined;
  const ui = (meta as Record<string, unknown>).ui;
  if (!ui || typeof ui !== "object") return undefined;
  return (ui as Record<string, unknown>).resourceUri;
}

const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(here, "index.js")] });
const client = new Client({ name: "canvas-meta-test", version: "0" });
await client.connect(transport);

const listed = (await client.listTools()).tools as { name: string; _meta?: unknown }[];
const showRoomResult = (await client.callTool({ name: "show_room", arguments: {} })) as { _meta?: unknown };
// Not a collaboration link, so this is refused by the link parser: no network.
const joinResult = (await client.callTool({ name: "join_room", arguments: { link: "not-a-room-link" } })) as { _meta?: unknown };
await client.close();

test("only show_room carries _meta.ui in its registration and result", () => {
  const registered = new Map(listed.map((t) => [t.name, uiResourceUri(t._meta)]));
  const uri = registered.get(CANVAS_TOOL);
  assert.equal(typeof uri, "string", `${CANVAS_TOOL} should declare a canvas resource, got ${String(uri)}`);
  assert.ok(String(uri).startsWith("ui://"), `expected a ui:// resource, got ${String(uri)}`);
  for (const name of TEXT_TOOLS) {
    assert.ok(registered.has(name), `${name} is not registered`);
    assert.equal(registered.get(name), undefined, `${name} should not declare a canvas resource`);
  }
  // Every other tool leaves the canvas alone too.
  for (const [name, value] of registered) {
    if (name === CANVAS_TOOL) continue;
    assert.equal(value, undefined, `${name} should not declare a canvas resource`);
  }
  // And the result the host renders carries the same resource as the registration.
  assert.equal(uiResourceUri(showRoomResult._meta), uri);
  assert.equal(uiResourceUri(joinResult._meta), undefined);
});
