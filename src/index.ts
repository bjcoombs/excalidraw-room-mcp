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
  translate,
  type ElementSpec,
  type ExcalidrawElement,
} from "./elements.js";
import { forcedLine, protectedBy, refusalLines, type Refusal } from "./guard.js";
import { isValidHandle, MAX_HANDLE_LENGTH } from "./handle.js";
import { helpText, README_URL, readReadme } from "./help.js";
import { LISTEN_TIP, SERVER_INSTRUCTIONS } from "./instructions.js";
import { DEFAULT_LISTENER, ListenLease, leaseLine, waitUnderLease } from "./lease.js";
import {
  agentReplyDepthLine,
  agentReplyDepthRefusal,
  agentReplyDepthSchema,
  answerSchema,
  buildAttributedLine,
  chainOf,
  findAttributedLine,
  findHandledMentions,
  findMentions,
  formatMention,
  nearbyNeighbourhood,
  handledKey,
  answeredStickyNote,
  buildMentionAnswer,
  confidenceSchema,
  markAcknowledged,
  markHandled,
  markRemoved,
  markReplied,
  markSeen,
  acknowledgementText,
  planAcknowledgement,
  previousAnswerNear,
  MentionPolicy,
  newGroupId,
  nextChain,
  policyLine,
  previousLine,
  noteStays,
  removedWithMention,
  scopeRuleFor,
  spentAnswerElements,
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
import { commitLine, persistedLine, RoomClient } from "./room.js";
import { selectElements, unknownIdsText } from "./scene.js";
import { MAX_SCALE, snapshotScene } from "./snapshot.js";
import { stagedToolsEnabled, ToolStage, type ToolHandle } from "./staged.js";
import {
  buildShowRoomPayload,
  CANVAS_RESOURCE_URI,
  NOT_IN_ROOM_TEXT,
  canvasHtmlUrl,
  registerCanvasResource,
  summariseShowRoom,
} from "./view.js";
import { resolveShowRoom, ViewerPool, viewersLine } from "./viewers.js";
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
 * Read-only clients for rooms this process is asked to render but is not
 * working in. A host may route a canvas widget's calls to a process other than
 * the one its conversation uses, so `scene_show {link}` is answered from here
 * rather than by moving the process. See src/viewers.ts.
 */
const viewers = new ViewerPool();
/**
 * Mentions already surfaced to an agent, by element id -> the words they
 * carried, the server's markers stripped. Reset on join. This is what stops
 * mention_wait returning the same note twice in a row; it is deliberately
 * not what "pending" means.
 */
let handledMentions: HandledNotes = new Map();
/**
 * Mentions an agent has answered, by element id -> the words they carried,
 * keyed exactly as above. Reset on join.
 *
 * Pending means unacknowledged, not unseen. A note an agent has looked at but
 * not acted on is still an open request: the canvas widget has to be able to
 * announce it from its button, mention_list has to be able to show it again, and mention_poll
 * has to keep reporting it. Only mention_acknowledge closes a mention.
 */
let acknowledgedMentions: HandledNotes = new Map();
/**
 * Whether this session answers knowledge questions on the canvas. In memory
 * beside the two handled maps, off until a person asks for it in chat, and
 * reset by the same join that clears them: a permission granted for one room is
 * not a permission for the next.
 */
const mentionPolicy = new MentionPolicy();
/**
 * Which caller on this connection is waiting for mentions. In memory beside
 * the two handled maps and reset by the same join, because a lease taken for
 * one room says nothing about who listens in the next. See src/lease.ts.
 */
const listenLease = new ListenLease();
room.on("joined", () => {
  handledMentions = new Map();
  acknowledgedMentions = new Map();
  mentionPolicy.reset();
  listenLease.reset();
});

/**
 * Every mention of any of `tags` that has not been acknowledged, seen or not,
 * as this agent should see it: another agent's note is dropped unless the
 * caller asked for it. Both the addressing (which tags) and the filtering
 * (which authors) are applied in one place, so `mention_list`, `mention_poll`,
 * `mention_wait` and `scene_show` cannot disagree about what is pending.
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
function previousLineFor(id: string, elements: readonly ExcalidrawElement[] = room.getElements()): PreviousLine | null {
  const line = findAttributedLine(elements, id);
  return line ? previousLine(line) : null;
}

/**
 * What the agent last wrote about this mention: the line still under the note,
 * or failing that the answer a sticky note beside it already gives to the same
 * question. An answered note is removed from the canvas, so the sticky note is the
 * only history a note asking again can carry.
 */
function previousFor(mention: Mention, elements: readonly ExcalidrawElement[], radius: number): PreviousLine | null {
  return previousLineFor(mention.id, elements) ?? previousAnswerNear(elements, mention, radius);
}

/**
 * One mention rendered with its neighbourhood: the elements around it and the
 * hop markers saying why the far ones are there. Every mention block goes
 * through here so `scene_read near`, `scene_snapshot near` and the mention
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
 * Only the words the tool returned are marked. mention_list commits one
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

/*
 * Argument descriptions are capped at 100 characters and tool descriptions at
 * 300, and src/budget.test.ts holds the whole tools/list under 10,000: every
 * character here is in the model's context on every turn. The rules and formats
 * these used to spell out are in README, served by room_help.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/108
 */
const autoSeenSchema = z.boolean().default(true);

/**
 * The ownership guard's override. Off by default, so the safe behaviour is the
 * one an agent gets without thinking about it; the noisy path is the one it has
 * to ask for.
 */
const forceSchema = z.boolean().default(false);

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
const tagSchema = z.string().optional();

/**
 * Off by default: two agents listening in one room would otherwise answer each
 * other's requests, and each other's answers, without either being asked.
 */
const answerAgentMentionsSchema = z.boolean().default(false);

/**
 * An [x, y] pair. Deliberately an array-with-length rather than a zod tuple:
 * a tuple emits draft-07 tuple-form `items` (an array of per-position
 * schemas), which the Anthropic API rejects, taking the whole tool list with
 * it. `.length(2)` still rejects anything but exactly two numbers at runtime.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/28
 */
const point = z.array(z.number()).length(2);

/**
 * Where to put the element, instead of where. Given `place`, the server finds
 * a free slot from the live scene and the caller's x and y are not read:
 * asking for a slot and naming coordinates are alternatives, and honouring
 * both would put the element somewhere neither asked for.
 */
const placeSchema = z
  .object({
    near: z.string().optional(),
    cluster: z.string().optional(),
    side: z.enum(SIDES).optional(),
    gap: z.number().min(0).optional(),
    newCluster: z.boolean().optional(),
  })
  .strict()
  .optional();

const ELEMENT_TYPES = ["rectangle", "ellipse", "diamond", "text", "arrow", "line", "freedraw", "stickynote"] as const;

/**
 * The full element spec, checked inside the scene_add handler rather than
 * emitted in tools/list. Declared field by field it serialises to about 1,400
 * characters with no descriptions at all, over the 900 a single tools/list
 * entry may cost, so the emitted schema names the type and lists the fields in
 * its description, and this strict object still refuses a misspelt key by name.
 * README "Element specs" documents each field; room_help {topic: "scene"} serves it.
 */
const elementSpec = z
  .object({
    type: z.enum(ELEMENT_TYPES),
    id: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    width: z.number().optional(),
    height: z.number().optional(),
    text: z.string().optional(),
    label: z.string().optional(),
    link: z.string().optional(),
    fontSize: z.number().optional(),
    points: z.array(point).optional(),
    start: z.string().optional(),
    end: z.string().optional(),
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

const elementSpecs = z.array(elementSpec).min(1);

/**
 * What tools/list carries for scene_add: the type, which is what a model most
 * needs pinned, and every other key let through to `elementSpecs`.
 */
const emittedElementSpec = z.object({ type: z.enum(ELEMENT_TYPES) }).passthrough();

/** The zod issues as one line each, the way a refused argument is reported. */
function issuesText(tool: string, error: z.ZodError): string {
  const issues = error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return `Invalid arguments for tool ${tool}: ${issues.join("; ")}`;
}

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
 * `scene_show` alone carries it. room_create and room_join used to as well, and
 * a host renders one widget per result that does, so asking for a room drew a
 * canvas before there was anything on it and a second one the moment the model
 * called scene_show. Their results are text; the canvas is what scene_show is
 * for.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/64
 */
const CANVAS_META = { ui: { resourceUri: CANVAS_RESOURCE_URI } } as const;

/** A result the host should render the canvas for: scene_show's, and only its. */
function canvasResult(s: string, isError = false) {
  return { ...text(s), _meta: CANVAS_META, ...(isError ? { isError: true } : {}) };
}

/**
 * The handle argument of room_create and room_join. Optional: absent means
 * the default derived from the os user.
 */
const handleSchema = z.string().optional();

/**
 * The room's neighbourhood radius. One number decides how far a mention
 * reaches for context and how far apart placement keeps clusters, so it is
 * agreed once on join rather than passed per call.
 */
const nearbyRadiusSchema = z.number().min(0).optional();

/**
 * The room's bound on agent-to-agent chains. A property of the room, like the
 * neighbourhood radius: the facilitator who sets the room up decides how much
 * agent-to-agent traffic their canvas carries, and no rebuild changes it.
 */
const roomReplyDepthSchema = agentReplyDepthSchema;

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

/**
 * Let go of the viewer for the room this process has just joined, if it was
 * holding one. A room needs one client per process: the working one reads the
 * same scene, and a second anonymous socket would show up as an extra peer.
 */
function dropViewerForCurrentRoom(): void {
  const roomId = room.status().roomId;
  if (roomId) viewers.closeRoom(roomId);
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
    leaseLine(listenLease),
    `peers: ${peers}`,
    viewersLine(viewers),
    `elements: ${s.elementCount} (${s.deletedCount} deleted)`,
    `sceneVersion: ${s.sceneVersion}`,
    `initial scene from: ${s.source ?? "-"}`,
    `last remote update: ${s.lastRemoteUpdate ?? "-"}`,
    persistedLine(s),
  ].join("\n");
}

const server = new McpServer(
  { name: "excalidraw-room-mcp", version: PACKAGE_VERSION },
  // listChanged is declared rather than left to the SDK's own registration of
  // it, because it is what lets a staged list tell the host the list moved.
  { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: { listChanged: true } } },
);

/** Handles of the tools staging withholds until a room is joined: everything not in PRE_JOIN_TOOLS. */
const gatedTools: ToolHandle[] = [];

/**
 * Keep a tool's handle so a staged list can withhold it. Wrapping the
 * registration rather than naming the tool again means the pre-join set is
 * exactly what is left unwrapped; `PRE_JOIN_TOOLS` in src/staged.ts names those
 * four and `staged-stdio.test.ts` asserts the list matches.
 */
function gated<T extends ToolHandle>(tool: T): T {
  gatedTools.push(tool);
  return tool;
}

// Plain registerTool, not registerAppTool: the canvas metadata is what
// registerAppTool is for, and this result is text. See CANVAS_META above.
server.registerTool(
  "room_create",
  {
    description:
      "Use to start a new empty room. Joins it and returns the link, which holds the room key, and the room status.",
    inputSchema: { handle: handleSchema, nearbyRadius: nearbyRadiusSchema, agentReplyDepth: roomReplyDepthSchema },
  },
  async ({ handle, nearbyRadius, agentReplyDepth }) => {
    const refusal = handleRefusal(handle) ?? agentReplyDepthRefusal(agentReplyDepth);
    if (refusal) return errorText(refusal);
    const link = await RoomClient.createLink();
    await room.join(link, { initTimeoutMs: 1500, handle, nearbyRadius, agentReplyDepth });
    dropViewerForCurrentRoom();
    toolStage.reveal();
    return text(`${link}\n\n${statusText()}\n\n${LISTEN_TIP}`);
  },
);

server.registerTool(
  "room_join",
  {
    description:
      "Use when given an excalidraw.com room link. Joins it and returns the room status and handle.",
    inputSchema: {
      link: z.string(),
      handle: handleSchema,
      nearbyRadius: nearbyRadiusSchema,
      agentReplyDepth: roomReplyDepthSchema,
      serverUrl: z.string().optional(),
      origin: z.string().optional(),
    },
  },
  async ({ link, serverUrl, origin, handle, nearbyRadius, agentReplyDepth }) => {
    const refusal = handleRefusal(handle) ?? agentReplyDepthRefusal(agentReplyDepth);
    if (refusal) return errorText(refusal);
    await room.join(link, { serverUrl, origin, handle, nearbyRadius, agentReplyDepth });
    dropViewerForCurrentRoom();
    toolStage.reveal();
    return text(`${statusText()}\n\n${LISTEN_TIP}`);
  },
);

gated(registerAppTool(
  server,
  "scene_show",
  {
    _meta: CANVAS_META,
    description:
      "Use to show the live canvas in a chat that renders MCP Apps. Returns a short room summary.",
    inputSchema: {
      tag: tagSchema,
      link: z.string().optional().describe("Leave unset; the canvas view sets it."),
      radius: z.number().min(0).optional(),
      include: z.enum(["summary", "json"]).default("summary"),
    },
  },
  async ({ tag, radius, include, link }) => {
    // A link for another room is answered from a viewer, so a widget whose
    // calls the host routed to this process is served without moving it out of
    // the room its own conversation is working in. See src/viewers.ts.
    const { client, error } = await resolveShowRoom(room, viewers, link);
    if (!client.isConnected) return canvasResult(error ? `${NOT_IN_ROOM_TEXT}\n${error}` : NOT_IN_ROOM_TEXT, true);
    const elements = client.getElements();
    // A viewer answers no mentions; the notes are still listed so the canvas
    // can highlight them, and acknowledging one remains the current room's.
    const pending = pendingMentions(resolveTags(tag, room.handle), elements);
    const payload = buildShowRoomPayload(client.status(), elements, pending, nearRadius(room.nearbyRadius, radius));
    // Text only, deliberately: a host that inlines structuredContent into the
    // model-visible transcript charges the reader for the element array on
    // every call, which is what a split payload was meant to avoid. The view
    // calls this tool itself with include: "json" and reads the text.
    return canvasResult(include === "json" ? JSON.stringify(payload) : summariseShowRoom(payload));
  },
));

registerCanvasResource(server, canvasHtmlUrl());

gated(server.registerTool(
  "room_open",
  {
    description:
      "Use after joining so the person can watch live in their browser. Returns the link and room state.",
    inputSchema: {
      link: z.string().optional(),
    },
  },
  async ({ link }) => {
    const result = await openRoom(room, link);
    return result.isError ? errorText(result.text) : text(result.text);
  },
));

server.registerTool(
  "room_status",
  {
    description:
      "Use to check the connection and room settings. Returns handle, radius, reply depth, answerQuestions, listener, peers and counts.",
    inputSchema: {},
  },
  async () => text(statusText()),
);

/** README.md, read on the first room_help call and kept: it does not change under a running server. */
let readme: string | undefined;

server.registerTool(
  "room_help",
  {
    // The eight topic names are already in SERVER_INSTRUCTIONS, which every
    // session reads at initialize, and an unknown topic lists them back. Naming
    // them a third time here spent 44 characters of the tools/list budget on a
    // list the model already holds.
    description:
      "Use for formats and rules the tool descriptions leave out. Returns README text by topic; an unknown topic lists them.",
    inputSchema: { topic: z.string() },
  },
  async ({ topic }) => {
    if (readme === undefined) {
      try {
        readme = readReadme();
      } catch (err) {
        return errorText(`README.md is not readable at ${README_URL.pathname}: ${(err as Error).message}`);
      }
    }
    return text(helpText(readme, topic));
  },
);

gated(server.registerTool(
  "scene_read",
  {
    description:
      "Use to read the drawing as data. Returns a line per element, or JSON, narrowed by ids, near or by.",
    inputSchema: {
      format: z.enum(["summary", "json"]).default("summary"),
      includeDeleted: z.boolean().default(false),
      ids: z.array(z.string()).min(1).optional(),
      near: z
        .object({ id: z.string(), radius: z.number().min(0).optional() })
        .optional()
,
      by: z.array(z.string()).min(1).optional().describe(`Author handles; "${PERSON_AUTHOR}" for people.`),
    },
  },
  async ({ format, includeDeleted, ids, near, by }) => {
    if (!room.isConnected) return text("not in a room; call room_join or room_create first");
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
));

gated(server.registerTool(
  "scene_snapshot",
  {
    description:
      "Use to read hand-drawn content or check a layout for overlap. Returns a PNG and the ids drawn.",
    inputSchema: {
      ids: z.array(z.string()).min(1).optional(),
      near: z.string().optional(),
      bbox: z
        .object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() })
        .optional(),
      scale: z.number().positive().max(MAX_SCALE).optional(),
      maxWidth: z.number().positive().optional(),
      maxHeight: z.number().positive().optional(),
    },
  },
  async ({ ids, near, bbox, scale, maxWidth, maxHeight }) => {
    if (!room.isConnected) return text("not in a room; call room_join or room_create first");
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
));

gated(server.registerTool(
  "scene_add",
  {
    description:
      "Use to draw shapes, text, arrows and sticky notes; place finds free space. Returns the ids added and any coordinates chosen.",
    inputSchema: {
      elements: z
        .array(emittedElementSpec)
        .min(1)
        .describe("Specs: id x y width height text label link points start end place, style keys."),
    },
  },
  async ({ elements }) => {
    // Checked before the connection, like every other argument refusal: a spec
    // the server would refuse in a room is refused out of one too.
    const parsed = elementSpecs.safeParse(elements);
    if (!parsed.success) return errorText(issuesText("scene_add", parsed.error));
    if (!room.isConnected) return text("not in a room; call room_join or room_create first");
    const specs = parsed.data as PlacedSpec[];
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
      commitLine(`added ${stamped.length} element(s)`, result),
      ...stamped.map((e) => `${e.id} ${e.type}`),
      ...placements.flatMap(({ id, result: placed }) => placementLines(id, placed)),
    ];
    return text(lines.join("\n"));
  },
));

