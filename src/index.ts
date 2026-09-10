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
import {
  AnnouncementClaims,
  DEFAULT_NEARBY_RADIUS,
  DEFAULT_TAG,
  findMentions,
  formatMention,
  markAcknowledged,
  markRemoved,
  markSeen,
  MAX_NOTE_LENGTH,
  nearbyElements,
  noteSchema,
  withScopeRule,
  type HandledVersions,
  type Mention,
} from "./mentions.js";
import { openRoom } from "./open.js";
import { buildPollPayload, pollText } from "./poll.js";
import { RoomClient } from "./room.js";
import { selectElements, unknownIdsText } from "./scene.js";
import { DEFAULT_MAX_DIMENSION, MAX_SCALE, snapshotScene } from "./snapshot.js";
import {
  buildShowRoomPayload,
  CANVAS_RESOURCE_URI,
  NOT_IN_ROOM_TEXT,
  canvasHtmlUrl,
  ensureJoined,
  registerCanvasResource,
  summariseShowRoom,
} from "./view.js";
import { PACKAGE_VERSION } from "./version.js";

// The `install-agent` subcommand copies the bundled canvas-listener subagent
// into a .claude/agents directory and exits. With no argv the MCP server starts
// exactly as before, and nothing but protocol frames reaches stdout.
if (process.argv[2] === "install-agent") {
  const { runInstallAgentCli } = await import("./install-agent.js");
  process.exit(await runInstallAgentCli(process.argv.slice(3)));
}

const room = new RoomClient();
/**
 * Mentions already surfaced to an agent, by element id -> version. Reset on
 * join. This is what stops wait_for_mention returning the same note twice in a
 * row; it is deliberately not what "pending" means.
 */
let handledMentions: HandledVersions = new Map();
/**
 * Mentions an agent has answered, by element id -> version. Reset on join.
 *
 * Pending means unacknowledged, not unseen. A note an agent has looked at but
 * not acted on is still an open request: the canvas widget has to be able to
 * announce it, list_mentions has to be able to show it again, and poll_room
 * has to keep reporting it. Only acknowledge_mention closes a mention.
 */
let acknowledgedMentions: HandledVersions = new Map();
/** Which mentions a widget has already announced into the chat. Reset on join. */
const announcementClaims = new AnnouncementClaims();
room.on("joined", () => {
  handledMentions = new Map();
  acknowledgedMentions = new Map();
  announcementClaims.reset();
});

/** Every mention of `tag` that has not been acknowledged, seen or not. */
function pendingMentions(tag: string, elements = room.getElements()): Mention[] {
  return findMentions(elements, tag, acknowledgedMentions);
}

/** Which of these mentions a widget has already announced. */
function announcedIds(mentions: readonly Mention[]): Set<string> {
  return new Set(mentions.filter((m) => announcementClaims.has(m.id)).map((m) => m.id));
}

/**
 * Commit the "seen" state for a mention the moment it is surfaced, so the
 * person who wrote it gets an immediate signal without an agent round trip.
 * The post-bump version goes into handledMentions: our own edit must not read
 * back as a new mention, while a later human edit (a higher version still)
 * re-pends it and the next seen pass rewrites the marker.
 *
 * Only the exact version the tool returned is marked. list_mentions commits
 * one mention at a time, so a person can edit a later one while an earlier
 * commit is in flight; marking that newer text would record a version the
 * caller never saw and swallow the edit. Leave it pending instead.
 *
 * The version is recorded either way. The broadcast has already gone out and
 * the local element already carries the marker, so treating a failed persist
 * as unhandled would return the same mention on every poll. A failure is
 * reported on the debug channel instead; it is not the caller's to act on.
 */
async function commitSeen(mention: Mention): Promise<void> {
  const current = room.getElement(mention.id);
  if (!current || current.type !== "text") return;
  if (current.version !== mention.version) return;
  const updated = markSeen(current);
  if (!updated) return;
  const result = await room.commit([updated]);
  handledMentions.set(mention.id, updated.version);
  if (!result.persisted && process.env.EXCALIDRAW_ROOM_DEBUG) {
    console.error("[mentions] seen state for", mention.id, "not persisted:", result.error);
  }
}

