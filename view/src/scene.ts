/**
 * What the canvas draws: the room's own elements, plus a local box around every
 * pending mention. The boxes are decoration - they are built here and never
 * sent to the room.
 *
 * The geometry lives in this module rather than next to the Excalidraw call in
 * highlights.ts so that it can be exercised under Node: importing
 * @excalidraw/excalidraw outside the browser bundle is not possible, and the
 * box around a mention is the part worth pinning.
 */
import type { ShowRoomMention } from "./payload.js";

/** How far outside the mention's own box the highlight sits, in canvas px. */
export const HIGHLIGHT_PADDING = 8;

const HIGHLIGHT_COLOR = "#e03131";

/** Every highlight id starts with this, so a box can never be taken for a room element. */
export const HIGHLIGHT_ID_PREFIX = "mention-highlight-";

/**
 * A highlight box as convertToExcalidrawElements takes it. Deliberately a plain
 * object: highlights.ts is the only place that turns one into an Excalidraw
 * element.
 */
export interface HighlightBox {
  type: "rectangle";
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor: string;
  backgroundColor: string;
  strokeStyle: "dashed";
  strokeWidth: number;
  roughness: number;
  opacity: number;
}

/** One dashed box per pending mention, wrapping the text that carries it. */
export function highlightBoxes(mentions: readonly ShowRoomMention[]): HighlightBox[] {
  return mentions.map((m) => ({
    type: "rectangle" as const,
    id: `${HIGHLIGHT_ID_PREFIX}${m.id}`,
    x: m.x - HIGHLIGHT_PADDING,
    y: m.y - HIGHLIGHT_PADDING,
    width: m.width + HIGHLIGHT_PADDING * 2,
    height: m.height + HIGHLIGHT_PADDING * 2,
    strokeColor: HIGHLIGHT_COLOR,
    backgroundColor: "transparent",
    strokeStyle: "dashed" as const,
    strokeWidth: 2,
    roughness: 0,
    opacity: 100,
  }));
}

/**
 * The element list handed to the canvas: the room's scene first, the local
 * highlights on top. The mention's own text element is in the room's scene, so
 * this is the one place a mention's words are rendered at all.
 */
export function canvasElements<T>(elements: readonly T[], highlights: readonly T[]): T[] {
  return [...elements, ...highlights];
}
