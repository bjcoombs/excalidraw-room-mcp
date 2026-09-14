import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import assert from "node:assert/strict";
import test from "node:test";
import { PRE_JOIN_TOOLS, STAGED_TOOLS_ENV, stagedToolsEnabled, ToolStage, type ToolHandle } from "./staged.js";

/** A registered tool that records what staging did to it, in order. */
function fakeTool(): ToolHandle & { calls: string[] } {
  const calls: string[] = [];
  return { calls, enable: () => calls.push("enable"), disable: () => calls.push("disable") };
}

function stage(staged: boolean, count = 3) {
  const tools = Array.from({ length: count }, fakeTool);
  return { tools, stage: new ToolStage(tools, staged) };
}

test("the pre-join set is the four tools that work outside a room", () => {
  assert.deepEqual([...PRE_JOIN_TOOLS], ["room_create", "room_join", "room_status", "room_help"]);
});

test("staging is off unless the variable is set to something other than 0", () => {
  assert.equal(stagedToolsEnabled({}), false);
  assert.equal(stagedToolsEnabled({ [STAGED_TOOLS_ENV]: "" }), false, "empty turns it off without unsetting it");
  assert.equal(stagedToolsEnabled({ [STAGED_TOOLS_ENV]: "0" }), false);
  assert.equal(stagedToolsEnabled({ [STAGED_TOOLS_ENV]: "1" }), true);
  assert.equal(stagedToolsEnabled({ [STAGED_TOOLS_ENV]: "true" }), true);
});

test("a staged stage withholds every gated tool and reveals them all on a join", () => {
  const { tools, stage: s } = stage(true);

  assert.equal(s.isRevealed, true, "the SDK registers tools enabled, which is where staging starts");
  assert.equal(s.withhold(), true, "start-up withholds them");
  assert.equal(s.isRevealed, false);
  for (const tool of tools) assert.deepEqual(tool.calls, ["disable"]);

  assert.equal(s.reveal(), true, "a successful create or join hands them back");
  assert.equal(s.isRevealed, true);
  for (const tool of tools) assert.deepEqual(tool.calls, ["disable", "enable"]);

  assert.equal(s.withhold(), true, "room_leave withholds them again");
  for (const tool of tools) assert.deepEqual(tool.calls, ["disable", "enable", "disable"]);
});

test("a transition to the state already held changes nothing, so no host is told the list moved", () => {
  const { tools, stage: s } = stage(true);
  s.withhold();

  assert.equal(s.withhold(), false, "room_leave outside a room");
  assert.equal(s.isRevealed, false);
  for (const tool of tools) assert.deepEqual(tool.calls, ["disable"], "and no second disable is sent");

  s.reveal();
  assert.equal(s.reveal(), false, "a second room_join inside a room");
  for (const tool of tools) assert.deepEqual(tool.calls, ["disable", "enable"]);
});

test("without the flag nothing is ever enabled or disabled, so the full list stands from the start", () => {
  const { tools, stage: s } = stage(false);

  assert.equal(s.withhold(), false);
  assert.equal(s.reveal(), false);
  assert.equal(s.withhold(), false);
  assert.equal(s.isRevealed, true, "the tools stay as the SDK registered them");
  for (const tool of tools) assert.deepEqual(tool.calls, []);
});

test("a stage over no gated tools is still a stage, and the array it was given is copied", () => {
  const tools = [fakeTool()];
  const s = new ToolStage(tools, true);
  tools.push(fakeTool()); // pushed after construction: not staged
  assert.equal(s.withhold(), true);
  assert.deepEqual(tools[0].calls, ["disable"]);
  assert.deepEqual(tools[1].calls, []);
});

/**
 * The transition against real registered tools and a real client, over an
 * in-memory transport pair. `room_create` and `room_join` reach the public
 * relay, so the join itself is not driven here - this is what the SDK does
 * with the enable and disable calls a join would make.
 */
test("a revealed stage puts the gated tools in tools/list and tells the client the list moved", async () => {
  const server = new McpServer(
    { name: "staged-test", version: "0" },
    { capabilities: { tools: { listChanged: true } } },
  );
  const empty = async () => ({ content: [] });
  server.registerTool("room_join", { description: "pre-join", inputSchema: {} }, empty);
  const gated = [
    server.registerTool("scene_read", { description: "gated", inputSchema: {} }, empty),
    server.registerTool("mention_wait", { description: "gated", inputSchema: {} }, empty),
  ];
  const s = new ToolStage(gated, true);
  s.withhold(); // before connect, as the server does at start-up

  let listChanged = 0;
  const client = new Client({ name: "staged-test", version: "0" });
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged += 1;
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const names = async () => (await client.listTools()).tools.map((t) => t.name).sort();

  try {
    assert.deepEqual(await names(), ["room_join"], "the staged list is what the client connects to");
    assert.equal(listChanged, 0, "and it was reached without a notification");
    assert.deepEqual(client.getServerCapabilities()?.tools, { listChanged: true });

    s.reveal();
    await settled();
    assert.deepEqual(await names(), ["mention_wait", "room_join", "scene_read"]);
    assert.ok(listChanged > 0, "the client was told the list moved");

    const afterJoin = listChanged;
    s.withhold();
    await settled();
    assert.deepEqual(await names(), ["room_join"], "room_leave withholds them again");
    assert.ok(listChanged > afterJoin, "and the client was told again");
  } finally {
    await client.close();
    await server.close();
  }
});

/** Let the notifications the transport is carrying arrive. */
async function settled(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
