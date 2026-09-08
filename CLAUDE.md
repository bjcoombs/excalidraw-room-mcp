# excalidraw-room-mcp

MCP server (stdio) that joins an excalidraw.com live-collaboration room as a headless peer. Node 22, TypeScript, ESM. README.md is the product description; this file is what an agent needs that the code does not say.

## Commands

```bash
npm test            # tsc build, then node --test over dist/*.test.js
npm run test:coverage   # same, plus lcov at coverage/lcov.info
npm run mutate      # stryker over crypto/reconcile/elements (slow, minutes)
npm run e2e -- "<collab link>" [seconds]   # manual: joins a real room, needs a browser peer
EXCALIDRAW_ROOM_DEBUG=1 node dist/index.js  # run the server with diagnostics on stderr
```

## Layout

- `src/room.ts` socket + scene state + `waitForMention`; `src/crypto.ts` AES-GCM; `src/reconcile.ts` merge rule; `src/elements.ts` builders + summariser; `src/mentions.ts` `@claude` detection and neighbourhood; `src/firebase.ts` persistence; `src/index.ts` MCP tool surface; `src/e2e.ts` manual driver.
- Tests live beside the source as `*.test.ts` and run from `dist/`, so a test needs a build first. `npm test` does that.
- Protocol facts (events, payload shapes, where they came from upstream) are in the header comment of `src/room.ts`. Read it before touching the socket code.

## Runtime corrections (things training will get wrong here)

- **stdout is the MCP transport.** Never `console.log` in server code; use `console.error`, gated by `EXCALIDRAW_ROOM_DEBUG`.
- **The public relay needs `Origin: https://excalidraw.com`.** Without it the handshake fails (400 websocket, 403 polling). Keep the `extraHeaders` in `RoomClient.join`.
- **Do not import `@excalidraw/excalidraw` in Node.** It assumes a DOM. The crypto and reconcile logic here are ports of the upstream functions; change them only alongside the upstream source they cite.
- **Peers broadcast every keystroke.** A text element arrives as a stream of version bumps while someone types. Anything that reacts to text content must wait for it to settle (`waitForMention` does, 1.5s); acting on the first "@claude" would fire before the instruction exists.
- **Handled mentions are keyed by (id, version)**, held in memory in `src/index.ts` and reset on join. Acknowledging bumps the version, so record the post-bump version or the acknowledgement itself reads as a new mention.
- **Every local mutation must bump `version` and refresh `versionNonce`** (use `bump()` in `src/elements.ts`), or peers discard the change.
- **Firestore writes are conditional** on the document update time. Keep `persist()`'s reload-reconcile-retry; an unconditional PATCH silently drops a peer's edit.
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