const autoSeenSchema = z
  .boolean()
  .default(true)
  .describe("Mark the mention seen on the canvas (amber stroke plus a marker) as soon as it is returned. Set false for silent polling.");

/**
 * An [x, y] pair. Deliberately an array-with-length rather than a zod tuple:
 * a tuple emits draft-07 tuple-form `items` (an array of per-position
 * schemas), which the Anthropic API rejects, taking the whole tool list with
 * it. `.length(2)` still rejects anything but exactly two numbers at runtime.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/28
 */
const point = z
  .array(z.number())
  .length(2)
  .describe("An [x, y] pair.");

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
    link: z.string().optional().describe("URL the element links to. Excalidraw shows a link icon on it; defaults to no link."),
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

/**
 * Binds a tool to the in-chat canvas. Hosts without MCP Apps ignore it.
 *
 * `show_room` alone carries it. create_room and join_room used to as well, and
 * a host renders one widget per result that does, so asking for a room drew a
 * canvas before there was anything on it and a second one the moment the model
 * called show_room. Their results are text; the canvas is what show_room is
 * for.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/64
 */
const CANVAS_META = { ui: { resourceUri: CANVAS_RESOURCE_URI } } as const;

/** A result the host should render the canvas for: show_room's, and only its. */
function canvasResult(s: string, isError = false) {
  return { ...text(s), _meta: CANVAS_META, ...(isError ? { isError: true } : {}) };
}

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
  { name: "excalidraw-room-mcp", version: PACKAGE_VERSION },
  { instructions: SERVER_INSTRUCTIONS },
);

