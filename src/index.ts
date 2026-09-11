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
import {
  applyUpdate,
  buildElements,
  bump,
  elementAuthor,
  PERSON_AUTHOR,
  randomId,
  stampAuthor,
  summarise,
  type ElementSpec,
  type ExcalidrawElement,
} from "./elements.js";
import { forcedLine, protectedBy, refusalLines, type Refusal } from "./guard.js";
import { defaultHandle, isValidHandle, MAX_HANDLE_LENGTH } from "./handle.js";
import { LISTEN_TIP, SERVER_INSTRUCTIONS } from "./instructions.js";
import {
  agentReplyDepthLine,
  agentReplyDepthRefusal,
  agentReplyDepthSchema,
  answerSchema,
  buildAttributedLine,
  BROADCAST_TAG,
  chainOf,
  DEFAULT_AGENT_REPLY_DEPTH,
  DEFAULT_NEARBY_RADIUS,
  findAttributedLine,
  findHandledMentions,
  findMentions,
  formatMention,
  nearbyNeighbourhood,
  handledKey,
  markAcknowledged,
  markHandled,
  markRemoved,
  markSeen,
  acknowledgementText,
  planAcknowledgement,
  markAnswered,
  MAX_ANSWER_LENGTH,
  MAX_REPLY_LENGTH,
  MAX_AGENT_REPLY_DEPTH,
  MENTION_POLICY_HOSTING_RULE,
  MENTION_STATUSES,
  MentionPolicy,
  MIN_AGENT_REPLY_DEPTH,
  newGroupId,
  nextChain,
  policyLine,
  previousLine,
  scopeRuleFor,
  replySchema,
  resolveTags,
  statusSchema,
  visibleMentions,
  withGroup,
  withRequestPreamble,
  withScopeRule,
  type HandledNotes,
  type FormatMentionOptions,
  type Mention,
  type PreviousLine,
} from "./mentions.js";
import { openRoom } from "./open.js";
import {
  CLUSTER_CUSTOM_DATA_KEY,
  DEFAULT_GAP,
  SIDES,
  integralSize,
  nearRadius,
  place,
  placementLines,
  reservedElement,
  specSize,
  type PlacedSpec,
  type PlacementResult,
} from "./placement.js";
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
 * Mentions already surfaced to an agent, by element id -> the words they
 * carried, the server's markers stripped. Reset on join. This is what stops
 * wait_for_mention returning the same note twice in a row; it is deliberately
 * not what "pending" means.
 */
let handledMentions: HandledNotes = new Map();
/**
 * Mentions an agent has answered, by element id -> the words they carried,
 * keyed exactly as above. Reset on join.
 *
 * Pending means unacknowledged, not unseen. A note an agent has looked at but
 * not acted on is still an open request: the canvas widget has to be able to
 * announce it from its button, list_mentions has to be able to show it again, and poll_room
 * has to keep reporting it. Only acknowledge_mention closes a mention.
 */
let acknowledgedMentions: HandledNotes = new Map();
/**
 * Whether this session answers knowledge questions on the canvas. In memory
 * beside the two handled maps, off until a person asks for it in chat, and
 * reset by the same join that clears them: a permission granted for one room is
 * not a permission for the next.
 */
const mentionPolicy = new MentionPolicy();
room.on("joined", () => {
  handledMentions = new Map();
  acknowledgedMentions = new Map();
  mentionPolicy.reset();
});

/**
 * Every mention of any of `tags` that has not been acknowledged, seen or not,
 * as this agent should see it: another agent's note is dropped unless the
 * caller asked for it. Both the addressing (which tags) and the filtering
 * (which authors) are applied in one place, so `list_mentions`, `poll_room`,
 * `wait_for_mention` and `show_room` cannot disagree about what is pending.
 */
function pendingMentions(
  tags: readonly string[],
  elements = room.getElements(),
  answerAgentMentions = false,
): Mention[] {
  return visibleMentions(
    findMentions(elements, tags, acknowledgedMentions),
    room.handle,
    answerAgentMentions,
    room.agentReplyDepth,
  );
}

/** Every mention of any of `tags` this process has acknowledged and left on the canvas. */
function handledMentionsOnCanvas(
  tags: readonly string[],
  elements = room.getElements(),
  answerAgentMentions = false,
): Mention[] {
  return visibleMentions(
    findHandledMentions(elements, tags, acknowledgedMentions),
    room.handle,
    answerAgentMentions,
    room.agentReplyDepth,
  );
}

/**
 * What the agent last wrote under a mention, or null when the room holds no
 * attributed line for it. Read from the scene rather than remembered, so a
 * line written by an earlier process still shows up.
 */
function previousLineFor(id: string, elements = room.getElements()): PreviousLine | null {
  const line = findAttributedLine(elements, id);
  return line ? previousLine(line) : null;
}

