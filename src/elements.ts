/**
 * Element construction and summarisation.
 *
 * Builders produce complete Excalidraw elements (every field the 0.18 renderer
 * reads) from a compact spec, so the calling agent does not have to emit the
 * full element shape. The summariser goes the other way: it renders a scene as
 * short lines an agent can read, including a coarse path for freehand strokes.
 */
import { generateKeyBetween } from "fractional-indexing";
import { isValidHandle } from "./handle.js";
import type { ElementLike } from "./reconcile.js";

export type ExcalidrawElement = ElementLike & {
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isDeleted: boolean;
  boundElements: { id: string; type: string }[] | null;
  containerId?: string | null;
  text?: string;
  points?: [number, number][];
  startBinding?: StoredBinding | null;
  endBinding?: StoredBinding | null;
  strokeColor?: string;
  backgroundColor?: string;
  link?: string | null;
  /** Groups the element belongs to. Upstream writes an empty array, never undefined. */
  groupIds?: string[] | null;
  /** Frame the element sits in, by frame id. */
  frameId?: string | null;
  /** A frame's title, which is the only text a frame carries. */
  name?: string | null;
};

/** BindMode, packages/element/src/types.ts: how the arrow meets the shape. */
export type BindMode = "inside" | "orbit" | "skip";

/**
 * The arrow binding upstream writes (FixedPointBinding): the bound element, the
 * binding point as a ratio of that element's box, and the bind mode. Storing a
 * ratio rather than a resolved point is what lets the app re-derive the arrow
 * end after the shape is moved or resized, including across a reload.
 */
export interface Binding {
  elementId: string;
  fixedPoint: [number, number];
  mode: BindMode;
}

/**
 * A binding as it may arrive in a scene. Clients older than upstream's move to
 * fixedPoint wrote a `focus`/`gap` pair with a null fixedPoint instead, and a
 * scene carrying those must still load here, so everything past `elementId` -
 * the only field this server reads - is left as an open record rather than
 * named and validated.
 */
export type StoredBinding = Binding | { elementId: string; fixedPoint: null; [older: string]: unknown };

export type ShapeType = "rectangle" | "ellipse" | "diamond";
export type LinearType = "arrow" | "line";

export interface ElementSpec {
  type: ShapeType | LinearType | "text" | "freedraw";
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  /** Text content for text elements. */
  text?: string;
  /** Bound label for shapes and arrows. */
  label?: string;
  fontSize?: number;
  /** Absolute points for arrows, lines and freedraw. */
  points?: [number, number][];
  /** Element id an arrow or line starts at. */
  start?: string;
  /** Element id an arrow or line ends at. */
  end?: string;
  /** URL the element links to. Renders a link icon on the canvas; null when absent. */
  link?: string;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  strokeStyle?: "solid" | "dashed" | "dotted";
  fillStyle?: "solid" | "hachure" | "cross-hatch" | "zigzag";
  rounded?: boolean;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  roughness?: number;
  opacity?: number;
}

const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";

export function randomId(length = 20): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => ID_ALPHABET[b % ID_ALPHABET.length]).join("");
}

export function randomInteger(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

/** Approximate text metrics. Excalidraw measures with a canvas; we cannot. */
export function measureText(text: string, fontSize: number): { width: number; height: number } {
  const lines = text.split("\n");
  const longest = Math.max(...lines.map((l) => l.length), 1);
  return {
    width: Math.ceil(longest * fontSize * 0.6),
    height: Math.ceil(lines.length * fontSize * 1.25),
  };
}

interface BaseInit {
  id?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  strokeColor?: string;
  backgroundColor?: string;
  strokeWidth?: number;
  strokeStyle?: string;
  fillStyle?: string;
  roughness?: number;
  opacity?: number;
  link?: string | null;
}

function base(type: string, init: BaseInit): ExcalidrawElement {
  return {
    id: init.id ?? randomId(),
    type,
    x: init.x,
    y: init.y,
    width: init.width,
    height: init.height,
    angle: 0,
    strokeColor: init.strokeColor ?? "#1e1e1e",
    backgroundColor: init.backgroundColor ?? "transparent",
    fillStyle: init.fillStyle ?? "solid",
    strokeWidth: init.strokeWidth ?? 2,
    strokeStyle: init.strokeStyle ?? "solid",
    roughness: init.roughness ?? 1,
    opacity: init.opacity ?? 100,
    groupIds: [],
    frameId: null,
    index: null,
    roundness: null,
    seed: randomInteger(),
    version: 1,
    versionNonce: randomInteger(),
    isDeleted: false,
    boundElements: null,
    updated: Date.now(),
    link: init.link ?? null,
    locked: false,
  };
}

function textElement(
  text: string,
  init: Omit<BaseInit, "width" | "height"> & {
    fontSize?: number;
    containerId?: string | null;
    textAlign?: string;
    verticalAlign?: string;
  },
): ExcalidrawElement {
  const fontSize = init.fontSize ?? 20;
  const { width, height } = measureText(text, fontSize);
  return {
    ...base("text", { ...init, width, height }),
    text,
    originalText: text,
    fontSize,
    fontFamily: 5,
    textAlign: init.textAlign ?? "left",
    verticalAlign: init.verticalAlign ?? "top",
    containerId: init.containerId ?? null,
    autoResize: true,
    lineHeight: 1.25,
  };
}

function centre(el: ExcalidrawElement): [number, number] {
  return [el.x + el.width / 2, el.y + el.height / 2];
}

/** How far outside a bound shape's outline an arrow end stops, in px. */
const EDGE_OUTSET = 4;

/**
 * Point on the bounding box of `el`, pushed `outset` px further out, where a
 * line from its centre towards `target` exits.
 */
function edgePoint(el: ExcalidrawElement, target: [number, number], outset: number): [number, number] {
  const [cx, cy] = centre(el);
  let dx = target[0] - cx;
  let dy = target[1] - cy;
  if (dx === 0 && dy === 0) {
    // Target sits on our centre (for example two shapes stacked exactly).
    // Pick a fixed direction rather than dividing by zero.
    dx = 1;
    dy = 0;
  }
  const len = Math.hypot(dx, dy);
  const tx = dx !== 0 ? el.width / 2 / Math.abs(dx) : Infinity;
  const ty = dy !== 0 ? el.height / 2 / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty);
  const ex = cx + dx * t + (dx / len) * outset;
  const ey = cy + dy * t + (dy / len) * outset;
  return [ex, ey];
}

