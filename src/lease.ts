/**
 * The listening lease: which caller on this connection is waiting for
 * mentions.
 *
 * One server process is one room peer with one handle, and a subagent borrows
 * its parent session's connection, so every agent under a lead is the same
 * peer. `RoomClient.waitForMention` settles on the first pending note and hands
 * it to whoever is waiting, with no notion of who that is: when a lead spawns
 * the listener subagent and then waits itself, both are handed the same note,
 * both draw and both acknowledge, and the person gets two edits for one
 * request. Nothing in the tool surface reported that it had happened.
 *
 * The lease is the gate in front of that wait. One name holds it at a time;
 * the same name renews it; a different name is turned away with a normal
 * result naming the holder. The hold runs to the in-flight wait's own deadline
 * plus {@link LISTEN_LEASE_GRACE_MS}, so a legitimate 600-second wait is never
 * mistaken for a stale one, and a listener that was killed mid-wait frees the
 * lease by simply not calling again.
 *
 * Pure state with the clock injected; nothing here reads the room or the
 * wall clock on its own. `src/index.ts` holds the single instance beside the
 * handled and acknowledged maps.
 *
 * There is deliberately no reset, and a join does not clear the lease. The
 * handled maps are about notes on one canvas, so a join empties them; the
 * lease is about who on this connection is waiting, which a change of room
 * does not answer. It cannot be cleared on join without reopening the hole it
 * closes: `RoomClient.leave` does not remove the `"scene"` listener that
 * `waitForMention` attaches, so a wait in flight when the process moves rooms
 * keeps looping against the new room's elements until its own deadline. Were
 * the lease freed at that moment, a fresh caller would take it under any name
 * and both waits would be live in the new room - the exact double-delivery
 * this module exists to prevent. Tying the hold to the wait's own deadline
 * covers that case for free: the lease lapses when the wait it gated can no
 * longer return, whichever room that wait ended up in.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/133
 */

/**
 * The name a caller that did not give one listens under.
 *
 * Defaulting rather than requiring a name keeps a bare `mention_wait` working -
 * the server's own instructions tell a lead to call it that way - and still
 * refuses the second anonymous caller, because both collide here.
 */
export const DEFAULT_LISTENER = "lead";

/**
 * How long a lease outlives the deadline of the wait it was taken for.
 *
 * It covers the round trip between one wait returning and the same listener
 * calling again: long enough that a listener acting on a note it was just
 * handed does not lose its place, short enough that a crashed one is replaced
 * within half a minute.
 */
export const LISTEN_LEASE_GRACE_MS = 30_000;

/**
 * A listener name is letters, digits, underscores and hyphens, 1 to 64
 * characters - the handle grammar of src/handle.ts widened to the casing an
 * agent name is written in.
 *
 * The grammar is a safety boundary, not a style preference. The name is echoed
 * verbatim into `leaseLine`, which is one line of `room_status`, and into
 * `refusalText`: a name carrying a newline would forge a further status line,
 * so `"worker\nlistening: none"` could make a held lease read as a free one.
 */
export const LISTENER_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidListener(listener: string): boolean {
  return LISTENER_PATTERN.test(listener);
}

/** The lease was taken or renewed under the asked-for name. */
export interface LeaseGranted {
  granted: true;
}

/** The lease is held by somebody else, with this long left on the current hold. */
export interface LeaseRefused {
  granted: false;
  listener: string;
  secondsRemaining: number;
}

export type LeaseClaim = LeaseGranted | LeaseRefused;

/** Who is listening and for how much longer, as `room_status` reports it. */
export interface LeaseHolder {
  listener: string;
  secondsRemaining: number;
}

/**
 * The single listening lease of one server process.
 *
 * `now` is injected so the expiry and the grace window are exercised by moving
 * a fake clock rather than by waiting out real seconds.
 */
export class ListenLease {
  private listener: string | null = null;
  private expiresAt = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Take or renew the lease for a wait of `waitMs`, or refuse.
   *
   * A refused claim changes nothing: the holder keeps the deadline it set, so
   * a second caller polling in a loop cannot extend or shorten the first one's
   * hold.
   */
  claim(listener: string, waitMs: number): LeaseClaim {
    const t = this.now();
    if (this.listener !== null && this.listener !== listener && this.expiresAt > t) {
      return { granted: false, listener: this.listener, secondsRemaining: remaining(this.expiresAt, t) };
    }
    this.listener = listener;
    this.expiresAt = t + waitMs + LISTEN_LEASE_GRACE_MS;
    return { granted: true };
  }

  /** The live holder, or null once the hold has run out. */
  current(): LeaseHolder | null {
    const t = this.now();
    if (this.listener === null || this.expiresAt <= t) return null;
    return { listener: this.listener, secondsRemaining: remaining(this.expiresAt, t) };
  }

}

function remaining(expiresAt: number, now: number): number {
  return Math.ceil((expiresAt - now) / 1000);
}

/** The lease as `room_status` prints it. */
export function leaseLine(lease: ListenLease): string {
  const held = lease.current();
  return held ? `listening: ${held.listener} (${held.secondsRemaining}s remaining)` : "listening: none";
}

/**
 * What a turned-away caller reads.
 *
 * A normal result rather than a protocol error, because a second waiter is a
 * mistake to surface to the model, not a transport fault: it says who has the
 * turn, and where to read pending notes without taking it.
 */
export function refusalText(refusal: LeaseRefused): string {
  return [
    `${refusal.listener} is listening for mentions on this connection`,
    `(lease frees itself in ${refusal.secondsRemaining}s if that listener stops calling).`,
    "One caller waits at a time, or one note is handed to two agents.",
    "Use mention_list to read pending mentions without waiting;",
    "mention_acknowledge and the scene tools work without the lease.",
  ].join(" ");
}

/** The outcome of a wait attempted under the lease. */
export type LeaseOutcome<T> = { granted: true; value: T } | { granted: false; text: string };

/**
 * Run `wait` holding the lease, or refuse before it starts.
 *
 * The gate is in front of the wait rather than around it: a refused caller
 * returns at once with the refusal text instead of blocking out its own
 * timeout and then finding it was never listening.
 */
export async function waitUnderLease<T>(
  lease: ListenLease,
  listener: string,
  waitMs: number,
  wait: () => Promise<T>,
): Promise<LeaseOutcome<T>> {
  const claim = lease.claim(listener, waitMs);
  if (!claim.granted) return { granted: false, text: refusalText(claim) };
  return { granted: true, value: await wait() };
}
