import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptJson, generateRoomKey } from "./crypto.js";
import { loadScene, saveScene, SceneConflictError } from "./firebase.js";

type FetchCall = { url: URL; init?: RequestInit };

/** Replace global fetch for one test; returns the recorded calls. */
function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const call = { url, init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

const el = (id: string, version = 1) => ({ id, type: "rectangle", version, versionNonce: 1, x: 0, y: 0, width: 1, height: 1, isDeleted: false, boundElements: null });

test("loadScene returns null on 404 and decrypts a stored document", async () => {
  const key = await generateRoomKey();
  const elements = [el("a"), el("b", 3)];
  const { ciphertext, iv } = await encryptJson(key, elements);
  const doc = {
    updateTime: "2026-09-08T13:00:00.000000Z",
    fields: {
      sceneVersion: { integerValue: "4" },
      ciphertext: { bytesValue: Buffer.from(ciphertext).toString("base64") },
      iv: { bytesValue: Buffer.from(iv).toString("base64") },
    },
  };
  const stub = stubFetch(({ url }) =>
    url.pathname.endsWith("/scenes/missing") ? new Response("", { status: 404 }) : Response.json(doc),
  );
  try {
    assert.equal(await loadScene("missing", key), null);
    const stored = await loadScene("room1", key);
    assert.deepEqual(stored?.elements, elements);
    assert.equal(stored?.sceneVersion, 4);
    assert.equal(stored?.updateTime, doc.updateTime);
    assert.ok(stub.calls.every((c) => c.url.searchParams.get("key")), "api key present on every call");
  } finally {
    stub.restore();
  }
});

test("saveScene sends an exists=false precondition for a new document and updateTime for an existing one", async () => {
  const key = await generateRoomKey();
  const stub = stubFetch(() => Response.json({ updateTime: "2026-09-08T13:01:00.000000Z", fields: {} }));
  try {
    const t1 = await saveScene("room1", key, [el("a")], 1, null);
    assert.equal(t1, "2026-09-08T13:01:00.000000Z");
    const t2 = await saveScene("room1", key, [el("a", 2)], 2, t1);
    assert.equal(t2, t1);
    const [first, second] = stub.calls;
    assert.equal(first.init?.method, "PATCH");
    assert.equal(first.url.searchParams.get("currentDocument.exists"), "false");
    assert.equal(first.url.searchParams.get("currentDocument.updateTime"), null);
    assert.equal(second.url.searchParams.get("currentDocument.updateTime"), t1);
    assert.equal(second.url.searchParams.get("currentDocument.exists"), null);
    const body = JSON.parse(String(second.init?.body));
    assert.equal(body.fields.sceneVersion.integerValue, "2");
    assert.ok(body.fields.ciphertext.bytesValue.length > 0);
  } finally {
    stub.restore();
  }
});

test("saveScene raises SceneConflictError on a failed precondition and a plain Error otherwise", async () => {
  const key = await generateRoomKey();
  let status = 412;
  let body = '{"error":{"status":"FAILED_PRECONDITION"}}';
  const stub = stubFetch(() => new Response(body, { status }));
  try {
    await assert.rejects(saveScene("room1", key, [el("a")], 1, "t0"), SceneConflictError);
    status = 400;
    body = '{"error":{"status":"FAILED_PRECONDITION","message":"the stored version is newer"}}';
    await assert.rejects(saveScene("room1", key, [el("a")], 1, "t0"), SceneConflictError);
    status = 500;
    body = "boom";
    await assert.rejects(saveScene("room1", key, [el("a")], 1, "t0"), (err: unknown) => {
      return err instanceof Error && !(err instanceof SceneConflictError) && /firestore write failed: 500/.test(err.message);
    });
  } finally {
    stub.restore();
  }
});
