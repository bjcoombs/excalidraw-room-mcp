/**
 * The scene's extent, and whether it moved. Kept free of DOM and React so
 * `npm test` can compile and run it under Node (tsconfig.view-test.json); the
 * component in app.tsx does nothing with bounds that is not decided here.
 *
 * Fitting is driven off bounds rather than off the element signature: an edit
 * that leaves the extent alone must not move a viewport the reader is looking
 * at, and only a change in extent means the current viewport can no longer show
 * everything. https://github.com/bjcoombs/excalidraw-room-mcp/issues/31
 */

/** An axis-aligned box in canvas coordinates. */
export interface SceneBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * How far an edge may move before the view refits, in canvas pixels. Element
 * geometry arrives as floats over the wire and a drag of a pixel or two is not
 * worth a viewport jump; 1 px is below what a reader can see at any useful zoom.
 */
export const BOUNDS_EPSILON = 1;

/** Padding left around the scene when fitting, in canvas pixels. */
export const FIT_PADDING = 24;

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The box enclosing every element that is not deleted, or null when there is
 * nothing to enclose. Elements come straight off the wire, so each coordinate
 * is checked rather than trusted: one element carrying a NaN width would
 * otherwise poison the whole box and fit the canvas to nothing.
 *
 * Call this with the list that is actually drawn, highlights included. A
 * highlight box sits outside the mention it wraps, so bounds taken from the
 * scene elements alone can leave one at the edge outside the fitted viewport.
 */
export function sceneBounds(elements: readonly Record<string, unknown>[]): SceneBounds | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let found = false;
  for (const element of elements) {
    if (element.isDeleted === true) continue;
    const x = num(element.x);
    const y = num(element.y);
    if (x === null || y === null) continue;
    const width = num(element.width) ?? 0;
    const height = num(element.height) ?? 0;
    // A negative width is legal in a raw element (a shape dragged leftwards),
    // so normalise rather than assume x is the left edge.
    minX = Math.min(minX, x, x + width);
    minY = Math.min(minY, y, y + height);
    maxX = Math.max(maxX, x, x + width);
    maxY = Math.max(maxY, y, y + height);
    found = true;
  }
  return found ? { minX, minY, maxX, maxY } : null;
}

/**
 * Whether the scene's extent moved enough to be worth refitting. Appearing or
 * disappearing counts as a change; so does any edge moving by more than
 * {@link BOUNDS_EPSILON}.
 */
export function boundsChanged(previous: SceneBounds | null, next: SceneBounds | null, epsilon = BOUNDS_EPSILON): boolean {
  if (previous === null || next === null) return previous !== next;
  return (
    Math.abs(previous.minX - next.minX) > epsilon ||
    Math.abs(previous.minY - next.minY) > epsilon ||
    Math.abs(previous.maxX - next.maxX) > epsilon ||
    Math.abs(previous.maxY - next.maxY) > epsilon
  );
}
