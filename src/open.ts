/**
 * The `open_room` tool: hand the room to a person by opening its link in the
 * default browser. The in-chat view depends on the host - which may cache the
 * view HTML across versions, and may route the view's tool calls to a second
 * server process - whereas excalidraw.com is the room's real surface, so this
 * is the reliable way for someone to watch the canvas live.
 *
 * The launch is deliberately fire-and-forget: a detached child with stdio
 * ignored, unreferenced so it never holds the event loop open, and never given
 * a pipe to stdout, which is the MCP transport. Nothing here waits for the
 * browser, so a slow launch cannot stall the server.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { ensureJoined, NOT_IN_ROOM_TEXT, type ShowRoomClient } from "./view.js";

/** The command that opens a URL in the platform's default browser. */
export interface BrowserCommand {
  command: string;
  args: string[];
}

/**
 * Pick the opener for a platform. `process.platform` values, with anything
 * else treated as a freedesktop system, which is what the BSDs are.
 *
 * The Windows form is `cmd /c start "" <url>`: `start` is a shell builtin, not
 * an executable, and its first quoted argument is the window title, so the
 * empty string keeps a quoted URL from being read as one.
 */
export function browserOpenCommand(platform: string, url: string): BrowserCommand {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

/** The environment variable that suppresses the launch. */
export const NO_OPEN_ENV = "EXCALIDRAW_ROOM_NO_OPEN";

/**
 * Whether to skip launching a browser. Set `EXCALIDRAW_ROOM_NO_OPEN=1` in
 * tests, CI, and anywhere a headless process must not spawn a window; the tool
 * still returns the link. `0` and the empty string mean "do open", so the
 * variable can be turned off without being unset.
 */
export function browserLaunchSuppressed(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[NO_OPEN_ENV];
  return value !== undefined && value !== "" && value !== "0";
}

/** The `spawn` shape this module uses; the real one satisfies it. */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: "ignore" },
) => { unref?: () => void; on?: (event: string, listener: (err: Error) => void) => unknown };

/** What {@link launchBrowser} attempted. */
export interface LaunchResult {
  launched: boolean;
  command: BrowserCommand | null;
  error: string | null;
}

/**
 * Start the platform opener on a URL and return immediately. A spawn failure
 * is reported rather than thrown: the link is in the result either way, so the
 * person can open it by hand.
 */
export function launchBrowser(
  url: string,
  deps: { platform?: string; spawn?: SpawnLike } = {},
): LaunchResult {
  const command = browserOpenCommand(deps.platform ?? process.platform, url);
  const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnLike);
  try {
    const child = spawn(command.command, command.args, { detached: true, stdio: "ignore" });
    // An exec failure surfaces asynchronously as an 'error' event, which is
    // unhandled-throws on a ChildProcess. Swallow it onto the debug channel.
    child.on?.("error", (err: Error) => {
      if (process.env.EXCALIDRAW_ROOM_DEBUG) console.error("[open_room] browser launch failed:", err.message);
    });
    child.unref?.();
    return { launched: true, command, error: null };
  } catch (err) {
    return { launched: false, command, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The result text and error flag `open_room` returns. */
export interface OpenRoomResult {
  text: string;
  isError: boolean;
}

/** The seams {@link openRoom} is tested through. */
export interface OpenRoomDeps {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  spawn?: SpawnLike;
}

/**
 * Open the current room - or the one a link names, joining it first - in the
 * default browser, and report the link with the room's state.
 *
 * With no link and no room this is the same refusal `show_room` gives, so a
 * host that shows the text verbatim tells the reader what to call next.
 */
export async function openRoom(
  room: ShowRoomClient,
  link: string | undefined,
  deps: OpenRoomDeps = {},
): Promise<OpenRoomResult> {
  const { error } = await ensureJoined(room, link);
  const status = room.status();
  if (!room.isConnected || !status.link) {
    return { text: error ? `${NOT_IN_ROOM_TEXT}\n${error}` : NOT_IN_ROOM_TEXT, isError: true };
  }

  const suppressed = browserLaunchSuppressed(deps.env ?? process.env);
  const launch = suppressed ? null : launchBrowser(status.link, deps);
  const lines = [
    `room: ${status.link}`,
    `connected: ${status.connected}`,
    `peers: ${status.peers.length}`,
    `elements: ${status.elementCount}`,
  ];
  if (suppressed) lines.push(`browser not opened: ${NO_OPEN_ENV} is set. Open the link above yourself.`);
  else if (launch?.launched) lines.push("Opened in the default browser.");
  else lines.push(`browser not opened: ${launch?.error ?? "unknown error"}. Open the link above yourself.`);
  return { text: lines.join("\n"), isError: false };
}
