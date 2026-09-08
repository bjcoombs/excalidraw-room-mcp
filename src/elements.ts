/**
 * Element construction and summarisation.
 *
 * Builders produce complete Excalidraw elements (every field the 0.18 renderer
 * reads) from a compact spec, so the calling agent does not have to emit the
 * full element shape. The summariser goes the other way: it renders a scene as
 * short lines an agent can read, including a coarse path for freehand strokes.
 */
import { generateKeyBetween } from "fractional-indexing";
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
  startBinding?: Binding | null;
  endBinding?: Binding | null;
  strokeColor?: string;
  backgroundColor?: string;
};

export interface Binding {
  elementId: string;
  focus: number;
  gap: number;
  fixedPoint: null;
}

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
    link: null,
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

/** Point just outside the bounding box of `el`, `gap` px beyond where a line from its centre towards `target` exits. */
function edgePoint(el: ExcalidrawElement, target: [number, number], gap: number): [number, number] {
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
  const ex = cx + dx * t + (dx / len) * gap;
  const ey = cy + dy * t + (dy / len) * gap;
  return [ex, ey];
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
          }),
          roundness: spec.rounded === false || spec.type !== "rectangle" ? null : { type: 3 },
        };
        created.push(shape);
        if (spec.label) {
          const fontSize = spec.fontSize ?? 20;
          const m = measureText(spec.label, fontSize);
          const label = textElement(spec.label, {
            x: shape.x + (shape.width - m.width) / 2,
            y: shape.y + (shape.height - m.height) / 2,
            fontSize,
            containerId: shape.id,
            textAlign: "center",
            verticalAlign: "middle",
            strokeColor: spec.strokeColor,
          });
          created.push(label);
          remember(addBound(shape, { id: label.id, type: "text" }));
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
        const gap = 4;
        if (startEl && endEl) {
          const mid: [number, number][] = absolute.length >= 2 ? absolute.slice(1, -1) : [];
          const towardsEnd = mid[0] ?? centre(endEl);
          const towardsStart = mid[mid.length - 1] ?? centre(startEl);
          absolute = [edgePoint(startEl, towardsEnd, gap), ...mid, edgePoint(endEl, towardsStart, gap)];
        } else if (startEl && absolute.length >= 1) {
          absolute = [edgePoint(startEl, absolute[absolute.length - 1], gap), ...absolute.slice(1)];
        } else if (endEl && absolute.length >= 1) {
          absolute = [...absolute.slice(0, -1), edgePoint(endEl, absolute[0], gap)];
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
          }),
          roundness: { type: 2 },
          points: rel,
          lastCommittedPoint: null,
          startBinding: startEl ? { elementId: startEl.id, focus: 0, gap, fixedPoint: null } : null,
          endBinding: endEl ? { elementId: endEl.id, focus: 0, gap, fixedPoint: null } : null,
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

/** One line per element, readable by a person or an agent. */
export function summarise(elements: readonly ExcalidrawElement[]): string {
  const byId = new Map(elements.map((e) => [e.id, e]));
  const labelFor = new Map<string, string>();
  for (const el of elements) {
    if (el.type === "text" && el.containerId && !el.isDeleted) {
      labelFor.set(el.containerId, el.text ?? "");
    }
  }
  const lines: string[] = [];
  for (const el of elements) {
    if (el.isDeleted) continue;
    if (el.type === "text" && el.containerId && byId.has(el.containerId)) continue;
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
    const label = labelFor.get(el.id);
    if (label !== undefined) parts.push(`"${label}"`);
    if (el.strokeColor && el.strokeColor !== "#1e1e1e") parts.push(`stroke=${el.strokeColor}`);
    if (el.backgroundColor && el.backgroundColor !== "transparent") parts.push(`fill=${el.backgroundColor}`);
    lines.push(parts.join(" "));
  }
  return lines.join("\n");
}
