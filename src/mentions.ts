/**
 * Mentions: text elements on the canvas that address the agent ("@claude ...").
 *
 * A person types the instruction next to the thing they mean; the agent reads
 * the text plus what sits around it. Pure functions here; the waiting and the
 * handled-set live in RoomClient.
 */
import { summarise, type ExcalidrawElement } from "./elements.js";

export const DEFAULT_TAG = "@claude";
export const DEFAULT_NEARBY_RADIUS = 250;

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
