/**
 * Ownership guard: whether an element belongs to another agent that is still
 * working in the room.
 *
 * Two agents on one board diverge the moment one of them rearranges or deletes
 * the other's work while that other is mid-task, because each then reasons from
 * a scene the other has already changed. The rule that stops it is narrow on
 * purpose. Only an element stamped with the handle of an agent peer *currently*
 * present is protected: an agent that has left cannot be surprised, and a
 * person's drawing carries no stamp at all, so a person's board stays fully
 * editable by the agents they invited.
 *
 * Pure functions only. The caller supplies the present agent handles
 * (`RoomClient.status().peers` filtered to `kind: "agent"`) and its own handle;
 * nothing here reads the room.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/93
 */
import { elementAuthor, type ExcalidrawElement } from "./elements.js";

/** An edit the guard turned down, and the handle it belongs to. */
export interface Refusal {
  id: string;
  owner: string;
}

/**
 * The handle protecting `el`, or null when the edit is free to proceed.
 *
 * Null for a person-drawn element (no author), for an author that has left the
 * room, and for this server's own work - an agent is never guarded against
 * itself, even though its own handle may appear among the peers.
 */
export function protectedBy(
  el: ExcalidrawElement,
  presentAgentHandles: Iterable<string>,
  myHandle: string | null | undefined,
): string | null {
  const author = elementAuthor(el);
  if (author === null) return null;
  if (myHandle && author === myHandle) return null;
  for (const handle of presentAgentHandles) if (handle === author) return author;
  return null;
}

/**
 * One line per refused edit, in the order the ids were asked for, so a caller
 * reading the result text can see both what it may not touch and who to ask.
 */
export function refusalLines(refusals: readonly Refusal[]): string {
  return refusals.map((r) => `refused ${r.id} (owned by ${r.owner})`).join("\n");
}

/**
 * How a forced edit reports itself. `force` is an override of another agent's
 * ownership, not a quiet fast path, so the result says whose work was written
 * over: the operator reading the transcript is the one who can tell the other
 * agent.
 */
export function forcedLine(refusals: readonly Refusal[]): string {
  const owners = [...new Set(refusals.map((r) => r.owner))].sort();
  return `forced ${refusals.length} edit(s) to elements owned by ${owners.join(", ")}`;
}
