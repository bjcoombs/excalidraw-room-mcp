/**
 * The in-chat canvas. Read-only: it renders what the server has, and never
 * writes to the room. Editing stays on excalidraw.com, one click away through
 * the status bar's Open in browser control.
 *
 * The canvas takes the whole widget. Everything else the reader needs is one
 * line along the bottom (status.tsx); a mention's words are drawn where the
 * note sits, on the canvas, rather than repeated in a column beside it.
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
 * applied, after which every refresh carrying the same signature returned early
 * and the canvas stayed as it was until somebody edited the room. Holding the
 * scene and flushing it from an effect closes that window: a parent's effect
 * runs after its children have mounted.
 *
 * Second, the bar reports when the last update landed, so a canvas that has
 * stopped moving can be told from a room that has.
 *
 * A third thing exists because a host may not route the view to the same
 * server process the model is talking to. Claude Desktop routes an iframe's
 * callServerTool to a second process, and one room per process means that
 * process has joined nothing, so every refresh answers with the not-in-a-room
 * refusal while the model reads the scene perfectly well. So the view learns
 * the room link from the summary it is seeded with and passes it on every call:
 * show_room joins that room first when it is in none, and the widget shows up
 * in the room as an extra peer.
 */
import { CaptureUpdateAction, Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { App } from "@modelcontextprotocol/ext-apps";
import { useCallback, useEffect, useRef, useState } from "react";
import { boundsChanged, FIT_PADDING, sceneBounds, type SceneBounds } from "./bounds.js";
import { highlightElements } from "./highlights.js";
import { envelopeShape, isNotInRoom, linkFromSummary, parseResult, resultText, roomLink, sceneSignature, type ShowRoomPayload } from "./payload.js";
import { canvasElements } from "./scene.js";
import { openInBrowser, StatusBar } from "./status.js";

/** How often the view asks the server for the room again, in milliseconds. */
const REFRESH_INTERVAL_MS = 2000;

/**
 * The height the view asks the host for. A 1200x700 scene in a 200 px strip is
 * what issue #31 reports; this is the smallest height at which such a scene is
 * legible. The host may refuse, hence the matching min-height in style.css.
 */
const PREFERRED_HEIGHT_PX = 560;

export function RoomView({ app }: { app: App }) {
  const [payload, setPayload] = useState<ShowRoomPayload | null>(null);
  const [note, setNote] = useState<string>("Connecting to the room…");
  const [error, setError] = useState<string | null>(null);
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);
  const [pollingAvailable, setPollingAvailable] = useState<boolean | null>(null);
  const [linkBlocked, setLinkBlocked] = useState(false);
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastSignature = useRef<string | null>(null);
  /** Which request is newest. A result from an older one is dropped rather than applied. */
  const lastGeneration = useRef(0);
  const lastBounds = useRef<SceneBounds | null>(null);
  /** The newest scene that has not reached the canvas, or null when the canvas is current. */
  const pending = useRef<ShowRoomPayload | null>(null);
  /**
   * The room link, once anything has named it. Sent on every call so a server
   * process that has joined nothing joins this room rather than refusing.
   */
  const link = useRef<string | null>(null);
  // Bumping this is how a flush from an effect reaches the bar.
  const [, setTick] = useState(0);
  const show = useCallback(() => setTick((n) => n + 1), []);

  /**
   * Push the held scene into the canvas, and fit the viewport when the scene's
   * extent moved. Returns whether a scene actually reached the canvas, so a
   * caller knows whether anything changed; a scene held for want of a mounted
   * canvas stays in `pending` for the next call.
   *
   * Only ever called from an effect or from a refresh's callback - never from a
   * render. See the note at the top of this file.
   */
  const flush = useCallback(() => {
    const next = pending.current;
    if (!next) return false;
    const instance = api.current;
    if (!instance) return false;
    const elements = canvasElements(next.elements, highlightElements(next.mentions) as unknown as Record<string, unknown>[]);
    // View mode has no undo stack to feed, and a remote scene is not the
    // reader's edit: NEVER keeps it out of history. Excalidraw 0.18 requires the
    // action explicitly rather than defaulting it.
    instance.updateScene({ elements: elements as never, captureUpdate: CaptureUpdateAction.NEVER });
    pending.current = null;

    // Measured over the drawn list, not over next.elements: a highlight box sits
    // 8 px outside the mention it wraps, so bounds taken from the elements alone
    // can exclude a highlight at the scene edge. Relying on FIT_PADDING to
    // absorb the overhang would tie correctness to two unrelated constants.
    const bounds = sceneBounds(elements);
    if (bounds && boundsChanged(lastBounds.current, bounds)) {
      lastBounds.current = bounds;
      // Guarded by boundsChanged above: fitToContent runs on first paint and
      // whenever an edge moved, and never for an edit inside the existing box,
      // which would yank a viewport the reader is looking at. canvasOffsets is
      // the only padding fitToContent takes.
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
  // an element's version or versionNonce moved, so an unchanged result leaves
  // the viewport alone. The `pending` half of that test is what keeps a held
  // scene from being stranded: an identical signature is only grounds to skip
  // the push when the last one actually reached the canvas.
  const apply = useCallback(
    (next: ShowRoomPayload) => {
      setPayload(next);
      const signature = sceneSignature(next.elements) + `#${next.mentions.map((m) => `${m.id}:${m.version}`).join(",")}`;
      if (signature === lastSignature.current && pending.current === null) return;
      lastSignature.current = signature;
      pending.current = next;
      flush();
    },
    [flush],
  );

  /**
   * Read one tool result.
   *
   * The seed is the exception. `show_room` returns the model's summary by
   * default, and the host hands the view whatever the model's call returned, so
   * a seed without a payload is the normal case rather than a failure: the
   * view's own first refresh, dispatched on connect with include: "json", is
   * what carries the scene.
   */
  const record = useCallback(
    (result: unknown, seed = false) => {
      const { payload: next } = parseResult(result);
      // Every result is read for the room link first, payload or not: the seed
      // is a summary whose first line names the room, and it is often the only
      // thing that does when the view's own calls land on a process that has
      // joined nothing.
      const named = roomLink(next?.link ?? null) ?? linkFromSummary(resultText(result));
      if (named) link.current = named;
      if (next) {
        apply(next);
        return;
      }
      if (seed) {
        setNote("Loading the room…");
        return;
      }
      // A refusal from a server that has joined nothing, with no link yet to
      // send it, is the expected state: the next seed or summary carrying a
      // link is what ends it.
      if (link.current === null && isNotInRoom(resultText(result))) {
        setNote("Waiting for a room link. Ask for show_room once the room is joined.");
        return;
      }
      // A result with no text at all: name the envelope the parser was given,
      // so the next operator sees which host wrapper the view is missing.
      setNote(resultText(result) ?? `The server sent a result the view could not read: ${envelopeShape(result)}`);
    },
    [apply],
  );

  const refresh = useCallback(async () => {
    // A refresh does not await the previous call, so two can be in flight at
    // once and the older one can answer last. Applying it would show a scene
    // the reader has already moved past - self-healing on the next refresh, but
    // a visible step backwards until then. A result is applied only while it is
    // still the newest one dispatched.
    const generation = (lastGeneration.current += 1);
    try {
      // include: "json" is how the view gets the elements at all: show_room
      // returns text only, and its default is the model's summary. A
      // callServerTool result is the view's own call and never enters the
      // conversation, so the full payload here costs the reader nothing.
      // link is what lets a second server process - the one some hosts route
      // this iframe's calls to - join the room before answering. The process
      // the model uses is already in it and ignores the argument.
      const args: Record<string, unknown> = { include: "json" };
      if (link.current) args.link = link.current;
      const result = await app.callServerTool({ name: "show_room", arguments: args });
      if (generation !== lastGeneration.current) return;
      setLastUpdateAt(Date.now());
      setError(null);
      record(result);
    } catch (err) {
      // A call that throws is reported and retried. Stopping here is what turns
      // one bad call into a permanently still frame.
      setError(String(err));
      setNote(`Could not reach the server: ${String(err)}`);
    }
  }, [app, record]);

  /**
   * Hand the room to the host's browser. A sandboxed iframe cannot navigate
   * anywhere itself, so a host that refuses leaves the link to be shown as text
   * in the bar instead of a control that does nothing.
   */
  const open = useCallback(() => {
    const href = roomLink(payload?.link ?? null);
    if (!href) return;
    void openInBrowser(app, href).then((outcome) => setLinkBlocked(outcome === "blocked"));
  }, [app, payload]);

  useEffect(() => {
    // A seed the host happens to carry a payload in still paints immediately;
    // otherwise it is a summary, and the refresh below is what fills the canvas.
    app.ontoolresult = (params) => {
      record(params, true);
      show();
    };
    void app.connect().then(
      () => {
        // serverTools is the capability that makes an interval refresh possible
        // at all; without it the Refresh button is the only path, and the bar
        // has to say so rather than leave a still frame unexplained.
        const capable = app.getHostCapabilities()?.serverTools !== undefined;
        setPollingAvailable(capable);
        // A taller container where the host takes a hint; style.css carries the
        // fallback for a host that ignores it.
        try {
          app.sendSizeChanged({ width: document.documentElement.clientWidth || 800, height: PREFERRED_HEIGHT_PX });
        } catch {
          // A host without the notification is not a reason to fail the view.
        }
        // The seed cannot be relied on to carry the scene, so the view fetches
        // it here rather than waiting for the interval's first tick.
        void refresh();
      },
      (err: unknown) => {
        setError(String(err));
        setNote(`Could not connect to the host: ${String(err)}`);
      },
    );
  }, [app, record, refresh, show]);

  // A hidden document is a document nobody is watching: refreshing it burns the
  // server's socket and the host's budget for nothing. Visibility is the only
  // thing that stops the interval.
  useEffect(() => {
    let timer: number | undefined;
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer);
      timer = undefined;
    };
    const start = () => {
      stop();
      timer = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    };
    const onVisibilityChange = () => {
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
      <StatusBar
        payload={payload}
        note={note}
        error={error}
        lastUpdateAt={lastUpdateAt}
        pollingAvailable={pollingAvailable}
        linkBlocked={linkBlocked}
        onOpen={open}
        onRefresh={() => void refresh()}
      />
    </div>
  );
}
