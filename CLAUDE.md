# excalidraw-room-mcp

MCP server (stdio) that joins an excalidraw.com live-collaboration room as a headless peer. Node 22, TypeScript, ESM. README.md is the product description; this file is what an agent needs that the code does not say.

## Commands

```bash
npm run lint        # eslint flat config: the CLAUDE.md contracts, enforced
npm test            # tsc build, then node --test over dist/*.test.js
npm run test:coverage   # same, plus lcov at coverage/lcov.info
npm run mutate      # stryker over crypto/reconcile/elements (builds first, ~2 min; weekly in CI)
npm run e2e -- "<collab link>" [seconds]   # manual: joins a real room, needs a browser peer
npm run e2e:show-room -- "<collab link>"   # manual: joins, prints the show_room payload, exits
npm run build:view  # just the in-chat view: view/ -> dist/view/canvas.html
npm run check:bundle   # packs a throwaway .mcpb and asserts its contents (needs network for npx mcpb)
EXCALIDRAW_ROOM_DEBUG=1 node dist/index.js  # run the server with diagnostics on stderr
node dist/index.js install-agent [--global] [--force]  # CLI mode: copy agents/canvas-listener.md into .claude/agents/
```

## Layout

- `view/` is a separate Vite build (React + `@excalidraw/excalidraw`) producing the single file `dist/view/canvas.html`, the MCP Apps resource the chat host renders. Its dependencies live in the root `package.json`; there is no nested lockfile. `src/view.ts` builds the `show_room` payload and serves that file.
- `view/dev/harness.html` + `harness.tsx` drive the view without a host: `npx vite --config view/vite.config.ts`, then open `/dev/harness.html`. `window.harness` swaps the payload the fake `callServerTool` returns and fingerprints the canvas pixels, which is how the repaint and fit-to-content paths are checked outside Claude Desktop. `vite.config.ts` names `canvas.html` as the only build input, so none of it reaches the bundle.
- `.mcpbignore` patterns are gitignore-style, so a pattern naming a directory that also exists under `dist/` must be anchored with a leading slash. `/view/` excludes the Vite sources; unanchored `view/` excluded `dist/view/canvas.html` too and shipped a bundle whose `show_room` resource 404s. `npm run check:bundle` (`scripts/check-bundle.sh`) is the guard, and the release workflow runs it on the artifact it is about to attach.
- `src/instructions.ts` holds the `instructions` string sent at initialize and the listen tip appended to `create_room` and `join_room`. `agents/canvas-listener.md` is the Sonnet subagent that runs the listen loop; it is documented in README under Collaborating.
- `src/room.ts` socket + scene state + `waitForMention`; `src/crypto.ts` AES-GCM; `src/reconcile.ts` merge rule; `src/elements.ts` builders + summariser; `src/mentions.ts` `@claude` detection and neighbourhood; `src/firebase.ts` persistence; `src/index.ts` MCP tool surface; `src/e2e.ts` manual driver.
- Tests live beside the source as `*.test.ts` and run from `dist/`, so a test needs a build first. `npm test` does that.
- Protocol facts (events, payload shapes, where they came from upstream) are in the header comment of `src/room.ts`. Read it before touching the socket code.

## Runtime corrections (things training will get wrong here)

- **stdout is the MCP transport.** Never `console.log` in server code; use `console.error`, gated by `EXCALIDRAW_ROOM_DEBUG`.
- **The public relay needs `Origin: https://excalidraw.com`.** Without it the handshake fails (400 websocket, 403 polling). Keep the `extraHeaders` in `RoomClient.join`.
- **Never call the Excalidraw imperative API from a render.** `excalidrawAPI` hands the instance over during Excalidraw's own render, before its component mounts, and `updateScene` on an unmounted Excalidraw is a silent no-op - React logs "can't call setState on a component that is not yet mounted" and nothing is drawn. `view/src/app.tsx` records the instance in the callback and draws from an effect, which runs after the child has mounted. This is what made the chat widget a still frame in issue #30.
- **Do not import `@excalidraw/excalidraw` in Node.** It assumes a DOM. `view/` is the exception: that code runs in the host's iframe, and eslint lifts the ban there only. The crypto and reconcile logic here are ports of the upstream functions; change them only alongside the upstream source they cite.
- **Peers broadcast every keystroke.** A text element arrives as a stream of version bumps while someone types. Anything that reacts to text content must wait for it to settle (`waitForMention` does, 1.5s); acting on the first "@claude" would fire before the instruction exists.
- **Handled mentions are keyed by (id, version)**, held in memory in `src/index.ts` and reset on join. Acknowledging bumps the version, so record the post-bump version or the acknowledgement itself reads as a new mention.
- **Every local mutation must bump `version` and refresh `versionNonce`** (use `bump()` in `src/elements.ts`), or peers discard the change.
- **Firestore writes are conditional** on the document update time. Keep `persist()`'s reload-reconcile-retry; an unconditional PATCH silently drops a peer's edit.
- **The Firebase project id and API key in `src/firebase.ts` are not a leaked secret.** They are excalidraw.com's public web client configuration, copied from upstream `.env.production`; a Firebase web API key identifies the project and grants nothing, and the scene is ciphertext without the room key. Override them with `EXCALIDRAW_FIREBASE_PROJECT` and `EXCALIDRAW_FIREBASE_API_KEY` rather than editing or removing the defaults.
- **ESM imports need the `.js` suffix** even in `.ts` files (`moduleResolution: NodeNext`).
- **Element ids are immutable and unique.** `add_elements` rejects known or repeated ids; `update_elements` preserves the id.

## Testing boundaries

- Unit tests cover crypto, reconcile, elements, the Firestore load/save paths (fetch stubbed), and the link-parsing and pre-join paths of `room.ts`. The socket, broadcast and persist paths of `room.ts`, and all of `index.ts`, are exercised only by the manual e2e driver against a live room. If you change those, run the e2e with a browser open on the link and check both directions (server writes appear on the canvas; a pencil stroke appears in `read_scene`).
- `src/interop.test.ts` decrypts a scene excalidraw.com wrote (`tests/fixtures/`). If upstream changes its element shape, it fails there first; update the `allowed` field list in that test only after checking the upstream source.
- Text metrics are approximations (`measureText`). Tests assert containment, not exact pixels.

## Project management

- Work is tracked in GitHub Issues on this repo, through the `gh` CLI.
- Define new features and bugs as issues before starting them; reference the issue by full URL in the PR.
- Labels: `agent-ready` means an agent can pick it up unaided; `needs-triage` means open questions remain; `in-progress` while an agent is on it.

## Git

- Work in a worktree off `main`; the `excalidraw-room-mcp-main` checkout stays clean.
- Conventional commit subjects (`feat:`, `fix:`, `docs:`, `chore:`). No AI attribution or session links in commits or PRs.
