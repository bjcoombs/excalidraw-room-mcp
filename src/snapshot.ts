/**
 * Server-side raster of a region of the room.
 *
 * The relay carries element JSON, so a freedraw stroke reaches the model as a
 * point array and handwriting is unreadable to it. excalidraw.com's own export
 * runs in a browser; this module reaches the same place without a DOM by
 * writing an SVG for the element subset it understands and rasterising it with
 * `@resvg/resvg-wasm`. Nothing here touches the DOM or `@excalidraw/excalidraw`.
 *
 * The render is deliberately flat: `roughness` is ignored (no hand-drawn
 * wobble) and every fill is solid, because the point is legibility, not
 * fidelity to Excalidraw's rendering. Element types the SVG writer does not
 * cover are drawn as a labelled dashed box, so the model can tell that
 * something is there rather than reading empty space.
 */
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { type ExcalidrawElement } from "./elements.js";
import { DEFAULT_NEARBY_RADIUS } from "./mentions.js";
import { selectElements } from "./scene.js";

/** Scene units of empty space left on each side of the rendered bounding box. */
export const SNAPSHOT_PADDING = 20;
/** Highest scale the tool accepts; the schema rejects anything above it. */
export const MAX_SCALE = 3;
/** Default pixel ceiling for each axis. A render wider or taller is downscaled. */
export const DEFAULT_MAX_DIMENSION = 1600;
/** Hosts choke on larger images, so the PNG is reduced until it fits. */
export const MAX_PNG_BYTES = 4194304;
/** Below this the render carries no information; the fit stops here. */
export const MIN_SCALE = 0.02;
/** The one font shipped for text, so a render does not depend on the host's fonts. */
export const FONT_FAMILY = "DejaVu Sans";
/** Relative to the compiled module (dist/snapshot.js), so it resolves in the bundle too. */
export const FONT_FILE = "../assets/fonts/DejaVuSans.ttf";
/** Element types the SVG writer does not cover; each is drawn as a dashed box. */
export const PLACEHOLDER_TYPES = ["image", "frame", "embeddable", "iframe", "magicframe"];

const PLACEHOLDER_STROKE = "#868e96";
const BACKGROUND = "#ffffff";
const DEFAULT_STROKE = "#1e1e1e";
const DEFAULT_FONT_SIZE = 20;
const DEFAULT_LINE_HEIGHT = 1.25;
/** Fraction of the font size above the baseline; DejaVu Sans's ascent is 0.76 em. */
const ASCENT = 0.8;
const ARROWHEAD_LENGTH = 16;
const ARROWHEAD_ANGLE = Math.PI / 7;

export interface Bbox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapshotRequest {
  /** Render only these elements (a container's bound label travels with it). */
  ids?: readonly string[];
  /** Render this element and everything within the neighbourhood radius of it. */
  near?: string;
  /** How far `near` reaches, in scene units. Defaults to the room's radius. */
  nearRadius?: number;
  /** Render this region of scene space, and the elements that intersect it. */
  bbox?: Bbox;
  scale?: number;
  maxWidth?: number;
  maxHeight?: number;
}

export interface Snapshot {
  /** The PNG, or null when there was nothing to draw. */
  png: Uint8Array | null;
  width: number;
  height: number;
  bbox: Bbox;
  scale: number;
  /** Ids of every element drawn, in scene order. */
  ids: string[];
  /** Ids drawn as a labelled dashed box because their type is unsupported. */
  placeholders: string[];
  /** Ids the request named that the scene does not hold. */
  unknownIds: string[];
  /** The text block that follows the image: the pinned lines, then any notes. */
  text: string;
}

/** A decimal with no trailing zeros, so the pinned lines stay readable. */
function num(n: number): string {
  return String(Number(n.toFixed(4)));
}

function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function absolutePoints(el: ExcalidrawElement): [number, number][] {
  return (el.points ?? []).map(([px, py]) => [el.x + px, el.y + py]);
}

/** The element's extent in scene coordinates. Linear points win over width/height. */
export function elementBox(el: ExcalidrawElement): Bbox {
  const points = absolutePoints(el);
  if (points.length > 1) {
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
  }
  const width = Math.abs(el.width);
  const height = Math.abs(el.height);
  return { x: Math.min(el.x, el.x + el.width), y: Math.min(el.y, el.y + el.height), width, height };
}

function intersects(a: Bbox, b: Bbox): boolean {
  return (
    a.x <= b.x + b.width && b.x <= a.x + a.width && a.y <= b.y + b.height && b.y <= a.y + a.height
  );
}

