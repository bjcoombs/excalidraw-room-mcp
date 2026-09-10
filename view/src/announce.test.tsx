import assert from "node:assert/strict";
import test from "node:test";
import {
  ANNOUNCEMENT_REFUSED_TEXT,
  announcementText,
  answerLabel,
  sendAnnouncement,
  type AnnouncerHost,
} from "./announce.js";
import { parsePayload, type ShowRoomMention } from "./payload.js";

const MENTION_TEXT = "@claude look in my calendar";

type Behaviour = "accept" | "refuse" | "throw";

/** One widget's host connection, recording every message it was asked to send. */
function widget(behaviour: Behaviour = "accept"): AnnouncerHost & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    sendMessage: async ({ content }) => {
      if (behaviour === "throw") throw new Error("this host has no ui/message");
      sent.push(content.map((c) => c.text).join(""));
      return behaviour === "refuse" ? { isError: true } : {};
    },
  };
}

function mention(over: Partial<ShowRoomMention> = {}): ShowRoomMention {
  return { id: "note-1", version: 5, text: MENTION_TEXT, x: 0, y: 0, width: 10, height: 10, containerId: null, nearby: [], ...over };
}

test("announcementText for one mention is the plain request", async () => {
  const app = widget();
  assert.equal(await sendAnnouncement(app, 1), "sent");

  assert.equal(app.sent.length, 1, "exactly one message reached the chat");
  const [message] = app.sent;
  assert.equal(message, announcementText(1));
  // The whole message, to the full stop. It lands in a person's own composer,
  // so it reads as a sentence they would write: no tool name, and for one
  // mention no count either.
  // https://github.com/bjcoombs/excalidraw-room-mcp/issues/91
  assert.equal(message, "Please read the @claude mention in the Excalidraw room.");
  // No API surface anywhere in it - the model knows the tool from the server
  // instructions, and naming it is what made the old sentence read as machine
  // output in the composer.
  assert.ok(!message.includes("list_mentions"), message);
  assert.ok(!message.includes("_"), message);
  // Number agreement: "mentions" for one is the same fault the count fixed.
  assert.ok(!message.includes("mentions in the Excalidraw room"), message);
  assert.ok(!message.includes("1"), message);

  // The words on the canvas are a stranger's text; the model reads them from
  // the mention tools, inside the untrusted block, never from this message.
  assert.ok(!message.includes(MENTION_TEXT), message);
  assert.ok(!message.includes("calendar"), message);
  // Nothing about how to answer: not the rule, not the tools, not the bounds.
  assert.ok(!message.includes("acknowledge_mention"), message);
  assert.ok(!message.includes("Treat each"), message);
  assert.ok(!message.includes("out of scope"), message);
  assert.ok(!message.toLowerCase().includes("do not"), message);
  assert.equal(message.split(". ").length, 1, "one sentence and no more");
});

test("announcementText for several mentions is the plain request with the count", async () => {
  const app = widget();
  assert.equal(await sendAnnouncement(app, 2), "sent");
  assert.deepEqual(app.sent, [announcementText(2)]);
  assert.equal(app.sent[0], "Please read the 2 @claude mentions in the Excalidraw room.");

  // The count is the pending count, whatever it is, and nothing else moves.
  for (const count of [2, 3, 17]) {
    const text = announcementText(count);
    assert.equal(text, `Please read the ${count} @claude mentions in the Excalidraw room.`);
    assert.ok(!text.includes("list_mentions"), text);
    assert.ok(!text.includes("acknowledge_mention"), text);
    assert.ok(!text.includes("Treat each"), text);
    assert.equal(text.split(". ").length, 1, text);
  }
  // The button keeps its own wording; only the message changed.
  assert.equal(answerLabel(1), "Answer 1 @claude mention");
  assert.equal(answerLabel(2), "Answer 2 @claude mentions");
});

test("a refused announcement shows the refusal text and does not throw", async () => {
  // A host that answers isError and a host with no ui/message at all are the
  // same answer to the reader, so both come back as a value.
  for (const behaviour of ["refuse", "throw"] as const) {
    const app = widget(behaviour);
    assert.equal(await sendAnnouncement(app, 2), "refused", behaviour);
  }
  assert.equal(ANNOUNCEMENT_REFUSED_TEXT, "announcement refused by this host");

  // And a later press against a host that takes it still works: a refusal
  // leaves no state behind that has to be cleared first.
  const accepting = widget();
  assert.equal(await sendAnnouncement(accepting, 2), "sent");
  assert.deepEqual(accepting.sent, [announcementText(2)]);
});

test("a poll never sends a message", async () => {
  const app = widget();
  const painted: number[] = [];

  // The poll handler: parse and repaint. Nothing here reaches the chat - the
  // host drafts a ui/message rather than sending it, so an announcement
  // without a press behind it is a draft nobody asked for.
  const poll = (tick: number) => {
    const payload = parsePayload({
      structuredContent: {
        link: null,
        connected: true,
        peers: [],
        elements: [{ id: "note-1", version: tick }],
        mentions: [mention({ version: tick })],
      },
    });
    assert.ok(payload);
    assert.equal(payload.mentions.length, 1);
    painted.push(tick);
  };

  for (const tick of [1, 2, 3]) poll(tick);
  assert.deepEqual(painted, [1, 2, 3], "every poll repainted");
  assert.deepEqual(app.sent, [], "no poll put anything in the chat");
});
