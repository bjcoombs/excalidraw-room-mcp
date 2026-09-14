/**
 * `room_help`: the formats, rules and rationale that used to ride in every tool
 * description, served on demand from README.md.
 *
 * README is the single source. Each topic names the README headings it
 * returns, and the text is read from the README that ships beside `dist/` in
 * the npm package and the MCP bundle, so nothing here is a second copy to keep
 * in step. A heading renamed in README without the table below fails
 * `help.test.ts` rather than returning an empty topic.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/108
 */
import { readFileSync } from "node:fs";

/** Topic -> the README headings whose sections it returns, in order. */
export const HELP_TOPICS = {
  rooms: ["First five minutes"],
  scene: ["Tools", "Labels and text", "Saving the scene", "Limits"],
  snapshots: ["Snapshots"],
  placement: ["Placement"],
  mentions: ["Notes to the agent", "The listen loop", "Mention announcements"],
  answers: ["Questions on the canvas"],
  attribution: ["Attribution and ownership"],
  addressing: ["Handles and addressing", "Reply chains", "Lead and listener"],
} as const satisfies Record<string, readonly string[]>;

export type HelpTopic = keyof typeof HELP_TOPICS;

export const HELP_TOPIC_NAMES = Object.keys(HELP_TOPICS) as HelpTopic[];

/** Where README.md sits relative to this module, in `src/` under tsx and in `dist/` alike. */
export const README_URL = new URL("../README.md", import.meta.url);

const HEADING = /^(#{1,6})\s+(.*?)\s*$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * The section under the heading whose text is exactly `heading`: that heading
 * line and everything up to the next heading of the same or a higher level.
 * Lines inside a code fence are never read as headings. Null when README has
 * no such heading.
 */
export function extractSection(markdown: string, heading: string): string | null {
  const lines = markdown.split("\n");
  let inFence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) inFence = !inFence;
    const match = inFence ? null : HEADING.exec(lines[i]);
    if (!match) continue;
    if (start >= 0 && match[1].length <= level) return lines.slice(start, i).join("\n").trim();
    if (start < 0 && match[2] === heading) {
      start = i;
      level = match[1].length;
    }
  }
  return start >= 0 ? lines.slice(start).join("\n").trim() : null;
}

/** The topics, as an unknown topic is answered. */
export function topicsText(): string {
  return `room_help topics: ${HELP_TOPIC_NAMES.join(", ")}.`;
}

/** Whether `topic` names one of the help topics. */
export function isHelpTopic(topic: string): topic is HelpTopic {
  return Object.hasOwn(HELP_TOPICS, topic);
}

/**
 * The README text for `topic`, or the topic list when `topic` is not one. A
 * heading missing from README is named in the text rather than silently
 * skipped, so a stale table reads as a fault.
 */
export function helpText(markdown: string, topic: string): string {
  if (!isHelpTopic(topic)) return `unknown topic ${JSON.stringify(topic)}. ${topicsText()}`;
  const sections = HELP_TOPICS[topic].map(
    (heading) => extractSection(markdown, heading) ?? `(README has no "${heading}" section)`,
  );
  return sections.join("\n\n");
}

/** README.md as shipped beside the server. */
export function readReadme(url: URL = README_URL): string {
  return readFileSync(url, "utf8");
}