/** Union of every element's extent, padded by `SNAPSHOT_PADDING` on each side. */
export function boundsOf(elements: readonly ExcalidrawElement[]): Bbox {
  const boxes = elements.map(elementBox);
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return {
    x: x - SNAPSHOT_PADDING,
    y: y - SNAPSHOT_PADDING,
    width: right - x + SNAPSHOT_PADDING * 2,
    height: bottom - y + SNAPSHOT_PADDING * 2,
  };
}

/**
 * Adds the bound text of every selected container, in scene order.
 *
 * A shape and its label are one thing on the canvas, so selecting the shape
 * must bring the label. The reverse does not hold: selecting a label alone
 * renders the label, not the container it happens to sit in.
 */
function withBoundText(
  all: readonly ExcalidrawElement[],
  picked: readonly ExcalidrawElement[],
): ExcalidrawElement[] {
  const byId = new Map(all.map((e) => [e.id, e]));
  const keep = new Set(picked.map((e) => e.id));
  for (const el of picked) {
    for (const bound of el.boundElements ?? []) {
      if (bound.type !== "text") continue;
      const label = byId.get(bound.id);
      if (label) keep.add(label.id);
    }
  }
  return all.filter((e) => keep.has(e.id));
}

/** Applies the request's selector to the live scene. Deleted elements never render. */
export function selectForSnapshot(
  all: readonly ExcalidrawElement[],
  request: SnapshotRequest,
): { elements: ExcalidrawElement[]; unknownIds: string[] } {
  const live = all.filter((e) => !e.isDeleted);
  if (request.bbox) {
    const region = request.bbox;
    return { elements: live.filter((e) => intersects(elementBox(e), region)), unknownIds: [] };
  }
  if (!request.ids && !request.near) return { elements: [...live], unknownIds: [] };
  const { elements, unknownIds } = selectElements(live, {
    ids: request.ids,
    near: request.near ? { id: request.near, radius: request.nearRadius ?? DEFAULT_NEARBY_RADIUS } : undefined,
  });
  return { elements: withBoundText(live, elements), unknownIds };
}

function opacityAttr(el: ExcalidrawElement): string {
  const opacity = typeof el.opacity === "number" ? el.opacity : 100;
  return opacity >= 100 ? "" : ` opacity="${num(opacity / 100)}"`;
}

function dashAttr(el: ExcalidrawElement, width: number): string {
  const style = (el as { strokeStyle?: string }).strokeStyle;
  if (style === "dashed") return ` stroke-dasharray="${num(width * 4)} ${num(width * 4)}"`;
  if (style === "dotted") return ` stroke-dasharray="${num(width)} ${num(width * 2)}"`;
  return "";
}

function strokeWidthOf(el: ExcalidrawElement): number {
  const width = (el as { strokeWidth?: number }).strokeWidth;
  return typeof width === "number" && width > 0 ? width : 2;
}

function fillOf(el: ExcalidrawElement): string {
  const background = el.backgroundColor;
  return !background || background === "transparent" ? "none" : xml(background);
}

/** stroke, fill, width, dash pattern and opacity: what every shape shares. */
function paintAttrs(el: ExcalidrawElement, fill = fillOf(el)): string {
  const width = strokeWidthOf(el);
  const stroke = el.strokeColor && el.strokeColor !== "transparent" ? el.strokeColor : DEFAULT_STROKE;
  return `fill="${fill}" stroke="${xml(stroke)}" stroke-width="${num(width)}" stroke-linecap="round" stroke-linejoin="round"${dashAttr(el, width)}${opacityAttr(el)}`;
}

/** Excalidraw rotates about the element's centre; a null or zero angle is the common case. */
function rotateAttr(el: ExcalidrawElement): string {
  const angle = (el as { angle?: number }).angle;
  if (!angle) return "";
  const box = elementBox(el);
  const degrees = (angle * 180) / Math.PI;
  return ` transform="rotate(${num(degrees)} ${num(box.x + box.width / 2)} ${num(box.y + box.height / 2)})"`;
}

