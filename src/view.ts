/**
 * The MCP Apps view: an in-chat canvas that renders the room this server has
 * joined. Two things live here, both kept free of socket state so they can be
 * unit-tested: the payload `show_room` returns, and the registration of the
 * HTML resource a host fetches to render it.
 *
 * The HTML is the Vite bundle at `dist/view/canvas.html`, read from disk when
 * the host asks for the resource rather than inlined into this source, so the
 * view can be rebuilt without touching the server.
 */
import { readFile } from "node:fs/promises";
import { registerAppResource, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ExcalidrawElement } from "./elements.js";
import { DEFAULT_NEARBY_RADIUS, nearbyElements, type Mention } from "./mentions.js";
import type { RoomStatus } from "./room.js";

/** The resource the host loads to render the canvas. Referenced by tool `_meta.ui.resourceUri`. */
export const CANVAS_RESOURCE_URI = "ui://excalidraw-room/canvas.html";
export const CANVAS_RESOURCE_NAME = "Excalidraw room canvas";

/**
 * What `show_room` says before a room is joined. Worded so a host that shows
 * the text verbatim tells the user what to do next.
 */
export const NOT_IN_ROOM_TEXT = "Not in a room. Call create_room or join_room first.";

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
