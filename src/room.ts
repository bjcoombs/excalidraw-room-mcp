/**
 * Headless participant in an Excalidraw live-collaboration room.
 *
 * Protocol (excalidraw-room relay, socket.io):
 *   server -> "init-room"                       we reply "join-room" roomId
 *   server -> "first-in-room"                   nobody else here: load scene from Firestore
 *   server -> "new-user" socketId               a peer joined: send them SCENE_INIT
 *   server -> "room-user-change" socketId[]     current participants
 *   server -> "client-broadcast" cipher, iv     an encrypted message from a peer
 *   we     -> "server-broadcast" roomId, cipher, iv
 *
 * Every payload is JSON {type, payload} encrypted with the room key. Types
 * we act on: SCENE_INIT and SCENE_UPDATE carry {elements}. MOUSE_LOCATION and
 * IDLE_STATUS carry a username we keep for status reporting.
 *
 * Presence. A peer's name reaches the room only in its own MOUSE_LOCATION and
 * IDLE_STATUS broadcasts, so a headless client that never sends one is drawn
 * as an anonymous cursor. We send the same two messages upstream sends, with
 * the payload keys from excalidraw-app's SocketUpdateDataSource
 * (excalidraw/excalidraw, excalidraw-app/data/index.ts at commit
 * 6c908553a9cbd2e50bfabc49bc6045c5ba97d702):
 *   MOUSE_LOCATION {socketId, pointer: {x, y, tool}, button, selectedElementIds, username}
 *   IDLE_STATUS    {socketId, userState, username}
 * on join, again whenever a "new-user" arrives, and IDLE_STATUS every 30 s so
 * a browser that joins later still learns the name. excalidraw-app's receiver
 * (excalidraw-app/collab/Collab.tsx, same commit) destructures only the keys
 * above, so the extra `customData` marker we add to our own payload is
 * ignored there and lets other agents tell us from a browser.
 */
import { EventEmitter } from "node:events";
import { io, type Socket } from "socket.io-client";
import { decryptJson, encryptJson, generateRoomId, generateRoomKey } from "./crypto.js";
import { defaultHandle, isValidHandle, uniqueHandle } from "./handle.js";
import type { ExcalidrawElement } from "./elements.js";
import { loadScene, saveScene, SceneConflictError } from "./firebase.js";
import { DEFAULT_NEARBY_RADIUS, findMentions, isMentionText, type HandledVersions, type Mention } from "./mentions.js";
import { orderByIndex, reconcile, sceneVersion } from "./reconcile.js";

export const DEFAULT_SERVER_URL = "https://oss-collab.excalidraw.com";
export const DEFAULT_ORIGIN = "https://excalidraw.com";
const INIT_TIMEOUT_MS = 5000;
/** How long a joining client waits for the presence of the peers already here. */
const HANDLE_WAIT_MS = 1500;
/** Presence refresh, so a browser that joins later still learns our name. */
const IDLE_BROADCAST_MS = 30_000;
/**
 * Key we add to our own presence payload. Upstream ignores unknown payload
 * keys (see the header), so this rides along and marks the sender as another
 * server of this kind rather than a person in a browser.
 */
const AGENT_MARKER = "excalidrawRoomAgent";
const RE_COLLAB_LINK = /#room=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/;

type Message =
  | { type: "SCENE_INIT" | "SCENE_UPDATE"; payload: { elements: ExcalidrawElement[] } }
  | {
      type: "MOUSE_LOCATION" | "IDLE_STATUS";
      payload: { socketId?: string; username?: string; customData?: Record<string, unknown> };
    }
  | { type: "INVALID_RESPONSE" }
  | { type: string; payload?: unknown };

/** A participant in the room, as far as its presence broadcasts have told us. */
export interface RoomPeer {
  socketId: string;
  username: string | null;
  /** An agent is a peer whose presence carried our marker and a valid handle. */
  kind: "agent" | "browser";
}

