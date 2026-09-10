/**
 * Pending mentions are drawn as a dashed box around the text that carries them.
 * The boxes are local decoration: they are built here, never sent to the room.
 * The geometry is in scene.ts, which runs under Node; this file is only the
 * conversion into Excalidraw's element shape.
 */
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import type { ShowRoomMention } from "./payload.js";
import { highlightBoxes } from "./scene.js";

export function highlightElements(mentions: readonly ShowRoomMention[]): ReturnType<typeof convertToExcalidrawElements> {
  const boxes = highlightBoxes(mentions);
  if (!boxes.length) return [];
  return convertToExcalidrawElements(boxes);
}