gated(server.registerTool(
  "scene_add_raw",
  {
    description:
      "Use to import complete Excalidraw elements verbatim, in batches. Returns the ids added.",
    inputSchema: { elements: z.array(z.record(z.unknown())).min(1) },
  },
  async ({ elements }) => {
    if (!room.isConnected) return text("not in a room; call room_join or room_create first");
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
    return text(
      `${commitLine(`added ${prepared.length} element(s)`, result)}\n${prepared.map((e) => `${e.id} ${e.type}`).join("\n")}`,
    );
  },
));

gated(server.registerTool(
  "scene_update",
  {
    description:
      "Use to change elements by id; labels and bound arrows follow. Returns the count and any refusals.",
    inputSchema: {
      updates: z
        .array(z.object({ id: z.string(), set: z.record(z.unknown()) }))
        .min(1)
,
      force: forceSchema,
    },
  },
  async ({ updates, force }) => {
    if (!room.isConnected) return text("not in a room; call room_join or room_create first");
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
    return text(`${commitLine(`updated ${matched} element(s)`, result)}${note}${guard}`);
  },
));

gated(server.registerTool(
  "scene_translate",
  {
    description:
      "Use to move elements with their labels, groups, frame children and arrows. Returns the ids moved.",
    inputSchema: {
      ids: z.array(z.string()).min(1),
      dx: z.number(),
      dy: z.number(),
      force: forceSchema,
    },
  },
  async ({ ids, dx, dy, force }) => {
    if (!room.isConnected) return text("not in a room; call room_join or room_create first");
    const { allowed, refusals } = guardIds(ids, force);
    const guard = guardNote(refusals, force);
    // The closure runs over the whole scene, including elements the guard
    // refused: a refused id is not moved, but a group it is in still is.
    const { moved, rebound, added, missing } = translate(allowed, dx, dy, room.getElements());
    const unknown = missing.length ? `; unknown ids: ${missing.join(", ")}` : "";
    if (!moved.length) return text(`nothing moved${unknown}${guard}`);
    const result = await room.commit([...moved, ...rebound]);
    const lines = [
      commitLine(`moved ${moved.length} element(s)`, result),
      ...(added.length ? [`added by closure: ${added.join(", ")}`] : []),
      ...(rebound.length ? [`re-attached: ${rebound.map((e) => e.id).join(", ")}`] : []),
      ...(missing.length ? [`unknown ids: ${missing.join(", ")}`] : []),
    ];
    return text(`${lines.join("\n")}${guard}`);
  },
));