export interface RoomStatus {
  connected: boolean;
  roomId: string | null;
  link: string | null;
  handle: string | null;
  /** The room's neighbourhood radius, in canvas px. */
  nearbyRadius: number;
  peers: RoomPeer[];
  elementCount: number;
  deletedCount: number;
  sceneVersion: number;
  lastRemoteUpdate: string | null;
  source: "peer" | "firestore" | "empty" | null;
}

function log(...args: unknown[]): void {
  if (process.env.EXCALIDRAW_ROOM_DEBUG) console.error("[room]", ...args);
}

export class RoomClient extends EventEmitter {
  private socket: Socket | null = null;
  private roomId: string | null = null;
  private roomKey: string | null = null;
  private elements = new Map<string, ExcalidrawElement>();
  private peers = new Map<string, { username: string | null; agent: boolean }>();
  /** The handle asked for on join, before any clash suffix. */
  private desiredHandle: string = defaultHandle();
  /** The handle actually taken in this room; null until we are in one. */
  private currentHandle: string | null = null;
  /**
   * How far a neighbourhood query reaches in this room, in canvas px. One
   * number for the room, so the layout a placement chooses and the context a
   * mention pulls in are measured with the same tape.
   */
  private roomRadius: number = DEFAULT_NEARBY_RADIUS;
  private presenceTimer: NodeJS.Timeout | null = null;
  private firstInRoom = false;
  private lastRemoteUpdate: number | null = null;
  private source: RoomStatus["source"] = null;
  private serverUrl = DEFAULT_SERVER_URL;
  /** Update time of the Firestore document we last read or wrote; null if unknown or absent. */
  private storedUpdateTime: string | null = null;

