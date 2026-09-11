/**
 * The viewer pool: read-only clients for rooms this process is not working in.
 *
 * One conversation is one room, and the model-facing tools act on that room
 * alone. The canvas widget is the exception. A host may route a widget's
 * `callServerTool` to a server process other than the one its conversation
 * uses - Claude Desktop routes every widget to one shared extension process,
 * and with Cowork the model's process runs in the VM while the widget runs on
 * the host - so a process is regularly asked to render a room it is not in.
 *
 * The old answer was for `show_room {link}` to join that room, which moved the
 * process. With two widgets polling one process that flipped the room every
 * two seconds, and drawings meant for one room landed in the other
 * (issue #92). A viewer answers the render instead: a second client, joined to
 * the named room with no handle and no presence, held only as long as
 * something keeps polling it, and never the room any tool writes to.
 *
 * The pool is bounded on both axes. At most {@link MAX_VIEWERS} rooms are held
 * at once - a request beyond that closes the least recently polled - and a
 * viewer nobody has polled for {@link VIEWER_IDLE_MS} is closed as well, on an
 * unref'd timer so a held viewer never keeps the process alive.
 */
import type { ExcalidrawElement } from "./elements.js";
import { RoomClient, type RoomStatus } from "./room.js";

/** How many rooms the pool watches at once before it evicts. */
export const MAX_VIEWERS = 8;

/** How long a viewer survives without being polled, in milliseconds. */
export const VIEWER_IDLE_MS = 5 * 60_000;

/**
 * The part of {@link RoomClient} a viewer is used through. Narrowed to these
 * members so the pool and the `show_room` resolution can be driven without a
 * socket.
 */
export interface ViewerClient {
  readonly isConnected: boolean;
  status(): RoomStatus;
  getElements(includeDeleted?: boolean): ExcalidrawElement[];
  join(link: string, opts?: { viewer?: boolean }): Promise<unknown>;
  leave(): void;
}

/** Seams for tests: what a viewer is, and how the idle timers are kept. */
export interface ViewerPoolDeps {
  /** Build a client for a new viewer. Defaults to a real {@link RoomClient}. */
  create?: () => ViewerClient;
  /** Start an idle timer. The default is an unref'd `setTimeout`. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  /** Cancel one of the above. */
  clearTimer?: (handle: unknown) => void;
  /** How many viewers to hold. Defaults to {@link MAX_VIEWERS}. */
  max?: number;
  /** Idle lifetime in milliseconds. Defaults to {@link VIEWER_IDLE_MS}. */
  idleMs?: number;
}

interface Entry {
  client: ViewerClient;
  timer: unknown;
}

/**
 * Viewers by room id, in least-recently-polled order: a poll deletes and
 * re-inserts its entry, so the Map's own order is the eviction order and the
 * first key is always the next one out.
 */
export class ViewerPool {
  private readonly viewers = new Map<string, Entry>();
  private readonly create: () => ViewerClient;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly max: number;
  private readonly idleMs: number;

  constructor(deps: ViewerPoolDeps = {}) {
    this.create = deps.create ?? (() => new RoomClient());
    this.setTimer =
      deps.setTimer ??
      ((fn, ms) => {
        const timer = setTimeout(fn, ms);
        timer.unref?.();
        return timer;
      });
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.max = deps.max ?? MAX_VIEWERS;
    this.idleMs = deps.idleMs ?? VIEWER_IDLE_MS;
  }

  /** The rooms currently watched, least recently polled first. */
  roomIds(): string[] {
    return [...this.viewers.keys()];
  }

  /** How many viewers are held. */
  get size(): number {
    return this.viewers.size;
  }

  /**
   * The viewer for a link, joined if this is the first request for that room
   * and reused otherwise. Every call counts as a poll: it restarts the idle
   * timer and makes this the last viewer the pool would evict.
   */
  async view(link: string): Promise<ViewerClient> {
    const { roomId } = RoomClient.parseLink(link);
    const held = this.viewers.get(roomId);
    if (held) {
      this.touch(roomId, held);
      return held.client;
    }
    const client = this.create();
    // Joined before it is recorded, so a room that cannot be reached leaves
    // nothing in the pool and no timer behind it.
    await client.join(link, { viewer: true });
    const entry: Entry = { client, timer: null };
    this.viewers.set(roomId, entry);
    this.touch(roomId, entry);
    this.evictBeyondMax();
    return client;
  }

  /** Close every viewer. The pool is empty afterwards. */
  closeAll(): void {
    for (const roomId of [...this.viewers.keys()]) this.closeRoom(roomId);
  }

  /**
   * Leave a room and forget it. Closing one that is not held is a no-op, which
   * is how a process that has just joined a room for itself drops the viewer
   * it may have been holding for it: one client per room, and the working one
   * wins.
   */
  closeRoom(roomId: string): void {
    const entry = this.viewers.get(roomId);
    if (!entry) return;
    this.clearTimer(entry.timer);
    this.viewers.delete(roomId);
    entry.client.leave();
  }

  /** Re-insert an entry as the most recently polled, and restart its idle timer. */
  private touch(roomId: string, entry: Entry): void {
    this.clearTimer(entry.timer);
    entry.timer = this.setTimer(() => this.closeRoom(roomId), this.idleMs);
    this.viewers.delete(roomId);
    this.viewers.set(roomId, entry);
  }

  /** Drop the least recently polled viewers until the pool is within bounds. */
  private evictBeyondMax(): void {
    while (this.viewers.size > this.max) {
      const oldest = this.viewers.keys().next();
      if (oldest.done) return;
      this.closeRoom(oldest.value);
    }
  }
}

/** The `viewers:` line of room_status: the rooms watched, or `-` when none. */
export function viewersLine(pool: Pick<ViewerPool, "roomIds">): string {
  const ids = pool.roomIds();
  return `viewers: ${ids.length ? ids.join(", ") : "-"}`;
}

/** Which client answers a `show_room` call, and why it is not the one asked for. */
export interface ShowRoomTarget {
  /** The client whose scene and status the result is built from. */
  client: ViewerClient;
  /** Whether that client is a viewer rather than this process's own room. */
  viewer: boolean;
  /** Why the link could not be viewed, or null when there was nothing to report. */
  error: string | null;
}

/** A link this pool cannot serve, worded for the `show_room` result. */
function notViewed(err: unknown): string {
  return `link not viewed: ${err instanceof Error ? err.message : String(err)}`;
}

/**
 * Pick the client that answers `show_room`.
 *
 * No link, or the link of the room this process is already in, is the current
 * room: that is the model's own path, and it is unchanged. Any other link is
 * served from the pool, so rendering a room never moves the process out of the
 * one its conversation is working in.
 */
export async function resolveShowRoom(
  current: ViewerClient,
  pool: Pick<ViewerPool, "view">,
  link: string | undefined,
): Promise<ShowRoomTarget> {
  if (!link) return { client: current, viewer: false, error: null };
  let roomId: string;
  try {
    roomId = RoomClient.parseLink(link).roomId;
  } catch (err) {
    return { client: current, viewer: false, error: notViewed(err) };
  }
  if (current.isConnected && current.status().roomId === roomId) {
    return { client: current, viewer: false, error: null };
  }
  try {
    return { client: await pool.view(link), viewer: true, error: null };
  } catch (err) {
    return { client: current, viewer: false, error: notViewed(err) };
  }
}