// Ported from packages/element/src/binding.ts at excalidraw/excalidraw
// 854d00c31b7105290396fe34294fc2a0331ea469 - the SHA src/interop.test.ts pins.
const FIXED_POINT_BOUND = 10;
const MIN_BINDABLE_SIZE = 1;

/**
 * normalizeFixedPoint, packages/element/src/binding.ts @ 854d00c: clamp each
 * ratio to +-FIXED_POINT_BOUND, then nudge a ratio within 1e-4 of 0.5 to 0.5001
 * so a centred arrow does not flip its heading on floating-point noise.
 */
function normalizeFixedPoint(ratio: [number, number]): [number, number] {
  const epsilon = 0.0001;
  const clamp = (n: number) => Math.min(Math.max(n, -FIXED_POINT_BOUND), FIXED_POINT_BOUND);
  const clamped: [number, number] = [clamp(ratio[0]), clamp(ratio[1])];
  if (Math.abs(clamped[0] - 0.5) < epsilon || Math.abs(clamped[1] - 0.5) < epsilon) {
    return clamped.map((n) => (Math.abs(n - 0.5) < epsilon ? 0.5001 : n)) as [number, number];
  }
  return clamped;
}

/**
 * The binding point on `el` expressed as a ratio of its box, which is the
 * fixedPoint upstream stores.
 *
 * calculateFixedPointForNonElbowArrowBinding in
 * packages/element/src/binding.ts @ 854d00c31b7105290396fe34294fc2a0331ea469
 * divides the bound point's offset from the element origin by the element's
 * width and height, floors each divisor at the binding gap so a near-zero-size
 * shape cannot blow the ratio up, sends the pair through normalizeFixedPoint,
 * and binds a shape smaller than MIN_BINDABLE_SIZE to its centre because it has
 * no interior to anchor into. Upstream de-rotates the point around the element
 * centre first; every element this file builds has angle 0, so that rotation is
 * the identity here.
 */
function fixedPointFor(el: ExcalidrawElement, point: [number, number]): [number, number] {
  if (el.width < MIN_BINDABLE_SIZE || el.height < MIN_BINDABLE_SIZE) {
    return normalizeFixedPoint([0.5, 0.5]);
  }
  return normalizeFixedPoint([
    (point[0] - el.x) / Math.max(el.width, EDGE_OUTSET),
    (point[1] - el.y) / Math.max(el.height, EDGE_OUTSET),
  ]);
}

function addBound(el: ExcalidrawElement, ref: { id: string; type: string }): ExcalidrawElement {
  const existing = el.boundElements ?? [];
  if (existing.some((b) => b.id === ref.id)) return el;
  return { ...el, boundElements: [...existing, ref] };
}

export interface BuildContext {
  /** Existing scene elements, used to resolve `start`/`end` bindings. */
  existing: Map<string, ExcalidrawElement>;
  /** Highest fractional index currently in the scene, or null for an empty scene. */
  lastIndex: string | null;
}

export interface BuildResult {
  /** New elements to insert, in z-order. */
  created: ExcalidrawElement[];
  /** Existing elements that changed (bound-element back references). */
  updated: ExcalidrawElement[];
}

/**
 * Build complete elements from specs. Specs are processed in order so an arrow
 * may reference a shape created earlier in the same batch.
 */