/**
 * One mention rendered with its neighbourhood: the elements around it and the
 * hop markers saying why the far ones are there. Every mention block goes
 * through here so `read_scene near`, `snapshot_scene near` and the mention
 * tools all read the same neighbourhood.
 */
function mentionBlock(
  mention: Mention,
  elements: readonly ExcalidrawElement[],
  radius: number,
  opts: FormatMentionOptions = {},
): string {
  const { elements: nearby, reasons } = nearbyNeighbourhood(elements, mention, radius);
  return formatMention(mention, nearby, { ...opts, reasons });
}

/**
 * Commit the "seen" state for a mention the moment it is surfaced, so the
 * person who wrote it gets an immediate signal without an agent round trip.
 * The words the note carried go into handledMentions: our own marker must not
 * read back as a new mention, while a later human edit changes those words,
 * re-pends it and the next seen pass rewrites the marker.
 *
 * Only the words the tool returned are marked. list_mentions commits one
 * mention at a time, so a person can edit a later one while an earlier commit
 * is in flight; marking that newer text would record words the caller never
 * saw and swallow the edit. Leave it pending instead. A note somebody merely
 * dragged in the meantime still carries the words that were returned, so the
 * seen state lands on it as it should.
 *
 * The words are recorded either way. The broadcast has already gone out and
 * the local element already carries the marker, so treating a failed persist
 * as unhandled would return the same mention on every poll. A failure is
 * reported on the debug channel instead; it is not the caller's to act on.
 */
async function commitSeen(mention: Mention): Promise<void> {
  const current = room.getElement(mention.id);
  if (!current || current.type !== "text") return;
  if (handledKey(current) !== handledKey(mention)) return;
  const updated = markSeen(current);
  if (!updated) return;
  const result = await room.commit([updated]);
  markHandled(handledMentions, updated);
  if (!result.persisted && process.env.EXCALIDRAW_ROOM_DEBUG) {
    console.error("[mentions] seen state for", mention.id, "not persisted:", result.error);
  }
}

const autoSeenSchema = z
  .boolean()
  .default(true)
  .describe("Mark the mention seen on the canvas (amber stroke plus a marker) as soon as it is returned. Set false for silent polling.");

/**
 * The ownership guard's override. Off by default, so the safe behaviour is the
 * one an agent gets without thinking about it; the noisy path is the one it has
 * to ask for.
 */
const forceSchema = z
  .boolean()
  .default(false)
  .describe("Edit elements another agent in the room drew anyway. Without it those ids are skipped and reported as refused, so the agent still working on them keeps a true picture of the scene.");

/**
 * Splits requested ids into the ones this server may edit and the ones another
 * present agent owns. `force` keeps every id in `allowed` and still reports the
 * refusals, which is what lets the result text say whose work was written over.
 */
function guardIds(ids: readonly string[], force: boolean): { allowed: string[]; refusals: Refusal[] } {
  const present = room.agentHandles();
  const allowed: string[] = [];
  const refusals: Refusal[] = [];
  for (const id of ids) {
    const el = room.getElement(id);
    const owner = el ? protectedBy(el, present, room.handle) : null;
    if (owner === null) {
      allowed.push(id);
      continue;
    }
    refusals.push({ id, owner });
    if (force) allowed.push(id);
  }
  return { allowed, refusals };
}

/** The guard's report, appended to a result text: nothing when nothing was owned. */
function guardNote(refusals: readonly Refusal[], force: boolean): string {
  if (!refusals.length) return "";
  const lines = refusalLines(refusals);
  return force ? `\n${forcedLine(refusals)}\n${lines}` : `\n${lines}\npass force: true to edit them anyway`;
}

/**
 * No default, deliberately: the default is not a constant but this server's
 * own handle, which is only known once it is in a room. An explicit tag still
 * behaves exactly as it did.
 */
const tagSchema = z
  .string()
  .optional()
  .describe(
    `Text a note must contain to count as a mention. Omit it and this server answers to its own handle - "@<handle>", the handle room_status reports - and to "${BROADCAST_TAG}", the broadcast tag every agent in the room hears; matching is case-insensitive. Pass a tag to match that text alone, which is how you read notes addressed to someone else.`,
  );

/**
 * Off by default: two agents listening in one room would otherwise answer each
 * other's requests, and each other's answers, without either being asked.
 */
const answerAgentMentionsSchema = z
  .boolean()
  .default(false)
  .describe(
    "Also return notes written by another agent in the room. False by default: a note stamped with another agent's handle is dropped, while notes people wrote (nothing stamps them) and this server's own notes are always returned. True returns them all, each with the 'from: <handle>' line naming its author - up to the room's agentReplyDepth, which bounds how far a chain an agent started may run before this agent stops hearing it. A chain a person started is never bounded.",
  );

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

