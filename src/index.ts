#!/usr/bin/env node
/**
 * MCP server exposing a live Excalidraw collaboration room over stdio.
 * Nothing is written to stdout except protocol frames; diagnostics go to
 * stderr when EXCALIDRAW_ROOM_DEBUG is set.
 */
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { buildElements, bump, measureText, summarise, type ElementSpec, type ExcalidrawElement } from "./elements.js";
import { LISTEN_TIP, SERVER_INSTRUCTIONS } from "./instructions.js";
import { DEFAULT_NEARBY_RADIUS, DEFAULT_TAG, findMentions, formatMention, nearbyElements, type HandledVersions } from "./mentions.js";
import { RoomClient } from "./room.js";
import { buildShowRoomPayload, CANVAS_RESOURCE_URI, NOT_IN_ROOM_TEXT, canvasHtmlUrl, registerCanvasResource } from "./view.js";

const room = new RoomClient();
/** Mentions already acted on, by element id -> version. Reset on join. */
let handledMentions: HandledVersions = new Map();
room.on("joined", () => {
  handledMentions = new Map();
});

const point = z.tuple([z.number(), z.number()]);

const elementSpec = z
  .object({
    type: z.enum(["rectangle", "ellipse", "diamond", "text", "arrow", "line", "freedraw"]),
    id: z.string().optional().describe("Optional id. Random if omitted. Use to reference the element from a later spec."),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    text: z.string().optional().describe("Content of a text element."),
    label: z.string().optional().describe("Text bound inside a shape or on an arrow."),
    fontSize: z.number().optional(),
    points: z.array(point).optional().describe("Absolute [x,y] points for arrow, line or freedraw."),
    start: z.string().optional().describe("Id of the element an arrow or line starts at."),
    end: z.string().optional().describe("Id of the element an arrow or line ends at."),
    strokeColor: z.string().optional(),
    backgroundColor: z.string().optional(),
    strokeWidth: z.number().optional(),
    strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
    fillStyle: z.enum(["solid", "hachure", "cross-hatch", "zigzag"]).optional(),
    rounded: z.boolean().optional(),
    startArrowhead: z.string().nullable().optional(),
    endArrowhead: z.string().nullable().optional(),
    roughness: z.number().optional(),
    opacity: z.number().optional(),
  })
  .strict();

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

/** A refusal the host can show as-is; hosts render isError results as text. */
function errorText(s: string) {
  return { ...text(s), isError: true };
}

/** Binds a tool to the in-chat canvas. Hosts without MCP Apps ignore it. */
const CANVAS_META = { ui: { resourceUri: CANVAS_RESOURCE_URI } } as const;

function statusText(): string {
  const s = room.status();
  const peers = s.peers.length
    ? s.peers.map((p) => p.username ?? p.socketId).join(", ")
    : "none";
  return [
    `connected: ${s.connected}`,
    `room: ${s.link ?? "-"}`,
    `peers: ${peers}`,
    `elements: ${s.elementCount} (${s.deletedCount} deleted)`,
    `sceneVersion: ${s.sceneVersion}`,
    `initial scene from: ${s.source ?? "-"}`,
    `last remote update: ${s.lastRemoteUpdate ?? "-"}`,
  ].join("\n");
}

const server = new McpServer(
  { name: "excalidraw-room-mcp", version: "0.2.0" },
  { instructions: SERVER_INSTRUCTIONS },
);

registerAppTool(
  server,
  "create_room",
  {
    _meta: CANVAS_META,
    description:
      "Create a new empty live-collaboration room, join it, and return the excalidraw.com link for a person to open. The link contains the encryption key; share it only with people who should see the drawing.",
    inputSchema: {},
  },
  async () => {
    const link = await RoomClient.createLink();
    await room.join(link, { initTimeoutMs: 1500 });
    return text(`${link}\n\n${statusText()}\n\n${LISTEN_TIP}`);
  },
);

registerAppTool(
  server,
  "join_room",
  {
    _meta: CANVAS_META,
    description:
      "Join an existing excalidraw.com live-collaboration room from its link (the URL with #room=<id>,<key>). Loads the current scene from a connected peer, or from the room's persisted copy if nobody else is present.",
    inputSchema: {
      link: z.string().describe("Collaboration link, e.g. https://excalidraw.com/#room=abc...,key..."),
      serverUrl: z.string().optional().describe("Relay URL. Defaults to excalidraw.com's public relay."),
      origin: z.string().optional().describe("Origin header to present to the relay. Defaults to https://excalidraw.com, which the public relay requires."),
    },
  },
  async ({ link, serverUrl, origin }) => {
    await room.join(link, { serverUrl, origin });
    return text(`${statusText()}\n\n${LISTEN_TIP}`);
  },
);