// Plain registerTool, not registerAppTool: the canvas metadata is what
// registerAppTool is for, and this result is text. See CANVAS_META above.
server.registerTool(
  "create_room",
  {
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

server.registerTool(
  "join_room",
  {
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
      "Render the current room as a canvas in the chat. Returns a short summary as text - the room link, connection state, peer and element counts, and the pending @claude mentions with the ids of the elements around each. The canvas view fetches the elements for itself, so they never pass through this result unless you ask: pass include: \"json\" only if you need the element array in the text; read_scene with ids or near is the cheaper way to inspect elements. Pass link only to point this server at a room it is not in; without it the current room is used, which is what you want. The in-chat view depends on the host; prefer open_room to watch the canvas.",
    inputSchema: {
      tag: z.string().default(DEFAULT_TAG),
      link: z
        .string()
        .optional()
        .describe(
          "Collaboration link to join first if this server is in no room, or in a different one. The canvas view sends the link it was shown, because some hosts route the view's calls to a second server process that has joined nothing. Leave it unset: the model's own calls should use the room already joined.",
        ),
      radius: z.number().min(0).default(DEFAULT_NEARBY_RADIUS).describe("How far around each mention to look for related elements, in canvas px."),
      include: z
        .enum(["summary", "json"])
        .default("summary")
        .describe("What the text content carries. 'summary' (default) is a few lines; 'json' is the whole payload, which for a 35-element scene is roughly 10k tokens. The canvas view asks for 'json' itself, so the default keeps the elements out of the conversation."),
    },
  },
  async ({ tag, radius, include, link }) => {
    // A link joins this process to the room before anything is read, so a view
    // whose calls the host routed to a second process is not stuck reporting
    // NOT_IN_ROOM_TEXT forever. See ensureJoined in view.ts.
    const { error } = await ensureJoined(room, link);
    if (!room.isConnected) return canvasResult(error ? `${NOT_IN_ROOM_TEXT}\n${error}` : NOT_IN_ROOM_TEXT, true);
    const elements = room.getElements();
    const pending = pendingMentions(tag, elements);
    const payload = buildShowRoomPayload(room.status(), elements, pending, radius, announcedIds(pending));
    // Text only, deliberately: a host that inlines structuredContent into the
    // model-visible transcript charges the reader for the element array on
    // every call, which is what a split payload was meant to avoid. The view
    // calls this tool itself with include: "json" and reads the text.
    return canvasResult(include === "json" ? JSON.stringify(payload) : summariseShowRoom(payload));
  },
);

registerCanvasResource(server, canvasHtmlUrl());

server.registerTool(
  "open_room",
  {
    description:
      "Open the room on excalidraw.com in the default browser; the primary way for a person to watch the canvas live. Returns the link, the connection state, and the peer and element counts. Pass link only to open a room this server is not in - it is joined first; without it the current room is used.",
    inputSchema: {
      link: z
        .string()
        .optional()
        .describe("Collaboration link to join before opening, if this server is in no room or in a different one. Leave it unset to open the room already joined."),
    },
  },
  async ({ link }) => {
    const result = await openRoom(room, link);
    return result.isError ? errorText(result.text) : text(result.text);
  },
);

server.registerTool(
  "room_status",
  { description: "Connection state, peers, and scene counters for the current room.", inputSchema: {} },
  async () => text(statusText()),
);

server.registerTool(
  "read_scene",
  {
    description:
      "Read the current drawing. 'summary' gives one line per element with position, size, text, and a sampled path for freehand strokes. 'json' returns the full Excalidraw element array as compact JSON. Filter to keep the response small: 'ids' returns just those elements (unknown ids are named back), and 'near' returns one element plus everything within a radius of it.",
    inputSchema: {
      format: z.enum(["summary", "json"]).default("summary"),
      includeDeleted: z.boolean().default(false),
      ids: z.array(z.string()).min(1).optional().describe("Return only the elements with these ids."),
      near: z
        .object({
          id: z.string().describe("Element the neighbourhood is centred on."),
          radius: z.number().describe("How far beyond that element's bounding box to reach."),
        })
        .optional()
        .describe("Return the named element and everything within the radius of it."),
    },
  },
  async ({ format, includeDeleted, ids, near }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const { elements, unknownIds } = selectElements(room.getElements(includeDeleted), { ids, near });
    const body =
      format === "json"
        ? JSON.stringify(elements)
        : elements.length
          ? summarise(elements)
          : ids || near
            ? "(no matching elements)"
            : "(empty scene)";
    if (!unknownIds.length) return text(body);
    return { content: [...text(body).content, ...text(unknownIdsText(unknownIds)).content] };
  },
);

server.registerTool(
  "snapshot_scene",
  {
    description:
      "Render a region of the room to a PNG and see it. Use it whenever the drawing itself is the question: to read hand-drawn content (handwriting, sketched boxes, freehand arrows) that reaches you as point arrays and is otherwise unreadable, to answer \"what does this look like\", and after moving, spacing or grouping elements to check whether anything still overlaps and the groups read as intended. Select with ids, near (one element and its neighbourhood), or bbox; with no selector the whole scene is rendered. The text block after the image gives the bounding box in scene coordinates, the scale, the pixel size and the ids of the elements drawn, so you can map what you see back to read_scene ids and near queries. Shapes, lines, arrows, freehand strokes and text are drawn flat, without the hand-drawn wobble the canvas shows; images, frames and embeds are drawn as a labelled dashed box and named on a placeholders line.",
    inputSchema: {
      ids: z.array(z.string()).min(1).optional().describe("Render only the elements with these ids. A container's bound label travels with it."),
      near: z
        .string()
        .optional()
        .describe(`Element id to centre on: it and everything within ${DEFAULT_NEARBY_RADIUS} scene units of it are rendered.`),
      bbox: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number().positive(),
          height: z.number().positive(),
        })
        .optional()
        .describe("Region of scene space to render, and the elements that intersect it."),
      scale: z
        .number()
        .positive()
        .max(MAX_SCALE)
        .optional()
        .describe(`Pixels per scene unit, 1 by default and at most ${MAX_SCALE}. Raise it to read small handwriting.`),
      maxWidth: z
        .number()
        .positive()
        .optional()
        .describe(`Pixel ceiling for the width, ${DEFAULT_MAX_DIMENSION} by default. A wider render is downscaled and the text block says so.`),
      maxHeight: z
        .number()
        .positive()
        .optional()
        .describe(`Pixel ceiling for the height, ${DEFAULT_MAX_DIMENSION} by default. A taller render is downscaled and the text block says so.`),
    },
  },
  async ({ ids, near, bbox, scale, maxWidth, maxHeight }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const snapshot = await snapshotScene(room.getElements(), { ids, near, bbox, scale, maxWidth, maxHeight });
    if (!snapshot.png) return text(snapshot.text);
    return {
      content: [
        { type: "image" as const, data: Buffer.from(snapshot.png).toString("base64"), mimeType: "image/png" },
        { type: "text" as const, text: snapshot.text },
      ],
    };
  },
);

