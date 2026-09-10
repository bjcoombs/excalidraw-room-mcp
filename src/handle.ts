/**
 * Room handles: the name this server presents as its Excalidraw presence
 * username, so a person in the room can tell two agents apart and address one
 * of them. Pure functions only; RoomClient owns the socket that broadcasts it.
 */
import os from "node:os";

/** A handle is lowercase letters, digits and hyphens, 1 to 32 characters. */
export const HANDLE_PATTERN = /^[a-z0-9-]{1,32}$/;
export const MAX_HANDLE_LENGTH = 32;
const SUFFIX = "-claude";

export function isValidHandle(handle: string): boolean {
  return HANDLE_PATTERN.test(handle);
}

/**
 * `<os user>-claude`, so a facilitator connecting from their own laptop is
 * named after them without configuration. Anything outside the grammar in the
 * user name becomes a hyphen, and the name is trimmed so the result still
 * fits 32 characters.
 */
export function defaultHandle(user: string = os.userInfo().username): string {
  const cleaned = user.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const base = cleaned || "agent";
  return `${base.slice(0, MAX_HANDLE_LENGTH - SUFFIX.length)}${SUFFIX}`;
}

/**
 * `desired`, or `desired-2`, `desired-3` and so on when an agent already in
 * the room answers to it. The base is trimmed to leave room for the suffix, so
 * every candidate is a valid handle and the search terminates.
 */
export function uniqueHandle(desired: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(desired)) return desired;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${desired.slice(0, MAX_HANDLE_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}
