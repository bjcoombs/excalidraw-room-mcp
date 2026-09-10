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
import { scopeRuleFor, UNTRUSTED_CLOSE, UNTRUSTED_OPEN, type Mention } from "./mentions.js";
import type { RoomStatus } from "./room.js";

/**
 * Maximum characters in the variable part of the result - the counters and the
 * mention list. The scope rule that follows is a fixed sentence and is not
 * counted: it cannot be shortened without losing the thing it says.
 */
export const POLL_TEXT_LIMIT = 300;

export interface PollState {
  status: RoomStatus;
  /** Every mention not yet acknowledged, whether or not an agent has seen it. */
  pending: readonly Mention[];
  /**
   * Whether the session policy has knowledge answers on. Reported here as well
   * as by room_status because poll_room is the call an agent makes inside a
   * turn, and the rule that follows the counters depends on it.
   */
  answerQuestions: boolean;
}

export interface PollPayload {
  connected: boolean;
  /** The session policy's answering flag, as set_mention_policy left it. */
  answerQuestions: boolean;
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
    answerQuestions: state.answerQuestions,
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

/**
 * The counters as compact JSON plus one line per pending mention. This is the
 * part the size bound governs: it grows with the room, so it is the part that
 * can be traded away.
 *
 * The mention lines carry the id and the note's words, both inside the
 * untrusted block, because a line of that list is mostly someone else's text.
 * `oneLine` has already flattened the text, so a note can neither add a line
 * of its own nor forge the closing marker.
 */
export function pollBody(payload: PollPayload): string {
  const { pendingMentions, ...counters } = payload;
  const lines = [JSON.stringify(counters)];
  if (pendingMentions.length) {
    lines.push(UNTRUSTED_OPEN);
    for (const m of pendingMentions) lines.push(`mention ${m.id} - ${m.text}`);
    lines.push(UNTRUSTED_CLOSE);
  }
  return lines.join("\n");
}

/**
 * What poll_room returns: the bounded body, then the scope rule. The rule is
 * fixed-length and is the one thing in the result that must not be shortened,
 * so it sits outside the bound rather than competing with the counters for it.
 */
export function pollText(payload: PollPayload): string {
  return `${pollBody(payload)}\n${scopeRuleFor(payload)}`;
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
    if (pollBody(candidate).length <= POLL_TEXT_LIMIT) return candidate;
  }
  return fallback;
}