registerAppTool(
  server,
  "show_room",
  {
    _meta: CANVAS_META,
    description:
      "Render the current room as a canvas in the chat, and return it as JSON: the room link, connection state, peers, the full element array, and the pending @claude mentions with the ids of the elements around each. Call it any time to bring the view back without rejoining.",
    inputSchema: {
      tag: z.string().default(DEFAULT_TAG),
      radius: z.number().min(0).default(DEFAULT_NEARBY_RADIUS).describe("How far around each mention to look for related elements, in canvas px."),
    },
  },
  async ({ tag, radius }) => {
    if (!room.isConnected) return errorText(NOT_IN_ROOM_TEXT);
    const elements = room.getElements();
    const pending = findMentions(elements, tag, handledMentions);
    return text(JSON.stringify(buildShowRoomPayload(room.status(), elements, pending, radius)));
  },
);

registerCanvasResource(server, canvasHtmlUrl());

server.registerTool(
  "room_status",
  { description: "Connection state, peers, and scene counters for the current room.", inputSchema: {} },
  async () => text(statusText()),
);

server.registerTool(
  "read_scene",
  {
    description:
      "Read the current drawing. 'summary' gives one line per element with position, size, text, and a sampled path for freehand strokes. 'json' returns the full Excalidraw element array.",
    inputSchema: {
      format: z.enum(["summary", "json"]).default("summary"),
      includeDeleted: z.boolean().default(false),
    },
  },
  async ({ format, includeDeleted }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const elements = room.getElements(includeDeleted);
    if (format === "json") return text(JSON.stringify(elements, null, 2));
    return text(elements.length ? summarise(elements) : "(empty scene)");
  },
);

server.registerTool(
  "add_elements",
  {
    description:
      "Add elements to the drawing from compact specs. Shapes take x, y, width, height and an optional label. Arrows take start/end element ids (edges are computed) or absolute points. Later specs may reference ids of earlier specs in the same call.",
    inputSchema: { elements: z.array(elementSpec).min(1) },
  },
  async ({ elements }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const existing = new Map(room.getElements(true).map((e) => [e.id, e]));
    const { created, updated } = buildElements(elements as ElementSpec[], {
      existing,
      lastIndex: room.lastIndex(),
    });
    const result = await room.commit([...created, ...updated]);
    const ids = created.map((e) => `${e.id} ${e.type}`).join("\n");
    return text(`added ${created.length} element(s)${result.persisted ? "" : ` (not persisted: ${result.error})`}\n${ids}`);
  },
);

server.registerTool(
  "add_raw_elements",
  {
    description:
      "Add complete Excalidraw elements verbatim (the JSON shape from an .excalidraw file). Missing version fields are filled in; fractional indices are assigned if absent.",
    inputSchema: { elements: z.array(z.record(z.unknown())).min(1) },
  },
  async ({ elements }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const { generateKeyBetween } = await import("fractional-indexing");
    let last = room.lastIndex();
    const prepared: ExcalidrawElement[] = [];
    for (const raw of elements as Record<string, unknown>[]) {
      const el = {
        version: 1,
        versionNonce: Math.floor(Math.random() * 2 ** 31),
        isDeleted: false,
        updated: Date.now(),
        boundElements: null,
        ...raw,
      } as unknown as ExcalidrawElement;
      if (!el.id) el.id = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
      if (!el.index) {
        last = generateKeyBetween(last, null);
        el.index = last;
      }
      prepared.push(el);
    }
    const result = await room.commit(prepared);
    return text(`added ${prepared.length} element(s)${result.persisted ? "" : ` (not persisted: ${result.error})`}\n${prepared.map((e) => `${e.id} ${e.type}`).join("\n")}`);
  },
);

server.registerTool(
  "update_elements",
  {
    description:
      "Patch existing elements by id. 'set' is merged over the element; version and nonce are bumped. Changing 'text' or 'fontSize' on a text element re-measures it unless width/height are given.",
    inputSchema: {
      updates: z.array(z.object({ id: z.string(), set: z.record(z.unknown()) })).min(1),
    },
  },
  async ({ updates }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const changed: ExcalidrawElement[] = [];
    const missing: string[] = [];
    for (const { id, set } of updates) {
      const current = room.getElement(id);
      if (!current) {
        missing.push(id);
        continue;
      }
      let next = { ...current, ...set, id: current.id } as ExcalidrawElement;
      if (next.type === "text" && ("text" in set || "fontSize" in set) && !("width" in set) && !("height" in set)) {
        const m = measureText(String(next.text ?? ""), Number(next.fontSize ?? 20));
        next = { ...next, width: m.width, height: m.height, originalText: next.text };
      }
      changed.push(bump(next));
    }
    if (!changed.length) return text(`no elements updated; unknown ids: ${missing.join(", ")}`);
    const result = await room.commit(changed);
    const note = missing.length ? `\nunknown ids: ${missing.join(", ")}` : "";
    return text(`updated ${changed.length} element(s)${result.persisted ? "" : ` (not persisted: ${result.error})`}${note}`);
  },
);