server.registerTool(
  "add_elements",
  {
    description:
      "Add elements to the drawing from compact specs. Shapes take x, y, width, height and an optional label. Arrows take start/end element ids (edges are computed) or absolute points. Any element may take a link (a URL), which makes it clickable on the canvas. Later specs may reference ids of earlier specs in the same call.",
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
      "Add complete Excalidraw elements verbatim (the JSON shape from an .excalidraw file). Missing version fields are filled in; fractional indices are assigned if absent. Hosts cap tool-argument size, so keep each call's arguments under the limit in README Limits (4 KB on Claude Desktop, 16 KB on Claude Code) and send a large scene as several batches; a later batch may reference ids from an earlier one.",
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
      "Patch existing elements by id. 'set' is merged over the element; version and nonce are bumped. 'set' accepts any element field, including link (a URL, or null to remove it). Changing 'text' or 'fontSize' on a text element re-measures it unless width/height are given.",
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
      "Block until someone writes a text element containing the tag (default '@claude') on the canvas, then return it with the elements around it. Returns 'no mention' after timeoutSeconds so the caller can loop. A mention is reported once it has stopped changing for about 1.5s. Returning it also marks it seen on the canvas (amber stroke and a marker) so the person knows the note landed; pass autoSeen false to poll without touching the drawing. Acknowledge it with acknowledge_mention when done, which removes the handled note from the canvas; reply about the work in chat.",
    inputSchema: {
      tag: z.string().default(DEFAULT_TAG),
      timeoutSeconds: z.number().min(1).max(600).default(60),
      radius: z.number().min(0).default(250).describe("How far around the mention to look for related elements, in canvas px."),
      autoSeen: autoSeenSchema,
    },
  },
  async ({ tag, timeoutSeconds, radius, autoSeen }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const mention = await room.waitForMention(tag, handledMentions, { timeoutMs: timeoutSeconds * 1000 });
    if (!mention) return text(`no mention of ${tag} within ${timeoutSeconds}s`);
    const out = formatMention(mention, nearbyElements(room.getElements(), mention, radius));
    if (autoSeen) await commitSeen(mention);
    return text(withScopeRule(out));
  },
);

server.registerTool(
  "list_mentions",
  {
    description: "List every pending (unacknowledged) mention of the tag on the canvas right now, each with its nearby elements. Mentions surfaced here are marked seen on the canvas as wait_for_mention does; pass autoSeen false to look without touching the drawing.",
    inputSchema: {
      tag: z.string().default(DEFAULT_TAG),
      radius: z.number().min(0).default(250),
      autoSeen: autoSeenSchema,
    },
  },
  async ({ tag, radius, autoSeen }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const all = room.getElements();
    const pending = pendingMentions(tag, all);
    if (!pending.length) return text(`no pending mentions of ${tag}`);
    const out = pending.map((m) => formatMention(m, nearbyElements(all, m, radius))).join("\n\n---\n\n");
    if (autoSeen) {
      for (const m of pending) await commitSeen(m);
    }
    return text(withScopeRule(out));
  },
);

