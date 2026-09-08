# excalidraw-room-mcp

An MCP server that joins a live [Excalidraw](https://excalidraw.com) collaboration room as a headless participant, so an AI agent can read what you draw and draw back, in the same canvas, in real time.

You draw on excalidraw.com as normal. The agent sees your boxes, arrows, text and freehand strokes, and its edits appear on your screen as it makes them. No credits, no export step, no browser automation.

## Why

The official [excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp) renders a drawing inside the chat window. That is one-way: the agent draws, you look. This server is the other direction. It attaches to a drawing you already have open and keeps both sides in sync.

It works because Excalidraw's collaboration protocol is open. The relay server ([excalidraw-room](https://github.com/excalidraw/excalidraw-room)) forwards encrypted blobs between participants and never sees plaintext. The collaboration link carries the room id and the AES key, so anyone holding the link can join, decrypt, and take part. This server does exactly that.

## Install

Requires Node 22 or newer.

```bash
git clone https://github.com/bjcoombs/excalidraw-room-mcp.git
cd excalidraw-room-mcp
npm install
npm run build
```

Register with Claude Code:

```bash
claude mcp add excalidraw-room -- node /absolute/path/to/excalidraw-room-mcp/dist/index.js
```

Or with any other MCP client that speaks stdio, using the same command.

## Use

1. On excalidraw.com, click **Live collaboration**, then **Start session**, and copy the link. It looks like `https://excalidraw.com/#room=<id>,<key>`.
2. Ask the agent to join it: "join this excalidraw room: <link>".
3. Draw. Ask the agent what it sees, or ask it to add things.

Or the other way round: ask the agent to create a room, and open the link it gives you.

### See the canvas in the chat

In a host that supports MCP Apps (Claude Desktop, claude.ai), joining or creating a room renders the drawing in the chat window. The view refreshes every two seconds while it is on screen, so a shape someone draws on excalidraw.com turns up in the chat without another prompt; it stops asking when the window is hidden. Pending `@claude` mentions are outlined on the canvas and listed in a strip beside it, and clear from both when the agent acknowledges them. Ask for `show_room` to bring the view back at any point.

The view is read-only: it never writes to the room. Editing happens on excalidraw.com, and the header carries an **Open on excalidraw.com** link to the room. Hosts without MCP Apps support get the same text results as before.

### Talk to it on the canvas

Type a text element containing `@claude` next to the thing you mean, for example `@claude add a cache between these`. The agent calls `wait_for_mention`, which blocks until such a text appears and has stopped changing, then returns the instruction together with the elements around it. When it has acted, `acknowledge_mention` turns the text grey and appends a check mark (or a short note, such as why it declined), so you can see on the canvas what has been dealt with. Edit the text again and it becomes pending again.

A loop that keeps an agent listening is just: `wait_for_mention` (up to 10 minutes per call), act, `acknowledge_mention`, repeat.

## Tools

| Tool | What it does |
|---|---|
| `create_room` | Make a new empty room, join it, return the link to open. |
| `join_room` | Join a room from its link. Loads the scene from a peer, or from the persisted copy if nobody else is there. |
| `show_room` | The room as JSON (link, connection state, peers, elements, pending mentions) and, in a host that supports MCP Apps, the canvas rendered in the chat. |
| `room_status` | Connection state, peers, element counts. |
| `read_scene` | The drawing as one line per element (default), or the full element JSON. Freehand strokes come back as a sampled path so a scribble is legible. |
| `add_elements` | Add shapes, text, arrows, lines and freehand strokes from compact specs. Arrows bind to element ids; edge points are computed. |
| `add_raw_elements` | Add complete Excalidraw elements verbatim, for example from an `.excalidraw` file. |
| `update_elements` | Patch elements by id. Versions are bumped so peers accept the change. |
| `delete_elements` | Soft-delete by id. |
| `wait_for_mention` | Block until a text element containing the tag (default `@claude`) appears and settles; return it with its nearby elements. Returns "no mention" after the timeout so the caller can loop. |
| `list_mentions` | Every pending mention right now, with nearby elements. |
| `acknowledge_mention` | Mark a mention handled: grey it out and append a check mark or a note. |
| `leave_room` | Disconnect. |

### Example

```
add_elements:
  - {type: rectangle, id: api, x: 0,   y: 0, width: 160, height: 80, label: "API"}
  - {type: ellipse,   id: db,  x: 320, y: 0, width: 160, height: 80, label: "Postgres"}
  - {type: arrow, start: api, end: db, label: "query"}
```

`read_scene` afterwards:

```
api rectangle @(0,0) 160x80 "API"
db ellipse @(320,0) 160x80 "Postgres"
Kp3... arrow 2 pts: (156,40) -> (324,40) from api to db "query"
```

## How it works

- **Transport**: socket.io to `https://oss-collab.excalidraw.com`, the relay excalidraw.com uses. The public relay rejects handshakes that do not carry an `Origin: https://excalidraw.com` header, so the client sends one. Override `serverUrl` and `origin` on `join_room` to point at a self-hosted `excalidraw-room`.
- **Encryption**: AES-128-GCM with the key from the link, matching `packages/excalidraw/data/encryption.ts` upstream. Implemented on Node's WebCrypto so the server does not depend on the browser-oriented `@excalidraw/excalidraw` package.
- **Merging**: Excalidraw's reconcile rule, per element id: higher `version` wins, ties go to the lower `versionNonce`. Local edits bump both, exactly as the web app does, so peers accept them.
- **Z-order**: fractional indices via the same `fractional-indexing` library upstream uses. New elements go on top.
- **Persistence**: excalidraw.com keeps each room's encrypted scene in a public Firestore document. On joining an empty room the server reads it. After every write it saves the reconciled scene back, conditional on the document's update time, so a stale copy never overwrites a newer one. On a conflict it reloads, reconciles, and retries once. If the save still fails, the change has already reached connected peers and their browsers persist it on their normal schedule.

## Limits

- Images and other file attachments are out of scope. They travel by a separate path and are not needed for diagrams.
- Text is measured by approximation, not a real font. Labels may be slightly wider or narrower than the web app would make them; the app re-measures on the next edit.
- The public relay is not a documented API for third parties. The protocol is open source and stable in practice, but nobody has promised to keep it that way.
- One room per server process. Run a second instance for a second room.

## Security

The room key is the only secret, and it is in the link. The server uses it locally to encrypt and decrypt; it is never sent anywhere. Treat collaboration links as you would a password to that drawing.

## Development

```bash
npm test          # build (server + view) + unit tests
npm run build:view   # just the in-chat view: view/ -> dist/view/canvas.html
npm run e2e:show-room -- "<collab link>"   # join a real room and print the show_room payload
EXCALIDRAW_ROOM_DEBUG=1 node dist/index.js   # run with diagnostics on stderr
```

The in-chat view is a separate Vite build under `view/` (paths relative to the repo root). It bundles `@excalidraw/excalidraw` into the single file `dist/view/canvas.html`, which `src/view.ts` serves as the MCP Apps resource. The Node server itself never imports that package.

## License

MIT. Excalidraw itself is MIT, and the protocol details here are derived from its source.
