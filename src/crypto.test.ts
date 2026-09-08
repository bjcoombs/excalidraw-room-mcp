import { test } from "node:test";
import assert from "node:assert/strict";
import { decryptJson, encryptJson, generateRoomId, generateRoomKey } from "./crypto.js";

test("room key is 22 base64url chars, room id is 20 hex chars", async () => {
  const key = await generateRoomKey();
  assert.match(key, /^[A-Za-z0-9_-]{22}$/);
  assert.match(generateRoomId(), /^[0-9a-f]{20}$/);
});

test("encrypt/decrypt round-trips JSON", async () => {
  const key = await generateRoomKey();
  const payload = { type: "SCENE_UPDATE", payload: { elements: [{ id: "a", version: 1 }] } };
  const { ciphertext, iv } = await encryptJson(key, payload);
  assert.equal(iv.length, 12);
  const back = await decryptJson<typeof payload>(key, iv, ciphertext);
  assert.deepEqual(back, payload);
});

test("decrypt with the wrong key fails", async () => {
  const { ciphertext, iv } = await encryptJson(await generateRoomKey(), { a: 1 });
  await assert.rejects(decryptJson(await generateRoomKey(), iv, ciphertext));
});

test("decrypt accepts a Node Buffer for the ciphertext, as socket.io delivers", async () => {
  const key = await generateRoomKey();
  const { ciphertext, iv } = await encryptJson(key, { ok: true });
  const back = await decryptJson<{ ok: boolean }>(key, Buffer.from(iv), Buffer.from(ciphertext));
  assert.equal(back.ok, true);
});