/**
 * Where to put the element, instead of where. Given `place`, the server finds
 * a free slot from the live scene and the caller's x and y are not read:
 * asking for a slot and naming coordinates are alternatives, and honouring
 * both would put the element somewhere neither asked for.
 */
const placeSchema = z
  .object({
    near: z.string().optional().describe("Id of the element to sit beside. The slot is the first free one on the chosen side."),
    cluster: z
      .string()
      .optional()
      .describe(
        "Id of an element whose cluster to join: its group, its frame, or the nodes already placed in it. The slot search fills the cluster's footprint before growing it, and the result says when the cluster no longer fits inside the room's neighbourhood radius.",
      ),
    side: z
      .enum(SIDES)
      .optional()
      .describe("Which side of the anchor to take, or 'auto' (the default) for the nearest free side."),
    gap: z.number().min(0).optional().describe(`Space left around the element, in canvas px. ${DEFAULT_GAP} by default.`),
    newCluster: z
      .boolean()
      .optional()
      .describe(
        "Start a separate cluster: the slot is more than the room's neighbourhood radius clear of the anchor's cluster, so a mention written on one does not pull in the other. Needs near.",
      ),
  })
  .strict()
  .optional()
  .describe("Let the server choose the coordinates. Given this, x and y are ignored.");

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
    place: placeSchema,
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

/**
 * The handle argument of create_room and join_room. Optional: absent means
 * the default derived from the os user.
 */
const handleSchema = z
  .string()
  .optional()
  .describe(
    `Name to appear as in the room: lowercase letters, digits and hyphens, 1 to ${MAX_HANDLE_LENGTH} characters. Made unique against the agents already in the room by appending -2, -3, and the result text states the handle taken. Defaults to ${defaultHandle()}.`,
  );

/**
 * The room's neighbourhood radius. One number decides how far a mention
 * reaches for context and how far apart placement keeps clusters, so it is
 * agreed once on join rather than passed per call.
 */
const nearbyRadiusSchema = z
  .number()
  .min(0)
  .optional()
  .describe(
    `How far a neighbourhood query reaches around a mention, in canvas px, and the distance placement keeps between clusters. ${DEFAULT_NEARBY_RADIUS} by default; room_status reports it, and list_mentions, wait_for_mention, show_room, read_scene near and snapshot_scene near use it when they are given no radius of their own.`,
  );

/**
 * The room's bound on agent-to-agent chains. A property of the room, like the
 * neighbourhood radius: the facilitator who sets the room up decides how much
 * agent-to-agent traffic their canvas carries, and no rebuild changes it.
 */
const roomReplyDepthSchema = agentReplyDepthSchema.describe(
  `How many agent replies deep a chain an agent started may run before this agent stops hearing it, ${MIN_AGENT_REPLY_DEPTH} to ${MAX_AGENT_REPLY_DEPTH}. ${DEFAULT_AGENT_REPLY_DEPTH} by default, so an agent may answer another agent once and the conversation goes on only if a person writes again; 0 means agent-started chains are never answered, even with answerAgentMentions on. A chain a person started is never bounded. This agent takes the bound at its own join and applies it to what it hears; it is not synchronised across the room, so two agents in one room may hold different bounds. room_status reports it as "agentReplyDepth: <n>".`,
);

/** A refusal naming the handle, or null when there is nothing to refuse. */
function handleRefusal(handle: string | undefined): string | null {
  if (handle === undefined || isValidHandle(handle)) return null;
  return `invalid handle ${JSON.stringify(handle)}: a handle is 1 to ${MAX_HANDLE_LENGTH} characters of lowercase letters, digits and hyphens`;
}

/**
 * The elements written by any of `handles`, or all of them when no filter was
 * given. `person` matches the elements carrying no author, which is what a
 * browser writes: a facilitator asking what the room drew and an agent asking
 * what it drew itself are the same question with a different handle.
 */
function filterByAuthor(elements: readonly ExcalidrawElement[], handles: string[] | undefined): ExcalidrawElement[] {
  if (!handles?.length) return [...elements];
  const wanted = new Set(handles);
  return elements.filter((el) => wanted.has(elementAuthor(el) ?? PERSON_AUTHOR));
}

function statusText(): string {
  const s = room.status();
  const peers = s.peers.length
    ? s.peers.map((p) => `${p.username ?? p.socketId} (${p.kind})`).join(", ")
    : "none";
  return [
    `connected: ${s.connected}`,
    `room: ${s.link ?? "-"}`,
    `handle: ${s.handle ?? "-"}`,
    `nearbyRadius: ${s.nearbyRadius}`,
    agentReplyDepthLine(s.agentReplyDepth),
    policyLine(mentionPolicy),
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
      "Create a new empty live-collaboration room, join it, and return the excalidraw.com link for a person to open. The link contains the encryption key; share it only with people who should see the drawing. The result states the handle this server took in the room.",
    inputSchema: { handle: handleSchema, nearbyRadius: nearbyRadiusSchema, agentReplyDepth: roomReplyDepthSchema },
  },
  async ({ handle, nearbyRadius, agentReplyDepth }) => {
    const refusal = handleRefusal(handle) ?? agentReplyDepthRefusal(agentReplyDepth);
    if (refusal) return errorText(refusal);
    const link = await RoomClient.createLink();
    await room.join(link, { initTimeoutMs: 1500, handle, nearbyRadius, agentReplyDepth });
    return text(`${link}\n\n${statusText()}\n\n${LISTEN_TIP}`);
  },
);

