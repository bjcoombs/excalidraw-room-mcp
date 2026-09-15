import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_RELATIVE_PATHS,
  BUNDLED_AGENTS,
  bundledAgentPaths,
  installAgents,
  resolveAgentInstalls,
} from "./install-agent.js";

const env = { HOME: "/home/someone" };

/** Both bundled agents, in the order they are installed and reported. */
const names = ["canvas-listener.md", "canvas-answerer.md"];

test("every bundled agent is installed, under the current project by default", () => {
  const targets = resolveAgentInstalls([], env, "/work/project").map((i) => i.target);
  assert.deepEqual(
    targets,
    names.map((n) => path.join("/work/project", ".claude", "agents", n)),
  );
});

test("--global installs every bundled agent under the home directory instead", () => {
  const targets = resolveAgentInstalls(["--global"], env, "/work/project").map((i) => i.target);
  assert.deepEqual(
    targets,
    names.map((n) => path.join("/home/someone", ".claude", "agents", n)),
  );
});

test("the sources are the agent files shipped in the package", () => {
  const sources = resolveAgentInstalls([], env, "/work/project").map((i) => i.source);
  assert.deepEqual(sources, bundledAgentPaths());
  assert.deepEqual(BUNDLED_AGENTS.slice(), ["canvas-listener", "canvas-answerer"]);
  assert.deepEqual(
    AGENT_RELATIVE_PATHS,
    names.map((n) => path.join("agents", n)),
  );
});

test("--force is off unless asked for, and reads the same with --global, for each agent", () => {
  assert.deepEqual(resolveAgentInstalls([], env, "/work").map((i) => i.force), [false, false]);
  assert.deepEqual(resolveAgentInstalls(["--force"], env, "/work").map((i) => i.force), [true, true]);
  assert.deepEqual(resolveAgentInstalls(["--global", "--force"], env, "/work").map((i) => i.force), [true, true]);
});

test("every bundled source exists in the built package", () => {
  for (const source of bundledAgentPaths()) {
    assert.ok(existsSync(source), `${source} should ship with the package`);
  }
});

test("installing copies every agent file to its resolved target", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "install-agent-"));
  const targets = await installAgents([], env, cwd);
  assert.deepEqual(
    targets,
    names.map((n) => path.join(cwd, ".claude", "agents", n)),
  );
  for (const [i, target] of targets.entries()) {
    assert.equal(readFileSync(target, "utf8"), readFileSync(bundledAgentPaths()[i], "utf8"));
  }
});

test("installing refuses to overwrite an existing file unless forced", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "install-agent-"));
  await installAgents([], env, cwd);
  await assert.rejects(() => installAgents([], env, cwd), /--force/);
  const targets = await installAgents(["--force"], env, cwd);
  for (const [i, target] of targets.entries()) {
    assert.equal(readFileSync(target, "utf8"), readFileSync(bundledAgentPaths()[i], "utf8"));
  }
});

test("one agent already in place blocks the whole install, naming it, and copies nothing", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "install-agent-"));
  const [listener, answerer] = names.map((n) => path.join(cwd, ".claude", "agents", n));
  // Install both, then remove the second so only the first is in the way.
  await installAgents([], env, cwd);
  const { rm } = await import("node:fs/promises");
  await rm(answerer);
  await assert.rejects(() => installAgents([], env, cwd), (err: Error) => {
    assert.match(err.message, /canvas-listener\.md/);
    assert.doesNotMatch(err.message, /canvas-answerer\.md/);
    return true;
  });
  assert.ok(existsSync(listener));
  assert.equal(existsSync(answerer), false, "a refused install leaves nothing half-copied");
});
