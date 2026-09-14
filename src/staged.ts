/**
 * Progressive disclosure of the tool list. Before a room is joined, only the
 * four tools that can do anything without one are worth listing: every scene
 * and mention tool answers "not in a room; call room_join or room_create
 * first", yet all of them sit in the model's context on every turn. Staging
 * withholds them until a join and hands them back on `room_leave`.
 *
 * Off unless EXCALIDRAW_ROOM_STAGED_TOOLS is set, because whether Claude
 * Desktop and Claude Code re-fetch `tools/list` when they are told the list
 * changed is unverified: a host that ignores the notification would be left
 * with the pre-join four for the rest of the session.
 * https://github.com/bjcoombs/excalidraw-room-mcp/issues/109
 */

/** The variable that turns staging on. */
export const STAGED_TOOLS_ENV = "EXCALIDRAW_ROOM_STAGED_TOOLS";

/**
 * The tools a staged server lists before a room is joined. Everything else is
 * gated: `room_leave` and `room_open` need a room, and so does every `scene_`
 * and `mention_` tool.
 */
export const PRE_JOIN_TOOLS: readonly string[] = ["room_create", "room_join", "room_status", "room_help"];

/**
 * Whether the tool list is staged. `0` and the empty string mean "do not
 * stage", so the variable can be turned off without being unset - the reading
 * `EXCALIDRAW_ROOM_NO_OPEN` already uses.
 */
export function stagedToolsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[STAGED_TOOLS_ENV];
  return value !== undefined && value !== "" && value !== "0";
}

/**
 * What staging needs of a registered tool. `server.registerTool` and
 * `registerAppTool` both return an SDK `RegisteredTool`, which satisfies this;
 * each call sends `notifications/tools/list_changed` once the server is
 * connected, and sends nothing before that.
 */
export type ToolHandle = { enable(): void; disable(): void };

/**
 * The gated tools and whether they are listed. Every transition is a change of
 * state, so a second `room_join` inside a room and a `room_leave` outside one
 * cost nothing and notify nobody.
 */
export class ToolStage {
  private readonly gated: readonly ToolHandle[];
  private readonly staged: boolean;
  private revealed = true;

  /**
   * `gated` is the tools withheld before a join - the SDK registers every tool
   * enabled, which is the unstaged list and the starting point `withhold`
   * moves away from.
   */
  constructor(gated: Iterable<ToolHandle>, staged: boolean) {
    this.gated = [...gated];
    this.staged = staged;
  }

  /** Whether the gated tools are in `tools/list` now. */
  get isRevealed(): boolean {
    return this.revealed;
  }

  /**
   * Withhold the gated tools: once at start-up before the transport is
   * connected, and again on `room_leave`. Returns whether anything changed.
   */
  withhold(): boolean {
    return this.toggle(false);
  }

  /** List the gated tools, after a successful create or join. */
  reveal(): boolean {
    return this.toggle(true);
  }

  private toggle(revealed: boolean): boolean {
    if (!this.staged || revealed === this.revealed) return false;
    this.revealed = revealed;
    // One notification per tool: `enable`/`disable` is the SDK's only public
    // way to change a registered tool, and each sends its own. A host refetches
    // the same list either way.
    for (const tool of this.gated) {
      if (revealed) tool.enable();
      else tool.disable();
    }
    return true;
  }
}