server.registerTool(
  "join_room",
  {
    description:
      "Join an existing excalidraw.com live-collaboration room from its link (the URL with #room=<id>,<key>). Loads the current scene from a connected peer, or from the room's persisted copy if nobody else is present. The result states the handle this server took in the room.",
    inputSchema: {
      link: z.string().describe("Collaboration link, e.g. https://excalidraw.com/#room=abc...,key..."),
      handle: handleSchema,
      nearbyRadius: nearbyRadiusSchema,
      agentReplyDepth: roomReplyDepthSchema,
      serverUrl: z.string().optional().describe("Relay URL. Defaults to excalidraw.com's public relay."),
      origin: z.string().optional().describe("Origin header to present to the relay. Defaults to https://excalidraw.com, which the public relay requires."),
    },
  },
  async ({ link, serverUrl, origin, handle, nearbyRadius, agentReplyDepth }) => {
    const refusal = handleRefusal(handle) ?? agentReplyDepthRefusal(agentReplyDepth);
    if (refusal) return errorText(refusal);
    await room.join(link, { serverUrl, origin, handle, nearbyRadius, agentReplyDepth });
    return text(`${statusText()}\n\n${LISTEN_TIP}`);
  },
);

registerAppTool(
  server,
  "show_room",
  {
    _meta: CANVAS_META,
    description:
      "Render the current room as a canvas in the chat. Returns a short summary as text - the room link, connection state, peer and element counts, and the pending mentions addressed to this agent with the ids of the elements around each. The canvas view fetches the elements for itself, so they never pass through this result unless you ask: pass include: \"json\" only if you need the element array in the text; read_scene with ids or near is the cheaper way to inspect elements. Pass link only to point this server at a room it is not in; without it the current room is used, which is what you want. The in-chat view depends on the host; prefer open_room to watch the canvas.",
    inputSchema: {
      tag: tagSchema,
      link: z
        .string()
        .optional()
        .describe(
          "Collaboration link to join first if this server is in no room, or in a different one. The canvas view sends the link it was shown, because some hosts route the view's calls to a second server process that has joined nothing. Leave it unset: the model's own calls should use the room already joined.",
        ),
      radius: z.number().min(0).optional().describe("How far around each mention to look for related elements, in canvas px. Defaults to the room's nearbyRadius."),
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
    const pending = pendingMentions(resolveTags(tag, room.handle), elements);
    const payload = buildShowRoomPayload(room.status(), elements, pending, nearRadius(room.nearbyRadius, radius));
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
  {
    description:
      "Connection state, the handle this server took in the room, the room's nearbyRadius and agentReplyDepth, the session's answerQuestions policy, the peers with their handles and whether each is an agent or a browser, and scene counters for the current room.",
    inputSchema: {},
  },
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
          radius: z.number().min(0).optional().describe("How far beyond that element's bounding box to reach. Defaults to the room's nearbyRadius."),
        })
        .optional()
        .describe("Return the named element and everything within the radius of it."),
      by: z
        .array(z.string())
        .min(1)
        .optional()
        .describe(
          `Return only elements written by these handles. "${PERSON_AUTHOR}" selects the elements nothing stamped, which is what a browser leaves, so by: ["${PERSON_AUTHOR}"] is what people in the room drew. Every summary line ends with "by <handle>" whether or not this is set.`,
        ),
    },
  },
  async ({ format, includeDeleted, ids, near, by }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const selected = selectElements(room.getElements(includeDeleted), {
      ids,
      near: near && { id: near.id, radius: nearRadius(room.nearbyRadius, near.radius) },
    });
    const { unknownIds } = selected;
    const elements = filterByAuthor(selected.elements, by);
    const body =
      format === "json"
        ? JSON.stringify(elements)
        : elements.length
          ? summarise(elements)
          : ids || near || by
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
        .describe("Element id to centre on: it and everything within the room's nearbyRadius of it are rendered."),
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
    const snapshot = await snapshotScene(room.getElements(), {
      ids,
      near,
      nearRadius: room.nearbyRadius,
      bbox,
      scale,
      maxWidth,
      maxHeight,
    });
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
      "Add elements to the drawing from compact specs. Shapes take x, y, width, height and an optional label. Arrows take start/end element ids (edges are computed) or absolute points. Any element may take a link (a URL), which makes it clickable on the canvas. Later specs may reference ids of earlier specs in the same call. Pass place instead of x and y to have the server find a free slot beside an element or inside a cluster, so two agents drawing at once never overlap; the result reports the coordinates it chose.",
    inputSchema: { elements: z.array(elementSpec).min(1) },
  },
  async ({ elements }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const specs = elements as PlacedSpec[];
    // Placement runs before anything is built, spec by spec: each slot is
    // found against the live scene plus the slots this call has already
    // taken, or two specs placed against one anchor would be sent to the
    // same free space.
    const placements: { id: string; result: PlacementResult }[] = [];
    const reserved: ExcalidrawElement[] = [];
    for (const spec of specs) {
      if (!spec.place) continue;
      // An id is assigned now rather than by the builder: the result names
      // the element whose coordinates it reports, and a cluster stamp has to
      // find the built element again.
      const id = spec.id ?? randomId();
      spec.id = id;
      const placed = place(spec.place, spec, {
        elements: [...room.getElements(), ...reserved],
        radius: room.nearbyRadius,
      });
      if (placed.refusal) return errorText(`${id}: ${placed.refusal}`);
      spec.x = placed.x;
      spec.y = placed.y;
      reserved.push(reservedElement(id, spec.type, placed.x, placed.y, integralSize(specSize(spec))));
      placements.push({ id, result: placed });
    }
    const existing = new Map(room.getElements(true).map((e) => [e.id, e]));
    const { created, updated } = buildElements(specs as ElementSpec[], {
      existing,
      lastIndex: room.lastIndex(),
    });
    const clustered = created.map((el) => {
      const key = placements.find((p) => p.id === el.id)?.result.clusterKey;
      if (key === undefined) return el;
      const current = el.customData as Record<string, unknown> | undefined;
      return { ...el, customData: { ...current, [CLUSTER_CUSTOM_DATA_KEY]: key } };
    });
    // Only the new elements are stamped, and after the cluster key is written
    // so both keys reach the canvas. `updated` are elements that were already
    // in the scene gaining a bound-element back reference, and whoever drew
    // them is still their author.
    const stamped = clustered.map((el) => stampAuthor(el, room.handle));
    const result = await room.commit([...stamped, ...updated]);
    const lines = [
      `added ${stamped.length} element(s)${result.persisted ? "" : ` (not persisted: ${result.error})`}`,
      ...stamped.map((e) => `${e.id} ${e.type}`),
      ...placements.flatMap(({ id, result: placed }) => placementLines(id, placed)),
    ];
    return text(lines.join("\n"));
  },
);

