/**
 * The MCP Apps view: an in-chat canvas that renders the room this server has
 * joined. Two things live here, both kept free of socket state so they can be
 * unit-tested: the payload `show_room` returns, and the registration of the
 * HTML resource a host fetches to render it.
 *
 * The HTML is the Vite bundle at `dist/view/canvas.html`, read from disk when
 * the host asks for the resource rather than inlined into this source, so the
 * view can be rebuilt without touching the server.
 *
 * The result carries text and nothing else. An MCP Apps result may also hold
 * `structuredContent`, and the payload used to travel there, but a host is free
 * to inline that channel into the model-visible transcript - Claude Desktop
 * does - which charges the reader the element array on every call, the cost the
 * split was meant to avoid. So `content` carries {@link summariseShowRoom}'s
 * few lines, and the view fetches the payload itself by calling `show_room`
 * with include: "json" and parsing the text.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/29
 */
import { readFile } from "node:fs/promises";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExcalidrawElement } from "./elements.js";
import { DEFAULT_NEARBY_RADIUS, nearbyElements, type Mention } from "./mentions.js";
import { RoomClient, type RoomStatus } from "./room.js";
import { PACKAGE_VERSION } from "./version.js";

/**
 * The stem of the resource URI. The version is appended, so the whole URI
 * changes with every release.
 */
export const CANVAS_RESOURCE_URI_PREFIX = "ui://excalidraw-room/canvas-";

/**
 * The resource the host loads to render the canvas. Referenced by tool
 * `_meta.ui.resourceUri`.
 *
 * The URI carries the package version because a host may cache the HTML by
 * URI and keep serving it across extension versions. Claude Desktop 1.49585.0
 * with extension 0.5.3 on disk rendered the 0.5.1 view: its log shows
 * `resources/read` for `ui://excalidraw-room/canvas.html` three times on one
 * afternoon and never again after any later reinstall, so no view change since
 * then had ever run. A version in the URI makes each release a cache miss.
 */
export const CANVAS_RESOURCE_URI = `${CANVAS_RESOURCE_URI_PREFIX}${PACKAGE_VERSION}.html`;
export const CANVAS_RESOURCE_NAME = "Excalidraw room canvas";

/**
 * What `show_room` says before a room is joined. Worded so a host that shows
 * the text verbatim tells the user what to do next.
 */
export const NOT_IN_ROOM_TEXT = "Not in a room. Call create_room or join_room first.";

/**
 * The part of {@link RoomClient} the `show_room` join path uses. Narrowed to
 * these three members so the path can be tested without a socket.
 */
export interface ShowRoomClient {
  readonly isConnected: boolean;
  status(): RoomStatus;
  join(link: string): Promise<unknown>;
}

/** What {@link ensureJoined} did, for the caller to report. */
export interface EnsureJoinedResult {
  /** Whether this call joined a room. */
  joined: boolean;
  /** Why the link could not be joined, or null when there was nothing to do. */
  error: string | null;
}

/**
 * Join the room a `show_room` call names, if this process is not already in it.
 *
 * The canvas view calls `show_room` over the host's own connection, and some
 * hosts - Claude Desktop among them - route an iframe's `callServerTool` to a
 * second server process rather than the one the model is talking to. One room
 * per process means that process is in no room, so every poll the view makes
 * returns {@link NOT_IN_ROOM_TEXT} while the model sees the scene perfectly
 * well. Passing the link the view was shown lets that process join for itself.
 *
 * Without a link nothing happens, which is the model's path unchanged. With
 * one, a process already connected to that same room is left alone; a process
 * in no room, or in a different one, joins.
 */