function shapeSvg(el: ExcalidrawElement): string {
  const { x, y, width, height } = elementBox(el);
  const paint = paintAttrs(el);
  if (el.type === "ellipse") {
    return `<ellipse cx="${num(x + width / 2)}" cy="${num(y + height / 2)}" rx="${num(width / 2)}" ry="${num(height / 2)}" ${paint}${rotateAttr(el)}/>`;
  }
  if (el.type === "diamond") {
    const points = [
      [x + width / 2, y],
      [x + width, y + height / 2],
      [x + width / 2, y + height],
      [x, y + height / 2],
    ];
    return `<polygon points="${points.map((p) => `${num(p[0])},${num(p[1])}`).join(" ")}" ${paint}${rotateAttr(el)}/>`;
  }
  const radius = (el as { roundness?: unknown }).roundness
    ? Math.min(32, Math.min(width, height) * 0.25)
    : 0;
  const rx = radius ? ` rx="${num(radius)}"` : "";
  return `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" ${paint}${rx}${rotateAttr(el)}/>`;
}

function arrowheadSvg(
  tip: [number, number],
  from: [number, number],
  paint: string,
): string {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const wing = (sign: number): string => {
    const a = angle + Math.PI + sign * ARROWHEAD_ANGLE;
    return `${num(tip[0] + Math.cos(a) * ARROWHEAD_LENGTH)},${num(tip[1] + Math.sin(a) * ARROWHEAD_LENGTH)}`;
  };
  return `<polyline points="${wing(1)} ${num(tip[0])},${num(tip[1])} ${wing(-1)}" ${paint}/>`;
}

function linearSvg(el: ExcalidrawElement): string {
  const points = absolutePoints(el);
  if (points.length < 2) return "";
  const paint = paintAttrs(el, "none");
  const path = points.map((p, i) => `${i ? "L" : "M"} ${num(p[0])} ${num(p[1])}`).join(" ");
  const parts = [`<path d="${path}" ${paint}/>`];
  const arrows = el as { startArrowhead?: string | null; endArrowhead?: string | null };
  const endHead = el.type === "arrow" && arrows.endArrowhead !== null ? arrows.endArrowhead ?? "arrow" : null;
  if (endHead) parts.push(arrowheadSvg(points[points.length - 1], points[points.length - 2], paint));
  if (arrows.startArrowhead) parts.push(arrowheadSvg(points[0], points[1], paint));
  return `<g${rotateAttr(el)}>${parts.join("")}</g>`;
}

/**
 * A freedraw stroke as one smoothed path: quadratic segments whose control
 * points are the recorded points and whose ends are the midpoints between
 * them. Pressure is ignored, so the stroke has a single width.
 */
function freedrawSvg(el: ExcalidrawElement): string {
  const points = absolutePoints(el);
  if (!points.length) return "";
  if (points.length < 3) return linearSvg({ ...el, type: "line" });
  const mid = (a: [number, number], b: [number, number]): string =>
    `${num((a[0] + b[0]) / 2)} ${num((a[1] + b[1]) / 2)}`;
  const parts = [`M ${num(points[0][0])} ${num(points[0][1])}`];
  for (let i = 1; i < points.length - 1; i += 1) {
    parts.push(`Q ${num(points[i][0])} ${num(points[i][1])} ${mid(points[i], points[i + 1])}`);
  }
  const last = points[points.length - 1];
  parts.push(`L ${num(last[0])} ${num(last[1])}`);
  return `<path d="${parts.join(" ")}" ${paintAttrs(el, "none")}${rotateAttr(el)}/>`;
}

function anchorFor(align: string | undefined): { anchor: string; offset: number } {
  if (align === "center") return { anchor: "middle", offset: 0.5 };
  if (align === "right") return { anchor: "end", offset: 1 };
  return { anchor: "start", offset: 0 };
}

/**
 * Text at the element's own font size and alignment, drawn from its own box.
 *
 * A bound label is centred in that box rather than in its container's: the two
 * agree while the scene is consistent, and where they disagree the canvas
 * draws the label at its own coordinates, so drawing it from the container
 * would hide exactly the fault a snapshot is taken to catch (issue #112).
 * Rotation still comes from the container, which is what the label turns with.
 */
function textSvg(el: ExcalidrawElement, container: ExcalidrawElement | undefined): string {
  const lines = (el.text ?? "").split("\n");
  if (!lines.some((line) => line.length)) return "";
  const fontSize = (el as { fontSize?: number }).fontSize ?? DEFAULT_FONT_SIZE;
  const lineHeight = (el as { lineHeight?: number }).lineHeight ?? DEFAULT_LINE_HEIGHT;
  const step = fontSize * lineHeight;
  const box = elementBox(el);
  const { anchor, offset } = container ? { anchor: "middle", offset: 0.5 } : anchorFor((el as { textAlign?: string }).textAlign);
  const x = box.x + box.width * offset;
  const top = container ? box.y + (box.height - lines.length * step) / 2 : box.y;
  const fill = el.strokeColor && el.strokeColor !== "transparent" ? el.strokeColor : DEFAULT_STROKE;
  const spans = lines.map(
    (line, i) =>
      `<text x="${num(x)}" y="${num(top + i * step + fontSize * ASCENT)}" font-family="${FONT_FAMILY}" font-size="${num(fontSize)}" fill="${xml(fill)}" text-anchor="${anchor}">${xml(line)}</text>`,
  );
  return `<g${opacityAttr(el)}${rotateAttr(container ?? el)}>${spans.join("")}</g>`;
}