server.registerTool(
  "add_raw_elements",
  {
    description:
      "Add complete Excalidraw elements verbatim (the JSON shape from an .excalidraw file). Missing version fields are filled in; fractional indices are assigned if absent. An element carrying customData is stamped with this server's handle as its author, keeping the keys it came with; an element with no customData is left unattributed, so a scene imported from a file still reads as the work of whoever drew it. Hosts cap tool-argument size, so keep each call's arguments under the limit in README Limits (4 KB on Claude Desktop, 16 KB on Claude Code) and send a large scene as several batches; a later batch may reference ids from an earlier one.",
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
      // The verbatim path, and attribution follows that: an element carrying
      // customData of the caller's own is the caller's construction and is
      // stamped alongside its keys, while one carrying none is left exactly as
      // it arrived. That is what lets a scene imported from an .excalidraw
      // file, or a person's drawing replayed into a room, keep reading as a
      // person's work rather than being claimed by whoever pasted it.
      prepared.push(raw.customData === undefined ? el : stampAuthor(el, room.handle));
    }
    const result = await room.commit(prepared);
    return text(`added ${prepared.length} element(s)${result.persisted ? "" : ` (not persisted: ${result.error})`}\n${prepared.map((e) => `${e.id} ${e.type}`).join("\n")}`);
  },
);

