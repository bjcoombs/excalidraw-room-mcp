/**
 * Scene selection: which elements a read should return.
 *
 * `read_scene` on a large scene costs context proportional to the whole
 * drawing. These pure filters let a caller ask for a handful of elements by id,
 * or for a neighbourhood around one of them, reusing the same proximity rule
 * mentions use.
 */
import { type ExcalidrawElement } from "./elements.js";
import { mentionOf, nearbyElements } from "./mentions.js";

export interface NearFilter {
  /** Element the neighbourhood is centred on. */
  id: string;
  /** How far beyond that element's bounding box to reach. */
  radius: number;
}

export interface SceneFilter {
  /** Return only these elements. */
  ids?: readonly string[];
  /** Return the named element and everything within `radius` of it. */
  near?: NearFilter;
}

export interface Selection {
  elements: ExcalidrawElement[];
  /** Ids named by the filter that the scene does not hold. */
  unknownIds: string[];
}

/**
 * Applies `ids` and `near` to a scene. Both filters restrict, so giving each
 * returns their intersection; giving neither returns the scene unchanged in its
 * original order.
 */
export function selectElements(
  elements: readonly ExcalidrawElement[],
  filter: SceneFilter = {},
): Selection {
  const unknownIds: string[] = [];
  const present = new Set(elements.map((e) => e.id));
  let keep: Set<string> | null = null;

  const narrowed = (current: Set<string> | null, allowed: Set<string>): Set<string> =>
    current === null ? allowed : new Set([...current].filter((id) => allowed.has(id)));

  if (filter.ids) {
    const wanted = new Set<string>();
    for (const id of filter.ids) {
      if (present.has(id)) wanted.add(id);
      else unknownIds.push(id);
    }
    keep = narrowed(keep, wanted);
  }

  if (filter.near) {
    const anchor = elements.find((e) => e.id === filter.near!.id);
    if (!anchor) {
      unknownIds.push(filter.near.id);
      keep = narrowed(keep, new Set());
    } else {
      const around = nearbyElements(elements, mentionOf(anchor), filter.near.radius);
      keep = narrowed(keep, new Set([anchor.id, ...around.map((e) => e.id)]));
    }
  }

  const kept = keep;
  return {
    elements: kept === null ? [...elements] : elements.filter((e) => kept.has(e.id)),
    unknownIds,
  };
}

/** A line naming the ids a filter asked for that the scene does not hold. */
export function unknownIdsText(unknownIds: readonly string[]): string {
  return `unknown id(s): ${unknownIds.join(", ")}`;
}
