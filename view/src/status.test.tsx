import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ShowRoomMention, ShowRoomPayload } from "./payload.js";
import { canvasElements, highlightBoxes } from "./scene.js";
import { ANNOUNCEMENT_REFUSED_TEXT, answerLabel } from "./announce.js";
import { clock, openInBrowser, OPEN_IN_BROWSER_LABEL, POLLING_UNAVAILABLE_TEXT, StatusBar, type OpenLinkCapable } from "./status.js";

const LINK = "https://excalidraw.com/#room=0123456789abcdef0123,AbCdEfGhIjKlMnOpQrStUv";
const MENTION_TEXT = "@claude add a box here";

function mention(over: Partial<ShowRoomMention> = {}): ShowRoomMention {
  return { id: "text-1", version: 5, text: MENTION_TEXT, x: 20, y: 40, width: 200, height: 25, containerId: null, nearby: [], ...over };
}

function payload(over: Partial<ShowRoomPayload> = {}): ShowRoomPayload {
  return {
    link: LINK,
    connected: true,
    peers: [{ socketId: "sock-1", username: "Ada" }],
    elements: [{ id: "rect-1" }, { id: "text-1", text: MENTION_TEXT }],
    mentions: [mention()],
    ...over,
  };
}

function bar(over: Partial<Parameters<typeof StatusBar>[0]> = {}): string {
  return renderToStaticMarkup(
    <StatusBar
      payload={payload()}
      note="Connecting to the room…"
      lastUpdateAt={null}
      pollingAvailable={true}
      linkBlocked={false}
      onOpen={() => undefined}
      onRefresh={() => undefined}
      {...over}
    />,
  );
}

/** A host that takes, refuses or drops an open-link request, and records what it was asked. */
function host(behaviour: "accept" | "refuse" | "throw"): OpenLinkCapable & { asked: { url: string }[] } {
  const asked: { url: string }[] = [];
  return {
    asked,
    openLink: async (params) => {
      asked.push(params);
      if (behaviour === "throw") throw new Error("host has no open-link");
      return behaviour === "refuse" ? { isError: true } : {};
    },
  };
}

test("mention texts render only on the canvas", () => {
  const markup = bar();
  // The bar counts the pending mentions; the words are on the canvas, where the
  // note sits, and nowhere in the view's own chrome.
  assert.ok(markup.includes("1 pending mention"), markup);
  assert.ok(!markup.includes(MENTION_TEXT), markup);
  assert.ok(!markup.toLowerCase().includes("mentions</h2>"), markup);
  // The mention's own text element is in the room's scene, so the canvas is
  // what renders it, with a highlight box on top carrying no text of its own.
  const scene = canvasElements(payload().elements, highlightBoxes([mention()]) as unknown as Record<string, unknown>[]);
  assert.ok(JSON.stringify(scene).includes(MENTION_TEXT));
  assert.equal(JSON.stringify(highlightBoxes([mention()])).includes(MENTION_TEXT), false);
});

test("status line shows connection, peers, elements, pending mentions and last update and no Refresh when polling is available", () => {
  const at = Date.UTC(2026, 0, 2, 3, 4, 5);
  const markup = bar({ lastUpdateAt: at, pollingAvailable: true });
  assert.ok(markup.includes("connected"), markup);
  assert.ok(markup.includes("1 peer<"), markup);
  assert.ok(markup.includes("2 elements"), markup);
  assert.ok(markup.includes("1 pending mention"), markup);
  assert.ok(markup.includes(`last update ${clock(at)}`), markup);
  assert.equal(clock(at), new Date(at).toLocaleTimeString());
  // Polling is what keeps the canvas current, so there is nothing to press.
  assert.ok(!markup.includes("Refresh"), markup);
  assert.ok(!markup.includes(POLLING_UNAVAILABLE_TEXT), markup);
  // Nothing of the old diagnostics survives.
  assert.ok(!/\bpolls\b|\brepaints\b|\bstructured\b|\bstale\b/.test(markup), markup);
});

test("status line shows the polling-unavailable text and a Refresh control when the host does not proxy server tools", () => {
  const markup = bar({ pollingAvailable: false });
  assert.ok(markup.includes(POLLING_UNAVAILABLE_TEXT), markup);
  assert.ok(/<button[^>]*>Refresh<\/button>/.test(markup), markup);
});

test("Open in browser requests open-link with the room link", async () => {
  const markup = bar();
  assert.ok(markup.includes(OPEN_IN_BROWSER_LABEL), markup);
  const app = host("accept");
  assert.equal(await openInBrowser(app, LINK), "opened");
  assert.deepEqual(app.asked, [{ url: LINK }]);
});

test("Open in browser shows the link as text when the host rejects open-link", async () => {
  const refused = host("refuse");
  assert.equal(await openInBrowser(refused, LINK), "blocked");
  const thrown = host("throw");
  assert.equal(await openInBrowser(thrown, LINK), "blocked");
  // A blocked link is shown for the reader to copy, and the control that cannot
  // work is gone.
  const markup = bar({ linkBlocked: true });
  assert.ok(markup.includes(LINK), markup);
  assert.ok(!markup.includes(OPEN_IN_BROWSER_LABEL), markup);
});

test("the status bar says why there is no room yet before the first update", () => {
  const markup = bar({ payload: null, note: "Waiting for a room link." });
  assert.ok(markup.includes("Waiting for a room link."), markup);
  assert.ok(markup.includes("last update -"), markup);
});

test("the bar shows Answer 1 @claude mention for one pending mention", () => {
  const markup = bar({ payload: payload({ mentions: [mention()] }) });
  assert.ok(/<button[^>]*>Answer 1 @claude mention<\/button>/.test(markup), markup);
  // The button is there because something is pending, not because a send was
  // refused: nothing has been sent at all.
  assert.ok(!markup.includes(ANNOUNCEMENT_REFUSED_TEXT), markup);
  // The refusal sits next to the button, which stays: a refused host may take
  // the next press and the mention is pending either way.
  const refusedMarkup = bar({ payload: payload({ mentions: [mention()] }), announcementRefused: true });
  assert.ok(refusedMarkup.includes(ANNOUNCEMENT_REFUSED_TEXT), refusedMarkup);
  assert.ok(refusedMarkup.includes(answerLabel(1)), refusedMarkup);
});

test("the bar shows Answer 3 @claude mentions for three pending mentions", () => {
  const three = [mention({ id: "text-1" }), mention({ id: "text-2" }), mention({ id: "text-3" })];
  const markup = bar({ payload: payload({ mentions: three }) });
  assert.ok(/<button[^>]*>Answer 3 @claude mentions<\/button>/.test(markup), markup);
  assert.ok(markup.includes("3 pending mentions"), markup);
  // The label counts what is pending, so it never disagrees with the bar.
  assert.ok(!markup.includes("Answer 1 @claude mention<"), markup);
});

test("the bar shows no Answer button when nothing is pending", () => {
  const markup = bar({ payload: payload({ mentions: [] }) });
  assert.ok(markup.includes("no pending mentions"), markup);
  assert.ok(!markup.includes("Answer"), markup);
  // Nor before the first update, when there is no room to count.
  assert.ok(!bar({ payload: null }).includes("Answer"), markup);
  // A refusal with nothing pending leaves nothing to press or to explain.
  assert.ok(!bar({ payload: payload({ mentions: [] }), announcementRefused: true }).includes("Answer"), markup);
});
