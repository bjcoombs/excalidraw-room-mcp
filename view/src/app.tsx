/**
 * The in-chat canvas. Read-only: it renders what the server has, and never
 * writes to the room. Editing stays on excalidraw.com, one click away through
 * the header link.
 *
 * Two things here exist because the widget painted a still frame in a host we
 * could not step through (issue #30).
 *
 * First, the scene is pushed into the canvas from an effect and never from a
 * render. `excalidrawAPI` hands over the imperative API during Excalidraw's own
 * render, before its component has mounted, and `updateScene` on an unmounted
 * Excalidraw is a silent no-op - it logs React's "can't call setState on a
 * component that is not yet mounted" and draws nothing. A seed result that
 * arrives in that window was therefore dropped while still being recorded as
 * applied, after which every poll carrying the same signature returned early and
 * the canvas stayed as it was until somebody edited the room. Holding the scene
 * and flushing it from an effect closes that window: a parent's effect runs
 * after its children have mounted.
 *
 * Second, every stage of the apply path is counted and shown in a status line,
 * so the next operator sees which stage stopped without opening dev tools.
 */
import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { App } from "@modelcontextprotocol/ext-apps";
import { useCallback, useEffect, useRef, useState } from "react";
import { boundsChanged, FIT_PADDING, sceneBounds, type SceneBounds } from "./bounds.js";
import { highlightElements } from "./highlights.js";
import { parsePayload, roomLink, sceneSignature, type ShowRoomPayload } from "./payload.js";

/** How often the view asks the server for the room again, in milliseconds. */
const POLL_INTERVAL_MS = 2000;

/**
 * The height the view asks the host for. A 1200x700 scene in a 200 px strip is
 * what issue #31 reports; this is the smallest height at which such a scene
 * plus the mention strip is legible. The host may refuse, hence the matching
 * min-height in style.css.
 */
const PREFERRED_HEIGHT_PX = 560;

/** Counters and timestamps the status line reports. Refs, not state: they are written from a poll. */
interface Diagnostics {
  polls: number;
  applies: number;
  /** Results that were not a payload: the pre-join refusal, or an envelope this view cannot read. */
  parseNulls: number;
  /** updateScene calls that reached the canvas. */
  updates: number;
  /** Scenes held because the canvas was not ready yet. */
  deferred: number;
  fits: number;
  lastRefreshAt: number | null;
  lastError: string | null;
}

function emptyDiagnostics(): Diagnostics {
  return { polls: 0, applies: 0, parseNulls: 0, updates: 0, deferred: 0, fits: 0, lastRefreshAt: null, lastError: null };
}