/** A dashed box named with the element's type, so unsupported content is visible. */
function placeholderSvg(el: ExcalidrawElement): string {
  const { x, y, width, height } = elementBox(el);
  const fontSize = Math.max(8, Math.min(16, height / 3));
  return [
    `<g${opacityAttr(el)}${rotateAttr(el)}>`,
    `<rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" fill="none" stroke="${PLACEHOLDER_STROKE}" stroke-width="2" stroke-dasharray="8 6"/>`,
    `<text x="${num(x + width / 2)}" y="${num(y + height / 2 + fontSize * 0.35)}" font-family="${FONT_FAMILY}" font-size="${num(fontSize)}" fill="${PLACEHOLDER_STROKE}" text-anchor="middle">${xml(el.type)}</text>`,
    "</g>",
  ].join("");
}

function elementSvg(el: ExcalidrawElement, byId: Map<string, ExcalidrawElement>): string {
  if (PLACEHOLDER_TYPES.includes(el.type)) return placeholderSvg(el);
  if (el.type === "rectangle" || el.type === "ellipse" || el.type === "diamond") return shapeSvg(el);
  if (el.type === "arrow" || el.type === "line") return linearSvg(el);
  if (el.type === "freedraw") return freedrawSvg(el);
  if (el.type === "text") {
    return textSvg(el, el.containerId ? byId.get(el.containerId) : undefined);
  }
  return placeholderSvg(el);
}

