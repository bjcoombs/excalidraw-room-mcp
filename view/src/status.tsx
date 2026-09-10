/**
 * The status bar under the canvas, and the host-mediated way out to the browser.
 *
 * The bar is the view's only chrome: the canvas takes the whole width, so
 * everything a reader needs about the room - whether it is connected, how many
 * peers and elements it holds, how many @claude mentions are still pending, and
 * when the last update landed - is one quiet line here. Mention text is not:
 * that belongs on the canvas, where the note actually sits.
 *
 * This module is React and nothing else - no Excalidraw, no host SDK class - so
 * it renders under Node with renderToStaticMarkup and the bar's content is
 * pinned by test rather than by screenshot.
 */
import { ANNOUNCEMENT_REFUSED_TEXT, answerLabel } from "./announce.js";
import { roomLink, type ShowRoomPayload } from "./payload.js";

/**
 * What the bar says when the host does not proxy server tools: there is no
 * polling in that host, so Refresh is the only way to update the view and the
 * bar has to say so rather than leave a still frame unexplained.
 */
export const POLLING_UNAVAILABLE_TEXT = "polling unavailable: this host does not proxy server tools, use Refresh";

/** The label of the control that asks the host to open the room in a browser. */
export const OPEN_IN_BROWSER_LABEL = "Open in browser";

/** The part of `App` this module uses. A fake with one method stands in for it under test. */
export interface OpenLinkCapable {
  openLink(params: { url: string }): Promise<{ isError?: boolean }>;
}

/** Whether the host took the link, or left the view to show it instead. */
export type OpenOutcome = "opened" | "blocked";

/**
 * Ask the host to open a URL. A sandboxed iframe cannot navigate the browser
 * itself, so this is the only way out; a host may refuse by answering
 * `isError` or by rejecting the request outright, and both mean the same thing
 * to the reader - the bar shows the link as text to copy instead.
 */
export async function openInBrowser(app: OpenLinkCapable, url: string): Promise<OpenOutcome> {
  try {
    const result = await app.openLink({ url });
    return result?.isError ? "blocked" : "opened";
  } catch {
    return "blocked";
  }
}

/** Local time of day, or a dash before the first update. */
export function clock(at: number | null): string {
  return at === null ? "-" : new Date(at).toLocaleTimeString();
}

/** "no pending mentions", "1 pending mention", "3 pending mentions". */
export function pendingText(count: number): string {
  if (count === 0) return "no pending mentions";
  return `${count} pending mention${count === 1 ? "" : "s"}`;
}

/**
 * The only thing in this view that puts a message in the chat, and it does so
 * from a press. Present whenever the room has a pending mention - not only
 * after a refusal - because a host drafts a `ui/message` rather than sending
 * it whether a timer or a click produced it, so the press is the mechanism and
 * not the fallback. It stays up until the mentions leave the pending list: a
 * sent announcement the model has not acted on yet is still unanswered.
 */
function AnswerButton({ count, refused, onAnswer }: { count: number; refused: boolean; onAnswer?: () => void }) {
  if (count <= 0) return null;
  return (
    <>
      <button type="button" className="answer" onClick={onAnswer}>
        {answerLabel(count)}
      </button>
      {refused ? <span className="announce-refused">{ANNOUNCEMENT_REFUSED_TEXT}</span> : null}
    </>
  );
}

/**
 * A menu action's one-line result. Its own component for the reason
 * AnswerButton and OpenControl are: the bar's function is already at the
 * complexity ceiling the lint config sets, and a conditional piece of it
 * belongs beside the others rather than inside the footer.
 */
function Hint({ text }: { text?: string | null }) {
  if (!text) return null;
  return <span className="status-hint">{text}</span>;
}

/** The way out to the browser, or the link as text where the host refused it. */
function OpenControl({ href, linkBlocked, onOpen }: { href: string | null; linkBlocked: boolean; onOpen: () => void }) {
  if (!href) return null;
  return (
    <span className="open">
      {linkBlocked ? (
        <span className="room-link">{href}</span>
      ) : (
        <button type="button" className="open-link" onClick={onOpen}>
          {OPEN_IN_BROWSER_LABEL}
        </button>
      )}
    </span>
  );
}

export interface StatusBarProps {
  /** The room as the last update described it, or null before the first one. */
  payload: ShowRoomPayload | null;
  /** What to say while there is no room to describe: connecting, or why not.  */
  note: string;
  /** The last call's failure, if it failed. Kept visible while the stale scene is still on screen. */
  error?: string | null;
  /** When the last update landed, in epoch ms. */
  lastUpdateAt: number | null;
  /** Whether the host proxies server tools. Null until the connection answers. */
  pollingAvailable: boolean | null;
  /** True once the host has refused to open the link, which makes the bar show it as text. */
  linkBlocked: boolean;
  /** True once the host has refused an announcement, which puts the refusal next to the button. */
  announcementRefused?: boolean;
  /**
   * The last menu action's one-line result - a snapshot sent, copied to the
   * clipboard, or refused everywhere. Null when there is nothing to say. The
   * menu has no surface of its own once it closes, so this line is where its
   * actions report.
   */
  hint?: string | null;
  onOpen: () => void;
  onRefresh: () => void;
  /** Send the announcement for everything pending. The only path to `ui/message` in this view. */
  onAnswer?: () => void;
}

export function StatusBar({
  payload,
  note,
  error = null,
  lastUpdateAt,
  pollingAvailable,
  linkBlocked,
  announcementRefused = false,
  hint,
  onOpen,
  onRefresh,
  onAnswer,
}: StatusBarProps) {
  const peers = payload?.peers.length ?? 0;
  const href = roomLink(payload?.link ?? null);
  return (
    <footer className="room-status">
      {payload ? (
        <>
          <span className={payload.connected ? "dot dot-on" : "dot dot-off"} />
          <span>{payload.connected ? "connected" : "disconnected"}</span>
          <span className="sep">·</span>
          <span>
            {peers} peer{peers === 1 ? "" : "s"}
          </span>
          <span className="sep">·</span>
          <span>{payload.elements.length} elements</span>
          <span className="sep">·</span>
          <span>{pendingText(payload.mentions.length)}</span>
          <span className="sep">·</span>
        </>
      ) : (
        <>
          <span>{note}</span>
          <span className="sep">·</span>
        </>
      )}
      <span>last update {clock(lastUpdateAt)}</span>
      {pollingAvailable === false ? (
        <>
          <span className="sep">·</span>
          <span>{POLLING_UNAVAILABLE_TEXT}</span>
          <button type="button" className="refresh" onClick={onRefresh}>
            Refresh
          </button>
        </>
      ) : null}
      <AnswerButton count={payload?.mentions.length ?? 0} refused={announcementRefused} onAnswer={onAnswer} />
      <Hint text={hint} />
      {error ? <span className="status-error">last error: {error}</span> : null}
      <OpenControl href={href} linkBlocked={linkBlocked} onOpen={onOpen} />
    </footer>
  );
}
