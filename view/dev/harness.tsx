/**
 * A local rig for the repaint path. Not part of the bundle: vite.config.ts names
 * canvas.html as the only input, and .mcpbignore drops view/ from the package.
 *
 *   npx vite --config view/vite.config.ts   then open /dev/harness.html
 *
 * It stands in for the host: a fake App whose callServerTool returns whatever
 * payload the page currently holds, so a poll can be watched without a host.
 * window.harness lets a driver (or the console) push a new payload and count
 * the elements the canvas actually drew.
 */
import type { App } from "@modelcontextprotocol/ext-apps";
import { createRoot } from "react-dom/client";
import { RoomView } from "../src/app.js";
import "@excalidraw/excalidraw/index.css";
import "../src/style.css";

function rect(id: string, x: number, y: number, w: number, h: number, version: number) {
  return {
    id,
    type: "rectangle",
    x,
    y,
    width: w,
    height: h,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    index: `a${id}`,
    roundness: null,
    seed: 1,
    version,
    versionNonce: version * 7,
    isDeleted: false,
    boundElements: null,
    updated: 1,
    link: null,
    locked: false,
  };
}

function payload(elements: unknown[], mentions: unknown[] = []) {
  return {
    link: "https://excalidraw.com/#room=0123456789abcdef0123,AbCdEfGhIjKlMnOpQrStUv",
    connected: true,
    peers: [{ socketId: "sock-1", username: "Ada" }],
    elements,
    mentions,
  };
}

const SCENES: Record<string, ReturnType<typeof payload>> = {
  // One shape, the seed.
  seed: payload([rect("a", 0, 0, 200, 100, 1)]),
  // A second shape: a version-bearing change the poll must repaint.
  grown: payload([rect("a", 0, 0, 200, 100, 1), rect("b", 300, 0, 200, 100, 1)]),
  // The same ids at a higher version: an edit in place.
  edited: payload([rect("a", 0, 0, 400, 260, 9), rect("b", 300, 0, 200, 100, 1)]),
  // Wide, with a note far below: issue 31's letterboxing case.
  wide: payload(
    [rect("a", 0, 0, 1200, 700, 1)],
    [{ id: "note", version: 1, text: "@claude here", x: 0, y: 900, width: 200, height: 25, containerId: null, nearby: ["a"] }],
  ),
  // An element far outside the bounds: H2's refit case.
  far: payload([rect("a", 0, 0, 200, 100, 1), rect("z", 0, 800, 200, 100, 1)]),
  // An edit that changes an element but not the extent: H2's second half, where
  // the viewport must stay where the reader left it.
  inside: payload([rect("a", 0, 0, 200, 100, 4), rect("z", 0, 800, 200, 100, 1), rect("m", 50, 400, 100, 60, 1)]),
};

let current = SCENES.seed;
let polls = 0;

/**
 * A host already holds the tool result when it renders the widget, so it
 * delivers it as soon as the view connects rather than waiting for a poll. That
 * makes the seed apply race Excalidraw's own mount, which is the race issue #30
 * lands on: `?seed=poll` here delivers it a second later instead, for comparison.
 */
const SEED_ON_CONNECT = new URLSearchParams(location.search).get("seed") !== "poll";

const app = {
  ontoolresult: undefined as undefined | ((params: unknown) => void),
  connect: async () => {
    if (SEED_ON_CONNECT) app.ontoolresult?.({ content: [{ type: "text", text: "room summary" }], structuredContent: current } as never);
    return undefined;
  },
  callServerTool: async () => {
    polls += 1;
    // What the server returns for include: "json": the payload as text, no
    // structured channel. The seed paths below still deliver structuredContent,
    // which is the other shape a host may hand the view.
    return { content: [{ type: "text", text: JSON.stringify(current) }] };
  },
  getHostCapabilities: () => ({ serverTools: {} }),
  // What a host that allows the request does. `?openlink=refuse` stands in for
  // one that does not, so the bar's link-as-text fallback can be seen.
  openLink: async ({ url }: { url: string }) => {
    if (new URLSearchParams(location.search).get("openlink") === "refuse") return { isError: true };
    window.open(url, "_blank", "noreferrer");
    return {};
  },
  getHostContext: () => ({ displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] }),
  sendSizeChanged: (size: unknown) => void size,
} as unknown as App;

declare global {
  interface Window {
    harness: {
      scenes: string[];
      set: (name: string) => void;
      seed: (name: string) => void;
      polls: () => number;
      /** A fingerprint of the drawn pixels. Changes only when the canvas repaints. */
      painted: () => string;
    };
  }
}

window.harness = {
  scenes: Object.keys(SCENES),
  set: (name) => {
    current = SCENES[name] ?? current;
  },
  seed: (name) => {
    current = SCENES[name] ?? current;
    app.ontoolresult?.({ content: [{ type: "text", text: "room summary" }], structuredContent: current } as never);
  },
  polls: () => polls,
  painted: () => {
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>(".excalidraw canvas")];
    // A cheap content hash: the static canvas holds the elements, and its data
    // URL changes if and only if what was drawn changed.
    return canvases
      .map((c) => {
        const url = c.toDataURL();
        let h = 0;
        for (let i = 0; i < url.length; i += 1) h = (h * 31 + url.charCodeAt(i)) | 0;
        return `${c.width}x${c.height}:${h}`;
      })
      .join(" ");
  },
};

const container = document.getElementById("root");
if (container) createRoot(container).render(<RoomView app={app} />);
