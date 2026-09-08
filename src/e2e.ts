/**
 * Manual end-to-end driver. Spawns the server as an MCP client would, creates
 * a room, seeds three elements, then polls the scene so a person can open the
 * printed link, draw, and watch the stroke arrive here.
 *
 *   npm run build && node dist/e2e.js [link] [seconds]
 *
 * With a link it joins that room instead of creating one.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const link = args.find((a) => a.includes("#room="));
const seconds = Number(args.find((a) => /^\d+$/.test(a)) ?? 120);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(here, "index.js")],
  env: { ...process.env, EXCALIDRAW_ROOM_DEBUG: "1" },
  stderr: "inherit",
});
const client = new Client({ name: "e2e", version: "0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const res = await client.callTool({ name, arguments: args });
  const content = (res.content as { type: string; text?: string }[]) ?? [];
  return content.map((c) => c.text ?? "").join("\n");
};

console.log("tools:", (await client.listTools()).tools.map((t) => t.name).join(", "));
if (link) {
  console.log("--- join_room");
  console.log(await call("join_room", { link }));
  console.log("--- read_scene (before)");
  console.log(await call("read_scene"));
} else {
  console.log("--- create_room");
  console.log(await call("create_room"));
}

// Unique ids per run so the driver can be pointed at a room more than once.
const run = Date.now().toString(36);
const api = `api-${run}`;
const db = `db-${run}`;
console.log("--- add_elements");
console.log(
  await call("add_elements", {
    elements: [
      { type: "rectangle", id: api, x: 100, y: 100, width: 180, height: 90, label: "API", backgroundColor: "#a5d8ff" },
      { type: "ellipse", id: db, x: 500, y: 100, width: 180, height: 90, label: "Postgres", backgroundColor: "#b2f2bb" },
      { type: "arrow", id: `${api}-${db}`, start: api, end: db, label: "query" },
    ],
  }),
);

let lastSummary = "";
const deadline = Date.now() + seconds * 1000;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 4000));
  const status = await call("room_status");
  const summary = await call("read_scene");
  if (summary !== lastSummary) {
    console.log(`--- ${new Date().toISOString()} scene changed`);
    console.log(status);
    console.log(summary);
    lastSummary = summary;
  }
}
console.log("--- final json element count:", JSON.parse(await call("read_scene", { format: "json" })).length);
await client.close();
process.exit(0);
