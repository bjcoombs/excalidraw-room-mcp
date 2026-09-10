import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  announceMentions,
  announcementText,
  answerLabel,
  CLAIM_TOOL,
  claimIds,
  retryAnnouncement,
  type AnnounceableMention,
  type AnnouncerHost,
} from "./announce.js";
import { parsePayload } from "./payload.js";
import { StatusBar } from "./status.js";

const MENTION_TEXT = "@claude look in my calendar";

/**
 * The server's claim state, as the tool implements it: first caller for an id
 * wins, `release` hands it back. One instance stands in for one server
 * process, which is what several widgets in one host share.
 */
class ClaimStore {
  private readonly claimed = new Set<string>();
  readonly calls: { ids: string[]; release: boolean }[] = [];

  call(ids: string[], release: boolean): string[] {
    this.calls.push({ ids, release });
    const changed: string[] = [];
    for (const id of ids) {
      if (release) {
        if (this.claimed.delete(id)) changed.push(id);
      } else if (!this.claimed.has(id)) {
        this.claimed.add(id);
        changed.push(id);
      }
    }
    return changed;
  }

  /** The tool's result text: a count line, then one id per line. */
  result(ids: string[], release: boolean) {
    const changed = this.call(ids, release);
    const header = `announcement claim: ${release ? "released" : "won"} ${changed.length} of ${ids.length}`;
    return { content: [{ type: "text", text: changed.length ? `${header}\n${changed.join("\n")}` : header }] };
  }
}

type Behaviour = "accept" | "refuse" | "throw";

/** One widget: its own host connection, sharing the server's claim store. */
function widget(store: ClaimStore, behaviour: Behaviour = "accept"): AnnouncerHost & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    callServerTool: async ({ name, arguments: args }) => {
      assert.equal(name, CLAIM_TOOL);
      const ids = (args?.ids as string[] | undefined) ?? [];
      return store.result(ids, args?.release === true);
    },
    sendMessage: async ({ content }) => {
      if (behaviour === "throw") throw new Error("this host has no ui/message");
      sent.push(content.map((c) => c.text).join(""));
      return behaviour === "refuse" ? { isError: true } : {};
    },
  };
}

function mentions(...ids: string[]): AnnounceableMention[] {
  return ids.map((id) => ({ id, announced: false }));
}

test("two widgets sharing one claim store send one announcement", async () => {
  const store = new ClaimStore();
  const first = widget(store);
  const second = widget(store);
  const seen = mentions("note-1");

  // Both widgets poll the same room and see the same new mention. The claim is
  // server-side, so exactly one of them is allowed to speak.
  const [a, b] = await Promise.all([announceMentions(first, seen), announceMentions(second, seen)]);

  assert.equal(first.sent.length + second.sent.length, 1, "exactly one message reached the chat");
  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ["none", "sent"]);

  // A third poll by either widget announces nothing: the server now reports
  // the mention as announced, and the claim would lose anyway.
  await announceMentions(first, [{ id: "note-1", announced: true }]);
  await announceMentions(second, mentions("note-1"));
  assert.equal(first.sent.length + second.sent.length, 1);
});

test("the announcement carries the count and none of the mention text", async () => {
  const store = new ClaimStore();
  const app = widget(store);
  await announceMentions(app, mentions("note-1", "note-2", "note-3"));

  assert.equal(app.sent.length, 1);
  const [message] = app.sent;
  assert.equal(message, announcementText(3));
  assert.ok(message.includes("There are 3 unanswered @claude mentions"), message);
  // The words on the canvas are a stranger's text; the model reads them from
  // list_mentions, inside the untrusted block, and never from this message.
  assert.ok(!message.includes(MENTION_TEXT), message);
  assert.ok(!message.includes("calendar"), message);
  // The message states the bounds of the task it hands over.
  assert.ok(message.includes("list_mentions"), message);
  assert.ok(message.includes("acknowledge_mention"), message);
  assert.ok(message.includes("Do not use any other tool"), message);
  assert.equal(announcementText(1).includes("There are 1 unanswered"), true);
});

