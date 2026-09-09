import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_RELATIVE_PATH, bundledAgentPath, installAgent, resolveAgentInstall } from "./install-agent.js";

const env = { HOME: "/home/someone" };

test("with no flags the agent installs under the current project", () => {
  const { target } = resolveAgentInstall([], env, "/work/project");
  assert.equal(target, path.join("/work/project", ".claude", "agents", "canvas-listener.md"));
});

test("--global installs under the home directory instead", () => {
  const { target } = resolveAgentInstall(["--global"], env, "/work/project");
  assert.equal(target, path.join("/home/someone", ".claude", "agents", "canvas-listener.md"));
});

test("the source is the agent file shipped in the package", () => {
  const { source } = resolveAgentInstall([], env, "/work/project");
  assert.equal(source, bundledAgentPath());
  assert.equal(AGENT_RELATIVE_PATH, path.join("agents", "canvas-listener.md"));
});

test("--force is off unless asked for, and reads the same with --global", () => {
  assert.equal(resolveAgentInstall([], env, "/work").force, false);
  assert.equal(resolveAgentInstall(["--force"], env, "/work").force, true);
  assert.equal(resolveAgentInstall(["--global", "--force"], env, "/work").force, true);
});

test("the bundled source exists in the built package", () => {
  assert.ok(existsSync(bundledAgentPath()), `${bundledAgentPath()} should ship with the package`);
});

test("installing copies the agent file to the resolved target", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "install-agent-"));
  const target = await installAgent([], env, cwd);
  assert.equal(target, path.join(cwd, ".claude", "agents", "canvas-listener.md"));
  assert.equal(readFileSync(target, "utf8"), readFileSync(bundledAgentPath(), "utf8"));
});

test("installing refuses to overwrite an existing file unless forced", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "install-agent-"));
  await installAgent([], env, cwd);
  await assert.rejects(() => installAgent([], env, cwd), /--force/);
  const target = await installAgent(["--force"], env, cwd);
  assert.equal(readFileSync(target, "utf8"), readFileSync(bundledAgentPath(), "utf8"));
});
