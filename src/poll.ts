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
 * payload is therefore assembled at the largest detail level whose serialised
 * form fits POLL_TEXT_LIMIT: peer names go first, then mention text, then
 * entries drop out of the mention list. `peerCount` and `pendingCount` always
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

/** Detail levels, widest first: mention entries, then text length, then peer names. */
const MENTION_CAPS = [10, 4, 2, 1, 0];
const TEXT_BUDGETS = [60, 32, 16, 8, 0];
const PEER_CAPS = [6, 2, 0];

interface Detail {
  mentionCap: number;
  textBudget: number;
  peerCap: number;
}

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
  let narrowest = assemble(state, sinceVersion, { mentionCap: 0, textBudget: 0, peerCap: 0 });
  for (const mentionCap of MENTION_CAPS) {
    for (const textBudget of TEXT_BUDGETS) {
      for (const peerCap of PEER_CAPS) {
        const candidate = assemble(state, sinceVersion, { mentionCap, textBudget, peerCap });
        if (pollText(candidate).length <= POLL_TEXT_LIMIT) return candidate;
        narrowest = candidate;
      }
    }
  }
  return narrowest;
}
