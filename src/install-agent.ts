/**
 * `excalidraw-room-mcp install-agent`: copy the bundled canvas-listener
 * subagent out of the package and into a Claude Code agents directory, so the
 * listener arrives with the server it was written against instead of being
 * fetched from a moving branch.
 *
 * This is a CLI mode, not the MCP server, so stdout here is a human transcript
 * and `console.log` is the right channel (eslint lifts the ban for this file
 * only). Path resolution is a pure function so it can be tested without a
 * filesystem.
 */
import { copyFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Where the agent file sits inside the package and the repository. */
export const AGENT_RELATIVE_PATH = path.join("agents", "canvas-listener.md");
/** Directory a Claude Code project or user keeps subagents in. */
export const AGENTS_DIR = path.join(".claude", "agents");

export interface AgentInstall {
  /** The agent file shipped in the package. */
  source: string;
  /** Where it is being copied to. */
  target: string;
  /** Whether an existing file at the target may be replaced. */
  force: boolean;
}

/**
 * The packaged agent file, resolved relative to the compiled `dist/`, so an
 * `npx` install reads the copy that came with the installed server version.
 */
export function bundledAgentPath(): string {
  return fileURLToPath(new URL("../agents/canvas-listener.md", import.meta.url));
}

/**
 * Decide where the agent file comes from and where it goes. `--global` targets
 * the user's home directory (every project); otherwise the target is the
 * project rooted at `cwd`.
 */
export function resolveAgentInstall(argv: string[], env: NodeJS.ProcessEnv, cwd: string): AgentInstall {
  const global = argv.includes("--global") || argv.includes("-g");
  const root = global ? (env.HOME ?? homedir()) : cwd;
  return {
    source: bundledAgentPath(),
    target: path.join(root, AGENTS_DIR, "canvas-listener.md"),
    force: argv.includes("--force") || argv.includes("-f"),
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy the packaged agent file into place, creating the agents directory if it
 * is missing. Rejects rather than overwriting an existing file unless forced.
 * Returns the target path.
 */
export async function installAgent(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<string> {
  const { source, target, force } = resolveAgentInstall(argv, env, cwd);
  if (!force && (await exists(target))) {
    throw new Error(`${target} already exists. Pass --force to replace it.`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  return target;
}

/**
 * The `install-agent` subcommand: install the file and report where it went.
 * Returns the process exit code.
 */
export async function runInstallAgentCli(argv: string[]): Promise<number> {
  try {
    const target = await installAgent(argv);
    console.log(`Installed canvas-listener subagent to ${target}`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
