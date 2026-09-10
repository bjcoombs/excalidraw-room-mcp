/**
 * What the widget's menu actions do, minus the canvas.
 *
 * The two actions that carry a picture out of the widget - sending a snapshot
 * to the model and saving the image - are decided here, in plain functions that
 * take the host methods they need and a renderer shaped like Excalidraw's
 * `exportToBlob`. Nothing in this module imports Excalidraw or touches a DOM
 * global directly, so it compiles and runs under Node with the rest of the
 * tests (tsconfig.view-test.json), the way announce.ts and status.tsx do; the
 * binding to the real component is menu-excalidraw.tsx.
 *
 * Three things about the shape are deliberate.
 *
 * First, nothing here throws. Both functions are called from a menu handler,
 * and an exception out of one would leave the reader with a menu that closed
 * and nothing else. Every failure comes back as an outcome with the line the
 * status bar should show.
 *
 * Second, the model context path is the one that may not exist. `ui/update-model-context`
 * is optional for a host and image content in it is optional again: Claude
 * Desktop's support was unverified when this was written. So a refusal - a
 * missing method, an `isError` result or a rejected request - is a normal
 * branch, and its fallback is the clipboard, which needs no host support at
 * all: the reader pastes the PNG into the chat themselves.
 *
 * Third, the picture is rendered from the elements the reader can see rather
 * than from the whole scene. A room may be far larger than the viewport, and a
 * snapshot of everything answers a question nobody asked.
 */

/** The status-bar line after the clipboard fallback. The words are pinned by the acceptance contract. */
export const SNAPSHOT_CLIPBOARD_HINT = "snapshot copied, paste it into the chat";

/** The status-bar line when the snapshot reached the model. */
export const SNAPSHOT_SENT_HINT = "snapshot sent to Claude";

/** The name the host is asked to save the exported image under. */
export const EXPORT_FILE_NAME = "excalidraw-room.png";

/** The mime type of everything this module renders. */
const PNG = "image/png";

/** How far outside the elements the render leaves, in canvas pixels. */
const EXPORT_PADDING = 16;

/**
 * A content block as `ui/update-model-context` takes it. Restated rather than
 * imported so this module stays free of the SDK's class: a fake with one
 * method stands in for the host under test.
 */
export type ModelContextBlock = { type: "image"; data: string; mimeType: string } | { type: "text"; text: string };

/** A result a host may answer any of these requests with. */
export interface HostAnswer {
  isError?: boolean;
}

/**
 * The host methods the menu uses. Every one is optional: a host that does not
 * implement the request simply does not have the method, which is the same
 * answer as a refusal and takes the same fallback.
 */
export interface SnapshotHost {
  updateModelContext?(params: { content: ModelContextBlock[] }): Promise<unknown>;
  downloadFile?(params: { contents: { type: "resource"; resource: { uri: string; mimeType: string; blob: string } }[] }): Promise<HostAnswer | undefined>;
  openLink?(params: { url: string }): Promise<HostAnswer | undefined>;
}

/**
 * Excalidraw's `exportToBlob`, as far as this module needs it. The element and
 * app-state types are the component's own; they cross this boundary untouched,
 * so they are opaque here rather than restated wrongly.
 */
export type ExportToBlobLike = (options: {
  elements: readonly never[];
  appState: Record<string, unknown>;
  files: Record<string, unknown> | null;
  mimeType?: string;
  exportPadding?: number;
}) => Promise<Blob>;

/** The clipboard, as far as this module needs it. Null where the iframe has none. */
export interface ClipboardWriter {
  (blob: Blob): Promise<void>;
}

/** The scene to render: what the canvas holds now, and the room it belongs to. */
export interface SnapshotScene {
  elements: readonly Record<string, unknown>[];
  appState: Record<string, unknown>;
  files: Record<string, unknown> | null;
  link: string | null;
}

/** Everything the menu handlers need that is not the scene. */
export interface SnapshotEnv {
  app: SnapshotHost;
  exportToBlob: ExportToBlobLike;
  /** Null where the browser or the sandbox has no clipboard to write to. */
  clipboard?: ClipboardWriter | null;
  /** Device pixels per canvas pixel, so a snapshot is as sharp as the screen. */
  pixelRatio?: number;
}

