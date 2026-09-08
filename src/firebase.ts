/**
 * Room persistence. excalidraw.com stores each room's scene, encrypted with
 * the room key, in a Firestore document at scenes/{roomId}. This is the same
 * public project and API key the web app ships in its bundle; the key only
 * identifies the project, it grants nothing. Without the room key the document
 * is ciphertext.
 */
import { decryptJson, encryptJson } from "./crypto.js";
import type { ExcalidrawElement } from "./elements.js";

const PROJECT = "excalidraw-room-persistence";
const API_KEY = "AIzaSyAd15pYlMci_xIp9ko6wkEsDzAAA0Dn0RU";

function docUrl(roomId: string): string {
  return `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/scenes/${roomId}?key=${API_KEY}`;
}

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  return Buffer.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf)).toString("base64");
}

export interface StoredScene {
  sceneVersion: number;
  elements: ExcalidrawElement[];
}

export async function loadScene(roomId: string, roomKey: string): Promise<StoredScene | null> {
  const res = await fetch(docUrl(roomId));
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`firestore read failed: ${res.status} ${await res.text()}`);
  const doc = (await res.json()) as {
    fields: {
      sceneVersion: { integerValue: string };
      ciphertext: { bytesValue: string };
      iv: { bytesValue: string };
    };
  };
  const ciphertext = Buffer.from(doc.fields.ciphertext.bytesValue, "base64");
  const iv = Buffer.from(doc.fields.iv.bytesValue, "base64");
  const elements = await decryptJson<ExcalidrawElement[]>(roomKey, iv, ciphertext);
  return { sceneVersion: Number(doc.fields.sceneVersion.integerValue), elements };
}

/**
 * Best-effort save. The web app does this inside a transaction that only
 * writes when its version is newer; we do a plain overwrite, so only call it
 * when this client holds the reconciled scene.
 */
export async function saveScene(
  roomId: string,
  roomKey: string,
  elements: readonly ExcalidrawElement[],
  sceneVersion: number,
): Promise<void> {
  const { ciphertext, iv } = await encryptJson(roomKey, elements);
  const body = {
    fields: {
      sceneVersion: { integerValue: String(sceneVersion) },
      ciphertext: { bytesValue: toBase64(ciphertext) },
      iv: { bytesValue: toBase64(iv) },
    },
  };
  const res = await fetch(docUrl(roomId), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`firestore write failed: ${res.status} ${await res.text()}`);
}
