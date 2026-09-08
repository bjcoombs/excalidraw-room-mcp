/**
 * Element reconciliation, matching packages/excalidraw/data/reconcile.ts in
 * the Excalidraw repo minus the "element currently being edited" checks,
 * which only apply inside a browser session.
 *
 * Rule: for each id, keep the higher version. On a tie keep the one with the
 * lower versionNonce so every peer resolves the conflict the same way.
 */
export interface ElementLike {
  id: string;
  version: number;
  versionNonce: number;
  index?: string | null;
  isDeleted?: boolean;
  [key: string]: unknown;
}

export function shouldDiscardRemote(
  local: ElementLike | undefined,
  remote: ElementLike,
): boolean {
  if (!local) return false;
  if (local.version > remote.version) return true;
  if (local.version === remote.version && local.versionNonce <= remote.versionNonce) return true;
  return false;
}

export function orderByIndex<T extends ElementLike>(elements: readonly T[]): T[] {
  return [...elements].sort((a, b) => {
    const ai = a.index ?? null;
    const bi = b.index ?? null;
    if (ai === bi) return 0;
    if (ai === null) return 1;
    if (bi === null) return -1;
    return ai < bi ? -1 : 1;
  });
}

export function reconcile<T extends ElementLike>(
  local: readonly T[],
  remote: readonly T[],
): T[] {
  const localMap = new Map(local.map((el) => [el.id, el]));
  const out: T[] = [];
  const added = new Set<string>();

  for (const remoteEl of remote) {
    if (added.has(remoteEl.id)) continue;
    const localEl = localMap.get(remoteEl.id);
    if (localEl && shouldDiscardRemote(localEl, remoteEl)) {
      out.push(localEl);
    } else {
      out.push(remoteEl);
    }
    added.add(remoteEl.id);
  }

  for (const localEl of local) {
    if (!added.has(localEl.id)) {
      out.push(localEl);
      added.add(localEl.id);
    }
  }

  return orderByIndex(out);
}

/** Excalidraw's getSceneVersion: sum of every element's version. */
export function sceneVersion(elements: readonly ElementLike[]): number {
  return elements.reduce((acc, el) => acc + el.version, 0);
}