// Characterization tests pin this function first: https://github.com/bjcoombs/excalidraw-room-mcp/issues/4
// eslint-disable-next-line complexity
export function buildElements(specs: ElementSpec[], ctx: BuildContext): BuildResult {
  const created: ExcalidrawElement[] = [];
  const touched = new Map<string, ExcalidrawElement>();
  const lookup = (id: string): ExcalidrawElement | undefined =>
    touched.get(id) ?? created.find((e) => e.id === id) ?? ctx.existing.get(id);
  const remember = (el: ExcalidrawElement) => {
    const idx = created.findIndex((e) => e.id === el.id);
    if (idx >= 0) created[idx] = el;
    else touched.set(el.id, el);
  };

  const seen = new Set<string>();
  const conflicts: string[] = [];
  const repeated: string[] = [];
  for (const spec of specs) {
    if (spec.id === undefined) continue;
    if (spec.id === "") throw new Error("element id must not be empty");
    if (ctx.existing.has(spec.id)) conflicts.push(spec.id);
    if (seen.has(spec.id)) repeated.push(spec.id);
    seen.add(spec.id);
  }
  if (conflicts.length) {
    throw new Error(`element id(s) already in the scene: ${conflicts.join(", ")}. Use update_elements to change them.`);
  }
  if (repeated.length) {
    throw new Error(`element id(s) repeated within the batch: ${repeated.join(", ")}`);
  }

  for (const spec of specs) {
    switch (spec.type) {
      case "rectangle":
      case "ellipse":
      case "diamond": {
        const shape: ExcalidrawElement = {
          ...base(spec.type, {
            id: spec.id,
            x: spec.x ?? 0,
            y: spec.y ?? 0,
            width: spec.width ?? 160,
            height: spec.height ?? 80,
            strokeColor: spec.strokeColor,
            backgroundColor: spec.backgroundColor,
            strokeWidth: spec.strokeWidth,
            strokeStyle: spec.strokeStyle,
            fillStyle: spec.fillStyle,
            roughness: spec.roughness,
            opacity: spec.opacity,
            link: spec.link,
          }),
          roundness: spec.rounded === false || spec.type !== "rectangle" ? null : { type: 3 },
        };
        created.push(shape);
        if (spec.label) {
          const label = textElement(spec.label, {
            x: shape.x,
            y: shape.y,
            fontSize: spec.fontSize ?? 20,
            containerId: shape.id,
            textAlign: "center",
            verticalAlign: "middle",
            strokeColor: spec.strokeColor,
          });
          const laid = layoutBoundLabel(shape, label);
          created.push(laid.label);
          remember(addBound(laid.container, { id: label.id, type: "text" }));
        }
        break;
      }
      case "text": {
        created.push(
          textElement(spec.text ?? spec.label ?? "", {
            id: spec.id,
            x: spec.x ?? 0,
            y: spec.y ?? 0,
            fontSize: spec.fontSize,
            strokeColor: spec.strokeColor,
            opacity: spec.opacity,
            link: spec.link,
          }),
        );
        break;
      }
      case "arrow":
      case "line": {
        let absolute: [number, number][] = spec.points ? [...spec.points] : [];
        const startEl = spec.start ? lookup(spec.start) : undefined;
        const endEl = spec.end ? lookup(spec.end) : undefined;
        if (spec.start && !startEl) throw new Error(`start element not found: ${spec.start}`);
        if (spec.end && !endEl) throw new Error(`end element not found: ${spec.end}`);
        // The arrow stops EDGE_OUTSET px clear of the outline, but the binding
        // records the point on the outline itself, which is what upstream's
        // fixedPoint is a ratio of.
        let startAnchor: [number, number] | null = null;
        let endAnchor: [number, number] | null = null;
        if (startEl && endEl) {
          const mid: [number, number][] = absolute.length >= 2 ? absolute.slice(1, -1) : [];
          const towardsEnd = mid[0] ?? centre(endEl);
          const towardsStart = mid[mid.length - 1] ?? centre(startEl);
          startAnchor = edgePoint(startEl, towardsEnd, 0);
          endAnchor = edgePoint(endEl, towardsStart, 0);
          absolute = [
            edgePoint(startEl, towardsEnd, EDGE_OUTSET),
            ...mid,
            edgePoint(endEl, towardsStart, EDGE_OUTSET),
          ];
        } else if (startEl && absolute.length >= 1) {
          const towards = absolute[absolute.length - 1];
          startAnchor = edgePoint(startEl, towards, 0);
          absolute = [edgePoint(startEl, towards, EDGE_OUTSET), ...absolute.slice(1)];
        } else if (endEl && absolute.length >= 1) {
          const towards = absolute[0];
          endAnchor = edgePoint(endEl, towards, 0);
          absolute = [...absolute.slice(0, -1), edgePoint(endEl, towards, EDGE_OUTSET)];
        }
        if (absolute.length < 2) {
          throw new Error(`${spec.type} needs at least two points, or start and end element ids`);
        }
        const [ox, oy] = absolute[0];
        const rel = absolute.map(([px, py]) => [px - ox, py - oy] as [number, number]);
        const xs = rel.map((p) => p[0]);
        const ys = rel.map((p) => p[1]);
        const width = Math.max(...xs) - Math.min(...xs);
        const height = Math.max(...ys) - Math.min(...ys);
        const linear: ExcalidrawElement = {
          ...base(spec.type, {
            id: spec.id,
            x: ox,
            y: oy,
            width,
            height,
            strokeColor: spec.strokeColor,
            backgroundColor: spec.backgroundColor,
            strokeWidth: spec.strokeWidth,
            strokeStyle: spec.strokeStyle,
            roughness: spec.roughness,
            opacity: spec.opacity,
            link: spec.link,
          }),
          roundness: { type: 2 },
          points: rel,
          lastCommittedPoint: null,
          startBinding:
            startEl && startAnchor
              ? { elementId: startEl.id, fixedPoint: fixedPointFor(startEl, startAnchor), mode: "orbit" }
              : null,
          endBinding:
            endEl && endAnchor
              ? { elementId: endEl.id, fixedPoint: fixedPointFor(endEl, endAnchor), mode: "orbit" }
              : null,
          startArrowhead: spec.startArrowhead ?? null,
          endArrowhead: spec.endArrowhead ?? (spec.type === "arrow" ? "arrow" : null),
          ...(spec.type === "arrow" ? { elbowed: false } : {}),
        };
        created.push(linear);
        if (startEl) remember(addBound(startEl, { id: linear.id, type: spec.type }));
        if (endEl) remember(addBound(endEl, { id: linear.id, type: spec.type }));
        if (spec.label) {
          const fontSize = spec.fontSize ?? 16;
          const m = measureText(spec.label, fontSize);
          const midIdx = Math.floor(absolute.length / 2);
          const a = absolute[midIdx - 1];
          const b = absolute[midIdx];
          const mx = (a[0] + b[0]) / 2;
          const my = (a[1] + b[1]) / 2;
          const label = textElement(spec.label, {
            x: mx - m.width / 2,
            y: my - m.height / 2,
            fontSize,
            containerId: linear.id,
            textAlign: "center",
            verticalAlign: "middle",
            strokeColor: spec.strokeColor,
          });
          created.push(label);
          remember(addBound(linear, { id: label.id, type: "text" }));
        }
        break;
      }
      case "freedraw": {
        const pts = spec.points ?? [];
        if (pts.length < 2) throw new Error("freedraw needs at least two points");
        const [ox, oy] = pts[0];
        const rel = pts.map(([px, py]) => [px - ox, py - oy] as [number, number]);
        const xs = rel.map((p) => p[0]);
        const ys = rel.map((p) => p[1]);
        created.push({
          ...base("freedraw", {
            id: spec.id,
            x: ox,
            y: oy,
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
            strokeColor: spec.strokeColor,
            strokeWidth: spec.strokeWidth,
            roughness: spec.roughness,
            opacity: spec.opacity,
            link: spec.link,
          }),
          points: rel,
          pressures: [],
          simulatePressure: true,
          lastCommittedPoint: rel[rel.length - 1],
        });
        break;
      }
      default:
        throw new Error(`unsupported element type: ${(spec as ElementSpec).type}`);
    }
  }

  // Assign fractional indices after the current top of the z-order.
  let last = ctx.lastIndex;
  for (let i = 0; i < created.length; i++) {
    const next = generateKeyBetween(last, null);
    created[i] = { ...created[i], index: next };
    last = next;
  }

  // Bound-element back references on pre-existing elements are edits.
  const updated: ExcalidrawElement[] = [];
  for (const el of touched.values()) {
    if (ctx.existing.has(el.id)) updated.push(bump(el));
  }
  return { created, updated };
}