server.registerTool(
  "delete_elements",
  {
    description: "Soft-delete elements by id (Excalidraw keeps tombstones so peers converge).",
    inputSchema: { ids: z.array(z.string()).min(1) },
  },
  async ({ ids }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const changed: ExcalidrawElement[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const current = room.getElement(id);
      if (!current) missing.push(id);
      else if (!current.isDeleted) changed.push(bump({ ...current, isDeleted: true }));
    }
    if (!changed.length) return text(`nothing deleted; unknown ids: ${missing.join(", ")}`);
    const result = await room.commit(changed);
    const note = missing.length ? `\nunknown ids: ${missing.join(", ")}` : "";
    return text(`deleted ${changed.length} element(s)${result.persisted ? "" : ` (not persisted: ${result.error})`}${note}`);
  },
);

server.registerTool(
  "wait_for_mention",
  {
    description:
      "Block until someone writes a text element containing the tag (default '@claude') on the canvas, then return it with the elements around it. Returns 'no mention' after timeoutSeconds so the caller can loop. A mention is reported once it has stopped changing for about 1.5s; acknowledge it with acknowledge_mention when done, or it will be returned again.",
    inputSchema: {
      tag: z.string().default(DEFAULT_TAG),
      timeoutSeconds: z.number().min(1).max(600).default(60),
      radius: z.number().min(0).default(250).describe("How far around the mention to look for related elements, in canvas px."),
    },
  },
  async ({ tag, timeoutSeconds, radius }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const mention = await room.waitForMention(tag, handledMentions, { timeoutMs: timeoutSeconds * 1000 });
    if (!mention) return text(`no mention of ${tag} within ${timeoutSeconds}s`);
    return text(formatMention(mention, nearbyElements(room.getElements(), mention, radius)));
  },
);

server.registerTool(
  "list_mentions",
  {
    description: "List every pending (unacknowledged) mention of the tag on the canvas right now, each with its nearby elements.",
    inputSchema: {
      tag: z.string().default(DEFAULT_TAG),
      radius: z.number().min(0).default(250),
    },
  },
  async ({ tag, radius }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const all = room.getElements();
    const pending = findMentions(all, tag, handledMentions);
    if (!pending.length) return text(`no pending mentions of ${tag}`);
    return text(pending.map((m) => formatMention(m, nearbyElements(all, m, radius))).join("\n\n---\n\n"));
  },
);

server.registerTool(
  "acknowledge_mention",
  {
    description:
      "Mark a mention as handled so it is not returned again, and show that on the canvas: the text turns grey and gets a check mark appended (or a note of your choosing, e.g. why it was declined). If the person edits the text again it becomes pending again.",
    inputSchema: {
      id: z.string().describe("The mention's element id from wait_for_mention or list_mentions."),
      note: z.string().optional().describe("Appended to the text instead of the default check mark."),
      keepText: z.boolean().default(false).describe("Only recolour; leave the text unchanged."),
    },
  },
  async ({ id, note, keepText }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const current = room.getElement(id);
    if (!current || current.type !== "text") return text(`no text element with id ${id}`);
    const suffix = keepText ? "" : ` ${note ?? "✓"}`;
    const nextText = `${current.text ?? ""}${suffix}`;
    const m = measureText(nextText, Number(current.fontSize ?? 20));
    const updated = bump({
      ...current,
      text: nextText,
      originalText: nextText,
      width: current.autoResize === false ? current.width : m.width,
      height: m.height,
      strokeColor: "#868e96",
    } as ExcalidrawElement);
    const result = await room.commit([updated]);
    handledMentions.set(id, updated.version);
    return text(`acknowledged ${id}${result.persisted ? "" : ` (not persisted: ${result.error})`}`);
  },
);

server.registerTool(
  "leave_room",
  { description: "Disconnect from the current room.", inputSchema: {} },
  async () => {
    room.leave();
    return text("left room");
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
