import assert from "node:assert/strict";
import test from "node:test";
import { extractSection, HELP_TOPIC_NAMES, HELP_TOPICS, helpText, readReadme } from "./help.js";

const readme = readReadme();

test("every heading a room_help topic names is a section of the README", () => {
  for (const [topic, headings] of Object.entries(HELP_TOPICS)) {
    for (const heading of headings) {
      const section = extractSection(readme, heading);
      assert.ok(section, `${topic}: README has no "${heading}" heading`);
      assert.ok(section.length > 100, `${topic}: "${heading}" is ${section.length} characters`);
    }
  }
});

test("the eight topics are the ones the issue names", () => {
  assert.deepEqual(HELP_TOPIC_NAMES, ["rooms", "scene", "snapshots", "placement", "mentions", "answers", "attribution", "addressing"]);
});

test("placement carries place: and nearbyRadius", () => {
  const text = helpText(readme, "placement");
  assert.ok(text.startsWith("### Placement"), text);
  assert.ok(text.includes("place:"), text);
  assert.ok(text.includes("nearbyRadius"), text);
  // It stops at the next heading of its own level.
  assert.ok(!text.includes("### Labels and text"), text);
});

test("each topic carries the rules its old tool descriptions did", () => {
  assert.match(helpText(readme, "scene"), /NOT PERSISTED/);
  assert.match(helpText(readme, "scene"), /strokeColor` is its text colour/);
  assert.match(helpText(readme, "snapshots"), /hand-drawn/);
  assert.match(helpText(readme, "snapshots"), /overlap/);
  assert.match(helpText(readme, "answers"), /never write client-identifiable/);
  assert.match(helpText(readme, "answers"), /only record/);
  assert.match(helpText(readme, "attribution"), /force: true/);
  assert.match(helpText(readme, "addressing"), /replyTo/);
  assert.match(helpText(readme, "addressing"), /agentReplyDepth: <n>/);
  assert.match(helpText(readme, "mentions"), /autoSeen/);
  assert.match(helpText(readme, "rooms"), /serverUrl/);
});

test("an unknown topic lists every topic", () => {
  const text = helpText(readme, "no-such-topic");
  assert.match(text, /unknown topic "no-such-topic"/);
  for (const topic of HELP_TOPIC_NAMES) assert.ok(text.includes(topic), topic);
  // Inherited object keys are not topics.
  assert.match(helpText(readme, "toString"), /unknown topic/);
});

test("extractSection ends at a same-or-higher heading and ignores headings in code fences", () => {
  const md = ["## A", "one", "```bash", "# not a heading", "```", "### A.1", "two", "## B", "three"].join("\n");
  assert.equal(extractSection(md, "A"), ["## A", "one", "```bash", "# not a heading", "```", "### A.1", "two"].join("\n"));
  assert.equal(extractSection(md, "A.1"), "### A.1\ntwo");
  assert.equal(extractSection(md, "B"), "## B\nthree");
  assert.equal(extractSection(md, "not a heading"), null);
  assert.equal(extractSection(md, "C"), null);
});

test("a heading missing from README is named rather than skipped", () => {
  assert.match(helpText("# nothing here", "snapshots"), /README has no "Snapshots" section/);
});