  static parseLink(link: string): { roomId: string; roomKey: string } {
    const trimmed = link.trim();
    const m = trimmed.match(RE_COLLAB_LINK) ?? trimmed.match(/^([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/);
    if (!m) throw new Error("not a collaboration link: expected ...#room=<roomId>,<roomKey>");
    if (m[2].length !== 22) throw new Error("invalid room key length");
    return { roomId: m[1], roomKey: m[2] };
  }

  static async createLink(): Promise<string> {
    return `https://excalidraw.com/#room=${generateRoomId()},${await generateRoomKey()}`;
  }

  get link(): string | null {
    return this.roomId && this.roomKey ? `https://excalidraw.com/#room=${this.roomId},${this.roomKey}` : null;
  }

  get isConnected(): boolean {
    return !!this.socket?.connected && !!this.roomId;
  }

  /** The handle taken in the current room, for other tools in this process. */
  get handle(): string | null {
    return this.currentHandle;
  }

  /** The neighbourhood radius agreed for this room, for the other tools. */
  get nearbyRadius(): number {
    return this.roomRadius;
  }

  status(): RoomStatus {
    const all = [...this.elements.values()];
    return {
      connected: this.isConnected,
      roomId: this.roomId,
      link: this.link,
      handle: this.currentHandle,
      nearbyRadius: this.roomRadius,
      peers: [...this.peers.entries()].map(([socketId, peer]) => ({
        socketId,
        username: peer.username,
        kind: peer.agent ? ("agent" as const) : ("browser" as const),
      })),
      elementCount: all.filter((e) => !e.isDeleted).length,
      deletedCount: all.filter((e) => e.isDeleted).length,
      sceneVersion: sceneVersion(all),
      lastRemoteUpdate: this.lastRemoteUpdate ? new Date(this.lastRemoteUpdate).toISOString() : null,
      source: this.source,
    };
  }

  getElements(includeDeleted = false): ExcalidrawElement[] {
    const all = orderByIndex([...this.elements.values()]);
    return includeDeleted ? all : all.filter((e) => !e.isDeleted);
  }

  getElement(id: string): ExcalidrawElement | undefined {
    return this.elements.get(id);
  }

  lastIndex(): string | null {
    const ordered = this.getElements(true);
    const last = ordered[ordered.length - 1];
    return (last?.index as string | undefined) ?? null;
  }

  async join(
    link: string,
    opts: {
      serverUrl?: string;
      origin?: string;
      initTimeoutMs?: number;
      /** Name to present in the room. Invalid handles are refused here. */
      handle?: string;
      handleWaitMs?: number;
      /** Neighbourhood radius for this room, in canvas px. */
      nearbyRadius?: number;
    } = {},
  ): Promise<RoomStatus> {
    if (opts.handle !== undefined && !isValidHandle(opts.handle)) {
      throw new Error(`invalid handle ${JSON.stringify(opts.handle)}`);
    }
    if (this.socket) this.leave();
    const { roomId, roomKey } = RoomClient.parseLink(link);
    this.roomId = roomId;
    this.roomKey = roomKey;
    this.serverUrl = opts.serverUrl ?? DEFAULT_SERVER_URL;
    this.elements.clear();
    this.peers.clear();
    this.source = null;
    this.storedUpdateTime = null;
    this.desiredHandle = opts.handle ?? defaultHandle();
    this.currentHandle = null;
    this.roomRadius = opts.nearbyRadius ?? DEFAULT_NEARBY_RADIUS;
    this.firstInRoom = false;

    // The public relay rejects handshakes without a browser Origin (400 on
    // websocket, 403 on polling), so present the app's origin.
    const socket = io(this.serverUrl, {
      transports: ["websocket", "polling"],
      extraHeaders: { Origin: opts.origin ?? DEFAULT_ORIGIN },
    });
    this.socket = socket;

    let settled = false;
    const initialised = new Promise<void>((resolve, reject) => {
      const done = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      };
      const timer = setTimeout(async () => {
        // Peers present but no SCENE_INIT arrived: fall back to Firestore.
        if (!settled) {
          log("init timeout, loading from firestore");
          await this.loadFromFirestore().catch((err) => log("firestore fallback failed", err));
          done();
        }
      }, opts.initTimeoutMs ?? INIT_TIMEOUT_MS);

      socket.on("connect_error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`relay connection failed: ${err.message}`));
        }
      });
      socket.on("init-room", () => {
        log("init-room, joining", roomId);
        socket.emit("join-room", roomId);
      });
      socket.on("first-in-room", async () => {
        log("first-in-room");
        this.firstInRoom = true;
        await this.loadFromFirestore().catch((err) => log("firestore load failed", err));
        if (this.source === null) this.source = "empty";
        done();
      });
      socket.on("new-user", (socketId: string) => {
        log("new-user", socketId);
        void this.broadcast("SCENE_INIT", this.getElements(true));
        // A peer learns our name only from a presence message it was there to
        // receive, so send one to whoever just arrived.
        void this.broadcastPresence("MOUSE_LOCATION");
      });
      socket.on("room-user-change", (clients: string[]) => {
        const me = socket.id;
        const next = new Map<string, { username: string | null; agent: boolean }>();
        for (const id of clients) {
          if (id !== me) next.set(id, this.peers.get(id) ?? { username: null, agent: false });
        }
        this.peers = next;
        this.emit("peers", this.status().peers);
      });
      socket.on("client-broadcast", async (cipher: ArrayBuffer | Uint8Array, iv: Uint8Array) => {
        if (!this.roomKey) return;
        let msg: Message;
        try {
          msg = await decryptJson<Message>(this.roomKey, new Uint8Array(iv), cipher);
        } catch (err) {
          log("decrypt failed", err);
          return;
        }
        switch (msg.type) {
          case "SCENE_INIT":
          case "SCENE_UPDATE": {
            const incoming = (msg as { payload: { elements: ExcalidrawElement[] } }).payload.elements;
            this.mergeRemote(incoming);
            if (msg.type === "SCENE_INIT" && this.source === null) this.source = "peer";
            done();
            break;
          }
          case "MOUSE_LOCATION":
          case "IDLE_STATUS": {
            // Presence can outrun room-user-change, so take the sender on its
            // own word; the next room-user-change drops anyone who has left.
            this.notePresence(
              (msg as { payload: { socketId?: string; username?: string; customData?: Record<string, unknown> } })
                .payload,
            );
            break;
          }
          default:
            break;
        }
      });
    });