/** What one action did, and the line the status bar should carry afterwards. */
export interface MenuOutcome {
  outcome: "sent" | "copied" | "saved" | "failed";
  hint: string;
  /** The ids that were rendered. Empty when nothing was. */
  ids: string[];
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** The ids of a list of elements, in the order they are drawn. */
export function elementIds(elements: readonly Record<string, unknown>[]): string[] {
  return elements.map((element) => element.id).filter((id): id is string => typeof id === "string");
}

/** The ids the app state reports as selected. */
function selectedIds(appState: Record<string, unknown>): Set<string> {
  const selected = appState.selectedElementIds;
  if (!selected || typeof selected !== "object") return new Set();
  return new Set(Object.entries(selected as Record<string, unknown>).filter(([, on]) => on === true).map(([id]) => id));
}

/**
 * The part of the scene the viewport shows, in canvas coordinates. Null when
 * the app state does not describe a viewport, which is the case before the
 * canvas has been laid out.
 */
function viewport(appState: Record<string, unknown>): { left: number; top: number; right: number; bottom: number } | null {
  const scrollX = num(appState.scrollX);
  const scrollY = num(appState.scrollY);
  const width = num(appState.width);
  const height = num(appState.height);
  const zoomValue = num((appState.zoom as { value?: unknown } | undefined)?.value) ?? 1;
  if (scrollX === null || scrollY === null || width === null || height === null || zoomValue <= 0) return null;
  const left = -scrollX;
  const top = -scrollY;
  return { left, top, right: left + width / zoomValue, bottom: top + height / zoomValue };
}

/** Whether an element's box overlaps a rectangle. A negative width is normalised, as in bounds.ts. */
function overlaps(element: Record<string, unknown>, rect: { left: number; top: number; right: number; bottom: number }): boolean {
  const x = num(element.x);
  const y = num(element.y);
  if (x === null || y === null) return false;
  const width = num(element.width) ?? 0;
  const height = num(element.height) ?? 0;
  const minX = Math.min(x, x + width);
  const maxX = Math.max(x, x + width);
  const minY = Math.min(y, y + height);
  const maxY = Math.max(y, y + height);
  return maxX >= rect.left && minX <= rect.right && maxY >= rect.top && minY <= rect.bottom;
}

/**
 * What a snapshot renders: the selection when there is one, otherwise what the
 * viewport shows, and the whole scene when the app state describes no viewport
 * yet. A container's bound label travels with it, so selecting a labelled box
 * does not render a box with the words missing.
 *
 * Deleted elements are dropped either way: the renderer would draw them.
 */
export function snapshotElements(elements: readonly Record<string, unknown>[], appState: Record<string, unknown>): Record<string, unknown>[] {
  const live = elements.filter((element) => element.isDeleted !== true);
  const selected = selectedIds(appState);
  if (selected.size) {
    return live.filter((element) => {
      const id = element.id;
      const container = element.containerId;
      return (typeof id === "string" && selected.has(id)) || (typeof container === "string" && selected.has(container));
    });
  }
  const rect = viewport(appState);
  if (!rect) return live;
  const visible = live.filter((element) => overlaps(element, rect));
  const shown = new Set(elementIds(visible));
  // A label whose container is on screen is on screen, even where its own box
  // rounds outside the viewport.
  return live.filter((element) => {
    const id = element.id;
    const container = element.containerId;
    return (typeof id === "string" && shown.has(id)) || (typeof container === "string" && shown.has(container));
  });
}

/**
 * The one line that travels with the image. The model is being told what it is
 * looking at and where the thing lives, so it can read the room with the
 * server's tools rather than guess from pixels.
 */
export function snapshotText(link: string | null, ids: readonly string[]): string {
  return `Snapshot of the Excalidraw room ${link ?? "(no link)"}; elements: ${ids.join(", ")}`;
}

/** Base64 of a blob's bytes, without a data: prefix. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // Chunked: a snapshot is hundreds of kilobytes and String.fromCharCode over
  // one spread of that length overflows the argument list.
  let binary = "";
  const CHUNK = 0x8000;
  for (let at = 0; at < bytes.length; at += CHUNK) binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  return btoa(binary);
}

/**
 * The browser clipboard as a writer, or null where there is none. Taken from a
 * scope rather than reaching for the globals directly, so the fallback path can
 * be exercised under Node.
 */
export interface ClipboardScope {
  navigator?: { clipboard?: { write(items: unknown[]): Promise<void> } };
  ClipboardItem?: new (parts: Record<string, Blob>) => unknown;
}

export function browserClipboard(scope: ClipboardScope = globalThis as ClipboardScope): ClipboardWriter | null {
  const clipboard = scope.navigator?.clipboard;
  const Item = scope.ClipboardItem;
  if (!clipboard || typeof clipboard.write !== "function" || typeof Item !== "function") return null;
  return async (blob: Blob) => {
    await clipboard.write([new Item({ [blob.type || PNG]: blob })]);
  };
}

/** The render, or the reason it failed. */
type Render = { blob: Blob; ids: string[] } | { failed: string };

async function render(env: SnapshotEnv, scene: SnapshotScene): Promise<Render> {
  const elements = snapshotElements(scene.elements, scene.appState);
  if (!elements.length) return { failed: "nothing on the canvas to render" };
  try {
    const blob = await env.exportToBlob({
      elements: elements as unknown as readonly never[],
      // exportScale is what exportToBlob reads for the pixel density; the
      // screen's own ratio keeps the snapshot as sharp as what the reader sees.
      appState: { ...scene.appState, exportScale: env.pixelRatio ?? 1 },
      files: scene.files,
      mimeType: PNG,
      exportPadding: EXPORT_PADDING,
    });
    return { blob, ids: elementIds(elements) };
  } catch (err) {
    return { failed: String(err) };
  }
}

/** Whether the host took the model-context update. A missing method is a refusal. */
async function offerToModel(app: SnapshotHost, content: ModelContextBlock[]): Promise<boolean> {
  if (typeof app.updateModelContext !== "function") return false;
  try {
    const result = (await app.updateModelContext({ content })) as HostAnswer | undefined;
    return result?.isError !== true;
  } catch {
    // A host without the request, or one that refuses image content, rejects
    // outright. Same answer as isError, same fallback.
    return false;
  }
}

/** Whether the PNG reached the clipboard. */
async function copyToClipboard(clipboard: ClipboardWriter | null | undefined, blob: Blob): Promise<boolean> {
  if (!clipboard) return false;
  try {
    await clipboard(blob);
    return true;
  } catch {
    // A sandboxed iframe without clipboard-write permission throws here. There
    // is nothing left to try, so the bar says so.
    return false;
  }
}

/**
 * Send a picture of what the reader is looking at to the model: one image block
 * and one line naming the room and the ids, through `ui/update-model-context`.
 *
 * The clipboard is the fallback, not an error path: a host that will not take
 * image content still lets the reader paste the PNG into the chat, and that is
 * what the hint tells them to do.
 */
export async function sendSnapshot(env: SnapshotEnv, scene: SnapshotScene): Promise<MenuOutcome> {
  const rendered = await render(env, scene);
  if ("failed" in rendered) return { outcome: "failed", hint: `snapshot failed: ${rendered.failed}`, ids: [] };
  const { blob, ids } = rendered;
  let data: string;
  try {
    data = await blobToBase64(blob);
  } catch (err) {
    return { outcome: "failed", hint: `snapshot failed: ${String(err)}`, ids };
  }
  const content: ModelContextBlock[] = [
    { type: "image", data, mimeType: PNG },
    { type: "text", text: snapshotText(scene.link, ids) },
  ];
  if (await offerToModel(env.app, content)) return { outcome: "sent", hint: SNAPSHOT_SENT_HINT, ids };
  if (await copyToClipboard(env.clipboard, blob)) return { outcome: "copied", hint: SNAPSHOT_CLIPBOARD_HINT, ids };
  return { outcome: "failed", hint: "snapshot could not be sent to Claude or copied: this host allows neither", ids };
}

/**
 * Hand the rendered image to the host to save. A sandboxed iframe cannot start
 * a download itself, so `ui/download-file` is the only route; a host without it
 * leaves the export dialog's own clipboard copy as the way out, which is what
 * the caller falls back to.
 */
export async function saveImage(env: SnapshotEnv, scene: SnapshotScene): Promise<MenuOutcome> {
  const rendered = await render(env, scene);
  if ("failed" in rendered) return { outcome: "failed", hint: `export failed: ${rendered.failed}`, ids: [] };
  const { blob, ids } = rendered;
  const app = env.app;
  if (typeof app.downloadFile !== "function") return { outcome: "failed", hint: "this host cannot save files", ids };
  try {
    const blobData = await blobToBase64(blob);
    const result = await app.downloadFile({
      contents: [{ type: "resource", resource: { uri: `file:///${EXPORT_FILE_NAME}`, mimeType: PNG, blob: blobData } }],
    });
    if (result?.isError === true) return { outcome: "failed", hint: "this host refused the download", ids };
    return { outcome: "saved", hint: `saved ${EXPORT_FILE_NAME}`, ids };
  } catch {
    return { outcome: "failed", hint: "this host cannot save files", ids };
  }
}

/**
 * Run a menu action after the current paint. The widget polls the room every
 * two seconds and repaints from the same thread; rendering a PNG on the click
 * itself would hold the menu open over a frame that never came. The default
 * schedule is a zero timeout, which is enough to get past the commit.
 */
export function afterPaint(run: () => void, schedule: (task: () => void) => void = (task) => void setTimeout(task, 0)): void {
  schedule(run);
}
