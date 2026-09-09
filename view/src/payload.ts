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

/**
 * An MCP `CallToolResult` as far as this view cares: a text `content` list and
 * a `structuredContent` object. Both `ontoolresult` and `callServerTool` are
 * typed to deliver exactly this, but the value that reaches the iframe is
 * whatever the host chose to forward, so the parser below asserts none of it.
 */
export interface ToolResultLike {
  content?: { type?: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}

/** Where a payload was read from. Counted separately so a host that drops one channel is visible. */
export type PayloadSource = "structured" | "text";

export interface ParsedResult {
  payload: ShowRoomPayload | null;
  source: PayloadSource | null;
}

/**
 * The envelope keys a host may wrap a tool result in. `callServerTool` is typed
 * to return the `CallToolResult` itself, but a host bridging the call over
 * postMessage may hand the view the JSON-RPC response or its own wrapper, and
 * the view has no way to negotiate: it reads whichever of these it is given.
 */
const ENVELOPE_KEYS = ["result", "toolResult"] as const;

/** JSON if the string is JSON, otherwise undefined. A summary text lands here and is discarded. */
function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The value itself when it is an object, or the object it encodes when it is a JSON string. */
function asObject(value: unknown): Record<string, unknown> | null {
  const decoded = typeof value === "string" ? tryJson(value) : value;
  return decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>) : null;
}

/**
 * The result and every envelope it may be nested in, outermost first. Two
 * levels of unwrapping covers `result`, `toolResult`, and one wrapper around
 * either; the list is finite and duplicate-free, so a self-referential envelope
 * cannot loop.
 */
function envelopes(result: unknown): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<unknown>();
  const push = (value: unknown, depth: number) => {
    const obj = asObject(value);
    if (!obj || seen.has(obj)) return;
    seen.add(obj);
    out.push(obj);
    if (depth === 0) return;
    for (const key of ENVELOPE_KEYS) push(obj[key], depth - 1);
  };
  push(result, 2);
  return out;
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
function fromText(result: Record<string, unknown>): ShowRoomPayload | null {
  const content = result.content;
  if (!Array.isArray(content)) return null;
  for (const item of content as { type?: string; text?: string }[]) {
    if (!item || typeof item.text !== "string") continue;
    const parsed = coerce(tryJson(item.text));
    if (parsed) return parsed;
  }
  return null;
}

/**
 * The payload and the channel it came from. A show_room result carries the
 * payload in `structuredContent`; its text is a short summary the model reads
 * unless the caller passed include: "json". Hosts differ in what they forward
 * to an iframe - some deliver the `CallToolResult`, some a wrapper around it,
 * some only the text - so every envelope is tried in turn: structured content
 * first, then a bare payload object, then a JSON text item.
 *
 * Before a join the text is the plain-text refusal, which is not JSON and
 * carries no structured content: that reads as "no payload yet", not a crash.
 */
export function parseResult(result: unknown): ParsedResult {
  const levels = envelopes(result);
  for (const level of levels) {
    const structured = coerce(level.structuredContent) ?? coerce(level);
    if (structured) return { payload: structured, source: "structured" };
  }
  for (const level of levels) {
    const fromJsonText = fromText(level);
    if (fromJsonText) return { payload: fromJsonText, source: "text" };
  }
  return { payload: null, source: null };
}

/** The payload alone, for callers that do not report which channel carried it. */
export function parsePayload(result: unknown): ShowRoomPayload | null {
  return parseResult(result).payload;
}

/**
 * The shape of a result the parser could not read, short enough for the status
 * line: the top-level keys, and those of any `result` or `toolResult` inside
 * it. A host whose envelope this view does not handle names itself here instead
 * of leaving an operator to guess from a bare "unreadable" count.
 */
export function envelopeShape(result: unknown): string {
  if (result === undefined) return "undefined";
  if (result === null) return "null";
  if (typeof result !== "object") return typeof result;
  const parts = [`{${Object.keys(result as Record<string, unknown>).join(",")}}`];
  for (const key of ENVELOPE_KEYS) {
    const nested = (result as Record<string, unknown>)[key];
    if (nested && typeof nested === "object") parts.push(`${key}{${Object.keys(nested as Record<string, unknown>).join(",")}}`);
    else if (typeof nested === "string") parts.push(`${key}:string`);
  }
  return parts.join(" ");
}

/** The first text item in a result, whatever envelope carries it. */
export function resultText(result: unknown): string | null {
  for (const level of envelopes(result)) {
    const content = level.content;
    if (!Array.isArray(content)) continue;
    const item = (content as { type?: string; text?: string }[]).find((c) => c && typeof c.text === "string");
    if (item?.text) return item.text;
  }
  return null;
}

/**
 * A fingerprint of the scene. Excalidraw bumps version and versionNonce on
 * every change, so comparing this against the last one tells us whether the
 * scene moved without diffing element by element.
 */
export function sceneSignature(elements: readonly Record<string, unknown>[]): string {
  return elements.map((e) => `${e.id}:${e.version}:${e.versionNonce}`).join("|");
}