export async function ensureJoined(room: ShowRoomClient, link: string | undefined): Promise<EnsureJoinedResult> {
  if (!link) return { joined: false, error: null };
  let roomId: string;
  try {
    roomId = RoomClient.parseLink(link).roomId;
  } catch (err) {
    return { joined: false, error: `link not joined: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (room.isConnected && room.status().roomId === roomId) return { joined: false, error: null };
  try {
    await room.join(link);
    return { joined: true, error: null };
  } catch (err) {
    return { joined: false, error: `link not joined: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** A pending mention, plus the ids of the elements it sits among. */
export interface ShowRoomMention {
  id: string;
  version: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  containerId: string | null;
  nearby: string[];
}

/** The JSON body of a `show_room` result: everything the view draws from. */
export interface ShowRoomPayload {
  link: string | null;
  connected: boolean;
  peers: { socketId: string; username: string | null }[];
  elements: ExcalidrawElement[];
  mentions: ShowRoomMention[];
}

/**
 * Assemble the view's payload. Elements pass through untouched: the view feeds
 * them straight to the Excalidraw component, so any shape mapping belongs
 * there, not here.
 */
export function buildShowRoomPayload(
  status: RoomStatus,
  elements: readonly ExcalidrawElement[],
  mentions: readonly Mention[],
  radius: number = DEFAULT_NEARBY_RADIUS,
): ShowRoomPayload {
  return {
    link: status.link,
    connected: status.connected,
    peers: status.peers.map((p) => ({ socketId: p.socketId, username: p.username })),
    elements: [...elements],
    mentions: mentions.map((m) => ({
      id: m.id,
      version: m.version,
      text: m.text,
      x: m.x,
      y: m.y,
      width: m.width,
      height: m.height,
      containerId: m.containerId,
      nearby: nearbyElements(elements, m, radius).map((e) => e.id),
    })),
  };
}

/**
 * How many nearby ids one mention contributes to the text summary. A note in
 * the middle of a busy diagram can sit next to dozens of elements; the view has
 * all of them, and the model can ask for the rest by id.
 */
export const SUMMARY_NEARBY_LIMIT = 10;

/** How many mentions the text summary spells out before it defers to list_mentions. */
export const SUMMARY_MENTION_LIMIT = 5;

/**
 * One mention as the model reads it: the same three lines `formatMention`
 * writes, except that the neighbours are named by id rather than summarised
 * element by element, which is what keeps the summary short.
 */
export function formatShowRoomMention(mention: ShowRoomMention): string {
  const where = mention.containerId
    ? `inside ${mention.containerId}`
    : `at (${Math.round(mention.x)},${Math.round(mention.y)})`;
  const shown = mention.nearby.slice(0, SUMMARY_NEARBY_LIMIT);
  const hidden = mention.nearby.length - shown.length;
  const nearby = mention.nearby.length
    ? `nearby (${mention.nearby.length}): ${shown.join(", ")}${hidden ? `, +${hidden} more` : ""}`
    : "nearby: none";
  return [`mention ${mention.id} v${mention.version} ${where}:`, `"${mention.text}"`, nearby].join("\n");
}

/**
 * The payload as text for the model: the link, the connection state, the
 * counts, and every pending mention with the ids around it. Bounded by the two
 * limits above, so the length grows with the number of mentions and not with
 * the size of the scene.
 */
export function summariseShowRoom(payload: ShowRoomPayload): string {
  const lines = [
    `room: ${payload.link ?? "-"}`,
    `connected: ${payload.connected}`,
    `peers: ${payload.peers.length}`,
    `elements: ${payload.elements.length}`,
    `pending mentions: ${payload.mentions.length}`,
  ];
  const shown = payload.mentions.slice(0, SUMMARY_MENTION_LIMIT);
  for (const mention of shown) lines.push("", formatShowRoomMention(mention));
  const hidden = payload.mentions.length - shown.length;
  if (hidden) lines.push("", `+${hidden} more pending; call list_mentions for them.`);
  lines.push("", 'The elements are not in this text. The canvas view fetches them itself; pass include: "json" if you need them here.');
  return lines.join("\n");
}

/**
 * Where the built view sits relative to the compiled server: `dist/index.js`
 * and `dist/view.js` both resolve this to `dist/view/canvas.html`.
 */
export function canvasHtmlUrl(): URL {
  return new URL("./view/canvas.html", import.meta.url);
}

/** Serve the built canvas HTML at {@link CANVAS_RESOURCE_URI}. */
export function registerCanvasResource(server: Pick<McpServer, "registerResource">, htmlPath: URL | string): void {
  registerAppResource(
    server,
    CANVAS_RESOURCE_NAME,
    CANVAS_RESOURCE_URI,
    {
      description: "Live read-only view of the Excalidraw room this server has joined.",
      mimeType: RESOURCE_MIME_TYPE,
    },
    async () => ({
      contents: [
        {
          uri: CANVAS_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await readFile(htmlPath, "utf8"),
        },
      ],
    }),
  );
}