server.registerTool(
  "update_elements",
  {
    description:
      "Patch existing elements by id. 'set' is merged over the element; version and nonce are bumped. 'set' accepts any element field, including link (a URL, or null to remove it). Changing 'text' or 'fontSize' on a text element re-measures it unless width/height are given, keeps originalText in step, and, for a label bound to a shape, re-centres it and grows the shape to fit so the canvas redraws the new label. An element another agent in the room drew is left alone and reported as refused unless force is true; a person's elements and those of an agent that has left are never guarded.",
    inputSchema: {
      updates: z.array(z.object({ id: z.string(), set: z.record(z.unknown()) })).min(1),
      force: forceSchema,
    },
  },
  async ({ updates, force }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const { allowed, refusals } = guardIds(updates.map((u) => u.id), force);
    const editable = new Set(allowed);
    const guard = guardNote(refusals, force);
    // Keyed by id: one update may also change the container its text is bound
    // to, and two updates in a batch may reach the same element.
    const changed = new Map<string, ExcalidrawElement>();
    const missing: string[] = [];
    let matched = 0;
    for (const { id, set } of updates) {
      if (!editable.has(id)) continue;
      const current = changed.get(id) ?? room.getElement(id);
      if (!current) {
        missing.push(id);
        continue;
      }
      matched++;
      for (const el of applyUpdate(current, set, (cid) => changed.get(cid) ?? room.getElement(cid))) {
        changed.set(el.id, el);
      }
    }
    const unknown = missing.length ? `; unknown ids: ${missing.join(", ")}` : "";
    if (!matched) return text(`no elements updated${unknown}${guard}`);
    const result = await room.commit([...changed.values()]);
    const note = missing.length ? `\nunknown ids: ${missing.join(", ")}` : "";
    return text(`updated ${matched} element(s)${result.persisted ? "" : ` (not persisted: ${result.error})`}${note}${guard}`);
  },
);

server.registerTool(
  "delete_elements",
  {
    description:
      "Soft-delete elements by id (Excalidraw keeps tombstones so peers converge). An element another agent in the room drew is left alone and reported as refused unless force is true; a person's elements and those of an agent that has left are never guarded.",
    inputSchema: { ids: z.array(z.string()).min(1), force: forceSchema },
  },
  async ({ ids, force }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const { allowed, refusals } = guardIds(ids, force);
    const deletable = new Set(allowed);
    const guard = guardNote(refusals, force);
    const changed: ExcalidrawElement[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      if (!deletable.has(id)) continue;
      const current = room.getElement(id);
      if (!current) missing.push(id);
      else if (!current.isDeleted) changed.push(bump({ ...current, isDeleted: true }));
    }
    const unknown = missing.length ? `; unknown ids: ${missing.join(", ")}` : "";
    if (!changed.length) return text(`nothing deleted${unknown}${guard}`);
    const result = await room.commit(changed);
    const note = missing.length ? `\nunknown ids: ${missing.join(", ")}` : "";
    return text(`deleted ${changed.length} element(s)${result.persisted ? "" : ` (not persisted: ${result.error})`}${note}${guard}`);
  },
);

server.registerTool(
  "wait_for_mention",
  {
    description:
      "Block until someone writes a text element addressed to this agent on the canvas, then return it with the elements around it. With no tag it answers to its own handle and to the '@claude' broadcast tag. Returns 'no mention' after timeoutSeconds so the caller can loop. A mention is reported once it has stopped changing for about 1.5s. Returning it also marks it seen on the canvas (amber stroke and a marker) so the person knows the note landed; pass autoSeen false to poll without touching the drawing. Acknowledge it with acknowledge_mention when done, which removes the handled note from the canvas; reply about the work in chat.",
    inputSchema: {
      tag: tagSchema,
      timeoutSeconds: z.number().min(1).max(600).default(60),
      radius: z.number().min(0).optional().describe("How far around the mention to look for related elements, in canvas px. Defaults to the room's nearbyRadius."),
      autoSeen: autoSeenSchema,
      answerAgentMentions: answerAgentMentionsSchema,
    },
  },
  async ({ tag, timeoutSeconds, radius, autoSeen, answerAgentMentions }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const tags = resolveTags(tag, room.handle);
    const mention = await room.waitForMention(tags, handledMentions, {
      timeoutMs: timeoutSeconds * 1000,
      accept: (m) => visibleMentions([m], room.handle, answerAgentMentions, room.agentReplyDepth).length > 0,
    });
    if (!mention) return text(`no mention of ${tags[0]} within ${timeoutSeconds}s`);
    const elements = room.getElements();
    const out = mentionBlock(mention, elements, nearRadius(room.nearbyRadius, radius), {
      previous: previousLineFor(mention.id, elements),
    });
    if (autoSeen) await commitSeen(mention);
    return text(withRequestPreamble(withScopeRule(out, mentionPolicy)));
  },
);

