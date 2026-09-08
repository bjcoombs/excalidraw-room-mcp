/**
 * The shape src/view.ts sends, restated for the browser. The two files are
 * separate builds with no shared module, so this mirrors ShowRoomPayload by
 * hand; src/view.test.ts pins the server side of the contract.
 */
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

export interface ShowRoomPayload {
  link: string | null;
  connected: boolean;
  peers: { socketId: string; username: string | null }[];
  elements: Record<string, unknown>[];
  mentions: ShowRoomMention[];
}

/** Every room link the server hands out has this prefix; anything else is not one. */
const ROOM_LINK_PREFIX = "https://excalidraw.com/#room=";

/**
 * The href for the "Open on excalidraw.com" link, or null when there is no room
 * to open. The prefix check keeps the anchor from pointing anywhere else.
 */
export function roomLink(link: string | null): string | null {
  return link && link.startsWith(ROOM_LINK_PREFIX) ? link : null;
}

interface ToolResultLike {
  content?: { type?: string; text?: string }[];
  isError?: boolean;
}

/**
 * A show_room result carries one text item holding the JSON payload. Before a
 * join it carries the plain-text refusal instead, which is not JSON: that reads
 * as "no payload yet", not as a crash.
 */
export function parsePayload(result: ToolResultLike | undefined): ShowRoomPayload | null {
  const text = result?.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Partial<ShowRoomPayload>;
  if (!Array.isArray(p.elements)) return null;
  return {
    link: typeof p.link === "string" ? p.link : null,
    connected: p.connected === true,
    peers: Array.isArray(p.peers) ? p.peers : [],
    elements: p.elements,
    mentions: Array.isArray(p.mentions) ? p.mentions : [],
  };
}

/**
 * A fingerprint of the scene. Excalidraw bumps version and versionNonce on
 * every change, so comparing this against the last one tells us whether the
 * scene moved without diffing element by element.
 */
export function sceneSignature(elements: readonly Record<string, unknown>[]): string {
  return elements.map((e) => `${e.id}:${e.version}:${e.versionNonce}`).join("|");
}
