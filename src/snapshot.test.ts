import assert from "node:assert/strict";
import { inflateSync } from "node:zlib";
import { test } from "node:test";
import { buildElements, type ElementSpec, type ExcalidrawElement } from "./elements.js";
import { buildSvg, MAX_PNG_BYTES, snapshotScene, stickyNoteDate } from "./snapshot.js";

/** The four pinned lines of the text block, as a lookup. */
function lines(text: string): string[] {
  return text.split("\n");
}

function field(text: string, prefix: string): string {
  const line = lines(text).find((l) => l.startsWith(prefix));
  assert.ok(line, `no line starting ${prefix} in:\n${text}`);
  return line.slice(prefix.length).trim();
}

/** PNG signature, then width and height from the IHDR at bytes 16-23. */
function pngSize(png: Uint8Array): { width: number; height: number } {
  const bytes = Buffer.from(png);
  assert.deepEqual(
    [...bytes.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    "not a PNG",
  );
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * How many distinct byte values the inflated image data holds. A blank canvas
 * is uniform - one filter byte per row plus one sample value, so at most two -
 * while anything actually drawn produces antialiased edges and many more. This
 * is the contract's definition of "the PNG has ink"; eight is the threshold.
 */
function distinctImageBytes(png: Uint8Array): number {
  const bytes = Buffer.from(png);
  const chunks: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (type === "IDAT") chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  assert.ok(chunks.length, "no IDAT chunks");
  const raw = inflateSync(Buffer.concat(chunks));
  return new Set(raw).size;
}

function hasInk(png: Uint8Array): boolean {
  return distinctImageBytes(png) >= 8;
}

function build(specs: ElementSpec[]): ExcalidrawElement[] {
  const { created } = buildElements(specs, { existing: new Map(), lastIndex: null });
  return created;
}

const FREEDRAW: ExcalidrawElement = {
  type: "freedraw",
  id: "f",
  x: 300,
  y: 0,
  width: 60,
  height: 60,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  strokeWidth: 2,
  strokeStyle: "solid",
  opacity: 100,
  isDeleted: false,
  boundElements: null,
  version: 1,
  versionNonce: 1,
  updated: 1,
  index: "a5",
  points: [
    [0, 0],
    [15, 30],
    [40, 12],
    [60, 60],
  ],
} as unknown as ExcalidrawElement;

test("snapshot renders a rectangle, its bound text, an arrow and a freedraw stroke to a PNG sized to the bounding box and lists all four ids", async () => {
  const scene = [
    ...build([
      { type: "rectangle", id: "r", x: 0, y: 0, width: 200, height: 100, label: "API" },
      { type: "ellipse", id: "e", x: 400, y: 0, width: 120, height: 120 },
      { type: "arrow", id: "a", start: "r", end: "e" },
    ]),
    FREEDRAW,
  ];
  const label = scene.find((el) => el.type === "text" && el.containerId === "r");
  assert.ok(label, "the rectangle's label was not built");

  const snapshot = await snapshotScene(scene, { ids: ["r", "a", "f"], scale: 2 });

  assert.ok(snapshot.png, "no PNG");
  const size = pngSize(snapshot.png);
  assert.equal(size.width, Math.round(snapshot.bbox.width * 2));
  assert.equal(size.height, Math.round(snapshot.bbox.height * 2));
  assert.equal(field(snapshot.text, "pixels"), `${size.width}x${size.height}`);
  assert.equal(field(snapshot.text, "scale"), "2");
  const ids = field(snapshot.text, "ids").split(", ");
  for (const id of ["r", label.id, "a", "f"]) assert.ok(ids.includes(id), `${id} missing from ${ids.join(", ")}`);
  assert.ok(!ids.includes("e"), "an unselected element was rendered");
  assert.ok(hasInk(snapshot.png), "the PNG is blank");
});

test("snapshot downscales to maxWidth and reports the reduced scale", async () => {
  const scene = build([{ type: "rectangle", id: "r", x: 0, y: 0, width: 400, height: 200 }]);

  const snapshot = await snapshotScene(scene, { ids: ["r"], scale: 3, maxWidth: 100 });

  assert.ok(snapshot.png);
  const size = pngSize(snapshot.png);
  assert.ok(size.width <= 100, `width ${size.width} exceeds maxWidth`);
  assert.equal(field(snapshot.text, "pixels"), `${size.width}x${size.height}`);
  assert.ok(Number(field(snapshot.text, "scale")) < 3, "the scale was not reduced");
  assert.ok(
    lines(snapshot.text).some((l) => l.includes("reduced")),
    `no reduction note in:\n${snapshot.text}`,
  );
});

test("snapshot draws an unsupported element type as a dashed placeholder", async () => {
  const image = {
    ...FREEDRAW,
    id: "i",
    type: "image",
    x: 0,
    y: 0,
    width: 120,
    height: 90,
    points: undefined,
    strokeColor: "transparent",
  } as unknown as ExcalidrawElement;
  const scene = [...build([{ type: "rectangle", id: "r", x: 200, y: 0, width: 100, height: 100 }]), image];

  const snapshot = await snapshotScene(scene);

  assert.ok(snapshot.png);
  assert.equal(field(snapshot.text, "placeholders"), "i");
  assert.deepEqual(snapshot.placeholders, ["i"]);
  assert.ok(field(snapshot.text, "ids").split(", ").includes("i"));
  assert.ok(hasInk(snapshot.png), "the placeholder box was not drawn");
});

test("snapshot of a 200-element scene completes within 2 s", async () => {
  const specs: ElementSpec[] = [];
  for (let i = 0; i < 200; i += 1) {
    specs.push({
      type: "rectangle",
      id: `p${i}`,
      x: (i % 20) * 60,
      y: Math.floor(i / 20) * 60,
      width: 40,
      height: 40,
    });
  }
  const scene = build(specs);
  assert.equal(scene.length, 200);
  // The wasm module and the font load once per process; a cold load is not
  // what this test measures.
  await snapshotScene(scene, { ids: ["p0"] });

  const started = performance.now();
  const snapshot = await snapshotScene(scene, { ids: specs.map((s) => s.id!) });
  const elapsed = performance.now() - started;

  assert.ok(snapshot.png);
  assert.equal(field(snapshot.text, "ids").split(", ").length, 200);
  assert.ok(hasInk(snapshot.png));
  assert.ok(elapsed < 2000, `took ${Math.round(elapsed)} ms`);
});

test("snapshot keeps the PNG under 4 MB by reducing the scale and says so", async () => {
  // Dense, unaligned strokes are the worst case for PNG compression, so this
  // is the cheapest scene that genuinely overshoots the cap at scale 3.
  const scene: ExcalidrawElement[] = [];
  let seed = 7;
  const next = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  for (let i = 0; i < 1600; i += 1) {
    const points: [number, number][] = [];
    for (let p = 0; p < 8; p += 1) points.push([next() * 130, next() * 130]);
    scene.push({
      ...FREEDRAW,
      id: `s${i}`,
      x: next() * 1400,
      y: next() * 1400,
      width: 130,
      height: 130,
      points,
    } as unknown as ExcalidrawElement);
  }

  const snapshot = await snapshotScene(scene, { scale: 3, maxWidth: 20000, maxHeight: 20000 });

  assert.ok(snapshot.png);
  assert.ok(
    snapshot.png.length <= MAX_PNG_BYTES,
    `the PNG is ${snapshot.png.length} bytes, over the ${MAX_PNG_BYTES} cap`,
  );
  assert.ok(snapshot.scale < 3, `the scale stayed at ${snapshot.scale}`);
  assert.ok(
    lines(snapshot.text).some((l) => l.includes("reduced")),
    `no reduction note in:\n${snapshot.text}`,
  );
  assert.equal(field(snapshot.text, "pixels"), `${pngSize(snapshot.png).width}x${pngSize(snapshot.png).height}`);
});

// ---------------------------------------------------------------------------
// A bound label is drawn where it actually is.
// https://github.com/bjcoombs/excalidraw-room-mcp/issues/112

/** The x, y of every <text> span in an SVG, in document order. */
function textAnchors(svg: string): { x: number; y: number }[] {
  return [...svg.matchAll(/<text x="([-\d.]+)" y="([-\d.]+)"/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
}

test("snapshot draws a bound label at its own coordinates when they disagree with the container", () => {
  const scene = build([{ type: "rectangle", id: "r", x: 0, y: 0, width: 200, height: 100, label: "Box" }]);
  const rect = scene.find((e) => e.id === "r")!;
  const label = scene.find((e) => e.containerId === "r")!;

  const agreeing = textAnchors(buildSvg(scene, { x: 0, y: 0, width: 400, height: 600 }, 400, 600));
  assert.equal(agreeing.length, 1);
  assert.equal(agreeing[0].x, label.x + label.width / 2, "a consistent scene still centres the label");

  // The #112 fault: the container moved and the label did not. The canvas
  // draws the label where the label says it is, so the snapshot must too.
  const adrift = [rect, { ...label, x: label.x, y: label.y + 400 }];
  const drawn = textAnchors(buildSvg(adrift, { x: 0, y: 0, width: 400, height: 600 }, 400, 600));
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].x, agreeing[0].x, "the label did not move sideways");
  assert.equal(drawn[0].y - agreeing[0].y, 400, "and is drawn 400px down, not back inside the box");
});

test("snapshot rotates a bound label with its container", () => {
  const scene = build([{ type: "rectangle", id: "r", x: 0, y: 0, width: 200, height: 100, label: "Box" }]);
  const rect = { ...scene.find((e) => e.id === "r")!, angle: Math.PI / 2 };
  const label = scene.find((e) => e.containerId === "r")!;
  const svg = buildSvg([rect, label], { x: 0, y: 0, width: 400, height: 400 }, 400, 400);

  // The container's centre, not the label's: the label turns about the shape
  // it is bound to, which is what the canvas does.
  assert.match(svg, /<g transform="rotate\(90 100 50\)"><text /, svg);
  const unrotated = buildSvg([scene.find((e) => e.id === "r")!, label], { x: 0, y: 0, width: 400, height: 400 }, 400, 400);
  assert.doesNotMatch(unrotated, /rotate/, "a container at angle 0 rotates nothing");
});

// ---------------------------------------------------------------------------
// Sticky notes: https://github.com/bjcoombs/excalidraw-room-mcp/issues/121

/** Mid-month and mid-day, so the local date is the same in every time zone. */
const JUNE_15_2020 = new Date(2020, 5, 15, 12).getTime();

test("snapshot draws a stickynote with its label and footer date", async () => {
  const scene = build([
    { type: "stickynote", id: "n", x: 0, y: 0, label: "Ship it", strokeColor: "#e03131", backgroundColor: "#ffdf6b" },
  ]);
  const [note, label] = scene;
  const box = { x: -20, y: -20, width: 300, height: 300 };

  const now = build([{ type: "stickynote", id: "m", x: 0, y: 0 }]);
  const today = new Date(now[0].created as number);
  const thisYear = buildSvg(now, box, 300, 300);
  assert.ok(thisYear.includes(`>${today.getDate()} ${today.toLocaleString("en-GB", { month: "short" }).slice(0, 3)}</text>`), thisYear);

  const dated = [{ ...note, created: JUNE_15_2020 }, label];
  const svg = buildSvg(dated, box, 300, 300);
  // The shadow, 3 px down and right at 16 percent, then the fill with no border.
  assert.match(svg, /<rect x="3" y="3" width="250" height="250" fill="#000000" fill-opacity="0.16"\/>/);
  assert.match(svg, /<rect x="0" y="0" width="250" height="250" fill="#ffdf6b" stroke="none"\/>/);
  // The label from the top-left inside the padding, in the note's ink.
  assert.match(svg, /<text x="16" y="[\d.]+" font-family="DejaVu Sans" font-size="28" fill="#e03131" text-anchor="start">Ship it<\/text>/);
  // The date bottom right at 12 px, with the year because it is not this one.
  assert.match(svg, /<text x="234" y="236" font-family="DejaVu Sans" font-size="12" fill="#e03131" text-anchor="end">15 Jun 2020<\/text>/);

  assert.equal(stickyNoteDate(JUNE_15_2020, false, new Date(2020, 0, 1).getTime()), "15 Jun");
  assert.equal(stickyNoteDate(JUNE_15_2020, true), "15 Jun", "a narrow note leaves the year off");
  assert.equal(stickyNoteDate(Number.NaN), null);
  assert.equal(stickyNoteDate(8.64e15 + 1), null, "past the last date a Date can hold");
  assert.match(buildSvg([{ ...note, created: JUNE_15_2020, width: 100 }], box, 300, 300), />15 Jun<\/text>/);
  assert.doesNotMatch(buildSvg([{ ...note, created: JUNE_15_2020, width: 60 }], box, 300, 300), /Jun/, "under the data floor");

  const snapshot = await snapshotScene(dated);
  assert.ok(snapshot.png);
  assert.deepEqual(snapshot.placeholders, [], "a sticky note is drawn, not a placeholder");
  assert.deepEqual(snapshot.ids, ["n", label.id]);
  assert.ok(hasInk(snapshot.png));
});

test("snapshot omits the footer date when created is null", () => {
  const [note, label] = build([{ type: "stickynote", id: "n", x: 0, y: 0, label: "Ship it" }]);
  const svg = buildSvg([{ ...note, created: null }, label], { x: 0, y: 0, width: 300, height: 300 }, 300, 300);
  assert.equal(textAnchors(svg).length, 1, "the label and nothing else");
  assert.doesNotMatch(svg, /font-size="12"/);
  assert.match(svg, /fill="#ffdf6b" stroke="none"/, "the note itself is still drawn");
});