server.registerTool(
  "list_mentions",
  {
    description: "List every pending (unacknowledged) mention addressed to this agent on the canvas right now, each with its nearby elements. With no tag it answers to its own handle and to the '@claude' broadcast tag. Mentions surfaced here are marked seen on the canvas as wait_for_mention does; pass autoSeen false to look without touching the drawing. Pass includeHandled true to also list the notes this server acknowledged and left on the canvas, marked handled, so they can be found and cleaned up.",
    inputSchema: {
      tag: tagSchema,
      radius: z.number().min(0).optional().describe("How far around each mention to look for related elements, in canvas px. Defaults to the room's nearbyRadius."),
      autoSeen: autoSeenSchema,
      answerAgentMentions: answerAgentMentionsSchema,
      includeHandled: z
        .boolean()
        .default(false)
        .describe(
          "Also list mentions already acknowledged whose note is still on the canvas (kept with a check mark, a status or a reply). They are listed after the pending ones with 'handled' on the first line, and are never marked seen.",
        ),
    },
  },
  async ({ tag, radius, autoSeen, includeHandled, answerAgentMentions }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const all = room.getElements();
    const tags = resolveTags(tag, room.handle);
    const pending = pendingMentions(tags, all, answerAgentMentions);
    // Handled notes come after the pending ones, deliberately: the pending
    // list is the work and the handled list is the tidying, and an agent
    // reading top to bottom should meet the request before the housekeeping.
    const handled = includeHandled ? handledMentionsOnCanvas(tags, all, answerAgentMentions) : [];
    // The first tag is this agent's own address, so the empty result names
    // what the caller is listening on rather than every tag it matched.
    if (!pending.length && !handled.length) return text(`no pending mentions of ${tags[0]}`);
    const reach = nearRadius(room.nearbyRadius, radius);
    const blocks = [
      ...pending.map((m) =>
        mentionBlock(m, all, reach, { previous: previousLineFor(m.id, all) }),
      ),
      ...handled.map((m) => mentionBlock(m, all, reach, { handled: true })),
    ];
    const out = blocks.join("\n\n---\n\n");
    if (autoSeen) {
      for (const m of pending) await commitSeen(m);
    }
    return text(withRequestPreamble(withScopeRule(out, mentionPolicy)));
  },
);

server.registerTool(
  "acknowledge_mention",
  {
    description:
      "Mark a mention as handled so it is not returned again. By default the text element is removed from the canvas (soft-deleted): the seen marker already told the person it landed and the drawing is the evidence it was done. Say what you did in chat, not on the canvas - artefacts of the work belong there, prose about it does not. " +
      `Pass status ${MENTION_STATUSES.map((v) => `"${v}"`).join(" or ")} to keep the element instead, greyed with one check mark, and draw that status under it on its own grey line reading "claude: <status>" - use it when the person has to read the outcome where they wrote the request. Pass keep true to keep it greyed with a check mark and draw nothing. Pass reply (up to ${MAX_REPLY_LENGTH} characters) when the request is unclear: your question is drawn on the same line under it, as "claude: <question>", so the person answers where they asked. A reply to a mention another agent wrote is addressed to that agent by default, as "claude: @<its handle> <question>", so it reaches that agent as a mention of its own; replyTo addresses it to a different handle instead, and the room's agentReplyDepth bounds how far such a chain runs. Pass answer (up to ${MAX_ANSWER_LENGTH} characters) for a knowledge question, while set_mention_policy has answering on: the question stays in its own colour with a check mark as the heading of your answer, which is drawn on the line under it, and source puts a public URL behind it. Whatever you were given, the person's own words are left exactly as they wrote them. status, reply and answer exclude each other. Editing the text makes the mention pending again and what you wrote comes back with it.`,
    inputSchema: z
      .object({
        id: z.string().describe("The mention's element id from wait_for_mention or list_mentions."),
        keep: z.boolean().default(false).describe("Keep the text element on the canvas, greyed with a single check mark, instead of removing it."),
        reply: replySchema
          .optional()
          .describe(
            `A question to draw underneath, at most ${MAX_REPLY_LENGTH} characters, for a request you cannot act on as written. Excludes status. Must not contain a tag this agent answers to (its own handle or ${BROADCAST_TAG}), or your question would itself read as a mention.`,
          ),
        replyTo: z
          .string()
          .optional()
          .describe(
            "Handle to address the reply to, written on the line as \"@<handle>\" so it reaches that agent as a mention. Defaults to the mention's own author, which is what you want: an agent gets its answer back, and a note a person wrote is answered with no tag at all. Needs reply, and may not be an address this agent answers to.",
          ),
        status: statusSchema
          .optional()
          .describe(
            "The outcome to draw underneath, attributed to you. \"out of scope\" for anything that is not a change to the drawing; \"see chat\" for work whose account is in the chat reply. Excludes reply.",
          ),
        answer: answerSchema
          .optional()
          .describe(
            `What the question asks, in at most two sentences and ${MAX_ANSWER_LENGTH} characters, drawn on the line underneath while set_mention_policy has answerQuestions on. Built from the words above and public knowledge only, never from the conversation or anything seen outside the room. ${MENTION_POLICY_HOSTING_RULE} Excludes status and reply; put the depth behind source rather than writing more here.`,
          ),
        source: z
          .string()
          .url()
          .optional()
          .describe("Public URL the answer cites. It becomes the link on the answer line, which is where depth belongs. Needs answer."),
      })
      // Strict on purpose: `note` was this tool's free-text status until 0.7.0,
      // and a caller still passing it must be told the argument is gone rather
      // than have its words silently dropped.
      .strict(),
  },
  async ({ id, keep, reply, replyTo, status, answer, source }) => {
    // Read before the plan so a reply can default to the note's own author, and
    // only when there is a room to read it from: the refusals below are decided
    // before anything on the canvas is touched and before the room is even
    // consulted, because a refusal must leave the note exactly as the person
    // wrote it and arguments that exclude each other do so whatever the
    // connection state is.
    const current = room.isConnected ? room.getElement(id) : undefined;
    const plan = planAcknowledgement(
      { keep, reply, replyTo, status, answer, source },
      resolveTags(undefined, room.handle),
      room.handle,
      current ? elementAuthor(current) : null,
    );
    if (plan.refusal) return errorText(plan.refusal);
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    if (!current || current.type !== "text") return text(`no text element with id ${id}`);
    // Either way the words the person wrote are recorded, so our own edit
    // never reads back as a new mention, and neither does a later move.
    // An answered question keeps its own colour:
    // it is the heading of the line under it, not spent work.
    let updated = plan.answers ? markAnswered(current) : plan.kept ? markAcknowledged(current) : markRemoved(current);
    // Whatever this acknowledgement does, whatever the last one wrote is spent:
    // the old attributed line goes, replaced when this one writes its own.
    const stale = findAttributedLine(room.getElements(), id);
    const changed: ExcalidrawElement[] = [];
    if (stale) changed.push(markRemoved(stale));
    if (plan.line !== undefined) {
      // The note and its line are one thing on the canvas, so they are put in
      // a fresh group: dragging the question somewhere else takes the words
      // under it along. A new id each time, because the old line is going.
      const group = newGroupId();
      updated = withGroup(updated, group);
      // Placed under the note as it now reads: the check mark has already been
      // written, so `updated` carries the height the line has to clear.
      changed.push(
        withGroup(
          buildAttributedLine(
            updated,
            plan.line,
            {
              existing: new Map(room.getElements(true).map((e) => [e.id, e])),
              lastIndex: room.lastIndex(),
            },
            room.handle,
            // One hop past the note being answered, carrying its root kind: the
            // line is itself a mention for whoever it addresses, and this is
            // what stops that going on forever.
            { link: plan.link, answer: plan.answers, chain: nextChain(chainOf(current)) },
          ),
          group,
        ),
      );
    }
    // The note goes in first so a reader of the commit sees the heading before
    // the line, and after the grouping so it carries the group id.
    changed.unshift(updated);
    const result = await room.commit(changed);
    markHandled(handledMentions, updated);
    markHandled(acknowledgedMentions, updated);
    return text(`${acknowledgementText(id, plan)}${result.persisted ? "" : ` (not persisted: ${result.error})`}`);
  },
);