export function RoomView({ app }: { app: App }) {
  const [payload, setPayload] = useState<ShowRoomPayload | null>(null);
  const [note, setNote] = useState<string>("Connecting to the room…");
  const [visibility, setVisibility] = useState<string>(() => document.visibilityState);
  const [pollingAvailable, setPollingAvailable] = useState<boolean | null>(null);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastSignature = useRef<string | null>(null);
  const lastBounds = useRef<SceneBounds | null>(null);
  /** The newest scene that has not reached the canvas, or null when the canvas is current. */
  const pending = useRef<ShowRoomPayload | null>(null);
  const diagnostics = useRef<Diagnostics>(emptyDiagnostics());
  // Bumping this is how a ref write reaches the status line; the counters
  // themselves stay in a ref so a poll never races a render for them.
  const [, setTick] = useState(0);
  const show = useCallback(() => setTick((n) => n + 1), []);

  /**
   * Push the held scene into the canvas, and fit the viewport when the scene's
   * extent moved. Returns whether a scene actually reached the canvas, so a
   * caller knows whether anything changed; a scene held for want of a mounted
   * canvas stays in `pending` for the next call.
   *
   * Only ever called from an effect or from a poll's callback - never from a
   * render. See the note at the top of this file.
   */
  const flush = useCallback(() => {
    const next = pending.current;
    if (!next) return false;
    const instance = api.current;
    if (!instance) {
      diagnostics.current.deferred += 1;
      return false;
    }
    const elements = [...next.elements, ...highlightElements(next.mentions)];
    // View mode has no undo stack to feed, and a remote scene is not the
    // reader's edit: NEVER keeps it out of history. Excalidraw 0.18 requires the
    // action explicitly rather than defaulting it.
    instance.updateScene({ elements: elements as never, captureUpdate: CaptureUpdateAction.NEVER });
    diagnostics.current.updates += 1;
    pending.current = null;

    const bounds = sceneBounds(next.elements);
    if (bounds && boundsChanged(lastBounds.current, bounds)) {
      lastBounds.current = bounds;
      diagnostics.current.fits += 1;
      // Guarded by boundsChanged above: fitToContent runs on first paint and
      // whenever an edge moved, and never for an edit inside the existing box,
      // which would yank a viewport the reader is looking at. scrollToContent
      // measures the elements it is given, so the highlights go in too - a
      // mention box sits outside the element it wraps. canvasOffsets is the
      // only padding fitToContent takes.
      instance.scrollToContent(elements as never, {
        fitToContent: true,
        animate: false,
        canvasOffsets: { top: FIT_PADDING, right: FIT_PADDING, bottom: FIT_PADDING, left: FIT_PADDING },
      });
    } else if (!bounds) {
      lastBounds.current = null;
    }
    return true;
  }, []);

  // The flush point. No dependency array, so this runs after every commit -
  // including the first one, which is the earliest moment Excalidraw is mounted
  // and the only one the seed result can be waiting on. flush() is a no-op when
  // nothing is held, so the re-render show() causes settles immediately rather
  // than looping.
  useEffect(() => {
    if (flush()) show();
  });

  // Applied on every refresh. The scene is only pushed into the component when
  // an element's version or versionNonce moved, so an unchanged poll leaves the
  // viewport alone. The `pending` half of that test is what keeps a held scene
  // from being stranded: an identical signature is only grounds to skip the
  // push when the last one actually reached the canvas.
  const apply = useCallback(
    (next: ShowRoomPayload) => {
      setPayload(next);
      diagnostics.current.applies += 1;
      const signature = sceneSignature(next.elements) + `#${next.mentions.map((m) => `${m.id}:${m.version}`).join(",")}`;
      if (signature === lastSignature.current && pending.current === null) return;
      lastSignature.current = signature;
      pending.current = next;
      flush();
    },
    [flush],
  );

  const refresh = useCallback(async () => {
    diagnostics.current.polls += 1;
    try {
      const result = await app.callServerTool({ name: "show_room", arguments: {} });
      diagnostics.current.lastRefreshAt = Date.now();
      diagnostics.current.lastError = null;
      const next = parsePayload(result as never);
      if (next) apply(next);
      else {
        diagnostics.current.parseNulls += 1;
        setNote(textOf(result as never) ?? "The server is not in a room.");
      }
    } catch (err) {
      // A poll that throws is reported and retried. Stopping here is what turns
      // one bad call into a permanently still frame.
      diagnostics.current.lastError = String(err);
      setNote(`Could not reach the server: ${String(err)}`);
    } finally {
      show();
    }
  }, [app, apply, show]);

  useEffect(() => {
    app.ontoolresult = (params) => {
      const seed = parsePayload(params as never);
      if (seed) apply(seed);
      else {
        diagnostics.current.parseNulls += 1;
        setNote(textOf(params as never) ?? "The server is not in a room.");
      }
      show();
    };
    void app.connect().then(
      () => {
        // serverTools is the capability that makes polling possible at all;
        // without it the Refresh button is the only refresh path, and the
        // status line has to say so rather than leave a still frame unexplained.
        const capable = app.getHostCapabilities()?.serverTools !== undefined;
        setPollingAvailable(capable);
        // A taller container where the host takes a hint; style.css carries the
        // fallback for a host that ignores it.
        try {
          app.sendSizeChanged({ width: document.documentElement.clientWidth || 800, height: PREFERRED_HEIGHT_PX });
        } catch {
          // A host without the notification is not a reason to fail the view.
        }
        void refresh();
      },
      (err: unknown) => {
        diagnostics.current.lastError = String(err);
        setNote(`Could not connect to the host: ${String(err)}`);
        show();
      },
    );
  }, [app, apply, refresh, show]);

  // A hidden document is a document nobody is watching: polling it burns the
  // server's socket and the host's budget for nothing. Visibility is the only
  // thing that stops the poll.
  useEffect(() => {
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    };
    const onVisibilityChange = () => {
      setVisibility(document.visibilityState);
      if (document.hidden) stop();
      else {
        void refresh();
        start();
      }
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    onVisibilityChange();
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      stop();
    };
  }, [refresh]);

  return (
    <div className="room">
      <Header payload={payload} note={note} />
      <div className="room-body">
        <div className="room-canvas">
          <Excalidraw
            // Called during Excalidraw's render, so this records the API and
            // nothing else; the effect above does the drawing once it is mounted.
            excalidrawAPI={(instance) => {
              api.current = instance;
            }}
            viewModeEnabled
            zenModeEnabled
            UIOptions={{ canvasActions: { toggleTheme: false } }}
          />
        </div>
        <MentionStrip payload={payload} />
      </div>
      <StatusLine diagnostics={diagnostics.current} visibility={visibility} pollingAvailable={pollingAvailable} onRefresh={() => void refresh()} />
    </div>
  );
}

