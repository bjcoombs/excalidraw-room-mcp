/**
 * The package version, read from package.json at startup so serverInfo.version
 * in the MCP handshake always matches what was published. Resolved relative to
 * this module, which lives in dist/, so ../package.json is the repo (or
 * installed package) root.
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: unknown };

export const PACKAGE_VERSION: string = typeof pkg.version === "string" ? pkg.version : "0.0.0";
