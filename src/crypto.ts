/**
 * AES-GCM helpers matching packages/excalidraw/data/encryption.ts in the
 * Excalidraw repo, ported to Node's WebCrypto. The room key in a collab
 * link is the raw 128-bit key, base64url encoded (22 chars), used as the
 * `k` of a JWK.
 */
const subtle = globalThis.crypto.subtle;
const KEY_BITS = 128;
export const IV_LENGTH_BYTES = 12;

function importKey(key: string, usage: KeyUsage): Promise<CryptoKey> {
  return subtle.importKey(
    "jwk",
    { alg: "A128GCM", ext: true, k: key, key_ops: ["encrypt", "decrypt"], kty: "oct" },
    { name: "AES-GCM", length: KEY_BITS },
    false,
    [usage],
  );
}

export async function generateRoomKey(): Promise<string> {
  const key = await subtle.generateKey({ name: "AES-GCM", length: KEY_BITS }, true, [
    "encrypt",
    "decrypt",
  ]);
  const jwk = await subtle.exportKey("jwk", key);
  if (!jwk.k) throw new Error("exported key has no k");
  return jwk.k;
}

export function generateRoomId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function encrypt(
  key: string,
  plaintext: Uint8Array,
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(IV_LENGTH_BYTES));
  const k = await importKey(key, "encrypt");
  const ciphertext = await subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, k, plaintext as unknown as BufferSource);
  return { ciphertext, iv };
}

export async function decrypt(
  key: string,
  iv: Uint8Array,
  ciphertext: ArrayBuffer | Uint8Array,
): Promise<Uint8Array> {
  const k = await importKey(key, "decrypt");
  const plain = await subtle.decrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource }, k, ciphertext as unknown as BufferSource);
  return new Uint8Array(plain);
}

export async function encryptJson(
  key: string,
  value: unknown,
): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
  return encrypt(key, new TextEncoder().encode(JSON.stringify(value)));
}

export async function decryptJson<T>(
  key: string,
  iv: Uint8Array,
  ciphertext: ArrayBuffer | Uint8Array,
): Promise<T> {
  const bytes = await decrypt(key, iv, ciphertext);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
