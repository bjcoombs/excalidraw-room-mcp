/**
 * Mentions: text elements on the canvas that address the agent ("@claude ...").
 *
 * A person types the instruction next to the thing they mean; the agent reads
 * the text plus what sits around it. Pure functions here; the waiting and the
 * handled-set live in RoomClient.
 */
import { z } from "zod";
import { bump, measureText, summarise, type ExcalidrawElement } from "./elements.js";

export const DEFAULT_TAG = "@claude";
export const DEFAULT_NEARBY_RADIUS = 250;

/**
 * The two states the server paints onto a mention's text. Both are appended to
 * the note and both recolour the stroke, so they must be stripped before the
 * next one is written or the text collects suffixes. Keep the marker a distinct
 * string that nobody types by accident.
 */
export const SEEN_MARKER = " \u23f3";
export const SEEN_STROKE = "#e8590c";
export const ACKNOWLEDGED_MARK = "\u2713";
export const ACKNOWLEDGED_STROKE = "#868e96";

/**
 * How long a canvas-facing note may be. The canvas is a shared drawing, not a
 * reply channel: a note wider than the diagram it annotates zooms the whole
 * scene out under fit-to-content rendering. Prose about the work goes to chat;
 * only a status a person must read on the canvas earns a note, and 24
 * characters is enough for "declined" or "see chat".
 */
export const MAX_NOTE_LENGTH = 24;

/** Why a note was refused, in words the caller can act on. */
export const NOTE_TOO_LONG_TEXT =
  `note is longer than ${MAX_NOTE_LENGTH} characters; the canvas is not a reply channel. ` +
  "Reply in chat and acknowledge without a note, or use a short status such as \"see chat\".";

/**
 * The cap as the tool declares and enforces it. The schema is the enforcement
 * point: the MCP SDK validates arguments before the handler runs, so a long
 * note is refused with this message and the element is never touched.
 */
export const noteSchema = z.string().max(MAX_NOTE_LENGTH, { message: NOTE_TOO_LONG_TEXT });

/** Remove every seen marker, wherever a later edit left it. */
export function stripSeenMarker(text: string): string {
  return text.split(SEEN_MARKER).join("");
}

/**
 * Remove whatever status the server last wrote: seen markers anywhere, and a
 * trailing run of default check marks. Both transitions run this first, so a
 * repeated acknowledgement, or a human edit that kept the tick before
 * re-pending, still ends with exactly one suffix. A custom `note` is not
 * recognised here: it is free text, indistinguishable from what the person
 * wrote, so acknowledging twice with a note leaves both notes.
 */
export function stripStatus(text: string): string {
  // ACKNOWLEDGED_MARK is a single non-metacharacter glyph, so it needs no
  // escaping; keep it that way if the constant ever changes.
  return stripSeenMarker(text).replace(new RegExp(`(?:\\s*${ACKNOWLEDGED_MARK})+$`, "u"), "");
}

export function hasSeenMarker(text: string | undefined): boolean {
  return !!text && text.includes(SEEN_MARKER);
}

/** The note with exactly one seen marker, whatever it carried before. */
export function seenText(text: string): string {
  return `${stripStatus(text)}${SEEN_MARKER}`;
}

/** The note with the seen marker replaced by the final suffix, not appended after it. */
export function acknowledgedText(text: string, suffix: string): string {
  return `${stripStatus(text)}${suffix}`;
}

/** Retext a text element, keeping its box in step with the new content. */
function retext(el: ExcalidrawElement, nextText: string): ExcalidrawElement {
  const m = measureText(nextText, Number(el.fontSize ?? 20));
  return {
    ...el,
    text: nextText,
    originalText: nextText,
    width: el.autoResize === false ? el.width : m.width,
    height: m.height,
  };
}

/**
 * The element as it should look once the server has shown the mention was
 * seen: amber stroke plus one marker. Null when it already looks that way, so
 * the caller commits nothing and does not bump the version for nothing.
 */
export function markSeen(el: ExcalidrawElement): ExcalidrawElement | null {
  const current = el.text ?? "";
  const next = seenText(current);
  if (next === current && el.strokeColor === SEEN_STROKE) return null;
  return bump({ ...retext(el, next), strokeColor: SEEN_STROKE });
}

/**
 * The element as it should look when the note stays on the canvas: grey stroke
 * and one status suffix, replacing the seen marker rather than following it.
 * This is the exception now that acknowledgement removes the note by default -
 * it is for an outcome the person has to read where they wrote the request.
 */
