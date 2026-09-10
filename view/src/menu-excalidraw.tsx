/**
 * The menu, bound to the real Excalidraw component.
 *
 * Everything Node can run is in menu.tsx (what the menu lists) and snapshot.ts
 * (what the items do). This file is the part that cannot: it imports
 * @excalidraw/excalidraw for `MainMenu`, its default items and `exportToBlob`,
 * and reads the live canvas through the imperative API. Keep it thin - it is
 * covered by the operator check in the acceptance contract and by the dev
 * harness, not by a unit test.
 *
 * The imperative API is read inside a handler, never during a render: the
 * instance is handed over before Excalidraw has mounted, and app.tsx explains
 * at length what calling it early costs.
 */
import { CaptureUpdateAction, exportToBlob, MainMenu } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { RoomMenuItems, type MenuParts } from "./menu.js";
import { afterPaint, browserClipboard, saveImage, sendSnapshot, type SnapshotEnv, type SnapshotHost, type SnapshotScene } from "./snapshot.js";

/** Excalidraw's menu pieces, in the shape menu.tsx declares them. */
const PARTS: MenuParts = {
  Item: MainMenu.Item,
  Search: MainMenu.DefaultItems.SearchMenu,
  Help: MainMenu.DefaultItems.Help,
};

export interface RoomMenuProps {
  /** The host, for update-model-context and download-file. */
  app: SnapshotHost;
  /** The canvas, or null before Excalidraw has handed it over. */
  api: () => ExcalidrawImperativeAPI | null;
  /** The room, as the last update named it. */
  link: string | null;
  /** Where an action's one-line result goes: the status bar. */
  onHint: (hint: string) => void;
  /** The status bar's own control, reused so both routes behave the same. */
  onOpen: () => void;
}

/**
 * The widget's main menu. Rendered as a child of `<Excalidraw>`, which is how
 * the package takes a replacement menu.
 */
export function RoomMenu({ app, api, link, onHint, onOpen }: RoomMenuProps) {
  const env = (): SnapshotEnv => ({
    app,
    exportToBlob,
    clipboard: browserClipboard(),
    pixelRatio: window.devicePixelRatio || 1,
  });

  /** What the canvas holds now, or null while it is still coming up. */
  const scene = (): SnapshotScene | null => {
    const instance = api();
    if (!instance) return null;
    return { elements: instance.getSceneElements(), appState: instance.getAppState(), files: instance.getFiles(), link };
  };

  /** Excalidraw's own image export dialog, whose clipboard copy works in the sandbox. */
  const openExportDialog = () => {
    const instance = api();
    if (!instance) return;
    instance.updateScene({ appState: { openDialog: { name: "imageExport" } }, captureUpdate: CaptureUpdateAction.NEVER });
  };

  /** Run an action off the click, on a scene the canvas has actually handed over. */
  const act = (run: (scene: SnapshotScene) => void) =>
    afterPaint(() => {
      const current = scene();
      if (!current) {
        onHint("the canvas is not ready yet");
        return;
      }
      run(current);
    });

  const onSnapshot = () => act((current) => void sendSnapshot(env(), current).then((result) => onHint(result.hint)));

  const onExport = () =>
    act(
      (current) =>
        void saveImage(env(), current).then((result) => {
          if (result.outcome === "saved") {
            onHint(result.hint);
            return;
          }
          // The dialog is the fallback rather than the front door: its own PNG
          // and SVG buttons download through the browser, which a sandboxed
          // iframe blocks, but its Copy to clipboard needs nothing from the host.
          openExportDialog();
          onHint(`${result.hint} - use Copy to clipboard in the dialog`);
        }),
    );

  return (
    <MainMenu>
      <RoomMenuItems parts={PARTS} onSnapshot={onSnapshot} onExport={onExport} onOpen={onOpen} />
    </MainMenu>
  );
}
