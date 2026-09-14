/**
 * The staged tool list as a host sees it: `tools/list` over stdio against the
 * built server, with EXCALIDRAW_ROOM_STAGED_TOOLS set and without it.
 *
 * The join that reveals the rest of the list is not driven here. `room_create`
 * and `room_join` both open a socket to the public relay, and `npm test` makes
 * no network calls, so the transition itself is covered in `staged.test.ts`
 * against the enable/disable handles and only the two starting lists are
 * driven over the wire.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/109
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PRE_JOIN_TOOLS, STAGED_TOOLS_ENV } from "./staged.js";

const here = path.dirname(fileURLToPath(import.meta.url));

type Listing = { names: string[]; listChanged: number; capability: unknown; disabledCall: string };

/**
 * One connected client against the built server, started with `env` merged over
 * this process's own. Returns the tool names, how many `tools/list_changed`
 * notifications arrived, the server's declared tools capability, and what a
 * gated tool answers when it is called.
 */
async function listing(env: Record<string, string>): Promise<Listing> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, "index.js")],
    env: { ...process.env, ...env } as Record<string, string>,
  });
  const client = new Client({ name: "staged-stdio-test", version: "0" });
  let listChanged = 0;
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged += 1;
  });
  await client.connect(transport);
  try {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    const capability = client.getServerCapabilities()?.tools;
    const result = (await client.callTool({ name: "scene_read", arguments: {} })) as {
      content?: { text?: string }[];
    };
    const disabledCall = (result.content ?? []).map((c) => c.text ?? "").join("");
    return { names, listChanged, capability, disabledCall };
  } finally {
    await client.close();
  }
}

const staged = await listing({ [STAGED_TOOLS_ENV]: "1" });
const unstaged = await listing({ [STAGED_TOOLS_ENV]: "" });

test("staged: tools/list before a join names exactly the four tools that work outside a room", () => {
  assert.deepEqual(staged.names, [...PRE_JOIN_TOOLS].sort());
});

test("staged: a gated tool is refused by name rather than answering out of a room", () => {
  assert.match(staged.disabledCall, /scene_read disabled/);
});

test("unstaged: the full nineteen are listed from the start and nothing is withheld", () => {
  assert.equal(unstaged.names.length, 19, unstaged.names.join(", "));
  for (const name of PRE_JOIN_TOOLS) assert.ok(unstaged.names.includes(name), `${name} is missing`);
  for (const name of ["scene_read", "scene_translate", "mention_wait", "room_open", "room_leave"]) {
    assert.ok(unstaged.names.includes(name), `${name} is missing`);
  }
  assert.doesNotMatch(unstaged.disabledCall, /disabled/, unstaged.disabledCall);
});

test("neither list is reached by a notification: the starting list is staged before the transport connects", () => {
  assert.equal(staged.listChanged, 0);
  assert.equal(unstaged.listChanged, 0);
});

test("the server declares tools.listChanged, so a host knows the list can move under it", () => {
  assert.deepEqual(staged.capability, { listChanged: true });
  assert.deepEqual(unstaged.capability, { listChanged: true });
});
