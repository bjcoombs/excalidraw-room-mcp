import assert from "node:assert/strict";
import test from "node:test";
import {
  afterPaint,
  blobToBase64,
  browserClipboard,
  elementIds,
  EXPORT_FILE_NAME,
  saveImage,
  sendSnapshot,
  snapshotElements,
  snapshotText,
  SNAPSHOT_CLIPBOARD_HINT,
  type ClipboardScope,
  type ExportToBlobLike,
  type ModelContextBlock,
  type SnapshotEnv,
  type SnapshotHost,
  type SnapshotScene,
} from "./snapshot.js";

const LINK = "https://excalidraw.com/#room=0123456789abcdef0123,AbCdEfGhIjKlMnOpQrStUv";

/** Four bytes that are not all the same, so base64 of them is recognisable. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function png(): Blob {
  return new Blob([PNG_BYTES], { type: "image/png" });
}

/** A viewport 800x600 at the origin, at zoom 1: the default the tests draw in. */
function appState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { scrollX: 0, scrollY: 0, width: 800, height: 600, zoom: { value: 1 }, ...over };
}

function scene(over: Partial<SnapshotScene> = {}): SnapshotScene {
  return {
    elements: [
      { id: "r", x: 0, y: 0, width: 200, height: 100 },
      { id: "t", x: 10, y: 10, width: 80, height: 20, containerId: "r" },
    ],
    appState: appState(),
    files: null,
    link: LINK,
    ...over,
  };
}

/** A renderer shaped like exportToBlob that records what it was asked to draw. */
function renderer(behaviour: "png" | "throw" = "png"): ExportToBlobLike & { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  const fn = (async (options: Record<string, unknown>) => {
    calls.push(options);
    if (behaviour === "throw") throw new Error("canvas too big");
    return png();
  }) as unknown as ExportToBlobLike & { calls: Record<string, unknown>[] };
  fn.calls = calls;
  return fn;
}

/**
 * A host that takes, refuses or drops each request. "none" is a host whose SDK
 * has no such method at all, which is the same answer as a refusal.
 */
function host(behaviour: "accept" | "refuse" | "throw" | "none"): SnapshotHost & { context: ModelContextBlock[][]; downloads: unknown[] } {
  const context: ModelContextBlock[][] = [];
  const downloads: unknown[] = [];
  const answer = async () => {
    if (behaviour === "throw") throw new Error("this host has no such request");
    return behaviour === "refuse" ? { isError: true } : {};
  };
  const app: SnapshotHost & { context: ModelContextBlock[][]; downloads: unknown[] } = { context, downloads };
  if (behaviour !== "none") {
    app.updateModelContext = async (params) => {
      context.push(params.content);
      return answer();
    };
    app.downloadFile = async (params) => {
      downloads.push(params);
      return answer();
    };
  }
  return app;
}

/** A clipboard that takes or refuses the write, and records what it took. */
function clipboard(behaviour: "accept" | "throw"): { write: (blob: Blob) => Promise<void>; written: Blob[] } {
  const written: Blob[] = [];
  return {
    written,
    write: async (blob: Blob) => {
      if (behaviour === "throw") throw new Error("clipboard-write is not permitted here");
      written.push(blob);
    },
  };
}

function env(over: Partial<SnapshotEnv> = {}): SnapshotEnv {
  return { app: host("accept"), exportToBlob: renderer(), clipboard: null, pixelRatio: 2, ...over };
}

test("Send snapshot to Claude sends one image block and one text block through update-model-context", async () => {
  const app = host("accept");
  const render = renderer();
  const result = await sendSnapshot(env({ app, exportToBlob: render }), scene());

  assert.equal(result.outcome, "sent");
  assert.equal(app.context.length, 1);
  const content = app.context[0];
  assert.equal(content.length, 2);
  assert.deepEqual(
    content.map((block) => block.type),
    ["image", "text"],
  );
  const image = content[0];
  assert.ok(image.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, await blobToBase64(png()));
  const text = content[1];
  assert.ok(text.type === "text");
  // The line names where the room is and which elements are in the picture, so
  // the model can read them with the server's tools rather than infer from pixels.
  assert.ok(text.text.includes(LINK), text.text);
  assert.ok(text.text.includes("r, t"), text.text);
  assert.deepEqual(result.ids, ["r", "t"]);
  // Device scale, so the snapshot is as sharp as the screen the reader is on.
  assert.equal(render.calls[0].mimeType, "image/png");
  assert.equal((render.calls[0].appState as Record<string, unknown>).exportScale, 2);
});

test("Send snapshot to Claude copies the PNG to the clipboard and shows the hint when the host refuses", async () => {
  for (const behaviour of ["refuse", "throw", "none"] as const) {
    const board = clipboard("accept");
    const result = await sendSnapshot(env({ app: host(behaviour), clipboard: board.write }), scene());
    assert.equal(result.outcome, "copied", behaviour);
    // The exact words the reader is told to act on.
    assert.equal(result.hint, SNAPSHOT_CLIPBOARD_HINT, behaviour);
    assert.equal(board.written.length, 1, behaviour);
    assert.equal(board.written[0].type, "image/png", behaviour);
  }
});

