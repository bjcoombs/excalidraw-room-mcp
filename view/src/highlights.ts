/**
 * Pending mentions are drawn as a dashed box around the text that carries them.
 * The boxes are local decoration: they are built here, never sent to the room.
 */
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ShowRoomMention } from "./payload.js";

const HIGHLIGHT_PADDING = 8;
const HIGHLIGHT_COLOR = "#e03131";
export const HIGHLIGHT_ID_PREFIX = "mention-highlight-";

export function highlightElements(mentions: readonly ShowRoomMention[]): ReturnType<typeof convertToExcalidrawElements> {
  if (!mentions.length) return [];
  return convertToExcalidrawElements(
    mentions.map((m) => ({
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
    })),
  );
}
