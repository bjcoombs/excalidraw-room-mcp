// Builds the in-chat canvas into one self-contained file, dist/view/canvas.html,
// which src/view.ts serves as the MCP Apps resource. Everything (Excalidraw, React,
// CSS, fonts the bundle inlines) has to live inside that one file: the host renders
// it in a sandboxed iframe with no network access back to us.
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const here = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: here,
  plugins: [react(), viteSingleFile()],
  define: {
    // Excalidraw reads process.env.IS_PREACT; nothing else in the bundle needs a shim.
    "process.env.IS_PREACT": JSON.stringify("false"),
  },
  build: {
    outDir: "../dist/view",
    // dist also holds the compiled server (dist/*.js). Wiping it here would delete it.
    emptyOutDir: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    chunkSizeWarningLimit: 20000,
    rollupOptions: {
      // The html entry names the output file: canvas.html, which src/view.ts serves.
      input: `${here}/canvas.html`,
      output: { entryFileNames: "canvas.js", assetFileNames: "canvas[extname]" },
    },
  },
});
