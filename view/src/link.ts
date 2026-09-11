/**
 * The room this canvas belongs to, and the guard that keeps another room off
 * it.
 *
 * One conversation is one room. The widget cannot assume the process that
 * answers its polls is the one its conversation uses: Claude Desktop routes
 * every widget's `callServerTool` to one shared extension process, and in
 * Cowork the model's process runs in the VM while the widget runs on the host.
 * A widget that painted whatever arrived therefore showed another
 * conversation's room (issue #92).
 *
 * So the link the widget is seeded with is the room it is for, for as long as
 * it lives, and a payload for any other room is refused with a line saying so
 * rather than drawn. The server side of the same fix serves the asked-for room
 * from a read-only viewer, so in practice the refusal is the backstop for a
 * host that drops the link argument, not the normal path.
 */

/** What the bar says while the widget has no room to show. */
export const WAITING_FOR_LINK_TEXT = "Waiting for a room link. Ask for show_room once the room is joined.";

/**
 * The room id in a collaboration link: the part between `#room=` and the
 * comma. `RoomClient.parseLink` reads the same format server-side and is not
 * importable here - the view is a browser bundle with no Node module in it -
 * so the format is pinned in both places, as NOT_IN_ROOM_TEXT is.
 */
export function roomIdOf(link: string | null): string | null {
  if (!link) return null;
  const match = /#room=([a-zA-Z0-9_-]+),/.exec(link);
  return match ? match[1] : null;
}

/** Whether two links name the same room. */
export function sameRoom(a: string | null, b: string | null): boolean {
  const left = roomIdOf(a);
  return left !== null && left === roomIdOf(b);
}

/** The refusal line, naming both rooms so an operator can see which host did it. */
export function mismatchText(seeded: string | null, received: string | null): string {
  return `The host returned another room: this canvas is for ${roomIdOf(seeded) ?? "-"}, the server answered with ${roomIdOf(received) ?? "no room"}.`;
}

/**
 * Why a payload must not be painted on a canvas seeded with `seeded`, or null
 * when it may be.
 *
 * With no seeded link there is no room to show and nothing is painted; the
 * widget waits for one. With one, only that room's payload is drawn, and the
 * returned line is what the status bar says instead.
 */
export function paintRefusal(seeded: string | null, received: string | null): string | null {
  if (!roomIdOf(seeded)) return WAITING_FOR_LINK_TEXT;
  return sameRoom(seeded, received) ? null : mismatchText(seeded, received);
}
