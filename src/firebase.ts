/**
 * Room persistence. excalidraw.com stores each room's scene, encrypted with
 * the room key, in a Firestore document at scenes/{roomId}.
 *
 * DEFAULT_PROJECT and DEFAULT_API_KEY below are excalidraw.com's own public
 * client configuration, copied verbatim from `VITE_APP_FIREBASE_CONFIG` in
 * `.env.production` of github.com/excalidraw/excalidraw (commit
 * 14d512f32136b376707ed2a3f5af90d6c262d461). A Firebase web API key is a
 * project identifier that every visitor already receives in the web app's
 * bundle, not a credential: it names the project the request goes to, and
 * reading a scene still requires the room key, without which the document is
 * ciphertext. Do not "fix" this value by removing it.
 *
 * A self-hosted deployment points at its own project with the
 * EXCALIDRAW_FIREBASE_PROJECT and EXCALIDRAW_FIREBASE_API_KEY environment
 * variables, read per request so nothing has to be set before import.
 *
 * Writes are conditional on the document's update time (or on it not existing
 * yet), so a stale client cannot overwrite a newer scene. On a conflict the
 * caller reloads, reconciles, and retries; see RoomClient.persist.
 */
import { decryptJson, encryptJson } from "./crypto.js";
import type { ExcalidrawElement } from "./elements.js";

const DEFAULT_PROJECT = "excalidraw-room-persistence";
const DEFAULT_API_KEY = "AIzaSyAd15pYlMci_xIp9ko6wkEsDzAAA0Dn0RU";

function docUrl(roomId: string, params: Record<string, string> = {}): string {
  const project = process.env.EXCALIDRAW_FIREBASE_PROJECT ?? DEFAULT_PROJECT;
  const apiKey = process.env.EXCALIDRAW_FIREBASE_API_KEY ?? DEFAULT_API_KEY;
  const qs = new URLSearchParams({ key: apiKey, ...params });
  return `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/scenes/${roomId}?${qs}`;
}

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  return Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64");
}

export interface StoredScene {
  sceneVersion: number;
  elements: ExcalidrawElement[];
  /** Firestore document update time; pass back to saveScene as the precondition. */
  updateTime: string;
}

export class SceneConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneConflictError";
  }
}

interface SceneDocument {
  updateTime: string;
  fields: {
    sceneVersion: { integerValue: string };
    ciphertext: { bytesValue: string };
    iv: { bytesValue: string };
  };
}

export async function loadScene(roomId: string, roomKey: string): Promise<StoredScene | null> {
  const res = await fetch(docUrl(roomId));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`firestore read failed: ${res.status} ${await res.text()}`);
  const doc = (await res.json()) as SceneDocument;
  const ciphertext = Buffer.from(doc.fields.ciphertext.bytesValue, "base64");
  const iv = Buffer.from(doc.fields.iv.bytesValue, "base64");
  const elements = await decryptJson<ExcalidrawElement[]>(roomKey, iv, ciphertext);
  return { sceneVersion: Number(doc.fields.sceneVersion.integerValue), elements, updateTime: doc.updateTime };
}

/**
 * Write the scene, guarded by a precondition: `expectedUpdateTime` must match
 * the stored document's update time, or, when null, the document must not
 * exist. Returns the new update time. Throws SceneConflictError when the
 * precondition fails.
 */
export async function saveScene(
  roomId: string,
  roomKey: string,
  elements: readonly ExcalidrawElement[],
  sceneVersion: number,
  expectedUpdateTime: string | null,
): Promise<string> {
  const { ciphertext, iv } = await encryptJson(roomKey, elements);
  const body = {
    fields: {
      sceneVersion: { integerValue: String(sceneVersion) },
      ciphertext: { bytesValue: toBase64(ciphertext) },
      iv: { bytesValue: toBase64(iv) },
    },
  };
  const precondition: Record<string, string> =
    expectedUpdateTime === null
      ? { "currentDocument.exists": "false" }
      : { "currentDocument.updateTime": expectedUpdateTime };
  const res = await fetch(docUrl(roomId, precondition), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) {
    const doc = (await res.json()) as SceneDocument;
    return doc.updateTime;
  }
  const detail = await res.text();
  if (res.status === 412 || res.status === 409 || detail.includes("FAILED_PRECONDITION") || detail.includes("ALREADY_EXISTS")) {
    throw new SceneConflictError(`scene changed underneath us: ${res.status} ${detail.slice(0, 200)}`);
  }
  throw new Error(`firestore write failed: ${res.status} ${detail.slice(0, 200)}`);
}