server.registerTool(
  "set_mention_policy",
  {
    description:
      "Turn knowledge answers on or off for this session. With answerQuestions true, a mention that asks a question - a definition, a comparison, a critique of what is on the canvas - may be answered on the canvas with acknowledge_mention answer instead of being acknowledged \"out of scope\"; reading the person's accounts, sending or posting anything, and acting outside the room stay out of scope either way, and an answer is built from the mention's own words and public knowledge only, never from the conversation. " +
      `${MENTION_POLICY_HOSTING_RULE} ` +
      "The flag is held in memory only: it is off when this server starts, a person turns it on by asking in chat, and joining a room or restarting turns it off again. Nothing is written to disk, so this tool call is the only record that it was asked for. room_status and poll_room report answerQuestions.",
    inputSchema: {
      answerQuestions: z
        .boolean()
        .describe("True to answer knowledge questions on the canvas for the rest of this session; false to go back to drawing requests only."),
    },
  },
  async ({ answerQuestions }) => {
    mentionPolicy.set(answerQuestions);
    return text(`${policyLine(mentionPolicy)}\n\n${scopeRuleFor(mentionPolicy)}`);
  },
);

server.registerTool(
  "poll_room",
  {
    description:
      "Cheap state probe: connection state, sceneVersion, the peers, the ids and text of the pending mentions addressed to this agent, and whether the scene moved since a version you pass. Use it while you are working in a turn to notice a change without a full show_room; use wait_for_mention when you are handing the turn back to a person.",
    inputSchema: {
      sinceVersion: z.number().optional().describe("A sceneVersion from an earlier call. changedSince is false only if the scene version still equals it."),
      tag: tagSchema,
      answerAgentMentions: answerAgentMentionsSchema,
    },
  },
  async ({ sinceVersion, tag, answerAgentMentions }) => {
    if (!room.isConnected) return text("not in a room; call join_room or create_room first");
    const pending = pendingMentions(resolveTags(tag, room.handle), room.getElements(), answerAgentMentions);
    return text(
      pollText(
        buildPollPayload(
          { status: room.status(), pending, answerQuestions: mentionPolicy.answerQuestions },
          sinceVersion,
        ),
      ),
    );
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