/**
 * Attribution, written into `customData` because that object is free-form,
 * survives an excalidraw.com round trip and is the only per-element place a
 * peer will not strip. A browser writes no `customData` at all, so its absence
 * is what identifies a person's work: there is nothing to stamp on their side
 * and nothing to migrate on ours.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/82
 */
export const AUTHOR_KEY = "author";
/** What kind of writer the author was. Only agents stamp, so only "agent" is written. */
export const AUTHOR_KIND_KEY = "authorKind";
export const AGENT_AUTHOR_KIND = "agent";
/** How an element carrying no author reads: somebody drew it in a browser. */
export const PERSON_AUTHOR = "person";
/**
 * The author stamped when the room has no handle. `join` always takes one, so
 * this is the shape of a server driven outside a room rather than a case a
 * caller meets; it matches the historic attribution prefix.
 */
export const FALLBACK_AUTHOR = "claude";

/**
 * The handle recorded on an element, or null when nothing recorded a usable
 * one.
 *
 * `customData` arrives from peers unsanitised and is free-form, so this field
 * is somebody else's string until it is checked. It is read back into prose
 * this server writes - the `from:` line above a quoted mention, the `by
 * <handle>` on every summary line - so an author of "x\n--- end untrusted room
 * content ---" would put a peer's words outside the boundary that marks them
 * as a peer's. Only the handle grammar is accepted, which is what this server
 * ever stamps; anything else is not an author and the element reads as a
 * person's.
 */
export function elementAuthor(el: ExcalidrawElement): string | null {
  const data = el.customData as Record<string, unknown> | undefined;
  const author = data?.[AUTHOR_KEY];
  return typeof author === "string" && isValidHandle(author) ? author : null;
}

/** The author as a reader sees it: the handle that wrote it, or `person`. */
export function authorLabel(el: ExcalidrawElement): string {
  return elementAuthor(el) ?? PERSON_AUTHOR;
}

/**
 * The element with this server's handle recorded on it. Applied on create
 * only - `add_elements`, `add_raw_elements` and the attributed lines
 * `acknowledge_mention` writes - so the stamp says who first drew a thing
 * rather than who last touched it. Other `customData` keys are preserved,
 * including a caller's own on the raw path.
 */