test("a snapshot the host and the clipboard both refuse says so and does not throw", async () => {
  const board = clipboard("throw");
  const result = await sendSnapshot(env({ app: host("refuse"), clipboard: board.write }), scene());
  assert.equal(result.outcome, "failed");
  assert.ok(result.hint.includes("snapshot"), result.hint);
  assert.equal(board.written.length, 0);

  // A host with no clipboard at all takes the same branch.
  const none = await sendSnapshot(env({ app: host("none"), clipboard: null }), scene());
  assert.equal(none.outcome, "failed");
});

test("a render that fails is reported and never thrown out of the handler", async () => {
  const result = await sendSnapshot(env({ exportToBlob: renderer("throw") }), scene());
  assert.equal(result.outcome, "failed");
  assert.ok(result.hint.includes("canvas too big"), result.hint);

  const empty = await sendSnapshot(env(), scene({ elements: [] }));
  assert.equal(empty.outcome, "failed");
  assert.ok(empty.hint.includes("nothing on the canvas"), empty.hint);
});

test("a snapshot renders the selection when there is one, and what the viewport shows otherwise", () => {
  const elements = [
    { id: "r", x: 0, y: 0, width: 200, height: 100 },
    { id: "t", x: 10, y: 10, width: 80, height: 20, containerId: "r" },
    { id: "far", x: 5000, y: 5000, width: 50, height: 50 },
    { id: "gone", x: 0, y: 0, width: 10, height: 10, isDeleted: true },
  ];
  // No selection: everything the 800x600 viewport overlaps, and nothing beyond it.
  assert.deepEqual(elementIds(snapshotElements(elements, appState())), ["r", "t"]);
  // A selected container brings its bound label, and leaves the rest out.
  assert.deepEqual(elementIds(snapshotElements(elements, appState({ selectedElementIds: { r: true } }))), ["r", "t"]);
  assert.deepEqual(elementIds(snapshotElements(elements, appState({ selectedElementIds: { far: true } }))), ["far"]);
  // Scrolled to the far shape, that is what the picture holds.
  assert.deepEqual(elementIds(snapshotElements(elements, appState({ scrollX: -5000, scrollY: -5000 }))), ["far"]);
  // Before the canvas is laid out there is no viewport to intersect, so the
  // whole scene is the honest answer.
  assert.deepEqual(elementIds(snapshotElements(elements, {})), ["r", "t", "far"]);
});

test("the snapshot line names the room and the elements", () => {
  assert.equal(snapshotText(LINK, ["r", "t"]), `Snapshot of the Excalidraw room ${LINK}; elements: r, t`);
  assert.ok(snapshotText(null, []).includes("no link"));
});

test("Export image hands the PNG to the host to download", async () => {
  const app = host("accept");
  const result = await saveImage(env({ app }), scene());
  assert.equal(result.outcome, "saved");
  assert.equal(app.downloads.length, 1);
  const asked = app.downloads[0] as { contents: { resource: { uri: string; mimeType: string; blob: string } }[] };
  assert.equal(asked.contents.length, 1);
  assert.equal(asked.contents[0].resource.mimeType, "image/png");
  assert.ok(asked.contents[0].resource.uri.endsWith(EXPORT_FILE_NAME), asked.contents[0].resource.uri);
  assert.equal(asked.contents[0].resource.blob, await blobToBase64(png()));

  // A host that refuses, rejects, or has no download request at all leaves the
  // caller to fall back to Excalidraw's dialog rather than fail silently.
  for (const behaviour of ["refuse", "throw", "none"] as const) {
    const refused = await saveImage(env({ app: host(behaviour) }), scene());
    assert.equal(refused.outcome, "failed", behaviour);
    assert.ok(refused.hint.length > 0, behaviour);
  }
});

test("the clipboard writer is null where the sandbox has none", () => {
  assert.equal(browserClipboard({} as ClipboardScope), null);
  assert.equal(browserClipboard({ navigator: {} } as ClipboardScope), null);

  const written: unknown[] = [];
  class Item {
    constructor(readonly parts: Record<string, Blob>) {}
  }
  const writer = browserClipboard({
    navigator: {
      clipboard: {
        write: async (items: unknown[]) => {
          written.push(...items);
        },
      },
    },
    ClipboardItem: Item as unknown as ClipboardScope["ClipboardItem"],
  });
  assert.ok(writer);
  return writer(png()).then(() => {
    assert.equal(written.length, 1);
    assert.deepEqual(Object.keys((written[0] as Item).parts), ["image/png"]);
  });
});

test("a menu action runs after the current paint, not on the click", () => {
  const order: string[] = [];
  const queued: (() => void)[] = [];
  afterPaint(
    () => order.push("action"),
    (task) => queued.push(task),
  );
  order.push("click returned");
  queued.forEach((task) => task());
  // The handler returns before the render happens: a PNG rendered on the click
  // itself would hold the widget's poll and repaint behind it.
  assert.deepEqual(order, ["click returned", "action"]);
});