/** Local time of day, or a dash before the first result. */
function clock(at: number | null): string {
  return at === null ? "-" : new Date(at).toLocaleTimeString();
}

/**
 * Why the canvas does or does not repaint, in one line. Every number here
 * distinguishes one stage of the apply path from the next: polls that returned,
 * results that were payloads, scenes that reached the canvas, and fits.
 */
function StatusLine({
  diagnostics,
  visibility,
  pollingAvailable,
  onRefresh,
}: {
  diagnostics: Diagnostics;
  visibility: string;
  pollingAvailable: boolean | null;
  onRefresh: () => void;
}) {
  const polling =
    pollingAvailable === false ? "polling unavailable: this host does not proxy server tools, use Refresh" : `polling every ${POLL_INTERVAL_MS / 1000}s`;
  return (
    <footer className="room-status">
      <button type="button" className="refresh" onClick={onRefresh}>
        Refresh
      </button>
      <span>last refresh {clock(diagnostics.lastRefreshAt)}</span>
      <span className="sep">·</span>
      <span>{diagnostics.polls} polls</span>
      <span className="sep">·</span>
      <span>
        {diagnostics.updates} repaints{diagnostics.fits ? `, ${diagnostics.fits} fits` : ""}
      </span>
      {diagnostics.parseNulls ? (
        <>
          <span className="sep">·</span>
          <span>{diagnostics.parseNulls} unreadable</span>
        </>
      ) : null}
      {diagnostics.deferred ? (
        <>
          <span className="sep">·</span>
          <span>{diagnostics.deferred} deferred</span>
        </>
      ) : null}
      <span className="sep">·</span>
      <span>{visibility}</span>
      <span className="sep">·</span>
      <span>{polling}</span>
      <span className="status-error">{diagnostics.lastError ? `last error: ${diagnostics.lastError}` : ""}</span>
    </footer>
  );
}

function Header({ payload, note }: { payload: ShowRoomPayload | null; note: string }) {
  if (!payload) return <header className="room-header">{note}</header>;
  const peers = payload.peers.length;
  const href = roomLink(payload.link);
  return (
    <header className="room-header">
      <span className={payload.connected ? "dot dot-on" : "dot dot-off"} />
      <span>{payload.connected ? "connected" : "disconnected"}</span>
      <span className="sep">·</span>
      <span>
        {peers} peer{peers === 1 ? "" : "s"}
      </span>
      <span className="sep">·</span>
      <span>{payload.elements.length} elements</span>
      {href ? (
        <a className="open-link" href={href} target="_blank" rel="noreferrer">
          Open on excalidraw.com
        </a>
      ) : null}
    </header>
  );
}

function MentionStrip({ payload }: { payload: ShowRoomPayload | null }) {
  const mentions = payload?.mentions ?? [];
  return (
    <aside className="room-mentions">
      <h2>Mentions</h2>
      {mentions.length === 0 ? (
        <p className="empty">Nothing pending.</p>
      ) : (
        <ul>
          {mentions.map((m) => (
            <li key={m.id}>
              <p className="mention-text">{m.text}</p>
              <p className="mention-meta">
                {m.id} · v{m.version}
                {m.nearby.length ? ` · near ${m.nearby.length}` : ""}
              </p>
            </li>
          ))}
        </ul>
      )}
      <p className="read-only">Read-only view. Draw on excalidraw.com.</p>
    </aside>
  );
}

function textOf(result: { content?: { type?: string; text?: string }[] } | undefined): string | null {
  return result?.content?.find((c) => c.type === "text")?.text ?? null;
}