test("a rejected announcement shows the Answer button and a later claim for the same id succeeds", async () => {
  const store = new ClaimStore();
  const refusing = widget(store, "refuse");
  const result = await announceMentions(refusing, mentions("note-1"));

  assert.equal(result.outcome, "blocked");
  assert.deepEqual(result.ids, ["note-1"]);

  // The bar grows the one control the reader has to act on.
  const markup = renderToStaticMarkup(
    <StatusBar
      payload={null}
      note="Connecting to the room…"
      lastUpdateAt={null}
      pollingAvailable={true}
      linkBlocked={false}
      blockedAnnouncement={result.ids.length}
      onOpen={() => undefined}
      onRefresh={() => undefined}
      onAnswer={() => undefined}
    />,
  );
  assert.ok(/<button[^>]*>Answer 1 @claude mention<\/button>/.test(markup), markup);

  // The claim was released, so the click behind that button wins the same id
  // back rather than finding it taken by the attempt that failed.
  assert.deepEqual(await claimIds(refusing, ["note-1"]), ["note-1"]);

  // And the button's own path works end to end against a host that takes it.
  const accepting = widget(store, "accept");
  await claimIds(accepting, []);
  const retried = await retryAnnouncement(accepting, ["note-2"]);
  assert.equal(retried.outcome, "sent");
  assert.deepEqual(accepting.sent, [announcementText(1)]);

  // A button pressed after another widget got there first sends nothing and
  // still reports the ids answered for, so the control clears rather than
  // inviting a second message.
  const late = await retryAnnouncement(refusing, ["note-2"]);
  assert.deepEqual(late, { outcome: "sent", ids: ["note-2"] });
  assert.equal(accepting.sent.length, 1);
});

test("the Answer button label contains Answer and the mention count", () => {
  assert.equal(answerLabel(1), "Answer 1 @claude mention");
  assert.equal(answerLabel(4), "Answer 4 @claude mentions");
  for (const count of [1, 4]) {
    const label = answerLabel(count);
    assert.ok(label.includes("Answer"), label);
    assert.ok(label.includes(String(count)), label);
  }
  // Nothing to press when nothing was refused.
  const quiet = renderToStaticMarkup(
    <StatusBar
      payload={null}
      note="Connecting to the room…"
      lastUpdateAt={null}
      pollingAvailable={true}
      linkBlocked={false}
      onOpen={() => undefined}
      onRefresh={() => undefined}
    />,
  );
  assert.ok(!quiet.includes("Answer"), quiet);
});

test("a failed announcement does not stop polling or repainting", async () => {
  const store = new ClaimStore();
  const app = widget(store, "throw");
  const painted: number[] = [];
  const attempts: Promise<unknown>[] = [];

  // The poll handler: parse, repaint, announce in the background. The
  // announcement is never awaited here, which is the point - a host with no
  // ui/message must not cost the reader a frame.
  const poll = (tick: number) => {
    const payload = parsePayload({
      structuredContent: {
        link: null,
        connected: true,
        peers: [],
        elements: [{ id: "note-1", version: tick }],
        mentions: [{ id: "note-1", version: tick, text: MENTION_TEXT, x: 0, y: 0, width: 10, height: 10, containerId: null, nearby: [], announced: false }],
      },
    });
    assert.ok(payload);
    attempts.push(announceMentions(app, payload.mentions).catch(() => assert.fail("announceMentions rejected")));
    painted.push(tick);
  };

  for (const tick of [1, 2, 3]) poll(tick);
  assert.deepEqual(painted, [1, 2, 3], "every poll repainted");

  const results = await Promise.all(attempts);
  for (const result of results) assert.notEqual((result as { outcome: string }).outcome, "sent");
  assert.deepEqual(app.sent, []);
  // Each failed attempt gave the id back, so nothing is stuck claimed.
  assert.deepEqual(await claimIds(widget(store), ["note-1"]), ["note-1"]);
});
