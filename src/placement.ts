/**
 * Placement: where a new element goes, decided from the live scene.
 *
 * Two agents drawing at once pick coordinates independently, so they overlap:
 * Excalidraw resolves stacking by fractional index and concurrent edits by
 * last writer wins, and neither prevents two boxes landing on each other. The
 * server holds the whole scene, so it can answer "next free slot beside this"
 * instead, and a caller that asks for a slot never has to know where anything
 * already is.
 *
 * Layout is also context management. A mention hands the model everything
 * within the room's neighbourhood radius of the note, so what a diagram is
 * laid out like decides what reading one note costs. That is why a cluster
 * grows inwards before outwards, why it reports when it no longer fits inside
 * the radius, and why a new cluster is pushed more than a radius clear of the
 * old one: a note written on one cluster must not drag its neighbour in.
 *
 * Every function here is pure over the element list and deterministic given
 * it, so two agents placing against the same anchor in sequence - each seeing
 * the other's element - get different slots.
 */
import { LABEL_PADDING, measureText, type ElementSpec, type ExcalidrawElement } from "./elements.js";
import { boxDistance, DEFAULT_NEARBY_RADIUS, type Box } from "./mentions.js";

/** Step between candidate slots, and the space left around a placed element. */
export const DEFAULT_GAP = 20;
/** The size `buildElements` gives a shape whose spec names none, mirrored here. */
export const DEFAULT_SHAPE_WIDTH = 160;
export const DEFAULT_SHAPE_HEIGHT = 80;
/** The font size `buildElements` measures text at when a spec names none. */
export const DEFAULT_FONT_SIZE = 20;

/**
 * Where a cluster-placed element records the cluster it joined. A group would
 * be the obvious home, but Excalidraw groups are a selection tool - and the
 * neighbourhood already hops a whole group in, so grouping a growing cluster
 * would hand every mention on it the entire cluster and defeat the radius.
 * `customData` survives an excalidraw.com round trip, so the cluster outlives
 * this process.
 */
export const CLUSTER_CUSTOM_DATA_KEY = "excalidrawRoomCluster";

/** Sides an element may be placed on, plus `auto` for the nearest free one. */
export const SIDES = ["above", "below", "left", "right", "auto"] as const;
export type Side = (typeof SIDES)[number];
/** A side the search can actually scan along. */
export type FixedSide = Exclude<Side, "auto">;

/**
 * The order `auto` tries, which is also how it breaks a tie between two sides
 * the same distance away: below first, because a diagram grows downwards as it
 * is read, then right, then back over the top and the left.
 */
export const AUTO_SIDES: readonly FixedSide[] = ["below", "right", "above", "left"];

/** What a caller asked for in `place`. */
export interface PlaceRequest {
  /** Anchor element to sit beside. */
  near?: string;
  /** Anchor element whose cluster to join. */
  cluster?: string;
  /** Which side of the anchor, or the nearest free one. Defaults to `auto`. */
  side?: Side;
  /** Space left around the element, in canvas px. Defaults to {@link DEFAULT_GAP}. */
  gap?: number;
  /** Start a separate cluster, more than a radius clear of the anchor's. */
  newCluster?: boolean;
}

/** An `add_elements` spec that may ask to be placed rather than positioned. */
export interface PlacedSpec extends ElementSpec {
  place?: PlaceRequest;
}

export interface Size {
  width: number;
  height: number;
}

/** Refusals. Each names the argument it refused, because the caller fixes it. */
export const BOTH_ANCHORS_TEXT = "place takes near or cluster, not both: near sits beside one element, cluster joins the group around one.";
export const NO_ANCHOR_TEXT = "place needs near: <id> or cluster: <id>, the element the new one is positioned against.";
export const NEW_CLUSTER_NEEDS_NEAR_TEXT = "newCluster needs near: <id>: it starts a cluster clear of that anchor's, so cluster: <id> has nothing to do.";
export const SIDE_WITH_CLUSTER_TEXT = "side has no effect with cluster: the slot search fills the cluster's footprint and then grows it from its centre.";

