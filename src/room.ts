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
 */
import { EventEmitter } from "node:events";
import { io, type Socket } from "socket.io-client";
import { decryptJson, encryptJson, generateRoomId, generateRoomKey } from "./crypto.js";
import type { ExcalidrawElement } from "./elements.js";
import { loadScene, saveScene, SceneConflictError } from "./firebase.js";
import { findMentions, isMentionText, type HandledVersions, type Mention } from "./mentions.js";
import { orderByIndex, reconcile, sceneVersion } from "./reconcile.js";

export const DEFAULT_SERVER_URL = "https://oss-collab.excalidraw.com";
export const DEFAULT_ORIGIN = "https://excalidraw.com";
const INIT_TIMEOUT_MS = 5000;
const RE_COLLAB_LINK = /#room=([a-zA-Z0-9_-]+),([a-zA-Z0-9_-]+)$/;

type Message =
  | { type: "SCENE_INIT" | "SCENE_UPDATE"; payload: { elements: ExcalidrawElement[] } }
  | { type: "MOUSE_LOCATION" | "IDLE_STATUS"; payload: { socketId?: string; username?: string } }
  | { type: "INVALID_RESPONSE" }
  | { type: string; payload?: unknown };

export interface RoomStatus {
  connected: boolean;
  roomId: string | null;
  link: string | null;
  peers: { socketId: string; username: string | null }[];
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
  private peers = new Map<string, string | null>();
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

  status(): RoomStatus {
    const all = [...this.elements.values()];
    return {
      connected: this.isConnected,
      roomId: this.roomId,
      link: this.link,
      peers: [...this.peers.entries()].map(([socketId, username]) => ({ socketId, username })),
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
    opts: { serverUrl?: string; origin?: string; initTimeoutMs?: number } = {},
  ): Promise<RoomStatus> {
    if (this.socket) this.leave();
    const { roomId, roomKey } = RoomClient.parseLink(link);
    this.roomId = roomId;
    this.roomKey = roomKey;
    this.serverUrl = opts.serverUrl ?? DEFAULT_SERVER_URL;
    this.elements.clear();
    this.peers.clear();
    this.source = null;
    this.storedUpdateTime = null;

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
        await this.loadFromFirestore().catch((err) => log("firestore load failed", err));
        if (this.source === null) this.source = "empty";
        done();
      });
      socket.on("new-user", (socketId: string) => {
        log("new-user", socketId);
        void this.broadcast("SCENE_INIT", this.getElements(true));
      });
      socket.on("room-user-change", (clients: string[]) => {
        const me = socket.id;
        const next = new Map<string, string | null>();
        for (const id of clients) {
          if (id !== me) next.set(id, this.peers.get(id) ?? null);
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
            const p = (msg as { payload: { socketId?: string; username?: string } }).payload;
            if (p.socketId && this.peers.has(p.socketId) && p.username) {
              this.peers.set(p.socketId, p.username);
            }
            break;
          }
          default:
            break;
        }
      });
    });

    await initialised;
    this.emit("joined", this.status());
    return this.status();
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
   * Resolve with the first pending mention of `tag`, or null after `timeoutMs`.
   * A mention counts once it has been quiet for `settleMs` (Excalidraw
   * broadcasts every keystroke, so "@claude" alone would otherwise fire before
   * the instruction is typed).
   */
  async waitForMention(
    tag: string,
    handled: HandledVersions,
    opts: { timeoutMs?: number; settleMs?: number } = {},
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
      const pending = findMentions(this.getElements(), tag, handled);
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
    if (!this.socket || !this.roomId || !this.roomKey) throw new Error("not in a room");
    const { ciphertext, iv } = await encryptJson(this.roomKey, { type, payload: { elements } });
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
    this.socket?.close();
    this.socket = null;
    this.roomId = null;
    this.roomKey = null;
    this.peers.clear();
    this.source = null;
  }
}