export function markAcknowledged(el: ExcalidrawElement, opts: { note?: string } = {}): ExcalidrawElement {
  const current = el.text ?? "";
  const next = acknowledgedText(current, ` ${opts.note ?? ACKNOWLEDGED_MARK}`);
  return bump({ ...retext(el, next), strokeColor: ACKNOWLEDGED_STROKE });
}

/**
 * The element as it should look once the mention is handled: gone. Excalidraw
 * has no annotation layer, so a handled note is clutter in the same coordinate
 * space as the drawing; the seen marker already told the person it landed and
 * the drawing is the evidence it was done. A tombstone rather than a real
 * delete, so peers converge, and the version bump means the caller can record
 * it handled and never surface it again.
 */
export function markRemoved(el: ExcalidrawElement): ExcalidrawElement {
  return bump({ ...el, isDeleted: true });
}

export interface Mention {
  id: string;
  version: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Shape the text is bound inside, if any. */
  containerId: string | null;
}

/** id -> version already dealt with. A newer version of the same text is a new mention. */
export type HandledVersions = Map<string, number>;

export function isMentionText(text: string | undefined, tag: string): boolean {
  return !!text && text.toLowerCase().includes(tag.toLowerCase());
}

export function findMentions(
  elements: readonly ExcalidrawElement[],
  tag: string = DEFAULT_TAG,
  handled: HandledVersions = new Map(),
): Mention[] {
  const out: Mention[] = [];
  for (const el of elements) {
    if (el.isDeleted || el.type !== "text") continue;
    if (!isMentionText(el.text, tag)) continue;
    const seen = handled.get(el.id);
    if (seen !== undefined && el.version <= seen) continue;
    out.push({
      id: el.id,
      version: el.version,
      text: el.text ?? "",
      x: el.x,
      y: el.y,
      width: el.width,
      height: el.height,
      containerId: el.containerId ?? null,
    });
  }
  return out;
}

/** A bounding box in canvas coordinates. Both element and mention shapes fit it. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The box with a non-negative width and height. Excalidraw stores a shape
 * dragged up or to the left with a negative dimension, and an unnormalised box
 * reads as lying entirely on the wrong side of itself.
 */
function normalise(b: Box): Box {
  return {
    x: Math.min(b.x, b.x + b.width),
    y: Math.min(b.y, b.y + b.height),
    width: Math.abs(b.width),
    height: Math.abs(b.height),
  };
}

/**
 * Distance between two bounding boxes: zero when they overlap or touch,
 * otherwise the length of the shortest line joining them.
 *
 * Box to box, not centre to centre. A 800x300 diagram with a note 160 px below
 * it has its centre 440 px from the note's centre, so a centre measure calls it
 * far away at the 250 px default and the agent loses the context the note was
 * written next to. https://github.com/bjcoombs/excalidraw-room-mcp/issues/34
 */
export function boxDistance(first: Box, second: Box): number {
  const a = normalise(first);
  const b = normalise(second);
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

/**
 * Elements around a mention: anything whose bounding box is within `radius` of
 * the mention's box, plus the container the text is bound to. The mention
 * itself is excluded.
 */
export function nearbyElements(
  elements: readonly ExcalidrawElement[],
  mention: Mention,
  radius: number = DEFAULT_NEARBY_RADIUS,
): ExcalidrawElement[] {
  const picked = new Map<string, ExcalidrawElement>();
  for (const el of elements) {
    if (el.isDeleted || el.id === mention.id) continue;
    if (el.id === mention.containerId || boxDistance(el, mention) <= radius) picked.set(el.id, el);
  }
  // Bound labels of picked shapes travel with them so the summary reads whole.
  for (const el of elements) {
    if (el.type === "text" && el.containerId && picked.has(el.containerId) && el.id !== mention.id) {
      picked.set(el.id, el);
    }
  }
  return [...picked.values()];
}

export function formatMention(mention: Mention, nearby: readonly ExcalidrawElement[]): string {
  const where = mention.containerId ? `inside ${mention.containerId}` : `at (${Math.round(mention.x)},${Math.round(mention.y)})`;
  const lines = [
    `mention ${mention.id} v${mention.version} ${where}:`,
    `"${mention.text}"`,
    "",
    nearby.length ? `nearby (${nearby.length}):` : "nearby: none",
  ];
  if (nearby.length) lines.push(summarise(nearby));
  return lines.join("\n");
}
