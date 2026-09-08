// Enforces the contracts documented in CLAUDE.md. Each rule below stands in for a
// paragraph of prose that a contributor (human or agent) would otherwise have to
// read and remember.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "node_modules/", "coverage/", "reports/", ".stryker-tmp/"],
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      // Functions past this point are hard to reason about and hard to test.
      complexity: ["error", { max: 15 }],
      // stdout is the MCP stdio transport: console.log corrupts the protocol
      // stream. Diagnostics go to stderr, gated by EXCALIDRAW_ROOM_DEBUG.
      "no-console": ["error", { allow: ["error"] }],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@excalidraw/excalidraw",
              message:
                "The upstream package assumes a DOM and cannot run in Node. Port the function instead, citing the upstream source. See CLAUDE.md.",
            },
          ],
        },
      ],
    },
  },
  {
    // src/elements.ts is the complexity hotspot that issue #4 is pinning with
    // characterization tests before anyone refactors it. This ceiling is the
    // file's current worst unfenced function; lower it as #4 lands.
    // https://github.com/bjcoombs/excalidraw-room-mcp/issues/4
    files: ["src/elements.ts"],
    rules: {
      complexity: ["error", { max: 24 }],
    },
  },
  {
    // The view is browser code, built separately by Vite: the DOM the Node
    // rules guard against is exactly what it runs in. @excalidraw/excalidraw
    // renders the canvas there, and console is a browser console, not the MCP
    // transport. Every other rule still applies, and src/ keeps both bans.
    files: ["view/**/*.ts", "view/**/*.tsx"],
    languageOptions: {
      parser: tseslint.parser,
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      complexity: ["error", { max: 15 }],
      "no-console": "off",
      "no-restricted-imports": "off",
    },
  },
  {
    // The manual e2e driver is a CLI, not the MCP server: its stdout is a human
    // transcript, so console.log is the correct output channel there.
    files: ["src/e2e.ts"],
    rules: {
      "no-console": "off",
    },
  },
);