gated(server.registerTool(
  "scene_delete",
  {
    description:
      "Use to remove elements by id. Returns the count and any refusals.",
    inputSchema: { ids: z.array(z.string()).min(1), force: forceSchema },
  },
  async ({ ids, force }) => {
    if (!room.isConnected) return text("not in a room; call room_join or room_create first");
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
    return text(`${commitLine(`deleted ${changed.length} element(s)`, result)}${note}${guard}`);
  },
));

gated(server.registerTool(
  "mention_wait",
  {
    description:
      "Use to hand the turn back and listen for notes to you. Blocks until one settles; returns it with its neighbourhood.",
    inputSchema: {
      tag: tagSchema,
      timeoutSeconds: z.number().min(1).max(600).default(60),
      radius: z.number().min(0).optional(),
      autoSeen: autoSeenSchema,
      answerAgentMentions: answerAgentMentionsSchema,
      listener: z
        .string()
        .min(1)
        .max(64)
        .default(DEFAULT_LISTENER)
        .describe("Who listens. One name at a time; a second is refused, not served."),
    },
  },
  async ({ tag, timeoutSeconds, radius, autoSeen, answerAgentMentions, listener }) => {
    if (!room.isConnected) return text("not in a room; call room_join or room_create first");
    const tags = resolveTags(tag, room.handle);
    const timeoutMs = timeoutSeconds * 1000;
    // The lease gates the wait rather than the merge rule: a foreign listener
    // is turned away here, before anything blocks. See src/lease.ts.
    const outcome = await waitUnderLease(listenLease, listener, timeoutMs, () =>
      room.waitForMention(tags, handledMentions, {
        timeoutMs,
        accept: (m) => visibleMentions([m], room.handle, answerAgentMentions, room.agentReplyDepth).length > 0,
      }),
    );
    if (!outcome.granted) return text(outcome.text);
    const mention = outcome.value;
    if (!mention) return text(`no mention of ${tags[0]} within ${timeoutSeconds}s`);
    const elements = room.getElements();
    const reach = nearRadius(room.nearbyRadius, radius);
    const out = mentionBlock(mention, elements, reach, { previous: previousFor(mention, elements, reach) });
    if (autoSeen) await commitSeen(mention);
    return text(withRequestPreamble(withScopeRule(out, mentionPolicy)));
  },
));