export function anchorMissingText(id: string): string {
  return `place anchor not found: ${id}. Pass the id of an element in the scene, or one created earlier in this call.`;
}

export function unplaceableText(type: string): string {
  return `place cannot position a ${type}: its geometry comes from its points. Give the points you want, or bind it with start and end.`;
}

/** The phrase that says a cluster no longer fits inside the room's radius. */
export const OUTGROWN_TEXT = "cluster outgrown the radius";

/** A box with non-negative extent, whatever order its corners were given in. */
function normalise(b: Box): Box {
  return {
    x: Math.min(b.x, b.x + b.width),
    y: Math.min(b.y, b.y + b.height),
    width: Math.abs(b.width),
    height: Math.abs(b.height),
  };
}

/**
 * The box a search works in: normalised, then grown outwards to whole pixels.
 * Whole pixels in, whole pixels out - which is what lets the tool report the
 * coordinates it wrote rather than a rounding of them - and growing rather
 * than rounding means a fractional neighbour is never encroached on.
 */
export function integralBox(b: Box): Box {
  const n = normalise(b);
  const x = Math.floor(n.x);
  const y = Math.floor(n.y);
  return { x, y, width: Math.ceil(n.x + n.width) - x, height: Math.ceil(n.y + n.height) - y };
}

/** The element's bounding box, on whole pixels. */
export function elementBox(el: ExcalidrawElement): Box {
  return integralBox({ x: el.x, y: el.y, width: el.width, height: el.height });
}

/**
 * Whether a box is worth searching against. A peer can broadcast an element
 * with a NaN coordinate, and an obstacle that compares false against
 * everything would send an outward scan on forever.
 */
export function isFiniteBox(b: Box): boolean {
  return Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.width) && Number.isFinite(b.height);
}

/** The live elements a search must not land on, as boxes. */
export function obstacleBoxes(elements: readonly ExcalidrawElement[]): Box[] {
  return elements.filter((el) => !el.isDeleted).map(elementBox).filter(isFiniteBox);
}