server.registerTool(
  "acknowledge_mention",
  {
    description:
      "Mark a mention as handled so it is not returned again. By default the note is removed from the canvas (soft-deleted): the seen marker already told the person it landed and the drawing is the evidence it was done. Reply about the work in chat, not on the canvas - artefacts of the work belong on the canvas, prose about it does not. Pass a short note (up to " +
      `${MAX_NOTE_LENGTH} characters) to keep the note instead, greyed with that note as its only suffix, when the person has to read the outcome where they wrote the request ("declined", "see chat"). Pass keep true to keep it greyed with a check mark for an audit trail. If the person edits the text again it becomes pending again.`,
    inputSchema: {
      id: z.string().describe("The mention's element id from wait_for_mention or list_mentions."),
      note: noteSchema
        .optional()
        .describe(
          `Keep the note on the canvas with this as its only suffix, at most ${MAX_NOTE_LENGTH} characters. For a status the person must see there, not a reply: reply in chat instead.`,
        ),
      keep: z.boolean().default(false).describe("Keep the note on the canvas, greyed with a single check mark, instead of removing it."),
    },
  },
  async ({ id, note, keep }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const current = room.getElement(id);
    if (!current || current.type !== "text") return text(`no text element with id ${id}`);
    // A note or an explicit keep leaves the element in place; otherwise the
    // handled note goes. Either way the post-bump version is recorded, so our
    // own edit never reads back as a new mention.
    // An empty or blank note is no note: keeping it would leave a trailing
    // space as the whole status, which reads as a bug on the canvas. It falls
    // through to the default instead, so the note is removed unless keep says
    // otherwise.
    const status = note?.trim() || undefined;
    const kept = status !== undefined || keep;
    const updated = kept ? markAcknowledged(current, { note: status }) : markRemoved(current);
    const result = await room.commit([updated]);
    handledMentions.set(id, updated.version);
    acknowledgedMentions.set(id, updated.version);
    // The claim goes with it. If the person edits the note again it is a new
    // request, and a widget has to be free to announce it.
    announcementClaims.release([id]);
    const what = kept ? `acknowledged ${id}` : `acknowledged and removed ${id} from the canvas`;
    return text(`${what}${result.persisted ? "" : ` (not persisted: ${result.error})`}`);
  },
);

server.registerTool(
  "poll_room",
  {
    description:
      "Cheap state probe: connection state, sceneVersion, the peers, the pending mention ids and text, and whether the scene moved since a version you pass. Use it while you are working in a turn to notice a change without a full show_room; use wait_for_mention when you are handing the turn back to a person.",
    inputSchema: {
      sinceVersion: z.number().optional().describe("A sceneVersion from an earlier call. changedSince is false only if the scene version still equals it."),
      tag: z.string().default(DEFAULT_TAG),
    },
  },
  async ({ sinceVersion, tag }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const pending = pendingMentions(tag);
    return text(pollText(buildPollPayload({ status: room.status(), pending, announced: announcedIds(pending) }, sinceVersion)));
  },
);


server.registerTool(
  "claim_mention_announcement",
  {
    description:
      "For the in-chat canvas view, not for an agent to call. Claim the right to announce mentions into the chat: the first caller for an id gets it back in the result, later callers get nothing, so several open widgets against one server produce one message rather than several. Pass release true to give ids back after a failed announcement, which lets a later attempt win them. Claims are dropped when the mention is acknowledged and when the server joins a room.",
    inputSchema: {
      ids: z.array(z.string()).min(1).describe("Mention element ids, as poll_room and show_room report them."),
      release: z
        .boolean()
        .default(false)
        .describe("Give these ids back instead of claiming them. For a widget whose host refused the message."),
    },
  },
  async ({ ids, release }) => {
    const changed = release ? announcementClaims.release(ids) : announcementClaims.claim(ids);
    const verb = release ? "released" : "won";
    const header = `announcement claim: ${verb} ${changed.length} of ${ids.length}`;
    return text(changed.length ? `${header}\n${changed.join("\n")}` : header);
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
