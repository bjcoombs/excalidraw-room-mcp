/**
 * The in-chat canvas. Read-only: it renders what the server has, and never
 * writes to the room. Editing stays on excalidraw.com, one click away through
 * the header link.
 */
import { Excalidraw } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { App } from "@modelcontextprotocol/ext-apps";
import { useCallback, useEffect, useRef, useState } from "react";
import { highlightElements } from "./highlights.js";
import { parsePayload, roomLink, sceneSignature, type ShowRoomPayload } from "./payload.js";

/** How often the view asks the server for the room again, in milliseconds. */
const POLL_INTERVAL_MS = 2000;

export function RoomView({ app }: { app: App }) {
  const [payload, setPayload] = useState<ShowRoomPayload | null>(null);
  const [note, setNote] = useState<string>("Connecting to the room…");
  const api = useRef<ExcalidrawImperativeAPI | null>(null);
  const lastSignature = useRef<string | null>(null);

  // Applied on every refresh; the scene is only pushed into the component when
  // an element's version or versionNonce moved, so the viewport is left alone.
  const apply = useCallback((next: ShowRoomPayload) => {
    setPayload(next);
    const signature = sceneSignature(next.elements) + `#${next.mentions.map((m) => `${m.id}:${m.version}`).join(",")}`;
    if (signature === lastSignature.current) return;
    lastSignature.current = signature;
    api.current?.updateScene({
      elements: [...next.elements, ...highlightElements(next.mentions)] as never,
    });
  }, []);

  const refresh = useCallback(async () => {
    try {
      const result = await app.callServerTool({ name: "show_room", arguments: {} });
      const next = parsePayload(result as never);
      if (next) apply(next);
      else setNote(textOf(result as never) ?? "The server is not in a room.");
    } catch (err) {
      setNote(`Could not reach the server: ${String(err)}`);
    }
  }, [app, apply]);

  useEffect(() => {
    app.ontoolresult = (params) => {
      const seed = parsePayload(params as never);
      if (seed) apply(seed);
      else setNote(textOf(params as never) ?? "The server is not in a room.");
    };
    void app.connect().then(refresh, (err: unknown) => setNote(`Could not connect to the host: ${String(err)}`));
  }, [app, apply, refresh]);

  // A hidden document is a document nobody is watching: polling it burns the
  // server's socket and the host's budget for nothing.
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
          <Excalidraw excalidrawAPI={(instance) => (api.current = instance)} viewModeEnabled zenModeEnabled UIOptions={{ canvasActions: { toggleTheme: false } }} />
        </div>
        <MentionStrip payload={payload} />
      </div>
    </div>
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