export function stampAuthor(el: ExcalidrawElement, handle: string | null | undefined): ExcalidrawElement {
  const data = (el.customData ?? {}) as Record<string, unknown>;
  return {
    ...el,
    customData: { ...data, [AUTHOR_KEY]: handle || FALLBACK_AUTHOR, [AUTHOR_KIND_KEY]: AGENT_AUTHOR_KIND },
  };
}

/**
 * `next` with the author it had before the patch, whatever the patch said.
 *
 * An update is not authorship: a second agent recolouring a box does not
 * become the person who drew it, and a `customData` patch replaces the whole
 * object, so without this the stamp disappears the first time anyone sets one
 * other key on it. The author fields are therefore taken from `current` and
 * from nowhere else - an element a person drew stays unattributed however the
 * caller patches it.
 */
export function keepAuthor(current: ExcalidrawElement, next: ExcalidrawElement): ExcalidrawElement {
  const before = current.customData as Record<string, unknown> | undefined;
  const after = next.customData as Record<string, unknown> | undefined;
  const author = before?.[AUTHOR_KEY];
  const kind = before?.[AUTHOR_KIND_KEY];
  if (after === undefined && author === undefined && kind === undefined) return next;
  const data: Record<string, unknown> = { ...after };
  delete data[AUTHOR_KEY];
  delete data[AUTHOR_KIND_KEY];
  if (author !== undefined) data[AUTHOR_KEY] = author;
  if (kind !== undefined) data[AUTHOR_KIND_KEY] = kind;
  return { ...next, customData: data };
}

/** Smallest gap kept between a bound label's box and its container's edge, in px. */
export const LABEL_PADDING = 10;

/**
 * Place a bound label inside its container and grow the container to fit it.
 *
 * Upstream draws a container's label from `originalText`, wrapped to the
 * container's width, so a label wider or taller than the box is clipped or
 * disappears. The container therefore grows - keeping its top-left corner, so
 * nothing else on the canvas moves - until the label fits with LABEL_PADDING
 * to spare, and the label is re-centred on the result.
 *
 * A linear container is the exception: an arrow's or line's width and height
 * are derived from its points, so resizing the box would move the line.
 * Those keep their geometry and only re-centre the label.
 */
export function layoutBoundLabel(
  container: ExcalidrawElement,
  label: ExcalidrawElement,
): { container: ExcalidrawElement; label: ExcalidrawElement } {
  const linear = container.type === "arrow" || container.type === "line";
  const width = linear ? container.width : Math.max(container.width, label.width + LABEL_PADDING);
  const height = linear ? container.height : Math.max(container.height, label.height + LABEL_PADDING);
  const fitted =
    width === container.width && height === container.height ? container : { ...container, width, height };
  return {
    container: fitted,
    label: {
      ...label,
      x: fitted.x + (fitted.width - label.width) / 2,
      y: fitted.y + (fitted.height - label.height) / 2,
    },
  };
}

/** Absolute scene coordinates of a linear element's points. */
function absolutePoints(el: ExcalidrawElement): [number, number][] {
  return (el.points ?? []).map(([px, py]) => [el.x + px, el.y + py] as [number, number]);
}

/**
 * `linear` with one end moved to `point`: the origin, the relative points and
 * the derived box all follow, because an arrow's `x`/`y` is its first point
 * and everything else is stored relative to it.
 */