/** Boxes overlapping by more than 0 px in both axes. Touching edges do not. */
export function intersects(first: Box, second: Box): boolean {
  const a = normalise(first);
  const b = normalise(second);
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Whether a candidate lands clear of every obstacle. */
export function isFree(candidate: Box, obstacles: readonly Box[]): boolean {
  return !obstacles.some((o) => intersects(candidate, o));
}

/** The box with `gap` px of margin on every side. */
export function padded(b: Box, gap: number): Box {
  const n = normalise(b);
  return { x: n.x - gap, y: n.y - gap, width: n.width + gap + gap, height: n.height + gap + gap };
}

/**
 * Whether a candidate has the gap free around it, not merely the box itself.
 * Two elements sharing an edge do not overlap, but they read as one shape;
 * the gap is what the caller asked to be left around the element, so it is
 * what the search has to find.
 */
export function isClear(candidate: Box, obstacles: readonly Box[], gap: number): boolean {
  return isFree(padded(candidate, gap), obstacles);
}

/** Whether `inner` lies entirely within `outer`. */
export function contains(outer: Box, inner: Box): boolean {
  const a = normalise(outer);
  const b = normalise(inner);
  return b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height;
}

/** The smallest box holding all of them; the first box when there is one. */
export function union(boxes: readonly Box[]): Box {
  const first = normalise(boxes[0]);
  let { x, y } = first;
  let right = first.x + first.width;
  let bottom = first.y + first.height;
  for (const box of boxes.slice(1)) {
    const b = normalise(box);
    x = Math.min(x, b.x);
    y = Math.min(y, b.y);
    right = Math.max(right, b.x + b.width);
    bottom = Math.max(bottom, b.y + b.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}

/** The centre point of a box. */
export function centreOf(b: Box): [number, number] {
  const n = normalise(b);
  return [n.x + n.width / 2, n.y + n.height / 2];
}

/**
 * Distance from a point to the furthest corner of a box: the box lies entirely
 * within `r` of the point when this is at most `r`. Measured to the furthest
 * corner rather than the nearest edge because a member half inside the radius
 * is half outside it, and the radius is what a mention on the cluster will
 * read.
 */
export function cornerDistance(point: readonly [number, number], b: Box): number {
  const n = normalise(b);
  const dx = Math.max(Math.abs(point[0] - n.x), Math.abs(point[0] - (n.x + n.width)));
  const dy = Math.max(Math.abs(point[1] - n.y), Math.abs(point[1] - (n.y + n.height)));
  return Math.hypot(dx, dy);
}

/**
 * The size the element will be built at, before it is built. `buildElements`
 * measures text and grows a labelled shape to fit its label, so a slot found
 * for the spec's stated size would be too small for either.
 */
export function specSize(spec: PlacedSpec): Size {
  const fontSize = spec.fontSize ?? DEFAULT_FONT_SIZE;
  if (spec.type === "text") {
    const measured = measureText(spec.text ?? spec.label ?? "", fontSize);
    return { width: spec.width ?? measured.width, height: spec.height ?? measured.height };
  }
  const width = spec.width ?? DEFAULT_SHAPE_WIDTH;
  const height = spec.height ?? DEFAULT_SHAPE_HEIGHT;
  if (spec.label === undefined) return { width, height };
  const label = measureText(spec.label, fontSize);
  return {
    width: Math.max(width, label.width + LABEL_PADDING),
    height: Math.max(height, label.height + LABEL_PADDING),
  };
}

/** The size a search reserves: whole pixels, never smaller than the element. */
export function integralSize(size: Size): Size {
  return { width: Math.ceil(size.width), height: Math.ceil(size.height) };
}

/** The candidate box `out` px clear of the anchor on that side. */
export function slotOn(side: FixedSide, anchor: Box, size: Size, out: number): Box {
  const a = normalise(anchor);
  const { width, height } = size;
  if (side === "right") return { x: a.x + a.width + out, y: a.y, width, height };
  if (side === "left") return { x: a.x - out - width, y: a.y, width, height };
  if (side === "below") return { x: a.x, y: a.y + a.height + out, width, height };
  return { x: a.x, y: a.y - out - height, width, height };
}

/**
 * The first free slot on that side: `gap` clear of the anchor, then a further
 * `gap` at a time until nothing is in the way. The scan runs outwards along
 * one axis with the other edge aligned to the anchor, so it terminates once it
 * is past every obstacle - which is why an obstacle with a non-finite
 * coordinate is dropped before we get here.
 */
export function findSideSlot(
  side: FixedSide,
  anchor: Box,
  size: Size,
  gap: number,
  obstacles: readonly Box[],
): Box {
  let step = 0;
  let candidate = slotOn(side, anchor, size, gap);
  while (!isClear(candidate, obstacles, gap)) {
    step++;
    candidate = slotOn(side, anchor, size, gap + step * gap);
  }
  return candidate;
}

/** Where `auto` put it, and which side that turned out to be. */
export interface AutoSlot {
  side: FixedSide;
  slot: Box;
}

/**
 * The nearest free side: each side's first free slot, then the one whose box
 * ends up closest to the anchor. A tie goes to the earlier side in
 * {@link AUTO_SIDES}, so the answer is the same for two agents asking in
 * sequence about the same scene.
 */
export function findAutoSlot(anchor: Box, size: Size, gap: number, obstacles: readonly Box[]): AutoSlot {
  let side = AUTO_SIDES[0];
  let slot = findSideSlot(side, anchor, size, gap, obstacles);
  let distance = boxDistance(slot, anchor);
  for (const other of AUTO_SIDES.slice(1)) {
    const candidate = findSideSlot(other, anchor, size, gap, obstacles);
    const candidateDistance = boxDistance(candidate, anchor);
    if (candidateDistance < distance) {
      side = other;
      slot = candidate;
      distance = candidateDistance;
    }
  }
  return { side, slot };
}

/** The cluster an anchor belongs to. */
export interface Cluster {
  /** What a member is stamped with, so the next placement finds the same set. */
  key: string;
  /** Every live member, the anchor among them. */
  members: ExcalidrawElement[];
}

/** The cluster tag an element carries, or undefined for an untagged one. */
function clusterTag(el: ExcalidrawElement): string | undefined {
  const tag = (el.customData as Record<string, unknown> | undefined)?.[CLUSTER_CUSTOM_DATA_KEY];
  return typeof tag === "string" && tag.length > 0 ? tag : undefined;
}

/**
 * What identifies the anchor's cluster: its own tag if it has one, else the
 * group or frame it belongs to, else the anchor itself. An element the server
 * placed into a cluster carries the key, so joining a cluster through any of
 * its members reaches the same set.
 */
export function clusterKey(anchor: ExcalidrawElement): string {
  return clusterTag(anchor) ?? anchor.groupIds?.[0] ?? anchor.frameId ?? anchor.id;
}

/** The anchor's cluster: its group, its frame, its tagged members, or itself. */
export function clusterOf(elements: readonly ExcalidrawElement[], anchor: ExcalidrawElement): Cluster {
  const key = clusterKey(anchor);
  const members = elements.filter(
    (el) =>
      !el.isDeleted &&
      (el.id === anchor.id ||
        el.id === key ||
        clusterTag(el) === key ||
        el.groupIds?.includes(key) === true ||
        el.frameId === key),
  );
  return { key, members };
}

/** The slot a cluster placement chose, and what the cluster now covers. */
export interface ClusterSlot {
  slot: Box;
  /** The cluster's bounding box with the new element in it. */
  footprint: Box;
  /** True when the cluster no longer fits inside the radius of its centre. */
  outgrown: boolean;
}

/**
 * Candidate positions on a `gap` grid from the footprint's top-left, over the
 * footprint and `reach` px to the right of and below it. Row-major, so the
 * plain order is deterministic before any sort.
 *
 * A cluster grows down and to the right and never up or left, which keeps its
 * anchor at its top-left corner: the side a caller placed the cluster's first
 * element on stays where it was put, and the space above and to the left of
 * the anchor stays free for a note written against it. Growing in every
 * direction would eat that space as the cluster filled up.
 */
export function gridCandidates(footprint: Box, size: Size, gap: number, reach: number): Box[] {
  const f = normalise(footprint);
  const iMax = Math.ceil((f.width + reach) / gap);
  const jMax = Math.ceil((f.height + reach) / gap);
  const out: Box[] = [];
  for (let j = 0; j <= jMax; j++) {
    for (let i = 0; i <= iMax; i++) {
      out.push({ x: f.x + i * gap, y: f.y + j * gap, width: size.width, height: size.height });
    }
  }
  return out;
}

/**
 * The candidates ordered by how far their centre is from the footprint's, so a
 * cluster fills in towards its middle and grows as a disc rather than a
 * streak. Equal distances go to the later grid position - the lower and
 * further right of the two - so a cluster grows the way a diagram is read,
 * which is the direction {@link AUTO_SIDES} takes first for the same reason.
 */
function byDistanceFromCentre(candidates: readonly Box[], footprint: Box): Box[] {
  const [cx, cy] = centreOf(footprint);
  return candidates
    .map((box, order) => {
      const [bx, by] = centreOf(box);
      return { box, order, distance: Math.hypot(bx - cx, by - cy) };
    })
    .sort((a, b) => a.distance - b.distance || b.order - a.order)
    .map((entry) => entry.box);
}

/**
 * Where the next member of a cluster goes: a free slot inside the current
 * footprint if there is one, otherwise the free slot nearest the centre that
 * keeps every member - the new one included - inside `radius` of the grown
 * footprint's centre.
 *
 * When no such slot exists the element is still placed, on the nearest free
 * candidate, and `outgrown` is set: refusing would leave the caller with
 * nowhere to put the node, while placing it silently would let a cluster grow
 * until a mention on it costs the whole scene. The caller is told so it can
 * split the cluster or wrap it in a frame.
 */
export function findClusterSlot(
  members: readonly Box[],
  size: Size,
  gap: number,
  radius: number,
  obstacles: readonly Box[],
): ClusterSlot {
  const footprint = union(members);
  const reach = radius + Math.max(size.width, size.height);
  const candidates = gridCandidates(footprint, size, gap, reach);
  for (const candidate of candidates) {
    if (contains(footprint, candidate) && isClear(candidate, obstacles, gap)) {
      return { slot: candidate, footprint, outgrown: false };
    }
  }
  let nearest: Box | null = null;
  for (const candidate of byDistanceFromCentre(candidates, footprint)) {
    if (!isClear(candidate, obstacles, gap)) continue;
    if (nearest === null) nearest = candidate;
    const grown = union([footprint, candidate]);
    const centre = centreOf(grown);
    const fits = [...members, candidate].every((box) => cornerDistance(centre, box) <= radius);
    if (fits) return { slot: candidate, footprint: grown, outgrown: false };
  }
  // Nothing within reach of the footprint is free either, so leave the grid
  // and take the first slot below the cluster, however far out that is.
  const slot = nearest ?? findSideSlot("below", footprint, size, gap, obstacles);
  return { slot, footprint: union([footprint, slot]), outgrown: true };
}

/**
 * The boxes a new cluster has to stay clear of: the anchor cluster's members,
 * and everything else already inside the radius of its footprint. The point of
 * the separation is that a note on one cluster does not pull the other in, and
 * what a note on this cluster pulls in is exactly that set.
 */
export function separationBoxes(footprint: Box, members: readonly Box[], obstacles: readonly Box[], radius: number): Box[] {
  return [...members, ...obstacles.filter((o) => boxDistance(o, footprint) <= radius)];
}

/**
 * Where a new cluster starts: `gap` plus a radius plus the element's own size
 * clear of the anchor cluster's footprint, then further out until the element
 * is free and more than a radius from everything in the anchor's
 * neighbourhood. A mention on either cluster then reaches its own only.
 */
export function findNewClusterSlot(
  side: FixedSide,
  footprint: Box,
  size: Size,
  gap: number,
  radius: number,
  obstacles: readonly Box[],
  separation: readonly Box[],
): Box {
  const clear = gap + radius + Math.max(size.width, size.height);
  let step = 0;
  let candidate = slotOn(side, footprint, size, clear);
  while (!isClear(candidate, obstacles, gap) || separation.some((box) => boxDistance(candidate, box) <= radius)) {
    step++;
    candidate = slotOn(side, footprint, size, clear + step * gap);
  }
  return candidate;
}

/** The scene a placement is decided against. */
export interface PlacementScene {
  /** Every element the search can see, including ones placed earlier in the call. */
  elements: readonly ExcalidrawElement[];
  /** The room's neighbourhood radius. */
  radius: number;
}

/** Where the element goes, or why it cannot be placed. */
export interface PlacementResult {
  x: number;
  y: number;
  /** The cluster's bounding box, for a cluster placement. */
  footprint?: Box;
  /** True when the cluster has outgrown the radius. */
  outgrown?: boolean;
  /** The cluster key to stamp on the placed element. */
  clusterKey?: string;
  /** Why the request was refused. Nothing is placed when this is set. */
  refusal?: string;
}

function refusal(text: string): PlacementResult {
  return { x: 0, y: 0, refusal: text };
}

/** Types whose geometry comes from their points, so a slot cannot move them. */
const UNPLACEABLE = ["arrow", "line", "freedraw"];

/**
 * Why the arguments cannot be honoured, or null when they can. Separate from
 * {@link place} because every one of these is answerable without the scene,
 * and the caller's fix is to change the argument named in the text.
 */
export function requestRefusal(request: PlaceRequest, spec: PlacedSpec): string | null {
  if (request.near !== undefined && request.cluster !== undefined) return BOTH_ANCHORS_TEXT;
  if (request.near === undefined && request.cluster === undefined) return NO_ANCHOR_TEXT;
  if (request.cluster !== undefined && request.newCluster === true) return NEW_CLUSTER_NEEDS_NEAR_TEXT;
  if (request.cluster !== undefined && request.side !== undefined) return SIDE_WITH_CLUSTER_TEXT;
  if (UNPLACEABLE.includes(spec.type)) return unplaceableText(spec.type);
  return null;
}

/**
 * Decide where one spec goes. The caller's x and y are not read: `place` is
 * the alternative to choosing coordinates, and honouring both would put the
 * element somewhere neither asked for.
 */
export function place(request: PlaceRequest, spec: PlacedSpec, scene: PlacementScene): PlacementResult {
  const refused = requestRefusal(request, spec);
  if (refused !== null) return refusal(refused);
  const anchorId = request.near ?? request.cluster ?? "";
  const anchor = scene.elements.find((el) => el.id === anchorId && !el.isDeleted);
  if (!anchor) return refusal(anchorMissingText(anchorId));

  const size = integralSize(specSize(spec));
  const gap = Math.max(1, Math.round(request.gap ?? DEFAULT_GAP));
  const obstacles = obstacleBoxes(scene.elements);
  const radius = scene.radius;

  if (request.cluster !== undefined) {
    const cluster = clusterOf(scene.elements, anchor);
    const placed = findClusterSlot(cluster.members.map(elementBox), size, gap, radius, obstacles);
    return {
      x: placed.slot.x,
      y: placed.slot.y,
      footprint: placed.footprint,
      outgrown: placed.outgrown,
      clusterKey: cluster.key,
    };
  }

  if (request.newCluster === true) {
    const cluster = clusterOf(scene.elements, anchor);
    const members = cluster.members.map(elementBox);
    const footprint = union(members);
    const side = request.side === undefined || request.side === "auto" ? AUTO_SIDES[0] : request.side;
    const slot = findNewClusterSlot(
      side,
      footprint,
      size,
      gap,
      radius,
      obstacles,
      separationBoxes(footprint, members, obstacles, radius),
    );
    return { x: slot.x, y: slot.y };
  }

  const anchorBox = elementBox(anchor);
  const slot =
    request.side === undefined || request.side === "auto"
      ? findAutoSlot(anchorBox, size, gap, obstacles).slot
      : findSideSlot(request.side, anchorBox, size, gap, obstacles);
  return { x: slot.x, y: slot.y };
}

/** The line a placement reports: the id and the coordinates actually written. */
export function placedText(id: string, result: PlacementResult): string {
  return `placed ${id} at x=${result.x} y=${result.y}`;
}

/** The line a cluster placement adds: the cluster's box, for a low-scale snapshot. */
export function footprintText(footprint: Box): string {
  return `footprint x=${footprint.x} y=${footprint.y} width=${footprint.width} height=${footprint.height}`;
}

/** Every line a placement reports, in the order the caller reads them. */
export function placementLines(id: string, result: PlacementResult): string[] {
  const lines = [placedText(id, result)];
  if (result.footprint) lines.push(footprintText(result.footprint));
  if (result.outgrown === true) lines.push(OUTGROWN_TEXT);
  return lines;
}

/**
 * A box an earlier spec in the same call has taken, as an element the search
 * can see. The batch is not on the canvas yet, so without these two specs
 * placed against the same anchor in one call would be given the same slot.
 */
export function reservedElement(id: string, type: string, x: number, y: number, size: Size): ExcalidrawElement {
  return {
    id,
    type,
    x,
    y,
    width: size.width,
    height: size.height,
    isDeleted: false,
    version: 1,
    versionNonce: 0,
    boundElements: null,
  };
}

/**
 * The radius a neighbourhood query uses: the caller's if it named one, else
 * the room's. Layout and neighbourhood share one number, so `read_scene near`
 * with no radius reaches exactly as far as the mention that prompted it.
 */
export function nearRadius(roomRadius: number = DEFAULT_NEARBY_RADIUS, requested?: number): number {
  return requested ?? roomRadius;
}