gated(server.registerTool(
  "mention_list",
  {
    description:
      "Use to see pending mentions now, without waiting. Returns each with its neighbourhood.",
    inputSchema: {
      tag: tagSchema,
      radius: z.number().min(0).optional(),
      autoSeen: autoSeenSchema,
      answerAgentMentions: answerAgentMentionsSchema,
      includeHandled: z.boolean().default(false),
    },
  },
  async ({ tag, radius, autoSeen, includeHandled, answerAgentMentions }) => {
    if (!room.isConnected) return text("not in a room; call room_join or room_create first");
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
      ...pending.map((m) => mentionBlock(m, all, reach, { previous: previousFor(m, all, reach) })),
      ...handled.map((m) => mentionBlock(m, all, reach, { handled: true })),
    ];
    const out = blocks.join("\n\n---\n\n");
    if (autoSeen) {
      for (const m of pending) await commitSeen(m);
    }
    return text(withRequestPreamble(withScopeRule(out, mentionPolicy)));
  },
));

gated(server.registerTool(
  "mention_acknowledge",
  {
    description:
      "Use when a mention is done, unclear or out of scope. Removes it, or keeps it with status, keep or reply, or swaps in an answer sticky note.",
    inputSchema: z
      .object({
        id: z.string(),
        keep: z.boolean().default(false),
        reply: replySchema.optional(),
        replyTo: z.string().optional(),
        status: statusSchema.optional(),
        answer: answerSchema.optional().describe("Only while mention_policy is on."),
        source: z.string().url().optional(),
        confidence: confidenceSchema
          .optional()
          .describe("How well founded the answer is. \"high\" needs a source. room_help answers."),
      })
      // Strict on purpose: `note` was this tool's free-text status until 0.7.0,
      // and a caller still passing it must be told the argument is gone rather
      // than have its words silently dropped.
      .strict(),
  },
  async ({ id, keep, reply, replyTo, status, answer, source, confidence }) => {
    // Read before the plan so a reply can default to the note's own author, and
    // only when there is a room to read it from: the refusals below are decided
    // before anything on the canvas is touched and before the room is even
    // consulted, because a refusal must leave the note exactly as the person
    // wrote it and arguments that exclude each other do so whatever the
    // connection state is.
    const current = room.isConnected ? room.getElement(id) : undefined;
    const plan = planAcknowledgement(
      { keep, reply, replyTo, status, answer, source, confidence },
      resolveTags(undefined, room.handle),
      room.handle,
      current ? elementAuthor(current) : null,
    );
    if (plan.refusal) return errorText(plan.refusal);
    if (!room.isConnected) return text("not in a room; call room_join or room_create first");
    if (!current || current.type !== "text") return text(`no text element with id ${id}`);
    // The person's own sticky note, when the question was typed into one and
    // this acknowledgement answers it: the note stays and the answer goes
    // under it. https://github.com/bjcoombs/excalidraw-room-mcp/issues/128
    const answeredNote = answeredStickyNote(room.getElements(), current, plan);
    // Either way the words the person wrote are recorded, so our own edit
    // never reads back as a new mention, and neither does a later move.
    // A reply leaves the note live in the colour it was written in, because
    // the line under it asks something; keep and status grey it as spent; an
    // answer removes a loose note, because the sticky note drawn in its place
    // carries the question itself and nothing should ask it twice, and marks a
    // note of the person's own as it stands, because the answer sits below it.
    let updated = plan.replies
      ? markReplied(current)
      : noteStays(plan, answeredNote)
        ? markAcknowledged(current)
        : markRemoved(current);
    // Whatever this acknowledgement does, whatever the last one wrote is spent:
    // the old attributed line goes, replaced when this one writes its own.
    const stale = findAttributedLine(room.getElements(), id);
    const changed: ExcalidrawElement[] = [];
    if (stale) changed.push(markRemoved(stale));
    // A note typed into a sticky note goes with the sticky note: the words were
    // the whole of what the box was drawn to carry, and a box left standing
    // empty is litter the person has to clear. A mention labelling a rectangle
    // or an ellipse is a request about that drawing, so that container stays.
    // https://github.com/bjcoombs/excalidraw-room-mcp/issues/126
    changed.push(...removedWithMention(room.getElements(), current, plan));
    // A sticky note answering this note from an earlier acknowledgement is
    // spent too, and it takes its bound text and its confidence marker with it.
    changed.push(...spentAnswerElements(room.getElements(), id));
    if (plan.answer !== undefined) {
      // A loose note is removed and the sticky note takes its place: the
      // question is the heading of the answer inside the box, so keeping the
      // note as well would draw it twice. A question typed into the person's
      // own sticky note keeps that note, and the answer is a second note
      // grouped under it, holding the answer alone.
      const answered = buildMentionAnswer(
        current,
        updated,
        answeredNote,
        plan.answer,
        { existing: new Map(room.getElements(true).map((e) => [e.id, e])), lastIndex: room.lastIndex() },
        room.handle,
        { link: plan.link, confidence: plan.confidence, chain: nextChain(chainOf(current)) },
      );
      updated = answered.mention;
      changed.push(...answered.changed);
    }
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
    return text(`${acknowledgementText(id, plan, answeredNote !== null)}${result.persisted ? "" : ` (not persisted: ${result.error})`}`);
  },
));