    await initialised;
    // Names arrive with the presence of the peers already here, so a handle
    // can only be made unique once we have heard from them.
    if (!this.firstInRoom) await this.awaitPeerPresence(opts.handleWaitMs ?? HANDLE_WAIT_MS);
    this.currentHandle = uniqueHandle(this.desiredHandle, this.agentHandles());
    await this.broadcastPresence("MOUSE_LOCATION").catch((err) => log("presence failed", err));
    this.presenceTimer = setInterval(() => {
      void this.broadcastPresence("IDLE_STATUS").catch((err) => log("presence refresh failed", err));
    }, IDLE_BROADCAST_MS);
    this.presenceTimer.unref();
    this.emit("joined", this.status());
    return this.status();
  }

  /** Record a peer's name, and whether its presence marks it as an agent. */
  private notePresence(p: { socketId?: string; username?: string; customData?: Record<string, unknown> }): void {
    if (!p.socketId || p.socketId === this.socket?.id) return;
    const peer = this.peers.get(p.socketId) ?? { username: null, agent: false };
    if (p.username) peer.username = p.username;
    if (p.customData?.[AGENT_MARKER] === true && !!p.username && isValidHandle(p.username)) peer.agent = true;
    this.peers.set(p.socketId, peer);
    this.emit("peers", this.status().peers);
  }

  /**
   * The handles of the agents currently in the room. Used both to make a
   * joining handle unique and by the ownership guard, which protects an
   * element only while the agent that stamped it is still here.
   */
  agentHandles(): string[] {
    const names: string[] = [];
    for (const peer of this.peers.values()) if (peer.agent && peer.username) names.push(peer.username);
    return names;
  }

  /**
   * Resolve once every known peer has named itself, or after `ms`. A browser
   * sitting idle may never send presence, which is why this is a deadline and
   * not a condition.
   */
  private async awaitPeerPresence(ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
      const peers = [...this.peers.values()];
      if (peers.length > 0 && peers.every((p) => p.username !== null)) return;
      if (Date.now() >= deadline) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /**
   * Announce ourselves the way a browser does. See the header for the payload
   * keys and where they come from.
   */
  private async broadcastPresence(type: "MOUSE_LOCATION" | "IDLE_STATUS"): Promise<void> {
    const socketId = this.socket?.id;
    if (!socketId || !this.currentHandle) return;
    const common = {
      socketId,
      username: this.currentHandle,
      customData: { [AGENT_MARKER]: true },
    };
    const payload =
      type === "MOUSE_LOCATION"
        ? { ...common, pointer: { x: 0, y: 0, tool: "pointer" }, button: "up", selectedElementIds: {} }
        : { ...common, userState: "idle" };
    await this.emitEncrypted({ type, payload });
  }

  private async loadFromFirestore(): Promise<void> {
    if (!this.roomId || !this.roomKey) return;
    const stored = await loadScene(this.roomId, this.roomKey);
    if (stored) {
      this.mergeRemote(stored.elements);
      this.storedUpdateTime = stored.updateTime;
      if (this.source === null) this.source = "firestore";
      log("loaded", stored.elements.length, "elements from firestore");
    } else {
      this.storedUpdateTime = null;
    }
  }

  /**
   * Conditional save. If another client wrote since we last read (or the
   * document appeared), reload it, reconcile into our scene, and retry once.
   */
  private async persist(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const all = this.getElements(true);
      try {
        this.storedUpdateTime = await saveScene(
          this.roomId!,
          this.roomKey!,
          all,
          sceneVersion(all),
          this.storedUpdateTime,
        );
        return;
      } catch (err) {
        if (!(err instanceof SceneConflictError) || attempt === 1) throw err;
        log("persist conflict, reloading and retrying");
        await this.loadFromFirestore();
      }
    }
  }

  /**
   * Apply elements as if a peer had broadcast them. This is the same path the
   * socket uses; exposed so tests and embedders can drive the client without a
   * relay.
   */
  ingestRemote(incoming: ExcalidrawElement[]): void {
    this.mergeRemote(incoming);
  }

  /**
   * Resolve with the first pending mention of `tag` (one tag or any of
   * several), or null after `timeoutMs`. `accept` narrows which mentions
   * count, by author.
   * A mention counts once it has been quiet for `settleMs` (Excalidraw
   * broadcasts every keystroke, so "@claude" alone would otherwise fire before
   * the instruction is typed).
   */
  async waitForMention(
    tag: string | readonly string[],
    handled: HandledVersions,
    opts: { timeoutMs?: number; settleMs?: number; accept?: (mention: Mention) => boolean } = {},
  ): Promise<Mention | null> {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const settleMs = opts.settleMs ?? 1500;
    const deadline = Date.now() + timeoutMs;

    const settled = async (candidate: Mention): Promise<Mention | null> => {
      // Wait until the element stops changing, then re-read it.
      for (;;) {
        await new Promise((r) => setTimeout(r, settleMs));
        const now = this.elements.get(candidate.id);
        if (!now || now.isDeleted || !isMentionText(now.text, tag)) return null;
        if (now.version === candidate.version) return candidate;
        candidate = findMentions([now], tag, handled)[0] ?? candidate;
        if (Date.now() > deadline) return candidate;
      }
    };

    for (;;) {
      const all = findMentions(this.getElements(), tag, handled);
      // The caller decides which authors it answers, and a note it does not
      // answer must not end the wait: dropping it after the settle would
      // return "no mention" while another agent's note sat unread, so the
      // filter is applied before anything is waited on.
      const pending = opts.accept ? all.filter(opts.accept) : all;
      if (pending.length) {
        const ready = await settled(pending[0]);
        if (ready) return ready;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const changed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          this.off("scene", onScene);
          resolve(false);
        }, remaining);
        const onScene = () => {
          clearTimeout(timer);
          resolve(true);
        };
        this.once("scene", onScene);
      });
      if (!changed) return null;
    }
  }

  private mergeRemote(incoming: ExcalidrawElement[]): void {
    const merged = reconcile([...this.elements.values()], incoming);
    this.elements = new Map(merged.map((e) => [e.id, e]));
    this.lastRemoteUpdate = Date.now();
    this.emit("scene", this.getElements());
  }

  private async broadcast(type: "SCENE_INIT" | "SCENE_UPDATE", elements: ExcalidrawElement[]): Promise<void> {
    await this.emitEncrypted({ type, payload: { elements } });
  }

  private async emitEncrypted(message: { type: string; payload: unknown }): Promise<void> {
    if (!this.socket || !this.roomId || !this.roomKey) throw new Error("not in a room");
    const { ciphertext, iv } = await encryptJson(this.roomKey, message);
    this.socket.emit("server-broadcast", this.roomId, ciphertext, iv);
  }

  /**
   * Apply local edits: store them, broadcast to peers, and persist. Elements
   * must already carry bumped versions (see elements.bump).
   */
  async commit(changed: ExcalidrawElement[]): Promise<{ persisted: boolean; error?: string }> {
    if (!this.isConnected) throw new Error("not in a room; call join_room first");
    const ids = new Set<string>();
    for (const el of changed) {
      if (!el.id) throw new Error("element without an id in commit");
      if (ids.has(el.id)) throw new Error(`duplicate element id in commit: ${el.id}`);
      ids.add(el.id);
    }
    for (const el of changed) this.elements.set(el.id, el);
    await this.broadcast("SCENE_UPDATE", changed);
    try {
      await this.persist();
      return { persisted: true };
    } catch (err) {
      log("persist failed", err);
      return { persisted: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  leave(): void {
    if (this.presenceTimer) clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    this.socket?.close();
    this.socket = null;
    this.roomId = null;
    this.roomKey = null;
    this.peers.clear();
    this.currentHandle = null;
    this.firstInRoom = false;
    this.source = null;
  }
}