function withEndpoint(
  linear: ExcalidrawElement,
  which: "start" | "end",
  point: [number, number],
): ExcalidrawElement {
  const abs = absolutePoints(linear);
  if (abs.length < 2) return linear;
  abs[which === "start" ? 0 : abs.length - 1] = point;
  const [ox, oy] = abs[0];
  const rel = abs.map(([px, py]) => [px - ox, py - oy] as [number, number]);
  const xs = rel.map((p) => p[0]);
  const ys = rel.map((p) => p[1]);
  return {
    ...linear,
    x: ox,
    y: oy,
    points: rel,
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

/**
 * `linear` re-attached to `shape` wherever it binds to it, or null when it
 * binds to something else.
 *
 * Excalidraw stores an arrow's endpoints absolutely and re-derives them from
 * the binding only while the app itself drags the shape. Nothing re-derives
 * them for a scene this server writes, so moving or resizing a shape leaves
 * every arrow into it pointing at where the shape used to be (issue #112).
 *
 * The new end lands on the shape's outline (outset 0) rather than the
 * EDGE_OUTSET gap `buildElements` leaves on creation: an end that has been
 * re-attached should read as touching the box it is bound to, and the
 * `fixedPoint` recorded alongside it is a ratio of that same outline point.
 */
export function rebindLinear(
  linear: ExcalidrawElement,
  shape: ExcalidrawElement,
): ExcalidrawElement | null {
  let next = linear;
  let changed = false;
  for (const which of ["start", "end"] as const) {
    const binding = which === "start" ? next.startBinding : next.endBinding;
    if (!binding || binding.elementId !== shape.id) continue;
    const abs = absolutePoints(next);
    if (abs.length < 2) continue;
    // Aim at the end that is staying put, so the arrow keeps its heading.
    const other = which === "start" ? abs[abs.length - 1] : abs[0];
    const anchor = edgePoint(shape, other, 0);
    const rebound: Binding = {
      elementId: shape.id,
      fixedPoint: fixedPointFor(shape, anchor),
      mode: binding.fixedPoint === null ? "orbit" : (binding as Binding).mode,
    };
    const moved = withEndpoint(next, which, anchor);
    next = which === "start" ? { ...moved, startBinding: rebound } : { ...moved, endBinding: rebound };
    changed = true;
  }
  return changed ? next : null;
}

/**
 * Everything bound to `after` brought back into agreement with its new box,
 * plus `after` itself in case fitting a label grew it.
 *
 * Bound text is re-laid out inside a shape and carried by the delta along a
 * linear container (an arrow's label has no box to be centred in - the arrow's
 * width and height come from its points). Bound arrows are re-attached.
 */
function relayoutBindings(
  before: ExcalidrawElement,
  after: ExcalidrawElement,
  lookup: (id: string) => ExcalidrawElement | undefined,
): { element: ExcalidrawElement; changed: ExcalidrawElement[] } {
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  const resized = after.width !== before.width || after.height !== before.height;
  const bounds = after.boundElements;
  if (!bounds || (dx === 0 && dy === 0 && !resized)) return { element: after, changed: [] };
  const linear = isLinear(after);
  let element = after;
  const changed: ExcalidrawElement[] = [];
  // Text first: fitting a label can grow the container, and the arrows are
  // then re-attached to the box that grew rather than the one that did not.
  for (const ref of bounds) {
    const bound = lookup(ref.id);
    if (!bound || bound.isDeleted || bound.type !== "text") continue;
    if (linear) {
      changed.push(bump({ ...bound, x: bound.x + dx, y: bound.y + dy }));
      continue;
    }
    const laid = layoutBoundLabel(element, bound);
    element = laid.container;
    changed.push(bump(laid.label));
  }
  for (const ref of bounds) {
    const bound = lookup(ref.id);
    if (!bound || bound.isDeleted) continue;
    if (!isLinear(bound)) continue;
    const rebound = rebindLinear(bound, element);
    if (rebound) changed.push(bump(rebound));
  }
  return { element, changed };
}

/**
 * Merge `set` over `current` and return every element that changed, bumped.
 *
 * Editing a text element's content is not a one-field change. Upstream renders
 * from `originalText`, not `text`, and re-renders a container's label only
 * when the container itself is marked changed, so a bare `text` write leaves
 * the box blank on the canvas while the scene model reports the new string
 * (issue #90). Here `originalText` follows `text`, the box is re-measured
 * unless the caller gave explicit dimensions, and a bound label is re-laid out
 * inside its container, which is returned bumped alongside it.
 *
 * Geometry is the mirror image of that (issue #112): a bound label and a bound
 * arrow carry their own absolute coordinates, so changing `x`, `y`, `width` or
 * `height` on a container without moving them leaves the label floating at the
 * old position and the arrows pointing at empty canvas.
 */
export function applyUpdate(
  current: ExcalidrawElement,
  set: Record<string, unknown>,
  lookup: (id: string) => ExcalidrawElement | undefined,
): ExcalidrawElement[] {
  let next = keepAuthor(current, { ...current, ...set, id: current.id } as ExcalidrawElement);
  const reflowed = next.type === "text" && ("text" in set || "fontSize" in set);
  if (reflowed) {
    if ("text" in set) next = { ...next, originalText: next.text };
    if (!("width" in set) && !("height" in set)) {
      const m = measureText(String(next.text ?? ""), Number(next.fontSize ?? 20));
      next = { ...next, width: m.width, height: m.height };
    }
  }
  const changed: ExcalidrawElement[] = [];
  const container = reflowed && next.containerId ? lookup(next.containerId) : undefined;
  if (container) {
    const laid = layoutBoundLabel(container, next);
    next = laid.label;
    changed.push(bump(laid.container));
  }
  const relaid = relayoutBindings(current, next, lookup);
  return [bump(relaid.element), ...changed, ...relaid.changed];
}

/** What `translate` moved, what it pulled in, and what it could not find. */
export interface TranslateResult {
  /** Elements moved by the delta, bumped, in scene order. */
  moved: ExcalidrawElement[];
  /** Arrows bound at one end to something moved: re-attached rather than moved. */
  rebound: ExcalidrawElement[];
  /** Ids the closure added: everything moved that was not asked for, in scene order. */
  added: string[];
  /** Requested ids that are not in the scene. */
  missing: string[];
}

/** Arrows and lines: the two types whose geometry is a list of points. */
function isLinear(el: ExcalidrawElement): boolean {
  return el.type === "arrow" || el.type === "line";
}

function pushInto(map: Map<string, string[]>, key: string, id: string): void {
  const existing = map.get(key);
  if (existing) existing.push(id);
  else map.set(key, [id]);
}

/**
 * Every id that travels when `requested` moves: the ids themselves, their
 * bound labels, their groups' other members, a translated frame's children,
 * and any arrow whose two ends are both in the set. A both-ends arrow may
 * itself carry a label, so the worklist is re-run until nothing new arrives.
 */
function translationClosure(requested: readonly string[], live: readonly ExcalidrawElement[]): Set<string> {
  const byId = new Map(live.map((e) => [e.id, e]));
  const members = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const el of live) {
    for (const group of el.groupIds ?? []) pushInto(members, group, el.id);
    if (el.frameId) pushInto(children, el.frameId, el.id);
  }
  const picked = new Set<string>();
  const queue = [...requested];
  let growing = true;
  while (growing) {
    while (queue.length) {
      const id = queue.pop() as string;
      const el = byId.get(id);
      if (!el || picked.has(id)) continue;
      picked.add(id);
      for (const group of el.groupIds ?? []) queue.push(...(members.get(group) ?? []));
      queue.push(...(children.get(id) ?? []));
      for (const ref of el.boundElements ?? []) {
        if (byId.get(ref.id)?.type === "text") queue.push(ref.id);
      }
    }
    const spanning = arrowsSpanning(live, picked);
    queue.push(...spanning);
    growing = spanning.length > 0;
  }
  return picked;
}

/** Ids of the arrows and lines not yet picked whose two ends are both picked. */
function arrowsSpanning(live: readonly ExcalidrawElement[], picked: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  for (const el of live) {
    if (picked.has(el.id) || !isLinear(el)) continue;
    const from = el.startBinding?.elementId;
    const to = el.endBinding?.elementId;
    if (from === undefined || to === undefined) continue;
    if (picked.has(from) && picked.has(to)) ids.push(el.id);
  }
  return ids;
}

/** The arrows left behind by a translation, each re-attached to what moved under it. */
function reattachArrows(
  live: readonly ExcalidrawElement[],
  picked: ReadonlySet<string>,
  moved: ReadonlyMap<string, ExcalidrawElement>,
): ExcalidrawElement[] {
  const rebound: ExcalidrawElement[] = [];
  for (const el of live) {
    if (picked.has(el.id) || !isLinear(el)) continue;
    const ends = [el.startBinding?.elementId, el.endBinding?.elementId];
    let next = el;
    let touched = false;
    for (const [i, id] of ends.entries()) {
      // Both ends bound to one shape are re-computed together by the first
      // call, so the duplicate is skipped rather than re-computed off itself.
      if (id === undefined || ends.indexOf(id) !== i) continue;
      const shape = moved.get(id);
      if (!shape) continue;
      const re = rebindLinear(next, shape);
      if (re) {
        next = re;
        touched = true;
      }
    }
    if (touched) rebound.push(bump(next));
  }
  return rebound;
}

/**
 * Move `ids` by (dx, dy) together with everything that must travel with them.
 *
 * Excalidraw's own drag resolves this closure in the app; a scene written from
 * outside has to resolve it here or the drawing comes apart (issue #112). What
 * travels: a bound label, because it holds its own coordinates; every other
 * member of a group one of the ids belongs to, because a group moves as one;
 * the children of a translated frame; and an arrow bound at *both* ends to
 * elements that are moving, because both of its ends are moving by the same
 * delta. An arrow bound at one end is not moved - the shape moved under it and
 * the other end stayed - so it is re-attached instead, and reported separately.
 *
 * Each element is moved exactly once however many ways the closure reaches it.
 */
export function translate(
  ids: readonly string[],
  dx: number,
  dy: number,
  elements: readonly ExcalidrawElement[],
): TranslateResult {
  const live = elements.filter((e) => !e.isDeleted);
  const present = new Set(live.map((e) => e.id));
  const missing = ids.filter((id) => !present.has(id));
  const asked = new Set(ids.filter((id) => present.has(id)));
  const picked = translationClosure([...asked], live);

  const moved: ExcalidrawElement[] = [];
  const added: string[] = [];
  for (const el of live) {
    if (!picked.has(el.id)) continue;
    moved.push(bump({ ...el, x: el.x + dx, y: el.y + dy }));
    if (!asked.has(el.id)) added.push(el.id);
  }
  const rebound = reattachArrows(live, picked, new Map(moved.map((e) => [e.id, e])));
  return { moved, rebound, added, missing };
}

/** Return a copy with version bumped and a fresh nonce, as Excalidraw does on every mutation. */
export function bump(el: ExcalidrawElement): ExcalidrawElement {
  return { ...el, version: el.version + 1, versionNonce: randomInteger(), updated: Date.now() };
}

function round(n: number): number {
  return Math.round(n);
}

function samplePoints(points: [number, number][], max: number): [number, number][] {
  if (points.length <= max) return points;
  const out: [number, number][] = [];
  for (let i = 0; i < max; i++) {
    const idx = Math.round((i * (points.length - 1)) / (max - 1));
    out.push(points[idx]);
  }
  return out;
}

/**
 * Why an element is in a neighbourhood although it sits outside the radius:
 * id -> one of `via arrow <id>`, `via group` or `via frame <id>`. Elements
 * picked by the radius itself carry no reason and are absent from the map.
 */
export type SummaryReasons = ReadonlyMap<string, string>;

/**
 * One line per element, readable by a person or an agent.
 *
 * `reasons` is the neighbourhood's hop map: an element reached by following an
 * arrow binding, a group or a frame is a long way from the note it is listed
 * under, so its line ends with why it is there. Without the marker the model
 * reads a far shape as being next to the mention.
 */
export function summarise(elements: readonly ExcalidrawElement[], reasons: SummaryReasons = new Map()): string {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const labelFor = new Map<string, ExcalidrawElement>();
  for (const el of elements) {
    if (el.type === "text" && el.containerId && !el.isDeleted) {
      labelFor.set(el.containerId, el);
    }
  }
  const lines: string[] = [];
  for (const el of elements) {
    if (el.isDeleted) continue;
    if (el.type === "text" && el.containerId && byId.has(el.containerId)) continue;
    lines.push(summaryLine(el, labelFor.get(el.id), reasons.get(el.id)));
  }
  return lines.join("\n");
}

/**
 * Whether a bound label's centre has come adrift from its container's box.
 *
 * The summary folds a label into its container's line, so a scene where the
 * two disagree - the container moved and the label did not - reads as if
 * nothing were wrong. This is what puts the disagreement on the line.
 */
function labelEscaped(container: ExcalidrawElement, label: ExcalidrawElement): boolean {
  const cx = label.x + label.width / 2;
  const cy = label.y + label.height / 2;
  return cx < container.x || cx > container.x + container.width || cy < container.y || cy > container.y + container.height;
}

/** One element's line: what it is, where, what it says, and why it is listed. */
function summaryLine(el: ExcalidrawElement, label: ExcalidrawElement | undefined, reason: string | undefined): string {
  const parts: string[] = [`${el.id} ${el.type}`];
  if (el.type === "freedraw" || el.type === "arrow" || el.type === "line") {
    const pts = (el.points ?? []).map(([px, py]) => [round(el.x + px), round(el.y + py)] as [number, number]);
    const sampled = samplePoints(pts, 8);
    parts.push(`${pts.length} pts: ${sampled.map(([px, py]) => `(${px},${py})`).join(" -> ")}`);
    if (el.startBinding) parts.push(`from ${el.startBinding.elementId}`);
    if (el.endBinding) parts.push(`to ${el.endBinding.elementId}`);
  } else {
    parts.push(`@(${round(el.x)},${round(el.y)}) ${round(el.width)}x${round(el.height)}`);
  }
  if (el.type === "text") parts.push(`"${el.text ?? ""}"`);
  // A frame's title is a property rather than a child element - frames are the
  // only type carrying one - so it only reaches the model if this prints it.
  if (el.name) parts.push(`"${el.name}"`);
  if (label !== undefined) {
    parts.push(`"${label.text ?? ""}"`);
    if (labelEscaped(el, label)) parts.push(`(label at ${round(label.x)},${round(label.y)}, outside container)`);
  }
  if (el.strokeColor && el.strokeColor !== "#1e1e1e") parts.push(`stroke=${el.strokeColor}`);
  if (el.backgroundColor && el.backgroundColor !== "transparent") parts.push(`fill=${el.backgroundColor}`);
  if (reason !== undefined) parts.push(reason);
  // Last, so the line reads as a sentence and the reason keeps its place: the
  // author is who wrote the element, and `by person` is a browser's element,
  // which carries no attribution to read.
  parts.push(`by ${authorLabel(el)}`);
  return parts.join(" ");
}

/**
 * Width every run of words this server writes on the canvas is wrapped to, in
 * canvas px.
 *
 * Excalidraw renders a peer's text exactly as delivered - it re-wraps only
 * text it edits itself - so a sentence written as one line stays one line and
 * a two-sentence answer runs 1,600 px across the drawing it was written about.
 * The server therefore does the wrapping, and 360 px is about a column of
 * prose at the default font size: wide enough for a question to sit on one
 * line, narrow enough to read beside a diagram.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/107
 */
export const WRAP_WIDTH = 360;

/** How many leading characters of `word` fit in `width`, at least one. */
function longestFitting(word: string, width: number, fontSize: number): number {
  let take = 1;
  while (take < word.length && measureText(word.slice(0, take + 1), fontSize).width <= width) take++;
  return take;
}

/**
 * `text` with newlines inserted so no line measures wider than `width`.
 *
 * Greedy by word, using the same {@link measureText} approximation the rest of
 * the module lays out with, so a wrapped line and the box drawn around it
 * agree. Newlines already in the text are paragraph breaks and are kept, blank
 * lines included; a single word too long for the width is broken rather than
 * left to overflow, because one unbreakable token would otherwise widen the
 * whole block.
 */
export function wrapText(text: string, width: number = WRAP_WIDTH, fontSize = 20): string {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(" ")) {
      if (line !== "" && measureText(`${line} ${word}`, fontSize).width <= width) {
        line = `${line} ${word}`;
        continue;
      }
      if (line !== "") out.push(line);
      let rest = word;
      while (measureText(rest, fontSize).width > width) {
        const take = longestFitting(rest, width, fontSize);
        out.push(rest.slice(0, take));
        rest = rest.slice(take);
      }
      line = rest;
    }
    out.push(line);
  }
  return out.join("\n");
}
