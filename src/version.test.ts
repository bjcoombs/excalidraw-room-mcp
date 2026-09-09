import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "./version.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(here, "..", "package.json"), "utf8")) as { version: string };

test("PACKAGE_VERSION matches package.json", () => {
  assert.equal(PACKAGE_VERSION, pkg.version);
  assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+/);
});
