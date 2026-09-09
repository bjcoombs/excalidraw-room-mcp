/**
 * Mentions: text elements on the canvas that address the agent ("@claude ...").
 *
 * A person types the instruction next to the thing they mean; the agent reads
 * the text plus what sits around it. Pure functions here; the waiting and the
 * handled-set live in RoomClient.
 */
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
 * The element as it should look once the agent is done: grey stroke and one
 * status suffix, replacing the seen marker rather than following it.
 */
export function markAcknowledged(
  el: ExcalidrawElement,
  opts: { note?: string; keepText?: boolean } = {},
): ExcalidrawElement {
  const current = el.text ?? "";
  const next = opts.keepText ? stripStatus(current) : acknowledgedText(current, ` ${opts.note ?? ACKNOWLEDGED_MARK}`);
  return bump({ ...retext(el, next), strokeColor: ACKNOWLEDGED_STROKE });
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

function intersects(a: ExcalidrawElement, b: { x: number; y: number; width: number; height: number }): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/**
 * Elements around a mention: anything whose bounding box overlaps the mention's
 * box grown by `radius`, plus the container the text is bound to. The mention
 * itself is excluded.
 */
export function nearbyElements(
  elements: readonly ExcalidrawElement[],
  mention: Mention,
  radius: number = DEFAULT_NEARBY_RADIUS,
): ExcalidrawElement[] {
  const box = {
    x: mention.x - radius,
    y: mention.y - radius,
    width: mention.width + radius * 2,
    height: mention.height + radius * 2,
  };
  const picked = new Map<string, ExcalidrawElement>();
  for (const el of elements) {
    if (el.isDeleted || el.id === mention.id) continue;
    if (el.id === mention.containerId || intersects(el, box)) picked.set(el.id, el);
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