/** The SVG document for a selection, sized in pixels and mapped onto the bbox. */
export function buildSvg(
  elements: readonly ExcalidrawElement[],
  bbox: Bbox,
  width: number,
  height: number,
): string {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const body = elements.map((el) => elementSvg(el, byId)).join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`,
    ` viewBox="${num(bbox.x)} ${num(bbox.y)} ${num(bbox.width)} ${num(bbox.height)}">`,
    `<rect x="${num(bbox.x)}" y="${num(bbox.y)}" width="${num(bbox.width)}" height="${num(bbox.height)}" fill="${BACKGROUND}"/>`,
    body,
    "</svg>",
  ].join("");
}

/** Which element types in a selection have no SVG writer, in scene order. */
export function placeholderIds(elements: readonly ExcalidrawElement[]): string[] {
  const drawn = new Set(["rectangle", "ellipse", "diamond", "arrow", "line", "freedraw", "text"]);
  return elements.filter((e) => !drawn.has(e.type)).map((e) => e.id);
}

let renderer: Promise<{ Resvg: typeof import("@resvg/resvg-wasm").Resvg; font: Uint8Array }> | null = null;

/**
 * Initialises the wasm module and reads the bundled font, once per process.
 *
 * The wasm file ships inside `@resvg/resvg-wasm`, so it is resolved through
 * the package's own `./index_bg.wasm` export rather than by guessing a path;
 * the font is resolved relative to this module, which puts it at
 * `assets/fonts/` in the checkout and in the bundle alike.
 */
async function loadRenderer(): Promise<{ Resvg: typeof import("@resvg/resvg-wasm").Resvg; font: Uint8Array }> {
  if (!renderer) {
    renderer = (async () => {
      const { Resvg, initWasm } = await import("@resvg/resvg-wasm");
      const require = createRequire(import.meta.url);
      const [wasm, font] = await Promise.all([
        readFile(require.resolve("@resvg/resvg-wasm/index_bg.wasm")),
        readFile(fileURLToPath(new URL(FONT_FILE, import.meta.url))),
      ]);
      await initWasm(wasm);
      return { Resvg, font: new Uint8Array(font) };
    })().catch((error: unknown) => {
      renderer = null;
      throw error;
    });
  }
  return renderer;
}

/** Rasterises one SVG with the bundled font as the only font available. */
async function rasterise(svg: string): Promise<Uint8Array> {
  const { Resvg, font } = await loadRenderer();
  const image = new Resvg(svg, {
    font: { fontBuffers: [font], defaultFontFamily: FONT_FAMILY, sansSerifFamily: FONT_FAMILY },
    fitTo: { mode: "original" },
  });
  return image.render().asPng();
}

function pixelSize(bbox: Bbox, scale: number, request: SnapshotRequest): { width: number; height: number } {
  const maxW = request.maxWidth ?? DEFAULT_MAX_DIMENSION;
  const maxH = request.maxHeight ?? DEFAULT_MAX_DIMENSION;
  return {
    width: Math.max(1, Math.min(Math.floor(maxW), Math.round(bbox.width * scale))),
    height: Math.max(1, Math.min(Math.floor(maxH), Math.round(bbox.height * scale))),
  };
}

/** The scale that honours the request and still fits maxWidth and maxHeight. */
function fitScale(bbox: Bbox, request: SnapshotRequest): number {
  const requested = Math.min(request.scale ?? 1, MAX_SCALE);
  const maxW = request.maxWidth ?? DEFAULT_MAX_DIMENSION;
  const maxH = request.maxHeight ?? DEFAULT_MAX_DIMENSION;
  return Math.max(MIN_SCALE, Math.min(requested, maxW / bbox.width, maxH / bbox.height));
}

function textBlock(snapshot: Omit<Snapshot, "text" | "png">, notes: readonly string[]): string {
  const lines = [
    `bbox x=${num(snapshot.bbox.x)} y=${num(snapshot.bbox.y)} width=${num(snapshot.bbox.width)} height=${num(snapshot.bbox.height)}`,
    `scale ${num(snapshot.scale)}`,
    `pixels ${snapshot.width}x${snapshot.height}`,
    `ids ${snapshot.ids.join(", ")}`,
  ];
  if (snapshot.placeholders.length) lines.push(`placeholders ${snapshot.placeholders.join(", ")}`);
  return [...lines, ...notes].join("\n");
}

function emptySnapshot(unknownIds: string[]): Snapshot {
  const reason = unknownIds.length
    ? `no elements to render; unknown id(s): ${unknownIds.join(", ")}`
    : "no elements to render; the selection is empty";
  return {
    png: null,
    width: 0,
    height: 0,
    bbox: { x: 0, y: 0, width: 0, height: 0 },
    scale: 0,
    ids: [],
    placeholders: [],
    unknownIds,
    text: reason,
  };
}

/**
 * Renders the requested region to a PNG.
 *
 * The scale is reduced twice over: once to fit `maxWidth`/`maxHeight`, and
 * again, re-rendering, while the PNG is over `MAX_PNG_BYTES`. Every reduction
 * is reported in the text block, because the model reads the pixel size back
 * to map what it sees onto scene coordinates.
 */
export async function snapshotScene(
  all: readonly ExcalidrawElement[],
  request: SnapshotRequest = {},
): Promise<Snapshot> {
  const { elements, unknownIds } = selectForSnapshot(all, request);
  if (!elements.length) return emptySnapshot(unknownIds);

  const bbox = request.bbox ?? boundsOf(elements);
  const requested = Math.min(request.scale ?? 1, MAX_SCALE);
  const fitted = fitScale(bbox, request);
  let scale = fitted;
  let size = pixelSize(bbox, scale, request);
  let png = await rasterise(buildSvg(elements, bbox, size.width, size.height));
  for (let attempt = 0; attempt < 6 && png.length > MAX_PNG_BYTES && scale > MIN_SCALE; attempt += 1) {
    scale = Math.max(MIN_SCALE, scale * Math.min(0.9, Math.sqrt(MAX_PNG_BYTES / png.length)));
    size = pixelSize(bbox, scale, request);
    png = await rasterise(buildSvg(elements, bbox, size.width, size.height));
  }

  const notes: string[] = [];
  if (scale < requested) {
    const reasons = [
      ...(fitted < requested ? ["fit maxWidth and maxHeight"] : []),
      ...(scale < fitted ? ["keep the PNG under 4 MB"] : []),
    ];
    notes.push(`scale reduced from ${num(requested)} to ${num(scale)} to ${reasons.join(" and ")}`);
  }

  const core = {
    width: size.width,
    height: size.height,
    bbox,
    scale,
    ids: elements.map((e) => e.id),
    placeholders: placeholderIds(elements),
    unknownIds,
  };
  const trailing = unknownIds.length ? [...notes, `unknown id(s): ${unknownIds.join(", ")}`] : notes;
  return { ...core, png, text: textBlock(core, trailing) };
}
