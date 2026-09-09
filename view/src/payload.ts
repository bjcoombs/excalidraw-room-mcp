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
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * The payload as this view needs it, or null when the value is not one. Every
 * field is defaulted rather than trusted: the object crosses a postMessage
 * boundary from a host, and a missing elements array is the one thing the
 * caller cannot paper over.
 */
function coerce(value: unknown): ShowRoomPayload | null {
  if (!value || typeof value !== "object") return null;
  const p = value as Partial<ShowRoomPayload>;
  if (!Array.isArray(p.elements)) return null;
  return {
    link: typeof p.link === "string" ? p.link : null,
    connected: p.connected === true,
    peers: Array.isArray(p.peers) ? p.peers : [],
    elements: p.elements,
    mentions: Array.isArray(p.mentions) ? p.mentions : [],
  };
}

/** The JSON payload a caller asked for as text (show_room's include: "json"). */
function fromText(result: ToolResultLike | undefined): ShowRoomPayload | null {
  const text = result?.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return coerce(JSON.parse(text));
  } catch {
    return null;
  }
}

/**
 * A show_room result carries the payload in `structuredContent`; its text is a
 * short summary the model reads, not JSON. Read the structured channel first
 * and fall back to the text, which still holds the payload when a caller passed
 * include: "json" and is how a host that drops structured content keeps working.
 *
 * Before a join the text is the plain-text refusal, which is not JSON and
 * carries no structured content: that reads as "no payload yet", not a crash.
 */
export function parsePayload(result: ToolResultLike | undefined): ShowRoomPayload | null {
  return coerce(result?.structuredContent) ?? fromText(result);
}

/**
 * A fingerprint of the scene. Excalidraw bumps version and versionNonce on
 * every change, so comparing this against the last one tells us whether the
 * scene moved without diffing element by element.
 */
export function sceneSignature(elements: readonly Record<string, unknown>[]): string {
  return elements.map((e) => `${e.id}:${e.version}:${e.versionNonce}`).join("|");
}
