/**
 * poll_room's payload: the cheap state probe an agent can call inside a turn.
 *
 * show_room costs a full scene dump and wait_for_mention blocks the turn, so
 * neither suits "has anything changed since I last looked?". This reads the
 * room state already in memory and reports only the counters, so the result
 * fits in one short text block: the caller decides from `changedSince`
 * whether to spend a read_scene or list_mentions call.
 *
 * The size bound is part of the contract, not a nicety - a probe an agent is
 * expected to call repeatedly must cost a fixed, small number of tokens. The
 * payload is therefore assembled at the widest detail level whose serialised
 * form fits POLL_TEXT_LIMIT, sacrificing peer names first, then mention text,
 * then entries in the mention list. `peerCount` and `pendingCount` always
 * report the true totals, so a shortened list is visible rather than silent.
 */
import type { Mention } from "./mentions.js";
import type { RoomStatus } from "./room.js";

/** Maximum characters in the serialised payload. */
export const POLL_TEXT_LIMIT = 300;

export interface PollState {
  status: RoomStatus;
  pending: readonly Mention[];
}

export interface PollPayload {
  connected: boolean;
  sceneVersion: number;
  peerCount: number;
  /** Peer names, shortened to fit the size bound; peerCount is the true total. */
  peers: string[];
  pendingCount: number;
  /** Pending mentions, shortened to fit the size bound; pendingCount is the true total. */
  pendingMentions: { id: string; text: string }[];
  /** False only when sinceVersion was given and the scene version still equals it. */
  changedSince: boolean;
}

interface Detail {
  mentionCap: number;
  textBudget: number;
  peerCap: number;
}

/**
 * Detail levels, widest first, each strictly narrower than the one before it:
 * peer names go first, then mention text, then entries drop out of the mention
 * list. The last level is the counters alone, which is always inside the bound.
 */
const DETAIL_LEVELS: Detail[] = [
  { mentionCap: 10, textBudget: 60, peerCap: 6 },
  { mentionCap: 10, textBudget: 60, peerCap: 2 },
  { mentionCap: 10, textBudget: 60, peerCap: 0 },
  { mentionCap: 10, textBudget: 32, peerCap: 0 },
  { mentionCap: 10, textBudget: 16, peerCap: 0 },
  { mentionCap: 10, textBudget: 8, peerCap: 0 },
  { mentionCap: 10, textBudget: 0, peerCap: 0 },
  { mentionCap: 4, textBudget: 0, peerCap: 0 },
  { mentionCap: 2, textBudget: 0, peerCap: 0 },
  { mentionCap: 1, textBudget: 0, peerCap: 0 },
  { mentionCap: 0, textBudget: 0, peerCap: 0 },
];

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function shorten(s: string, budget: number): string {
  if (budget <= 0) return "";
  return s.length <= budget ? s : `${s.slice(0, budget - 1)}…`;
}

function assemble(state: PollState, sinceVersion: number | undefined, detail: Detail): PollPayload {
  const { status, pending } = state;
  return {
    connected: status.connected,
    sceneVersion: status.sceneVersion,
    peerCount: status.peers.length,
    peers: status.peers.slice(0, detail.peerCap).map((p) => shorten(p.username ?? p.socketId, 24)),
    pendingCount: pending.length,
    pendingMentions: pending
      .slice(0, detail.mentionCap)
      .map((m) => ({ id: m.id, text: shorten(oneLine(m.text), detail.textBudget) })),
    changedSince: sinceVersion === undefined || status.sceneVersion !== sinceVersion,
  };
}

/** Compact JSON, the form poll_room returns as its text content. */
export function pollText(payload: PollPayload): string {
  return JSON.stringify(payload);
}

/**
 * The state probe for `state`, compared against `sinceVersion` when given.
 * The result always serialises to at most POLL_TEXT_LIMIT characters: the
 * narrowest detail level carries no peer names, no mention text and no
 * mention entries, which is bounded by the counters alone.
 */
export function buildPollPayload(state: PollState, sinceVersion?: number): PollPayload {
  const fallback = assemble(state, sinceVersion, DETAIL_LEVELS[DETAIL_LEVELS.length - 1]);
  for (const detail of DETAIL_LEVELS) {
    const candidate = assemble(state, sinceVersion, detail);
    if (pollText(candidate).length <= POLL_TEXT_LIMIT) return candidate;
  }
  return fallback;
}
