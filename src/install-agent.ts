/**
 * `excalidraw-room-mcp install-agent`: copy the bundled subagents out of the
 * package and into a Claude Code agents directory, so they arrive with the
 * server they were written against instead of being fetched from a moving
 * branch.
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

/**
 * Every agent the package ships, in the order they are installed and reported.
 * The listener owns the wait loop; the answerer is what it spawns for a
 * knowledge question.
 */
export const BUNDLED_AGENTS = ["canvas-listener", "canvas-answerer"] as const;
/** Where the agent files sit inside the package and the repository. */
export const AGENT_RELATIVE_PATHS = BUNDLED_AGENTS.map((name) => path.join("agents", `${name}.md`));
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
 * The packaged agent files, resolved relative to the compiled `dist/`, so an
 * `npx` install reads the copies that came with the installed server version.
 */
export function bundledAgentPaths(): string[] {
  return BUNDLED_AGENTS.map((name) => fileURLToPath(new URL(`../agents/${name}.md`, import.meta.url)));
}

/**
 * Decide where each agent file comes from and where it goes. `--global`
 * targets the user's home directory (every project); otherwise the target is
 * the project rooted at `cwd`.
 */
export function resolveAgentInstalls(argv: string[], env: NodeJS.ProcessEnv, cwd: string): AgentInstall[] {
  const global = argv.includes("--global") || argv.includes("-g");
  const root = global ? (env.HOME ?? homedir()) : cwd;
  const force = argv.includes("--force") || argv.includes("-f");
  return BUNDLED_AGENTS.map((name, i) => ({
    source: bundledAgentPaths()[i],
    target: path.join(root, AGENTS_DIR, `${name}.md`),
    force,
  }));
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
 * Copy every packaged agent file into place, creating the agents directory if
 * it is missing. Rejects rather than overwriting existing files unless forced,
 * and checks all of them before copying any, so a refusal leaves the agents
 * directory as it found it rather than half updated. Returns the target paths.
 */
export async function installAgents(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<string[]> {
  const installs = resolveAgentInstalls(argv, env, cwd);
  const blocked: string[] = [];
  for (const { target, force } of installs) {
    if (!force && (await exists(target))) blocked.push(target);
  }
  if (blocked.length) {
    throw new Error(`${blocked.join(", ")} already exists. Pass --force to replace it.`);
  }
  for (const { source, target } of installs) {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  return installs.map((i) => i.target);
}

/**
 * The `install-agent` subcommand: install the files and report where each one
 * went, one line per destination. Returns the process exit code.
 */
export async function runInstallAgentCli(argv: string[]): Promise<number> {
  try {
    const targets = await installAgents(argv);
    for (const [i, target] of targets.entries()) {
      console.log(`Installed ${BUNDLED_AGENTS[i]} subagent to ${target}`);
    }
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}