gated(server.registerTool(
  "mention_policy",
  {
    description:
      "Use only when a person asks in chat to have canvas questions answered, or to stop. Returns the scope rule now in force.",
    inputSchema: {
      answerQuestions: z.boolean(),
    },
  },
  async ({ answerQuestions }) => {
    mentionPolicy.set(answerQuestions);
    return text(`${policyLine(mentionPolicy)}\n\n${scopeRuleFor(mentionPolicy)}`);
  },
));

gated(server.registerTool(
  "mention_poll",
  {
    description:
      "Use inside a turn to notice mentions or scene changes without blocking. Returns sceneVersion and pending mentions.",
    inputSchema: {
      sinceVersion: z.number().optional(),
      tag: tagSchema,
      answerAgentMentions: answerAgentMentionsSchema,
    },
  },
  async ({ sinceVersion, tag, answerAgentMentions }) => {
    if (!room.isConnected) return text("not in a room; call room_join or room_create first");
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
));


gated(server.registerTool(
  "room_leave",
  {
    description: "Use when done with the room. Disconnects and returns left room.",
    inputSchema: {},
  },
  async () => {
    room.leave();
    // room_leave is itself withheld here: it needs a room like the rest, and
    // the handler has already run by the time its own entry leaves the list.
    toolStage.withhold();
    return text("left room");
  },
));

// Withheld before the transport is connected, so the starting list is the
// staged one and no client is told anything changed to reach it. Without the
// flag this is a no-op and all nineteen tools are listed from the start.
const toolStage = new ToolStage(gatedTools, stagedToolsEnabled());
toolStage.withhold();

const transport = new StdioServerTransport();
await server.connect(transport);
